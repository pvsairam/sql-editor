import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatSql } from '../src/sql/format';
import { render, subset, toInList, toInserts, toJson, toMarkdown, toTsv, guessTableName, numericColumns, Table } from '../src/results/formats';
import { buildXlsx, colName, excelSerial } from '../src/results/xlsx';
import { readZip } from '../src/fusion/zip';

const opts = { indent: 2, keywordCase: 'upper' as const };
const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

const SAMPLES = [
  'select 1 from dual',
  "select p.person_number, n.full_name from per_all_people_f p join per_person_names_f n on p.person_id=n.person_id and n.name_type='GLOBAL' where sysdate between p.effective_start_date and p.effective_end_date order by 1,2 desc",
  'with x as (select 1 a from dual), y as (select 2 b from dual) select * from x, y where x.a < y.b',
  "select a, -b, +c, d*e, f/g, h||'x', 'it''s' q, q'[a;b]' z, :bind from t where a not between 1 and 5 and b in (select b from u where u.c = 'x') -- tail\n union all select 1,2,3,4,5,6,7,8,9 from dual",
  'select count(*) over (partition by a order by b rows between unbounded preceding and current row) from t',
  'select /*+ parallel(4) */ distinct a from t a left outer join u b on (a.id = b.id(+)) where exists (select 1 from v where v.id=a.id) group by a having count(*)>1 fetch first 10 rows only',
  'select case when a=1 then \'x\' when a=2 then \'y\' else \'z\' end as c, cast(b as varchar2(10)), extract(year from d), nvl2(a,b,c) from t connect by prior id = parent_id start with parent_id is null',
  'select "Quoted Col", t."X" from "My Table" t where t.a@dblink = 1',
  'select a from t where a > 1.5e10 and b < .5 and c = -1'
];

test('formatter only changes whitespace and keyword case (token stream preserved)', () => {
  for (const s of SAMPLES) {
    const out = formatSql(s, opts);
    assert.equal(squash(out), squash(s), `changed tokens:\n${s}\n=>\n${out}`);
  }
});

test('formatter is idempotent and never emits blank lines', () => {
  for (const s of SAMPLES) {
    const once = formatSql(s, opts);
    assert.equal(formatSql(once, opts), once, `not idempotent:\n${once}`);
    assert.ok(!/\n\s*\n/.test(once), `blank line in:\n${once}`);
  }
});

test('formatter layout for a typical Fusion query', () => {
  const out = formatSql("select a.x, b.y from t1 a join t2 b on a.id=b.id and b.k='Z' where a.f = 1 and a.g between 1 and 2 order by 1", opts);
  assert.equal(
    out,
    ['SELECT', '  a.x,', '  b.y', 'FROM', '  t1 a', '  JOIN t2 b', '    ON a.id = b.id', '      AND b.k = \'Z\'', 'WHERE', '  a.f = 1', '  AND a.g BETWEEN 1 AND 2', 'ORDER BY', '  1', ''].join('\n')
  );
});

test('formatter honours keyword case and keeps strings/comments untouched', () => {
  const out = formatSql("select 'from where' as x /* select */ from dual -- order by", { indent: 4, keywordCase: 'lower' });
  assert.match(out, /^select\n {4}'from where' as x \/\* select \*\/\nfrom\n {4}dual -- order by\n$/);
});

const T: Table = { columns: ['ID', 'NAME', 'AMT', 'D'], rows: [['1', 'Ann', '10.50', '2024-01-02T03:04:05.000+00:00'], ['2', "O'Brien", '', '2024-02-03T00:00:00.000+00:00'], ['3', 'multi\nline', '-3', '']] };

test('copy/export serialisations', () => {
  assert.equal(toTsv(T, true).split('\n')[0], 'ID\tNAME\tAMT\tD');
  assert.equal(toTsv({ columns: ['a'], rows: [['x\ty']] }, false), '"x\ty"');
  assert.deepEqual(JSON.parse(toJson(T)), [
    { ID: 1, NAME: 'Ann', AMT: 10.5, D: '2024-01-02T03:04:05.000+00:00' },
    { ID: 2, NAME: "O'Brien", AMT: null, D: '2024-02-03T00:00:00.000+00:00' },
    { ID: 3, NAME: 'multi\nline', AMT: -3, D: null }
  ]);
  assert.equal(toMarkdown(subset(T, [1], [0, 1])), "| ID | NAME |\n| ---: | --- |\n| 2 | O'Brien |");
  assert.equal(toInserts(subset(T, [0, 1], [0, 1, 3]), 'T1').split('\n')[1], "INSERT INTO T1 (ID, NAME, D) VALUES (2, 'O''Brien', TO_TIMESTAMP('2024-02-03 00:00:00', 'YYYY-MM-DD HH24:MI:SS'));");
  assert.equal(toInList(subset(T, null, [1])), "'Ann', 'O''Brien', 'multi\nline'");
  assert.equal(toInList(subset(T, null, [0])), '1, 2, 3');
  assert.deepEqual(numericColumns(T), [true, false, true, false]);
  assert.equal(guessTableName('select * from per_all_people_f p where 1=1'), 'per_all_people_f');
  assert.equal(guessTableName('select * from (select 1 x)'), 'TABLE_NAME');
  assert.equal(render(T, 'csv', { headers: false, delimiter: ';' }).split('\r\n')[0], '1;Ann;10.50;2024-01-02T03:04:05.000+00:00');
});

test('xlsx: valid package with typed cells, escaped text and Excel date serials', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(701), 'ZZ');
  assert.equal(colName(702), 'AAA');
  assert.equal(excelSerial(1970, 1, 1), 25569);
  assert.equal(excelSerial(2024, 1, 2, 12), 45293.5);
  const zip = readZip(buildXlsx({ columns: ['a&b', 'n', 'd'], rows: [['<x>\u0001"q"', '1', '2024-01-02T00:00:00.000Z'], ['z', '2.5', '']] }, 'We:ird/Name'));
  const files = Object.fromEntries(zip.map((e) => [e.name, e.data.toString('utf8')]));
  assert.ok(files['[Content_Types].xml'] && files['xl/workbook.xml'] && files['xl/styles.xml']);
  assert.match(files['xl/workbook.xml'], /<sheet name="We ird Name"/);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<t>a&amp;b<\/t>/);
  assert.match(sheet, /&lt;x&gt;&quot;q&quot;/);
  assert.ok(!sheet.includes('\u0001'));
  assert.match(sheet, /<c r="B2"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="C2" s="2"><v>45293<\/v><\/c>/);
  assert.match(sheet, /<autoFilter ref="A1:C3"\/>/);
  assert.throws(() => buildXlsx({ columns: ['a'], rows: new Array(1048576).fill(['x']) }), /at most/);
});
