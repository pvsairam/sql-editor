/**
 * Virtualised result grid with Excel-style selection and reliable copy.
 *
 * Why this exists: the 1.x build used AG Grid Community, whose range selection, clipboard and context
 * menu are Enterprise features, and whose copy relied on APIs that are blocked in VS Code webviews.
 * This grid owns selection and builds the clipboard text itself; the host writes it to the real
 * clipboard (vscode.env.clipboard), so Ctrl+C always works.
 */
import { el, fmtNum, isNumeric } from './util.js';

export interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface SelectionInfo {
  rows: number;
  cols: number;
  cells: number;
  numeric?: { count: number; sum: number; avg: number; min: number; max: number };
}

export interface GridCallbacks {
  /** Text to place on the clipboard (Ctrl+C). */
  copy(text: string, label: string): void;
  selectionChanged(info: SelectionInfo | null, focusRow: number | undefined): void;
  contextMenu(e: { x: number; y: number; kind: 'cell' | 'header' | 'gutter'; row: number; col: number }): void;
  openCell(row: number, col: number): void;
  /** the visible row count changed (filter) */
  viewChanged(visible: number, total: number): void;
  nearEnd(): void;
}

interface Col {
  name: string;
  width: number;
  numeric: boolean;
  /** every non-empty value is an ISO date/time (BI Publisher's CSV format) */
  date: boolean;
  /** the user dragged this column's border: never auto-fit it again */
  userSized?: boolean;
  /** some value has a non-midnight time part */
  time: boolean;
  sort?: 'asc' | 'desc';
  filter: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const ROW_H = 26;
const HEAD_H = 30;
const FILTER_H = 28;
const GUTTER_W = 52;
const OVERSCAN = 6;
const MIN_W = 56;
const MAX_W = 560;

export class Grid {
  readonly root = el('div', 'grid');
  private head = el('div', 'grid-head');
  private headScroll = el('div', 'grid-head-scroll');
  private headInner = el('div', 'grid-head-inner');
  private corner = el('div', 'grid-corner');
  private body = el('div', 'grid-body');
  private canvas = el('div', 'grid-canvas');
  private rowsLayer = el('div', 'grid-rows');

  private cols: Col[] = [];
  private rows: string[][] = [];
  private view: number[] = [];
  private quick = '';
  private showFilters = false;
  private wrap = false;
  private maxCell = 5000;
  private dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'raw' = 'MM/DD/YYYY';
  private ranges: Range[] = [];
  private anchor: { r: number; c: number } | undefined;
  private focus: { r: number; c: number } | undefined;
  private colLeft: number[] = [];
  private totalW = 0;
  private raf = 0;
  private dragging = false;
  private autoScroll: number | undefined;
  private lastPointer = { x: 0, y: 0 };
  private measureCtx = document.createElement('canvas').getContext('2d')!;
  private sortOrder: { col: number; dir: 'asc' | 'desc' } | undefined;
  private nearEndFired = false;
  private resizeObs: ResizeObserver;

  constructor(
    parent: HTMLElement,
    private readonly cb: GridCallbacks
  ) {
    this.head.append(this.corner, this.headScroll);
    this.headScroll.append(this.headInner);
    this.canvas.append(this.rowsLayer);
    this.body.append(this.canvas);
    this.body.tabIndex = 0;
    this.body.setAttribute('role', 'grid');
    this.root.append(this.head, this.body);
    parent.append(this.root);

    this.body.addEventListener('scroll', () => {
      this.headInner.style.transform = `translateX(${-this.body.scrollLeft}px)`;
      this.schedule();
      if (!this.nearEndFired && this.body.scrollTop + this.body.clientHeight > this.canvas.offsetHeight - ROW_H * 12) {
        this.nearEndFired = true;
        this.cb.nearEnd();
      }
    });
    this.body.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.body.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.body.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.body.addEventListener('copy', (e) => {
      const t = this.selectionText(false);
      if (t !== undefined) {
        e.clipboardData?.setData('text/plain', t);
        e.preventDefault();
        this.cb.copy(t, this.copyLabel());
      }
    });
    this.head.addEventListener('contextmenu', (e) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('[data-col]');
      if (h) {
        e.preventDefault();
        this.cb.contextMenu({ x: e.clientX, y: e.clientY, kind: 'header', row: -1, col: Number(h.dataset['col']) });
      }
    });
    this.corner.addEventListener('click', () => this.selectAll());
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mouseup', () => this.onMouseUp());
    this.resizeObs = new ResizeObserver(() => this.schedule());
    this.resizeObs.observe(this.body);
  }

  destroy(): void {
    this.resizeObs.disconnect();
    this.root.remove();
    cancelAnimationFrame(this.raf);
  }

  // ------------------------------------------------------------------------------- data

  setOptions(o: { wrap?: boolean; maxCell?: number; dateFormat?: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'raw' }): void {
    if (o.dateFormat !== undefined) {
      this.dateFormat = o.dateFormat;
    }
    if (o.wrap !== undefined) {
      this.wrap = o.wrap;
      this.root.classList.toggle('wrap', o.wrap);
    }
    if (o.maxCell !== undefined) {
      this.maxCell = o.maxCell;
    }
    this.schedule(true);
  }

  setData(columns: string[], rows: string[][]): void {
    this.cols = columns.map((name) => ({ name, width: 120, numeric: true, date: true, time: false, filter: '' }));
    this.rows = rows;
    this.ranges = [];
    this.anchor = this.focus = undefined;
    this.sortOrder = undefined;
    this.nearEndFired = false;
    this.detectNumeric(0);
    this.detectDates(0);
    this.autosizeAll(1000);
    this.rebuildView();
    this.buildHeader();
    this.body.scrollTop = 0;
    this.body.scrollLeft = 0;
    this.emitSelection();
  }

  appendRows(rows: string[][]): void {
    const start = this.rows.length;
    for (const r of rows) {
      this.rows.push(r);
    }
    this.detectNumeric(start);
    this.detectDates(start);
    this.cols.forEach((c, i) => {
      if (!c.userSized) {
        this.autosize(i, 1000);
      }
    });
    this.nearEndFired = false;
    this.rebuildView();
    this.buildHeader(); // sort glyphs / numeric alignment may have changed
  }

  get rowCount(): number {
    return this.rows.length;
  }
  get visibleCount(): number {
    return this.view.length;
  }
  get columns(): string[] {
    return this.cols.map((c) => c.name);
  }
  cell(viewRow: number, col: number): string {
    return this.rows[this.view[viewRow]]?.[col] ?? '';
  }
  hasDateColumns(): boolean {
    return this.cols.some((c) => c.date);
  }
  display(viewRow: number, col: number): string {
    return this.shown(this.cell(viewRow, col), this.cols[col]);
  }
  isNumericColumn(c: number): boolean {
    return this.cols[c]?.numeric ?? false;
  }

  private detectDates(from: number): void {
    for (let c = 0; c < this.cols.length; c++) {
      const col = this.cols[c];
      if (from > 0 && !col.date) {
        continue;
      }
      let seen = from > 0;
      for (let r = from; r < this.rows.length && col.date; r++) {
        const v = this.rows[r][c];
        if (v === '' || v === undefined) {
          continue;
        }
        const m = ISO_DATE.exec(v);
        if (!m) {
          col.date = false;
          break;
        }
        seen = true;
        if (m[4] && (m[4] !== '00' || m[5] !== '00' || m[6] !== '00')) {
          col.time = true;
        }
      }
      if (!seen) {
        col.date = false;
      }
    }
  }

  /** Text shown in a cell (dates formatted per setting); copy and filters use it too. */
  private shown(v: string, col: Col): string {
    if (!col.date || v === '' || this.dateFormat === 'raw') {
      return v;
    }
    const m = ISO_DATE.exec(v);
    if (!m) {
      return v;
    }
    const [, y, mo, d, hh, mi, ss] = m;
    const date = this.dateFormat === 'YYYY-MM-DD' ? `${y}-${mo}-${d}` : this.dateFormat === 'DD/MM/YYYY' ? `${d}/${mo}/${y}` : `${mo}/${d}/${y}`;
    return col.time && hh ? `${date} ${hh}:${mi}:${ss}` : date;
  }

  private detectNumeric(from: number): void {
    const n = this.cols.length;
    const seen = new Array<boolean>(n).fill(false);
    for (let c = 0; c < n; c++) {
      if (from > 0 && !this.cols[c].numeric) {
        continue;
      }
      for (let r = from; r < this.rows.length; r++) {
        const v = this.rows[r][c];
        if (v === '' || v === undefined) {
          continue;
        }
        if (!isNumeric(v)) {
          this.cols[c].numeric = false;
          break;
        }
        seen[c] = true;
      }
      if (from === 0 && !seen[c]) {
        this.cols[c].numeric = false;
      }
    }
  }

  // ------------------------------------------------------------------ filter / sort / view

  setQuickFilter(text: string): void {
    this.quick = text.trim().toLowerCase();
    this.rebuildView();
  }

  toggleColumnFilters(show?: boolean): boolean {
    this.showFilters = show ?? !this.showFilters;
    this.root.classList.toggle('filters', this.showFilters);
    this.buildHeader();
    this.schedule(true);
    return this.showFilters;
  }

  setColumnFilter(col: number, text: string): void {
    this.cols[col].filter = text;
    this.rebuildView();
  }

  sortBy(col: number, dir: 'asc' | 'desc' | undefined): void {
    for (const c of this.cols) {
      c.sort = undefined;
    }
    this.sortOrder = dir ? { col, dir } : undefined;
    if (dir) {
      this.cols[col].sort = dir;
    }
    this.rebuildView();
    this.buildHeader();
  }

  private matchesColumnFilter(v: string, f: string, numeric: boolean): boolean {
    const t = f.trim();
    if (!t) {
      return true;
    }
    const lower = v.toLowerCase();
    if (t === '=' || t.toLowerCase() === 'empty') {
      return v === '';
    }
    if (t === '!' || t.toLowerCase() === '!empty') {
      return v !== '';
    }
    if (t[0] === '!') {
      return !lower.includes(t.slice(1).toLowerCase());
    }
    const op = /^(>=|<=|>|<|=)\s*(.+)$/.exec(t);
    if (op) {
      const rhs = op[2];
      if (op[1] === '=') {
        return lower === rhs.toLowerCase();
      }
      const a = numeric ? Number(v) : v;
      const b = numeric ? Number(rhs) : rhs;
      if (numeric && (Number.isNaN(a) || Number.isNaN(b))) {
        return false;
      }
      switch (op[1]) {
        case '>':
          return a > b;
        case '<':
          return a < b;
        case '>=':
          return a >= b;
        default:
          return a <= b;
      }
    }
    return lower.includes(t.toLowerCase());
  }

  private rebuildView(): void {
    const colFilters = this.cols.map((c, i) => ({ i, f: c.filter, num: c.numeric })).filter((x) => x.f.trim() !== '');
    let idx: number[] = [];
    const q = this.quick;
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      let ok = true;
      for (const cf of colFilters) {
        if (!this.matchesColumnFilter(row[cf.i] ?? '', cf.f, cf.num)) {
          ok = false;
          break;
        }
      }
      if (ok && q) {
        ok = false;
        for (let c = 0; c < row.length; c++) {
          if (row[c].toLowerCase().includes(q) || (this.cols[c].date && this.shown(row[c], this.cols[c]).toLowerCase().includes(q))) {
            ok = true;
            break;
          }
        }
      }
      if (ok) {
        idx.push(r);
      }
    }
    if (this.sortOrder) {
      const { col, dir } = this.sortOrder;
      const numeric = this.cols[col].numeric;
      const m = dir === 'asc' ? 1 : -1;
      const rows = this.rows;
      idx = idx.sort((a, b) => {
        const va = rows[a][col] ?? '';
        const vb = rows[b][col] ?? '';
        if (va === '' || vb === '') {
          return va === vb ? a - b : va === '' ? 1 : -1; // empties always last
        }
        const d = numeric ? Number(va) - Number(vb) : va < vb ? -1 : va > vb ? 1 : 0;
        return d !== 0 ? d * m : a - b;
      });
    }
    this.view = idx;
    this.ranges = this.ranges.filter((r) => r.r1 < idx.length);
    if (this.focus && this.focus.r >= idx.length) {
      this.focus = this.anchor = undefined;
      this.ranges = [];
    }
    this.canvas.style.height = `${idx.length * ROW_H}px`;
    this.cb.viewChanged(idx.length, this.rows.length);
    this.schedule(true);
    this.emitSelection();
  }

  // ------------------------------------------------------------------------------ layout

  private measure(text: string, bold = false): number {
    const cs = getComputedStyle(this.body);
    this.measureCtx.font = `${bold ? '600 ' : ''}${cs.fontSize} ${cs.fontFamily}`;
    return this.measureCtx.measureText(text).width;
  }

  private autosizeAll(sample: number): void {
    this.cols.forEach((_c, i) => this.autosize(i, sample));
  }

  /**
   * Fit a column to its content: header + the widest values, ignoring the top 2% outliers so one huge
   * description does not stretch the column. Long text is capped (MAX_W); use the cell viewer / wrap for the rest.
   */
  autosize(col: number, sample = 2000, userAction = false): void {
    const c = this.cols[col];
    if (userAction) {
      c.userSized = false;
    }
    const header = this.measure(c.name, true) + 44;
    const n = Math.min(this.rows.length, sample);
    const step = this.rows.length > sample ? this.rows.length / sample : 1;
    const widths: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = this.shown(this.rows[Math.floor(k * step)][col] ?? '', c);
      if (v === '') {
        continue;
      }
      widths.push(this.measure(v.length > 140 ? v.slice(0, 140) : v) + 24);
    }
    widths.sort((x, y) => x - y);
    const body = widths.length === 0 ? 0 : widths.length > 50 ? widths[Math.floor(widths.length * 0.98)] : widths[widths.length - 1];
    c.width = Math.round(Math.min(MAX_W, Math.max(MIN_W, header, body)));
    this.layoutColumns();
  }

  /** Re-fit the columns the user has not resized by hand. */
  refit(): void {
    this.cols.forEach((c, i) => {
      if (!c.userSized) {
        this.autosize(i, 2000);
      }
    });
    this.buildHeader();
    this.schedule(true);
  }

  /** Re-fit every column (toolbar button). */
  fitAll(): void {
    this.cols.forEach((_c, i) => this.autosize(i, 2000, true));
    this.buildHeader();
    this.schedule(true);
  }

  private layoutColumns(): void {
    let x = 0;
    this.colLeft = this.cols.map((c) => {
      const l = x;
      x += c.width;
      return l;
    });
    this.totalW = x;
    this.canvas.style.width = `${GUTTER_W + this.totalW}px`;
    this.headInner.style.width = `${this.totalW}px`;
  }

  private buildHeader(): void {
    this.layoutColumns();
    this.corner.style.width = `${GUTTER_W}px`;
    this.corner.title = 'Select all';
    this.head.style.height = `${HEAD_H + (this.showFilters ? FILTER_H : 0)}px`;
    this.headInner.textContent = '';
    this.cols.forEach((c, i) => {
      const h = el('div', 'hcell' + (c.numeric ? ' num' : ''));
      h.dataset['col'] = String(i);
      h.style.left = `${this.colLeft[i]}px`;
      h.style.width = `${c.width}px`;
      const label = el('span', 'hlabel', c.name);
      h.append(label);
      const sort = el('span', 'hsort', c.sort === 'asc' ? '▲' : c.sort === 'desc' ? '▼' : '');
      h.append(sort);
      h.title = `${c.name}\nClick: sort · Ctrl+click: select column · Right-click: more`;
      h.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('resizer')) {
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          this.selectColumn(i, e.shiftKey);
        } else {
          this.sortBy(i, c.sort === 'asc' ? 'desc' : c.sort === 'desc' ? undefined : 'asc');
        }
      });
      const rz = el('div', 'resizer');
      rz.addEventListener('mousedown', (e) => this.startResize(e, i));
      rz.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.autosize(i, 2000, true);
        this.buildHeader();
        this.schedule(true);
      });
      h.append(rz);
      if (this.showFilters) {
        const f = el('input', 'hfilter');
        f.placeholder = 'filter';
        f.value = c.filter;
        f.title = 'text · =exact · !not · >n · <n · >=n · empty · !empty';
        f.addEventListener('input', () => this.setColumnFilter(i, f.value));
        f.addEventListener('keydown', (e) => e.stopPropagation());
        f.addEventListener('click', (e) => e.stopPropagation());
        h.append(f);
      }
      this.headInner.append(h);
    });
    this.headInner.style.transform = `translateX(${-this.body.scrollLeft}px)`;
  }

  private startResize(e: MouseEvent, col: number): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = this.cols[col].width;
    this.cols[col].userSized = true;
    const move = (ev: MouseEvent) => {
      this.cols[col].width = Math.max(MIN_W, Math.min(1200, startW + ev.clientX - startX));
      this.layoutColumns();
      // reposition this and following header cells
      for (let i = col; i < this.cols.length; i++) {
        const cell = this.headInner.children[i] as HTMLElement | undefined;
        if (cell) {
          cell.style.left = `${this.colLeft[i]}px`;
          cell.style.width = `${this.cols[i].width}px`;
        }
      }
      this.schedule(true);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  resize(): void {
    this.schedule(true);
  }

  // ------------------------------------------------------------------------------- render

  private schedule(force = false): void {
    if (force) {
      this.lastKey = '';
    }
    if (this.raf) {
      return;
    }
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private lastKey = '';

  private colRange(scrollLeft: number, width: number): [number, number] {
    const left = scrollLeft;
    const right = scrollLeft + width;
    let lo = 0;
    let hi = this.cols.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.colLeft[mid] <= left) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    let end = lo;
    while (end < this.cols.length - 1 && this.colLeft[end + 1] < right) {
      end++;
    }
    return [Math.max(0, lo - 1), Math.min(this.cols.length - 1, end + 1)];
  }

  private render(): void {
    const top = this.body.scrollTop;
    const h = this.body.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(this.view.length - 1, Math.ceil((top + h) / ROW_H) + OVERSCAN);
    const [c1, c2] = this.cols.length ? this.colRange(this.body.scrollLeft, this.body.clientWidth) : [0, -1];
    const selKey = this.ranges.map((r) => `${r.r1},${r.c1},${r.r2},${r.c2}`).join(';') + `|${this.focus?.r},${this.focus?.c}`;
    const key = `${first}:${last}:${c1}:${c2}:${selKey}:${this.view.length}:${this.wrap}`;
    if (key === this.lastKey) {
      return;
    }
    this.lastKey = key;

    const frag = document.createDocumentFragment();
    for (let r = first; r <= last; r++) {
      const src = this.rows[this.view[r]];
      if (!src) {
        continue;
      }
      const row = el('div', 'row' + (r % 2 ? ' odd' : ''));
      row.style.top = `${r * ROW_H}px`;
      row.style.width = `${GUTTER_W + this.totalW}px`;
      const g = el('div', 'gutter' + (this.rowFullySelected(r) ? ' sel' : this.rowTouched(r) ? ' part' : ''), String(this.view[r] + 1));
      g.dataset['r'] = String(r);
      g.dataset['gutter'] = '1';
      row.append(g);
      for (let c = c1; c <= c2; c++) {
        const v = this.shown(src[c] ?? '', this.cols[c]);
        const cell = el('div', 'cell' + (this.cols[c].numeric ? ' num' : ''));
        cell.dataset['r'] = String(r);
        cell.dataset['c'] = String(c);
        cell.style.left = `${GUTTER_W + this.colLeft[c]}px`;
        cell.style.width = `${this.cols[c].width}px`;
        const shown = v.length > this.maxCell ? v.slice(0, this.maxCell) + '…' : v;
        cell.textContent = this.wrap ? shown : shown.indexOf('\n') >= 0 || shown.indexOf('\r') >= 0 ? shown.replace(/\r?\n|\r/g, ' ↵ ') : shown;
        if (v === '') {
          cell.classList.add('empty');
        }
        if (this.isSelected(r, c)) {
          cell.classList.add('sel');
        }
        if (this.focus && this.focus.r === r && this.focus.c === c) {
          cell.classList.add('focus');
        }
        row.append(cell);
      }
      frag.append(row);
    }
    this.rowsLayer.textContent = '';
    this.rowsLayer.append(frag);
  }

  // ----------------------------------------------------------------------------- selection

  private norm(r: Range): Range {
    return { r1: Math.min(r.r1, r.r2), r2: Math.max(r.r1, r.r2), c1: Math.min(r.c1, r.c2), c2: Math.max(r.c1, r.c2) };
  }

  private isSelected(r: number, c: number): boolean {
    for (const x of this.ranges) {
      if (r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2) {
        return true;
      }
    }
    return false;
  }

  private rowTouched(r: number): boolean {
    return this.ranges.some((x) => r >= x.r1 && r <= x.r2);
  }

  private rowFullySelected(r: number): boolean {
    return this.ranges.some((x) => r >= x.r1 && r <= x.r2 && x.c1 === 0 && x.c2 === this.cols.length - 1);
  }

  private setRange(a: { r: number; c: number }, b: { r: number; c: number }, additive: boolean): void {
    const rng = this.norm({ r1: a.r, c1: a.c, r2: b.r, c2: b.c });
    this.ranges = additive ? [...this.ranges.slice(0, -1).filter(Boolean), rng] : [rng];
  }

  selectAll(): void {
    if (!this.view.length || !this.cols.length) {
      return;
    }
    this.ranges = [{ r1: 0, c1: 0, r2: this.view.length - 1, c2: this.cols.length - 1 }];
    this.anchor = { r: 0, c: 0 };
    this.focus = { r: this.view.length - 1, c: this.cols.length - 1 };
    this.afterSelectionChange();
  }

  selectColumn(col: number, extend = false): void {
    if (!this.view.length) {
      return;
    }
    const rng = { r1: 0, r2: this.view.length - 1, c1: col, c2: col };
    if (extend && this.ranges.length) {
      const last = this.ranges[this.ranges.length - 1];
      last.c1 = Math.min(last.c1, col);
      last.c2 = Math.max(last.c2, col);
    } else {
      this.ranges = [rng];
    }
    this.anchor = { r: 0, c: col };
    this.focus = { r: 0, c: col };
    this.afterSelectionChange();
    this.body.focus();
  }

  selectRow(row: number, extend = false): void {
    const rng = { r1: row, r2: row, c1: 0, c2: this.cols.length - 1 };
    if (extend && this.anchor) {
      this.ranges = [{ r1: Math.min(this.anchor.r, row), r2: Math.max(this.anchor.r, row), c1: 0, c2: this.cols.length - 1 }];
    } else {
      this.ranges = [rng];
      this.anchor = { r: row, c: 0 };
    }
    this.focus = { r: row, c: 0 };
    this.afterSelectionChange();
  }

  clearSelection(): void {
    this.ranges = [];
    this.afterSelectionChange();
  }

  private afterSelectionChange(): void {
    this.schedule(true);
    this.emitSelection();
  }

  private emitSelection(): void {
    if (this.ranges.length === 0) {
      this.cb.selectionChanged(null, this.focus?.r);
      return;
    }
    const rows = new Set<number>();
    const cols = new Set<number>();
    for (const r of this.ranges) {
      for (let i = r.r1; i <= r.r2; i++) {
        rows.add(i);
      }
      for (let i = r.c1; i <= r.c2; i++) {
        cols.add(i);
      }
    }
    const info: SelectionInfo = { rows: rows.size, cols: cols.size, cells: rows.size * cols.size };
    if (info.cells <= 200_000) {
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      let allNum = true;
      outer: for (const r of this.ranges) {
        for (let i = r.r1; i <= r.r2; i++) {
          const src = this.rows[this.view[i]];
          for (let c = r.c1; c <= r.c2; c++) {
            const v = src?.[c] ?? '';
            if (v === '') {
              continue;
            }
            if (!isNumeric(v)) {
              allNum = false;
              break outer;
            }
            const n = Number(v);
            count++;
            sum += n;
            min = Math.min(min, n);
            max = Math.max(max, n);
          }
        }
      }
      if (allNum && count > 1) {
        info.numeric = { count, sum, avg: sum / count, min, max };
      }
    }
    this.cb.selectionChanged(info, this.focus?.r);
  }

  /** Original data row index + column indexes of the selection, in view order (for host-side copy/export). */
  selectionIndexes(): { rowIdx: number[]; colIdx: number[] } | null {
    if (!this.ranges.length) {
      return null;
    }
    const rows = new Set<number>();
    const cols = new Set<number>();
    for (const r of this.ranges) {
      for (let i = r.r1; i <= r.r2; i++) {
        rows.add(i);
      }
      for (let i = r.c1; i <= r.c2; i++) {
        cols.add(i);
      }
    }
    return { rowIdx: [...rows].sort((a, b) => a - b).map((r) => this.view[r]), colIdx: [...cols].sort((a, b) => a - b) };
  }

  /** The current (filtered + sorted) view as original row indexes. */
  viewIndexes(): number[] {
    return this.view.slice();
  }

  columnIndexes(): number[] {
    return this.cols.map((_c, i) => i);
  }

  private tsvCell(v: string): string {
    return /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }

  /** Clipboard text for the current selection (undefined when nothing is selected). */
  selectionText(withHeaders: boolean): string | undefined {
    if (!this.ranges.length) {
      return undefined;
    }
    const rows = new Set<number>();
    const cols = new Set<number>();
    for (const r of this.ranges) {
      for (let i = r.r1; i <= r.r2; i++) {
        rows.add(i);
      }
      for (let i = r.c1; i <= r.c2; i++) {
        cols.add(i);
      }
    }
    const rs = [...rows].sort((a, b) => a - b);
    const cs = [...cols].sort((a, b) => a - b);
    if (rs.length === 1 && cs.length === 1 && !withHeaders) {
      return this.shown(this.cell(rs[0], cs[0]), this.cols[cs[0]]); // single cell: value as displayed, no quoting
    }
    const lines: string[] = [];
    if (withHeaders) {
      lines.push(cs.map((c) => this.tsvCell(this.cols[c].name)).join('\t'));
    }
    for (const r of rs) {
      lines.push(cs.map((c) => (this.isSelected(r, c) ? this.tsvCell(this.shown(this.cell(r, c), this.cols[c])) : '')).join('\t'));
    }
    return lines.join('\n');
  }

  copyLabel(): string {
    const info = this.ranges.length ? this.selectionIndexes() : null;
    if (!info) {
      return 'Copied';
    }
    const r = info.rowIdx.length;
    const c = info.colIdx.length;
    return r === 1 && c === 1 ? 'Copied cell' : `Copied ${fmtNum(r)} row${r === 1 ? '' : 's'} × ${fmtNum(c)} column${c === 1 ? '' : 's'}`;
  }

  copySelection(withHeaders: boolean): boolean {
    const t = this.selectionText(withHeaders);
    if (t === undefined) {
      return false;
    }
    this.cb.copy(t, this.copyLabel());
    return true;
  }

  focusedViewRow(): number | undefined {
    return this.focus?.r;
  }

  focusedCell(): { r: number; c: number } | undefined {
    return this.focus;
  }

  focusGrid(): void {
    this.body.focus({ preventScroll: true });
  }

  // --------------------------------------------------------------------------- interaction

  private hit(e: MouseEvent): { r: number; c: number; gutter: boolean } | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!this.view.length || !this.cols.length) {
      return undefined;
    }
    const r = Math.max(0, Math.min(this.view.length - 1, Math.floor(y / ROW_H)));
    if (x < GUTTER_W) {
      return { r, c: 0, gutter: true };
    }
    const gx = x - GUTTER_W;
    let lo = 0;
    let hi = this.cols.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.colLeft[mid] <= gx) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { r, c: lo, gutter: false };
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button === 2) {
      // right-click: keep selection if the cell is inside it, otherwise select that cell
      const h = this.hit(e);
      if (h && !h.gutter && !this.isSelected(h.r, h.c)) {
        this.anchor = this.focus = { r: h.r, c: h.c };
        this.ranges = [{ r1: h.r, c1: h.c, r2: h.r, c2: h.c }];
        this.afterSelectionChange();
      }
      return;
    }
    if (e.button !== 0) {
      return;
    }
    const h = this.hit(e);
    if (!h) {
      return;
    }
    this.body.focus({ preventScroll: true });
    if (h.gutter) {
      this.selectRow(h.r, e.shiftKey);
      this.dragging = true;
      this.dragMode = 'row';
      e.preventDefault();
      return;
    }
    const additive = e.ctrlKey || e.metaKey;
    if (e.shiftKey && this.anchor) {
      this.setRange(this.anchor, { r: h.r, c: h.c }, false);
      this.focus = { r: h.r, c: h.c };
    } else {
      this.anchor = { r: h.r, c: h.c };
      this.focus = { r: h.r, c: h.c };
      const rng = { r1: h.r, c1: h.c, r2: h.r, c2: h.c };
      this.ranges = additive ? [...this.ranges, rng] : [rng];
    }
    this.dragging = true;
    this.dragMode = 'cell';
    this.dragAdditive = additive && !e.shiftKey;
    this.afterSelectionChange();
    e.preventDefault(); // no native text selection inside the grid
  }

  private dragMode: 'cell' | 'row' = 'cell';
  private dragAdditive = false;

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragging) {
      return;
    }
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.applyDrag(e);
    // edge auto-scroll
    const rect = this.body.getBoundingClientRect();
    const dy = e.clientY < rect.top + 24 ? -(rect.top + 24 - e.clientY) : e.clientY > rect.bottom - 24 ? e.clientY - (rect.bottom - 24) : 0;
    const dx = e.clientX < rect.left + GUTTER_W + 16 ? -(rect.left + GUTTER_W + 16 - e.clientX) : e.clientX > rect.right - 24 ? e.clientX - (rect.right - 24) : 0;
    if ((dx || dy) && this.autoScroll === undefined) {
      this.autoScroll = window.setInterval(() => {
        const p = this.lastPointer;
        const r = this.body.getBoundingClientRect();
        const ddy = p.y < r.top + 24 ? -(r.top + 24 - p.y) : p.y > r.bottom - 24 ? p.y - (r.bottom - 24) : 0;
        const ddx = p.x < r.left + GUTTER_W + 16 ? -(r.left + GUTTER_W + 16 - p.x) : p.x > r.right - 24 ? p.x - (r.right - 24) : 0;
        this.body.scrollTop += Math.sign(ddy) * Math.min(40, Math.abs(ddy) / 2 + 6);
        this.body.scrollLeft += Math.sign(ddx) * Math.min(60, Math.abs(ddx) / 2 + 8);
        this.applyDrag({ clientX: p.x, clientY: p.y } as MouseEvent);
      }, 30);
    }
    if (!dx && !dy && this.autoScroll !== undefined) {
      clearInterval(this.autoScroll);
      this.autoScroll = undefined;
    }
  }

  private applyDrag(e: MouseEvent): void {
    const h = this.hit(e);
    if (!h || !this.anchor) {
      return;
    }
    if (this.dragMode === 'row') {
      this.ranges = [{ r1: Math.min(this.anchor.r, h.r), r2: Math.max(this.anchor.r, h.r), c1: 0, c2: this.cols.length - 1 }];
      this.focus = { r: h.r, c: 0 };
    } else {
      const rng = this.norm({ r1: this.anchor.r, c1: this.anchor.c, r2: h.r, c2: h.c });
      this.ranges = this.dragAdditive ? [...this.ranges.slice(0, -1), rng] : [rng];
      this.focus = { r: h.r, c: h.c };
    }
    this.afterSelectionChange();
  }

  private onMouseUp(): void {
    this.dragging = false;
    if (this.autoScroll !== undefined) {
      clearInterval(this.autoScroll);
      this.autoScroll = undefined;
    }
  }

  private onDblClick(e: MouseEvent): void {
    const h = this.hit(e);
    if (h && !h.gutter) {
      this.cb.openCell(h.r, h.c);
    }
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const h = this.hit(e);
    if (!h) {
      return;
    }
    this.cb.contextMenu({ x: e.clientX, y: e.clientY, kind: h.gutter ? 'gutter' : 'cell', row: h.r, col: h.c });
  }

  private ensureVisible(r: number, c: number): void {
    const top = r * ROW_H;
    const bottom = top + ROW_H;
    if (top < this.body.scrollTop) {
      this.body.scrollTop = top;
    } else if (bottom > this.body.scrollTop + this.body.clientHeight - 14) {
      this.body.scrollTop = bottom - this.body.clientHeight + 14;
    }
    const left = this.colLeft[c] ?? 0;
    const right = left + (this.cols[c]?.width ?? 0);
    if (left < this.body.scrollLeft) {
      this.body.scrollLeft = left;
    } else if (right > this.body.scrollLeft + this.body.clientWidth - GUTTER_W - 14) {
      this.body.scrollLeft = right - this.body.clientWidth + GUTTER_W + 14;
    }
  }

  private move(dr: number, dc: number, extend: boolean): void {
    if (!this.view.length || !this.cols.length) {
      return;
    }
    const cur = this.focus ?? { r: 0, c: 0 };
    const next = { r: Math.max(0, Math.min(this.view.length - 1, cur.r + dr)), c: Math.max(0, Math.min(this.cols.length - 1, cur.c + dc)) };
    this.focus = next;
    if (extend && this.anchor) {
      this.setRange(this.anchor, next, false);
    } else {
      this.anchor = next;
      this.ranges = [{ r1: next.r, c1: next.c, r2: next.r, c2: next.c }];
    }
    this.ensureVisible(next.r, next.c);
    this.afterSelectionChange();
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor(this.body.clientHeight / ROW_H) - 1);
    switch (e.key) {
      case 'ArrowDown':
        this.move(mod ? this.view.length : 1, 0, e.shiftKey);
        break;
      case 'ArrowUp':
        this.move(mod ? -this.view.length : -1, 0, e.shiftKey);
        break;
      case 'ArrowRight':
        this.move(0, mod ? this.cols.length : 1, e.shiftKey);
        break;
      case 'ArrowLeft':
        this.move(0, mod ? -this.cols.length : -1, e.shiftKey);
        break;
      case 'PageDown':
        this.move(page, 0, e.shiftKey);
        break;
      case 'PageUp':
        this.move(-page, 0, e.shiftKey);
        break;
      case 'Home':
        this.move(mod ? -this.view.length : 0, -this.cols.length, e.shiftKey);
        break;
      case 'End':
        this.move(mod ? this.view.length : 0, this.cols.length, e.shiftKey);
        break;
      case 'a':
      case 'A':
        if (mod) {
          this.selectAll();
        } else {
          return;
        }
        break;
      case 'c':
      case 'C':
        if (mod) {
          this.copySelection(e.shiftKey);
        } else {
          return;
        }
        break;
      case 'Enter':
        if (this.focus) {
          this.cb.openCell(this.focus.r, this.focus.c);
        }
        break;
      case 'Escape':
        this.clearSelection();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
}
