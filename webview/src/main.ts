import { Grid, SelectionInfo } from './grid.js';
import { BindField, BindType, CopyFormat, FromWebview, RunDTO, ToWebview, ViewSettings } from './protocol.js';
import { el, fmtMs, fmtNum, prettyValue } from './util.js';

interface VsCodeApi {
  postMessage(msg: FromWebview): void;
  getState(): { wrap?: boolean; record?: boolean } | undefined;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode: VsCodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState: () => undefined, setState() {} };

interface RunView {
  dto: RunDTO;
  pane: HTMLElement;
  grid?: Grid;
  visible: number;
  selection: SelectionInfo | null;
  focusRow?: number;
}

const ICONS: Record<string, string> = {
  copy: '<path d="M9 9h10v10H9zM5 15V5h10"/>',
  export: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  record: '<path d="M5 4h14v16H5zM9 9h6M9 13h6"/>',
  wrap: '<path d="M4 7h16M4 12h12a3 3 0 010 6h-3m0 0l2-2m-2 2l2 2M4 17h5"/>',
  rerun: '<path d="M20 12a8 8 0 11-2.3-5.7M20 4v5h-5"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<path d="M12 5v14m0 0l-5-5m5 5l5-5"/>',
  stop: '<path d="M7 7h10v10H7z"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  warn: '<path d="M12 4l9 16H3zM12 10v4m0 3v.01"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/>'
};
function icon(name: string): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ico');
  s.innerHTML = ICONS[name] ?? '';
  return s;
}

const app = document.getElementById('app')!;
const tabsEl = el('div', 'tabs');
const toolbarEl = el('div', 'toolbar');
const contentEl = el('div', 'content');
const mainEl = el('div', 'main');
const recordEl = el('div', 'record hidden');
const statusEl = el('div', 'statusbar');
const toastEl = el('div', 'toasts');
const overlay = el('div', 'overlay');
contentEl.append(mainEl, recordEl);
app.append(tabsEl, toolbarEl, contentEl, statusEl, toastEl, overlay);

const runs = new Map<string, RunView>();
let activeId: string | undefined;
let settings: ViewSettings = { wrapText: false, maxCellLength: 5000, fetchSize: 1000 };
const saved = vscode.getState() ?? {};
let wrap = saved.wrap ?? false;
let recordOn = saved.record ?? false;
let quickText = '';
let columnFilters = false;
let tick: number | undefined;

const send = (m: FromWebview) => vscode.postMessage(m);
const persist = () => vscode.setState({ wrap, record: recordOn });

// ------------------------------------------------------------------------------ helpers

function active(): RunView | undefined {
  return activeId ? runs.get(activeId) : undefined;
}

function toast(text: string, level: 'info' | 'error' = 'info'): void {
  const t = el('div', `toast ${level}`, text);
  toastEl.append(t);
  window.setTimeout(() => t.classList.add('out'), level === 'error' ? 5000 : 1800);
  window.setTimeout(() => t.remove(), level === 'error' ? 5400 : 2200);
}

let openPrompt: string | undefined;

function closeMenus(): void {
  if (openPrompt) {
    // dismissing the bind dialog any other way (backdrop click, panel blur) counts as Cancel so the host never waits forever
    const id = openPrompt;
    openPrompt = undefined;
    send({ type: 'bind-cancel', promptId: id });
  }
  overlay.textContent = '';
  overlay.classList.remove('open', 'modal');
}

interface MenuItem {
  label?: string;
  hint?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenus();
  overlay.classList.add('open');
  const menu = el('div', 'menu');
  for (const it of items) {
    if (it.separator) {
      menu.append(el('div', 'sep'));
      continue;
    }
    const row = el('div', 'item' + (it.disabled ? ' disabled' : ''));
    row.append(el('span', 'lbl', it.label ?? ''));
    if (it.hint) {
      row.append(el('span', 'hint', it.hint));
    }
    row.addEventListener('click', () => {
      if (!it.disabled) {
        closeMenus();
        it.action?.();
      }
    });
    menu.append(row);
  }
  overlay.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
}
overlay.addEventListener('mousedown', (e) => {
  if (e.target === overlay) {
    closeMenus();
  }
});
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open') && !overlay.querySelector('.dialog')) {
      // capture phase: the grid stops propagation of keys it handles
      e.preventDefault();
      e.stopPropagation();
      closeMenus();
      active()?.grid?.focusGrid();
    }
  },
  true
);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    const f = toolbarEl.querySelector<HTMLInputElement>('input.quick');
    if (f) {
      e.preventDefault();
      f.focus();
      f.select();
    }
  }
});
window.addEventListener('blur', () => {
  if (!overlay.classList.contains('modal') && !openPrompt) {
    closeMenus();
  }
});

function button(label: string, ico: string | undefined, title: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = el('button', `btn ${cls}`);
  b.title = title;
  if (ico) {
    b.append(icon(ico));
  }
  if (label) {
    b.append(el('span', undefined, label));
  }
  b.addEventListener('click', onClick);
  return b;
}

// -------------------------------------------------------------------------------- tabs

function renderTabs(): void {
  tabsEl.textContent = '';
  for (const rv of runs.values()) {
    const d = rv.dto;
    const t = el('div', 'tab' + (d.runId === activeId ? ' active' : '') + ` ${d.status}`);
    t.title = `${d.sql}\n\n${d.connectionName}`;
    const dot = el('span', `dot ${d.loading ? 'running' : d.status}`);
    t.append(dot, el('span', 'ttl', d.title || 'query'));
    const pin = el('span', 'pin' + (d.pinned ? ' on' : ''));
    pin.append(icon('pin'));
    pin.title = d.pinned ? 'Unpin (this result is kept)' : 'Pin: keep this result when you run another query';
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      d.pinned = !d.pinned;
      send({ type: 'pin', runId: d.runId, pinned: !!d.pinned });
      renderTabs();
    });
    t.append(pin);
    const x = el('span', 'x');
    x.append(icon('close'));
    x.title = 'Close';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRun(d.runId);
    });
    t.append(x);
    t.addEventListener('click', () => activate(d.runId));
    t.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        closeRun(d.runId);
      }
    });
    tabsEl.append(t);
  }
  if (runs.size === 0) {
    tabsEl.append(el('div', 'tabs-empty', 'Results'));
  }
}

function closeRun(id: string): void {
  const rv = runs.get(id);
  if (!rv) {
    return;
  }
  rv.grid?.destroy();
  rv.pane.remove();
  runs.delete(id);
  send({ type: 'close-run', runId: id });
  if (activeId === id) {
    activeId = [...runs.keys()].pop();
  }
  refresh();
}

function activate(id: string): void {
  activeId = id;
  refresh();
}

// ---------------------------------------------------------------------------- run views

function ensureRun(dto: RunDTO): RunView {
  let rv = runs.get(dto.runId);
  if (!rv) {
    const pane = el('div', 'pane hidden');
    mainEl.append(pane);
    rv = { dto, pane, visible: 0, selection: null };
    runs.set(dto.runId, rv);
  } else {
    rv.dto = dto;
  }
  return rv;
}

function ensureGrid(rv: RunView): Grid {
  if (!rv.grid) {
    rv.pane.textContent = '';
    rv.grid = new Grid(rv.pane, {
      copy: (text, label) => send({ type: 'copy', text, label }),
      selectionChanged: (info, focusRow) => {
        rv.selection = info;
        rv.focusRow = focusRow;
        if (rv.dto.runId === activeId) {
          renderStatus();
          renderRecord();
        }
      },
      contextMenu: (e) => gridMenu(rv, e),
      openCell: (r, c) => openCell(rv, r, c),
      viewChanged: (visible) => {
        rv.visible = visible;
        if (rv.dto.runId === activeId) {
          updateInfo(rv);
          renderStatus();
        }
      },
      nearEnd: () => {
        if (rv.dto.hasMore && !rv.dto.loading) {
          send({ type: 'fetch-more', runId: rv.dto.runId, all: false });
        }
      }
    });
    rv.grid.setOptions({ wrap: wrap || settings.wrapText, maxCell: settings.maxCellLength });
  }
  return rv.grid;
}

function paintPane(rv: RunView): void {
  const d = rv.dto;
  if (d.status === 'running' && d.columns.length === 0) {
    rv.pane.textContent = '';
    const box = el('div', 'state running-state');
    box.append(el('div', 'spinner'));
    box.append(el('div', 'state-title', 'Running query…'));
    const timer = el('div', 'state-sub timer', '0.0 s');
    timer.dataset['since'] = String(d.startedAt);
    box.append(timer, el('code', 'sqlpreview', d.sql.length > 400 ? d.sql.slice(0, 400) + '…' : d.sql));
    box.append(button('Cancel', 'stop', 'Cancel (the server may keep running the query)', () => send({ type: 'cancel', runId: d.runId }), 'secondary'));
    rv.pane.append(box);
    rv.grid = undefined;
    return;
  }
  if (d.status === 'error' || (d.status === 'cancelled' && d.columns.length === 0)) {
    rv.grid?.destroy();
    rv.grid = undefined;
    rv.pane.textContent = '';
    const box = el('div', `state error-state ${d.status}`);
    const head = el('div', 'err-head');
    head.append(icon('warn'), el('span', undefined, d.status === 'cancelled' ? 'Cancelled' : 'Query failed'));
    if (d.error?.kind && d.error.kind !== 'unknown' && d.status !== 'cancelled') {
      head.append(el('span', 'badge', d.error.kind));
    }
    box.append(head, el('pre', 'err-msg', d.error?.message ?? ''));
    if (d.error?.hint) {
      box.append(el('div', 'err-hint', d.error.hint));
    }
    const actions = el('div', 'err-actions');
    actions.append(
      button('Copy error', 'copy', 'Copy the error text', () => send({ type: 'copy', text: `${d.error?.message ?? ''}\n\n${d.sql}`, label: 'Copied error and SQL' }), 'secondary'),
      button('Edit SQL', 'code', 'Open the statement in a worksheet', () => send({ type: 'open-sql', runId: d.runId }), 'secondary'),
      button('Run again', 'rerun', 'Run the statement again', () => send({ type: 'rerun', runId: d.runId }))
    );
    box.append(actions, el('code', 'sqlpreview', d.sql.length > 600 ? d.sql.slice(0, 600) + '…' : d.sql));
    rv.pane.append(box);
    return;
  }
  const g = ensureGrid(rv);
  void g;
}

// -------------------------------------------------------------------------------- toolbar

function infoText(rv: RunView): string {
  const d = rv.dto;
  const n = rv.grid?.rowCount ?? d.rows.length;
  const visible = rv.visible || n;
  return visible !== n ? `${fmtNum(visible)} of ${fmtNum(n)} rows` : `${fmtNum(n)} row${n === 1 ? '' : 's'}${d.hasMore ? '+' : ''}`;
}

/** Update only the counter so typing in the filter box never loses focus. */
function updateInfo(rv: RunView): void {
  const e = toolbarEl.querySelector<HTMLElement>('.tb-info.counts');
  if (e) {
    e.textContent = infoText(rv);
  }
}

function rowsBox(): HTMLElement {
  const wrapEl = el('label', 'rows');
  wrapEl.title = 'Rows to fetch per run (1 - 1,000,000). Press Enter. "Fetch more" loads another batch of this size.';
  wrapEl.append(el('span', undefined, 'Rows'));
  const inp = el('input', 'rows-input');
  inp.setAttribute('list', 'row-presets');
  inp.value = String(settings.fetchSize);
  const list = el('datalist');
  list.id = 'row-presets';
  for (const n of [100, 500, 1000, 5000, 10000, 50000, 100000, 1000000]) {
    const o = el('option');
    o.value = String(n);
    list.append(o);
  }
  const commit = () => {
    const n = Math.floor(Number(inp.value.replace(/[, _]/g, '')));
    if (Number.isFinite(n) && n >= 1) {
      const v = Math.min(1_000_000, n);
      inp.value = String(v);
      if (v !== settings.fetchSize) {
        settings = { ...settings, fetchSize: v };
        send({ type: 'set-fetch-size', value: v });
      }
    } else {
      inp.value = String(settings.fetchSize);
    }
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      commit();
      inp.blur();
    }
  });
  wrapEl.append(inp, list);
  return wrapEl;
}

function renderToolbar(): void {
  toolbarEl.textContent = '';
  const rv = active();
  if (!rv) {
    toolbarEl.append(el('div', 'tb-left'), (() => { const r = el('div', 'tb-right'); r.append(rowsBox()); return r; })());
    return;
  }
  const d = rv.dto;
  const left = el('div', 'tb-left');
  const right = el('div', 'tb-right');

  if (d.status === 'running' || d.loading) {
    left.append(el('span', 'dotspin'), el('span', 'tb-info', d.columns.length ? `Fetching more rows… ${fmtNum(d.rows.length)} so far` : 'Running…'));
    left.append(button('Cancel', 'stop', 'Cancel', () => send({ type: 'cancel', runId: d.runId }), 'secondary'));
  } else if (d.status === 'error') {
    left.append(el('span', 'tb-info err', 'Failed'), el('span', 'tb-meta', `${fmtMs(d.elapsedMs)} · ${d.connectionName}`));
  } else {
    left.append(el('span', 'tb-info counts', infoText(rv)));
    left.append(el('span', 'tb-meta', `${fmtMs(d.elapsedMs)} · ${d.connectionName}${d.environment === 'PROD' ? ' · PROD' : ''}`));
    if (d.hasMore) {
      left.append(button(`Fetch ${fmtNum(settings.fetchSize)} more`, 'more', 'Fetch the next batch of rows from the server', () => send({ type: 'fetch-more', runId: d.runId, all: false }), 'secondary'));
      left.append(button('Fetch all', undefined, 'Fetch every remaining row (up to the maxRows setting)', () => send({ type: 'fetch-more', runId: d.runId, all: true }), 'secondary'));
    }
  }

  right.append(rowsBox());
  if (d.columns.length) {
    const q = el('input', 'quick');
    q.placeholder = 'Filter rows…  (Ctrl+F)';
    q.value = quickText;
    q.addEventListener('input', () => {
      quickText = q.value;
      rv.grid?.setQuickFilter(quickText);
    });
    q.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        q.value = quickText = '';
        rv.grid?.setQuickFilter('');
        rv.grid?.focusGrid();
      }
    });
    right.append(q);
    right.append(
      button('', 'filter', 'Per-column filters', (e) => {
        columnFilters = rv.grid?.toggleColumnFilters() ?? false;
        (e.currentTarget as HTMLElement).classList.toggle('on', columnFilters);
      }, columnFilters ? 'icon on' : 'icon')
    );
    right.append(
      button('Copy', 'copy', 'Copy the selection (Ctrl+C) or choose a format', (e) => copyMenu(rv, e.currentTarget as HTMLElement), 'secondary'),
      button('Export', 'export', 'Export to a file', (e) => exportMenu(rv, e.currentTarget as HTMLElement), 'secondary'),
      button('', 'record', 'Record view: all columns of the selected row', () => {
        recordOn = !recordOn;
        persist();
        refresh();
      }, recordOn ? 'icon on' : 'icon'),
      button('', 'wrap', 'Wrap long text', () => {
        wrap = !wrap;
        persist();
        for (const r of runs.values()) {
          r.grid?.setOptions({ wrap: wrap || settings.wrapText });
        }
        refresh();
      }, wrap ? 'icon on' : 'icon')
    );
  }
  right.append(
    button('', 'rerun', 'Run this statement again', () => send({ type: 'rerun', runId: d.runId }), 'icon'),
    button('', 'code', 'Open the SQL in a worksheet', () => send({ type: 'open-sql', runId: d.runId }), 'icon')
  );
  toolbarEl.append(left, right);
}

function scopeIndexes(rv: RunView, selectionOnly: boolean): { rowIdx: number[] | null; colIdx: number[] | null; label: string } {
  const g = rv.grid;
  if (selectionOnly && g) {
    const s = g.selectionIndexes();
    if (s) {
      return { rowIdx: s.rowIdx, colIdx: s.colIdx, label: 'selection' };
    }
  }
  return { rowIdx: g ? g.viewIndexes() : null, colIdx: null, label: 'all rows' };
}

function copyMenu(rv: RunView, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const g = rv.grid;
  const has = !!g?.selectionIndexes();
  const as = (format: CopyFormat, headers: boolean) => () => {
    const s = scopeIndexes(rv, true);
    send({ type: 'copy-as', runId: rv.dto.runId, format, headers, rowIdx: s.rowIdx, colIdx: s.colIdx });
  };
  showMenu(r.left, r.bottom + 2, [
    { label: has ? 'Copy selection' : 'Copy all rows', hint: 'Ctrl+C', action: () => (has ? g?.copySelection(false) : as('tsv', false)()) },
    { label: has ? 'Copy selection with headers' : 'Copy all rows with headers', hint: 'Ctrl+Shift+C', action: () => (has ? g?.copySelection(true) : as('tsv', true)()) },
    { separator: true },
    { label: 'Copy as CSV', action: as('csv', true) },
    { label: 'Copy as JSON', action: as('json', true) },
    { label: 'Copy as Markdown table', action: as('markdown', true) },
    { label: 'Copy as INSERT statements', action: as('insert', true) },
    { label: 'Copy first column as IN (…) list', action: as('inlist', false) }
  ]);
}

function exportMenu(rv: RunView, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const g = rv.grid;
  const has = !!g?.selectionIndexes() && (g?.selectionIndexes()?.rowIdx.length ?? 0) * (g?.selectionIndexes()?.colIdx.length ?? 0) > 1;
  const ex = (format: 'csv' | 'xlsx' | 'json', sel: boolean) => () => {
    const s = scopeIndexes(rv, sel);
    send({ type: 'export', runId: rv.dto.runId, format, rowIdx: s.rowIdx, colIdx: s.colIdx });
  };
  const n = rv.visible || rv.dto.rows.length;
  showMenu(r.left, r.bottom + 2, [
    { label: `Excel (.xlsx) · ${fmtNum(n)} rows`, action: ex('xlsx', false) },
    { label: `CSV (.csv) · ${fmtNum(n)} rows`, action: ex('csv', false) },
    { label: `JSON (.json) · ${fmtNum(n)} rows`, action: ex('json', false) },
    { separator: true },
    { label: 'Selection to Excel', action: ex('xlsx', true), disabled: !has },
    { label: 'Selection to CSV', action: ex('csv', true), disabled: !has }
  ]);
}

function gridMenu(rv: RunView, e: { x: number; y: number; kind: 'cell' | 'header' | 'gutter'; row: number; col: number }): void {
  const g = rv.grid;
  if (!g) {
    return;
  }
  const sel = g.selectionIndexes();
  const cellValue = e.kind === 'header' ? '' : g.cell(e.row, e.col);
  const colName = g.columns[e.col];
  const as = (format: CopyFormat, headers: boolean, selection = true) => () => {
    const s = scopeIndexes(rv, selection);
    send({ type: 'copy-as', runId: rv.dto.runId, format, headers, rowIdx: s.rowIdx, colIdx: s.colIdx });
  };
  const items: MenuItem[] = [];
  if (e.kind === 'header') {
    items.push(
      { label: 'Sort ascending', action: () => g.sortBy(e.col, 'asc') },
      { label: 'Sort descending', action: () => g.sortBy(e.col, 'desc') },
      { label: 'Clear sort', action: () => g.sortBy(e.col, undefined) },
      { separator: true },
      { label: 'Select column', action: () => g.selectColumn(e.col) },
      {
        label: 'Copy column',
        action: () => {
          g.selectColumn(e.col);
          g.copySelection(false);
        }
      },
      {
        label: 'Copy column with header',
        action: () => {
          g.selectColumn(e.col);
          g.copySelection(true);
        }
      },
      { label: 'Copy column name', action: () => send({ type: 'copy', text: colName, label: 'Copied column name' }) },
      { separator: true },
      { label: 'Fit column to content', action: () => g.autosize(e.col) }
    );
  } else {
    items.push(
      { label: 'Copy', hint: 'Ctrl+C', action: () => g.copySelection(false), disabled: !sel },
      { label: 'Copy with headers', hint: 'Ctrl+Shift+C', action: () => g.copySelection(true), disabled: !sel },
      { label: 'Copy as CSV', action: as('csv', true), disabled: !sel },
      { label: 'Copy as JSON', action: as('json', true), disabled: !sel },
      { label: 'Copy as Markdown', action: as('markdown', true), disabled: !sel },
      { label: 'Copy as INSERT statements', action: as('insert', true), disabled: !sel },
      { label: 'Copy as IN (…) list', action: as('inlist', false), disabled: !sel },
      { separator: true },
      { label: 'View value…', hint: 'Enter', action: () => openCell(rv, e.row, e.col), disabled: e.kind === 'gutter' },
      {
        label: 'Filter to this value',
        action: () => {
          if (!rv.grid) {
            return;
          }
          rv.grid.toggleColumnFilters(true);
          columnFilters = true;
          rv.grid.setColumnFilter(e.col, cellValue === '' ? 'empty' : `=${cellValue}`);
          refresh();
        },
        disabled: e.kind === 'gutter'
      },
      { separator: true },
      { label: 'Select all', hint: 'Ctrl+A', action: () => g.selectAll() }
    );
  }
  showMenu(e.x, e.y, items);
}

// ---------------------------------------------------------------------------- cell viewer

function openCell(rv: RunView, row: number, col: number): void {
  const g = rv.grid;
  if (!g) {
    return;
  }
  const value = g.cell(row, col);
  const colName = g.columns[col];
  closeMenus();
  overlay.classList.add('open', 'modal');
  const pv = prettyValue(value);
  const card = el('div', 'viewer');
  const head = el('div', 'viewer-head');
  head.append(el('span', 'viewer-title', colName), el('span', 'viewer-sub', `row ${fmtNum(row + 1)} · ${fmtNum(value.length)} chars${pv.kind !== 'text' ? ` · ${pv.kind.toUpperCase()}` : ''}`));
  const bodyEl = el('pre', 'viewer-body');
  bodyEl.textContent = value === '' ? '(empty / NULL)' : pv.text;
  const foot = el('div', 'viewer-foot');
  foot.append(
    button('Copy value', 'copy', 'Copy the raw value', () => send({ type: 'copy', text: value, label: 'Copied value' })),
    button('Close', undefined, 'Close (Esc)', () => closeMenus(), 'secondary')
  );
  card.append(head, bodyEl, foot);
  overlay.append(card);
  card.tabIndex = -1;
  card.focus();
  overlay.addEventListener(
    'mousedown',
    (ev) => {
      if (ev.target === overlay) {
        closeMenus();
        g.focusGrid();
      }
    },
    { once: true }
  );
}

// ---------------------------------------------------------------------------- record view

let recordFilter = '';
function renderRecord(): void {
  const rv = active();
  recordEl.classList.toggle('hidden', !(recordOn && rv && rv.grid));
  if (!(recordOn && rv && rv.grid)) {
    return;
  }
  recordEl.textContent = '';
  const g = rv.grid;
  const row = rv.focusRow;
  const head = el('div', 'rec-head');
  head.append(el('span', 'rec-title', row === undefined ? 'Record view' : `Row ${fmtNum((g.viewIndexes()[row] ?? 0) + 1)}`));
  const f = el('input', 'rec-filter');
  f.placeholder = 'Find column…';
  f.value = recordFilter;
  f.addEventListener('input', () => {
    recordFilter = f.value;
    renderRecord();
    recordEl.querySelector<HTMLInputElement>('.rec-filter')?.focus();
  });
  f.addEventListener('keydown', (e) => e.stopPropagation());
  head.append(f);
  recordEl.append(head);
  if (row === undefined) {
    recordEl.append(el('div', 'rec-empty', 'Click a row to see all of its columns here.'));
    return;
  }
  const list = el('div', 'rec-list');
  g.columns.forEach((name, c) => {
    if (recordFilter && !name.toLowerCase().includes(recordFilter.toLowerCase())) {
      return;
    }
    const v = g.cell(row, c);
    const item = el('div', 'rec-item');
    item.append(el('div', 'rec-key', name), el('div', 'rec-val' + (v === '' ? ' empty' : ''), v === '' ? '(empty)' : v.length > 600 ? v.slice(0, 600) + '…' : v));
    item.title = 'Click to copy';
    item.addEventListener('click', () => send({ type: 'copy', text: v, label: `Copied ${name}` }));
    list.append(item);
  });
  recordEl.append(list);
}

// ---------------------------------------------------------------------------- status bar

function renderStatus(): void {
  statusEl.textContent = '';
  const rv = active();
  if (!rv) {
    return;
  }
  const s = rv.selection;
  if (s) {
    statusEl.append(el('span', 'st', s.cells === 1 ? '1 cell selected' : `${fmtNum(s.rows)} row${s.rows === 1 ? '' : 's'} × ${fmtNum(s.cols)} col${s.cols === 1 ? '' : 's'}`));
    if (s.numeric) {
      const n = s.numeric;
      const f = (x: number) => (Number.isInteger(x) ? fmtNum(x) : x.toLocaleString(undefined, { maximumFractionDigits: 4 }));
      statusEl.append(el('span', 'st agg', `Sum ${f(n.sum)}`), el('span', 'st agg', `Avg ${f(n.avg)}`), el('span', 'st agg', `Min ${f(n.min)}`), el('span', 'st agg', `Max ${f(n.max)}`), el('span', 'st agg', `Count ${fmtNum(n.count)}`));
    }
  } else if (rv.grid) {
    statusEl.append(el('span', 'st dim', 'Click a cell · drag to select · Ctrl+C copies · double-click opens the value · right-click for more'));
  }
  if (rv.dto.note) {
    statusEl.append(el('span', 'st note', rv.dto.note));
  }
}

// ------------------------------------------------------------------------------- refresh

function refresh(): void {
  renderTabs();
  for (const [id, rv] of runs) {
    rv.pane.classList.toggle('hidden', id !== activeId);
  }
  const rv = active();
  if (!rv) {
    mainEl.querySelector('.empty-state')?.remove();
    const empty = el('div', 'state empty-state');
    empty.append(
      el('div', 'state-title', 'No results yet'),
      el('div', 'state-sub', 'Open a SQL file and press Ctrl+Enter (Cmd+Enter on macOS) to run the statement under the cursor, or F5 to run the whole script.')
    );
    mainEl.append(empty);
  } else {
    mainEl.querySelector('.empty-state')?.remove();
    paintPaneIfNeeded(rv);
    rv.grid?.resize();
    rv.grid?.setQuickFilter(quickText);
  }
  renderToolbar();
  renderStatus();
  renderRecord();
  if (tick === undefined) {
    tick = window.setInterval(() => {
      const t = mainEl.querySelector<HTMLElement>('.timer');
      if (t?.dataset['since']) {
        t.textContent = fmtMs(Date.now() - Number(t.dataset['since']));
      }
    }, 150);
  }
}

function paintPaneIfNeeded(rv: RunView): void {
  const d = rv.dto;
  const wantGrid = d.columns.length > 0 || (d.status === 'done' && d.columns.length === 0);
  if (wantGrid && d.status !== 'error') {
    if (!rv.grid) {
      ensureGrid(rv);
      rv.grid!.setData(d.columns, d.rows);
    }
    if (d.status === 'done' && d.columns.length === 0 && !rv.pane.querySelector('.zero')) {
      rv.pane.append(el('div', 'state-sub zero', 'The query returned no rows.'));
    }
  } else {
    paintPane(rv);
  }
}

// ---------------------------------------------------------------------------- messages

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': {
      for (const rv of runs.values()) {
        rv.grid?.destroy();
        rv.pane.remove();
      }
      runs.clear();
      settings = m.settings;
      for (const d of m.runs) {
        const rv = ensureRun(d);
        if (d.columns.length || d.status === 'done') {
          ensureGrid(rv).setData(d.columns, d.rows);
        } else {
          paintPane(rv);
        }
      }
      activeId = m.activeRunId && runs.has(m.activeRunId) ? m.activeRunId : [...runs.keys()].pop();
      refresh();
      break;
    }
    case 'run-start': {
      quickText = '';
      for (const id of m.drop ?? []) {
        const old = runs.get(id);
        if (old) {
          old.grid?.destroy();
          old.pane.remove();
          runs.delete(id);
        }
      }
      const rv = ensureRun(m.run);
      paintPane(rv);
      activeId = m.run.runId;
      refresh();
      break;
    }
    case 'run-rows': {
      const rv = runs.get(m.runId);
      if (!rv) {
        break;
      }
      const d = rv.dto;
      d.status = 'done';
      d.loading = false;
      d.error = undefined;
      d.hasMore = m.hasMore;
      d.elapsedMs = m.elapsedMs;
      d.note = m.note;
      if (m.append) {
        d.rows = d.rows.concat(m.rows);
        rv.grid?.appendRows(m.rows);
      } else {
        d.columns = m.columns;
        d.rows = m.rows;
        rv.grid?.destroy();
        rv.grid = undefined;
        rv.pane.textContent = '';
        ensureGrid(rv).setData(m.columns, m.rows);
        if (m.columns.length === 0) {
          rv.pane.append(el('div', 'state-sub zero', 'The query returned no rows.'));
        }
      }
      if (m.runId === activeId) {
        refresh();
      } else {
        renderTabs();
      }
      break;
    }
    case 'run-loading': {
      const rv = runs.get(m.runId);
      if (rv) {
        rv.dto.loading = m.loading;
        refresh();
      }
      break;
    }
    case 'run-error': {
      const rv = runs.get(m.runId);
      if (rv) {
        rv.dto.status = m.status;
        rv.dto.loading = false;
        rv.dto.error = m.error;
        rv.dto.elapsedMs = m.elapsedMs;
        if (!rv.dto.columns.length || m.status === 'error') {
          paintPane(rv);
        }
        refresh();
      }
      break;
    }
    case 'settings':
      settings = m.settings;
      for (const rv of runs.values()) {
        rv.grid?.setOptions({ wrap: wrap || settings.wrapText, maxCell: settings.maxCellLength });
      }
      refresh();
      break;
    case 'toast':
      toast(m.text, m.level);
      break;
    case 'bind-prompt':
      showBindDialog(m.promptId, m.binds);
      break;
    case 'focus-run':
      if (runs.has(m.runId)) {
        activate(m.runId);
      }
      break;
  }
});

refresh();
send({ type: 'ready' });


// ------------------------------------------------------------------------ bind dialog

function showBindDialog(promptId: string, binds: BindField[]): void {
  closeMenus();
  openPrompt = promptId;
  overlay.classList.add('open', 'modal');
  const card = el('div', 'dialog');
  const head = el('div', 'dialog-head');
  head.append(el('span', 'dialog-title', 'Bind Variables'));
  const x = el('span', 'dialog-x');
  x.append(icon('close'));
  head.append(x);
  const grid = el('div', 'bind-grid');
  for (const h of ['Parameter Name', 'Parameter Value', 'Is Null', 'Data Type']) {
    grid.append(el('div', 'bind-h', h));
  }
  const rows = binds.map((b) => {
    const name = el('div', 'bind-name', ':' + b.name);
    const value = el('input', 'bind-value');
    value.value = b.value;
    value.placeholder = b.type === 'DATE' || b.type === 'TIMESTAMP' ? 'YYYY-MM-DD or YYYY-MM-DD HH:MI:SS' : '';
    const nul = el('input', 'bind-null');
    nul.type = 'checkbox';
    nul.checked = b.isNull;
    const type = el('select', 'bind-type');
    for (const t of ['VARCHAR2', 'NUMBER', 'DATE', 'TIMESTAMP'] as BindType[]) {
      const o = el('option', undefined, t);
      o.value = t;
      type.append(o);
    }
    type.value = b.type;
    const sync = () => {
      value.disabled = nul.checked;
      value.classList.toggle('disabled', nul.checked);
    };
    nul.addEventListener('change', sync);
    type.addEventListener('change', () => {
      value.placeholder = type.value === 'DATE' || type.value === 'TIMESTAMP' ? 'YYYY-MM-DD or YYYY-MM-DD HH:MI:SS' : '';
    });
    sync();
    const nc = el('div', 'bind-cell');
    nc.append(nul);
    grid.append(name, value, nc, type);
    return { b, value, nul, type };
  });
  const foot = el('div', 'dialog-foot');
  const done = (ok: boolean) => {
    openPrompt = undefined;
    closeMenus();
    if (ok) {
      send({ type: 'bind-submit', promptId, values: rows.map((r) => ({ name: r.b.name, value: r.value.value, isNull: r.nul.checked, type: r.type.value as BindType })) });
    } else {
      send({ type: 'bind-cancel', promptId });
    }
  };
  foot.append(
    button('Cancel', undefined, 'Cancel (Esc)', () => done(false), 'secondary'),
    button('Clear', undefined, 'Clear all values', () => rows.forEach((r) => { r.value.value = ''; r.nul.checked = false; r.value.disabled = false; }), 'secondary'),
    button('Execute', undefined, 'Run the query (Enter)', () => done(true))
  );
  x.addEventListener('click', () => done(false));
  card.append(head, grid, foot);
  card.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      done(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done(false);
    }
  });
  overlay.append(card);
  rows[0]?.value.focus();
}
