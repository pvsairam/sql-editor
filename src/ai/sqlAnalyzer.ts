import { maskNonCode, stripSqlComments } from '../sql/lexer';
import { findBinds, stripTerminators } from '../sql/prepare';

export interface SqlWarning {
  severity: 'warning' | 'info';
  code: string;
  message: string;
  suggestion: string;
}

const HIGH_VOLUME_TABLES: Record<string, string[]> = {
  GL_BALANCES: ['LEDGER_ID', 'PERIOD_NAME', 'CODE_COMBINATION_ID'],
  XLA_AE_LINES: ['AE_HEADER_ID', 'LEDGER_ID', 'ACCOUNTING_DATE', 'CODE_COMBINATION_ID'],
  XLA_AE_HEADERS: ['LEDGER_ID', 'ACCOUNTING_DATE', 'PERIOD_NAME', 'ENTITY_ID', 'EVENT_ID'],
  INV_MATERIAL_TXNS: ['ORGANIZATION_ID', 'TRANSACTION_DATE', 'INVENTORY_ITEM_ID', 'TRANSACTION_ID'],
  AP_INVOICE_DISTRIBUTIONS_ALL: ['INVOICE_ID', 'ACCOUNTING_DATE', 'ORG_ID', 'SET_OF_BOOKS_ID'],
  RA_CUST_TRX_LINE_GL_DIST_ALL: ['CUSTOMER_TRX_ID', 'GL_DATE', 'ORG_ID', 'SET_OF_BOOKS_ID'],
  GL_JE_LINES: ['JE_HEADER_ID', 'LEDGER_ID', 'PERIOD_NAME', 'EFFECTIVE_DATE']
};

/**
 * Strictly checks whether a SQL statement is read-only (SELECT or WITH ... SELECT).
 * Rejects DML, DDL, PL/SQL, EXECUTE, CALL, GRANT, REVOKE, etc.
 */
export function isReadOnlySql(raw: string): boolean {
  const cleaned = stripTerminators(raw);
  const code = stripSqlComments(cleaned).trim();
  if (!code) {
    return false;
  }
  const head = /^(\w+)/i.exec(code)?.[1]?.toUpperCase() ?? '';
  if (head !== 'SELECT' && head !== 'WITH') {
    return false;
  }
  const masked = maskNonCode(cleaned).toUpperCase();
  if (/\b(?:INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXECUTE|CALL|BEGIN|DECLARE|COMMIT|ROLLBACK)\b/.test(masked)) {
    return false;
  }
  if (head === 'WITH' && !/\bSELECT\b/.test(masked)) {
    return false;
  }
  return true;
}

/** Static safety analysis for Oracle Fusion Cloud SQL (read-only heuristics, zero network calls). */
export function analyzeFusionSql(raw: string): SqlWarning[] {
  const warnings: SqlWarning[] = [];
  const masked = maskNonCode(raw).toUpperCase();
  if (!masked.trim()) {
    return warnings;
  }

  const hasWhere = /\bWHERE\b/.test(masked);
  const hasRowLimit = /\b(?:ROWNUM\s*<=?|FETCH\s+(?:FIRST|NEXT)\s+\d+)/.test(masked);

  // Extract referenced tables (FROM / JOIN)
  const tableRe = /\b(?:FROM|JOIN)\s+(?:[A-Z0-9_$#]+\.)?([A-Z_][A-Z0-9_$#]*)/g;
  const tables = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(masked)) !== null) {
    tables.add(m[1]);
  }

  // 1. High-volume Fusion tables without selective filters
  for (const t of tables) {
    const recommended = HIGH_VOLUME_TABLES[t];
    if (!recommended) {
      continue;
    }
    const hasSelective = recommended.some((col) => new RegExp(`\\b${col}\\b`).test(masked));
    if (!hasWhere) {
      warnings.push({
        severity: 'warning',
        code: 'UNRESTRICTED_LARGE_TABLE',
        message: `${t} is a very large Oracle Fusion table and is queried without a WHERE clause.`,
        suggestion: `Filter by ${recommended.slice(0, 3).join(', ')} (or add FETCH FIRST n ROWS ONLY while exploring).`
      });
    } else if (!hasSelective && !hasRowLimit) {
      warnings.push({
        severity: 'warning',
        code: 'BROAD_LARGE_TABLE_SCAN',
        message: `${t} is queried without common selective filters (${recommended.slice(0, 3).join(' / ')}).`,
        suggestion: `Add indexed predicates such as ${recommended.slice(0, 2).join(' and ')} to avoid BI Publisher timeouts.`
      });
    }
  }

  // 2. Date-effective HCM/Fusion tables (_F, _M) without effective date bounds
  const effectiveTables = [...tables].filter((t) => /(?:_F|_M)$/.test(t) || t === 'PER_ALL_PEOPLE_F' || t === 'PER_ALL_ASSIGNMENTS_M');
  if (effectiveTables.length > 0 && (!/\bEFFECTIVE_START_DATE\b/.test(masked) || !/\bEFFECTIVE_END_DATE\b/.test(masked))) {
    warnings.push({
      severity: 'warning',
      code: 'MISSING_EFFECTIVE_DATE',
      message: `Date-effective table(s) ${effectiveTables.slice(0, 3).join(', ')} referenced without EFFECTIVE_START_DATE / EFFECTIVE_END_DATE filter.`,
      suggestion: `Add: TRUNC(SYSDATE) BETWEEN alias.effective_start_date AND alias.effective_end_date`
    });
  }

  // 3. Translated _TL tables without LANGUAGE filter
  const tlTables = [...tables].filter((t) => /_TL$/.test(t));
  if (tlTables.length > 0 && !/\bLANGUAGE\b/.test(masked)) {
    warnings.push({
      severity: 'info',
      code: 'MISSING_LANGUAGE_FILTER',
      message: `Translation table(s) ${tlTables.slice(0, 3).join(', ')} referenced without a LANGUAGE filter (may duplicate rows across installed languages).`,
      suggestion: `Add: alias.language = USERENV('LANG') (or 'US').`
    });
  }

  // 4. SELECT * without row limit on non-DUAL tables
  if (/\bSELECT\s+\*/.test(masked) && !hasRowLimit && ![...tables].every((t) => t === 'DUAL')) {
    warnings.push({
      severity: 'info',
      code: 'SELECT_STAR_UNBOUNDED',
      message: 'SELECT * without a row limit can return very wide Fusion tables and slow down BI Publisher.',
      suggestion: 'Select explicit columns or add FETCH FIRST 100 ROWS ONLY.'
    });
  }

  return warnings;
}

/** Replace :bind placeholders outside strings/comments with NULL so read-only validation can execute safely. */
export function neutralizeBindsForValidation(sql: string): string {
  const names = findBinds(sql);
  if (names.length === 0) {
    return sql;
  }
  const masked = maskNonCode(sql);
  let out = '';
  let last = 0;
  const re = /(^|[^:\w$#]):([A-Za-z_][A-Za-z0-9_$#]*|[0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const start = m.index + m[1].length;
    const end = start + 1 + m[2].length;
    out += sql.slice(last, start) + 'NULL';
    last = end;
  }
  return out + sql.slice(last);
}

/** Wrap a read-only query to fetch at most `sampleRows` rows for live validation. */
export function wrapValidationQuery(sql: string, mode: 'rownum' | 'fetch' = 'rownum', sampleRows = 25): string {
  const clean = stripTerminators(sql).trim();
  if (mode === 'fetch') {
    return `${clean}\nFETCH FIRST ${sampleRows} ROWS ONLY`;
  }
  return `SELECT * FROM (\n${clean}\n) WHERE ROWNUM <= ${sampleRows}`;
}

/** Extract the first ```sql ... ``` fenced block from an LLM response. */
export function extractSqlBlock(text: string): string | undefined {
  const m = /```sql\s*([\s\S]*?)```/i.exec(text) ?? /```\s*(SELECT[\s\S]*?|WITH[\s\S]*?)```/i.exec(text);
  return m?.[1]?.trim();
}
