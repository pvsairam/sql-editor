/**
 * A small fake of the Oracle BI Publisher SOAP/REST endpoints used by the extension. It enforces
 * authentication, stores uploaded catalog objects (validating their zip structure) and "executes"
 * the gzip/base64 encoded SQL against an in-memory table, so the whole client can be exercised
 * end-to-end without a real pod.
 */
import * as http from 'http';
import * as zlib from 'zlib';
import { AddressInfo } from 'net';
import { readZip } from '../../src/fusion/zip';

export type MockAuthMode = 'basic' | 'bearer' | 'sso-header-redirect' | 'sso-always';

export interface MockOptions {
  mode?: MockAuthMode;
  user?: string;
  pass?: string;
  token?: string;
  /** For bearer mode: reject SOAP so the client must fall back to REST. */
  soapRejectsBearer?: boolean;
  /** Wording used for "report missing" faults. */
  missingReportFault?: 'recognizable' | 'opaque';
  /** Pretend the helper is already imported at this path (old manual-import flow). */
  preinstalled?: string[];
  /** Users who may not write to the catalog. */
  readOnlyCatalog?: boolean;
  /** uploadObject fails when the object already exists (some releases do not overwrite). */
  refuseOverwrite?: boolean;
  /** Data models may be uploaded but reports are refused (user lacks a BI authoring role). */
  denyReports?: boolean;
  denyUnarchive?: boolean;
  /** Rows of table DEMO_T. */
  rows?: number;
}

export interface UploadedObject {
  type: string;
  zip: Buffer;
  files: Record<string, string>;
}

export class MockFusion {
  server!: http.Server;
  url = '';
  objects = new Map<string, UploadedObject>();
  raw: Buffer = Buffer.alloc(0);
  unarchives: string[] = [];
  folders = new Set<string>();
  requests: { path: string; op: string; auth?: string; bodyCreds: boolean; status: number }[] = [];
  failedLogins = 0;
  private readonly o: Required<Omit<MockOptions, 'preinstalled'>> & { preinstalled: string[] };

  constructor(opts: MockOptions = {}) {
    this.o = {
      mode: 'basic',
      user: 'jdoe',
      pass: 's3cret',
      token: 'good-token',
      soapRejectsBearer: false,
      missingReportFault: 'recognizable',
      preinstalled: [],
      readOnlyCatalog: false,
      refuseOverwrite: false,
      denyReports: false,
      denyUnarchive: false,
      rows: 2500,
      ...opts
    };
    for (const p of this.o.preinstalled) {
      this.objects.set(p, { type: 'xdoz', zip: Buffer.alloc(0), files: {} });
    }
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.raw = Buffer.concat(chunks);
        this.handle(req, res, this.raw.toString('utf8'));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  // ---------------------------------------------------------------------------------------------

  private send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8', ...headers });
    res.end(body);
  }

  private fault(res: http.ServerResponse, message: string, status = 500) {
    const esc = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Oracle double-encodes the detail; reproduce that.
    const detail = `&lt;detail&gt;${esc.replace(/&/g, '&amp;')}&lt;/detail&gt;`;
    this.send(
      res,
      status,
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode><faultstring>oracle.xdo.webservice.exception.OperationFailedException: ${detail}</faultstring><detail>${esc}</detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>`
    );
  }

  /** Presentation Services Unarchive: parse the multipart upload and the native .catalog stream. */
  private unarchive(res: http.ServerResponse, text: string): void {
    const folder = /name="Folder"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? '';
    if (this.o.denyUnarchive) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>Error: not authorized to unarchive</body></html>');
      return;
    }
    this.unarchives.push(folder);
    const start = this.raw.indexOf('\r\n\r\n') + 4;
    const end = this.raw.indexOf('\r\n--', start);
    const cat = require('zlib').inflateSync(this.raw.subarray(start, end)) as Buffer;
    let i = 4;
    for (let k = 0; k < 4; k++) {
      i += 4 + cat.readUInt32LE(i);
    }
    const byPath = new Map<string, Record<string, string>>();
    const types = new Map<string, string>();
    for (;;) {
      const flag = cat.readUInt16LE(i);
      i += 2;
      if (flag === 2) {
        break;
      }
      const l = cat.readUInt32LE(i);
      const j = JSON.parse(cat.subarray(i + 4, i + 4 + l).toString());
      i += 4 + l;
      let data: Buffer | undefined;
      if (i < cat.length && cat.readUInt16LE(i) === 1) {
        const n = Number(cat.readBigUInt64LE(i + 2));
        data = cat.subarray(i + 10, i + 10 + n);
        i += 10 + n;
      }
      const full = String(j.OriginalPath).replace(/^\/users\//, '/~');
      if (j.ItemType === 1 && /\.(xdo|xdm)$/.test(full)) {
        types.set(full, full.endsWith('.xdo') ? 'xdoz' : 'xdmz');
        byPath.set(full, {});
      } else if (data) {
        const parent = full.slice(0, full.lastIndexOf('/'));
        byPath.get(parent)![j.ItemName] = data.toString('utf8');
      }
    }
    for (const [p, files] of byPath) {
      this.objects.set(p, { type: types.get(p)!, zip: Buffer.alloc(0), files });
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>Unarchive request is completed.</body></html>');
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const path = req.url ?? '';
    const authz = req.headers['authorization'];
    const op = /<v2:(\w+)>/.exec(body)?.[1] ?? (path.includes('/rest/') ? 'rest-run' : 'unknown');
    const bodyUser = /<v2:userID>([^<]*)<\/v2:userID>/.exec(body)?.[1] ?? '';
    const bodyPass = /<v2:password>([^<]*)<\/v2:password>/.exec(body)?.[1] ?? '';
    const log = (status: number) => this.requests.push({ path, op, auth: authz, bodyCreds: !!bodyUser, status });

    if (path.includes('saw.dll?unArchiveCatalog')) {
      this.unarchive(res, body);
      return;
    }
    const isRest = path.includes('/services/rest/');
    const basicHeaderOk = authz === 'Basic ' + Buffer.from(`${this.o.user}:${this.o.pass}`).toString('base64');
    const bodyOk = bodyUser === this.o.user && bodyPass === this.o.pass;

    // ---- authentication -------------------------------------------------------------------
    switch (this.o.mode) {
      case 'sso-always':
        log(302);
        res.writeHead(302, { Location: 'https://idp.example.com/login?x=1' }).end();
        return;
      case 'sso-header-redirect':
        if (authz) {
          log(302);
          res.writeHead(302, { Location: 'https://idp.example.com/login' }).end();
          return;
        }
        if (!bodyOk) {
          this.failedLogins++;
          log(401);
          this.fault(res, 'InvalidCredentials: Invalid username or password', 401);
          return;
        }
        break;
      case 'bearer': {
        const ok = authz === `Bearer ${this.o.token}`;
        if (!ok || (!isRest && this.o.soapRejectsBearer)) {
          log(401);
          res.writeHead(401, { 'Content-Type': 'text/html' }).end('<html><body>Unauthorized</body></html>');
          return;
        }
        break;
      }
      default:
        if (!basicHeaderOk && !bodyOk) {
          this.failedLogins++;
          log(401);
          this.fault(res, 'InvalidCredentials: Invalid username or password', 401);
          return;
        }
    }

    // ---- operations -----------------------------------------------------------------------
    try {
      if (isRest) {
        const m = /\/reports\/(.+)\/run$/.exec(path);
        const reportPath = '/' + decodeURIComponent(m![1]);
        const json = JSON.parse(body) as { parameterNameValues: { listOfParamNameValues: { item: { values: { item: string[] } }[] } } };
        const enc = json.parameterNameValues.listOfParamNameValues.item[0].values.item[0];
        const out = this.runReport(reportPath, enc);
        if (typeof out === 'string') {
          log(500);
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: out }));
          return;
        }
        log(200);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ reportBytes: out.toString('base64') }));
        return;
      }
      switch (op) {
        case 'runReport': {
          const reportPath = /<v2:reportAbsolutePath>([^<]*)<\/v2:reportAbsolutePath>/.exec(body)![1];
          const enc = /<v2:name>P_B64_CONTENT<\/v2:name>[\s\S]*?<v2:item>([^<]*)<\/v2:item>/.exec(body)![1];
          const out = this.runReport(reportPath, enc);
          if (typeof out === 'string') {
            log(500);
            this.fault(res, out);
            return;
          }
          log(200);
          this.send(
            res,
            200,
            `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><ns2:runReportResponse xmlns:ns2="http://xmlns.oracle.com/oxp/service/v2"><ns2:runReportReturn><ns2:reportBytes>${out.toString('base64')}</ns2:reportBytes><ns2:reportContentType>text/csv</ns2:reportContentType></ns2:runReportReturn></ns2:runReportResponse></env:Body></env:Envelope>`
          );
          return;
        }
        case 'createFolder': {
          const f = /<v2:folderAbsolutePath>([^<]*)</.exec(body)![1];
          if (this.o.readOnlyCatalog) {
            log(500);
            this.fault(res, 'User does not have permission to create folder');
            return;
          }
          if (this.folders.has(f)) {
            log(500);
            this.fault(res, 'Folder already exists');
            return;
          }
          this.folders.add(f);
          log(200);
          this.send(res, 200, '<env:Envelope xmlns:env="x"><env:Body><createFolderResponse/></env:Body></env:Envelope>');
          return;
        }
        case 'uploadObject': {
          const p = /<v2:reportObjectAbsolutePathURL>([^<]*)</.exec(body)![1];
          const type = /<v2:objectType>([^<]*)</.exec(body)![1];
          const data = Buffer.from(/<v2:objectZippedData>([^<]*)</.exec(body)![1], 'base64');
          if (this.o.readOnlyCatalog) {
            log(500);
            this.fault(res, 'User does not have permission to upload objects');
            return;
          }
          if (this.o.denyReports && type === 'xdoz') {
            log(500);
            this.fault(res, `Security violation: ${p}, user: ${this.o.user}, expect: 514, actual: 0`);
            return;
          }
          if (this.o.refuseOverwrite && this.objects.has(p)) {
            log(500);
            this.fault(res, `Object ${p} already exists`);
            return;
          }
          const files: Record<string, string> = {};
          for (const e of readZip(data)) {
            files[e.name] = e.data.toString('utf8');
          }
          if (type === 'xdmz' && !files['_datamodel.xdm']) {
            log(500);
            this.fault(res, 'Invalid data model archive');
            return;
          }
          if (type === 'xdoz' && !files['_report.xdo']) {
            log(500);
            this.fault(res, 'Invalid report archive');
            return;
          }
          this.objects.set(p, { type, zip: data, files });
          log(200);
          this.send(res, 200, '<env:Envelope xmlns:env="x"><env:Body><uploadObjectResponse><uploadObjectReturn>' + p + '</uploadObjectReturn></uploadObjectResponse></env:Body></env:Envelope>');
          return;
        }
        case 'deleteObject': {
          const p = /<v2:objectAbsolutePath>([^<]*)</.exec(body)![1];
          this.objects.delete(p);
          log(200);
          this.send(res, 200, '<env:Envelope xmlns:env="x"><env:Body><deleteObjectResponse/></env:Body></env:Envelope>');
          return;
        }
        case 'getFolderContents': {
          const f = /<v2:folderAbsolutePath>([^<]*)</.exec(body)![1];
          const known = this.folders.has(f) || [...this.objects.keys()].some((k) => k.startsWith(f + '/')) || /^\/~/.test(f) || f === '/Custom';
          if (!known) {
            log(500);
            this.fault(res, `Folder ${f} does not exist`);
            return;
          }
          const names = [...this.objects.keys()].filter((k) => k.slice(0, k.lastIndexOf('/')) === f).map((k) => k.slice(k.lastIndexOf('/') + 1));
          const items = names.map((n) => `<ns2:item><ns2:displayName>${n}</ns2:displayName><ns2:fileName>${n}</ns2:fileName></ns2:item>`).join('');
          log(200);
          this.send(res, 200, `<env:Envelope xmlns:env="x"><env:Body><ns2:getFolderContentsResponse xmlns:ns2="y"><ns2:getFolderContentsReturn><ns2:catalogContents>${items}</ns2:catalogContents></ns2:getFolderContentsReturn></ns2:getFolderContentsResponse></env:Body></env:Envelope>`);
          return;
        }
        default:
          log(404);
          this.send(res, 404, '<html>not found</html>');
      }
    } catch (e) {
      log(500);
      this.fault(res, 'Mock server error: ' + (e as Error).message);
    }
  }

  // ---------------------------------------------------------------------------------------------

  /** Returns CSV bytes, or an error string for a fault. */
  private runReport(reportPath: string, encodedSql: string): Buffer | string {
    const rpt = this.objects.get(reportPath);
    if (!rpt) {
      return this.o.missingReportFault === 'recognizable' ? `Report ${reportPath} does not exist in the catalog (path not found).` : `BIP internal failure code 17`;
    }
    if (rpt.type === 'xdoz') {
      // A deployed report must reference a data model that is also in the catalog.
      const dm = /<dataModel\s+url="([^"]*)"/.exec(rpt.files['_report.xdo'] ?? '')?.[1];
      if (dm && !this.objects.has(dm)) {
        return `Data model ${dm} not found`;
      }
    }
    let sql: string;
    try {
      sql = zlib.gunzipSync(Buffer.from(encodedSql, 'base64')).toString('utf8');
    } catch {
      return 'ORA-29261: bad argument (could not decode P_B64_CONTENT)';
    }
    return this.execute(sql);
  }

  private execute(sql: string): Buffer | string {
    let offset = 0;
    let limit = Infinity;
    let inner = sql;
    const w = /^SELECT \* FROM \(\n([\s\S]*)\n\) fusion_sql_page\nOFFSET (\d+) ROWS FETCH NEXT (\d+) ROWS ONLY$/.exec(sql);
    if (w) {
      inner = w[1];
      offset = Number(w[2]);
      limit = Number(w[3]);
    }
    const q = inner.replace(/\s+/g, ' ').trim();
    const csv = (cols: string[], rows: string[][]) => {
      const f = (v: string) => (/[|"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      return Buffer.from([cols.join('|'), ...rows.map((r) => r.map(f).join('|'))].join('\n') + '\n', 'utf8');
    };
    if (/^SELECT 1 AS OK FROM DUAL$/i.test(q)) {
      return csv(['OK'], [['1']].slice(offset, offset + limit));
    }
    if (/FROM DEMO_T\b/i.test(q)) {
      const all: string[][] = [];
      for (let i = 1; i <= this.o.rows; i++) {
        all.push([String(i), `Name ${i}`, i % 7 === 0 ? 'has|pipe' : i % 11 === 0 ? 'multi\nline "quoted"' : '  padded  ']);
      }
      return csv(['ID', 'NAME', 'NOTE'], all.slice(offset, offset + limit));
    }
    if (/FROM DUP_COLS\b/i.test(q) && w) {
      return 'ORA-00918: column ambiguously defined';
    }
    if (/FROM DUP_COLS\b/i.test(q)) {
      return csv(['A', 'A'], [['1', '2']]);
    }
    if (/FROM NO_ROWS\b/i.test(q)) {
      return csv(['ID', 'NAME'], []);
    }
    const t = /FROM\s+(\w+)/i.exec(q)?.[1] ?? 'X';
    return `ORA-00942: table or view does not exist\nORA-06512: at line 4\n(${t})`;
  }
}
