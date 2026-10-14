import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
import { OAuthClient, OAuthConfig, TokenSet, TokenStore, jwtExpiry, pkcePair } from '../src/auth/oauth';
import { FusionError } from '../src/fusion/errors';

class MemStore implements TokenStore {
  t?: TokenSet;
  async load() {
    return this.t;
  }
  async save(t: TokenSet) {
    this.t = t;
  }
  async clear() {
    this.t = undefined;
  }
}

function jwt(expSec: number): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b({ exp: expSec })}.sig`;
}

/** Minimal IDCS-like identity provider. */
class MockIdp {
  server!: http.Server;
  url = '';
  challenge = '';
  codes = new Map<string, { challenge: string; redirect: string }>();
  refreshTokens = new Set<string>();
  deviceApprovedAfter = 2; // polls before approval
  polls = 0;
  tokenCalls: URLSearchParams[] = [];
  lastAuthHeader?: string;
  expiresIn = 3600;

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString()));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  private json(res: http.ServerResponse, status: number, o: object) {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
  }
  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    const u = new URL(req.url!, this.url);
    if (u.pathname === '/.well-known/openid-configuration') {
      return this.json(res, 200, {
        authorization_endpoint: `${this.url}/oauth2/v1/authorize`,
        token_endpoint: `${this.url}/oauth2/v1/token`,
        device_authorization_endpoint: `${this.url}/oauth2/v1/device`
      });
    }
    if (u.pathname === '/oauth2/v1/authorize') {
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('response_type'), 'code');
      assert.match(u.searchParams.get('scope')!, /offline_access/);
      const code = crypto.randomBytes(6).toString('hex');
      this.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')! });
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', u.searchParams.get('state')!);
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (u.pathname === '/oauth2/v1/device') {
      return this.json(res, 200, { device_code: 'DEV123', user_code: 'ABCD-EFGH', verification_uri: `${this.url}/activate`, expires_in: 60, interval: 1 });
    }
    if (u.pathname === '/oauth2/v1/token') {
      const p = new URLSearchParams(body);
      this.tokenCalls.push(p);
      this.lastAuthHeader = req.headers['authorization'] as string | undefined;
      const grant = p.get('grant_type');
      if (grant === 'authorization_code') {
        const c = this.codes.get(p.get('code')!);
        if (!c) return this.json(res, 400, { error: 'invalid_grant' });
        const ok = crypto.createHash('sha256').update(p.get('code_verifier')!).digest('base64url') === c.challenge;
        if (!ok || p.get('redirect_uri') !== c.redirect) return this.json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        this.codes.delete(p.get('code')!);
        const rt = 'rt-' + crypto.randomBytes(4).toString('hex');
        this.refreshTokens.add(rt);
        return this.json(res, 200, { access_token: 'at-1', refresh_token: rt, expires_in: this.expiresIn, token_type: 'Bearer' });
      }
      if (grant === 'refresh_token') {
        if (!this.refreshTokens.has(p.get('refresh_token')!)) return this.json(res, 400, { error: 'invalid_grant' });
        return this.json(res, 200, { access_token: 'at-refreshed', expires_in: this.expiresIn });
      }
      if (grant === 'client_credentials') {
        if (this.lastAuthHeader !== 'Basic ' + Buffer.from('cid:csecret').toString('base64')) return this.json(res, 401, { error: 'invalid_client' });
        return this.json(res, 200, { access_token: jwt(Math.floor(Date.now() / 1000) + 600), expires_in: 600 });
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        this.polls++;
        if (this.polls <= this.deviceApprovedAfter) return this.json(res, 400, { error: 'authorization_pending' });
        return this.json(res, 200, { access_token: 'at-device', refresh_token: 'rt-device', expires_in: 3600 });
      }
    }
    res.writeHead(404).end();
  }
}

const baseCfg = (issuer: string): OAuthConfig => ({ issuer, clientId: 'cid', scope: 'urn:opc:resource:consumer::all', flow: 'authorization_code', loopbackPort: 0 });

test('authorization code + PKCE: browser round trip yields tokens, saved and reused', async () => {
  const idp = new MockIdp();
  await idp.start();
  try {
    const store = new MemStore();
    const opened: string[] = [];
    const client = new OAuthClient(baseCfg(idp.url), store, {
      openBrowser: async (url) => {
        opened.push(url);
        // simulate the user's browser: follows the IdP redirect back to the loopback listener
        void fetch(url).then((r) => r.text());
      },
      showDeviceCode: () => assert.fail('not expected')
    });
    const t = await client.signIn();
    assert.equal(t.accessToken, 'at-1');
    assert.ok(t.refreshToken);
    assert.equal(opened.length, 1);
    assert.equal(await client.getAccessToken(), 'at-1');
    assert.equal(store.t?.accessToken, 'at-1');
    assert.deepEqual(await client.status(), { signedIn: true, expiresAt: t.expiresAt, canRefresh: true });
  } finally {
    await idp.stop();
  }
});

test('expired access token is refreshed silently; a dead refresh token forces sign-in', async () => {
  const idp = new MockIdp();
  await idp.start();
  try {
    idp.expiresIn = 30; // within the 60s skew -> always considered expired
    const store = new MemStore();
    const client = new OAuthClient(baseCfg(idp.url), store, { openBrowser: async (u) => void fetch(u), showDeviceCode() {} });
    await client.signIn();
    assert.equal(await client.getAccessToken(), 'at-refreshed');
    // concurrent callers share one refresh
    const before = idp.tokenCalls.length;
    const [a, b] = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
    assert.equal(a, 'at-refreshed');
    assert.equal(b, 'at-refreshed');
    assert.ok(idp.tokenCalls.length - before <= 1);
    idp.refreshTokens.clear();
    await assert.rejects(client.getAccessToken(), (e: FusionError) => e.kind === 'auth' && /Sign In/.test(e.display));
    assert.equal(store.t, undefined);
  } finally {
    await idp.stop();
  }
});

test('state mismatch on the loopback callback is rejected', async () => {
  const idp = new MockIdp();
  await idp.start();
  try {
    const client = new OAuthClient(baseCfg(idp.url), new MemStore(), {
      openBrowser: async (url) => {
        const u = new URL(url);
        const redirect = new URL(u.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'evil');
        redirect.searchParams.set('state', 'WRONG');
        const r = await fetch(redirect.toString());
        assert.equal(r.status, 400);
        // then abort the flow
        ac.abort();
      },
      showDeviceCode() {}
    });
    const ac = new AbortController();
    await assert.rejects(client.signIn(ac.signal), (e: FusionError) => e.kind === 'cancelled');
  } finally {
    await idp.stop();
  }
});

test('device code flow polls until approved', async () => {
  const idp = new MockIdp();
  await idp.start();
  try {
    let shown = '';
    const client = new OAuthClient({ ...baseCfg(idp.url), flow: 'device_code' }, new MemStore(), {
      openBrowser: async () => assert.fail('device flow must not open a loopback browser'),
      showDeviceCode: (i) => (shown = i.userCode)
    });
    const t = await client.signIn();
    assert.equal(shown, 'ABCD-EFGH');
    assert.equal(t.accessToken, 'at-device');
    assert.equal(idp.polls, 3);
  } finally {
    await idp.stop();
  }
});

test('client credentials uses HTTP Basic client auth and JWT expiry', async () => {
  const idp = new MockIdp();
  await idp.start();
  try {
    const client = new OAuthClient({ ...baseCfg(idp.url), flow: 'client_credentials', clientSecret: 'csecret' }, new MemStore(), { openBrowser: async () => {}, showDeviceCode() {} });
    const t = await client.signIn();
    assert.ok(Math.abs(t.expiresAt - (Date.now() + 600_000)) < 5000);
    assert.equal(await client.getAccessToken(), t.accessToken);
    const bad = new OAuthClient({ ...baseCfg(idp.url), flow: 'client_credentials', clientSecret: 'wrong' }, new MemStore(), { openBrowser: async () => {}, showDeviceCode() {} });
    await assert.rejects(bad.signIn(), (e: FusionError) => e.kind === 'auth' && /invalid_client/.test(e.message) && /Client ID/.test(e.display));
  } finally {
    await idp.stop();
  }
});

test('pkce pair and jwt expiry helpers', () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(jwtExpiry(jwt(2000000000)), 2000000000 * 1000);
  assert.equal(jwtExpiry('opaque-token'), undefined);
});

test('loopback port conflicts give an actionable error', async () => {
  const blocker = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const port = (blocker.address() as AddressInfo).port;
  const idp = new MockIdp();
  await idp.start();
  try {
    const client = new OAuthClient({ ...baseCfg(idp.url), loopbackPort: port }, new MemStore(), { openBrowser: async () => {}, showDeviceCode() {} });
    await assert.rejects(client.signIn(), (e: FusionError) => e.kind === 'config' && /loopbackPort/.test(e.display));
  } finally {
    blocker.close();
    await idp.stop();
  }
});
