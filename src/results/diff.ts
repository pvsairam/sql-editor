import { Table } from './formats';

export interface DiffResult {
  columns: string[];
  rows: string[][];
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  keyColumns: string[];
  summary: string;
}

/** Pick sensible default key column(s) common to both result sets (e.g. *_ID, *_NUMBER, *_CODE, or first shared column). */
export function guessKeyColumns(leftCols: string[], rightCols: string[]): string[] {
  const rightSet = new Set(rightCols.map((c) => c.toUpperCase()));
  const shared = leftCols.filter((c) => rightSet.has(c.toUpperCase()));
  if (shared.length === 0) {
    return [];
  }
  const idLike = shared.find((c) => /(?:^ID$|_ID$|_NUM$|_NUMBER$|_CODE$|_KEY$|_NAME$)/i.test(c));
  return [idLike ?? shared[0]];
}

/**
 * Compare two query result tables (e.g. [DEV] vs [PROD]) and produce a unified diff table
 * suitable for display, filtering, sorting, and Excel/CSV export in the Results panel.
 */
export function diffTables(
  left: Table,
  right: Table,
  opts: { leftLabel?: string; rightLabel?: string; keyColumns?: string[]; includeUnchanged?: boolean } = {}
): DiffResult {
  const unionCols: string[] = [...left.columns];
  const seenUpper = new Set(left.columns.map((c) => c.toUpperCase()));
  for (const c of right.columns) {
    if (!seenUpper.has(c.toUpperCase())) {
      unionCols.push(c);
      seenUpper.add(c.toUpperCase());
    }
  }

  const leftIdx = new Map<string, number>();
  left.columns.forEach((c, i) => leftIdx.set(c.toUpperCase(), i));
  const rightIdx = new Map<string, number>();
  right.columns.forEach((c, i) => rightIdx.set(c.toUpperCase(), i));

  const keys = (opts.keyColumns && opts.keyColumns.length ? opts.keyColumns : guessKeyColumns(left.columns, right.columns)).filter(
    (k) => leftIdx.has(k.toUpperCase()) && rightIdx.has(k.toUpperCase())
  );

  const rowKey = (row: string[], idxMap: Map<string, number>, rowNum: number): string => {
    if (keys.length === 0) {
      return `#${rowNum}`;
    }
    return keys.map((k) => row[idxMap.get(k.toUpperCase())!] ?? '').join('\u001f');
  };

  // Preserve multiplicity for duplicate keys via occurrence suffix
  const buildMap = (rows: string[][], idxMap: Map<string, number>) => {
    const out = new Map<string, string[]>();
    const counts = new Map<string, number>();
    rows.forEach((r, i) => {
      const base = rowKey(r, idxMap, i);
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      out.set(n === 1 ? base : `${base}\u001e${n}`, r);
    });
    return out;
  };

  const leftMap = buildMap(left.rows, leftIdx);
  const rightMap = buildMap(right.rows, rightIdx);

  const diffRows: string[][] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  for (const [k, lRow] of leftMap.entries()) {
    const rRow = rightMap.get(k);
    if (!rRow) {
      removed++;
      const vals = unionCols.map((c) => {
        const i = leftIdx.get(c.toUpperCase());
        return i !== undefined ? (lRow[i] ?? '') : '';
      });
      diffRows.push(['REMOVED (-)', ...vals]);
    } else {
      let differs = false;
      const vals = unionCols.map((c) => {
        const li = leftIdx.get(c.toUpperCase());
        const ri = rightIdx.get(c.toUpperCase());
        const lv = li !== undefined ? (lRow[li] ?? '') : '';
        const rv = ri !== undefined ? (rRow[ri] ?? '') : '';
        if (lv !== rv) {
          differs = true;
          return `${lv || '(empty)'} → ${rv || '(empty)'}`;
        }
        return lv;
      });
      if (differs) {
        changed++;
        diffRows.push(['CHANGED (~)', ...vals]);
      } else {
        unchanged++;
        if (opts.includeUnchanged) {
          diffRows.push(['SAME (=)', ...vals]);
        }
      }
    }
  }

  for (const [k, rRow] of rightMap.entries()) {
    if (!leftMap.has(k)) {
      added++;
      const vals = unionCols.map((c) => {
        const i = rightIdx.get(c.toUpperCase());
        return i !== undefined ? (rRow[i] ?? '') : '';
      });
      diffRows.push(['ADDED (+)', ...vals]);
    }
  }

  const labelL = opts.leftLabel ?? 'Left';
  const labelR = opts.rightLabel ?? 'Right';
  const keyInfo = keys.length ? ` by ${keys.join(', ')}` : ' by row order';
  const summary = `Diff ${labelL} → ${labelR}${keyInfo}: ${added} added, ${removed} removed, ${changed} changed, ${unchanged} unchanged`;

  return {
    columns: ['_DIFF', ...unionCols],
    rows: diffRows,
    added,
    removed,
    changed,
    unchanged,
    keyColumns: keys,
    summary
  };
}
