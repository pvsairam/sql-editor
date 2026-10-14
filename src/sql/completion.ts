import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/ConnectionStore';
import { SchemaService } from '../schema/SchemaService';
import { FUSION_TABLES, FUSION_TABLE_MAP } from './fusionCatalog';
import { SQL_FUNCTIONS, SQL_KEYWORDS } from './keywords';
import { maskNonCode, regionAt, statementAt } from './lexer';
import { settings } from '../config';

/** Map alias (and bare table name) -> table name for the tables in the statement under the cursor. */
export function tablesInStatement(sqlText: string): Map<string, string> {
  const out = new Map<string, string>();
  const masked = maskNonCode(sqlText);
  const re = /\b(?:FROM|JOIN|,)\s+(?:([A-Za-z0-9_$#]+)\.)?([A-Za-z_][A-Za-z0-9_$#]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_$#]*))?/gi;
  const stop = new Set(['WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'ON', 'GROUP', 'ORDER', 'UNION', 'HAVING', 'SELECT', 'CONNECT', 'START', 'FETCH', 'OFFSET', 'USING', 'NATURAL', 'OUTER', 'MINUS', 'INTERSECT', 'SET']);
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const table = m[2].toUpperCase();
    if (stop.has(table)) {
      continue;
    }
    out.set(table, table);
    const alias = m[3]?.toUpperCase();
    if (alias && !stop.has(alias)) {
      out.set(alias, table);
    }
  }
  return out;
}

export class FusionCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly store: ConnectionStore,
    private readonly schema: SchemaService
  ) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[] | undefined> {
    if (!settings.completion) {
      return undefined;
    }
    const line = doc.lineAt(pos.line).text.slice(0, pos.character);
    // No completion inside comments / string literals.
    const startLine = Math.max(0, pos.line - 300);
    const before = doc.getText(new vscode.Range(new vscode.Position(startLine, 0), pos));
    if (regionAt(before, before.length) !== 'code') {
      return undefined;
    }

    const conn = this.store.active;
    const fullText = doc.getText();
    const offset = doc.offsetAt(pos);
    const stmt = statementAt(fullText, offset, { blankLineEndsStatement: settings.blankLineEndsStatement });
    const scopeText = stmt ? stmt.text : fullText;

    const dot = /([A-Za-z_][A-Za-z0-9_$#]*)\.\s*([A-Za-z0-9_$#]*)$/.exec(line);
    if (dot) {
      const qualifier = dot[1].toUpperCase();
      const tables = tablesInStatement(scopeText);
      const table = tables.get(qualifier) ?? qualifier;
      const items: vscode.CompletionItem[] = [];
      let cols = conn ? this.schema.cachedColumns(conn.id, table) : undefined;
      if (!cols && conn) {
        cols = await Promise.race([this.schema.columns(conn, table), new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500))]);
      }
      if (token.isCancellationRequested) {
        return undefined;
      }
      for (const c of cols ?? []) {
        const it = new vscode.CompletionItem(c.name.toLowerCase(), vscode.CompletionItemKind.Field);
        it.detail = `${c.type}${c.nullable ? '' : ' NOT NULL'}`;
        it.documentation = `${table}.${c.name}`;
        it.sortText = String(c.id).padStart(4, '0');
        it.filterText = c.name;
        items.push(it);
      }
      if (items.length) {
        return items;
      }
      // Not a known alias: maybe a schema prefix (FUSION.) -> offer tables
      if (qualifier === settings.schemaOwner) {
        return this.tableItems(conn?.id);
      }
      return undefined;
    }

    const afterFrom = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[A-Za-z0-9_$#]*$/i.test(line);
    const items: vscode.CompletionItem[] = [];
    if (afterFrom) {
      items.push(...this.tableItems(conn?.id));
    } else {
      // columns of the tables already named in the statement
      if (conn) {
        for (const table of new Set(tablesInStatement(scopeText).values())) {
          for (const c of this.schema.cachedColumns(conn.id, table) ?? []) {
            const it = new vscode.CompletionItem(c.name.toLowerCase(), vscode.CompletionItemKind.Field);
            it.detail = `${table}.${c.name} · ${c.type}`;
            it.sortText = '1' + String(c.id).padStart(4, '0');
            items.push(it);
          }
        }
        // opportunistically warm the column cache for tables in the statement
        for (const table of new Set(tablesInStatement(scopeText).values())) {
          if (!this.schema.cachedColumns(conn.id, table) && (FUSION_TABLE_MAP.has(table) || this.schema.cached(conn.id)?.some((o) => o.name === table))) {
            void this.schema.columns(conn, table);
          }
        }
      }
      for (const [alias] of tablesInStatement(scopeText)) {
        const it = new vscode.CompletionItem(alias.toLowerCase(), vscode.CompletionItemKind.Variable);
        it.sortText = '2' + alias;
        it.detail = 'alias / table in this statement';
        items.push(it);
      }
      for (const k of SQL_KEYWORDS) {
        const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
        it.sortText = '4' + k;
        items.push(it);
      }
      for (const [name, body, desc] of SQL_FUNCTIONS) {
        const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        it.insertText = new vscode.SnippetString(body);
        it.detail = desc;
        it.sortText = '3' + name;
        items.push(it);
      }
      items.push(...this.tableItems(conn?.id, '5'));
    }
    return items;
  }

  private tableItems(connId: string | undefined, sortPrefix = '0'): vscode.CompletionItem[] {
    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    for (const o of (connId ? this.schema.cached(connId) : undefined) ?? []) {
      seen.add(o.name);
      const it = new vscode.CompletionItem(o.name.toLowerCase(), o.type === 'VIEW' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Struct);
      it.detail = `${o.owner}.${o.name} (${o.type.toLowerCase()})`;
      it.sortText = sortPrefix + o.name;
      it.filterText = o.name;
      items.push(it);
    }
    for (const t of FUSION_TABLES) {
      if (seen.has(t.name)) {
        continue;
      }
      const it = new vscode.CompletionItem(t.name.toLowerCase(), vscode.CompletionItemKind.Struct);
      it.detail = `${t.module} · ${t.desc}`;
      it.sortText = sortPrefix + t.name;
      it.filterText = t.name;
      items.push(it);
    }
    return items;
  }
}

export class FusionHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly store: ConnectionStore,
    private readonly schema: SchemaService
  ) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_][A-Za-z0-9_$#]*/);
    if (!range) {
      return undefined;
    }
    const word = doc.getText(range).toUpperCase();
    const known = FUSION_TABLE_MAP.get(word);
    const conn = this.store.active;
    const cols = conn ? this.schema.cachedColumns(conn.id, word) : undefined;
    if (!known && !cols) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${word}**`);
    if (known) {
      md.appendMarkdown(` — ${known.module}: ${known.desc}`);
    }
    if (cols?.length) {
      md.appendMarkdown('\n\n| column | type |\n|---|---|\n');
      for (const c of cols.slice(0, 40)) {
        md.appendMarkdown(`| ${c.name.toLowerCase()} | ${c.type}${c.nullable ? '' : ' not null'} |\n`);
      }
      if (cols.length > 40) {
        md.appendMarkdown(`\n…and ${cols.length - 40} more`);
      }
    }
    return new vscode.Hover(md, range);
  }
}
