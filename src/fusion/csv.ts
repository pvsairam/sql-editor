/**
 * Delimited-text parser for the BI Publisher "csv" output.
 *
 * The old implementation split on "\n" and "|" and trimmed every value, which silently corrupted
 * rows containing line breaks, pipes or significant whitespace. This is a real RFC-4180 style
 * state machine (quotes, escaped quotes, embedded delimiters/newlines, CRLF, BOM).
 */

export interface ParsedTable {
  columns: string[];
  rows: string[][];
}

export function parseDelimited(input: string | Buffer, delimiter = '|'): ParsedTable {
  let text = typeof input === 'string' ? input : input.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const strict = scan(text, delimiter, true);
  // A stray quote in an unquoted value would swallow the rest of the file; fall back to plain splitting.
  const records = strict.unterminated ? scan(text, delimiter, false).records : strict.records;
  return toTable(records, delimiter);
}

function scan(text: string, delimiter: string, useQuotes: boolean): { records: string[][]; unterminated: boolean } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let fieldWasQuoted = false;
  const n = text.length;

  const endField = () => {
    record.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (useQuotes && ch === '"' && field.length === 0 && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRecord();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i++;
      }
      endRecord();
    } else {
      field += ch;
    }
  }
  const unterminated = inQuotes;
  // Flush the last record unless the text ended exactly on a record boundary.
  if (field.length > 0 || fieldWasQuoted || record.length > 0) {
    endRecord();
  }
  return { records, unterminated };
}

function toTable(records: string[][], delimiter: string): ParsedTable {
  // Drop fully blank trailing/leading records (BI Publisher may append an empty line).
  const nonBlank = records.filter((r) => !(r.length === 1 && r[0] === ''));
  if (nonBlank.length === 0) {
    return { columns: [], rows: [] };
  }
  const columns = nonBlank[0].map((c) => c.trim());
  const rows = nonBlank.slice(1).map((r) => {
    if (r.length === columns.length) {
      return r;
    }
    if (r.length > columns.length) {
      // Unquoted delimiter inside a value: glue the overflow back onto the last column.
      return [...r.slice(0, columns.length - 1), r.slice(columns.length - 1).join(delimiter)];
    }
    return [...r, ...new Array<string>(columns.length - r.length).fill('')];
  });
  return { columns, rows };
}

/** Quote one field for CSV output when required. */
export function csvField(value: string | null | undefined, delimiter = ','): string {
  const s = value ?? '';
  if (s === '') {
    return '';
  }
  if (s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(columns: string[], rows: (string | null)[][], delimiter = ','): string {
  const lines = [columns.map((c) => csvField(c, delimiter)).join(delimiter)];
  for (const r of rows) {
    lines.push(r.map((v) => csvField(v, delimiter)).join(delimiter));
  }
  return lines.join('\r\n') + '\r\n';
}
