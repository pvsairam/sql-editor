import { AuthSession } from '../fusion/types';
import { OAuthClient, jwtExpiry } from './oauth';

export interface BrowserSessionData {
  cookie: string;
  bearerToken?: string;
  tokenExpiresAt?: number;
  capturedAt?: number;
}

export function serializeBrowserSession(data: BrowserSessionData): string {
  return JSON.stringify({
    v: 2,
    cookie: data.cookie,
    bearerToken: data.bearerToken,
    tokenExpiresAt: data.tokenExpiresAt,
    capturedAt: data.capturedAt ?? Date.now()
  });
}

export function parseBrowserSession(raw: string | undefined): BrowserSessionData | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const s = raw.trim();
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as Partial<BrowserSessionData>;
      if (typeof obj.cookie === 'string' || typeof obj.bearerToken === 'string') {
        const bearerToken = obj.bearerToken ? obj.bearerToken.replace(/^bearer\s+/i, '') : undefined;
        return {
          cookie: obj.cookie ?? '',
          bearerToken,
          tokenExpiresAt: obj.tokenExpiresAt ?? (bearerToken ? jwtExpiry(bearerToken) : undefined),
          capturedAt: obj.capturedAt
        };
      }
    } catch {
      /* fall through to legacy raw cookie */
    }
  }
  return { cookie: s };
}

export class BasicSession implements AuthSession {
  readonly method = 'basic' as const;
  constructor(
    readonly username: string,
    readonly password: string
  ) {}
  async authorization(): Promise<string> {
    return 'Basic ' + Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
  }
}

/** A pasted access token (JWT) or browser session cookie. */
export class TokenSession implements AuthSession {
  readonly method = 'token' as const;
  constructor(
    readonly username: string,
    private readonly kind: 'bearer' | 'cookie',
    private readonly value: string
  ) {}
  async authorization(): Promise<string | undefined> {
    if (this.kind !== 'bearer') {
      return undefined;
    }
    return /^bearer\s/i.test(this.value) ? this.value : `Bearer ${this.value}`;
  }
  cookie(): string | undefined {
    return this.kind === 'cookie' ? this.value.replace(/^cookie:\s*/i, '') : undefined;
  }
}

/**
 * Captured browser SSO session (Oracle IDCS / Oracle Authenticator / Entra / Okta).
 * Carries both the pod Cookie header AND an optional JWT Bearer token obtained via /fscmRestApi/tokenrelay.
 */
export class BrowserSession implements AuthSession {
  readonly method = 'browser' as const;
  constructor(
    readonly username: string,
    readonly data: BrowserSessionData
  ) {}
  async authorization(): Promise<string | undefined> {
    const tok = this.data.bearerToken;
    if (!tok) {
      return undefined;
    }
    const exp = this.data.tokenExpiresAt ?? jwtExpiry(tok);
    if (exp && exp < Date.now() + 30_000) {
      return undefined;
    }
    return /^bearer\s/i.test(tok) ? tok : `Bearer ${tok}`;
  }
  cookie(): string | undefined {
    const c = this.data.cookie?.replace(/^cookie:\s*/i, '');
    return c || undefined;
  }
}

export class OAuthSession implements AuthSession {
  readonly method = 'oauth' as const;
  constructor(
    readonly username: string,
    private readonly client: OAuthClient
  ) {}
  async authorization(signal?: AbortSignal): Promise<string> {
    return `Bearer ${await this.client.getAccessToken(signal)}`;
  }
}
