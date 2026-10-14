/**
 * Minimal WebSocket client + Chrome DevTools Protocol helper (no dependencies).
 * Used by browser-session SSO: we start the user's own Chrome/Edge/Brave with a private profile, let them sign
 * in through the company login page, and read the resulting session cookies for the pod.
 */
import * as crypto from 'crypto';
import * as http from 'http';
import { Duplex } from 'stream';

export class WsClient {
  private buf = Buffer.alloc(0);
  private frag: Buffer[] = [];
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  closed = false;

  private constructor(private readonly socket: Duplex) {
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  static connect(url: string, timeoutMs = 10000): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
        timeout: timeoutMs
      });
      req.on('upgrade', (res, socket, head) => {
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (res.headers['sec-websocket-accept'] !== accept) {
          socket.destroy();
          reject(new Error('WebSocket handshake failed'));
          return;
        }
        const c = new WsClient(socket);
        if (head.length) {
          c.onData(head);
        }
        resolve(c);
      });
      req.on('response', () => reject(new Error('WebSocket upgrade refused')));
      req.on('timeout', () => req.destroy(new Error('WebSocket connect timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  private onClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const p of this.pending.values()) {
      p.reject(new Error('Browser connection closed'));
    }
    this.pending.clear();
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) {
        return;
      }
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) {
          return;
        }
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) {
          return;
        }
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      if (masked) {
        off += 4;
      }
      if (this.buf.length < off + len) {
        return;
      }
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const mask = this.buf.subarray(off - 4, off);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      this.buf = this.buf.subarray(off + len);
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if (op === 8) {
        this.socket.end();
        this.onClose();
        return;
      }
      if (op === 9) {
        this.write(0x0a, payload);
        continue;
      }
      if (op === 1 || op === 0) {
        this.frag.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.frag).toString('utf8');
          this.frag = [];
          this.onMessage(text);
        }
      }
    }
  }

  private onMessage(text: string): void {
    try {
      const m = JSON.parse(text) as { id?: number; result?: unknown; error?: { message: string } };
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) {
          p?.reject(new Error(m.error.message));
        } else {
          p?.resolve(m.result);
        }
      }
    } catch {
      /* ignore non-JSON */
    }
  }

  private write(opcode: number, payload: Buffer): void {
    const mask = crypto.randomBytes(4);
    const n = payload.length;
    const header = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255]) : (() => {
      const h = Buffer.alloc(10);
      h[0] = 0x80 | opcode;
      h[1] = 0x80 | 127;
      h.writeBigUInt64BE(BigInt(n), 2);
      return h;
    })();
    const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  request<T = any>(method: string, params: object = {}, timeoutMs = 10000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('Browser connection closed'));
        return;
      }
      const id = this.nextId++;
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        }
      });
      this.write(0x1, Buffer.from(JSON.stringify({ id, method, params })));
    });
  }

  close(): void {
    if (!this.closed) {
      this.write(0x8, Buffer.alloc(0));
      this.socket.end();
      this.onClose();
    }
  }
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
}

/** Cookies that the browser would send to `host`. */
export function cookieHeaderFor(host: string, cookies: CdpCookie[]): string {
  const h = host.toLowerCase();
  return cookies
    .filter((c) => {
      const d = c.domain.toLowerCase().replace(/^\./, '');
      return h === d || h.endsWith('.' + d);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}
