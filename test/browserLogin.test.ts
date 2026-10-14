import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { browserCandidates, browserLogin, findBrowser } from '../src/auth/browserLogin';
import { cookieHeaderFor } from '../src/auth/cdp';
import { FusionError } from '../src/fusion/errors';

// A stand-in "Chrome": serves /json/version, speaks just enough DevTools over WebSocket.
const FAKE = `#!/usr/bin/env node
const http = require('http'), crypto = require('crypto');
const port = Number(process.argv.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
let polls = 0;
const send = (s, o) => { const b = Buffer.from(JSON.stringify(o)); const h = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]); s.write(Buffer.concat([h, b])); };
const srv = http.createServer((q, r) => { if (q.url === '/json/version') r.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/x' })); else r.writeHead(404).end(); });
srv.on('upgrade', (req, sock) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 6) {
      let len = buf[1] & 127, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), p = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((x, i) => x ^ mask[i % 4]));
      buf = buf.subarray(off + 4 + len);
      if ((buf[0] & 15) === 8) return;
      const m = JSON.parse(p.toString());
      if (m.method === 'Storage.getCookies') {
        polls++;
        const cookies = polls < 3 ? [{ name: 'other', value: 'x', domain: 'example.com', path: '/' }] : [{ name: 'JSESSIONID', value: 'abc123', domain: '127.0.0.1', path: '/' }, { name: 'ORA_FUSION', value: 'tok', domain: '.127.0.0.1', path: '/' }, { name: 'nope', value: 'n', domain: 'evil.com', path: '/' }];
        send(sock, { id: m.id, result: { cookies } });
      } else if (m.method === 'Browser.close') { send(sock, { id: m.id, result: {} }); setTimeout(() => process.exit(0), 20); }
    }
  });
});
srv.listen(port, '127.0.0.1');
if (process.env.FAKE_EXIT_EARLY) setTimeout(() => process.exit(0), 500);
`;

function fakeBrowser(): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-chrome-')), 'chrome');
  fs.writeFileSync(f, FAKE, { mode: 0o755 });
  return f;
}

test('browser SSO: opens the browser, polls cookies until the pod accepts them, returns only pod cookies', async () => {
  const exe = fakeBrowser();
  const verified: string[] = [];
  const header = await browserLogin({
    baseUrl: 'http://127.0.0.1:9',
    executable: exe,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')),
    pollMs: 50,
    verify: async (h) => {
      verified.push(h);
      return h.includes('JSESSIONID');
    }
  });
  assert.equal(header, 'JSESSIONID=abc123; ORA_FUSION=tok');
  assert.equal(verified.length, 1, 'verify is only called when cookies for the pod appear');
});

test('browser SSO: closing the browser early is reported as cancelled; abort works', async () => {
  const exe = fakeBrowser();
  process.env['FAKE_EXIT_EARLY'] = '1';
  try {
    await assert.rejects(
      browserLogin({ baseUrl: 'http://127.0.0.1:9', executable: exe, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')), pollMs: 50, verify: async () => false }),
      (e: FusionError) => e.kind === 'cancelled'
    );
  } finally {
    delete process.env['FAKE_EXIT_EARLY'];
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(
    browserLogin({ baseUrl: 'http://127.0.0.1:9', executable: exe, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')), pollMs: 50, verify: async () => false, signal: ac.signal }),
    (e: FusionError) => e.kind === 'cancelled'
  );
});

test('browser discovery and cookie filtering helpers', () => {
  assert.ok(browserCandidates('edge', 'win32', { ProgramFiles: 'C:\\PF' }).some((p) => p.endsWith('msedge.exe')));
  assert.ok(browserCandidates('auto', 'darwin').some((p) => p.includes('Google Chrome')));
  assert.throws(() => findBrowser('custom', '/definitely/not/here'), (e: FusionError) => e.kind === 'config' && /Custom path|full path/.test(e.display));
  assert.equal(cookieHeaderFor('abcd.fa.us2.oraclecloud.com', [{ name: 'a', value: '1', domain: '.us2.oraclecloud.com', path: '/' }, { name: 'b', value: '2', domain: 'abcd.fa.us2.oraclecloud.com', path: '/' }, { name: 'c', value: '3', domain: 'other.com', path: '/' }]), 'a=1; b=2');
});
