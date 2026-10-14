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

/** Find `:name` bind variables outside strings/comments, in order of first appearance. */
export function findBinds(sql: string): string[] {
  const masked = maskNonCode(sql);
  const seen: string[] = [];
  const re = /(?<![:\w$#]):([A-Za-z_][A-Za-z0-9_$#]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (!seen.includes(m[1].toUpperCase())) {
      seen.push(m[1].toUpperCase());
    }
  }
  return seen;
}

/** Substitute bind values as literals. Values are typed: numbers stay bare, NULL stays NULL, others are quoted. */
export function applyBinds(sql: string, values: Record<string, string>): string {
  const masked = maskNonCode(sql);
  const re = /(?<![:\w$#]):([A-Za-z_][A-Za-z0-9_$#]*)\b/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const v = values[m[1].toUpperCase()];
    if (v === undefined) {
      continue;
    }
    out += sql.slice(last, m.index) + literal(v);
    last = m.index + m[0].length;
  }
  return out + sql.slice(last);
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
