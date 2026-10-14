/** Typed errors so the UI can give actionable guidance instead of raw SOAP noise. */

export type FusionErrorKind =
  | 'auth' // credentials rejected
  | 'sso' // server answered with a browser login page / redirect: federated (SSO) tenant
  | 'network' // DNS, refused, reset
  | 'tls' // certificate problems
  | 'timeout'
  | 'cancelled'
  | 'oracle' // ORA-/PLS-/XDO- error returned by the database or BI Publisher
  | 'runtime-missing' // helper report not deployed on the pod
  | 'permission' // cannot write to the catalog folder etc.
  | 'unsupported' // statement type BI Publisher cannot run
  | 'http'
  | 'parse'
  | 'config';

export class FusionError extends Error {
  readonly kind: FusionErrorKind;
  readonly hint?: string;
  readonly status?: number;
  readonly code?: string;

  constructor(kind: FusionErrorKind, message: string, opts: { hint?: string; status?: number; code?: string; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'FusionError';
    this.kind = kind;
    this.hint = opts.hint;
    this.status = opts.status;
    this.code = opts.code;
  }

  /** Message plus hint, formatted for display. */
  get display(): string {
    return this.hint ? `${this.message}\n\n${this.hint}` : this.message;
  }
}

export function isFusionError(e: unknown): e is FusionError {
  return e instanceof FusionError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof FusionError) {
    return e.display;
  }
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

export const SSO_HINT =
  'This pod appears to use Single Sign-On (the server answered with a web login page instead of an API response). ' +
  'Edit the connection and choose "Single Sign-On (OAuth)" as the sign-in method, or "Access token / session cookie". ' +
  'See docs/SSO.md for the 5-minute setup.';
