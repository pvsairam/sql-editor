import type { AuthMethod } from './fusion/types';
import type { OAuthFlow } from './auth/oauth';

export type EnvironmentType = 'DEV' | 'TEST' | 'UAT' | 'PROD' | 'OTHER';

/** Non-secret connection profile (kept in globalState). Secrets live in SecretStorage. */
export interface Connection {
  id: string;
  name: string;
  /** Fusion pod base URL (origin only). */
  url: string;
  /** Fusion user name (login / personal folder). */
  username: string;
  auth: AuthMethod;
  environment: EnvironmentType;
  /** BI Publisher data source: ApplicationDB_FSCM (default), ApplicationDB_HCM, ApplicationDB_CRM ... */
  dataSource?: string;
  /** Catalog folder to hold the helper report; default /~<username>. */
  catalogRoot?: string;
  allowInsecureTls?: boolean;
  oauth?: {
    issuer: string;
    clientId: string;
    scope: string;
    flow: OAuthFlow;
  };
  /** browser-session SSO: which browser to open */
  browser?: { kind: 'auto' | 'chrome' | 'edge' | 'brave' | 'custom'; path?: string };
  /** token auth: how the pasted value is sent */
  tokenKind?: 'bearer' | 'cookie';
  /** Decided once per connection: may we upload the helper report to the pod? */
  runtimeConsent?: 'granted' | 'declined';
  /** Optional: full catalog path of an existing helper report (e.g. imported by hand); tried first. */
  helperPath?: string;
  /** Where the helper report was last found/installed. */
  reportPath?: string;
  createdAt: number;
}

export interface HistoryEntry {
  id: string;
  sql: string;
  timestamp: number;
  durationMs: number;
  status: 'success' | 'error';
  connectionId?: string;
  connectionName: string;
  rowCount?: number;
  error?: string;
  starred?: boolean;
}

export const ENV_COLORS: Record<EnvironmentType, string> = {
  DEV: 'charts.green',
  TEST: 'charts.blue',
  UAT: 'charts.yellow',
  PROD: 'charts.red',
  OTHER: 'charts.purple'
};
