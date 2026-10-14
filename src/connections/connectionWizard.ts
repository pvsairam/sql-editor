import * as vscode from 'vscode';
import { normalizeBaseUrl } from '../fusion/bip';
import { Connection, EnvironmentType } from '../model';
import { OAuthFlow } from '../auth/oauth';
import { AuthMethod } from '../fusion/types';
import { settings } from '../config';

export interface WizardResult {
  connection: Connection;
  /** undefined = unchanged */
  password?: string;
  clientSecret?: string | null;
}

const DEFAULT_SCOPE = 'urn:opc:resource:consumer::all';

class Cancel extends Error {}

async function input(opts: vscode.InputBoxOptions & { step: number; total: number }): Promise<string> {
  const v = await vscode.window.showInputBox({ ...opts, title: `${opts.title ?? 'Connection'} (${opts.step}/${opts.total})`, ignoreFocusOut: true });
  if (v === undefined) {
    throw new Cancel();
  }
  return v;
}

async function pick<T extends vscode.QuickPickItem>(items: T[], title: string, placeHolder: string): Promise<T> {
  const r = await vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true, matchOnDescription: true });
  if (!r) {
    throw new Cancel();
  }
  return r;
}

/** Guided connection setup. Returns undefined when the user cancels. */
export async function runConnectionWizard(existing?: Connection): Promise<WizardResult | undefined> {
  const editing = !!existing;
  const title = editing ? `Edit ${existing!.name}` : 'New Fusion connection';
  try {
    const url = normalizeBaseUrl(
      await input({
        title,
        step: 1,
        total: 5,
        prompt: 'Fusion pod URL',
        placeHolder: 'https://abcd.fa.us2.oraclecloud.com',
        value: existing?.url ?? '',
        validateInput: (v) => {
          try {
            const u = new URL(/^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`);
            return u.hostname.includes('.') || u.hostname === 'localhost' ? undefined : 'Enter the full host name, e.g. abcd.fa.us2.oraclecloud.com';
          } catch {
            return 'Not a valid URL';
          }
        }
      })
    );

    const host = new URL(url).hostname.split('.')[0];
    const name = (
      await input({ title, step: 2, total: 5, prompt: 'Connection name', value: existing?.name ?? host.toUpperCase(), validateInput: (v) => (v.trim() ? undefined : 'A name is required') })
    ).trim();

    const authItems: (vscode.QuickPickItem & { id: AuthMethod })[] = [
      { id: 'basic', label: '$(key) Username & password', description: 'Fusion local account', detail: 'Works when your pod accepts your Fusion password for API calls.' },
      {
        id: 'oauth',
        label: '$(account) Single Sign-On (OAuth)',
        description: 'recommended for SSO / MFA pods',
        detail: 'Sign in through your company identity provider in the browser. No password is stored. Needs an integrated application in the IAM identity domain (see docs/SSO.md).'
      },
      { id: 'token', label: '$(symbol-key) Access token or session cookie', description: 'advanced', detail: 'Paste a bearer token (JWT) or a signed-in browser session cookie.' }
    ];
    const auth = await pick(authItems, `${title} (3/5)`, 'How do you sign in to this pod?');

    const username = (
      await input({
        title,
        step: 4,
        total: 5,
        prompt: auth.id === 'basic' ? 'Fusion user name' : 'Fusion user name (used to locate your personal BI Publisher folder)',
        placeHolder: 'first.last@company.com',
        value: existing?.username ?? '',
        validateInput: (v) => (v.trim() ? undefined : 'Required')
      })
    ).trim();

    const result: WizardResult = {
      connection: {
        id: existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name,
        url,
        username,
        auth: auth.id,
        environment: existing?.environment ?? 'DEV',
        createdAt: existing?.createdAt ?? Date.now(),
        dataSource: existing?.dataSource,
        catalogRoot: existing?.catalogRoot,
        allowInsecureTls: existing?.allowInsecureTls,
        runtimeConsent: existing?.runtimeConsent,
        reportPath: existing?.url === url && existing?.username === username ? existing?.reportPath : undefined
      }
    };

    if (auth.id === 'basic') {
      const pw = await input({
        title,
        step: 5,
        total: 5,
        prompt: editing && existing?.auth === 'basic' ? 'Password (leave empty to keep the stored one)' : 'Password',
        password: true,
        validateInput: (v) => (!v && !(editing && existing?.auth === 'basic') ? 'Required' : undefined)
      });
      if (pw) {
        result.password = pw;
      }
    } else if (auth.id === 'oauth') {
      const o = existing?.oauth;
      const issuer = (
        await input({
          title: `${title} - Single Sign-On`,
          step: 5,
          total: 5,
          prompt: 'Identity domain URL (IAM / IDCS)',
          placeHolder: 'https://idcs-1234567890abcdef.identity.oraclecloud.com',
          value: o?.issuer ?? '',
          validateInput: (v) => {
            try {
              new URL(v.trim());
              return undefined;
            } catch {
              return 'Enter the identity domain URL, e.g. https://idcs-xxxx.identity.oraclecloud.com';
            }
          }
        })
      )
        .trim()
        .replace(/\/+$/, '');
      const clientId = (await input({ title: `${title} - Single Sign-On`, step: 5, total: 5, prompt: 'Client ID of the integrated application', value: o?.clientId ?? '', validateInput: (v) => (v.trim() ? undefined : 'Required') })).trim();
      const scope = (
        await input({
          title: `${title} - Single Sign-On`,
          step: 5,
          total: 5,
          prompt: 'Scope (Fusion resource audience)',
          value: o?.scope ?? DEFAULT_SCOPE,
          validateInput: (v) => (v.trim() ? undefined : 'Required')
        })
      ).trim();
      const flows: (vscode.QuickPickItem & { id: OAuthFlow })[] = [
        { id: 'authorization_code', label: '$(browser) Browser sign-in', description: `redirect http://${settings.redirectHost}:${settings.loopbackPort}/callback`, detail: 'Opens your default browser; works on desktop VS Code.' },
        { id: 'device_code', label: '$(device-mobile) Device code', description: 'remote / SSH / Codespaces / WSL', detail: 'Shows a short code to type at the identity provider. No local redirect needed.' },
        { id: 'client_credentials', label: '$(server-process) Client credentials', description: 'service accounts', detail: 'Uses a client secret instead of a person. Needs the secret.' }
      ];
      const flow = await pick(flows, `${title} - Single Sign-On`, 'Which OAuth flow?');
      result.connection.oauth = { issuer, clientId, scope, flow: flow.id };
      if (flow.id === 'client_credentials') {
        const secret = await input({ title: `${title} - Single Sign-On`, step: 5, total: 5, prompt: 'Client secret', password: true, validateInput: (v) => (v ? undefined : 'Required') });
        result.clientSecret = secret;
      } else if (!editing) {
        const secret = await vscode.window.showInputBox({ title: `${title} - Single Sign-On`, prompt: 'Client secret (only for confidential applications; leave empty for public clients)', password: true, ignoreFocusOut: true });
        if (secret === undefined) {
          throw new Cancel();
        }
        result.clientSecret = secret || null;
      }
    } else {
      const kind = await pick(
        [
          { label: '$(symbol-key) Bearer access token', id: 'bearer' as const, description: 'Authorization: Bearer …' },
          { label: '$(globe) Browser session cookie', id: 'cookie' as const, description: 'Cookie: …' }
        ],
        `${title} (5/5)`,
        'What will you paste?'
      );
      result.connection.tokenKind = kind.id;
    }

    const envItems: (vscode.QuickPickItem & { id: EnvironmentType })[] = (['DEV', 'TEST', 'UAT', 'PROD', 'OTHER'] as const).map((id) => ({
      id,
      label: id,
      description: id === 'PROD' ? 'shown in red as a reminder' : undefined,
      picked: (existing?.environment ?? 'DEV') === id
    }));
    const env = await pick(envItems, `${title}`, 'Which environment is this? (colours the connection so you never run against PROD by accident)');
    result.connection.environment = env.id;

    const adv = await vscode.window.showQuickPick(
      [
        { label: 'Done', id: 'done', description: 'Use defaults' },
        { label: 'Advanced options…', id: 'adv', description: 'BI Publisher data source, catalog folder, TLS' }
      ],
      { title, placeHolder: 'Finish', ignoreFocusOut: true }
    );
    if (!adv) {
      throw new Cancel();
    }
    if (adv.id === 'adv') {
      const ds = await vscode.window.showQuickPick(
        [
          { label: 'ApplicationDB_FSCM', description: 'Financials / SCM / most pods (default)' },
          { label: 'ApplicationDB_HCM', description: 'HCM-only pods' },
          { label: 'ApplicationDB_CRM', description: 'CX / Sales' },
          { label: 'Other…', description: 'type a custom JNDI data source name' }
        ],
        { title: `${title} - data source`, placeHolder: 'Which BI Publisher data source should queries use?', ignoreFocusOut: true }
      );
      if (!ds) {
        throw new Cancel();
      }
      let dsName = ds.label;
      if (ds.label === 'Other…') {
        dsName = (await input({ title, step: 5, total: 5, prompt: 'Data source name', value: existing?.dataSource ?? '', validateInput: (v) => (/^[\w$.-]+$/.test(v.trim()) ? undefined : 'Letters, digits, _ . - only') })).trim();
      }
      result.connection.dataSource = dsName === 'ApplicationDB_FSCM' ? undefined : dsName;
      const root = (
        await input({
          title,
          step: 5,
          total: 5,
          prompt: 'Catalog folder for the helper report (leave empty for your personal folder /~username)',
          value: existing?.catalogRoot ?? '',
          validateInput: (v) => (!v.trim() || v.trim().startsWith('/') ? undefined : 'Must start with /, e.g. /Custom/FusionSqlDev')
        })
      ).trim();
      result.connection.catalogRoot = root ? root.replace(/\/+$/, '') : undefined;
      const tls = await vscode.window.showQuickPick(
        [
          { label: 'Verify TLS certificates', id: false, description: 'recommended' },
          { label: 'Allow untrusted TLS certificate', id: true, description: 'only for lab pods behind a TLS-inspecting proxy' }
        ],
        { title, placeHolder: 'TLS', ignoreFocusOut: true }
      );
      if (!tls) {
        throw new Cancel();
      }
      result.connection.allowInsecureTls = tls.id || undefined;
    }
    return result;
  } catch (e) {
    if (e instanceof Cancel) {
      return undefined;
    }
    throw e;
  }
}
