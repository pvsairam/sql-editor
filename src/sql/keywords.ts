export const SQL_KEYWORDS: string[] = (
  'SELECT FROM WHERE GROUP BY ORDER HAVING UNION ALL INTERSECT MINUS WITH AS ON USING JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ' +
  'AND OR NOT IN IS NULL LIKE BETWEEN EXISTS CASE WHEN THEN ELSE END DISTINCT ASC DESC NULLS FIRST LAST OVER PARTITION ' +
  'FETCH NEXT ROWS ONLY OFFSET CONNECT START PRIOR LEVEL SIBLINGS FOR UPDATE OF SKIP LOCKED ROWNUM SYSDATE SYSTIMESTAMP DUAL'
).split(' ');

/** [name, snippet body, description] */
export const SQL_FUNCTIONS: [string, string, string][] = [
  ['NVL', 'NVL(${1:expr}, ${2:default})', 'Replace NULL'],
  ['NVL2', 'NVL2(${1:expr}, ${2:if_not_null}, ${3:if_null})', 'Choose by NULL-ness'],
  ['COALESCE', 'COALESCE(${1:a}, ${2:b})', 'First non-NULL'],
  ['DECODE', 'DECODE(${1:expr}, ${2:search}, ${3:result}, ${4:default})', 'Oracle conditional'],
  ['TO_CHAR', "TO_CHAR(${1:value}, '${2:YYYY-MM-DD}')", 'Convert to text'],
  ['TO_DATE', "TO_DATE(${1:text}, '${2:YYYY-MM-DD}')", 'Convert to date'],
  ['TO_NUMBER', 'TO_NUMBER(${1:text})', 'Convert to number'],
  ['TRUNC', 'TRUNC(${1:date_or_number})', 'Truncate'],
  ['ROUND', 'ROUND(${1:number}, ${2:2})', 'Round'],
  ['SUBSTR', 'SUBSTR(${1:text}, ${2:1}, ${3:length})', 'Substring'],
  ['INSTR', 'INSTR(${1:text}, ${2:search})', 'Position of substring'],
  ['REPLACE', "REPLACE(${1:text}, ${2:search}, ${3:replacement})", 'Replace text'],
  ['UPPER', 'UPPER(${1:text})', 'Upper case'],
  ['LOWER', 'LOWER(${1:text})', 'Lower case'],
  ['TRIM', 'TRIM(${1:text})', 'Trim spaces'],
  ['LISTAGG', "LISTAGG(${1:expr}, '${2:, }') WITHIN GROUP (ORDER BY ${3:expr})", 'Concatenate rows'],
  ['ROW_NUMBER', 'ROW_NUMBER() OVER (PARTITION BY ${1:col} ORDER BY ${2:col})', 'Row number'],
  ['RANK', 'RANK() OVER (PARTITION BY ${1:col} ORDER BY ${2:col})', 'Rank'],
  ['DENSE_RANK', 'DENSE_RANK() OVER (PARTITION BY ${1:col} ORDER BY ${2:col})', 'Dense rank'],
  ['LAG', 'LAG(${1:col}) OVER (ORDER BY ${2:col})', 'Previous row value'],
  ['LEAD', 'LEAD(${1:col}) OVER (ORDER BY ${2:col})', 'Next row value'],
  ['SUM', 'SUM(${1:col})', 'Sum'],
  ['COUNT', 'COUNT(${1:*})', 'Count'],
  ['MIN', 'MIN(${1:col})', 'Minimum'],
  ['MAX', 'MAX(${1:col})', 'Maximum'],
  ['AVG', 'AVG(${1:col})', 'Average'],
  ['REGEXP_LIKE', "REGEXP_LIKE(${1:col}, '${2:pattern}')", 'Regular-expression match'],
  ['REGEXP_SUBSTR', "REGEXP_SUBSTR(${1:text}, '${2:pattern}')", 'Regular-expression substring'],
  ['ADD_MONTHS', 'ADD_MONTHS(${1:date}, ${2:1})', 'Add months'],
  ['MONTHS_BETWEEN', 'MONTHS_BETWEEN(${1:d1}, ${2:d2})', 'Months between dates'],
  ['LAST_DAY', 'LAST_DAY(${1:date})', 'Last day of month'],
  ['EXTRACT', 'EXTRACT(${1:YEAR} FROM ${2:date})', 'Extract date part'],
  ['CAST', 'CAST(${1:expr} AS ${2:VARCHAR2(100)})', 'Type cast'],
  ['XMLAGG', 'XMLAGG(${1:expr})', 'Aggregate XML']
];
