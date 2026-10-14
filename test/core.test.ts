import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseDelimited, toCsv } from '../src/fusion/csv';
import { readZip, writeZip } from '../src/fusion/zip';
import { splitStatements, statementAt, maskNonCode, stripSqlComments } from '../src/sql/lexer';
import { applyBinds, findBinds, prepareStatement, stripTerminators, wrapForPaging } from '../src/sql/prepare';
import { buildRuntime, encodeSql, extractFromArchive, patchReportZip, runtimePaths } from '../src/fusion/runtime';
import { extractFaultMessage, classifyResponse } from '../src/fusion/soap';
import { xmlEscape, xmlUnescapeDeep } from '../src/fusion/xml';
import * as zlib from 'zlib';

test('csv: quoted fields, embedded pipes/newlines/quotes and untrimmed values', () => {
  const t = parseDelimited('ID|NAME|NOTE\n1|Ann|"a|b"\n2|Bob|"line1\nline2 ""q"""\n3|  Cy  |\n', '|');
  assert.deepEqual(t.columns, ['ID', 'NAME', 'NOTE']);
  assert.deepEqual(t.rows, [
    ['1', 'Ann', 'a|b'],
    ['2', 'Bob', 'line1\nline2 "q"'],
    ['3', '  Cy  ', '']
  ]);
});

test('csv: CRLF, BOM, blank trailing lines, short and long rows', () => {
  const t = parseDelimited('﻿A|B\r\n1|2\r\n3\r\n4|5|6\r\n\r\n', '|');
  assert.deepEqual(t.columns, ['A', 'B']);
  assert.deepEqual(t.rows, [['1', '2'], ['3', ''], ['4', '5|6']]);
});

test('csv: stray quote does not swallow the file', () => {
  const t = parseDelimited('A|B\n1|say "hi\n2|ok\n', '|');
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[1][0], '2');
});

test('csv: empty output', () => {
  assert.deepEqual(parseDelimited('', '|'), { columns: [], rows: [] });
  assert.deepEqual(parseDelimited('\n\n', '|'), { columns: [], rows: [] });
});

test('csv: export quoting', () => {
  assert.equal(toCsv(['a', 'b'], [['x,y', 'q"r'], [null, ' pad']]), 'a,b\r\n"x,y","q""r"\r\n," pad"\r\n');
});

test('zip: round trip including unicode names, empty files and compressible data', () => {
  const big = Buffer.from('abc'.repeat(10000));
  const z = writeZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/ü.bin', data: big },
    { name: 'empty', data: Buffer.alloc(0) }
  ]);
  const back = readZip(z);
  assert.equal(back.length, 3);
  assert.equal(back[1].name, 'dir/ü.bin');
  assert.ok(back[1].data.equals(big));
  assert.ok(z.length < big.length);
});

test('lexer: statements split on ; and / but not inside strings or comments', () => {
  const sql = `-- it's a comment; with semicolon\nSELECT 'a;b' AS x, q'[it's; here]' y FROM dual;\n/* ; */\nSELECT 2 FROM dual\n/\nSELECT 3 FROM dual`;
  const st = splitStatements(sql);
  assert.equal(st.length, 3);
  assert.match(st[0].text, /^-- it's a comment/);
  assert.match(st[1].text, /^\/\* ; \*\/\s*SELECT 2 FROM dual$/);
  assert.equal(st[2].text, 'SELECT 3 FROM dual');
});

test('lexer: statement at cursor', () => {
  const sql = 'SELECT 1 FROM dual;\n\nSELECT 2\nFROM dual;\n';
  const off = (s: string, from = 0) => sql.indexOf(s, from);
  assert.equal(statementAt(sql, off('SELECT 1') + 3)!.text, 'SELECT 1 FROM dual');
  assert.equal(statementAt(sql, off('FROM dual;\n', off('SELECT 2')) + 2)!.text, 'SELECT 2\nFROM dual');
  // cursor right after the first ; on the same line -> first statement
  assert.equal(statementAt(sql, sql.indexOf(';') + 1)!.text, 'SELECT 1 FROM dual');
  // blank line between statements goes to the previous one? (next line starts a new statement) -> second
  assert.equal(statementAt(sql, sql.indexOf('\n\n') + 2)!.text, 'SELECT 2\nFROM dual');
});

test('lexer: blank-line terminator option', () => {
  const sql = 'SELECT 1\nFROM dual\n\nSELECT 2\nFROM dual';
  assert.equal(splitStatements(sql).length, 1);
  const st = splitStatements(sql, { blankLineEndsStatement: true });
  assert.equal(st.length, 2);
  assert.equal(st[1].text, 'SELECT 2\nFROM dual');
});

test('lexer: mask and strip comments keep strings', () => {
  assert.equal(maskNonCode("a 'x;y' -- c;\nb").includes(';'), false);
  assert.equal(stripSqlComments("SELECT '--x' /*c*/ FROM t -- end").trim(), "SELECT '--x'   FROM t");
});

test('prepare: DML and PL/SQL are rejected with guidance', () => {
  for (const s of ['UPDATE t SET a=1', 'delete from t', 'BEGIN null; END;', 'CREATE TABLE x (a int)', 'ALTER SESSION SET x=1']) {
    assert.throws(() => prepareStatement(s), (e: Error) => e.name === 'FusionError' && /read-only|cannot be run|Only SELECT/.test(e.message));
  }
  assert.equal(prepareStatement('  select 1 from dual ;; \n').sql, 'select 1 from dual');
  assert.equal(prepareStatement('/* c */ WITH x AS (SELECT 1 a FROM dual) SELECT * FROM x;').rewritten, false);
});

test('prepare: DESC becomes a dictionary query', () => {
  const p = prepareStatement('desc per_all_people_f');
  assert.equal(p.rewritten, true);
  assert.match(p.sql, /FROM all_tab_columns/);
  assert.match(p.sql, /table_name = 'PER_ALL_PEOPLE_F'/);
  assert.throws(() => prepareStatement('desc a b c'));
});

test('prepare: binds are found outside strings and substituted as typed literals', () => {
  const sql = "SELECT :a, ':not', :b, :a FROM t WHERE x = :c -- :comment\n AND y = to_char(sysdate,'HH24:MI')";
  assert.deepEqual(findBinds(sql), ['A', 'B', 'C']);
  const out = applyBinds(sql, { A: '10', B: "O'Brien", C: 'null' });
  assert.match(out, /^SELECT 10, ':not', 'O''Brien', 10 FROM t WHERE x = NULL -- :comment/);
  assert.match(out, /'HH24:MI'/);
});

test('prepare: terminators and wrapper', () => {
  assert.equal(stripTerminators('select 1 from dual\n/\n'), 'select 1 from dual');
  assert.equal(wrapForPaging('select 1 from dual -- c', 5, 10), 'SELECT * FROM (\nselect 1 from dual -- c\n) fusion_sql_page\nOFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY');
});

test('runtime: generated archives contain the REF CURSOR data model and a patched report', () => {
  const art = buildRuntime({ catalogRoot: '/~john.doe@acme.com', dataSource: 'ApplicationDB_FSCM' });
  assert.equal(art.reportPath, '/~john.doe@acme.com/FusionSqlDev/v2/csv.xdo');
  const dm = Object.fromEntries(readZip(art.dataModelZip).map((e) => [e.name, e.data.toString('utf8')]));
  assert.match(dm['_datamodel.xdm'], /OPEN :xdo_cursor FOR utl_raw\.cast_to_varchar2\(UTL_COMPRESS\.lz_uncompress/);
  assert.match(dm['_datamodel.xdm'], /dataSourceRef="ApplicationDB_FSCM"/);
  assert.match(dm['_datamodel.xdm'], /name="P_B64_CONTENT"/);
  const rpt = Object.fromEntries(readZip(art.reportZip).map((e) => [e.name, e.data]));
  assert.match(rpt['_report.xdo'].toString(), /<dataModel url="\/~john\.doe@acme\.com\/FusionSqlDev\/v2\/dm\.xdm"\/>/);
  assert.match(rpt['xdo.cfg'].toString(), /csv-delimiter">\|</);
  assert.deepEqual(readZip(rpt['Default_en_US.xpt']).map((e) => e.name).sort(), ['businessView.xml', 'layout.xml', 'version.txt']);
  // default parameter value decodes to valid SQL
  const dflt = /defaultValue="([^"]+)"/.exec(dm['_datamodel.xdm'])![1];
  assert.equal(zlib.gunzipSync(Buffer.from(dflt, 'base64')).toString(), 'SELECT * FROM DUAL');
  // HCM data source gets its own folder
  assert.match(runtimePaths({ catalogRoot: '/~u', dataSource: 'ApplicationDB_HCM' }).versionFolder, /v2-hcm$/);
});

test('runtime: import an .xdrz-style archive and re-point the report', () => {
  const a = buildRuntime({ catalogRoot: '/~someone', dataSource: 'ApplicationDB_FSCM' });
  const xdrz = writeZip([
    { name: 'v1/dm.xdmz', data: a.dataModelZip },
    { name: 'v1/csv.xdoz', data: a.reportZip }
  ]);
  const { dataModelZip, reportZip } = extractFromArchive(xdrz);
  const patched = patchReportZip(reportZip, '/~other/FusionSqlDev/v2/dm.xdm');
  assert.ok(dataModelZip.length > 0);
  assert.match(readZip(patched).find((e) => e.name === '_report.xdo')!.data.toString(), /url="\/~other\/FusionSqlDev\/v2\/dm\.xdm"/);
  assert.throws(() => extractFromArchive(writeZip([{ name: 'x.txt', data: Buffer.from('x') }])));
});

test('encodeSql is gzip+base64', () => {
  assert.equal(zlib.gunzipSync(Buffer.from(encodeSql('select 1 from dual'), 'base64')).toString(), 'select 1 from dual');
});

test('soap: fault extraction prefers ORA codes and drops ORA-06512 noise', () => {
  const inner = 'java.sql.SQLException: ORA-00942: table or view does not exist\nORA-06512: at line 4';
  const body = `<env:Envelope><env:Body><env:Fault><faultstring>oracle.xdo.OperationFailedException: ${xmlEscape(xmlEscape(inner))}</faultstring></env:Fault></env:Body></env:Envelope>`;
  assert.equal(extractFaultMessage(body), 'ORA-00942: table or view does not exist');
  const e = classifyResponse(500, {}, body, 'basic')!;
  assert.equal(e.kind, 'oracle');
  assert.equal(e.code, 'ORA-00942');
  assert.equal(xmlUnescapeDeep('&amp;lt;a&amp;gt;'), '<a>');
});

test('soap: HTML login pages and redirects are SSO, 401 is auth', () => {
  assert.equal(classifyResponse(200, {}, '<!DOCTYPE html><html><title>Sign In</title></html>', 'basic')!.kind, 'sso');
  assert.equal(classifyResponse(302, { location: 'https://idp.example.com/x' }, '', 'basic')!.kind, 'sso');
  assert.equal(classifyResponse(401, {}, '', 'basic')!.kind, 'auth');
  assert.equal(classifyResponse(404, {}, '<html>nope</html>', 'basic')!.kind, 'http');
  assert.equal(classifyResponse(200, {}, '<Envelope><Body><ok/></Body></Envelope>', 'basic'), undefined);
});
