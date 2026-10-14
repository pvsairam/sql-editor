/**
 * A pragmatic SQL formatter for Oracle queries (SELECT / WITH). It only changes whitespace and
 * keyword case; string literals, quoted identifiers and comments are preserved byte for byte.
 */
import { scanSpans } from './lexer';

export interface FormatOptions {
  indent: number;
  keywordCase: 'upper' | 'lower' | 'preserve';
}

type Tok = { t: 'word' | 'num' | 'str' | 'ident' | 'lcomment' | 'bcomment' | 'op' | 'open' | 'close' | 'comma' | 'semi'; v: string };

const KEYWORDS = new Set(
  (
    'SELECT FROM WHERE GROUP BY ORDER HAVING UNION ALL INTERSECT MINUS EXCEPT WITH AS ON USING JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ' +
    'AND OR NOT IN IS NULL LIKE BETWEEN EXISTS CASE WHEN THEN ELSE END DISTINCT UNIQUE ASC DESC NULLS FIRST LAST OVER PARTITION ROWS RANGE ' +
    'UNBOUNDED PRECEDING FOLLOWING CURRENT ROW FETCH NEXT ONLY OFFSET CONNECT START PRIOR LEVEL SIBLINGS CAST INTERVAL FOR UPDATE OF SKIP LOCKED ' +
    'KEEP DENSE_RANK WITHIN LATERAL APPLY PIVOT UNPIVOT MODEL ESCAPE ANY SOME DAY MONTH YEAR HOUR MINUTE SECOND TO AT TIME ZONE'
  ).split(' ')
);

const CALL_KEYWORDS = new Set(['CAST', 'DENSE_RANK', 'KEEP', 'NVL', 'EXTRACT']);
const JOIN_STARTERS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER']);

function tokenize(sql: string): Tok[] {
  const spans = scanSpans(sql);
  const toks: Tok[] = [];
  let i = 0;
  let si = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const span = spans[si];
    if (span && span.start === i) {
      const text = sql.slice(span.start, span.end);
      toks.push({ t: span.kind === 'comment' ? (text.startsWith('--') ? 'lcomment' : 'bcomment') : span.kind === 'ident' ? 'ident' : 'str', v: text });
      i = span.end;
      si++;
      continue;
    }
    if (span && span.start < i) {
      si++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$#]/.test(sql[j])) {
        j++;
      }
      toks.push({ t: 'word', v: sql.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j])) {
        if ((sql[j] === 'e' || sql[j] === 'E') && /[+-]/.test(sql[j + 1] ?? '')) {
          j++;
        }
        j++;
      }
      toks.push({ t: 'num', v: sql.slice(i, j) });
      i = j;
    } else if (c === '(') {
      toks.push({ t: 'open', v: c });
      i++;
    } else if (c === ')') {
      toks.push({ t: 'close', v: c });
      i++;
    } else if (c === ',') {
      toks.push({ t: 'comma', v: c });
      i++;
    } else if (c === ';') {
      toks.push({ t: 'semi', v: c });
      i++;
    } else {
      // operator run (keeps :=, ||, <=, >=, <>, !=, =>, .., and bind markers like :name together)
      let j = i + 1;
      if (c === ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
        while (j < n && /[A-Za-z0-9_$#]/.test(sql[j])) {
          j++;
        }
      } else if (c !== '.' && c !== '@') {
        while (j < n && /[<>=!|*/+\-&%^~?:]/.test(sql[j]) && !(sql[j] === '-' && sql[j + 1] === '-') && !(sql[j] === '/' && sql[j + 1] === '*')) {
          j++;
        }
      }
      toks.push({ t: 'op', v: sql.slice(i, j) });
      i = j;
    }
  }
  return toks;
}

export function formatSql(sql: string, opts: FormatOptions): string {
  const toks = tokenize(sql);
  const pad = (lvl: number) => ' '.repeat(Math.max(0, lvl) * opts.indent);
  const kw = (v: string) => (opts.keywordCase === 'upper' ? v.toUpperCase() : opts.keywordCase === 'lower' ? v.toLowerCase() : v);

  interface Frame {
    base: number; // indent level of the clause keywords inside this paren group
    sub: boolean; // subquery group
    clause: string;
    lineBroken: boolean;
  }
  const stack: Frame[] = [{ base: 0, sub: true, clause: '', lineBroken: true }];
  let out = '';
  let atLineStart = true;
  let prev: Tok | undefined;

  const top = () => stack[stack.length - 1];
  const newline = (lvl: number) => {
    // Never emit blank lines: if we are already at the start of a line, only fix the indentation.
    out = out.replace(/[ \t]+$/, '') + (atLineStart ? '' : '\n') + pad(lvl);
    atLineStart = true;
  };
  let glue = false; // suppress the space before the next emitted token (after '.', '@' or a unary sign)
  const emit = (s: string, spaceBefore = true) => {
    if (!atLineStart && spaceBefore && !glue && out.length && !/[\s(]$/.test(out)) {
      out += ' ';
    }
    glue = false;
    out += s;
    atLineStart = false;
  };

  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    const next = toks[k + 1];
    const up = tk.t === 'word' ? tk.v.toUpperCase() : '';
    const f = top();

    switch (tk.t) {
      case 'lcomment': {
        emit(tk.v);
        newline(f.clause ? f.base + 1 : f.base);
        break;
      }
      case 'bcomment':
        emit(tk.v);
        break;
      case 'open': {
        const isSub = next?.t === 'word' && /^(SELECT|WITH)$/i.test(next.v);
        const callLike = prev !== undefined && (prev.t === 'ident' || (prev.t === 'word' && (!KEYWORDS.has(prev.v.toUpperCase()) || CALL_KEYWORDS.has(prev.v.toUpperCase()))));
        emit('(', !callLike);
        if (isSub) {
          const base = f.base + 1 + (f.clause === 'select' || f.clause === 'from' || f.clause === 'where' || f.clause === 'having' || f.clause === 'with' ? 1 : 0);
          stack.push({ base, sub: true, clause: '', lineBroken: false });
          newline(base);
        } else {
          stack.push({ base: f.base, sub: false, clause: f.clause, lineBroken: false });
        }
        break;
      }
      case 'close': {
        const closing = stack.length > 1 ? stack.pop()! : f;
        if (closing.sub && stack.length >= 1) {
          newline(closing.base - 1);
        }
        if (!atLineStart) {
          out = out.replace(/[ \t]+$/, '');
        }
        emit(')', false);
        break;
      }
      case 'comma': {
        out = out.replace(/[ \t]+$/, '');
        out += ',';
        atLineStart = false;
        if (f.sub && (f.clause === 'select' || f.clause === 'groupby' || f.clause === 'orderby' || f.clause === 'from' || f.clause === 'set' || f.clause === 'with')) {
          newline(f.base + 1);
        }
        break;
      }
      case 'semi':
        out = out.replace(/[ \t]+$/, '');
        out += ';';
        atLineStart = false;
        break;
      case 'word': {
        const word = KEYWORDS.has(up) ? kw(tk.v) : tk.v;
        const secondUp = next?.t === 'word' ? next.v.toUpperCase() : '';
        if (f.sub) {
          // clause starters
          if (up === 'SELECT') {
            if (!atLineStart || out.trim() !== '') {
              if (!(prev?.t === 'open')) {
                newline(f.base);
              }
            }
            emit(word, false);
            f.clause = 'select';
            const nx = secondUp;
            if (nx === 'DISTINCT' || nx === 'ALL' || nx === 'UNIQUE') {
              emit(kw(next!.v));
              k++;
            }
            newline(f.base + 1);
            prev = tk;
            continue;
          }
          if (up === 'WITH' && !prev) {
            emit(word, false);
            f.clause = 'with';
            newline(f.base + 1);
            prev = tk;
            continue;
          }
          if (up === 'FROM' && f.clause !== 'extract') {
            newline(f.base);
            emit(word, false);
            f.clause = 'from';
            newline(f.base + 1);
            prev = tk;
            continue;
          }
          if (up === 'WHERE') {
            newline(f.base);
            emit(word, false);
            f.clause = 'where';
            newline(f.base + 1);
            prev = tk;
            continue;
          }
          if ((up === 'GROUP' || up === 'ORDER') && secondUp === 'BY') {
            newline(f.base);
            emit(word, false);
            emit(kw(next!.v));
            k++;
            f.clause = up === 'GROUP' ? 'groupby' : 'orderby';
            newline(f.base + 1);
            prev = next;
            continue;
          }
          if (up === 'HAVING') {
            newline(f.base);
            emit(word, false);
            f.clause = 'having';
            newline(f.base + 1);
            prev = tk;
            continue;
          }
          if (up === 'UNION' || up === 'INTERSECT' || up === 'MINUS' || up === 'EXCEPT') {
            newline(f.base);
            emit(word, false);
            if (secondUp === 'ALL') {
              emit(kw(next!.v));
              k++;
            }
            newline(f.base);
            f.clause = '';
            prev = tk;
            continue;
          }
          if (f.clause === 'from' && JOIN_STARTERS.has(up) && !(prev?.t === 'word' && JOIN_STARTERS.has(prev.v.toUpperCase()))) {
            newline(f.base + 1);
            emit(word, false);
            prev = tk;
            continue;
          }
          if (up === 'ON' && f.clause === 'from') {
            newline(f.base + 2);
            emit(word, false);
            prev = tk;
            continue;
          }
          if ((up === 'AND' || up === 'OR') && (f.clause === 'where' || f.clause === 'having' || f.clause === 'from') && !(prev?.t === 'word' && prev.v.toUpperCase() === 'BETWEEN')) {
            // keep "x BETWEEN a AND b" together
            const between = lastBetweenOpen(toks, k);
            if (!between) {
              newline(f.base + (f.clause === 'from' ? 3 : 1));
              emit(word, false);
              prev = tk;
              continue;
            }
          }
          if ((up === 'CONNECT' || up === 'START') && secondUp !== '') {
            newline(f.base);
            emit(word, false);
            prev = tk;
            continue;
          }
          if (up === 'OFFSET' || up === 'FETCH') {
            newline(f.base);
            emit(word, false);
            prev = tk;
            continue;
          }
        }
        emit(word);
        break;
      }
      case 'str':
      case 'ident':
      case 'num':
        emit(tk.v);
        break;
      case 'op': {
        const unary = (tk.v === '-' || tk.v === '+') && (!prev || prev.t === 'op' || prev.t === 'comma' || prev.t === 'open' || (prev.t === 'word' && KEYWORDS.has(prev.v.toUpperCase())));
        if (tk.v === '.' || tk.v === '@') {
          out = out.replace(/[ \t]+$/, '');
          out += tk.v;
          atLineStart = false;
          glue = true;
        } else if (unary) {
          emit(tk.v);
          glue = true;
        } else if (tk.v === '*' && (prev?.t === 'open' || prev?.t === 'comma' || (prev?.t === 'word' && /^(SELECT|DISTINCT|ALL|UNIQUE)$/i.test(prev.v)) || (atLineStart && f.clause === 'select'))) {
          emit('*');
        } else {
          emit(tk.v);
        }
        break;
      }
    }
    prev = tk;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** True if the nearest unmatched BETWEEN before token k has not yet seen its AND. */
function lastBetweenOpen(toks: Tok[], k: number): boolean {
  let depth = 0;
  for (let i = k - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.t === 'close') {
      depth++;
    } else if (t.t === 'open') {
      if (depth === 0) {
        return false;
      }
      depth--;
    } else if (depth === 0 && t.t === 'word') {
      const u = t.v.toUpperCase();
      if (u === 'BETWEEN') {
        return true;
      }
      if (u === 'AND' || u === 'OR' || u === 'WHERE' || u === 'ON' || u === 'HAVING') {
        return false;
      }
    }
  }
  return false;
}
