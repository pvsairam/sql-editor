import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { Connection, EnvironmentType } from '../model';
import { ConnectionStore } from './ConnectionStore';
import { ConnectionManager } from './ConnectionManager';
import { FusionClient, normalizeBaseUrl } from '../fusion/bip';
import { FusionError, errorMessage } from '../fusion/errors';
import { AuthSession, Logger } from '../fusion/types';
import { BasicSession, OAuthSession, TokenSession } from '../auth/sessions';
import { OAuthFlow, TokenSet, TokenStore } from '../auth/oauth';

/** Data exchanged with the connection form webview. Keep in sync with webview/src/connection.ts. */
export interface FormData {
  name: string;
  environment: EnvironmentType;
  auth: 'basic' | 'oauth' | 'token' | 'browser';
  url: string;
  username: string;
  password: string;
  issuer: string;
  clientId: string;
  scope: string;
  flow: OAuthFlow;
  clientSecret: string;
  tokenKind: 'bearer' | 'cookie';
  token: string;
  browserKind: 'auto' | 'chrome' | 'edge' | 'brave' | 'custom';
  browserPath: string;
  dataSource: string;
  catalogRoot: string;
  helperPath: string;
  allowInsecureTls: boolean;
}

type ToForm =
  | { type: 'init'; id: string; editing: boolean; form: FormData; hasPassword: boolean; hasSecret: boolean; hasToken: boolean; redirectUrl: string }
  | { type: 'validation'; ok: boolean; title: string; detail?: string; steps?: { label: string; ok: boolean }[] }
  | { type: 'busy'; busy: boolean };
type FromForm = { type: 'ready' } | { type: 'save'; form: FormData } | { type: 'validate'; form: FormData } | { type: 'cancel' };

const open = new Map<string, vscode.WebviewPanel>();

class MemoryTokens implements TokenStore {
  tokens?: TokenSet;
  async load(): Promise<TokenSet | undefined> {
    return this.tokens;
  }
  async save(t: TokenSet): Promise<void> {
    this.tokens = t;
  }
  async clear(): Promise<void> {
    this.tokens = undefined;
  }
}

function toForm(c?: Connection): FormData {
  return {
    name: c?.name ?? '',
    environment: c?.environment ?? 'DEV',
    auth: c?.auth ?? 'basic',
    url: c?.url ?? '',
    username: c?.username ?? '',
    password: '',
    issuer: c?.oauth?.issuer ?? '',
    clientId: c?.oauth?.clientId ?? '',
    scope: c?.oauth?.scope ?? 'urn:opc:resource:consumer::all',
    flow: c?.oauth?.flow ?? 'authorization_code',
    clientSecret: '',
    tokenKind: c?.tokenKind ?? 'bearer',
    token: '',
    browserKind: c?.browser?.kind ?? 'auto',
    browserPath: c?.browser?.path ?? '',
    dataSource: c?.dataSource ?? '',
    catalogRoot: c?.catalogRoot ?? '',
    helperPath: c?.helperPath ?? '',
    allowInsecureTls: c?.allowInsecureTls ?? false
  };
}

/** Returns an error message for the first invalid field, if any. */
export function validateForm(f: FormData, editing: boolean, hasPassword: boolean): string | undefined {
  if (!f.name.trim()) {
    return 'Name is required.';
  }
  try {
    normalizeBaseUrl(f.url);
  } catch {
    return 'URL is not valid. Example: https://abcd.fa.us2.oraclecloud.com';
  }
  if (!f.url.trim()) {
    return 'URL is required.';
  }
  if (!f.username.trim()) {
    return 'User name is required.';
  }
  if (f.auth === 'basic' && !f.password && !(editing && hasPassword)) {
    return 'Password is required.';
  }
  if (f.auth === 'oauth') {
    if (!/^https?:\/\//i.test(f.issuer.trim())) {
      return 'Identity domain URL is required (https://idcs-xxxx.identity.oraclecloud.com).';
    }
    if (!f.clientId.trim()) {
      return 'Client ID is required.';
    }
    if (!f.scope.trim()) {
      return 'Scope is required.';
    }
    if (f.flow === 'client_credentials' && !f.clientSecret && !editing) {
      return 'Client secret is required for client credentials.';
    }
  }
  if (f.auth === 'browser' && f.browserKind === 'custom' && !f.browserPath.trim()) {
    return 'Enter the full path of the browser executable.';
  }
  if (f.catalogRoot.trim() && !f.catalogRoot.trim().startsWith('/')) {
    return 'Catalog folder must start with / (e.g. /Shared Folders/Custom).';
  }
  return undefined;
}

function draftConnection(id: string, f: FormData, prev?: Connection): Connection {
  return {
    id,
    name: f.name.trim(),
    url: normalizeBaseUrl(f.url),
    username: f.username.trim(),
    auth: f.auth,
    environment: f.environment,
    createdAt: prev?.createdAt ?? Date.now(),
    dataSource: f.dataSource.trim() && f.dataSource.trim() !== 'ApplicationDB_FSCM' ? f.dataSource.trim() : undefined,
    catalogRoot: f.catalogRoot.trim() ? f.catalogRoot.trim().replace(/\/+$/, '') : undefined,
    helperPath: f.helperPath.trim() || undefined,
    allowInsecureTls: f.allowInsecureTls || undefined,
    runtimeConsent: prev?.runtimeConsent,
    oauth: f.auth === 'oauth' ? { issuer: f.issuer.trim().replace(/\/+$/, ''), clientId: f.clientId.trim(), scope: f.scope.trim(), flow: f.flow } : undefined,
    browser: f.auth === 'browser' ? { kind: f.browserKind, path: f.browserKind === 'custom' ? f.browserPath.trim() : undefined } : undefined,
    tokenKind: f.auth === 'token' ? f.tokenKind : undefined,
    reportPath: prev && prev.url === normalizeBaseUrl(f.url) && prev.username === f.username.trim() ? prev.reportPath : undefined
  };
}

export function openConnectionForm(ctx: vscode.ExtensionContext, store: ConnectionStore, manager: ConnectionManager, log: Logger, existing?: Connection): void {
  const id = existing?.id ?? `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const already = open.get(id);
  if (already) {
    already.reveal();
    return;
  }
  const root = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('fusionSqlDev.connection', existing ? `Edit ${existing.name}` : 'New Fusion Connection', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [root]
  });
  open.set(id, panel);
  panel.iconPath = vscode.Uri.joinPath(root, 'icon.png');
  panel.onDidDispose(() => open.delete(id));

  const nonce = randomBytes(16).toString('hex');
  const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview', 'connection.js'));
  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'connection.css'));
  const csp = [`default-src 'none'`, `style-src ${panel.webview.cspSource}`, `script-src 'nonce-${nonce}' ${panel.webview.cspSource}`, `img-src ${panel.webview.cspSource} data:`].join('; ');
  panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Connection</title></head><body><div id="app"></div><script type="module" nonce="${nonce}" src="${js}"></script></body></html>`;

  const post = (m: ToForm) => void panel.webview.postMessage(m);
  let validationTokens: MemoryTokens | undefined; // tokens obtained while validating an SSO setup are kept for the save
  let validationKey = '';
  let validationCookie: string | undefined;

  const sessionFor = async (f: FormData, conn: Connection): Promise<AuthSession> => {
    if (f.auth === 'basic') {
      const pw = f.password || (await store.getPassword(id));
      if (!pw) {
        throw new FusionError('config', 'Enter the password first.');
      }
      return new BasicSession(conn.username, pw);
    }
    if (f.auth === 'token') {
      const t = f.token.trim() || (await store.getPasted(id));
      if (!t) {
        throw new FusionError('config', 'Paste a token or cookie first.');
      }
      return new TokenSession(conn.username, f.tokenKind, t.replace(/^bearer\s+/i, ''));
    }
    if (f.auth === 'browser') {
      validationCookie ??= (await store.getPasted(id)) || (await manager.captureBrowserSession(conn));
      return new TokenSession(conn.username, 'cookie', validationCookie);
    }
    const key = JSON.stringify([f.issuer, f.clientId, f.scope, f.flow]);
    if (!validationTokens || validationKey !== key) {
      validationTokens = new MemoryTokens();
      validationKey = key;
    }
    const secret = f.clientSecret || (await store.getClientSecret(id));
    const oauth = manager.buildOAuth(conn, secret, validationTokens);
    if (!(await oauth.status()).signedIn) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Signing in to validate…', cancellable: true }, async (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        await oauth.signIn(ac.signal);
      });
    }
    return new OAuthSession(conn.username, oauth);
  };

  panel.webview.onDidReceiveMessage(async (m: FromForm) => {
    try {
      if (m.type === 'ready') {
        post({
          type: 'init',
          id,
          editing: !!existing,
          form: toForm(existing),
          hasPassword: !!(await store.getPassword(id)),
          hasSecret: !!(await store.getClientSecret(id)),
          hasToken: !!(await store.getPasted(id)),
          redirectUrl: `http://${vscode.workspace.getConfiguration('fusionSqlDev').get('oauth.redirectHost', 'localhost')}:${vscode.workspace.getConfiguration('fusionSqlDev').get('oauth.loopbackPort', 53682)}/callback`
        });
      } else if (m.type === 'cancel') {
        panel.dispose();
      } else if (m.type === 'validate') {
        const err = validateForm(m.form, !!existing, !!(await store.getPassword(id)));
        if (err) {
          post({ type: 'validation', ok: false, title: err });
          return;
        }
        post({ type: 'busy', busy: true });
        try {
          const conn = draftConnection(id, m.form, existing);
          const client = new FusionClient({
            baseUrl: conn.url,
            auth: await sessionFor(m.form, conn),
            catalogRoot: conn.catalogRoot,
            dataSource: conn.dataSource,
            allowInsecureTls: conn.allowInsecureTls,
            log,
            timeoutMs: 60000
          });
          const r = await client.test(async () => false);
          const steps = [
            { label: 'Server reachable & signed in', ok: r.authenticated },
            { label: r.runtimeReady ? `Helper report found (${r.reportPath})` : 'Helper report (installed automatically on first run, after you confirm)', ok: r.runtimeReady }
          ];
          if (r.ok || (r.authenticated && !r.runtimeReady && !r.error)) {
            post({ type: 'validation', ok: true, title: r.ok ? 'Connection works' : 'Signed in - the helper report will be installed on the first run', steps });
          } else {
            post({ type: 'validation', ok: false, title: r.message, detail: r.error?.hint, steps });
          }
        } catch (e) {
          post({ type: 'validation', ok: false, title: e instanceof FusionError ? e.message : errorMessage(e), detail: e instanceof FusionError ? e.hint : undefined });
        } finally {
          post({ type: 'busy', busy: false });
        }
      } else if (m.type === 'save') {
        const err = validateForm(m.form, !!existing, !!(await store.getPassword(id)));
        if (err) {
          post({ type: 'validation', ok: false, title: err });
          return;
        }
        const conn = draftConnection(id, m.form, existing);
        const identityChanged =
          !!existing && (existing.auth !== conn.auth || existing.url !== conn.url || existing.browser?.kind !== conn.browser?.kind || existing.oauth?.issuer !== conn.oauth?.issuer || existing.oauth?.clientId !== conn.oauth?.clientId || existing.oauth?.scope !== conn.oauth?.scope);
        await store.save(conn);
        if (identityChanged) {
          await store.tokenStore(id).clear();
        }
        if (m.form.auth === 'basic' && m.form.password) {
          await store.setPassword(id, m.form.password);
        }
        if (m.form.auth === 'oauth') {
          if (m.form.clientSecret) {
            await store.setClientSecret(id, m.form.clientSecret);
          }
          if (validationTokens?.tokens && validationKey === JSON.stringify([m.form.issuer, m.form.clientId, m.form.scope, m.form.flow])) {
            await store.tokenStore(id).save(validationTokens.tokens);
          }
        }
        if (m.form.auth === 'browser' && validationCookie) {
          await store.setPasted(id, validationCookie);
        }
        if (m.form.auth === 'token' && m.form.token.trim()) {
          await store.setPasted(id, m.form.token.trim().replace(/^bearer\s+/i, ''));
        }
        manager.invalidate(id);
        if (!existing) {
          await store.setActive(id);
        }
        panel.dispose();
        const needsSignIn = (conn.auth === 'oauth' && !(await store.tokenStore(id).load())) || (conn.auth === 'browser' && !(await store.getPasted(id)));
        const next = needsSignIn ? 'Sign In' : 'New Worksheet';
        const pick = await vscode.window.showInformationMessage(`Connection "${conn.name}" ${existing ? 'updated' : 'created'}.`, next);
        if (pick === 'Sign In') {
          await vscode.commands.executeCommand('fusionSqlDev.signIn', id);
        } else if (pick === 'New Worksheet') {
          await vscode.commands.executeCommand('fusionSqlDev.newWorksheet');
        }
      }
    } catch (e) {
      log.error(`Connection form: ${errorMessage(e)}`);
      post({ type: 'busy', busy: false });
      post({ type: 'validation', ok: false, title: errorMessage(e) });
    }
  });
}
