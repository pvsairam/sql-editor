import * as zlib from 'zlib';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { FusionClient } from '../src/fusion/bip';
import { FusionError } from '../src/fusion/errors';
import { BasicSession, TokenSession } from '../src/auth/sessions';
import { MockFusion, MockOptions } from './helpers/mockFusion';
import { buildRuntime, buildCatalogArchive, buildCatalogFile } from '../src/fusion/runtime';
import { readZip } from '../src/fusion/zip';

async function withMock<T>(opts: MockOptions, fn: (m: MockFusion) => Promise<T>): Promise<T> {
  const m = new MockFusion(opts);
  await m.start();
  try {
    return await fn(m);
  } finally {
    await m.stop();
  }
}
const basic = (m: MockFusion, pass = 's3cret') => new FusionClient({ baseUrl: m.url, auth: new BasicSession('jdoe', pass), timeoutMs: 10000 });

test('first run reports runtime-missing, install creates folders + objects, then queries work', async () => {
  await withMock({}, async (m) => {
    const c = basic(m);
    await assert.rejects(c.runSql('SELECT * FROM DEMO_T', { limit: 10 }), (e: FusionError) => e.kind === 'runtime-missing');
    const path = await c.installRuntime();
    assert.equal(path, '/~jdoe/FusionSqlDev/v2/csv.xdo');
    assert.ok(m.objects.has('/~jdoe/FusionSqlDev/v2/dm.xdm'));
    assert.equal(m.objects.get('/~jdoe/FusionSqlDev/v2/csv.xdo')!.type, 'xdoz');
    const page = await c.runSql('SELECT * FROM DEMO_T;', { limit: 5 });
    assert.deepEqual(page.columns, ['ID', 'NAME', 'NOTE']);
    assert.equal(page.rows.length, 5);
    assert.equal(page.hasMore, true);
  });
});

test('opaque "not found" wording is still recognised through the catalog existence check', async () => {
  await withMock({ missingReportFault: 'opaque' }, async (m) => {
    const c = basic(m);
    assert.equal(await c.discoverRuntime(), undefined);
    await c.installRuntime();
    assert.ok((await c.runSql('SELECT * FROM DEMO_T', { limit: 1 })).rows.length === 1);
  });
});

test('paging: offset windows, hasMore, final partial page, values stay intact', async () => {
  await withMock({ rows: 25 }, async (m) => {
    const c = basic(m);
    await c.installRuntime();
    const p1 = await c.runSql('SELECT * FROM DEMO_T', { limit: 10 });
    const p3 = await c.runSql('SELECT * FROM DEMO_T', { limit: 10, offset: 20 });
    assert.equal(p1.hasMore, true);
    assert.equal(p3.rows.length, 5);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.rows[0][0], '21');
    // pipe / newline / quote / padding survive (the 1.x parser corrupted these)
    assert.equal(p1.rows[6][2], 'has|pipe');
    assert.equal(p1.rows[10 - 1][2], '  padded  ');
    const all = await c.runSql('SELECT * FROM DEMO_T', { limit: 100 });
    assert.equal(all.rows.length, 25);
    assert.equal(all.rows[10][2], 'multi\nline "quoted"');
  });
});

test('duplicate column names fall back to running the statement unwrapped', async () => {
  await withMock({}, async (m) => {
    const c = basic(m);
    await c.installRuntime();
    const page = await c.runSql('SELECT 1 a, 2 a FROM DUP_COLS', { limit: 10 });
    assert.equal(page.unpaged, true);
    assert.deepEqual(page.columns, ['A', 'A']);
  });
});

test('ORA errors surface as oracle errors with the code and without stack noise', async () => {
  await withMock({}, async (m) => {
    const c = basic(m);
    await c.installRuntime();
    await assert.rejects(c.runSql('SELECT * FROM NOPE', { limit: 10 }), (e: FusionError) => e.kind === 'oracle' && e.code === 'ORA-00942' && !/06512/.test(e.message));
  });
});

test('no rows still returns a result', async () => {
  await withMock({}, async (m) => {
    const c = basic(m);
    await c.installRuntime();
    const page = await c.runSql('SELECT * FROM NO_ROWS', { limit: 10 });
    assert.deepEqual(page.columns, ['ID', 'NAME']);
    assert.equal(page.rows.length, 0);
  });
});

test('manually imported helper at the legacy 1.x location is discovered (no reinstall)', async () => {
  await withMock({ preinstalled: ['/~jdoe/FusionQuery/v1/csv.xdo'] }, async (m) => {
    const c = basic(m);
    assert.equal(await c.discoverRuntime(), '/~jdoe/FusionQuery/v1/csv.xdo');
  });
});

test('wrong password: exactly ONE failed login (no retry storm that could lock the account)', async () => {
  await withMock({}, async (m) => {
    const c = basic(m, 'wrong');
    await assert.rejects(c.runSql('SELECT 1 FROM DUAL', { limit: 1 }), (e: FusionError) => e.kind === 'auth');
    assert.equal(m.failedLogins, 1);
  });
});

test('SSO pod that redirects Basic headers: client switches to body credentials and works', async () => {
  await withMock({ mode: 'sso-header-redirect' }, async (m) => {
    const c = basic(m);
    const path = await c.installRuntime();
    assert.ok(path);
    assert.equal((await c.runSql('SELECT * FROM DEMO_T', { limit: 2 })).rows.length, 2);
    assert.equal(m.failedLogins, 0);
  });
});

test('SSO-only pod produces a clear SSO error with guidance', async () => {
  await withMock({ mode: 'sso-always' }, async (m) => {
    const c = basic(m);
    await assert.rejects(c.installRuntime(), (e: FusionError) => e.kind === 'sso' && /OAuth/.test(e.display));
  });
});

test('bearer token: SOAP rejected, client falls back to REST and remembers', async () => {
  await withMock({ mode: 'bearer', soapRejectsBearer: true }, async (m) => {
    // install goes through the catalog SOAP service; pre-seed the objects as an admin would have
    const art = buildRuntime({ catalogRoot: '/~jdoe', dataSource: 'ApplicationDB_FSCM' });
    m.objects.set(art.dmPath, { type: 'xdmz', zip: art.dataModelZip, files: {} });
    m.objects.set(art.reportPath, { type: 'xdoz', zip: art.reportZip, files: { '_report.xdo': readZip(art.reportZip).find((e) => e.name === '_report.xdo')!.data.toString() } });
    const c = new FusionClient({ baseUrl: m.url, auth: new TokenSession('jdoe', 'bearer', 'good-token'), timeoutMs: 10000 });
    c.reportPath = art.reportPath;
    const page = await c.runSql('SELECT * FROM DEMO_T', { limit: 3 });
    assert.equal(page.rows.length, 3);
    await c.runSql('SELECT * FROM DEMO_T', { limit: 3 });
    const restCalls = m.requests.filter((r) => r.op === 'rest-run').length;
    const soapRuns = m.requests.filter((r) => r.op === 'runReport').length;
    assert.equal(restCalls, 2);
    assert.equal(soapRuns, 1, 'SOAP is tried once, then the REST transport is remembered');
    const bad = new FusionClient({ baseUrl: m.url, auth: new TokenSession('jdoe', 'bearer', 'expired'), timeoutMs: 10000 });
    bad.reportPath = art.reportPath;
    await assert.rejects(bad.runSql('SELECT 1 FROM DUAL', { limit: 1 }), (e: FusionError) => e.kind === 'auth');
  });
});

test('read-only catalog gives an actionable permission error', async () => {
  await withMock({ readOnlyCatalog: true }, async (m) => {
    const c = basic(m);
    await assert.rejects(c.installRuntime(), (e: FusionError) => e.kind === 'permission' && /BI Author|administrator/i.test(e.display));
  });
});

test('statements BI Publisher cannot run are rejected before any network call', async () => {
  await withMock({}, async (m) => {
    const c = basic(m);
    await assert.rejects(c.runSql('DELETE FROM t', { limit: 1 }), (e: FusionError) => e.kind === 'unsupported');
    assert.equal(m.requests.length, 0);
  });
});

test('cancelling aborts the request', async () => {
  await withMock({}, async (m) => {
    const c = basic(m);
    await c.installRuntime();
    const ac = new AbortController();
    const p = c.runSql('SELECT * FROM DEMO_T', { limit: 10, signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (e: FusionError) => e.kind === 'cancelled');
  });
});

test('test(): authenticates, installs on consent, reports state', async () => {
  await withMock({}, async (m) => {
    const declined = await basic(m).test(async () => false);
    assert.equal(declined.ok, false);
    assert.equal(declined.authenticated, true);
    assert.equal(declined.runtimeReady, false);
    const ok = await basic(m).test(async () => true);
    assert.equal(ok.ok, true);
    assert.match(ok.message, /FusionSqlDev/);
    const bad = await basic(m, 'nope').test(async () => true);
    assert.equal(bad.ok, false);
    assert.equal(bad.authenticated, false);
    assert.equal(bad.error?.kind, 'auth');
  });
});

test('unreachable host gives a network error, bad scheme a config error', async () => {
  const c = new FusionClient({ baseUrl: 'http://127.0.0.1:1', auth: new BasicSession('u', 'p'), timeoutMs: 3000 });
  await assert.rejects(c.runSql('SELECT 1 FROM DUAL', { limit: 1 }), (e: FusionError) => e.kind === 'network');
  assert.throws(() => new FusionClient({ baseUrl: 'https://exa mple.com', auth: new BasicSession('u', 'p') }), (e: FusionError) => e.kind === 'config');
});

test('base URL is reduced to its origin', () => {
  const c = new FusionClient({ baseUrl: 'abcd.fa.us2.oraclecloud.com/fscmUI/faces/FuseWelcome?x=1', auth: new BasicSession('u', 'p') });
  assert.equal(c.baseUrl, 'https://abcd.fa.us2.oraclecloud.com');
});

test('repair/reinstall works even when the pod refuses to overwrite (delete + retry)', async () => {
  await withMock({ refuseOverwrite: true }, async (m) => {
    const c = basic(m);
    await c.installRuntime();
    const again = await c.installRuntime();
    assert.equal(again, '/~jdoe/FusionSqlDev/v2/csv.xdo');
    assert.equal((await c.runSql('SELECT * FROM DEMO_T', { limit: 2 })).rows.length, 2);
  });
});

test('removeRuntime deletes both objects and the client rediscovers nothing', async () => {
  await withMock({}, async (m) => {
    const c = basic(m);
    await c.installRuntime();
    await c.removeRuntime();
    assert.equal(m.objects.size, 0);
    assert.equal(await c.discoverRuntime(), undefined);
  });
});

test('report creation denied (Security violation): clear explanation + manual-upload workaround; a hand-imported helper is then found', async () => {
  await withMock({ denyReports: true }, async (m) => {
    const c = basic(m);
    await assert.rejects(c.installRuntime(), (e: FusionError) => e.kind === 'permission' && e.code === 'SECURITY_VIOLATION' && /REPORT/.test(e.hint ?? '') && /Save Helper Catalog File/.test(e.hint ?? ''));
    assert.ok(m.objects.has('/~jdoe/FusionSqlDev/v2/dm.xdm'), 'data model part was uploaded');
    // user imports the archive by hand through the catalog UI -> objects appear at the expected paths
    const names = readZip(buildCatalogArchive({ catalogRoot: '/~jdoe', dataSource: 'ApplicationDB_FSCM' })).map((e) => e.name);
    assert.deepEqual(names.sort(), ['v2/csv.xdoz', 'v2/dm.xdmz', 'v2/~metadata.meta', '~metadata.meta']);
    const art = buildRuntime({ catalogRoot: '/~jdoe', dataSource: 'ApplicationDB_FSCM' });
    m.objects.set(art.reportPath, { type: 'xdoz', zip: art.reportZip, files: { '_report.xdo': readZip(art.reportZip).find((e) => e.name === '_report.xdo')!.data.toString() } });
    assert.equal(await c.discoverRuntime(), art.reportPath);
  });
});

test('an explicit helper path (connection setting) is tried first', async () => {
  await withMock({ preinstalled: ['/Custom/Team/csv.xdo'] }, async (m) => {
    const c = new FusionClient({ baseUrl: m.url, auth: new BasicSession('jdoe', 's3cret'), knownReportPath: '/Custom/Team/csv.xdo', timeoutMs: 10000 });
    assert.equal(await c.discoverRuntime(), '/Custom/Team/csv.xdo');
  });
});

test('buildCatalogFile follows the native .catalog layout', () => {
  const raw = zlib.inflateSync(buildCatalogFile({ catalogRoot: '/~jdoe@x.com', dataSource: 'ApplicationDB_FSCM' }, 'jdoe@x.com'));
  let i = 0;
  assert.equal(raw.readUInt32LE(i), 16);
  i += 4;
  const str = () => {
    const l = raw.readUInt32LE(i);
    const v = raw.subarray(i + 4, i + 4 + l);
    i += 4 + l;
    return v;
  };
  for (let k = 0; k < 4; k++) {
    str();
  }
  const items: Array<{ name: string; type: number; path: string; size: number }> = [];
  for (;;) {
    const flag = raw.readUInt16LE(i);
    i += 2;
    if (flag === 2) {
      break;
    }
    assert.equal(flag, 0);
    const j = JSON.parse(str().toString());
    let size = -1;
    if (i < raw.length && raw.readUInt16LE(i) === 1) {
      size = Number(raw.readBigUInt64LE(i + 2));
      i += 10 + size;
    }
    items.push({ name: j.ItemName, type: j.ItemType, path: j.OriginalPath, size });
  }
  assert.equal(i, raw.length);
  assert.deepEqual(items.map((x) => x.name), ['FusionSqlDev', 'v2', 'csv.xdo', 'dm.xdm', '_datamodel.xdm', '_report.xdo', 'sample.xml', 'Default.xpt.png', 'Default_en_US.xpt', 'xdo.cfg']);
  assert.equal(items[2].path, '/users/jdoe@x.com/FusionSqlDev/v2/csv.xdo');
  assert.ok(items.slice(4).every((x) => x.size > 0));
});
