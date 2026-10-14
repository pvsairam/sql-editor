/**
 * Pre-flight for a statement before it is sent to BI Publisher.
 *
 * BI Publisher can only open a cursor over a query, so DML/DDL/PL-SQL cannot run. We reject those
 * with a clear message (the old build surfaced a cryptic ORA-00900), and translate the SQL*Plus /
 * SQL Developer `DESC <object>` shortcut into a dictionary query.
 */
import { FusionError } from '../fusion/errors';
import { maskNonCode, stripSqlComments } from './lexer';

export interface PreparedStatement {
  sql: string;
  /** Original text, shown in history. */
  original: string;
  /** True if rewritten from a shortcut such as DESC. */
  rewritten: boolean;
}

const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK',
  'BEGIN', 'DECLARE', 'CALL', 'EXEC', 'EXECUTE', 'LOCK', 'RENAME', 'COMMENT', 'ANALYZE', 'SAVEPOINT', 'SET'
]);

export function firstKeyword(sql: string): string {
  const m = /^\s*([A-Za-z]+)/.exec(stripSqlComments(sql));
  return m ? m[1].toUpperCase() : '';
}

/** Remove trailing statement terminators (";" and a lone "/"). */
export function stripTerminators(sql: string): string {
  let s = sql.trim();
  for (;;) {
    const next = s.replace(/(?:\n\s*\/\s*|[\s;])+$/, '').trim();
    if (next === s) {
      return s;
    }
    s = next;
  }
}

export function prepareStatement(rawSql: string): PreparedStatement {
  const original = rawSql;
  const sql = stripTerminators(rawSql);
  if (!stripSqlComments(sql).trim()) {
    throw new FusionError('config', 'Nothing to run: the statement is empty.');
  }
  const kw = firstKeyword(sql);

  if (kw === 'DESC' || kw === 'DESCRIBE') {
    const m = /^\s*DESC(?:RIBE)?\s+(?:([A-Za-z0-9_$#]+)\.)?([A-Za-z0-9_$#]+)\s*$/i.exec(stripSqlComments(sql));
    if (!m) {
      throw new FusionError('config', 'Usage: DESC <table_or_view>  (optionally OWNER.NAME)');
    }
    const owner = m[1] ? `AND owner = '${m[1].toUpperCase()}'` : '';
    return {
      original,
      rewritten: true,
      sql:
        `SELECT column_id AS "#", column_name AS "NAME", CASE WHEN nullable = 'N' THEN 'NOT NULL' END AS "NULL?",\n` +
        `       data_type || CASE WHEN data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR') THEN '(' || char_length || ')'\n` +
        `                         WHEN data_type = 'NUMBER' AND data_precision IS NOT NULL THEN '(' || data_precision || CASE WHEN data_scale > 0 THEN ',' || data_scale END || ')' END AS "TYPE",\n` +
        `       owner AS "OWNER"\n` +
        `FROM all_tab_columns\nWHERE table_name = '${m[2].toUpperCase()}' ${owner}\nORDER BY owner, column_id`
    };
  }

  if (WRITE_KEYWORDS.has(kw)) {
    throw new FusionError('unsupported', `"${kw}" statements cannot be run: Oracle BI Publisher only executes read-only queries (SELECT / WITH).`, {
      hint: 'Fusion Cloud does not allow DML, DDL or PL/SQL through BI Publisher. Use the Fusion UI, FBDI or REST APIs for changes.'
    });
  }
  if (kw !== 'SELECT' && kw !== 'WITH' && !sql.trimStart().startsWith('(')) {
    throw new FusionError('unsupported', `Only SELECT / WITH queries can be run (found "${kw || sql.slice(0, 12)}").`);
  }
  return { sql, original, rewritten: false };
}

/** Wrap a query so that only `limit` rows starting at `offset` come back. */
export function wrapForPaging(sql: string, offset: number, limit: number): string {
  return `SELECT * FROM (\n${sql}\n) fusion_sql_page\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

const BIND_RE = () => /(?<![:\w$#]):([A-Za-z0-9_][A-Za-z0-9_$#]*)\b/g;

/** Find `:name` / `:1` bind variables outside strings/comments, in order of first appearance. */
export function findBinds(sql: string): string[] {
  const masked = maskNonCode(sql);
  const seen: string[] = [];
  const re = BIND_RE();
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (!seen.includes(m[1].toUpperCase())) {
      seen.push(m[1].toUpperCase());
    }
  }
  return seen;
}

export interface TypedBind {
  value: string;
  isNull?: boolean;
  type?: 'VARCHAR2' | 'NUMBER' | 'DATE' | 'TIMESTAMP';
}

/** Substitute bind values as literals. Plain strings are typed by guessing (see `literal`); TypedBind is exact. */
export function applyBinds(sql: string, values: Record<string, string | TypedBind>): string {
  const masked = maskNonCode(sql);
  const re = BIND_RE();
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const v = values[m[1].toUpperCase()];
    if (v === undefined) {
      continue;
    }
    out += sql.slice(last, m.index) + (typeof v === 'string' ? literal(v) : typedLiteral(v));
    last = m.index + m[0].length;
  }
  return out + sql.slice(last);
}

export function typedLiteral(b: TypedBind): string {
  if (b.isNull) {
    return 'NULL';
  }
  const v = b.value.trim();
  switch (b.type ?? 'VARCHAR2') {
    case 'NUMBER':
      if (!/^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(v)) {
        throw new FusionError('config', `"${b.value}" is not a valid NUMBER bind value.`);
      }
      return v;
    case 'DATE':
    case 'TIMESTAMP': {
      const fn = b.type === 'DATE' ? 'TO_DATE' : 'TO_TIMESTAMP';
      const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?$/.exec(v);
      if (iso) {
        const time = iso[2] ? (iso[2].length === 5 ? iso[2] + ':00' : iso[2]) : '00:00:00';
        return `${fn}('${iso[1]} ${time}', 'YYYY-MM-DD HH24:MI:SS')`;
      }
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
      if (us) {
        return `${fn}('${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')} 00:00:00', 'YYYY-MM-DD HH24:MI:SS')`;
      }
      throw new FusionError('config', `"${b.value}" is not a valid ${b.type} (use YYYY-MM-DD or YYYY-MM-DD HH:MI:SS).`);
    }
    default:
      return `'${b.value.replace(/'/g, "''")}'`;
  }
}

export function literal(v: string): string {
  const t = v.trim();
  if (/^null$/i.test(t)) {
    return 'NULL';
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return t;
  }
  if (/^(?:date|timestamp)\s+'[^']*'$/i.test(t) || /^(?:sysdate|systimestamp|current_date)$/i.test(t) || /^to_(?:date|timestamp|number)\s*\(.*\)$/i.test(t)) {
    return t;
  }
  return `'${v.replace(/'/g, "''")}'`;
}
