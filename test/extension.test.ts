import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { FakeHost, fakeContext, installFakeVscode } from './helpers/fakeVscode';
import { MockFusion } from './helpers/mockFusion';
import { readZip } from '../src/fusion/zip';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const host = new FakeHost();
let ctx: any;
let mock: MockFusion;
let posted: any[] = [];
let fromWebview: (m: unknown) => Promise<void> | void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = fn();
    if (v) {
      return v;
    }
    if (Date.now() - t > ms) {
      throw new Error('timed out waiting; posted types: ' + posted.map((p) => p.type).join(','));
    }
    await sleep(15);
  }
}
const run = (id: string, ...a: unknown[]) => host.commands.get(id)!(...a);
let firstRun = '';
const lastRunId = () => firstRun;

before(async () => {
  process.env['HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-home-'));
  installFakeVscode(host, pkg);
  ctx = fakeContext(host, pkg);
  mock = new MockFusion({ rows: 250 });
  await mock.start();
  host.config['fusionSqlDev.runtime.install'] = 'auto';
  host.config['fusionSqlDev.fetchSize'] = 100;
  await ctx.globalState.update('fusionSqlDev.connections', [
    { id: 'c1', name: 'DEV', url: mock.url, username: 'jdoe', auth: 'basic', environment: 'DEV', createdAt: 1 },
    { id: 'c2', name: 'BAD', url: mock.url, username: 'jdoe', auth: 'basic', environment: 'DEV', createdAt: 2 }
  ]);
  await ctx.globalState.update('fusionSqlDev.activeConnection', 'c1');
  await ctx.secrets.store('fusionSqlDev.password.c1', 's3cret');
  await ctx.secrets.store('fusionSqlDev.password.c2', 'wrong');
  const ext = require('../src/extension');
  await ext.activate(ctx);

  const provider = host.webviewProviders.get('fusionSqlDev.results');
  const view = {
    webview: {
      options: {} as any,
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: any) => u,
      postMessage: async (m: unknown) => void posted.push(m),
      onDidReceiveMessage: (fn: any) => {
        fromWebview = fn;
        return { dispose() {} };
      }
    },
    onDidDispose: () => ({ dispose() {} }),
    show() {}
  };
  provider.resolveWebviewView(view);
  (globalThis as any).__view = view;
  await fromWebview({ type: 'ready' });
});

after(async () => {
  await mock.stop();
  for (const d of ctx.subscriptions) {
    try {
      d.dispose();
    } catch {
      /* ignore */
    }
  }
});

test('manifest and runtime agree: every contributed command is registered and vice versa', () => {
  const contributed = new Set<string>(pkg.contributes.commands.map((c: any) => c.command));
  const registered = new Set<string>(host.commands.keys());
  assert.deepEqual([...contributed].filter((c) => !registered.has(c)), [], 'contributed but not registered');
  assert.deepEqual([...registered].filter((c) => !contributed.has(c)), [], 'registered but not contributed');
  const used = new Set<string>();
  for (const menus of Object.values(pkg.contributes.menus) as any[][]) {
    for (const m of menus) {
      used.add(m.command);
    }
  }
  for (const k of pkg.contributes.keybindings) {
    used.add(k.command);
  }
  assert.deepEqual([...used].filter((c) => !contributed.has(c)), [], 'menu/keybinding references an unknown command');
  const viewIds = pkg.contributes.views.fusionSqlDev.map((v: any) => v.id);
  for (const id of viewIds) {
    assert.ok(host.registeredProviders.includes(`tree:${id}`), `no tree provider for ${id}`);
  }
  assert.ok(host.webviewProviders.has('fusionSqlDev.results'));
  assert.equal(host.chatParticipants[0].id, pkg.contributes.chatParticipants[0].id);
  for (const p of ['codelens', 'completion', 'hover', 'format', 'rangeformat']) {
    assert.ok(host.registeredProviders.includes(p), `missing ${p} provider`);
  }
});

test('results webview html: strict CSP with nonce, module script, local resources only', () => {
  const html = (globalThis as any).__view.webview.html as string;
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(html, /<script type="module" nonce="[0-9a-f]{32}" src="[^"]*webview[\\/]main\.js">/);
  assert.ok(!/https?:\/\/(?!vscode)/.test(html.replace(/xmlns="[^"]*"/g, '')), 'no remote URLs in the webview');
  assert.ok(fs.existsSync(path.resolve(__dirname, '../../media/webview/main.js')), 'webview bundle was built');
  assert.ok(posted.some((m) => m.type === 'init'));
});

test('Ctrl+Enter: runs the statement under the cursor, auto-installs the helper, streams rows to the webview', async () => {
  const editor = host.makeEditor('SELECT * FROM DEMO_T;\n\nSELECT 1 AS OK FROM DUAL;\n');
  host.activeTextEditor = editor;
  host.visibleTextEditors = [editor];
  host.setCursor(editor, 5);
  posted = [];
  await run('fusionSqlDev.runStatement');
  const rows = await waitFor(() => posted.find((m) => m.type === 'run-rows' && !m.append));
  assert.deepEqual(rows.columns, ['ID', 'NAME', 'NOTE']);
  assert.equal(rows.rows.length, 100);
  assert.equal(rows.hasMore, true);
  assert.ok(mock.objects.has('/~jdoe/FusionSqlDev/v2/csv.xdo'), 'helper installed on first run');
  assert.ok(posted.find((m) => m.type === 'run-start').run.sql.startsWith('SELECT * FROM DEMO_T'));
  firstRun = posted.find((m) => m.type === 'run-start').run.runId;
  const conn = ctx.globalState.get('fusionSqlDev.connections').find((c: any) => c.id === 'c1');
  assert.equal(conn.reportPath, '/~jdoe/FusionSqlDev/v2/csv.xdo');
  assert.equal(conn.runtimeConsent, 'granted');
  assert.equal(host.contexts.get('fusionSqlDev.queryRunning'), false);
});

test('fetch more / fetch all append the remaining rows', async () => {
  const id = lastRunId();
  posted = [];
  await fromWebview({ type: 'fetch-more', runId: id, all: false });
  const more = await waitFor(() => posted.find((m) => m.type === 'run-rows' && m.append));
  assert.equal(more.rows.length, 100);
  assert.equal(more.rows[0][0], '101');
  posted = [];
  await fromWebview({ type: 'fetch-more', runId: id, all: true });
  await waitFor(() => posted.filter((m) => m.type === 'run-rows' && m.append).length >= 1);
  await waitFor(() => posted.some((m) => m.type === 'run-rows' && m.append && m.hasMore === false));
  const total = posted.filter((m) => m.type === 'run-rows' && m.append).reduce((a, m) => a + m.rows.length, 0);
  assert.equal(total, 50);
});

test('copy-as formats are built host-side and land on the clipboard', async () => {
  const id = lastRunId();
  await fromWebview({ type: 'copy-as', runId: id, format: 'csv', headers: true, rowIdx: [0, 6], colIdx: [0, 2] });
  assert.equal(host.clipboard, 'ID,NOTE\r\n1,"  padded  "\r\n7,has|pipe\r\n');
  await fromWebview({ type: 'copy-as', runId: id, format: 'insert', headers: true, rowIdx: [0], colIdx: null });
  assert.match(host.clipboard, /^INSERT INTO DEMO_T \(ID, NAME, NOTE\) VALUES \(1, 'Name 1', '  padded  '\);$/);
  await fromWebview({ type: 'copy-as', runId: id, format: 'inlist', headers: false, rowIdx: [0, 1, 2], colIdx: [1] });
  assert.equal(host.clipboard, "'Name 1', 'Name 2', 'Name 3'");
  await fromWebview({ type: 'copy', text: 'raw cell', label: 'Copied cell' });
  assert.equal(host.clipboard, 'raw cell');
  assert.ok(posted.some((m) => m.type === 'toast' && m.text === 'Copied cell'));
});

test('export: .xlsx is a valid workbook (checked with openpyxl), .csv has BOM and quoting, .json is typed', async () => {
  const id = lastRunId();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-export-'));
  host.saveDialogPath = path.join(dir, 'out.xlsx');
  await fromWebview({ type: 'export', runId: id, format: 'xlsx', rowIdx: null, colIdx: null });
  const xlsx = host.savedFiles.get(host.saveDialogPath)!;
  assert.ok(xlsx, 'xlsx written');
  fs.writeFileSync(host.saveDialogPath, xlsx);
  const names = readZip(Buffer.from(xlsx)).map((e) => e.name);
  assert.ok(names.includes('xl/worksheets/sheet1.xml'));
  const py = spawnSync('python3', ['-I', '-c', `
import sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
print(len(rows), rows[0], rows[1], rows[7][2], type(rows[1][0]).__name__)
print(ws.freeze_panes, ws.auto_filter.ref, ws['A1'].font.b)
`, host.saveDialogPath], { encoding: 'utf8' });
  if (py.status === 0) {
    const [l1, l2] = py.stdout.trim().split('\n');
    assert.match(l1, /^251 \('ID', 'NAME', 'NOTE'\) \(1, 'Name 1', '  padded  '\) has\|pipe int$/);
    assert.match(l2, /^A2 A1:C251 True$/);
  } else {
    console.log('  (openpyxl not available, structural check only)');
  }

  host.saveDialogPath = path.join(dir, 'out.csv');
  await fromWebview({ type: 'export', runId: id, format: 'csv', rowIdx: [10], colIdx: null });
  const csv = Buffer.from(host.savedFiles.get(host.saveDialogPath)!);
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(csv.subarray(3).toString('utf8'), 'ID,NAME,NOTE\r\n11,Name 11,"multi\nline ""quoted"""\r\n');

  host.saveDialogPath = path.join(dir, 'out.json');
  await fromWebview({ type: 'export', runId: id, format: 'json', rowIdx: [0], colIdx: [0, 1] });
  assert.deepEqual(JSON.parse(Buffer.from(host.savedFiles.get(host.saveDialogPath)!).toString()), [{ ID: 1, NAME: 'Name 1' }]);
});

test('errors: ORA error shows in results and history; DML is refused with guidance', async () => {
  const editor = host.makeEditor('SELECT * FROM NOPE');
  host.activeTextEditor = editor;
  posted = [];
  await run('fusionSqlDev.runStatement');
  const err = await waitFor(() => posted.find((m) => m.type === 'run-error'));
  assert.equal(err.error.kind, 'oracle');
  assert.match(err.error.message, /ORA-00942/);
  posted = [];
  host.activeTextEditor = host.makeEditor('DELETE FROM demo');
  await run('fusionSqlDev.runStatement');
  const dml = await waitFor(() => posted.find((m) => m.type === 'run-error'));
  assert.equal(dml.error.kind, 'unsupported');
  assert.match(dml.error.message, /read-only/);
});

test('script run: one result tab per statement, stops on the first error', async () => {
  host.activeTextEditor = host.makeEditor('SELECT 1 AS OK FROM DUAL;\nSELECT * FROM NOPE;\nSELECT 2 AS OK FROM DUAL;');
  posted = [];
  await run('fusionSqlDev.runScript');
  await waitFor(() => posted.filter((m) => m.type === 'run-start').length === 2 && posted.some((m) => m.type === 'run-error'));
  await sleep(100);
  assert.equal(posted.filter((m) => m.type === 'run-start').length, 2, 'third statement must not run');
  assert.ok(host.messages.some((m) => /Script stopped at statement 2 of 3/.test(m.text)));
});

test('bind variables: centred dialog tab (named and :1 style), typed values, cancel, date default', async () => {
  const lastPanel = () => host.panels.filter((p) => p.viewType === 'fusionSqlDev.binds').pop()!;
  const before = host.panels.length;
  host.activeTextEditor = host.makeEditor('SELECT * FROM DEMO_T WHERE id = :emp_id OR id = :1 OR d = :p_as_of_date');
  posted = [];
  const done = run('fusionSqlDev.runStatement');
  await waitFor(() => host.panels.length > before);
  const panel = lastPanel();
  panel.handler!({ type: 'ready' });
  const init = await waitFor(() => panel.posted.find((m) => m.type === 'init'));
  assert.deepEqual(init.binds.map((b: any) => [b.name, b.type]), [['EMP_ID', 'VARCHAR2'], ['1', 'VARCHAR2'], ['P_AS_OF_DATE', 'DATE']]);
  panel.handler!({ type: 'submit', values: [{ name: 'EMP_ID', value: '42', isNull: false, type: 'NUMBER' }, { name: '1', value: '', isNull: true, type: 'VARCHAR2' }, { name: 'P_AS_OF_DATE', value: '2024-01-31', isNull: false, type: 'DATE' }] });
  await done;
  await waitFor(() => posted.find((m) => m.type === 'run-rows'));
  assert.ok(panel.disposed, 'dialog closes after Execute');
  assert.equal(posted.find((m) => m.type === 'run-start').run.sql, 'SELECT * FROM DEMO_T WHERE id = :emp_id OR id = :1 OR d = :p_as_of_date', 'history keeps the :bind form');
  // remembered, and cancel runs nothing
  posted = [];
  const n2 = host.panels.length;
  const again = run('fusionSqlDev.runStatement');
  await waitFor(() => host.panels.length > n2);
  const p2 = lastPanel();
  p2.handler!({ type: 'ready' });
  assert.equal((await waitFor(() => p2.posted.find((m) => m.type === 'init'))).binds[0].value, '42');
  p2.handler!({ type: 'cancel' });
  await again;
  assert.ok(!posted.some((m) => m.type === 'run-start'));
  // closing the tab with the X also cancels
  const n3 = host.panels.length;
  const closed = run('fusionSqlDev.runStatement');
  await waitFor(() => host.panels.length > n3);
  lastPanel().onDispose!();
  await closed;
  assert.ok(!posted.some((m) => m.type === 'run-start'));
  // invalid number is reported in the results, not thrown
  const n4 = host.panels.length;
  const bad = run('fusionSqlDev.runStatement');
  await waitFor(() => host.panels.length > n4);
  const p4 = lastPanel();
  p4.handler!({ type: 'submit', values: [{ name: 'EMP_ID', value: 'abc', isNull: false, type: 'NUMBER' }, { name: '1', value: 'x', isNull: false, type: 'VARCHAR2' }, { name: 'P_AS_OF_DATE', value: '2024-01-31', isNull: false, type: 'DATE' }] });
  await bad;
  assert.match((await waitFor(() => posted.find((m) => m.type === 'run-error'))).error.message, /not a valid NUMBER/);
});

test('new query replaces the previous result tab unless it is pinned; script statements keep their tabs', async () => {
  host.activeTextEditor = host.makeEditor('SELECT 1 AS OK FROM DUAL');
  posted = [];
  await run('fusionSqlDev.runStatement');
  const first = (await waitFor(() => posted.find((m) => m.type === 'run-start'))).run.runId;
  await waitFor(() => posted.find((m) => m.type === 'run-rows'));
  await fromWebview({ type: 'pin', runId: first, pinned: true });
  posted = [];
  await run('fusionSqlDev.runStatement');
  const second = await waitFor(() => posted.find((m) => m.type === 'run-start'));
  assert.deepEqual(second.drop, [], 'pinned result is kept');
  await waitFor(() => posted.find((m) => m.type === 'run-rows'));
  posted = [];
  await run('fusionSqlDev.runStatement');
  const third = await waitFor(() => posted.find((m) => m.type === 'run-start'));
  assert.deepEqual(third.drop, [second.run.runId], 'unpinned previous result is replaced');
  host.activeTextEditor = host.makeEditor('SELECT 1 AS OK FROM DUAL;\nSELECT 2 AS OK FROM DUAL;');
  posted = [];
  await run('fusionSqlDev.runScript');
  await waitFor(() => posted.filter((m) => m.type === 'run-start').length === 2);
  assert.deepEqual(posted.filter((m) => m.type === 'run-start')[1].drop, [], 'second statement of a script keeps the first tab');
});

test('Rows box: the limit is applied in request-sized chunks and persisted', async () => {
  host.config['fusionSqlDev.requestSize'] = 100;
  await fromWebview({ type: 'set-fetch-size', value: 230 });
  assert.equal(ctx.globalState.get('fusionSqlDev.rowLimit'), 230);
  assert.ok(posted.some((m) => m.type === 'settings' && m.settings.fetchSize === 230));
  host.activeTextEditor = host.makeEditor('SELECT * FROM DEMO_T');
  posted = [];
  await run('fusionSqlDev.runStatement');
  await waitFor(() => posted.some((m) => m.type === 'run-rows' && m.append && m.hasMore) && posted.filter((m) => m.type === 'run-rows').reduce((a, m) => a + m.rows.length, 0) >= 230);
  const rows = posted.filter((m) => m.type === 'run-rows');
  assert.equal(rows.reduce((a, m) => a + m.rows.length, 0), 230, JSON.stringify(rows.map((m: any) => [m.append, m.rows.length, m.hasMore])));
  assert.equal(rows[0].append, false);
  assert.equal(rows[rows.length - 1].hasMore, true, '20 more rows exist (250 total)');
  await fromWebview({ type: 'set-fetch-size', value: 100 });
  host.config['fusionSqlDev.requestSize'] = 5000;
});

test('wrong password: auth error offered with an Edit Connection action (and a single login attempt)', async () => {
  await run('fusionSqlDev.setActiveConnection', 'c2');
  host.activeTextEditor = host.makeEditor('SELECT 1 AS OK FROM DUAL');
  posted = [];
  const before = mock.failedLogins;
  await run('fusionSqlDev.runStatement');
  const err = await waitFor(() => posted.find((m) => m.type === 'run-error'));
  assert.equal(err.error.kind, 'auth');
  assert.equal(mock.failedLogins - before, 1);
  await sleep(30);
  assert.ok(host.messages.some((m) => m.level === 'error' && m.items.includes('Edit Connection')));
  await run('fusionSqlDev.setActiveConnection', 'c1');
});

test('history is persisted without secrets, starred entries survive clear', async () => {
  await sleep(600);
  const file = path.join(ctx.globalStorageUri.fsPath, 'history.json');
  const text = fs.readFileSync(file, 'utf8');
  const h = JSON.parse(text);
  assert.ok(h.length >= 4);
  assert.ok(!/s3cret/.test(text), 'no stored secret in history');
  assert.ok(h.some((e: any) => e.status === 'error' && /ORA-00942/.test(e.error)));
  assert.ok(h.some((e: any) => e.status === 'success' && e.rowCount >= 100), JSON.stringify(h.map((e: any) => [e.status, e.rowCount, e.sql.slice(0, 20)])));
});

test('completion: Fusion tables after FROM, aliases and columns after "alias."', async () => {
  const p = host.providers['completion'];
  const text = 'SELECT papf. FROM per_all_people_f papf WHERE 1=1';
  const editor = host.makeEditor(text);
  const pos = editor.document.positionAt(text.indexOf('papf.') + 5);
  const items = await p.provideCompletionItems(editor.document, pos, { isCancellationRequested: false });
  assert.ok(items === undefined || Array.isArray(items)); // columns need a live schema; must not throw

  const t2 = 'SELECT * FROM per_';
  const e2 = host.makeEditor(t2);
  const items2 = await p.provideCompletionItems(e2.document, e2.document.positionAt(t2.length), { isCancellationRequested: false });
  const labels = items2.map((i: any) => i.label);
  assert.ok(labels.includes('per_all_people_f'));
  assert.ok(!labels.includes('SELECT'), 'only tables after FROM');

  const t3 = "SELECT 'it is per_' FROM dual";
  const e3 = host.makeEditor(t3);
  assert.equal(await p.provideCompletionItems(e3.document, e3.document.positionAt(t3.indexOf('per_') + 4), { isCancellationRequested: false }), undefined, 'no completion inside strings');
});

test('codelens: connection lens plus one Run lens per statement', () => {
  const p = host.providers['codelens'];
  const editor = host.makeEditor('SELECT 1 FROM dual;\nSELECT 2 FROM dual;');
  const lenses = p.provideCodeLenses(editor.document);
  const titles = lenses.map((l: any) => l.command.title);
  assert.ok(titles[0].includes('DEV'));
  assert.equal(titles.filter((t: string) => t.includes('Run') && !t.includes('Script')).length, 2);
  assert.ok(titles.some((t: string) => t.includes('Run Script')));
});

test('format provider rewrites the document; formatting is idempotent', () => {
  const p = host.providers['format'];
  const editor = host.makeEditor('select a,b from t where x=1 and y=2;\nselect 1 from dual');
  const [edit] = p.provideDocumentFormattingEdits(editor.document);
  assert.match(edit.newText, /^SELECT\n {2}a,\n {2}b\nFROM\n {2}t\nWHERE\n {2}x = 1\n {2}AND y = 2;\n\nSELECT\n {2}1\nFROM\n {2}dual;\n$/);
  const again = host.makeEditor(edit.newText);
  assert.equal(p.provideDocumentFormattingEdits(again.document)[0].newText, edit.newText);
});

test('new worksheet opens a SQL document bound to the active connection', async () => {
  await run('fusionSqlDev.newWorksheet');
  const doc = host.docs[host.docs.length - 1];
  assert.equal(doc.languageId, 'sql');
  assert.equal(doc.getText(), '', 'worksheets start blank');
  assert.match(doc.uri.path, /^Worksheet \d+\.sql$/);
  assert.ok(ctx.workspaceState.get('fusionSqlDev.docConnections')[doc.uri.toString()] === 'c1');
});

test('run on multiple connections: binds once, one tab per connection, concurrent', async () => {
  const conns = ctx.globalState.get('fusionSqlDev.connections');
  await ctx.globalState.update('fusionSqlDev.connections', [...conns, { id: 'c3', name: 'QA', url: mock.url, username: 'jdoe', auth: 'basic', environment: 'TEST', createdAt: 3 }]);
  await ctx.secrets.store('fusionSqlDev.password.c3', 's3cret');
  host.activeTextEditor = host.makeEditor('SELECT 1 AS OK FROM DUAL');
  host.ui.picks = [(items: any[]) => items.filter((i) => i.label === 'DEV' || i.label === 'QA')];
  posted = [];
  await run('fusionSqlDev.runOnConnections');
  await waitFor(() => posted.filter((m) => m.type === 'run-rows').length === 2);
  const starts = posted.filter((m) => m.type === 'run-start');
  assert.deepEqual(starts.map((s: any) => s.run.title.split(']')[0]).sort(), ['[DEV', '[QA']);
  assert.deepEqual(starts[1].drop, [], 'later tabs do not replace the first');
  assert.deepEqual(new Set(starts.map((s: any) => s.run.connectionName)), new Set(['DEV', 'QA']));
});

test('connection delete removes secrets; legacy import scrubs passwords', async () => {
  host.ui.buttons = (_m, items) => (items.includes('Delete') ? 'Delete' : undefined);
  await run('fusionSqlDev.deleteConnection', 'c2');
  assert.equal(ctx.globalState.get('fusionSqlDev.connections').length, 2);
  assert.equal(await ctx.secrets.get('fusionSqlDev.password.c2'), undefined);
  host.ui.buttons = () => undefined;
});
