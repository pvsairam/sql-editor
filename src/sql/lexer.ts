/**
 * Oracle-aware SQL lexing helpers: string literals (including q'[..]' quoting), "quoted identifiers",
 * -- line comments and block comments. The old splitter only understood single quotes, so a `;`
 * inside a comment or an `--` containing an apostrophe broke statement detection.
 */

export type Region = 'code' | 'string' | 'ident' | 'comment';

interface Span {
  start: number;
  end: number; // exclusive
  kind: Exclude<Region, 'code'>;
}

const CLOSERS: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };

/** Locate all non-code spans (strings, quoted identifiers, comments). */
export function scanSpans(sql: string): Span[] {
  const spans: Span[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      let j = sql.indexOf('\n', i);
      if (j < 0) {
        j = n;
      }
      spans.push({ start: i, end: j, kind: 'comment' });
      i = j;
    } else if (c === '/' && next === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      spans.push({ start: i, end: j, kind: 'comment' });
      i = j;
    } else if (c === "'") {
      const isIdent = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$#]/.test(ch);
      let qStart = -1;
      if (i >= 1 && /[qQ]/.test(sql[i - 1]) && !isIdent(sql[i - 2])) {
        qStart = i - 1;
      } else if (i >= 2 && /[qQ]/.test(sql[i - 1]) && /[nN]/.test(sql[i - 2]) && !isIdent(sql[i - 3])) {
        qStart = i - 2;
      }
      const isQ = qStart >= 0;
      if (isQ && i + 2 < n && !/\s/.test(sql[i + 1])) {
        const open = sql[i + 1];
        const close = CLOSERS[open] ?? open;
        let j = sql.indexOf(close + "'", i + 2);
        j = j < 0 ? n : j + 2;
        spans.push({ start: qStart, end: j, kind: 'string' });
        i = j;
      } else {
        let j = i + 1;
        while (j < n) {
          if (sql[j] === "'") {
            if (sql[j + 1] === "'") {
              j += 2;
              continue;
            }
            break;
          }
          j++;
        }
        j = Math.min(n, j + 1);
        spans.push({ start: i, end: j, kind: 'string' });
        i = j;
      }
    } else if (c === '"') {
      let j = sql.indexOf('"', i + 1);
      j = j < 0 ? n : j + 1;
      spans.push({ start: i, end: j, kind: 'ident' });
      i = j;
    } else {
      i++;
    }
  }
  return spans;
}

/** What kind of text the position `offset` (between characters) sits in. */
export function regionAt(sql: string, offset: number): Region {
  for (const s of scanSpans(sql)) {
    if (s.start >= offset) {
      break;
    }
    // inside the span, or at the end of an unterminated one
    const terminated = s.kind === 'comment' ? (sql[s.start + 1] === '-' ? false : sql.slice(s.end - 2, s.end) === '*/') : sql[s.end - 1] === (s.kind === 'ident' ? '"' : "'") && s.end - s.start > 1;
    if (offset < s.end || (offset === s.end && !terminated)) {
      return s.kind;
    }
  }
  return 'code';
}

/** Same-length copy of `sql` where every non-code character (except newlines) becomes a space. */
export function maskNonCode(sql: string): string {
  const chars = sql.split('');
  for (const s of scanSpans(sql)) {
    for (let k = s.start; k < s.end; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') {
        chars[k] = ' ';
      }
    }
  }
  return chars.join('');
}

export function stripSqlComments(sql: string): string {
  let out = '';
  let last = 0;
  for (const s of scanSpans(sql)) {
    if (s.kind === 'comment') {
      out += sql.slice(last, s.start) + ' ';
      last = s.end;
    }
  }
  return out + sql.slice(last);
}

export interface Statement {
  /** Trimmed statement text (without the terminator). */
  text: string;
  /** Offset of the first character of `text`. */
  start: number;
  /** Offset just past the last character of `text`. */
  end: number;
  /** Offset just past the terminator (or `end` if there was none); the cursor "belongs" to the statement up to here. */
  reach: number;
  /** True if the statement contains executable code (not only comments). */
  hasCode: boolean;
}

export interface SplitOptions {
  blankLineEndsStatement?: boolean;
}

/** Split script text into statements on `;`, a lone `/` line and (optionally) blank lines. */
export function splitStatements(sql: string, opts: SplitOptions = {}): Statement[] {
  const masked = maskNonCode(sql);
  const out: Statement[] = [];
  let segStart = 0;

  const push = (segEnd: number, reach: number) => {
    const raw = sql.slice(segStart, segEnd);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length > 0) {
      const start = segStart + lead;
      const hasCode = masked.slice(start, start + text.length).trim().length > 0;
      out.push({ text, start, end: start + text.length, reach, hasCode });
    }
    segStart = reach;
  };

  const n = sql.length;
  let i = 0;
  while (i < n) {
    let lineEnd = sql.indexOf('\n', i);
    if (lineEnd < 0) {
      lineEnd = n;
    }
    const maskedLine = masked.slice(i, lineEnd);

    if (maskedLine.trim() === '/') {
      push(i, lineEnd);
      i = lineEnd + 1;
      continue;
    }
    if (opts.blankLineEndsStatement && sql.slice(i, lineEnd).trim() === '' && sql.slice(segStart, i).trim() !== '') {
      push(i, lineEnd);
      i = lineEnd + 1;
      continue;
    }
    let from = 0;
    for (;;) {
      const semi = maskedLine.indexOf(';', from);
      if (semi < 0) {
        break;
      }
      push(i + semi, i + semi + 1);
      from = semi + 1;
    }
    i = lineEnd + 1;
  }
  push(n, n);
  return out;
}

/**
 * The statement the cursor is in, SQL Developer style. If the cursor sits on whitespace between two
 * statements it picks the one that ends before it (most recently typed).
 */
export function statementAt(sql: string, offset: number, opts: SplitOptions = {}): Statement | undefined {
  const all = splitStatements(sql, opts).filter((s) => s.hasCode);
  if (all.length === 0) {
    return undefined;
  }
  let prev: Statement | undefined;
  for (const s of all) {
    if (offset >= s.start && offset <= s.reach) {
      return s;
    }
    if (offset < s.start) {
      // between prev.reach and s.start: whitespace/comments. Prefer the statement the cursor is closest to.
      if (!prev) {
        return s;
      }
      const gapIsOnPrevLine = !sql.slice(prev.reach, offset).includes('\n');
      return gapIsOnPrevLine ? prev : s;
    }
    prev = s;
  }
  return prev;
}

/** Collapse whitespace and drop comments, for compact one-line display. */
export function oneLine(sql: string, max = 140): string {
  const t = stripSqlComments(sql).replace(/\s+/g, ' ').trim() || sql.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
