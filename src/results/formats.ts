/** Text serialisations of (a selection of) a result set: copy formats and file exports. */
import { csvField } from '../fusion/csv';

export interface Table {
  columns: string[];
  rows: string[][];
}

export type TextFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'insert' | 'inlist';

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function isNumeric(v: string): boolean {
  return NUMBER_RE.test(v) && v.length < 18;
}

/** A column is numeric when every non-empty value is (BI Publisher CSV carries no type info). */
export function numericColumns(t: Table): boolean[] {
  return t.columns.map((_c, i) => {
    let seen = 0;
    for (const r of t.rows) {
      const v = r[i];
      if (v === '' || v === undefined) {
        continue;
      }
      if (!isNumeric(v)) {
        return false;
      }
      seen++;
    }
    return seen > 0;
  });
}

/** Pick a subset of rows/columns (in the given order). */
export function subset(t: Table, rowIdx: number[] | null, colIdx: number[] | null): Table {
  const cols = colIdx ?? t.columns.map((_c, i) => i);
  const rows = (rowIdx ?? t.rows.map((_r, i) => i)).map((ri) => t.rows[ri]).filter((r): r is string[] => r !== undefined);
  return { columns: cols.map((i) => t.columns[i]), rows: rows.map((r) => cols.map((i) => r[i] ?? '')) };
}

function tsvCell(v: string): string {
  // Excel/Sheets-compatible: quote only when the value would break the grid.
  return /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toTsv(t: Table, headers: boolean): string {
  const lines: string[] = [];
  if (headers) {
    lines.push(t.columns.map(tsvCell).join('\t'));
  }
  for (const r of t.rows) {
    lines.push(r.map(tsvCell).join('\t'));
  }
  return lines.join('\n');
}

export function toCsvText(t: Table, headers: boolean, delimiter = ','): string {
  const lines: string[] = [];
  if (headers) {
    lines.push(t.columns.map((c) => csvField(c, delimiter)).join(delimiter));
  }
  for (const r of t.rows) {
    lines.push(r.map((v) => csvField(v, delimiter)).join(delimiter));
  }
  return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

export function toJson(t: Table, pretty = true): string {
  const num = numericColumns(t);
  const objs = t.rows.map((r) => {
    const o: Record<string, string | number | null> = {};
    t.columns.forEach((c, i) => {
      const v = r[i] ?? '';
      o[c] = v === '' ? null : num[i] ? Number(v) : v;
    });
    return o;
  });
  return JSON.stringify(objs, null, pretty ? 2 : undefined);
}

export function toMarkdown(t: Table): string {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const num = numericColumns(t);
  const head = `| ${t.columns.map(esc).join(' | ')} |`;
  const sep = `| ${t.columns.map((_c, i) => (num[i] ? '---:' : '---')).join(' | ')} |`;
  const body = t.rows.map((r) => `| ${r.map(esc).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function sqlLiteral(v: string, numeric: boolean): string {
  if (v === '') {
    return 'NULL';
  }
  if (numeric) {
    return v;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(v)!;
    return `TO_TIMESTAMP('${m[1]} ${m[2]}', 'YYYY-MM-DD HH24:MI:SS')`;
  }
  return `'${v.replace(/'/g, "''")}'`;
}

export function toInserts(t: Table, tableName: string): string {
  const num = numericColumns(t);
  const cols = t.columns.join(', ');
  return t.rows.map((r) => `INSERT INTO ${tableName} (${cols}) VALUES (${r.map((v, i) => sqlLiteral(v ?? '', num[i])).join(', ')});`).join('\n');
}

/** Values of the first selected column as a SQL IN-list, e.g. 'A', 'B', 'C'. */
export function toInList(t: Table): string {
  const num = numericColumns(t);
  const vals = t.rows.map((r) => r[0] ?? '').filter((v) => v !== '');
  const uniq = [...new Set(vals)];
  return uniq.map((v) => (num[0] ? v : `'${v.replace(/'/g, "''")}'`)).join(', ');
}

/** Guess the table a SELECT reads from, for generated INSERT statements. */
export function guessTableName(sql: string): string {
  const m = /\bFROM\s+([A-Za-z0-9_$#."]+)/i.exec(sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' '));
  return m && !/^\($/.test(m[1]) ? m[1] : 'TABLE_NAME';
}

export function render(t: Table, fmt: TextFormat, opts: { headers: boolean; sql?: string; delimiter?: string }): string {
  switch (fmt) {
    case 'tsv':
      return toTsv(t, opts.headers);
    case 'csv':
      return toCsvText(t, opts.headers, opts.delimiter ?? ',');
    case 'json':
      return toJson(t);
    case 'markdown':
      return toMarkdown(t);
    case 'insert':
      return toInserts(t, guessTableName(opts.sql ?? ''));
    case 'inlist':
      return toInList(t);
  }
}
