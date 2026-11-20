import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/ConnectionStore';
import { DbColumn, DbObject, DbObjectType, SchemaService } from './SchemaService';

type Node = MessageNode | CategoryNode | ObjectNode | ColumnNode;

const CATEGORY_ORDER: { type: DbObjectType; label: string; icon: string }[] = [
  { type: 'TABLE', label: 'Tables', icon: 'table' },
  { type: 'VIEW', label: 'Views', icon: 'eye' },
  { type: 'SYNONYM', label: 'Synonyms', icon: 'references' },
  { type: 'PACKAGE', label: 'Packages', icon: 'package' }
];

const MAX_ITEMS_PER_CATEGORY = 500;

class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon: string, command?: vscode.Command, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.description = description;
    this.contextValue = 'message';
  }
}

export class CategoryNode extends vscode.TreeItem {
  constructor(
    readonly objectType: DbObjectType,
    readonly items: DbObject[],
    label: string,
    icon: string,
    expanded: boolean
  ) {
    super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = items.length.toLocaleString();
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `dbCategory.${objectType}`;
    this.id = `category:${objectType}`;
  }
}

export class ObjectNode extends vscode.TreeItem {
  constructor(readonly obj: DbObject) {
    const isPackage = obj.type === 'PACKAGE';
    super(obj.name.toLowerCase(), isPackage ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = `dbObject.${obj.type}`;
    this.iconPath = new vscode.ThemeIcon(
      obj.type === 'VIEW' ? 'eye' : obj.type === 'SYNONYM' ? 'references' : obj.type === 'PACKAGE' ? 'package' : 'table'
    );
    this.description = obj.type === 'TABLE' ? undefined : obj.type.toLowerCase();
    this.tooltip = `${obj.owner}.${obj.name} (${obj.type})`;
    this.id = `${obj.owner}.${obj.type}.${obj.name}`;
    if (isPackage) {
      this.command = { command: 'fusionSqlDev.viewPackageSource', title: 'View Package Source', arguments: [this] };
    }
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
    if (parent instanceof CategoryNode) {
      const slice: Node[] = parent.items.slice(0, MAX_ITEMS_PER_CATEGORY).map((o) => new ObjectNode(o));
      if (parent.items.length > MAX_ITEMS_PER_CATEGORY) {
        slice.push(
          new MessageNode(
            `Showing ${MAX_ITEMS_PER_CATEGORY.toLocaleString()} of ${parent.items.length.toLocaleString()} — refine search`,
            'info',
            { command: 'fusionSqlDev.searchObjects', title: 'Search' }
          )
        );
      }
      return slice;
    }
    if (parent instanceof ObjectNode) {
      if (parent.obj.type === 'PACKAGE') {
        return [];
      }
      const cols = await this.schema.columns(conn, parent.obj.name, parent.obj.owner);
      return cols.length ? cols.map((c) => new ColumnNode(`${parent.obj.type}.${parent.obj.name}`, c)) : [new MessageNode('No columns visible', 'info')];
    }
    const filter = this.schema.filterFor(conn.id);
    const totalAll = this.schema.cachedAll(conn.id)?.length;
    const head: Node[] = [
      new MessageNode(
        filter ? `Filter: ${filter}` : 'Search tables, views, synonyms, packages…',
        'search',
        { command: 'fusionSqlDev.searchObjects', title: 'Search' },
        filter ? 'click to change' : totalAll ? `${totalAll.toLocaleString()} cached` : undefined
      )
    ];
    const objects = await this.schema.objects(conn);
    const failure = this.schema.failure(conn.id);
    if (failure) {
      return [...head, new MessageNode('Could not read the schema', 'warning', { command: 'fusionSqlDev.showLog', title: 'Log' }, failure.split('\n')[0].slice(0, 80))];
    }
    if (objects.length === 0) {
      return [...head, new MessageNode('No matching objects', 'info')];
    }
    const byType = new Map<DbObjectType, DbObject[]>();
    for (const o of objects) {
      const list = byType.get(o.type);
      if (list) {
        list.push(o);
      } else {
        byType.set(o.type, [o]);
      }
    }
    const categories: Node[] = [];
    for (const cat of CATEGORY_ORDER) {
      const items = byType.get(cat.type) ?? [];
      if (items.length > 0) {
        categories.push(new CategoryNode(cat.type, items, cat.label, cat.icon, !!filter && items.length <= 50));
      }
    }
    return [...head, ...categories];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
