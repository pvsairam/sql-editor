/**
 * OAuth 2.0 / OpenID Connect client for Oracle IAM (IDCS) identity domains, which is how Single
 * Sign-On works for Fusion pods: the user signs in through the browser (using the company IdP, MFA
 * included) and we receive a bearer token, so no Fusion password is ever typed into or stored by
 * this extension.
 *
 * Supported grants: authorization code + PKCE (loopback redirect), device code (works over SSH /
 * Codespaces / WSL), client credentials (service integrations) and refresh tokens.
 */
import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { FusionError } from '../fusion/errors';
import { httpRequest } from '../fusion/http';
import { Logger, nullLogger } from '../fusion/types';

export type OAuthFlow = 'authorization_code' | 'device_code' | 'client_credentials';

export interface OAuthConfig {
  /** Identity domain base URL, e.g. https://idcs-1234.identity.oraclecloud.com */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  flow: OAuthFlow;
  /** Fixed port for the loopback redirect (needed when the IdP requires an exact redirect URI). 0 = random. */
  loopbackPort?: number;
  /** Host name used in the redirect URI. The listener always binds to loopback. */
  redirectHost?: string;
  allowInsecureTls?: boolean;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceEndpoint?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  scope?: string;
}

export interface TokenStore {
  load(): Promise<TokenSet | undefined>;
  save(t: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSec: number;
}

export interface OAuthUi {
  openBrowser(url: string): Promise<void>;
  showDeviceCode(info: DeviceCodeInfo): void;
}

interface Endpoints {
  authorization: string;
  token: string;
  device: string;
}

const EXPIRY_SKEW_MS = 60_000;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Decode the `exp` claim of a JWT (ms since epoch) without verifying it. */
export function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class OAuthClient {
  private endpoints?: Endpoints;
  private refreshing?: Promise<TokenSet>;
  private cached?: TokenSet;

  constructor(
    private readonly cfg: OAuthConfig,
    private readonly store: TokenStore,
    private readonly ui: OAuthUi,
    private readonly log: Logger = nullLogger
  ) {}

  // -------------------------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------------------------

  /** Interactive sign-in using the configured flow. */
  async signIn(signal?: AbortSignal): Promise<TokenSet> {
    let tokens: TokenSet;
    switch (this.cfg.flow) {
      case 'authorization_code':
        tokens = await this.authCodeFlow(signal);
        break;
      case 'device_code':
        tokens = await this.deviceFlow(signal);
        break;
      case 'client_credentials':
        tokens = await this.clientCredentials(signal);
        break;
    }
    this.cached = tokens;
    await this.store.save(tokens);
    return tokens;
  }

  async signOut(): Promise<void> {
    this.cached = undefined;
    await this.store.clear();
  }

  /** Current token state without side effects. */
  async status(): Promise<{ signedIn: boolean; expiresAt?: number; canRefresh: boolean }> {
    const t = this.cached ?? (await this.store.load());
    if (!t) {
      return { signedIn: false, canRefresh: false };
    }
    return { signedIn: true, expiresAt: t.expiresAt, canRefresh: !!t.refreshToken || this.cfg.flow === 'client_credentials' };
  }

  /** A valid access token, refreshing silently when needed. Throws FusionError('auth') if sign-in is required. */
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    let t = this.cached ?? (await this.store.load());
    if (t && t.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      this.cached = t;
      return t.accessToken;
    }
    if (t?.refreshToken || this.cfg.flow === 'client_credentials') {
      this.refreshing ??= (async () => {
        try {
          const fresh = t?.refreshToken ? await this.refresh(t.refreshToken, signal) : await this.clientCredentials(signal);
          this.cached = fresh;
          await this.store.save(fresh);
          return fresh;
        } finally {
          this.refreshing = undefined;
        }
      })();
      try {
        t = await this.refreshing;
        return t.accessToken;
      } catch (e) {
        if (e instanceof FusionError && e.kind === 'cancelled') {
          throw e;
        }
        this.log.warn(`Token refresh failed: ${e instanceof Error ? e.message : String(e)}`);
        await this.store.clear();
        this.cached = undefined;
      }
    }
    throw new FusionError('auth', 'You are not signed in (or the session expired).', { hint: 'Right-click the connection and choose "Sign In (SSO)…".' });
  }

  // -------------------------------------------------------------------------------------------
  // endpoints
  // -------------------------------------------------------------------------------------------

  private async resolveEndpoints(signal?: AbortSignal): Promise<Endpoints> {
    if (this.endpoints) {
      return this.endpoints;
    }
    const base = this.cfg.issuer.replace(/\/+$/, '');
    const fallback: Endpoints = {
      authorization: this.cfg.authorizationEndpoint || `${base}/oauth2/v1/authorize`,
      token: this.cfg.tokenEndpoint || `${base}/oauth2/v1/token`,
      device: this.cfg.deviceEndpoint || `${base}/oauth2/v1/device`
    };
    if (this.cfg.authorizationEndpoint && this.cfg.tokenEndpoint) {
      return (this.endpoints = fallback);
    }
    try {
      const res = await httpRequest({
        url: `${base}/.well-known/openid-configuration`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: 20000,
        signal,
        allowInsecureTls: this.cfg.allowInsecureTls
      });
      if (res.status === 200) {
        const d = JSON.parse(res.body) as { authorization_endpoint?: string; token_endpoint?: string; device_authorization_endpoint?: string };
        this.endpoints = {
          authorization: this.cfg.authorizationEndpoint || d.authorization_endpoint || fallback.authorization,
          token: this.cfg.tokenEndpoint || d.token_endpoint || fallback.token,
          device: this.cfg.deviceEndpoint || d.device_authorization_endpoint || fallback.device
        };
        return this.endpoints;
      }
    } catch (e) {
      if (e instanceof FusionError && e.kind === 'cancelled') {
        throw e;
      }
      this.log.debug(`OIDC discovery failed, using default IDCS endpoints: ${e instanceof Error ? e.message : String(e)}`);
    }
    return (this.endpoints = fallback);
  }

  // -------------------------------------------------------------------------------------------
  // token endpoint
  // -------------------------------------------------------------------------------------------

  private async tokenRequest(params: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; json: Record<string, unknown> }> {
    const ep = await this.resolveEndpoints(signal);
    const form = new URLSearchParams(params);
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.cfg.clientSecret) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64');
    } else {
      form.set('client_id', this.cfg.clientId);
    }
    const res = await httpRequest({ url: ep.token, method: 'POST', headers, body: form.toString(), timeoutMs: 30000, signal, allowInsecureTls: this.cfg.allowInsecureTls });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      if (res.status !== 200) {
        throw new FusionError('auth', `Token endpoint answered HTTP ${res.status} with a non-JSON body.`, {
          status: res.status,
          hint: 'Check the identity domain URL of this connection (it looks like https://idcs-xxxx.identity.oraclecloud.com).'
        });
      }
    }
    return { status: res.status, json };
  }

  private toTokens(json: Record<string, unknown>, prev?: TokenSet): TokenSet {
    const access = json['access_token'];
    if (typeof access !== 'string' || !access) {
      throw new FusionError('auth', 'The identity provider did not return an access token.');
    }
    const expiresIn = Number(json['expires_in']);
    const fromJwt = jwtExpiry(access);
    const expiresAt = fromJwt ?? Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    return {
      accessToken: access,
      refreshToken: typeof json['refresh_token'] === 'string' ? (json['refresh_token'] as string) : prev?.refreshToken,
      expiresAt,
      scope: typeof json['scope'] === 'string' ? (json['scope'] as string) : undefined
    };
  }

  private oauthError(status: number, json: Record<string, unknown>, what: string): FusionError {
    const code = String(json['error'] ?? '');
    const desc = String(json['error_description'] ?? json['message'] ?? '');
    const hints: Record<string, string> = {
      invalid_client: 'The Client ID (or secret) is not accepted. Check the integrated application in the IAM identity domain.',
      invalid_grant: 'The grant was rejected or expired. Sign in again.',
      invalid_scope: 'The requested scope is not allowed for this application. Check the "Scope" of the connection.',
      unauthorized_client: 'This application is not allowed to use this grant type. In the identity domain, enable "Authorization code" (or "Device code") for the integrated application.',
      invalid_request: 'The identity provider rejected the request. If it mentions redirect_uri, register exactly the redirect URL shown in the connection settings.'
    };
    return new FusionError('auth', `${what} failed${code ? ` (${code})` : ` (HTTP ${status})`}${desc ? `: ${desc}` : ''}`, { status, code, hint: hints[code] });
  }

  private async refresh(refreshToken: string, signal?: AbortSignal): Promise<TokenSet> {
    const { status, json } = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal);
    if (status !== 200) {
      throw this.oauthError(status, json, 'Token refresh');
    }
    return this.toTokens(json, { accessToken: '', refreshToken, expiresAt: 0 });
  }

  private async clientCredentials(signal?: AbortSignal): Promise<TokenSet> {
    if (!this.cfg.clientSecret) {
      throw new FusionError('config', 'The client-credentials grant needs a client secret.');
    }
    const { status, json } = await this.tokenRequest({ grant_type: 'client_credentials', scope: this.cfg.scope }, signal);
    if (status !== 200) {
      throw this.oauthError(status, json, 'Client-credentials sign-in');
    }
    return this.toTokens(json);
  }

  // -------------------------------------------------------------------------------------------
  // authorization code + PKCE
  // -------------------------------------------------------------------------------------------

  private async authCodeFlow(signal?: AbortSignal): Promise<TokenSet> {
    const ep = await this.resolveEndpoints(signal);
    const { verifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(16));
    const host = this.cfg.redirectHost || 'localhost';
    const server = new LoopbackServer(this.cfg.loopbackPort ?? 0);
    const port = await server.start();
    const redirectUri = `http://${host}:${port}/callback`;
    try {
      const url = new URL(ep.authorization);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', this.cfg.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', withOfflineAccess(this.cfg.scope));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      this.log.info(`Opening browser for sign-in (redirect ${redirectUri})`);
      // Arm the listener BEFORE the browser opens so a fast redirect can never be missed.
      const callback = server.waitForCallback(state, 5 * 60_000, signal);
      callback.catch(() => undefined);
      await this.ui.openBrowser(url.toString());
      const cb = await callback;
      const { status, json } = await this.tokenRequest(
        { grant_type: 'authorization_code', code: cb, redirect_uri: redirectUri, code_verifier: verifier },
        signal
      );
      if (status !== 200) {
        throw this.oauthError(status, json, 'Sign-in');
      }
      return this.toTokens(json);
    } finally {
      server.close();
    }
  }

  // -------------------------------------------------------------------------------------------
  // device code
  // -------------------------------------------------------------------------------------------

  private async deviceFlow(signal?: AbortSignal): Promise<TokenSet> {
    const ep = await this.resolveEndpoints(signal);
    const form = new URLSearchParams({ client_id: this.cfg.clientId, scope: withOfflineAccess(this.cfg.scope) });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.cfg.clientSecret) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64');
    }
    const res = await httpRequest({ url: ep.device, method: 'POST', headers, body: form.toString(), timeoutMs: 30000, signal, allowInsecureTls: this.cfg.allowInsecureTls });
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      /* handled below */
    }
    if (res.status !== 200 || typeof d['device_code'] !== 'string') {
      throw this.oauthError(res.status, d, 'Device sign-in');
    }
    const info: DeviceCodeInfo = {
      userCode: String(d['user_code']),
      verificationUri: String(d['verification_uri'] ?? d['verification_url'] ?? ''),
      verificationUriComplete: typeof d['verification_uri_complete'] === 'string' ? (d['verification_uri_complete'] as string) : undefined,
      expiresInSec: Number(d['expires_in']) || 600
    };
    this.ui.showDeviceCode(info);

    let intervalMs = Math.max(1, Number(d['interval']) || 5) * 1000;
    const deadline = Date.now() + info.expiresInSec * 1000;
    while (Date.now() < deadline) {
      await sleep(intervalMs, signal);
      const { status, json } = await this.tokenRequest(
        { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: String(d['device_code']) },
        signal
      );
      if (status === 200) {
        return this.toTokens(json);
      }
      const err = String(json['error'] ?? '');
      if (err === 'authorization_pending') {
        continue;
      }
      if (err === 'slow_down') {
        intervalMs += 5000;
        continue;
      }
      if (err === 'access_denied') {
        throw new FusionError('auth', 'Sign-in was denied.');
      }
      if (err === 'expired_token') {
        throw new FusionError('auth', 'The device code expired before sign-in finished. Try again.');
      }
      throw this.oauthError(status, json, 'Device sign-in');
    }
    throw new FusionError('timeout', 'Timed out waiting for the browser sign-in to complete.');
  }
}

function withOfflineAccess(scope: string): string {
  return /\boffline_access\b/.test(scope) ? scope : `${scope} offline_access`.trim();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FusionError('cancelled', 'Cancelled.'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new FusionError('cancelled', 'Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<style>body{font:16px system-ui,sans-serif;background:#0f141b;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
.c{text-align:center}.t{font-size:44px}</style>
<div class="c"><div class="t">&#10003;</div><h2>You're signed in to Fusion SQL DEV</h2><p>You can close this tab and return to VS Code.</p></div>`;

function failurePage(msg: string): string {
  const safe = msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
  return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><body style="font:16px system-ui;padding:40px"><h2>Sign-in failed</h2><p>${safe}</p><p>Return to VS Code for details.</p>`;
}

/** Single-use HTTP listener bound to loopback (IPv4 and, when available, IPv6). */
export class LoopbackServer {
  private servers: http.Server[] = [];
  private resolveCb?: (v: string) => void;
  private rejectCb?: (e: Error) => void;
  private expectedState = '';

  constructor(private readonly port: number) {}

  async start(): Promise<number> {
    const v4 = http.createServer((req, res) => this.handle(req, res));
    const actual = await new Promise<number>((resolve, reject) => {
      v4.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          reject(new FusionError('config', `Port ${this.port} is already in use; the sign-in redirect needs it.`, { hint: 'Change "fusionSqlDev.oauth.loopbackPort" (and the redirect URL registered in the identity domain).' }));
        } else {
          reject(e);
        }
      });
      v4.listen(this.port, '127.0.0.1', () => resolve((v4.address() as AddressInfo).port));
    });
    this.servers.push(v4);
    // Best effort IPv6 so that http://localhost:<port> works whichever family the browser tries first.
    const v6 = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      v6.once('error', () => resolve());
      v6.listen(actual, '::1', () => {
        this.servers.push(v6);
        resolve();
      });
    });
    return actual;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (err) {
      const desc = url.searchParams.get('error_description') ?? '';
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(failurePage(`${err} ${desc}`));
      this.rejectCb?.(new FusionError('auth', `Sign-in failed: ${err}${desc ? ` - ${desc}` : ''}`));
      return;
    }
    if (!code || state !== this.expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(failurePage('Invalid or missing state. Start the sign-in again from VS Code.'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(SUCCESS_PAGE);
    this.resolveCb?.(code);
  }

  waitForCallback(state: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    this.expectedState = state;
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new FusionError('cancelled', 'Sign-in cancelled.'));
        return;
      }
      const timer = setTimeout(() => reject(new FusionError('timeout', 'Timed out waiting for the browser sign-in.')), timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new FusionError('cancelled', 'Sign-in cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.resolveCb = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.rejectCb = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });
  }

  close(): void {
    for (const s of this.servers) {
      s.close();
      s.closeAllConnections?.();
    }
    this.servers = [];
  }
}
