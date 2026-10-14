// Browser test for the results grid. Run: node test/webview/webview.e2e.mjs   (needs Playwright + Chromium)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node-tools/node_modules/playwright'));
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = url === '/' ? path.join(root, 'test/webview/harness.html') : path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 520 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.setDefaultTimeout(6000);
await page.goto(base);

const sent = () => page.evaluate(() => window.__sent);
const lastCopy = async () => (await sent()).filter((m) => m.type === 'copy').pop();
const post = (m) => page.evaluate((msg) => window.postMessage(msg, '*'), m);
let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ✔', name);
  } catch (e) {
    console.log('  ✖', name, '\n   ', e.message.split('\n')[0]);
    process.exitCode = 1;
  }
};

const COLS = ['ID', 'NAME', 'AMOUNT', 'NOTE', 'DATE', 'C6', 'C7', 'C8'];
const N = 5000;
const rows = Array.from({ length: N }, (_, i) => {
  const n = i + 1;
  return [String(n), `Name ${n}`, String((n * 37) % 1000) + '.5', n % 7 === 0 ? 'has|pipe\tand tab' : n % 11 === 0 ? 'multi\nline "quoted"' : '', '2024-01-' + String((n % 28) + 1).padStart(2, '0') + 'T00:00:00.000+00:00', 'a' + n, 'b' + n, 'c' + n];
});

await test('webview announces itself', async () => {
  await page.waitForFunction(() => window.__sent.some((m) => m.type === 'ready'));
});

await post({ type: 'init', runs: [], settings: { wrapText: false, maxCellLength: 5000, fetchSize: 1000 } });
await test('empty state shown before any run', async () => {
  assert.match(await page.textContent('.empty-state'), /Ctrl\+Enter/);
});

const t0 = Date.now();
await post({ type: 'run-start', run: { runId: 'r1', title: 'SELECT * FROM demo', sql: 'select * from demo', connectionName: 'DEV', environment: 'DEV', status: 'running', startedAt: Date.now(), elapsedMs: 0, columns: [], rows: [], hasMore: false, loading: true } });
await test('running state with spinner and cancel', async () => {
  await page.waitForSelector('.running-state .spinner');
  assert.ok(await page.$('.running-state button'));
});
await post({ type: 'run-rows', runId: 'r1', columns: COLS, rows, append: false, hasMore: true, elapsedMs: 1234 });
await page.waitForSelector('.cell');
console.log(`  (rendered ${N} rows in ${Date.now() - t0} ms)`);

await test('virtualised: only a window of rows is in the DOM', async () => {
  const n = await page.$$eval('.row', (r) => r.length);
  assert.ok(n > 5 && n < 60, `rows in DOM: ${n}`);
});
await test('toolbar shows row count, timing and fetch buttons', async () => {
  const t = await page.textContent('.toolbar');
  assert.match(t, /5,000 rows\+/);
  assert.match(t, /1\.23 s/);
  assert.match(t, /Fetch 1,000 more/);
});
await test('numeric columns are right-aligned, text left', async () => {
  const al = await page.$$eval('.row:nth-child(2) .cell', (cs) => cs.slice(0, 3).map((c) => c.classList.contains('num')));
  assert.deepEqual(al, [true, false, true]);
});

const cell = (r, c) => page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);

await test('dates: raw by default; toolbar toggle formats them (time only when present); copy uses the displayed text; filter finds both forms', async () => {
  assert.equal(await page.textContent('.cell[data-r="0"][data-c="4"]'), '2024-01-02T00:00:00.000+00:00', 'raw by default');
  await cell(0, 4).click();
  await page.keyboard.press('Control+c');
  assert.equal((await lastCopy()).text, '2024-01-02T00:00:00.000+00:00');
  await page.click('button[title^="Dates are raw"]');
  await page.waitForFunction(() => document.querySelector('.cell[data-r="0"][data-c="4"]')?.textContent === '01/02/2024');
  await cell(0, 4).click();
  await page.keyboard.press('Control+c');
  assert.equal((await lastCopy()).text, '01/02/2024');
  await post({ type: 'settings', settings: { wrapText: false, maxCellLength: 5000, fetchSize: 1000, dateFormat: 'YYYY-MM-DD' } });
  await page.waitForFunction(() => document.querySelector('.cell[data-r="0"][data-c="4"]')?.textContent === '2024-01-02');
  await post({ type: 'settings', settings: { wrapText: false, maxCellLength: 5000, fetchSize: 1000, dateFormat: 'MM/DD/YYYY' } });
  await page.waitForFunction(() => document.querySelector('.cell[data-r="0"][data-c="4"]')?.textContent === '01/02/2024');
  await page.fill('input.quick', '01/28/2024');
  await page.waitForFunction(() => /of 5,000/.test(document.querySelector('.tb-info')?.textContent ?? ''));
  await page.fill('input.quick', '');
  await page.waitForFunction(() => !/ of /.test(document.querySelector('.tb-info')?.textContent ?? ''));
});
await test('click selects a cell; Ctrl+C sends the raw value to the host clipboard', async () => {
  await cell(1, 1).click();
  await page.waitForSelector('.cell.focus');
  await page.keyboard.press('Control+c');
  const m = await lastCopy();
  assert.equal(m.text, 'Name 2');
  assert.match(m.label, /Copied cell/);
});
await test('shift+click extends to a rectangle; copy is tab separated', async () => {
  await cell(1, 0).click();
  await cell(3, 2).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+c');
  assert.equal((await lastCopy()).text, '2\tName 2\t74.5\n3\tName 3\t111.5\n4\tName 4\t148.5');
  assert.match((await lastCopy()).label, /3 rows × 3 columns/);
});
await test('Ctrl+Shift+C includes the header row', async () => {
  await page.keyboard.press('Control+Shift+C');
  assert.match((await lastCopy()).text, /^ID\tNAME\tAMOUNT\n2\tName 2/);
});
await test('mouse drag selects a range', async () => {
  const a = await cell(5, 1).boundingBox();
  const b = await cell(7, 2).boundingBox();
  await page.mouse.move(a.x + 10, a.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + 10, b.y + 8, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Control+c');
  assert.equal((await lastCopy()).text, 'Name 6\t' + ((6 * 37) % 1000) + '.5\nName 7\t' + ((7 * 37) % 1000) + '.5\nName 8\t' + ((8 * 37) % 1000) + '.5'.replace('.5.5', '.5'));
});
await test('values with tabs, quotes and newlines are quoted for spreadsheets', async () => {
  // row 7 (index 6) NOTE = 'has|pipe\tand tab'; row 11 (index 10) NOTE has newline+quotes
  await cell(6, 3).click();
  await cell(10, 3).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+c');
  const t = (await lastCopy()).text;
  assert.ok(t.startsWith('"has|pipe\tand tab"\n'), t.slice(0, 40));
  assert.ok(t.includes('"multi\nline ""quoted"""'));
});
await test('Ctrl+A then Ctrl+C copies every loaded row', async () => {
  await cell(2, 1).click();
  await page.keyboard.press('Control+a');
  assert.match(await page.textContent('.statusbar'), /5,000 rows × 8 cols/);
  await page.keyboard.press('Control+c');
  const t = (await lastCopy()).text;
  // note column contains embedded newlines inside quotes, so count records by the ID prefix
  assert.equal(t.split('\n').filter((l) => /^\d+\tName /.test(l)).length, N);
});
await test('status bar shows Sum/Avg for a numeric selection', async () => {
  await cell(0, 0).click();
  await cell(4, 0).click({ modifiers: ['Shift'] });
  const t = await page.textContent('.statusbar');
  assert.match(t, /Sum 15/);
  assert.match(t, /Avg 3/);
  assert.match(t, /Count 5/);
});
await test('keyboard navigation and shift-extend', async () => {
  await cell(0, 0).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+c');
  assert.equal((await lastCopy()).text, 'Name 2\nName 3');
});
await test('PageDown/End keep the focus visible and scrolled', async () => {
  await page.keyboard.press('Control+End');
  await page.waitForSelector(`.cell[data-r="${N - 1}"]`);
  await page.keyboard.press('Control+Home');
  await page.waitForSelector('.cell[data-r="0"]');
});
await test('header click sorts numerically (asc then desc), empties last', async () => {
  const head = page.locator('.hcell[data-col="2"]').first();
  const firstAmount = () => page.evaluate(() => Number(document.querySelector('.cell[data-r="0"][data-c="2"]')?.textContent));
  await head.click();
  await page.waitForFunction(() => document.querySelector('.cell[data-r="0"][data-c="2"]')?.textContent === '0.5');
  await head.click();
  await page.waitForFunction(() => Number(document.querySelector('.cell[data-r="0"][data-c="2"]')?.textContent) > 990);
  assert.ok((await firstAmount()) > 990);
  await head.click(); // clear
  await page.waitForFunction(() => document.querySelector('.cell[data-r="0"][data-c="0"]')?.textContent === '1');
});
await test('quick filter narrows the view and updates counts', async () => {
  await page.fill('input.quick', 'Name 4999');
  await page.waitForFunction(() => document.querySelector('.tb-info')?.textContent.includes('1 of 5,000'));
  await page.fill('input.quick', '');
  await page.waitForFunction(() => document.querySelector('.tb-info')?.textContent.includes('5,000'));
});
await test('per-column filters support operators', async () => {
  await page.click('button[title="Per-column filters"]');
  await page.fill('.hcell[data-col="0"] .hfilter', '>=4998');
  await page.waitForFunction(() => document.querySelector('.tb-info')?.textContent.includes('3 of 5,000'));
  await page.fill('.hcell[data-col="0"] .hfilter', '');
  await page.click('button[title="Per-column filters"]');
});
await test('right-click menu offers copy formats and host-side copy-as', async () => {
  await cell(1, 0).click();
  await cell(2, 1).click({ modifiers: ['Shift'] });
  await cell(2, 1).click({ button: 'right' });
  await page.waitForSelector('.menu .item');
  await page.locator('.menu .item', { hasText: 'Copy as CSV' }).click();
  const m = (await sent()).filter((x) => x.type === 'copy-as').pop();
  assert.equal(m.format, 'csv');
  assert.deepEqual(m.rowIdx, [1, 2]);
  assert.deepEqual(m.colIdx, [0, 1]);
});
await test('double-click opens the cell viewer with the full multi-line value', async () => {
  await page.keyboard.press('Control+Home');
  await cell(10, 3).dblclick();
  await page.waitForSelector('.viewer');
  assert.equal(await page.textContent('.viewer-body'), 'multi\nline "quoted"');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.viewer'));
});
await test('export menu requests host-side export for the visible rows', async () => {
  await page.locator('.toolbar button', { hasText: 'Export' }).click();
  await page.locator('.menu .item', { hasText: 'Excel' }).first().click();
  const m = (await sent()).filter((x) => x.type === 'export').pop();
  assert.equal(m.format, 'xlsx');
  assert.equal(m.rowIdx.length, N);
});
await test('fetch-more button asks the host for the next batch', async () => {
  await page.locator('.toolbar button', { hasText: 'Fetch 1,000 more' }).click();
  const m = (await sent()).filter((x) => x.type === 'fetch-more').pop();
  assert.deepEqual([m.runId, m.all], ['r1', false]);
});
await test('appended rows extend the grid without losing the selection', async () => {
  await cell(0, 0).click();
  await post({ type: 'run-rows', runId: 'r1', columns: COLS, rows: [['5001', 'Name 5001', '1.5', '', '', '', '', '']], append: true, hasMore: false, elapsedMs: 2000 });
  await page.waitForFunction(() => document.querySelector('.tb-info')?.textContent.includes('5,001'));
  assert.ok(await page.$('.cell.focus'));
  assert.equal(await page.$('button:has-text("Fetch all")'), null);
});
await test('record view lists every column of the focused row', async () => {
  await page.click('button[title^="Record view"]');
  await cell(1, 1).click();
  await page.waitForSelector('.rec-item');
  assert.match(await page.textContent('.record'), /NAME[\s\S]*Name 2/);
  await page.click('button[title^="Record view"]');
});

await page.click('button[title^="Record view"]');
await cell(3, 1).click();
await cell(8, 2).click({ modifiers: ['Shift'] });
await page.waitForSelector('.rec-item');



await page.screenshot({ path: process.env.SHOT2 ?? '/tmp/claude-0/grid2.png' });
await page.click('button[title^="Record view"]');

// error + second tab
await post({ type: 'run-start', run: { runId: 'r2', title: 'SELECT * FROM nope', sql: 'select * from nope', connectionName: 'DEV', environment: 'DEV', status: 'running', startedAt: Date.now(), elapsedMs: 0, columns: [], rows: [], hasMore: false, loading: true } });
await post({ type: 'run-error', runId: 'r2', status: 'error', error: { message: 'ORA-00942: table or view does not exist', hint: 'Check the table name with DESC.', kind: 'oracle' }, elapsedMs: 321 });
await test('errors render with message, hint, kind badge and actions', async () => {
  await page.waitForSelector('.error-state');
  const t = await page.textContent('.error-state');
  assert.match(t, /ORA-00942/);
  assert.match(t, /Check the table name/);
  assert.match(t, /oracle/);
  assert.ok(await page.$('.error-state button:has-text("Run again")'));
});
await test('tabs: two runs, switching back restores the first grid', async () => {
  assert.equal(await page.$$eval('.tab', (t) => t.length), 2);
  await page.locator('.tab').first().click();
  await page.waitForSelector('.cell');
  assert.match(await page.textContent('.tb-info'), /5,001/);
});
await test('closing a tab notifies the host', async () => {
  await page.locator('.tab').nth(1).locator('.x').click();
  assert.ok((await sent()).some((m) => m.type === 'close-run' && m.runId === 'r2'));
});

// scale
await post({ type: 'run-start', run: { runId: 'r3', title: 'big', sql: 'select 1', connectionName: 'DEV', environment: 'DEV', status: 'running', startedAt: Date.now(), elapsedMs: 0, columns: [], rows: [], hasMore: false, loading: true } });
const loadMs = await page.evaluate(
  (cols) =>
    new Promise((resolve) => {
      const rowsBig = Array.from({ length: 100000 }, (_, i) => [String(i), 'row ' + i, String(i * 3), 'x'.repeat(20), 'y', 'z', 'w', 'v']);
      const t = performance.now();
      const obs = new MutationObserver(() => {
        if (document.querySelector('.tb-info')?.textContent.includes('100,000')) {
          obs.disconnect();
          requestAnimationFrame(() => resolve(performance.now() - t));
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.postMessage({ type: 'run-rows', runId: 'r3', columns: cols, rows: rowsBig, append: false, hasMore: false, elapsedMs: 10 }, '*');
    }),
  COLS
);
await test(`100k rows load in-page (${Math.round(loadMs)} ms), sort and filter stay fast`, async () => {
  assert.ok(loadMs < 3000, `load took ${loadMs} ms`);
  const s = Date.now();
  await page.locator('.pane:not(.hidden) .hcell[data-col="2"]').click();
  await page.waitForFunction(() => document.querySelector('.cell[data-r="0"][data-c="2"]')?.textContent === '0');
  assert.ok(Date.now() - s < 2000, `sort took ${Date.now() - s} ms`);
  const f = Date.now();
  await page.fill('input.quick', 'row 99999');
  await page.waitForFunction(() => document.querySelector('.tb-info')?.textContent.includes('1 of 100,000'));
  assert.ok(Date.now() - f < 2000, `filter took ${Date.now() - f} ms`);
});

// ---- bind dialog, rows box, pin ----
await test('connection chip shows the active connection and asks the host to switch', async () => {
  await post({ type: 'settings', settings: { wrapText: false, maxCellLength: 5000, fetchSize: 1000, dateFormat: 'MM/DD/YYYY', connection: { name: 'ECGA NEW', environment: 'PROD' }, connections: [{ id: 'c1', name: 'ECGA NEW', environment: 'PROD', active: true }, { id: 'c2', name: 'DEVECGA', environment: 'DEV', active: false }] } });
  await page.waitForSelector('.chip .envdot.PROD');
  assert.match(await page.textContent('.chip'), /ECGA NEW/);
  await page.locator('.chip').click();
  const box = await page.locator('.chip').boundingBox();
  const menu = await page.locator('.menu').boundingBox();
  assert.ok(Math.abs(menu.x - box.x) < 8 && menu.y >= box.y + box.height, 'dropdown sits right under the chip');
  await page.locator('.menu .item', { hasText: 'DEVECGA' }).click();
  assert.ok((await sent()).some((x) => x.type === 'switch-connection' && x.id === 'c2'));
});
await test('Rows box accepts 1..1,000,000 and tells the host', async () => {
  const box = page.locator('.rows-input');
  await box.fill('250000');
  await box.press('Enter');
  assert.equal((await sent()).filter((x) => x.type === 'set-fetch-size').pop().value, 250000);
  await box.fill('99999999');
  await box.press('Enter');
  assert.equal((await sent()).filter((x) => x.type === 'set-fetch-size').pop().value, 1000000);
  await box.fill('abc');
  await box.press('Enter');
  assert.equal(await box.inputValue(), '1000000');
});
await test('single result hides the tab strip; pin button in toolbar notifies host; run-start can drop replaced tabs', async () => {
  const before = await page.$$eval('.tab', (t) => t.length);
  await page.locator('button[title^="Pin"]').click();
  assert.ok((await sent()).some((x) => x.type === 'pin' && x.pinned === true));
  await post({ type: 'run-start', run: { runId: 'r9', title: 'new', sql: 'select 1', connectionName: 'DEV', environment: 'DEV', status: 'running', startedAt: Date.now(), elapsedMs: 0, columns: [], rows: [], hasMore: false, loading: true }, drop: ['r1'] });
  await page.waitForFunction((n) => document.querySelectorAll('.tab').length === n, before);
  assert.ok(!(await page.$$eval('.tab', (t) => t.map((x) => x.title).join('|'))).includes('select * from demo'));
});

await page.screenshot({ path: process.env.SHOT ?? '/tmp/claude-0/grid.png' });
await test('no console or page errors', async () => assert.deepEqual(errors, []));

await test('auto-fit: widths follow the data (short ids narrow, long text wider, outliers capped) and re-fit on append', async () => {
  await post({ type: 'run-start', run: { runId: 'rw', title: 'fit', sql: 'select 1', connectionName: 'DEV', environment: 'DEV', status: 'running', startedAt: Date.now(), elapsedMs: 0, columns: [], rows: [], hasMore: false, loading: true }, drop: [] });
  const data = Array.from({ length: 200 }, (_, i) => [String(i % 10), 'Employee number ' + i, 'x'.repeat(i === 7 ? 3000 : 12), '2026-10-14T03:50:08.000+00:00']);
  await post({ type: 'run-rows', runId: 'rw', columns: ['ID', 'FULL_NAME', 'NOTE', 'CREATED'], rows: data, append: false, hasMore: true, elapsedMs: 5 });
  await page.waitForSelector('.pane:not(.hidden) .hcell');
  if (await page.$('button[title^="Dates are formatted"]')) {
    await page.click('button[title^="Dates are formatted"]');
  }
  await page.waitForFunction(() => document.querySelector('.pane:not(.hidden) .cell[data-c="3"]')?.textContent?.includes('T03:50'));
  const w = () => page.$$eval('.pane:not(.hidden) .hcell', (h) => h.map((x) => Math.round(x.getBoundingClientRect().width)));
  const a = await w();
  assert.ok(a[0] < a[1] && a[1] < a[3], `widths ${a}`);
  assert.ok(a[2] < 200, `outlier must not stretch the column: ${a[2]}`);
  assert.ok(a[3] > 220, `raw ISO date needs room: ${a[3]}`);
  await post({ type: 'run-rows', runId: 'rw', columns: [], rows: Array.from({ length: 100 }, (_, i) => ['1', 'A much much longer employee full name than before number ' + i, 'n', '2026-10-14T03:50:08.000+00:00']), append: true, hasMore: false, elapsedMs: 5 });
  await page.waitForFunction((prev) => document.querySelectorAll('.pane:not(.hidden) .hcell')[1].getBoundingClientRect().width > prev, a[1]);
});

// ---- bind dialog page ----
const bd = await browser.newPage({ viewport: { width: 900, height: 620 } });
bd.setDefaultTimeout(6000);
await bd.goto(base + 'test/webview/bind.html');
await bd.waitForFunction(() => window.__sent.some((m) => m.type === 'ready'));
await bd.evaluate(() => window.postMessage({ type: 'init', binds: [{ name: '1', value: '', isNull: false, type: 'VARCHAR2' }, { name: 'P_AS_OF_DATE', value: '', isNull: false, type: 'DATE' }, { name: 'DEPT', value: 'HR', isNull: false, type: 'VARCHAR2' }] }, '*'));
await test('bind dialog: centred card with name/value/Is Null/type; Enter submits typed values; Esc cancels', async () => {
  await bd.waitForSelector('.dialog .bind-value');
  assert.match(await bd.textContent('.dialog'), /Parameter Name[\s\S]*Parameter Value[\s\S]*Is Null[\s\S]*Data Type/);
  const box = await bd.locator('.dialog').boundingBox();
  assert.ok(Math.abs(box.x + box.width / 2 - 450) < 20 && Math.abs(box.y + box.height / 2 - 310) < 60, `dialog centre ${box.x + box.width / 2},${box.y + box.height / 2}`);
  assert.equal(await bd.locator('.bind-type').nth(1).inputValue(), 'DATE');
  await bd.screenshot({ path: process.env.SHOT3 ?? '/tmp/claude-0/bind.png' });
  await bd.locator('.bind-value').first().fill('100000065388230');
  await bd.locator('.bind-type').first().selectOption('NUMBER');
  await bd.locator('.bind-null').nth(2).check();
  await bd.keyboard.press('Enter');
  const m = (await bd.evaluate(() => window.__sent)).filter((x) => x.type === 'submit').pop();
  assert.deepEqual(m.values, [{ name: '1', value: '100000065388230', isNull: false, type: 'NUMBER' }, { name: 'P_AS_OF_DATE', value: '', isNull: false, type: 'DATE' }, { name: 'DEPT', value: 'HR', isNull: true, type: 'VARCHAR2' }]);
  await bd.keyboard.press('Escape');
  assert.ok((await bd.evaluate(() => window.__sent)).some((x) => x.type === 'cancel'));
});

// ---- connection form ----
const form = await browser.newPage({ viewport: { width: 900, height: 820 } });
form.setDefaultTimeout(6000);
await form.goto(base + 'test/webview/connection.html');
const fsent = () => form.evaluate(() => window.__sent);
await form.waitForFunction(() => window.__sent.some((m) => m.type === 'ready'));
const initForm = { name: '', environment: 'DEV', auth: 'basic', url: '', username: '', password: '', issuer: '', clientId: '', scope: 'urn:opc:resource:consumer::all', flow: 'authorization_code', clientSecret: '', tokenKind: 'bearer', token: '', dataSource: '', catalogRoot: '', helperPath: '', allowInsecureTls: false };
await form.evaluate((f) => window.postMessage({ type: 'init', id: 'c1', editing: false, form: f, hasPassword: false, hasSecret: false, hasToken: false, redirectUrl: 'http://localhost:53682/callback' }, '*'), initForm);
await test('connection form: fields, auth methods, SSO section, validate + create messages', async () => {
  await form.waitForSelector('.card');
  assert.match(await form.textContent('.card'), /Create Connection[\s\S]*Authentication Method[\s\S]*URL[\s\S]*User Name[\s\S]*Password/);
  const inputs = form.locator('.card input[type=text]');
  await inputs.nth(0).fill('DEV');
  await inputs.nth(1).fill('https://abcd.fa.us2.oraclecloud.com');
  await inputs.nth(2).fill('jdoe');
  await form.locator('input[type=password]').first().fill('s3cret');
  await form.getByText('Validate Setup').click();
  let m = (await fsent()).filter((x) => x.type === 'validate').pop();
  assert.equal(m.form.url, 'https://abcd.fa.us2.oraclecloud.com');
  assert.equal(m.form.password, 's3cret');
  await form.evaluate(() => window.postMessage({ type: 'validation', ok: true, title: 'Connection works', steps: [{ label: 'Server reachable & signed in', ok: true }] }, '*'));
  await form.waitForSelector('.banner.ok');
  assert.equal(await form.locator('.section').count(), 0, 'no stray token section for Local');
  await form.getByText('SSO', { exact: true }).click();
  await form.waitForSelector('.section');
  assert.match(await form.textContent('.section'), /Browser[\s\S]*private profile/);
  assert.equal(await form.locator('select').nth(1).inputValue(), 'browser');
  await form.locator('select').nth(1).selectOption('oauth');
  await form.waitForSelector('.section');
  assert.match(await form.textContent('.section'), /Identity domain URL[\s\S]*Client ID[\s\S]*Scope[\s\S]*localhost:53682\/callback/);
  await form.locator('select').nth(1).selectOption('browser');
  await form.locator('.section select').selectOption('edge');
  await form.screenshot({ path: process.env.SHOT4 ?? '/tmp/claude-0/form.png' });
  await form.locator('button.primary').click();
  m = (await fsent()).filter((x) => x.type === 'save').pop();
  assert.equal(m.form.auth, 'browser');
  assert.equal(m.form.browserKind, 'edge');
  assert.equal(m.form.name, 'DEV');
});

await browser.close();
server.close();
console.log(`\n${passed} checks passed${process.exitCode ? ', with FAILURES' : ''}`);
