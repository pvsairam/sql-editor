import * as vscode from 'vscode';
import { SavedQuery } from '../model';

const KEY_SAVED = 'fusionSqlDev.savedQueries';

/** Persistent store for reusable user-saved Fusion SQL queries / snippets. */
export class SavedQueriesStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  list(): SavedQuery[] {
    return this.ctx.globalState.get<SavedQuery[]>(KEY_SAVED, []);
  }

  get(id: string): SavedQuery | undefined {
    return this.list().find((q) => q.id === id);
  }

  async add(init: { name: string; sql: string; folder?: string; description?: string }): Promise<SavedQuery> {
    const now = Date.now();
    const item: SavedQuery = {
      id: `sq${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: init.name.trim(),
      folder: init.folder?.trim() || undefined,
      description: init.description?.trim() || undefined,
      sql: init.sql,
      createdAt: now,
      updatedAt: now
    };
    const all = [...this.list(), item];
    await this.ctx.globalState.update(KEY_SAVED, all);
    this.emitter.fire();
    return item;
  }

  async update(id: string, patch: Partial<Pick<SavedQuery, 'name' | 'folder' | 'description' | 'sql'>>): Promise<void> {
    const all = this.list().map((q) => (q.id === id ? { ...q, ...patch, updatedAt: Date.now() } : q));
    await this.ctx.globalState.update(KEY_SAVED, all);
    this.emitter.fire();
  }

  async delete(id: string): Promise<void> {
    const all = this.list().filter((q) => q.id !== id);
    await this.ctx.globalState.update(KEY_SAVED, all);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
