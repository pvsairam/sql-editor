/** Tiny XML helpers (escape, entity decoding, namespace-prefix-tolerant tag extraction). */

// Characters that are illegal in XML 1.0 documents.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xmlEscape(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Decode one level of XML entities (named + numeric). */
export function xmlUnescapeOnce(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, ent: string) => {
    switch (ent) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const cp = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        try {
          return String.fromCodePoint(cp);
        } catch {
          return '';
        }
      }
    }
  });
}

/** Oracle often double-encodes fault details; keep decoding until stable (max 3 rounds). */
export function xmlUnescapeDeep(s: string): string {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    const next = xmlUnescapeOnce(cur);
    if (next === cur) {
      break;
    }
    cur = next;
  }
  return cur;
}

/** First element text with the given local name, ignoring namespace prefixes and attributes. */
export function tagText(xml: string, localName: string): string | undefined {
  const re = new RegExp(`<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}\\s*>`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : undefined;
}

export function allTagText(xml: string, localName: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}\\s*>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

/** Strip a CDATA wrapper if present. */
export function unCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}
