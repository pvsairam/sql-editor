import { Connection, EnvironmentType, FusionContext } from '../model';
import { normalizeBaseUrl } from '../fusion/bip';
import { AuthMethod } from '../fusion/types';

export interface ExportedConnection {
  name: string;
  url: string;
  username: string;
  auth: AuthMethod;
  environment: EnvironmentType;
  dataSource?: string;
  catalogRoot?: string;
  helperPath?: string;
  allowInsecureTls?: boolean;
  oauth?: Connection['oauth'];
  browser?: Connection['browser'];
  tokenKind?: Connection['tokenKind'];
  fusionContext?: FusionContext;
}

export interface ConnectionExportBundle {
  format: 'fusion-sql-dev-connections';
  version: 1;
  exportedAt: string;
  connections: ExportedConnection[];
}

const VALID_AUTH: ReadonlySet<string> = new Set(['basic', 'oauth', 'token', 'browser']);
const VALID_ENV: ReadonlySet<string> = new Set(['DEV', 'TEST', 'UAT', 'PROD', 'OTHER']);

/**
 * Produce a strictly secret-free JSON export of connection profiles.
 * Passwords, OAuth client secrets, tokens, cookies, and runtime-specific state are NEVER included.
 */
export function serializeConnectionsForExport(connections: Connection[]): string {
  const cleaned: ExportedConnection[] = connections.map((c) => ({
    name: c.name,
    url: c.url,
    username: c.username,
    auth: c.auth,
    environment: c.environment,
    ...(c.dataSource ? { dataSource: c.dataSource } : {}),
    ...(c.catalogRoot ? { catalogRoot: c.catalogRoot } : {}),
    ...(c.helperPath ? { helperPath: c.helperPath } : {}),
    ...(c.allowInsecureTls ? { allowInsecureTls: c.allowInsecureTls } : {}),
    ...(c.oauth ? { oauth: { issuer: c.oauth.issuer, clientId: c.oauth.clientId, scope: c.oauth.scope, flow: c.oauth.flow } } : {}),
    ...(c.browser ? { browser: { kind: c.browser.kind, ...(c.browser.path ? { path: c.browser.path } : {}) } } : {}),
    ...(c.tokenKind ? { tokenKind: c.tokenKind } : {}),
    ...(c.fusionContext ? { fusionContext: { ...c.fusionContext } } : {})
  }));

  const bundle: ConnectionExportBundle = {
    format: 'fusion-sql-dev-connections',
    version: 1,
    exportedAt: new Date().toISOString(),
    connections: cleaned
  };
  return JSON.stringify(bundle, null, 2) + '\n';
}

/** Parse and validate a secret-free connection export JSON file into safe Connection objects. */
export function parseImportedConnections(rawJson: string): { connections: Connection[]; skipped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { connections?: unknown }).connections)
      ? (parsed as { connections: unknown[] }).connections
      : undefined;

  if (!list) {
    throw new Error('Invalid connection export file: expected a "connections" array.');
  }

  const out: Connection[] = [];
  let skipped = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped++;
      continue;
    }
    const r = item as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    const rawUrl = typeof r['url'] === 'string' ? r['url'].trim() : '';
    const username = typeof r['username'] === 'string' ? r['username'].trim() : '';
    if (!name || !rawUrl || !username) {
      skipped++;
      continue;
    }
    let url: string;
    try {
      url = normalizeBaseUrl(rawUrl);
    } catch {
      skipped++;
      continue;
    }
    const auth: AuthMethod = typeof r['auth'] === 'string' && VALID_AUTH.has(r['auth']) ? (r['auth'] as AuthMethod) : 'basic';
    const environment: EnvironmentType = typeof r['environment'] === 'string' && VALID_ENV.has(r['environment']) ? (r['environment'] as EnvironmentType) : 'DEV';
    const oauth =
      auth === 'oauth' && r['oauth'] && typeof r['oauth'] === 'object'
        ? (() => {
            const o = r['oauth'] as Record<string, unknown>;
            if (typeof o['issuer'] === 'string' && typeof o['clientId'] === 'string' && typeof o['scope'] === 'string') {
              const flow = o['flow'] === 'device_code' || o['flow'] === 'client_credentials' ? o['flow'] : 'authorization_code';
              return { issuer: o['issuer'], clientId: o['clientId'], scope: o['scope'], flow } as Connection['oauth'];
            }
            return undefined;
          })()
        : undefined;
    const browser =
      auth === 'browser' && r['browser'] && typeof r['browser'] === 'object'
        ? (() => {
            const b = r['browser'] as Record<string, unknown>;
            const kind = ['auto', 'chrome', 'edge', 'brave', 'custom'].includes(String(b['kind'])) ? (b['kind'] as NonNullable<Connection['browser']>['kind']) : 'auto';
            return { kind, path: typeof b['path'] === 'string' ? b['path'] : undefined };
          })()
        : undefined;
    const fusionContext =
      r['fusionContext'] && typeof r['fusionContext'] === 'object'
        ? (() => {
            const fc = r['fusionContext'] as Record<string, unknown>;
            return {
              coaSegments: typeof fc['coaSegments'] === 'string' ? fc['coaSegments'] : undefined,
              ledger: typeof fc['ledger'] === 'string' ? fc['ledger'] : undefined,
              businessUnit: typeof fc['businessUnit'] === 'string' ? fc['businessUnit'] : undefined,
              calendar: typeof fc['calendar'] === 'string' ? fc['calendar'] : undefined,
              notes: typeof fc['notes'] === 'string' ? fc['notes'] : undefined
            };
          })()
        : undefined;

    out.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${out.length}`,
      name,
      url,
      username,
      auth,
      environment,
      dataSource: typeof r['dataSource'] === 'string' && r['dataSource'].trim() ? r['dataSource'].trim() : undefined,
      catalogRoot: typeof r['catalogRoot'] === 'string' && r['catalogRoot'].trim() ? r['catalogRoot'].trim() : undefined,
      helperPath: typeof r['helperPath'] === 'string' && r['helperPath'].trim() ? r['helperPath'].trim() : undefined,
      allowInsecureTls: r['allowInsecureTls'] === true ? true : undefined,
      oauth,
      browser,
      tokenKind: auth === 'token' && (r['tokenKind'] === 'bearer' || r['tokenKind'] === 'cookie') ? r['tokenKind'] : undefined,
      fusionContext,
      createdAt: Date.now()
    });
  }
  return { connections: out, skipped };
}
