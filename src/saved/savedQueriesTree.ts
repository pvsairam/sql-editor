import * as vscode from 'vscode';
import { SavedQuery } from '../model';
import { SavedQueriesStore } from './SavedQueriesStore';
import { oneLine } from '../sql/lexer';

type Node = FolderNode | SavedQueryNode;

export class FolderNode extends vscode.TreeItem {
  constructor(
    readonly folder: string,
    readonly items: SavedQuery[]
  ) {
    super(folder, vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(items.length);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'savedFolder';
    this.id = `savedFolder:${folder}`;
  }
}

export class SavedQueryNode extends vscode.TreeItem {
  constructor(readonly query: SavedQuery) {
    super(query.name, vscode.TreeItemCollapsibleState.None);
    this.id = query.id;
    this.contextValue = 'savedQuery';
    this.description = query.description || oneLine(query.sql, 48);
    this.iconPath = new vscode.ThemeIcon('bookmark');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${query.name}**${query.folder ? ` _(${query.folder})_` : ''}\n\n`);
    md.appendCodeblock(query.sql.slice(0, 600), 'sql');
    this.tooltip = md;
    this.command = { command: 'fusionSqlDev.openSavedQuery', title: 'Open Saved Query', arguments: [this] };
  }
}

export class SavedQueriesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly store: SavedQueriesStore) {
    this.sub = store.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(e: Node): vscode.TreeItem {
    return e;
  }

  getChildren(parent?: Node): Node[] {
    if (parent instanceof FolderNode) {
      return parent.items.map((q) => new SavedQueryNode(q));
    }
    const all = this.store.list().slice().sort((a, b) => a.name.localeCompare(b.name));
    if (all.length === 0) {
      return [];
    }
    const folders = new Map<string, SavedQuery[]>();
    const root: SavedQuery[] = [];
    for (const q of all) {
      if (q.folder) {
        const list = folders.get(q.folder);
        if (list) {
          list.push(q);
        } else {
          folders.set(q.folder, [q]);
        }
      } else {
        root.push(q);
      }
    }
    const out: Node[] = [];
    for (const [f, items] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(new FolderNode(f, items));
    }
    for (const q of root) {
      out.push(new SavedQueryNode(q));
    }
    return out;
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
