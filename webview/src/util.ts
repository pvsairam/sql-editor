export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

export function fmtMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 2 : 1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString();
}

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
export function isNumeric(v: string): boolean {
  return v.length < 18 && NUMBER_RE.test(v);
}

/** Pretty-print JSON/XML-looking values for the cell viewer. */
export function prettyValue(v: string): { text: string; kind: 'json' | 'xml' | 'text' } {
  const t = v.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return { text: JSON.stringify(JSON.parse(t), null, 2), kind: 'json' };
    } catch {
      /* not JSON */
    }
  }
  if (t.startsWith('<') && t.endsWith('>')) {
    return { text: prettyXml(t), kind: 'xml' };
  }
  return { text: v, kind: 'text' };
}

function prettyXml(xml: string): string {
  let out = '';
  let depth = 0;
  for (const tok of xml.replace(/>\s+</g, '><').split(/(?=<)/)) {
    if (/^<\//.test(tok)) {
      depth = Math.max(0, depth - 1);
    }
    out += '  '.repeat(depth) + tok + '\n';
    if (/^<[^!?/][^>]*[^/]>[^<]*$/.test(tok) && !/<\/[^>]+>\s*$/.test(tok)) {
      depth++;
    }
  }
  return out.trimEnd();
}

export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: number | undefined;
  return ((...a: never[]) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  }) as T;
}
