import * as vscode from 'vscode';
import { FusionClient } from '../fusion/bip';
import { FusionError } from '../fusion/errors';
import { AuthSession, Logger } from '../fusion/types';
import { Connection } from '../model';
import { ConnectionStore } from './ConnectionStore';
import { OAuthClient, jwtExpiry } from '../auth/oauth';
import { BasicSession, OAuthSession, TokenSession } from '../auth/sessions';
import { settings } from '../config';

interface Cached {
  client: FusionClient;
  signature: string;
}

/** Creates (and caches) FusionClient instances, and owns every interactive sign-in flow. */
export class ConnectionManager {
  private readonly clients = new Map<string, Cached>();
  private readonly oauth = new Map<string, OAuthClient>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeAuth = this.emitter.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly log: Logger
  ) {}

  invalidate(id?: string): void {
    if (id) {
      this.clients.delete(id);
      this.oauth.delete(id);
    } else {
      this.clients.clear();
      this.oauth.clear();
    }
  }

  private signature(c: Connection): string {
    return JSON.stringify([c.url, c.username, c.auth, c.dataSource, c.catalogRoot, c.allowInsecureTls, c.oauth, c.tokenKind, settings.timeoutMs, settings.loopbackPort, settings.redirectHost]);
  }

  private async oauthClient(c: Connection): Promise<OAuthClient> {
    let o = this.oauth.get(c.id);
    if (!o) {
      if (!c.oauth) {
        throw new FusionError('config', 'This connection is set to Single Sign-On but has no identity-domain settings.', { hint: 'Edit the connection and fill in the OAuth section.' });
      }
      const clientSecret = await this.store.getClientSecret(c.id);
      o = new OAuthClient(
        {
          issuer: c.oauth.issuer,
          clientId: c.oauth.clientId,
          clientSecret,
          scope: c.oauth.scope,
          flow: c.oauth.flow,
          loopbackPort: settings.loopbackPort,
          redirectHost: settings.redirectHost,
          allowInsecureTls: c.allowInsecureTls
        },
        this.store.tokenStore(c.id),
        {
          openBrowser: async (url) => {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          },
          showDeviceCode: (info) => {
            const target = info.verificationUriComplete ?? info.verificationUri;
            void vscode.window.showInformationMessage(`Sign in to ${c.name}: enter code ${info.userCode} at ${info.verificationUri}`, 'Copy code & open browser').then(async (pick) => {
              if (pick) {
                await vscode.env.clipboard.writeText(info.userCode);
                await vscode.env.openExternal(vscode.Uri.parse(target));
              }
            });
          }
        },
        this.log
      );
      this.oauth.set(c.id, o);
    }
    return o;
  }

  private async session(c: Connection, interactive: boolean): Promise<AuthSession> {
    switch (c.auth) {
      case 'basic': {
        let pass = await this.store.getPassword(c.id);
        if (pass === undefined) {
          if (!interactive) {
            throw new FusionError('auth', 'No password is stored for this connection.', { hint: 'Edit the connection and enter the password.' });
          }
          pass = await vscode.window.showInputBox({ prompt: `Password for ${c.username} @ ${c.name}`, password: true, ignoreFocusOut: true });
          if (pass === undefined) {
            throw new FusionError('cancelled', 'Cancelled.');
          }
          await this.store.setPassword(c.id, pass);
        }
        return new BasicSession(c.username, pass);
      }
      case 'oauth': {
        const o = await this.oauthClient(c);
        const st = await o.status();
        if (!st.signedIn) {
          if (!interactive) {
            throw new FusionError('auth', 'You are not signed in.', { hint: 'Right-click the connection and choose "Sign In (SSO)…".' });
          }
          await this.signIn(c);
        }
        return new OAuthSession(c.username, o);
      }
      case 'token': {
        let raw = await this.store.getPasted(c.id);
        if (!raw) {
          if (!interactive || !(await this.setToken(c))) {
            throw new FusionError('auth', 'No access token or session cookie is stored for this connection.', { hint: 'Right-click the connection > "Set Access Token / Session Cookie…".' });
          }
          raw = await this.store.getPasted(c.id);
        }
        return new TokenSession(c.username, c.tokenKind ?? 'bearer', raw ?? '');
      }
    }
  }

  async clientFor(c: Connection, interactive = true): Promise<FusionClient> {
    const sig = this.signature(c);
    const cached = this.clients.get(c.id);
    if (cached && cached.signature === sig) {
      return cached.client;
    }
    const auth = await this.session(c, interactive);
    const client = new FusionClient({
      baseUrl: c.url,
      auth,
      catalogRoot: c.catalogRoot,
      dataSource: c.dataSource,
      timeoutMs: settings.timeoutMs,
      allowInsecureTls: c.allowInsecureTls,
      log: this.log,
      knownReportPath: c.reportPath
    });
    this.clients.set(c.id, { client, signature: sig });
    return client;
  }

  // ------------------------------------------------------------------------ sign-in

  async signIn(c: Connection): Promise<boolean> {
    if (c.auth !== 'oauth') {
      void vscode.window.showInformationMessage('Sign-in is only used by "Single Sign-On (OAuth)" connections.');
      return false;
    }
    const o = await this.oauthClient(c);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Signing in to ${c.name}…`, cancellable: true }, async (_p, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      await o.signIn(ac.signal);
    });
    this.invalidate(c.id);
    this.emitter.fire();
    void vscode.window.setStatusBarMessage(`Signed in to ${c.name}`, 4000);
    return true;
  }

  async signOut(c: Connection): Promise<void> {
    if (c.auth === 'oauth') {
      await (await this.oauthClient(c)).signOut();
    }
    this.invalidate(c.id);
    this.emitter.fire();
  }

  /** Paste a bearer token (JWT) or a Cookie header copied from a browser session. */
  async setToken(c: Connection): Promise<boolean> {
    const kind = c.tokenKind ?? 'bearer';
    const value = await vscode.window.showInputBox({
      title: kind === 'bearer' ? 'Access token (JWT)' : 'Session cookie',
      prompt:
        kind === 'bearer'
          ? 'Paste the bearer access token issued for this Fusion pod. It is stored in VS Code SecretStorage.'
          : 'Paste the value of the Cookie request header of a signed-in Fusion browser session.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 20 ? 'That looks too short.' : undefined)
    });
    if (!value) {
      return false;
    }
    const v = value.trim().replace(/^bearer\s+/i, '');
    await this.store.setPasted(c.id, v);
    const exp = kind === 'bearer' ? jwtExpiry(v) : undefined;
    this.invalidate(c.id);
    this.emitter.fire();
    if (exp) {
      void vscode.window.showInformationMessage(`Token saved. It expires ${new Date(exp).toLocaleString()}.`);
    }
    return true;
  }

  /** Short text for the tree: who you are and whether you are signed in. */
  async describe(c: Connection): Promise<string> {
    switch (c.auth) {
      case 'basic':
        return c.username;
      case 'oauth': {
        try {
          const st = await (await this.oauthClient(c)).status();
          if (!st.signedIn) {
            return `${c.username} · SSO · signed out`;
          }
          const exp = st.expiresAt ? new Date(st.expiresAt) : undefined;
          return `${c.username} · SSO · ${st.canRefresh ? 'signed in' : exp && exp.getTime() < Date.now() ? 'expired' : `until ${exp?.toLocaleTimeString()}`}`;
        } catch {
          return `${c.username} · SSO`;
        }
      }
      case 'token': {
        const raw = await this.store.getPasted(c.id);
        if (!raw) {
          return `${c.username} · token missing`;
        }
        const exp = jwtExpiry(raw);
        return `${c.username} · token${exp ? (exp < Date.now() ? ' expired' : ` until ${new Date(exp).toLocaleTimeString()}`) : ''}`;
      }
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
