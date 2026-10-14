import { AuthSession } from '../fusion/types';
import { OAuthClient } from './oauth';

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
