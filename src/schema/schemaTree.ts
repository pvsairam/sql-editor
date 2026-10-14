import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/ConnectionStore';
import { DbColumn, DbObject, SchemaService } from './SchemaService';

type Node = MessageNode | ObjectNode | ColumnNode;

class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon: string, command?: vscode.Command, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.description = description;
    this.contextValue = 'message';
  }
}

export class ObjectNode extends vscode.TreeItem {
  constructor(readonly obj: DbObject) {
    super(obj.name.toLowerCase(), vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'dbObject';
    this.iconPath = new vscode.ThemeIcon(obj.type === 'VIEW' ? 'eye' : 'table');
    this.description = obj.type === 'VIEW' ? 'view' : undefined;
    this.tooltip = `${obj.owner}.${obj.name}`;
    this.id = `${obj.owner}.${obj.name}`;
  }
}

export class ColumnNode extends vscode.TreeItem {
  constructor(
    readonly table: string,
    readonly col: DbColumn
  ) {
    super(col.name.toLowerCase(), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'dbColumn';
    this.description = `${col.type}${col.nullable ? '' : ' · not null'}`;
    this.iconPath = new vscode.ThemeIcon('symbol-field');
    this.id = `${table}.${col.name}`;
  }
}

export class SchemaTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly schema: SchemaService
  ) {
    this.subs = [schema.onDidChange(() => this.emitter.fire()), store.onDidChange(() => this.emitter.fire())];
  }

  getTreeItem(e: Node): vscode.TreeItem {
    return e;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    const conn = this.store.active;
    if (!conn) {
      return [new MessageNode('Select a connection to browse its schema', 'plug')];
    }
    if (parent instanceof ObjectNode) {
      const cols = await this.schema.columns(conn, parent.obj.name, parent.obj.owner);
      return cols.length ? cols.map((c) => new ColumnNode(parent.obj.name, c)) : [new MessageNode('No columns visible', 'info')];
    }
    const filter = this.schema.filterFor(conn.id);
    const head: Node[] = [new MessageNode(filter ? `Filter: ${filter}` : 'Search tables & views…', 'search', { command: 'fusionSqlDev.searchObjects', title: 'Search' }, filter ? 'click to change' : undefined)];
    const objects = await this.schema.objects(conn);
    const failure = this.schema.failure(conn.id);
    if (failure) {
      return [...head, new MessageNode('Could not read the schema', 'warning', { command: 'fusionSqlDev.showLog', title: 'Log' }, failure.split('\n')[0].slice(0, 80))];
    }
    if (objects.length === 0) {
      return [...head, new MessageNode('No matching tables or views', 'info')];
    }
    const nodes: Node[] = objects.map((o) => new ObjectNode(o));
    if (objects.length >= 2000) {
      nodes.push(new MessageNode('Showing the first 2,000 - refine the search', 'info', { command: 'fusionSqlDev.searchObjects', title: 'Search' }));
    }
    return [...head, ...nodes];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
