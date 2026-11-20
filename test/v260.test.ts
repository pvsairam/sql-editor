import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { AddressInfo } from 'net';
import { FusionClient } from '../src/fusion/bip';
import { FusionError } from '../src/fusion/errors';
import { BasicSession, BrowserSession, TokenSession, parseBrowserSession, serializeBrowserSession } from '../src/auth/sessions';
import { SHARED_CATALOG_ROOT, buildCatalogFile } from '../src/fusion/runtime';
import { MockFusion, MockOptions } from './helpers/mockFusion';
import { FakeHost, fakeContext, installFakeVscode } from './helpers/fakeVscode';
import { analyzeFusionSql, isReadOnlySql, neutralizeBindsForValidation, wrapValidationQuery } from '../src/ai/sqlAnalyzer';
import { diffTables, guessKeyColumns } from '../src/results/diff';
import { parseImportedConnections, serializeConnectionsForExport } from '../src/connections/exportImport';
import { Connection } from '../src/model';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const sharedHost = new FakeHost();
installFakeVscode(sharedHost, pkg);

async function withMock<T>(opts: MockOptions, fn: (m: MockFusion) => Promise<T>): Promise<T> {
  const m = new MockFusion(opts);
  await m.start();
  try {
    return await fn(m);
  } finally {
    await m.stop();
  }
}

// =========================================================================
// Pillar 1: BrowserSession, ExternalReportWSSService, Real _scid, Shared /Custom
// =========================================================================

test('Pillar 1: BrowserSession serializes/parses JWT+cookie and stays backward compatible with raw cookies', async () => {
  const futureExp = Date.now() + 3600_000;
  const serialized = serializeBrowserSession({ cookie: 'JSESSIONID=abc', bearerToken: 'eyJ.abc.def', tokenExpiresAt: futureExp });
  const parsed = parseBrowserSession(serialized)!;
  assert.equal(parsed.cookie, 'JSESSIONID=abc');
  assert.equal(parsed.bearerToken, 'eyJ.abc.def');
  const sess = new BrowserSession('jdoe', parsed);
  assert.equal(await sess.authorization(), 'Bearer eyJ.abc.def');
  assert.equal(sess.cookie(), 'JSESSIONID=abc');

  // Expired JWT drops Authorization header but retains session cookie
  const expiredSess = new BrowserSession('jdoe', { cookie: 'JSESSIONID=abc', bearerToken: 'old-jwt', tokenExpiresAt: Date.now() - 10_000 });
  assert.equal(await expiredSess.authorization(), undefined);
  assert.equal(expiredSess.cookie(), 'JSESSIONID=abc');

  // Legacy plain cookie string still parses cleanly
  const legacy = parseBrowserSession('ORA_FUSION=1; JSESSIONID=2')!;
  assert.equal(legacy.cookie, 'ORA_FUSION=1; JSESSIONID=2');
  assert.equal(legacy.bearerToken, undefined);
});

test('Pillar 1: bearer token falls back to ExternalReportWSSService (SOAP 1.2) and remembers it', async () => {
  await withMock({ mode: 'bearer', soapRejectsBearer: true, wssAcceptsBearer: true, preinstalled: ['/~jdoe/FusionSqlDev/v2/csv.xdo'] }, async (m) => {
    const client = new FusionClient({ baseUrl: m.url, auth: new TokenSession('jdoe', 'bearer', 'good-token'), timeoutMs: 10000 });
    const p1 = await client.runSql('SELECT * FROM DEMO_T', { limit: 5 });
    assert.equal(p1.rows.length, 5);
    assert.ok(m.requests.some((r) => r.path.includes('/ExternalReportWSSService') && r.status === 200));

    const before = m.requests.length;
    const p2 = await client.runSql('SELECT * FROM DEMO_T', { limit: 3 });
    assert.equal(p2.rows.length, 3);
    // Remembered WSS: no extra v2 SOAP retry!
    assert.equal(m.requests.slice(before).every((r) => r.path.includes('/ExternalReportWSSService')), true);
  });
});

test('Pillar 1: unarchiveCatalog fetches real _scid from saw.dll?Catalog before uploading', async () => {
  await withMock({ denyReports: true }, async (m) => {
    const client = new FusionClient({ baseUrl: m.url, auth: new BasicSession('jdoe', 's3cret'), timeoutMs: 10000 });
    const installed = await client.installRuntime();
    assert.equal(installed, '/~jdoe/FusionSqlDev/v2/csv.xdo');
    assert.ok(m.requests.some((r) => r.path.includes('saw.dll?Catalog') && r.status === 200));
    assert.deepEqual(m.unarchiveScids, ['REAL_SCID_987654321']);
  });
});

test('Pillar 1: shared /Custom/FusionSqlDev/v2 helper is discovered automatically and builds /shared/Custom catalog paths with full BI ACLs', async () => {
  const cat = zlib.inflateSync(buildCatalogFile({ catalogRoot: SHARED_CATALOG_ROOT, dataSource: 'ApplicationDB_FSCM' }, 'sairam.pakanati@sierra-cedar.com')).toString('utf8');
  assert.ok(cat.includes('/shared/Custom/FusionSqlDev/v2/csv.xdo'));
  assert.ok(cat.includes('"BIAdministrator"'), 'catalog includes BIAdministrator ACL');
  assert.ok(cat.includes('"BIAuthor"'), 'catalog includes BIAuthor ACL');
  assert.ok(cat.includes('"BIConsumer"'), 'catalog includes BIConsumer ACL');
  assert.ok(cat.includes('"Permissions":65535'), 'catalog grants full control to admins/authors/owner');
  assert.ok(cat.includes('"CatalogArchiveOptions":2'), 'catalog enables ACL preservation flag');
  assert.ok(cat.includes('"OwnerId":{"AccountType":0,"ID":"sairam.pakanati@sierra-cedar.com"}'), 'catalog sets OwnerId');

  await withMock({ preinstalled: ['/Custom/FusionSqlDev/v2/csv.xdo'] }, async (m) => {
    const client = new FusionClient({ baseUrl: m.url, auth: new BasicSession('jdoe', 's3cret'), timeoutMs: 10000 });
    assert.equal(await client.discoverRuntime(), '/Custom/FusionSqlDev/v2/csv.xdo');
  });
});

test('Pillar 1: Browser SSO uses Cookie-only first on SOAP 1.1 v2 endpoints so Bearer JWT never triggers false Invalid username or password', async () => {
  await withMock({ mode: 'basic', preinstalled: ['/~jdoe/FusionSqlDev/v2/csv.xdo'] }, async (m) => {
    // Override server listener check by inspecting what headers were sent on v2/CatalogService & v2/ReportService
    const sess = new BrowserSession('jdoe', { cookie: 'JSESSIONID=sess123', bearerToken: 'eyJ.jwt.tok', tokenExpiresAt: Date.now() + 3600_000 });
    const client = new FusionClient({ baseUrl: m.url, auth: sess, timeoutMs: 10000 });
    // Even though mock in basic mode will return 401, verify the first request to v2/CatalogService omitted Authorization: Bearer
    await client.objectExists('/~jdoe/FusionSqlDev/v2/csv.xdo').catch(() => undefined);
    assert.ok(m.requests.length >= 2, 'tried cookie-only first, then retried with Bearer');
    assert.equal(m.requests[0].auth, undefined, 'first v2 SOAP attempt for browser SSO must be cookie-only');
    assert.equal(m.requests[1].auth, 'Bearer eyJ.jwt.tok', 'fallback retries with Bearer JWT');
  });
});

test('Pillar 1: SSO/JWT automatically installs into My Folders over ExternalReportWSSService (SOAP 1.2) when v2 SOAP rejects bearer', async () => {
  await withMock({ mode: 'bearer', soapRejectsBearer: true, wssAcceptsBearer: true }, async (m) => {
    const client = new FusionClient({ baseUrl: m.url, auth: new TokenSession('jdoe', 'bearer', 'good-token'), timeoutMs: 10000 });
    const installed = await client.installRuntime();
    assert.equal(installed, '/~jdoe/FusionSqlDev/v2/csv.xdo');
    assert.ok(m.objects.has('/~jdoe/FusionSqlDev/v2/dm.xdm'));
    assert.ok(m.objects.has('/~jdoe/FusionSqlDev/v2/csv.xdo'));
    const p = await client.runSql('SELECT * FROM DEMO_T', { limit: 4 });
    assert.equal(p.rows.length, 4);
  });
});

// =========================================================================
// Pillar 2: Background SQL via ScheduleReportWSSService
// =========================================================================

test('Pillar 2: runSqlBackground schedules, polls to Success, and downloads full CSV result', async () => {
  await withMock({ rows: 12, preinstalled: ['/~jdoe/FusionSqlDev/v2/csv.xdo'] }, async (m) => {
    const client = new FusionClient({ baseUrl: m.url, auth: new BasicSession('jdoe', 's3cret'), timeoutMs: 10000 });
    const progress: string[] = [];
    const res = await client.runSqlBackground('SELECT * FROM DEMO_T', { pollMs: 25, onProgress: (s) => progress.push(s) });
    assert.equal(res.rows.length, 12);
    assert.deepEqual(res.columns, ['ID', 'NAME', 'NOTE']);
    assert.equal(res.hasMore, false);
    assert.ok(res.jobId);
    assert.ok(progress.some((p) => /Running/i.test(p)));
    assert.ok(progress.some((p) => /Downloading/i.test(p)));
  });
});

test('Pillar 2: cancelling runSqlBackground sends cancelSchedule and throws cancelled', async () => {
  await withMock({ rows: 5, preinstalled: ['/~jdoe/FusionSqlDev/v2/csv.xdo'] }, async (m) => {
    const client = new FusionClient({ baseUrl: m.url, auth: new BasicSession('jdoe', 's3cret'), timeoutMs: 10000 });
    const ac = new AbortController();
    await assert.rejects(
      client.runSqlBackground('SELECT * FROM DEMO_T', {
        pollMs: 500,
        signal: ac.signal,
        onProgress: (s) => {
          if (/Running/i.test(s)) {
            ac.abort();
          }
        }
      }),
      (e: FusionError) => e.kind === 'cancelled'
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(m.cancelledJobs.length >= 1, 'remote cancelSchedule should be called');
  });
});

// =========================================================================
// Pillar 3: Persistent SchemaService (Tables, Views, Synonyms, Packages)
// =========================================================================

test('Pillar 3: SchemaService syncs all 4 object types, persists to disk, resolves synonyms & ALL_SOURCE', async () => {
  const ctx = fakeContext(sharedHost, pkg);
  const { ConnectionStore } = require('../src/connections/ConnectionStore');
  const { ConnectionManager } = require('../src/connections/ConnectionManager');
  const { SchemaService } = require('../src/schema/SchemaService');
  const { SchemaTree, CategoryNode, ObjectNode } = require('../src/schema/schemaTree');
  const { nullLogger } = require('../src/fusion/types');

  await withMock({ preinstalled: ['/~jdoe/FusionSqlDev/v2/csv.xdo'] }, async (m) => {
    const store = new ConnectionStore(ctx, nullLogger);
    const conn: Connection = { id: 'sc1', name: 'DEV', url: m.url, username: 'jdoe', auth: 'basic', environment: 'DEV', createdAt: 1 };
    await store.save(conn);
    await store.setActive(conn.id);
    await store.setPassword(conn.id, 's3cret');
    const manager = new ConnectionManager(store, nullLogger, ctx.globalStorageUri.fsPath);
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-cache-'));

    const schema1 = new SchemaService(manager, nullLogger, storageDir);
    const objs = await schema1.objects(conn);
    assert.equal(objs.length, 5);
    assert.ok(objs.some((o: any) => o.type === 'TABLE' && o.name === 'DEMO_T'));
    assert.ok(objs.some((o: any) => o.type === 'VIEW' && o.name === 'DEMO_V'));
    assert.ok(objs.some((o: any) => o.type === 'SYNONYM' && o.name === 'DEMO_SYN'));
    assert.ok(objs.some((o: any) => o.type === 'PACKAGE' && o.name === 'DEMO_PKG'));

    // Second instance hydrates instantaneously from disk without hitting the server
    const reqsBefore = m.requests.length;
    const schema2 = new SchemaService(manager, nullLogger, storageDir);
    const hydrated = await schema2.objects(conn);
    assert.equal(hydrated.length, 5);
    assert.equal(m.requests.length, reqsBefore, 'hydrated from disk cache with zero network requests');

    // In-memory filtering
    await schema2.setFilter(conn, 'PKG');
    assert.deepEqual((await schema2.objects(conn)).map((o: any) => o.name), ['DEMO_PKG']);
    await schema2.setFilter(conn, '');

    // Synonym resolution & synonym column expansion
    const synTarget = await schema2.synonymTarget(conn, 'DEMO_SYN', 'FUSION');
    assert.equal(synTarget?.tableName, 'DEMO_T');
    const synCols = await schema2.columns(conn, 'DEMO_SYN', 'FUSION');
    assert.deepEqual(synCols.map((c: any) => c.name), ['ID', 'NAME', 'NOTE']);

    // Package source from ALL_SOURCE
    const src = await schema2.packageSource(conn, 'DEMO_PKG', 'FUSION');
    assert.match(src, /PACKAGE SPECIFICATION: FUSION\.DEMO_PKG/);
    assert.match(src, /PROCEDURE run_check/);
    assert.match(src, /PACKAGE BODY: FUSION\.DEMO_PKG/);

    // SchemaTree groups into 4 categories and assigns collision-free IDs even when TABLE + SYNONYM share DEMO_T
    const tree = new SchemaTree(store, schema2);
    const top = await tree.getChildren();
    const cats = top.filter((n: any) => n instanceof CategoryNode);
    assert.equal(cats.length, 4);
    const tableNodes = await tree.getChildren(cats.find((c: any) => c.objectType === 'TABLE'));
    const synNodes = await tree.getChildren(cats.find((c: any) => c.objectType === 'SYNONYM'));
    const tableId = (tableNodes.find((n: any) => n instanceof ObjectNode && n.obj.name === 'DEMO_T') as any).id;
    const synId = (synNodes.find((n: any) => n instanceof ObjectNode && n.obj.name === 'DEMO_T') as any).id;
    assert.notEqual(tableId, synId, 'TABLE and SYNONYM with same name must have distinct TreeItem IDs');
  });
});

// =========================================================================
// Pillar 4: Static SQL Analyzer + Read-Only Validate & Auto-Repair
// =========================================================================

test('Pillar 4: sqlAnalyzer enforces read-only, flags Fusion risks, and neutralizes binds safely', () => {
  assert.equal(isReadOnlySql('SELECT 1 FROM dual'), true);
  assert.equal(isReadOnlySql('WITH x AS (SELECT 1 a FROM dual) SELECT * FROM x'), true);
  assert.equal(isReadOnlySql('DELETE FROM per_all_people_f'), false);
  assert.equal(isReadOnlySql('UPDATE gl_balances SET period_net_dr = 0'), false);
  assert.equal(isReadOnlySql('BEGIN NULL; END;'), false);

  const w1 = analyzeFusionSql('SELECT * FROM gl_balances');
  assert.ok(w1.some((w) => w.code === 'UNRESTRICTED_LARGE_TABLE'));
  assert.ok(w1.some((w) => w.code === 'SELECT_STAR_UNBOUNDED'));

  const w2 = analyzeFusionSql('SELECT p.person_id FROM per_all_people_f p JOIN fnd_lookup_values_tl tl ON 1=1');
  assert.ok(w2.some((w) => w.code === 'MISSING_EFFECTIVE_DATE'));
  assert.ok(w2.some((w) => w.code === 'MISSING_LANGUAGE_FILTER'));

  const wClean = analyzeFusionSql(
    "SELECT p.person_id FROM per_all_people_f p WHERE TRUNC(SYSDATE) BETWEEN p.effective_start_date AND p.effective_end_date FETCH FIRST 10 ROWS ONLY"
  );
  assert.equal(wClean.length, 0);

  const neutralized = neutralizeBindsForValidation("SELECT * FROM demo_t WHERE id = :p_id AND note <> ':literal_not_bind'");
  assert.equal(neutralized, "SELECT * FROM demo_t WHERE id = NULL AND note <> ':literal_not_bind'");
  assert.match(wrapValidationQuery('SELECT 1 FROM dual;', 'rownum', 25), /ROWNUM <= 25/);
  assert.match(wrapValidationQuery('SELECT 1 FROM dual;', 'fetch', 25), /FETCH FIRST 25 ROWS ONLY/);
});

test('Pillar 4: validateAndRepairSql refuses DML and auto-repairs ORA-00942 via BYOK endpoint', async () => {
  const ctx = fakeContext(sharedHost, pkg);
  const { ConnectionStore } = require('../src/connections/ConnectionStore');
  const { ConnectionManager } = require('../src/connections/ConnectionManager');
  const { SchemaService } = require('../src/schema/SchemaService');
  const { validateAndRepairSql } = require('../src/ai/repair');
  const { nullLogger } = require('../src/fusion/types');

  // Local mock OpenAI-compatible BYOK server that repairs NOPE_TABLE -> DEMO_T
  const llmSrv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        choices: [{ message: { content: 'Fixed table name:\n```sql\nSELECT id, name FROM DEMO_T\n```' } }]
      })
    );
  });
  await new Promise<void>((r) => llmSrv.listen(0, '127.0.0.1', r));
  const llmUrl = `http://127.0.0.1:${(llmSrv.address() as AddressInfo).port}/v1/chat/completions`;

  try {
    sharedHost.config['fusionSqlDev.ai.provider'] = 'openai';
    sharedHost.config['fusionSqlDev.ai.endpoint'] = llmUrl;
    sharedHost.config['fusionSqlDev.ai.model'] = 'mock-gpt';

    await withMock({ rows: 5, preinstalled: ['/~jdoe/FusionSqlDev/v2/csv.xdo'] }, async (m) => {
      const store = new ConnectionStore(ctx, nullLogger);
      const conn: Connection = { id: 'ai1', name: 'DEV', url: m.url, username: 'jdoe', auth: 'basic', environment: 'DEV', createdAt: 1 };
      await store.save(conn);
      await store.setPassword(conn.id, 's3cret');
      const manager = new ConnectionManager(store, nullLogger);
      const schema = new SchemaService(manager, nullLogger);

      // Refuses non-read-only immediately
      const dml = await validateAndRepairSql({ ctx, conn, sql: 'DELETE FROM DEMO_T', manager, schema, log: nullLogger });
      assert.equal(dml.ok, false);
      assert.match(dml.error ?? '', /read-only/i);

      // Auto-repairs ORA-00942 in 2 attempts
      const repaired = await validateAndRepairSql({ ctx, conn, sql: 'SELECT id, name FROM NOPE_TABLE', manager, schema, log: nullLogger, maxAttempts: 3 });
      assert.equal(repaired.ok, true, repaired.error);
      assert.equal(repaired.repaired, true);
      assert.equal(repaired.attempts.length, 2);
      assert.equal(repaired.sql, 'SELECT id, name FROM DEMO_T');
      assert.equal(repaired.sampleRowCount, 5);
    });
  } finally {
    delete sharedHost.config['fusionSqlDev.ai.provider'];
    delete sharedHost.config['fusionSqlDev.ai.endpoint'];
    delete sharedHost.config['fusionSqlDev.ai.model'];
    llmSrv.closeAllConnections();
    await new Promise<void>((r) => llmSrv.close(() => r()));
  }
});

// =========================================================================
// Pillar 5: Result Diff, Saved Queries, Secret-Free Connection Export/Import
// =========================================================================

test('Pillar 5: diffTables detects Added, Removed, Changed, and Unchanged rows cleanly', () => {
  const left = {
    columns: ['PERSON_ID', 'FULL_NAME', 'STATUS'],
    rows: [
      ['100', 'Alice', 'ACTIVE'],
      ['101', 'Bob', 'ACTIVE'],
      ['102', 'Carol', 'ACTIVE']
    ]
  };
  const right = {
    columns: ['PERSON_ID', 'FULL_NAME', 'STATUS'],
    rows: [
      ['100', 'Alice', 'ACTIVE'],
      ['101', 'Bob', 'INACTIVE'],
      ['103', 'Dave', 'ACTIVE']
    ]
  };
  assert.deepEqual(guessKeyColumns(left.columns, right.columns), ['PERSON_ID']);
  const d = diffTables(left, right, { leftLabel: 'DEV', rightLabel: 'PROD' });
  assert.equal(d.unchanged, 1);
  assert.equal(d.changed, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.added, 1);
  assert.equal(d.rows.length, 3);
  assert.ok(d.rows.some((r) => r[0] === 'CHANGED (~)' && r[1] === '101' && r[3] === 'ACTIVE → INACTIVE'));
  assert.ok(d.rows.some((r) => r[0] === 'REMOVED (-)' && r[1] === '102'));
  assert.ok(d.rows.some((r) => r[0] === 'ADDED (+)' && r[1] === '103'));
});

test('Pillar 5: SavedQueriesStore persists add, update, and delete', async () => {
  const ctx = fakeContext(sharedHost, pkg);
  const { SavedQueriesStore } = require('../src/saved/SavedQueriesStore');

  const sq = new SavedQueriesStore(ctx);
  const q1 = await sq.add({ name: 'Active Workers', folder: 'HCM', sql: 'SELECT * FROM per_all_people_f' });
  assert.equal(sq.list().length, 1);
  assert.equal(sq.get(q1.id)?.folder, 'HCM');
  await sq.update(q1.id, { name: 'All Active Workers' });
  assert.equal(sq.get(q1.id)?.name, 'All Active Workers');
  await sq.delete(q1.id);
  assert.equal(sq.list().length, 0);
});

test('Pillar 5: connection export/import strips all secrets and runtime state cleanly', () => {
  const conns: Connection[] = [
    {
      id: 'c1',
      name: 'FIN DEV',
      url: 'https://abcd.fa.us2.oraclecloud.com',
      username: 'jdoe',
      auth: 'browser',
      environment: 'DEV',
      browser: { kind: 'edge' },
      catalogRoot: '/Custom',
      reportPath: '/Custom/FusionSqlDev/v2/csv.xdo',
      runtimeConsent: 'granted',
      fusionContext: { coaSegments: 'SEGMENT1=Company, SEGMENT2=Account', ledger: 'US Primary Ledger' },
      createdAt: 123
    }
  ];
  const json = serializeConnectionsForExport(conns);
  assert.ok(!json.includes('reportPath'), 'runtime reportPath should not be exported');
  assert.ok(!json.includes('password'), 'no password field');
  assert.ok(!json.includes('clientSecret'), 'no clientSecret field');
  assert.ok(json.includes('SEGMENT1=Company'));

  const imported = parseImportedConnections(json);
  assert.equal(imported.skipped, 0);
  assert.equal(imported.connections.length, 1);
  assert.equal(imported.connections[0].name, 'FIN DEV');
  assert.equal(imported.connections[0].catalogRoot, '/Custom');
  assert.equal(imported.connections[0].fusionContext?.ledger, 'US Primary Ledger');
  assert.throws(() => parseImportedConnections('not-json'), /valid JSON/i);
});
