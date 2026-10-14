import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { FusionError } from '../fusion/errors';
import { Logger, nullLogger } from '../fusion/types';
import { CdpCookie, WsClient, cookieHeaderFor } from './cdp';

export type BrowserKind = 'auto' | 'chrome' | 'edge' | 'brave' | 'custom';

export function browserCandidates(kind: BrowserKind, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const win = (rel: string) => [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']].filter((x): x is string => !!x).map((b) => path.join(b, rel));
  const all: Record<Exclude<BrowserKind, 'auto' | 'custom'>, string[]> =
    platform === 'win32'
      ? { chrome: win('Google\\Chrome\\Application\\chrome.exe'), edge: win('Microsoft\\Edge\\Application\\msedge.exe'), brave: win('BraveSoftware\\Brave-Browser\\Application\\brave.exe') }
      : platform === 'darwin'
        ? {
            chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
            edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
            brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
          }
        : {
            chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
            edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
            brave: ['/usr/bin/brave-browser', '/usr/bin/brave']
          };
  if (kind === 'auto') {
    return [...all.chrome, ...all.edge, ...all.brave];
  }
  return kind === 'custom' ? [] : all[kind];
}

export function findBrowser(kind: BrowserKind, customPath?: string): string {
  const list = kind === 'custom' && customPath ? [customPath] : browserCandidates(kind);
  const hit = list.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new FusionError('config', kind === 'custom' ? `Browser not found at "${customPath ?? ''}".` : `Could not find ${kind === 'auto' ? 'Chrome, Edge or Brave' : kind} on this computer.`, {
      hint: 'Pick another browser in the connection settings, or choose "Custom path" and enter the full path of a Chromium-based browser (chrome.exe / msedge.exe).'
    });
  }
  return hit;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject)
      .on('timeout', function (this: http.ClientRequest) {
        this.destroy(new Error('timeout'));
      });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BrowserLoginOptions {
  baseUrl: string;
  executable: string;
  /** Persistent profile: the company IdP session survives, so later sign-ins are one click. */
  profileDir: string;
  /** True once the cookies authenticate against the pod. */
  verify(cookieHeader: string): Promise<boolean>;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  log?: Logger;
}

/**
 * Open the browser on the pod, wait for the user to finish SSO, return the Cookie header.
 * The browser window is closed automatically afterwards.
 */
export async function browserLogin(o: BrowserLoginOptions): Promise<string> {
  const log = o.log ?? nullLogger;
  const host = new URL(o.baseUrl).hostname;
  fs.mkdirSync(o.profileDir, { recursive: true });
  const port = await freePort();
  const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${o.profileDir}`, '--no-first-run', '--no-default-browser-check', '--new-window', o.baseUrl];
  log.info(`Starting browser for SSO: ${path.basename(o.executable)} (debug port ${port})`);
  const child: ChildProcess = spawn(o.executable, args, { stdio: 'ignore', detached: false });
  let exited = false;
  child.on('exit', () => (exited = true));
  child.on('error', () => (exited = true));
  let ws: WsClient | undefined;
  const deadline = Date.now() + (o.timeoutMs ?? 5 * 60_000);
  const cleanup = async () => {
    try {
      await ws?.request('Browser.close', {}, 2000).catch(() => undefined);
    } finally {
      ws?.close();
      if (!exited) {
        child.kill();
      }
    }
  };
  try {
    // wait for the DevTools endpoint
    let wsUrl: string | undefined;
    while (!wsUrl) {
      if (exited) {
        throw new FusionError('cancelled', 'The browser was closed before sign-in finished.');
      }
      if (o.signal?.aborted) {
        throw new FusionError('cancelled', 'Sign-in cancelled.');
      }
      if (Date.now() > deadline) {
        throw new FusionError('timeout', 'The browser did not start in time.');
      }
      try {
        wsUrl = (await getJson<{ webSocketDebuggerUrl: string }>(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl;
      } catch {
        await sleep(300);
      }
    }
    ws = await WsClient.connect(wsUrl);
    let lastCookie = '';
    for (;;) {
      if (o.signal?.aborted) {
        throw new FusionError('cancelled', 'Sign-in cancelled.');
      }
      if (exited || ws.closed) {
        throw new FusionError('cancelled', 'The browser was closed before sign-in finished.');
      }
      if (Date.now() > deadline) {
        throw new FusionError('timeout', 'Timed out waiting for the browser sign-in (5 minutes).');
      }
      try {
        const { cookies } = await ws.request<{ cookies: CdpCookie[] }>('Storage.getCookies');
        const header = cookieHeaderFor(host, cookies);
        if (header && header !== lastCookie) {
          lastCookie = header;
          if (await o.verify(header)) {
            log.info('Browser session accepted by the pod.');
            return header;
          }
        }
      } catch (e) {
        if (exited || ws.closed) {
          throw new FusionError('cancelled', 'The browser was closed before sign-in finished.');
        }
        log.debug(`cookie poll: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(o.pollMs ?? 1500);
    }
  } finally {
    await cleanup();
  }
}
