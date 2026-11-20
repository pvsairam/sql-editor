import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Connection } from '../model';
import { ConnectionManager } from '../connections/ConnectionManager';
import { Logger } from '../fusion/types';
import { settings } from '../config';

export type DbObjectType = 'TABLE' | 'VIEW' | 'SYNONYM' | 'PACKAGE';

export interface DbObject {
  owner: string;
  name: string;
  type: DbObjectType;
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  id: number;
}

export interface SynonymTarget {
  synonymOwner: string;
  synonymName: string;
  tableOwner: string;
  tableName: string;
  dbLink?: string;
}

interface DiskSchemaCache {
  version: 2;
  owner: string;
  syncedAt: number;
  objects: DbObject[];
}

interface ConnCache {
  allObjects?: DbObject[];
  syncedAt?: number;
  syncedOwner?: string;
  objectFilter: string;
  columns: Map<string, DbColumn[]>;
  synonyms: Map<string, SynonymTarget | null>;
  loading?: Promise<DbObject[]>;
  failed?: string;
  loadedFromDisk?: boolean;
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function matchesFilter(name: string, filter: string): boolean {
  if (!filter) {
    return true;
  }
  const upper = name.toUpperCase();
  if (filter.includes('%') || filter.includes('_')) {
    const escaped = filter
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(upper);
  }
  return upper.includes(filter);
}

/**
 * Persistent, cached dictionary lookups (ALL_OBJECTS / ALL_TAB_COLUMNS / ALL_SOURCE / ALL_SYNONYMS)
 * used by the Schema view, completion, hover, and @fusion AI.
 */
export class SchemaService {
  private readonly cache = new Map<string, ConnCache>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly log: Logger,
    private readonly storageDir?: string
  ) {}

  private cacheFile(connId: string): string | undefined {
    if (!this.storageDir) {
      return undefined;
    }
    const safe = connId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.storageDir, `schema-cache-${safe}.json`);
  }

  private slot(id: string): ConnCache {
    let c = this.cache.get(id);
    if (!c) {
      c = { objectFilter: '', columns: new Map(), synonyms: new Map() };
      this.cache.set(id, c);
      this.hydrateFromDisk(id, c);
    }
    return c;
  }

  private hydrateFromDisk(id: string, slot: ConnCache): void {
    if (slot.loadedFromDisk) {
      return;
    }
    slot.loadedFromDisk = true;
    const file = this.cacheFile(id);
    if (!file || !fs.existsSync(file)) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DiskSchemaCache;
      if (parsed && parsed.version === 2 && Array.isArray(parsed.objects) && parsed.owner === settings.schemaOwner) {
        slot.allObjects = parsed.objects;
        slot.syncedAt = parsed.syncedAt;
        slot.syncedOwner = parsed.owner;
        this.log.debug(`Loaded ${parsed.objects.length.toLocaleString()} cached schema objects for ${id} from disk.`);
      }
    } catch (e) {
      this.log.debug(`Could not read schema disk cache: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private persistToDisk(id: string, owner: string, objects: DbObject[]): void {
    const file = this.cacheFile(id);
    if (!file) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload: DiskSchemaCache = { version: 2, owner, syncedAt: Date.now(), objects };
      fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
    } catch (e) {
      this.log.debug(`Could not persist schema cache: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  filterFor(id: string): string {
    return this.slot(id).objectFilter;
  }

  syncedAt(id: string): number | undefined {
    return this.slot(id).syncedAt;
  }

  async setFilter(conn: Connection, filter: string): Promise<void> {
    const s = this.slot(conn.id);
    s.objectFilter = filter.trim().toUpperCase();
    s.failed = undefined;
    // Filtering runs instantaneously in memory over the synced object index!
    this.emitter.fire();
  }

  refresh(id?: string): void {
    if (id) {
      const f = this.cache.get(id)?.objectFilter ?? '';
      this.cache.set(id, { objectFilter: f, columns: new Map(), synonyms: new Map(), loadedFromDisk: true });
      const file = this.cacheFile(id);
      if (file && fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    } else {
      for (const key of this.cache.keys()) {
        const file = this.cacheFile(key);
        if (file && fs.existsSync(file)) {
          try {
            fs.unlinkSync(file);
          } catch {
            /* ignore */
          }
        }
      }
      this.cache.clear();
    }
    this.emitter.fire();
  }

  cached(id: string): DbObject[] | undefined {
    const s = this.slot(id);
    if (!s.allObjects) {
      return undefined;
    }
    return s.objectFilter ? s.allObjects.filter((o) => matchesFilter(o.name, s.objectFilter)) : s.allObjects;
  }

  cachedAll(id: string): DbObject[] | undefined {
    return this.slot(id).allObjects;
  }

  cachedColumns(id: string, table: string): DbColumn[] | undefined {
    return this.slot(id).columns.get(table.toUpperCase());
  }

  failure(id: string): string | undefined {
    return this.slot(id).failed;
  }

  /** Tables, views, synonyms, and packages matching the current filter (backed by full persistent cache). */
  async objects(conn: Connection): Promise<DbObject[]> {
    const s = this.slot(conn.id);
    const owner = settings.schemaOwner;
    if (s.allObjects && s.syncedOwner === owner) {
      return s.objectFilter ? s.allObjects.filter((o) => matchesFilter(o.name, s.objectFilter)) : s.allObjects;
    }
    s.loading ??= this.loadObjects(conn, s).finally(() => (s.loading = undefined));
    const all = await s.loading;
    return s.objectFilter ? all.filter((o) => matchesFilter(o.name, s.objectFilter)) : all;
  }

  private async loadObjects(conn: Connection, s: ConnCache): Promise<DbObject[]> {
    const owner = settings.schemaOwner;
    const sql =
      `SELECT owner, object_name, object_type FROM all_objects WHERE object_type IN ('TABLE','VIEW','SYNONYM','PACKAGE')` +
      (owner === '%' ? '' : ` AND owner = ${sqlString(owner)}`) +
      ` ORDER BY object_name`;
    const statusMsg = vscode.window.setStatusBarMessage(`$(sync~spin) Syncing schema for ${conn.name}…`);
    try {
      const client = await this.manager.clientFor(conn, false);
      const all: DbObject[] = [];
      const maxObjects = settings.schemaMaxObjects;
      // Fetch up to 100k object names in ONE round-trip (~2 MB CSV) instead of 14 repeated ALL_OBJECTS sorts.
      const chunkSize = Math.min(maxObjects, 100000);
      let offset = 0;
      for (;;) {
        const take = Math.min(chunkSize, maxObjects - all.length);
        if (take <= 0) {
          break;
        }
        const page = await client.runSql(sql, { offset, limit: take });
        for (const r of page.rows) {
          const t = (r[2] || '').toUpperCase();
          if (t === 'TABLE' || t === 'VIEW' || t === 'SYNONYM' || t === 'PACKAGE') {
            all.push({ owner: r[0], name: r[1], type: t });
          }
        }
        if (!page.hasMore || page.rows.length === 0 || page.unpaged) {
          break;
        }
        offset += page.rows.length;
      }
      s.allObjects = all;
      s.syncedAt = Date.now();
      s.syncedOwner = owner;
      s.failed = undefined;
      this.persistToDisk(conn.id, owner, all);
      this.log.info(`Synced ${all.length.toLocaleString()} schema objects for ${conn.name}.`);
      void vscode.window.setStatusBarMessage(`Synced ${all.length.toLocaleString()} schema objects for ${conn.name}`, 4000);
    } catch (e) {
      this.log.warn(`Schema load failed: ${e instanceof Error ? e.message : String(e)}`);
      s.failed = e instanceof Error ? e.message : String(e);
      s.allObjects = [];
    } finally {
      statusMsg.dispose();
    }
    return s.allObjects ?? [];
  }

  async columns(conn: Connection, table: string, owner?: string): Promise<DbColumn[]> {
    const s = this.slot(conn.id);
    const key = table.toUpperCase();
    const hit = s.columns.get(key);
    if (hit) {
      return hit;
    }
    const effectiveOwner = owner || (settings.schemaOwner === '%' ? 'FUSION' : settings.schemaOwner);
    const queryCols = async (tbl: string, own: string): Promise<DbColumn[]> => {
      const sql =
        `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, column_id FROM all_tab_columns WHERE table_name = ${sqlString(tbl)}` +
        ` AND owner = ${sqlString(own)} ORDER BY column_id`;
      const client = await this.manager.clientFor(conn, false);
      const page = await client.runSql(sql, { limit: 2000 });
      return page.rows.map((r) => ({
        name: r[0],
        type: formatType(r[1], r[2], r[3], r[4]),
        nullable: r[5] === 'Y',
        id: Number(r[6]) || 0
      }));
    };
    try {
      let cols = await queryCols(key, effectiveOwner);
      // If empty, check if it's a SYNONYM pointing to another table/owner
      if (cols.length === 0) {
        const syn = await this.synonymTarget(conn, key, effectiveOwner);
        if (syn && (syn.tableName !== key || syn.tableOwner !== effectiveOwner)) {
          cols = await queryCols(syn.tableName.toUpperCase(), syn.tableOwner.toUpperCase());
        }
      }
      s.columns.set(key, cols);
      return cols;
    } catch (e) {
      this.log.debug(`Column load failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** Fetch PL/SQL specification and body from ALL_SOURCE for a package. */
  async packageSource(conn: Connection, name: string, owner?: string): Promise<string> {
    const pkg = name.toUpperCase();
    const own = (owner || (settings.schemaOwner === '%' ? 'FUSION' : settings.schemaOwner)).toUpperCase();
    const sql =
      `SELECT type, line, text FROM all_source WHERE owner = ${sqlString(own)} AND name = ${sqlString(pkg)}` +
      ` AND type IN ('PACKAGE', 'PACKAGE BODY') ORDER BY CASE WHEN type = 'PACKAGE' THEN 1 ELSE 2 END, line`;
    const client = await this.manager.clientFor(conn, true);
    const lines: { type: string; text: string }[] = [];
    let offset = 0;
    for (;;) {
      const page = await client.runSql(sql, { offset, limit: 5000 });
      for (const r of page.rows) {
        lines.push({ type: r[0], text: r[2] ?? '' });
      }
      if (!page.hasMore || page.rows.length === 0 || page.unpaged) {
        break;
      }
      offset += page.rows.length;
    }
    if (lines.length === 0) {
      return `-- No visible source in ALL_SOURCE for ${own}.${pkg}\n-- (Package body may be wrapped or you may lack visibility privileges.)\n`;
    }
    const spec = lines.filter((l) => l.type === 'PACKAGE').map((l) => l.text);
    const body = lines.filter((l) => l.type === 'PACKAGE BODY').map((l) => l.text);
    const sections: string[] = [];
    if (spec.length) {
      sections.push(`-- ============================================================\n-- PACKAGE SPECIFICATION: ${own}.${pkg}\n-- ============================================================\nCREATE OR REPLACE ${spec.join('\n')}\n/`);
    }
    if (body.length) {
      sections.push(`-- ============================================================\n-- PACKAGE BODY: ${own}.${pkg}\n-- ============================================================\nCREATE OR REPLACE ${body.join('\n')}\n/`);
    }
    return sections.join('\n\n') + '\n';
  }

  /** Resolve a synonym target from ALL_SYNONYMS. */
  async synonymTarget(conn: Connection, name: string, owner?: string): Promise<SynonymTarget | undefined> {
    const s = this.slot(conn.id);
    const key = name.toUpperCase();
    if (s.synonyms.has(key)) {
      return s.synonyms.get(key) ?? undefined;
    }
    const own = (owner || (settings.schemaOwner === '%' ? 'FUSION' : settings.schemaOwner)).toUpperCase();
    const sql = `SELECT owner, synonym_name, table_owner, table_name, db_link FROM all_synonyms WHERE synonym_name = ${sqlString(key)} AND owner IN (${sqlString(own)}, 'PUBLIC') ORDER BY CASE WHEN owner = ${sqlString(own)} THEN 1 ELSE 2 END`;
    try {
      const client = await this.manager.clientFor(conn, false);
      const page = await client.runSql(sql, { limit: 5 });
      if (page.rows.length === 0) {
        s.synonyms.set(key, null);
        return undefined;
      }
      const r = page.rows[0];
      const target: SynonymTarget = {
        synonymOwner: r[0],
        synonymName: r[1],
        tableOwner: r[2],
        tableName: r[3],
        dbLink: r[4] || undefined
      };
      s.synonyms.set(key, target);
      return target;
    } catch (e) {
      this.log.debug(`Synonym lookup failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
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
