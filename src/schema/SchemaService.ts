import * as vscode from 'vscode';
import { Connection } from '../model';
import { ConnectionManager } from '../connections/ConnectionManager';
import { Logger } from '../fusion/types';
import { settings } from '../config';

export interface DbObject {
  owner: string;
  name: string;
  type: string; // TABLE | VIEW
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  id: number;
}

interface ConnCache {
  objects?: DbObject[];
  objectFilter: string;
  columns: Map<string, DbColumn[]>;
  loading?: Promise<DbObject[]>;
  failed?: string;
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Lazy, cached dictionary lookups (ALL_OBJECTS / ALL_TAB_COLUMNS) used by the Schema view and completion. */
export class SchemaService {
  private readonly cache = new Map<string, ConnCache>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly log: Logger
  ) {}

  private slot(id: string): ConnCache {
    let c = this.cache.get(id);
    if (!c) {
      c = { objectFilter: '', columns: new Map() };
      this.cache.set(id, c);
    }
    return c;
  }

  filterFor(id: string): string {
    return this.slot(id).objectFilter;
  }

  async setFilter(conn: Connection, filter: string): Promise<void> {
    const s = this.slot(conn.id);
    s.objectFilter = filter.trim().toUpperCase();
    s.objects = undefined;
    s.failed = undefined;
    this.emitter.fire();
  }

  refresh(id?: string): void {
    if (id) {
      const f = this.cache.get(id)?.objectFilter ?? '';
      this.cache.set(id, { objectFilter: f, columns: new Map() });
    } else {
      this.cache.clear();
    }
    this.emitter.fire();
  }

  cached(id: string): DbObject[] | undefined {
    return this.cache.get(id)?.objects;
  }

  cachedColumns(id: string, table: string): DbColumn[] | undefined {
    return this.cache.get(id)?.columns.get(table.toUpperCase());
  }

  failure(id: string): string | undefined {
    return this.cache.get(id)?.failed;
  }

  /** Tables and views matching the current filter (max 2,000). */
  async objects(conn: Connection): Promise<DbObject[]> {
    const s = this.slot(conn.id);
    if (s.objects) {
      return s.objects;
    }
    s.loading ??= this.loadObjects(conn, s).finally(() => (s.loading = undefined));
    return s.loading;
  }

  private async loadObjects(conn: Connection, s: ConnCache): Promise<DbObject[]> {
    const owner = settings.schemaOwner;
    const f = s.objectFilter;
    const like = f ? (f.includes('%') ? f : `%${f}%`) : '';
    const sql =
      `SELECT owner, object_name, object_type FROM all_objects WHERE object_type IN ('TABLE','VIEW')` +
      (owner === '%' ? '' : ` AND owner = ${sqlString(owner)}`) +
      (like ? ` AND object_name LIKE ${sqlString(like)}` : '') +
      ` ORDER BY object_name`;
    try {
      const client = await this.manager.clientFor(conn, false);
      const page = await client.runSql(sql, { limit: 2000 });
      s.objects = page.rows.map((r) => ({ owner: r[0], name: r[1], type: r[2] }));
      s.failed = undefined;
    } catch (e) {
      this.log.warn(`Schema load failed: ${e instanceof Error ? e.message : String(e)}`);
      s.failed = e instanceof Error ? e.message : String(e);
      s.objects = [];
    }
    this.emitter.fire();
    return s.objects ?? [];
  }

  async columns(conn: Connection, table: string, owner?: string): Promise<DbColumn[]> {
    const s = this.slot(conn.id);
    const key = table.toUpperCase();
    const hit = s.columns.get(key);
    if (hit) {
      return hit;
    }
    const sql =
      `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, column_id FROM all_tab_columns WHERE table_name = ${sqlString(key)}` +
      (owner ? ` AND owner = ${sqlString(owner)}` : ` AND owner = ${sqlString(settings.schemaOwner === '%' ? 'FUSION' : settings.schemaOwner)}`) +
      ` ORDER BY column_id`;
    try {
      const client = await this.manager.clientFor(conn, false);
      const page = await client.runSql(sql, { limit: 2000 });
      const cols = page.rows.map((r) => ({
        name: r[0],
        type: formatType(r[1], r[2], r[3], r[4]),
        nullable: r[5] === 'Y',
        id: Number(r[6]) || 0
      }));
      s.columns.set(key, cols);
      return cols;
    } catch (e) {
      this.log.debug(`Column load failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
}

function formatType(type: string, length: string, precision: string, scale: string): string {
  if (/CHAR/.test(type)) {
    return `${type}(${length})`;
  }
  if (type === 'NUMBER' && precision) {
    return scale && scale !== '0' ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  }
  return type;
}
