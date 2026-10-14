/**
 * Small promise-based HTTP(S) client on top of node's core modules.
 *
 * Notes
 *  - Uses the *global* agent on purpose: inside VS Code the extension host patches http(s) so
 *    the `http.proxy` setting and operating-system certificates are honoured automatically.
 *  - TLS verification is ON. The old build hard-coded `rejectUnauthorized: false` for every call.
 *  - Redirects are NOT followed (a 302 to an identity provider is how we detect SSO tenants).
 */
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { FusionError } from './errors';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowInsecureTls?: boolean;
  /** Hard cap for the (decompressed) response, protects the extension host from runaway results. */
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED'
]);

export function mapNetworkError(e: NodeJS.ErrnoException, host: string): FusionError {
  const code = e.code ?? '';
  if (TLS_CODES.has(code)) {
    return new FusionError('tls', `TLS certificate problem talking to ${host} (${code}).`, {
      code,
      hint:
        'If you are behind a corporate proxy that inspects HTTPS, make sure its root certificate is trusted by your OS ' +
        '(VS Code uses the system store) or set NODE_EXTRA_CA_CERTS. As a last resort you can enable "Allow untrusted TLS certificate" on this connection.',
      cause: e
    });
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new FusionError('network', `Cannot resolve host "${host}".`, {
        code,
        hint: 'Check the pod URL (https://<pod>.fa.<region>.oraclecloud.com) and your network / VPN.',
        cause: e
      });
    case 'ECONNREFUSED':
      return new FusionError('network', `Connection to ${host} was refused.`, { code, cause: e });
    case 'ECONNRESET':
    case 'EPIPE':
      return new FusionError('network', `Connection to ${host} was reset by the server or a proxy.`, {
        code,
        hint: 'Large queries can hit gateway limits. Try a smaller fetch size, or retry.',
        cause: e
      });
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new FusionError('network', `Cannot reach ${host} (${code}).`, { code, hint: 'Check your network / VPN connection.', cause: e });
    default:
      return new FusionError('network', `Network error talking to ${host}: ${e.message}`, { code, cause: e });
  }
}

function decode(buf: Buffer, encoding: string): Promise<Buffer> {
  const enc = encoding.toLowerCase();
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (enc.includes('gzip')) {
      zlib.gunzip(buf, cb);
    } else if (enc.includes('deflate')) {
      zlib.inflate(buf, (err, out) => (err ? zlib.inflateRaw(buf, cb) : resolve(out)));
    } else if (enc.includes('br')) {
      zlib.brotliDecompress(buf, cb);
    } else {
      resolve(buf);
    }
  });
}

export function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      reject(new FusionError('config', `"${req.url}" is not a valid URL.`));
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      reject(new FusionError('config', `Unsupported URL scheme "${url.protocol}" (use https://).`));
      return;
    }
    if (req.signal?.aborted) {
      reject(new FusionError('cancelled', 'Cancelled.'));
      return;
    }

    const lib = url.protocol === 'https:' ? https : http;
    const bodyBuf = req.body === undefined ? undefined : Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'utf8');
    const headers: Record<string, string> = {
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': 'FusionSqlDev/2 (VS Code)',
      ...req.headers
    };
    if (bodyBuf) {
      headers['Content-Length'] = String(bodyBuf.length);
    }

    const options: https.RequestOptions = {
      method: req.method ?? (bodyBuf ? 'POST' : 'GET'),
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers
    };
    if (url.protocol === 'https:' && req.allowInsecureTls) {
      options.rejectUnauthorized = false;
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      req.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (err: Error) => finish(() => reject(err));

    const request = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const cap = req.maxBytes ?? 256 * 1024 * 1024;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > cap) {
          request.destroy(new FusionError('http', `Response exceeded ${Math.round(cap / 1048576)} MB. Lower the fetch size or add a WHERE clause.`));
          return;
        }
        chunks.push(c);
      });
      res.on('error', (e) => fail(mapNetworkError(e, url.host)));
      res.on('end', () => {
        decode(Buffer.concat(chunks), String(res.headers['content-encoding'] ?? ''))
          .catch(() => Buffer.concat(chunks))
          .then((raw) => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw.toString('utf8') })));
      });
    });

    const onAbort = () => request.destroy(new FusionError('cancelled', 'Cancelled.'));
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const timeoutMs = req.timeoutMs ?? 120000;
    timer = setTimeout(() => {
      request.destroy(
        new FusionError('timeout', `No response from ${url.host} within ${Math.round(timeoutMs / 1000)} s.`, {
          hint: 'The query may still be running on the pod. Increase "fusionSqlDev.queryTimeoutSeconds" or make the query cheaper.'
        })
      );
    }, timeoutMs);

    request.on('error', (e: NodeJS.ErrnoException) => {
      if (e instanceof FusionError) {
        fail(e);
      } else {
        fail(mapNetworkError(e, url.host));
      }
    });

    if (bodyBuf) {
      request.write(bodyBuf);
    }
    request.end();
  });
}
