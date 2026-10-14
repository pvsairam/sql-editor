/** Minimal but valid .xlsx writer (inline strings, real numbers and dates, bold frozen header, filters). */
import { writeZip, ZipEntry } from '../fusion/zip';
import { numericColumns, Table } from './formats';
import { xmlEscape } from '../fusion/xml';

const MAX_ROWS = 1_048_575;
const MAX_CELL = 32_767;
const ISO_DT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/** Excel serial for a wall-clock date-time (1900 date system). */
export function excelSerial(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return ms / 86400000 + 25569;
}

function dateColumns(t: Table): boolean[] {
  return t.columns.map((_c, i) => {
    let seen = 0;
    for (const r of t.rows) {
      const v = r[i];
      if (!v) {
        continue;
      }
      if (!ISO_DT.test(v)) {
        return false;
      }
      seen++;
    }
    return seen > 0;
  });
}

export function buildXlsx(t: Table, sheetName = 'Results'): Buffer {
  if (t.rows.length > MAX_ROWS) {
    throw new Error(`Excel supports at most ${MAX_ROWS.toLocaleString()} rows; this result has ${t.rows.length.toLocaleString()}. Export as CSV instead.`);
  }
  const num = numericColumns(t);
  const dates = dateColumns(t);
  const widths = t.columns.map((c, i) => {
    let w = c.length;
    for (let r = 0; r < Math.min(t.rows.length, 300); r++) {
      w = Math.max(w, (t.rows[r][i] ?? '').length);
    }
    return Math.min(60, Math.max(8, w + 2));
  });

  const rows: string[] = [];
  const cell = (ref: string, v: string, col: number): string => {
    if (v === '' || v === undefined) {
      return '';
    }
    if (num[col]) {
      return `<c r="${ref}"><v>${v}</v></c>`;
    }
    if (dates[col]) {
      const m = ISO_DT.exec(v)!;
      const serial = excelSerial(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
      return `<c r="${ref}" s="2"><v>${serial}</v></c>`;
    }
    const text = v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  };

  rows.push(`<row r="1">${t.columns.map((c, i) => `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${xmlEscape(c)}</t></is></c>`).join('')}</row>`);
  t.rows.forEach((r, ri) => {
    const rn = ri + 2;
    rows.push(`<row r="${rn}">${t.columns.map((_c, ci) => cell(`${colName(ci)}${rn}`, r[ci] ?? '', ci)).join('')}</row>`);
  });

  const lastCol = colName(Math.max(0, t.columns.length - 1));
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${lastCol}${t.rows.length + 1}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    (t.columns.length ? `<autoFilter ref="A1:${lastCol}${t.rows.length + 1}"/>` : '') +
    `</worksheet>`;

  const safeName = sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Results';
  const files: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
      )
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
      )
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
      )
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
      )
    },
    {
      name: 'xl/styles.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
      )
    },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') }
  ];
  return writeZip(files);
}
