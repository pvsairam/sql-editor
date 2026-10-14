import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryEntry } from '../model';
import { Logger } from '../fusion/types';
import { settings } from '../config';

/** Query history persisted as JSON in the extension's global storage (survives updates, never contains passwords). */
export class HistoryStore {
  private entries: HistoryEntry[] = [];
  private file: string;
  private timer?: NodeJS.Timeout;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    ctx: vscode.ExtensionContext,
    private readonly log: Logger
  ) {
    fs.mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
    this.file = path.join(ctx.globalStorageUri.fsPath, 'history.json');
    this.load();
    this.importLegacy();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as HistoryEntry[];
        this.entries = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      this.log.warn(`History file unreadable, starting empty: ${(e as Error).message}`);
      this.entries = [];
    }
  }

  /** One-time import of ~/FusionDev/history.json written by version 1.x. */
  private importLegacy(): void {
    const legacy = path.join(os.homedir(), 'FusionDev', 'history.json');
    const marker = this.file + '.legacy-imported';
    try {
      if (fs.existsSync(marker) || !fs.existsSync(legacy)) {
        return;
      }
      const old = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Partial<HistoryEntry & { executionTimeMs: number }>[];
      for (const o of old) {
        if (o.sql && o.timestamp) {
          this.entries.push({
            id: String(o.id ?? o.timestamp),
            sql: o.sql,
            timestamp: o.timestamp,
            durationMs: o.executionTimeMs ?? 0,
            status: o.status === 'error' ? 'error' : 'success',
            connectionName: o.connectionName ?? ''
          });
        }
      }
      this.entries.sort((a, b) => b.timestamp - a.timestamp);
      fs.writeFileSync(marker, '1');
      this.persist();
    } catch (e) {
      this.log.warn(`Legacy history import failed: ${(e as Error).message}`);
    }
  }

  all(): HistoryEntry[] {
    return this.entries;
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  add(e: Omit<HistoryEntry, 'id'>): HistoryEntry {
    const entry: HistoryEntry = { ...e, id: `${e.timestamp}-${Math.random().toString(36).slice(2, 8)}` };
    // Collapse immediate re-runs of the same statement on the same connection into one entry.
    const dup = this.entries.findIndex((x) => x.sql === entry.sql && x.connectionName === entry.connectionName && !x.starred && entry.timestamp - x.timestamp < 60_000);
    if (dup >= 0) {
      this.entries.splice(dup, 1);
    }
    this.entries.unshift(entry);
    this.trim();
    this.persist();
    return entry;
  }

  toggleStar(id: string): void {
    const e = this.get(id);
    if (e) {
      e.starred = !e.starred;
      this.persist();
    }
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.persist();
  }

  clear(keepStarred = true): void {
    this.entries = keepStarred ? this.entries.filter((e) => e.starred) : [];
    this.persist();
  }

  private trim(): void {
    const max = settings.historyMax;
    if (this.entries.length > max) {
      // Never drop starred entries.
      const starred = this.entries.filter((e) => e.starred);
      const rest = this.entries.filter((e) => !e.starred).slice(0, Math.max(0, max - starred.length));
      this.entries = [...starred, ...rest].sort((a, b) => b.timestamp - a.timestamp);
    }
  }

  private persist(): void {
    this.emitter.fire();
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.entries), 'utf8');
    } catch (e) {
      this.log.warn(`Could not save history: ${(e as Error).message}`);
    }
  }

  dispose(): void {
    this.flush();
    this.emitter.dispose();
  }
}
