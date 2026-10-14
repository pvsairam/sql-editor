import * as vscode from 'vscode';
import { HistoryEntry } from '../model';
import { HistoryStore } from './HistoryStore';
import { oneLine } from '../sql/lexer';

type Node = GroupNode | EntryNode;

class GroupNode extends vscode.TreeItem {
  constructor(
    readonly title: string,
    readonly entries: HistoryEntry[],
    expanded: boolean
  ) {
    super(title, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = String(entries.length);
    this.contextValue = 'historyGroup';
    this.id = `g:${title}`;
  }
}

export class EntryNode extends vscode.TreeItem {
  constructor(readonly entry: HistoryEntry) {
    super(oneLine(entry.sql, 90), vscode.TreeItemCollapsibleState.None);
    this.id = entry.id;
    this.contextValue = 'history';
    const t = new Date(entry.timestamp);
    const rows = entry.rowCount !== undefined ? ` · ${entry.rowCount.toLocaleString()} rows` : '';
    this.description = `${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${entry.connectionName}${entry.starred ? ' ★' : ''}`;
    this.iconPath = new vscode.ThemeIcon(entry.status === 'success' ? 'pass' : 'error', new vscode.ThemeColor(entry.status === 'success' ? 'testing.iconPassed' : 'testing.iconFailed'));
    const md = new vscode.MarkdownString();
    md.appendCodeblock(entry.sql.length > 1500 ? entry.sql.slice(0, 1500) + '\n…' : entry.sql, 'sql');
    md.appendMarkdown(`\n${t.toLocaleString()} · ${entry.durationMs} ms${rows}${entry.error ? `\n\n**Error:** ${entry.error.replace(/\n/g, '  \n')}` : ''}`);
    this.tooltip = md;
    this.command = { command: 'fusionSqlDev.openHistoryItem', title: 'Open in Worksheet', arguments: [this] };
  }
}

export class HistoryTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private filter = '';
  private readonly sub: vscode.Disposable;

  constructor(private readonly history: HistoryStore) {
    this.sub = history.onDidChange(() => this.emitter.fire());
  }

  setFilter(f: string): void {
    this.filter = f.trim().toLowerCase();
    this.emitter.fire();
  }

  getTreeItem(e: Node): vscode.TreeItem {
    return e;
  }

  getChildren(parent?: Node): Node[] {
    if (parent instanceof GroupNode) {
      return parent.entries.map((e) => new EntryNode(e));
    }
    const all = this.history.all().filter((e) => !this.filter || e.sql.toLowerCase().includes(this.filter) || e.connectionName.toLowerCase().includes(this.filter));
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = startOfDay(new Date());
    const day = 86400000;
    const groups: [string, HistoryEntry[]][] = [
      ['Starred', all.filter((e) => e.starred)],
      ['Today', all.filter((e) => !e.starred && e.timestamp >= today)],
      ['Yesterday', all.filter((e) => !e.starred && e.timestamp < today && e.timestamp >= today - day)],
      ['Previous 7 days', all.filter((e) => !e.starred && e.timestamp < today - day && e.timestamp >= today - 7 * day)],
      ['Older', all.filter((e) => !e.starred && e.timestamp < today - 7 * day)]
    ];
    return groups.filter(([, items]) => items.length > 0).map(([title, items]) => new GroupNode(title, items, title === 'Starred' || title === 'Today' || (this.filter !== '' && items.length < 50)));
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
