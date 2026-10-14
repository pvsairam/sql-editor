import * as vscode from 'vscode';
import { Connection, ENV_COLORS } from '../model';
import { ConnectionStore } from './ConnectionStore';
import { ConnectionManager } from './ConnectionManager';

export class ConnectionItem extends vscode.TreeItem {
  constructor(
    readonly conn: Connection,
    active: boolean,
    description: string
  ) {
    super(conn.name, vscode.TreeItemCollapsibleState.None);
    this.id = conn.id;
    this.contextValue = `connection.${conn.auth}`;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(active ? 'debug-start' : 'database', new vscode.ThemeColor(ENV_COLORS[conn.environment] ?? 'foreground'));
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${conn.name}** · ${conn.environment}${active ? ' · $(check) active' : ''}\n\n`);
    md.appendMarkdown(`${conn.url}\n\nUser: \`${conn.username}\`  \nSign-in: ${conn.auth === 'basic' ? 'username & password' : conn.auth === 'oauth' ? 'Single Sign-On (OAuth)' : 'access token / cookie'}`);
    if (conn.dataSource) {
      md.appendMarkdown(`  \nData source: \`${conn.dataSource}\``);
    }
    if (conn.reportPath) {
      md.appendMarkdown(`  \nHelper: \`${conn.reportPath}\``);
    }
    this.tooltip = md;
    this.command = { command: 'fusionSqlDev.setActiveConnection', title: 'Connect', arguments: [conn.id] };
  }
}

export class ConnectionTree implements vscode.TreeDataProvider<ConnectionItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager
  ) {
    this.subs = [store.onDidChange(() => this.emitter.fire()), manager.onDidChangeAuth(() => this.emitter.fire())];
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(e: ConnectionItem): vscode.TreeItem {
    return e;
  }

  async getChildren(): Promise<ConnectionItem[]> {
    const activeId = this.store.activeId;
    const out: ConnectionItem[] = [];
    for (const c of this.store.list()) {
      out.push(new ConnectionItem(c, c.id === activeId, await this.manager.describe(c)));
    }
    return out;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
