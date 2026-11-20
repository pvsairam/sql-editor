/**
 * FusionClient: runs SQL on an Oracle Fusion Cloud pod through the helper BI Publisher report and
 * installs that helper automatically when it is missing (no manual catalog import needed).
 */
import {
  BodyCredentials,
  PUB_WSS_NS,
  SCH_WSS_NS,
  cancelScheduleBody,
  classifyResponse,
  createFolderBody,
  createFolderWssBody,
  deleteObjectBody,
  deleteObjectWssBody,
  envelope,
  getAllJobInstanceIdsBody,
  getDocumentDataBody,
  getFolderContentsBody,
  getFolderContentsWssBody,
  getReportHistoryInfoBody,
  objectExistWssBody,
  parseDocumentData,
  parseFolderFileNames,
  parseJobHistoryStatus,
  parseJobInstanceIds,
  parseObjectExist,
  parseReportBytes,
  parseScheduledJobId,
  runReportBody,
  runReportWssBody,
  scheduleReportBody,
  soap12Envelope,
  uploadObjectBody,
  uploadObjectWssBody
} from './soap';
import { FusionError, SSO_HINT } from './errors';
import { HttpResponse, httpRequest } from './http';
import { parseDelimited } from './csv';
import { buildCatalogFile, buildRuntime, DEFAULT_DATA_SOURCE, encodeSql, extractFromArchive, legacyReportPaths, patchReportZip, runtimePaths } from './runtime';
import { AuthSession, AuthStyle, Logger, nullLogger, QueryPage } from './types';
import { prepareStatement, wrapForPaging } from '../sql/prepare';

export interface BackgroundRunOptions {
  signal?: AbortSignal;
  pollMs?: number;
  maxWaitMs?: number;
  jobName?: string;
  onProgress?: (status: string, jobId?: string) => void;
}

export interface FusionClientOptions {
  baseUrl: string;
  auth: AuthSession;
  /** Catalog folder holding the helper, default `/~<username>`. */
  catalogRoot?: string;
  dataSource?: string;
  timeoutMs?: number;
  allowInsecureTls?: boolean;
  log?: Logger;
  /** Report path discovered earlier (persisted by the caller to skip probing). */
  knownReportPath?: string;
  /** Initial basic-auth style; learned automatically on SSO redirects. */
  authStyle?: AuthStyle;
}

export interface RunOptions {
  offset?: number;
  limit: number;
  signal?: AbortSignal;
}

export interface TestResult {
  ok: boolean;
  authenticated: boolean;
  runtimeReady: boolean;
  reportPath?: string;
  latencyMs: number;
  message: string;
  error?: FusionError;
}

export function normalizeBaseUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) {
    s = 'https://' + s;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new FusionError('config', `"${input}" is not a valid URL.`, { hint: 'Example: https://abcd.fa.us2.oraclecloud.com' });
  }
  return u.origin;
}

export class FusionClient {
  readonly baseUrl: string;
  readonly catalogRoot: string;
  readonly dataSource: string;
  private readonly auth: AuthSession;
  private readonly timeoutMs: number;
  private readonly insecure: boolean;
  private readonly log: Logger;
  private style: AuthStyle;
  private transport: 'soap' | 'wss' | 'rest' = 'soap';
  private catalogTransport: 'soap' | 'wss' = 'soap';
  reportPath?: string;

  constructor(opts: FusionClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.auth = opts.auth;
    this.catalogRoot = (opts.catalogRoot ?? `/~${opts.auth.username}`).replace(/\/+$/, '');
    this.dataSource = opts.dataSource || DEFAULT_DATA_SOURCE;
    this.timeoutMs = opts.timeoutMs ?? 300000;
    this.insecure = opts.allowInsecureTls ?? false;
    this.log = opts.log ?? nullLogger;
    this.reportPath = opts.knownReportPath;
    this.style = opts.authStyle ?? 'both';
  }

  // ---------------------------------------------------------------------------------------------
  // transport
  // ---------------------------------------------------------------------------------------------

  private async headers(signal?: AbortSignal, mode: 'default' | 'cookie-only' | 'bearer-only' = 'default'): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml, application/xml, */*' };
    if (mode !== 'cookie-only') {
      const authz = this.auth.method === 'basic' && this.style === 'body' ? undefined : await this.auth.authorization(signal);
      if (authz) {
        h['Authorization'] = authz;
      }
    }
    if (mode !== 'bearer-only') {
      const cookie = this.auth.cookie?.();
      if (cookie) {
        h['Cookie'] = cookie;
      }
    }
    return h;
  }

  private bodyCreds(): BodyCredentials | null {
    if (this.auth.method === 'basic' && this.style !== 'header') {
      return { userID: this.auth.username, password: this.auth.password ?? '' };
    }
    return null;
  }

  /** POST a SOAP v2 request; classify failures. `inner` gets the credentials block to embed. */
  private async soap(service: 'ReportService' | 'CatalogService', inner: (c: BodyCredentials | null) => string, timeoutMs: number, signal?: AbortSignal): Promise<HttpResponse> {
    const url = `${this.baseUrl}/xmlpserver/services/v2/${service}`;
    const hasCookie = !!this.auth.cookie?.();
    const attempt = async (mode: 'default' | 'cookie-only' | 'bearer-only' = 'default'): Promise<{ res: HttpResponse; err?: FusionError }> => {
      const started = Date.now();
      const res = await httpRequest({
        url,
        method: 'POST',
        headers: await this.headers(signal, mode),
        body: envelope(inner(this.bodyCreds())),
        timeoutMs,
        signal,
        allowInsecureTls: this.insecure
      });
      this.log.debug(`POST v2/${service} (${mode}) -> HTTP ${res.status} (${Date.now() - started} ms, ${res.body.length} chars)`);
      return { res, err: classifyResponse(res.status, res.headers, res.body, this.auth.method) };
    };

    // On SOAP 1.1 v2 endpoints, a browser SSO session works best with Cookie-only first (sending an
    // Authorization: Bearer JWT alongside empty <userID>/<password> causes WebLogic/BIP v2 to reject
    // it as "Invalid username or password"). Fall back to Bearer+Cookie if Cookie-only is rejected.
    const initialMode: 'default' | 'cookie-only' = this.auth.method === 'browser' && hasCookie ? 'cookie-only' : 'default';
    let { res, err } = await attempt(initialMode);
    if (err && (err.kind === 'auth' || err.kind === 'sso') && initialMode === 'cookie-only') {
      const authz = await this.auth.authorization(signal);
      if (authz) {
        this.log.debug(`v2/${service} rejected cookie-only; retrying with Bearer token.`);
        ({ res, err } = await attempt('default'));
      }
    }
    // A redirect / HTML page means the pod never evaluated our credentials (SSO). Retrying with the
    // other basic-auth style is therefore safe (it cannot count as a failed password attempt).
    if (err?.kind === 'sso' && this.auth.method === 'basic' && this.style === 'both') {
      this.log.info('SSO-style response with Basic auth; retrying with credentials in the SOAP body only.');
      this.style = 'body';
      ({ res, err } = await attempt());
      if (err?.kind === 'sso') {
        this.style = 'header';
        ({ res, err } = await attempt());
      }
      if (err?.kind === 'sso') {
        this.style = 'both';
      }
    }
    if (err) {
      throw err;
    }
    return res;
  }

  /** POST a SOAP 1.2 WSS request (ExternalReportWSSService / ScheduleReportWSSService / CatalogService). */
  private async soapWss(service: 'ExternalReportWSSService' | 'ScheduleReportWSSService' | 'CatalogService', bodyXml: string, timeoutMs: number, signal?: AbortSignal): Promise<HttpResponse> {
    const url = `${this.baseUrl}/xmlpserver/services/${service}`;
    const sendOnce = async (mode: 'default' | 'cookie-only'): Promise<{ res: HttpResponse; err?: FusionError }> => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        Accept: 'application/soap+xml, text/xml, */*'
      };
      if (mode !== 'cookie-only') {
        const authz = await this.auth.authorization(signal);
        if (authz) {
          headers['Authorization'] = authz;
        }
      }
      const cookie = this.auth.cookie?.();
      if (cookie) {
        headers['Cookie'] = cookie;
      }
      const started = Date.now();
      const res = await httpRequest({ url, method: 'POST', headers, body: bodyXml, timeoutMs, signal, allowInsecureTls: this.insecure });
      this.log.debug(`POST ${service} (${mode}) -> HTTP ${res.status} (${Date.now() - started} ms, ${res.body.length} chars)`);
      return { res, err: classifyResponse(res.status, res.headers, res.body, this.auth.method) };
    };

    let { res, err } = await sendOnce('default');
    if (err && (err.kind === 'auth' || err.kind === 'sso') && this.auth.method === 'browser' && this.auth.cookie?.()) {
      this.log.debug(`${service} rejected Bearer+Cookie; retrying with Cookie only.`);
      ({ res, err } = await sendOnce('cookie-only'));
    }
    if (err) {
      throw err;
    }
    return res;
  }

  // ---------------------------------------------------------------------------------------------
  // report execution
  // ---------------------------------------------------------------------------------------------

  private async runReportWss(reportPath: string, encodedSql: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.soapWss('ExternalReportWSSService', soap12Envelope('pub', PUB_WSS_NS, runReportWssBody(reportPath, encodedSql)), this.timeoutMs, signal);
    const bytes = parseReportBytes(res.body);
    if (!bytes) {
      throw new FusionError('parse', 'ExternalReportWSSService answered without report data (reportBytes missing).', {
        hint: 'The helper report may be damaged. Run "Fusion SQL: Install / Repair Helper Report on Pod".'
      });
    }
    return bytes;
  }

  private async runReportAt(reportPath: string, encodedSql: string, signal?: AbortSignal): Promise<Buffer> {
    if (this.transport === 'rest') {
      return this.runReportRest(reportPath, encodedSql, signal);
    }
    if (this.transport === 'wss') {
      return this.runReportWss(reportPath, encodedSql, signal);
    }
    try {
      const res = await this.soap('ReportService', (c) => runReportBody(reportPath, encodedSql, c), this.timeoutMs, signal);
      const bytes = parseReportBytes(res.body);
      if (!bytes) {
        throw new FusionError('parse', 'BI Publisher answered without report data (reportBytes missing).', {
          hint: 'The helper report may be damaged. Run "Fusion SQL: Install / Repair Helper Report on Pod".'
        });
      }
      return bytes;
    } catch (e) {
      // Token / browser-session SSO: try ExternalReportWSSService (SOAP 1.2) first, then REST v1.
      const canFallback = e instanceof FusionError && (e.kind === 'auth' || e.kind === 'sso' || (e.kind === 'http' && e.status === 404)) && this.auth.method !== 'basic';
      if (canFallback) {
        this.log.info('SOAP v2 endpoint rejected the session; trying ExternalReportWSSService (SOAP 1.2).');
        try {
          const bytes = await this.runReportWss(reportPath, encodedSql, signal);
          this.transport = 'wss';
          return bytes;
        } catch (eWss) {
          const wssCanFallback = eWss instanceof FusionError && (eWss.kind === 'auth' || eWss.kind === 'sso' || (eWss.kind === 'http' && eWss.status === 404));
          if (!wssCanFallback) {
            throw eWss;
          }
          this.log.info('ExternalReportWSSService rejected the session; trying the REST endpoint.');
          const bytes = await this.runReportRest(reportPath, encodedSql, signal);
          this.transport = 'rest';
          return bytes;
        }
      }
      throw e;
    }
  }

  private async runReportRest(reportPath: string, encodedSql: string, signal?: AbortSignal): Promise<Buffer> {
    const seg = reportPath.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const authz = await this.auth.authorization(signal);
    if (authz) {
      headers['Authorization'] = authz;
    }
    const cookie = this.auth.cookie?.();
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    const res = await httpRequest({
      url: `${this.baseUrl}/xmlpserver/services/rest/v1/reports/${seg}/run`,
      method: 'POST',
      headers,
      body: JSON.stringify({
        byPassCache: true,
        flattenXML: false,
        attributeFormat: 'csv',
        parameterNameValues: { listOfParamNameValues: { item: [{ name: 'P_B64_CONTENT', values: { item: [encodedSql] } }] } }
      }),
      timeoutMs: this.timeoutMs,
      signal,
      allowInsecureTls: this.insecure
    });
    this.log.debug(`POST REST run -> HTTP ${res.status}`);
    if (res.status === 401) {
      throw new FusionError('auth', 'The access token was rejected (HTTP 401).', { status: 401, hint: 'Sign in again (right-click the connection > Sign In).' });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new FusionError('sso', `The server redirected to a login page (HTTP ${res.status}).`, { status: res.status, hint: SSO_HINT });
    }
    if (res.status !== 200) {
      const err = classifyResponse(res.status, res.headers, res.body, this.auth.method);
      throw err ?? new FusionError('http', `REST run failed with HTTP ${res.status}.`, { status: res.status });
    }
    let json: { reportBytes?: string };
    try {
      json = JSON.parse(res.body) as { reportBytes?: string };
    } catch {
      throw new FusionError('sso', 'The server returned a web page instead of JSON.', { status: res.status, hint: SSO_HINT });
    }
    if (typeof json.reportBytes !== 'string') {
      throw new FusionError('parse', 'REST response did not contain reportBytes.');
    }
    return Buffer.from(json.reportBytes, 'base64');
  }

  /** Candidate locations of the helper report, most specific first. */
  private candidates(): string[] {
    const ours = runtimePaths({ catalogRoot: this.catalogRoot, dataSource: this.dataSource }).reportPath;
    const list = [this.reportPath, ours, ...legacyReportPaths(this.catalogRoot)].filter((p): p is string => !!p);
    return [...new Set(list)];
  }

  /** Find a working helper report. Returns its path, or undefined when none is deployed. */
  async discoverRuntime(signal?: AbortSignal): Promise<string | undefined> {
    for (const path of this.candidates()) {
      try {
        const bytes = await this.runReportAt(path, encodeSql(wrapForPaging('SELECT 1 AS OK FROM DUAL', 0, 1)), signal);
        if (/\bOK\b/.test(bytes.toString('utf8'))) {
          this.reportPath = path;
          this.log.info(`Helper report found at ${path}`);
          return path;
        }
      } catch (e) {
        // The exact wording of "report not found" differs between releases, so anything that is not an
        // ORA-/PLS- error is double-checked against the catalog before it is treated as fatal.
        const looksMissing =
          e instanceof FusionError &&
          (e.kind === 'runtime-missing' || ((e.kind === 'oracle' || e.kind === 'http' || e.kind === 'permission') && !/\b(?:ORA|PLS)-\d+/.test(e.message)));
        if (looksMissing && !(await this.objectExists(path))) {
          this.log.debug(`No helper at ${path}`);
          continue;
        }
        throw e;
      }
    }
    this.reportPath = undefined;
    return undefined;
  }

  /**
   * Execute one SELECT and return `limit` rows from `offset`.
   * Throws FusionError('runtime-missing') if the helper report is not installed.
   */
  async runSql(sql: string, opts: RunOptions): Promise<QueryPage> {
    const prepared = prepareStatement(sql);
    const started = Date.now();
    if (!this.reportPath) {
      const found = await this.discoverRuntime(opts.signal);
      if (!found) {
        throw new FusionError('runtime-missing', 'The helper BI Publisher report is not installed on this pod yet.');
      }
    }
    const offset = opts.offset ?? 0;
    let unpaged = false;
    let bytes: Buffer;
    try {
      bytes = await this.runReportAt(this.reportPath!, encodeSql(wrapForPaging(prepared.sql, offset, opts.limit + 1)), opts.signal);
    } catch (e) {
      if (e instanceof FusionError && e.kind === 'runtime-missing' && this.reportPath) {
        // Deleted after we found it (or never really there): force re-discovery.
        this.reportPath = undefined;
        throw e;
      }
      // Oracle BI Publisher's PublicReportService often reports "does not have permission to run the report"
      // when the helper report does not exist yet (or was deleted) in My Folders. Double-check the catalog!
      if (
        e instanceof FusionError &&
        e.kind === 'permission' &&
        /does not have permission to run the report/i.test(e.message) &&
        this.reportPath
      ) {
        const exists = await this.objectExists(this.reportPath).catch(() => true);
        if (!exists) {
          this.log.info(`Helper report ${this.reportPath} does not exist; triggering install.`);
          this.reportPath = undefined;
          throw new FusionError('runtime-missing', 'The helper BI Publisher report is not installed on this pod yet.', { cause: e });
        }
        throw new FusionError('permission', e.message, {
          status: e.status,
          hint:
            'The helper report exists but BI Publisher refused to run it. Right-click the connection and choose "Install / Repair Helper Report on Pod" to re-upload it with full BIAdministrator/BIAuthor/BIConsumer ACLs, or verify your user has a BI Consumer / BI Author role.',
          cause: e
        });
      }
      // Paging wrapper cannot handle duplicate / unnamed columns: run the statement as it is.
      if (e instanceof FusionError && e.kind === 'oracle' && /ORA-00918|ORA-00957/.test(e.message) && offset === 0) {
        this.log.info('Paging wrapper rejected (duplicate column names); running the statement unwrapped.');
        bytes = await this.runReportAt(this.reportPath!, encodeSql(prepared.sql), opts.signal);
        unpaged = true;
      } else {
        throw e;
      }
    }
    const table = parseDelimited(bytes, '|');
    const hasMore = table.rows.length > opts.limit;
    const rows = hasMore ? table.rows.slice(0, opts.limit) : table.rows;
    return { columns: table.columns, rows, hasMore, elapsedMs: Date.now() - started, unpaged };
  }

  /**
   * Execute a long-running SELECT asynchronously via BI Publisher's ScheduleReportWSSService,
   * bypassing the ~500s synchronous gateway timeout.
   */
  async runSqlBackground(sql: string, opts: BackgroundRunOptions = {}): Promise<QueryPage & { jobId: string }> {
    const prepared = prepareStatement(sql);
    const started = Date.now();
    if (!this.reportPath) {
      const found = await this.discoverRuntime(opts.signal);
      if (!found) {
        throw new FusionError('runtime-missing', 'The helper BI Publisher report is not installed on this pod yet.');
      }
    }
    const jobName = opts.jobName ?? `FusionSqlDev_${Date.now().toString(36)}`;
    const encoded = encodeSql(prepared.sql);
    opts.onProgress?.('Submitting background job…');
    const submitRes = await this.soapWss('ScheduleReportWSSService', soap12Envelope('sch', SCH_WSS_NS, scheduleReportBody(this.reportPath!, encoded, jobName)), Math.min(this.timeoutMs, 120000), opts.signal);
    const submittedJobId = parseScheduledJobId(submitRes.body);
    if (!submittedJobId) {
      throw new FusionError('parse', 'ScheduleReportWSSService did not return a job ID.');
    }
    this.log.info(`Background job submitted: #${submittedJobId}`);
    opts.onProgress?.(`Job #${submittedJobId}: Queued`, submittedJobId);

    const pollMs = opts.pollMs ?? 3000;
    const deadline = Date.now() + (opts.maxWaitMs ?? 1800_000);
    const sleepAbortable = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (opts.signal?.aborted) {
          reject(new FusionError('cancelled', 'Cancelled.'));
          return;
        }
        const t = setTimeout(() => {
          opts.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(t);
          reject(new FusionError('cancelled', 'Cancelled.'));
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });

    let jobInstanceId = submittedJobId;
    const cancelRemote = async () => {
      try {
        await this.soapWss('ScheduleReportWSSService', soap12Envelope('sch', SCH_WSS_NS, cancelScheduleBody(jobInstanceId)), 15000);
      } catch {
        /* best-effort remote cancel */
      }
    };

    try {
      for (;;) {
        if (opts.signal?.aborted) {
          throw new FusionError('cancelled', 'Cancelled.');
        }
        if (Date.now() > deadline) {
          throw new FusionError('timeout', `Background job #${submittedJobId} did not finish in time.`, {
            hint: 'Increase "fusionSqlDev.background.maxWaitSeconds" or check BI Publisher Report Job History on the pod.'
          });
        }
        // Discover the child job instance ID if it hasn't resolved yet
        if (jobInstanceId === submittedJobId) {
          try {
            const instRes = await this.soapWss('ScheduleReportWSSService', soap12Envelope('sch', SCH_WSS_NS, getAllJobInstanceIdsBody(submittedJobId)), 30000, opts.signal);
            const ids = parseJobInstanceIds(instRes.body);
            if (ids.length > 0) {
              jobInstanceId = ids[0];
            }
          } catch (e) {
            if (e instanceof FusionError && ['auth', 'sso', 'cancelled'].includes(e.kind)) {
              throw e;
            }
          }
        }
        const histRes = await this.soapWss('ScheduleReportWSSService', soap12Envelope('sch', SCH_WSS_NS, getReportHistoryInfoBody(jobInstanceId)), 30000, opts.signal);
        const hist = parseJobHistoryStatus(histRes.body);
        const st = hist.status.toUpperCase();
        opts.onProgress?.(`Job #${jobInstanceId}: ${hist.status || 'Running'}`, jobInstanceId);

        if (st === 'S' || st === 'SUCCESS' || st === 'SUCCEEDED') {
          const outputId = hist.outputIds[0] ?? jobInstanceId;
          opts.onProgress?.(`Job #${jobInstanceId}: Downloading result…`, jobInstanceId);
          const docRes = await this.soapWss('ScheduleReportWSSService', soap12Envelope('sch', SCH_WSS_NS, getDocumentDataBody(outputId)), this.timeoutMs, opts.signal);
          const bytes = parseDocumentData(docRes.body);
          if (!bytes) {
            throw new FusionError('parse', `Background job #${jobInstanceId} succeeded but returned no document data.`);
          }
          const table = parseDelimited(bytes, '|');
          return { columns: table.columns, rows: table.rows, hasMore: false, elapsedMs: Date.now() - started, unpaged: true, jobId: jobInstanceId };
        }
        if (st === 'F' || st === 'FAILED' || st === 'ERROR' || st === 'E') {
          throw new FusionError('oracle', hist.statusDetail || `Background job #${jobInstanceId} failed on BI Publisher.`);
        }
        if (st === 'C' || st === 'CANCELED' || st === 'CANCELLED') {
          throw new FusionError('cancelled', `Background job #${jobInstanceId} was cancelled on BI Publisher.`);
        }
        await sleepAbortable(pollMs);
      }
    } catch (e) {
      if (e instanceof FusionError && e.kind === 'cancelled') {
        void cancelRemote();
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // catalog / install
  // ---------------------------------------------------------------------------------------------

  /** Call CatalogService (SOAP 1.1), falling back to ExternalReportWSSService (SOAP 1.2) on SSO/JWT rejection. */
  private async catalogSoap(v2Inner: (c: BodyCredentials | null) => string, wssInner: string, timeoutMs: number, signal?: AbortSignal): Promise<HttpResponse> {
    if (this.catalogTransport === 'wss') {
      return this.soapWss('ExternalReportWSSService', soap12Envelope('pub', PUB_WSS_NS, wssInner), timeoutMs, signal);
    }
    try {
      return await this.soap('CatalogService', v2Inner, timeoutMs, signal);
    } catch (e) {
      const canFallback = e instanceof FusionError && (e.kind === 'auth' || e.kind === 'sso' || (e.kind === 'http' && e.status === 404)) && this.auth.method !== 'basic';
      if (canFallback) {
        this.log.info('SOAP v2 CatalogService rejected the session; trying ExternalReportWSSService (SOAP 1.2).');
        const res = await this.soapWss('ExternalReportWSSService', soap12Envelope('pub', PUB_WSS_NS, wssInner), timeoutMs, signal);
        this.catalogTransport = 'wss';
        return res;
      }
      throw e;
    }
  }

  private async folderExists(folder: string): Promise<'yes' | 'no'> {
    try {
      await this.catalogSoap((c) => getFolderContentsBody(folder, c), getFolderContentsWssBody(folder), 30000);
      return 'yes';
    } catch (e) {
      if (e instanceof FusionError && ['auth', 'sso', 'network', 'tls', 'timeout', 'cancelled'].includes(e.kind)) {
        throw e;
      }
      return 'no';
    }
  }

  async objectExists(path: string): Promise<boolean> {
    // When using SOAP 1.2 WSS (SSO/JWT), objectExist is a single direct check.
    if (this.catalogTransport === 'wss' || this.transport === 'wss') {
      try {
        const res = await this.soapWss('ExternalReportWSSService', soap12Envelope('pub', PUB_WSS_NS, objectExistWssBody(path)), 30000);
        const parsed = parseObjectExist(res.body);
        if (parsed !== undefined) {
          this.catalogTransport = 'wss';
          return parsed;
        }
      } catch (e) {
        if (e instanceof FusionError && ['network', 'tls', 'timeout', 'cancelled'].includes(e.kind)) {
          throw e;
        }
        /* fall through to getFolderContents */
      }
    }
    const idx = path.lastIndexOf('/');
    const parent = idx > 0 ? path.slice(0, idx) : '/';
    const name = path.slice(idx + 1);
    try {
      const res = await this.catalogSoap((c) => getFolderContentsBody(parent, c), getFolderContentsWssBody(parent), 30000);
      return parseFolderFileNames(res.body).includes(name);
    } catch (e) {
      if (e instanceof FusionError && ['auth', 'sso', 'network', 'tls', 'timeout', 'cancelled'].includes(e.kind)) {
        throw e;
      }
      return false;
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    try {
      await this.catalogSoap((c) => createFolderBody(folder, c), createFolderWssBody(folder), 30000);
    } catch (e) {
      if (e instanceof FusionError && ['auth', 'sso', 'network', 'tls', 'timeout', 'cancelled'].includes(e.kind)) {
        throw e;
      }
      // "already exists" is fine; any real problem surfaces at upload time.
      this.log.debug(`createFolder ${folder}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async upload(path: string, type: 'xdmz' | 'xdoz', zipped: Buffer, retried = false): Promise<void> {
    try {
      await this.catalogSoap((c) => uploadObjectBody(path, type, zipped, c), uploadObjectWssBody(path, type, zipped), 120000);
    } catch (e) {
      // Some releases refuse to overwrite: delete the old object once and try again.
      if (!retried && e instanceof FusionError && /exist|already|overwrit|duplicate/i.test(e.message)) {
        this.log.info(`Upload refused because ${path} exists; replacing it.`);
        try {
          await this.catalogSoap((c) => deleteObjectBody(path, c), deleteObjectWssBody(path), 30000);
        } catch {
          /* the retry below reports the real problem */
        }
        return this.upload(path, type, zipped, true);
      }
      if (e instanceof FusionError && /security violation/i.test(e.message)) {
        throw new FusionError('permission', `Could not upload ${path}: ${e.message}`, {
          hint:
            (type === 'xdoz' ? 'The data model was uploaded, but BI Publisher refused to create the REPORT: creating reports needs a BI authoring role (for example "BI Author Role" / "BI Administrator Role"), which is separate from owning the folder - even for a Fusion system administrator. ' : 'BI Publisher refused this upload. ') +
            'Quickest workaround: run "Fusion SQL: Save Helper Catalog File…", then in BI Publisher open Catalog → My Folders → Unarchive and select FusionSqlDevHelper.catalog. Afterwards Test Connection finds it. ' +
            'Or assign yourself a BI authoring role in the Security Console and retry.',
          status: e.status,
          code: 'SECURITY_VIOLATION',
          cause: e
        });
      }
      if (e instanceof FusionError && (e.kind === 'permission' || e.kind === 'oracle' || e.kind === 'runtime-missing' || e.kind === 'http')) {
        throw new FusionError('permission', `Could not upload ${path}: ${e.message}`, {
          hint:
            'Your user must be able to write to its personal catalog folder (My Folders) - the roles "BI Author" / "BI Administrator" or "Application Implementation Consultant" usually grant that. ' +
            'Alternatively ask an administrator to import the helper once into a shared folder (see docs/HELPER-REPORT.md) and set "Catalog folder" on the connection.',
          status: e.status,
          cause: e
        });
      }
      throw e;
    }
  }

  /** Create the helper data model + report on the pod (idempotent). */
  async installRuntime(signal?: AbortSignal): Promise<string> {
    const spec = { catalogRoot: this.catalogRoot, dataSource: this.dataSource };
    const art = buildRuntime(spec);
    try {
      await this.deployZips(art.rootFolder, art.versionFolder, art.dmPath, art.reportPath, art.dataModelZip, art.reportZip);
    } catch (e) {
      // The SOAP CatalogService refuses to create reports for some users ("Security violation"),
      // or rejects SSO sessions on v2/WSS catalog endpoints. When we have a browser cookie (or hit SECURITY_VIOLATION),
      // automatically unarchive our ACL-enriched .catalog directly into My Folders via Presentation Services (saw.dll).
      const hasCookie = !!this.auth.cookie?.();
      const canUnarchive =
        e instanceof FusionError &&
        (e.code === 'SECURITY_VIOLATION' || (hasCookie && (e.kind === 'permission' || e.kind === 'auth' || e.kind === 'sso')));
      if (!canUnarchive) {
        throw e;
      }
      this.log.info(`SOAP upload failed (${e.message}); trying Catalog Unarchive (saw.dll) into ${this.unarchiveTarget()}.`);
      try {
        await this.unarchiveCatalog(buildCatalogFile(spec, this.auth.username), signal);
      } catch (e2) {
        this.log.info(`Unarchive fallback failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
        throw e;
      }
    }
    return this.verifyInstalled(art.reportPath, signal);
  }

  /** The catalog folder `Unarchive` extracts into: "/~jdoe" -> "/users/jdoe", "/Custom" -> "/shared/Custom". */
  private unarchiveTarget(): string {
    if (this.catalogRoot.startsWith('/~')) {
      return this.catalogRoot.replace(/^\/~/, '/users/');
    }
    if (this.catalogRoot.startsWith('/Custom')) {
      return `/shared${this.catalogRoot}`;
    }
    return this.catalogRoot;
  }

  /** Merge Set-Cookie headers into an existing Cookie header string (later values override earlier ones by name). */
  private static mergeCookies(existing: string | undefined, setCookies: string[] | undefined): string {
    const jar = new Map<string, string>();
    const add = (raw: string) => {
      for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
          jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
        }
      }
    };
    if (existing) {
      add(existing);
    }
    for (const sc of setCookies ?? []) {
      add(sc.split(';')[0] ?? '');
    }
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * Fetch real anti-CSRF `_scid` and BI Presentation Services session cookies (`ORA_BIPS_LBINFO`, `SAW_SESSION`)
   * from `/analytics/saw.dll?Catalog`, following up to 5 same-origin redirects.
   */
  private async fetchPresentationScid(authHeaders: Record<string, string>, baseCookie: string | undefined, signal?: AbortSignal): Promise<{ scid: string; cookie: string }> {
    const fallback = 'now' + Math.random().toString(36).slice(2, 14);
    let cookie = baseCookie ?? '';
    let url = `${this.baseUrl}/analytics/saw.dll?Catalog`;
    const origin = new URL(this.baseUrl).origin;
    try {
      for (let hop = 0; hop < 5; hop++) {
        const headers: Record<string, string> = { ...authHeaders, Accept: 'text/html,*/*' };
        if (cookie) {
          headers['Cookie'] = cookie;
        }
        const res = await httpRequest({ url, method: 'GET', headers, timeoutMs: 20000, signal, allowInsecureTls: this.insecure });
        cookie = FusionClient.mergeCookies(cookie, res.headers['set-cookie']);
        if (res.status >= 300 && res.status < 400 && res.headers['location']) {
          const next = new URL(String(res.headers['location']), url);
          if (next.origin !== origin) {
            break; // redirected off-pod to external IdP
          }
          url = next.toString();
          continue;
        }
        if (res.status === 200 && res.body) {
          const m =
            /[?&]_scid=([A-Za-z0-9_-]{8,64})/i.exec(res.body) ??
            /_scid['"]?\s*[:=]\s*['"]([A-Za-z0-9_-]{8,64})['"]/i.exec(res.body) ??
            /name=["']_scid["'][^>]*value=["']([^"']+)["']/i.exec(res.body);
          if (m?.[1]) {
            this.log.debug(`Fetched real Presentation Services _scid (${m[1].length} chars)`);
            return { scid: m[1], cookie };
          }
        }
        break;
      }
      return { scid: fallback, cookie };
    } catch {
      return { scid: fallback, cookie };
    }
  }

  /** POST a .catalog archive to the same endpoint the Catalog page's Unarchive dialog uses. */
  async unarchiveCatalog(archive: Buffer, signal?: AbortSignal): Promise<void> {
    const authHeaders: Record<string, string> = {};
    const baseCookie = this.auth.cookie?.();
    // BI Presentation Services (saw.dll) expects browser session cookies on SSO pods; sending an OAuth/JWT
    // Authorization: Bearer header alongside cookies can cause OHS/WebGate to reject the request.
    if (!baseCookie || this.auth.method === 'basic') {
      const authz = await this.auth.authorization(signal);
      if (authz) {
        authHeaders['Authorization'] = authz;
      }
    }
    const { scid, cookie } = await this.fetchPresentationScid(authHeaders, baseCookie, signal);
    const boundary = '----FusionSqlDev' + Math.random().toString(16).slice(2);
    const field = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="FusionSqlDevHelper.catalog"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      archive,
      Buffer.from('\r\n'),
      field('replReadOnly', 'All'),
      field('repl', 'all'),
      field('aclReadOnly', 'Preserve'),
      field('acl', 'preserve'),
      field('Folder', this.unarchiveTarget()),
      field('ajaxType', 'iframe'),
      field('urlGenerator', 'qualified'),
      field('_scid', scid),
      Buffer.from(`--${boundary}--\r\n`)
    ]);
    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Accept: 'text/html,*/*'
    };
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    const res = await httpRequest({ url: `${this.baseUrl}/analytics/saw.dll?unArchiveCatalog`, method: 'POST', headers, body, timeoutMs: 120000, signal, allowInsecureTls: this.insecure });
    this.log.debug(`POST saw.dll?unArchiveCatalog -> HTTP ${res.status} (${res.body.length} chars)`);
    if (res.status >= 300 || /<form[^>]+(login|j_security)/i.test(res.body)) {
      throw new FusionError('sso', `Catalog Unarchive was not accepted (HTTP ${res.status}); the Presentation Services endpoint needs a browser-style session.`, { status: res.status, hint: 'Use the "Browser session" sign-in, or import the saved helper file manually (Catalog → Unarchive).' });
    }
    if (/error|exception|not authorized|permission denied/i.test(res.body.replace(/<script[\s\S]*?<\/script>/gi, ''))) {
      throw new FusionError('permission', `Catalog Unarchive failed: ${res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    }
  }

  /** Install from a user supplied .xdrz archive (fallback if the generated objects are not accepted). */
  async installRuntimeFromArchive(archive: Buffer, signal?: AbortSignal): Promise<string> {
    const { dataModelZip, reportZip } = extractFromArchive(archive);
    const paths = runtimePaths({ catalogRoot: this.catalogRoot, dataSource: this.dataSource });
    await this.deployZips(paths.rootFolder, paths.versionFolder, paths.dmPath, paths.reportPath, dataModelZip, patchReportZip(reportZip, paths.dmPath));
    return this.verifyInstalled(paths.reportPath, signal);
  }

  private async deployZips(rootFolder: string, versionFolder: string, dmPath: string, reportPath: string, dm: Buffer, report: Buffer): Promise<void> {
    this.log.info(`Installing helper report into ${versionFolder}`);
    await this.ensureFolder(this.catalogRoot); // no-op when it exists (personal folders are created lazily on some pods)
    await this.ensureFolder(rootFolder);
    await this.ensureFolder(versionFolder);
    await this.upload(dmPath, 'xdmz', dm);
    await this.upload(reportPath, 'xdoz', report);
  }

  private async verifyInstalled(reportPath: string, signal?: AbortSignal): Promise<string> {
    this.reportPath = reportPath;
    try {
      const bytes = await this.runReportAt(reportPath, encodeSql(wrapForPaging('SELECT 1 AS OK FROM DUAL', 0, 1)), signal);
      if (!/\bOK\b/.test(bytes.toString('utf8'))) {
        throw new FusionError('parse', `The helper report was installed but returned unexpected output: ${bytes.toString('utf8').slice(0, 200)}`);
      }
    } catch (e) {
      this.reportPath = undefined;
      if (e instanceof FusionError && (e.kind === 'runtime-missing' || e.kind === 'oracle')) {
        throw new FusionError('runtime-missing', `The helper report was uploaded but could not be executed: ${e.message}`, {
          hint:
            'The pod may have rejected the generated report definition. Use "Install Helper From a Catalog File (.xdrz)" with FusionQueryProxy.xdrz as a fallback, ' +
            'and share the Fusion SQL DEV output log (enable fusionSqlDev.debugLogging) so the generator can be corrected.',
          cause: e
        });
      }
      throw e;
    }
    return reportPath;
  }

  async removeRuntime(): Promise<void> {
    const paths = runtimePaths({ catalogRoot: this.catalogRoot, dataSource: this.dataSource });
    for (const p of [paths.reportPath, paths.dmPath]) {
      try {
        await this.catalogSoap((c) => deleteObjectBody(p, c), deleteObjectWssBody(p), 30000);
      } catch (e) {
        this.log.debug(`deleteObject ${p}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.reportPath = undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // diagnostics
  // ---------------------------------------------------------------------------------------------

  /** Authenticate, look for the helper, optionally install it, and run SELECT 1. */
  async test(install: () => Promise<boolean>, signal?: AbortSignal): Promise<TestResult> {
    const started = Date.now();
    const done = (r: Omit<TestResult, 'latencyMs'>): TestResult => ({ ...r, latencyMs: Date.now() - started });
    let catalogAuthErr: FusionError | undefined;
    try {
      await this.folderExists(this.catalogRoot);
    } catch (e) {
      const err = e instanceof FusionError ? e : new FusionError('network', String(e));
      // For SSO/Bearer connections, CatalogService SOAP may be blocked even when ExternalReportWSSService / REST works.
      // Let discoverRuntime() try WSS/REST before declaring authentication failed.
      if (this.auth.method !== 'basic' && (err.kind === 'auth' || err.kind === 'sso')) {
        catalogAuthErr = err;
      } else {
        return done({ ok: false, authenticated: false, runtimeReady: false, message: err.message, error: err });
      }
    }
    try {
      let path = await this.discoverRuntime(signal);
      if (!path) {
        if (catalogAuthErr) {
          return done({ ok: false, authenticated: false, runtimeReady: false, message: catalogAuthErr.message, error: catalogAuthErr });
        }
        if (await install()) {
          path = await this.installRuntime(signal);
        } else {
          return done({ ok: false, authenticated: true, runtimeReady: false, message: 'Signed in, but the helper report is not installed on the pod.' });
        }
      }
      return done({ ok: true, authenticated: true, runtimeReady: true, reportPath: path, message: `Connected. Helper report: ${path}` });
    } catch (e) {
      const err = e instanceof FusionError ? e : new FusionError('http', String(e));
      return done({ ok: false, authenticated: err.kind !== 'auth' && err.kind !== 'sso', runtimeReady: false, message: err.message, error: err });
    }
  }
}
