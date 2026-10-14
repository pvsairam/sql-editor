import type { BodyCredentials } from './soap';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export type AuthMethod = 'basic' | 'oauth' | 'token';

/** Resolved credentials for one connection. Implementations may refresh tokens on demand. */
export interface AuthSession {
  readonly method: AuthMethod;
  /** Fusion user name; used to locate the personal catalog folder (/~user). */
  readonly username: string;
  /** Basic-auth password (only for method "basic"). */
  readonly password?: string;
  /** Value for the HTTP Authorization header, e.g. "Basic ..." or "Bearer ...". */
  authorization(signal?: AbortSignal): Promise<string | undefined>;
  /** Raw Cookie header value, for session-cookie tokens. */
  cookie?(): string | undefined;
}

export type AuthStyle = 'both' | 'header' | 'body';

export interface QueryPage {
  columns: string[];
  rows: string[][];
  /** More rows exist beyond this page. */
  hasMore: boolean;
  elapsedMs: number;
  /** True when the SQL could not be wrapped for paging and was executed as-is. */
  unpaged: boolean;
}

export type { BodyCredentials };
