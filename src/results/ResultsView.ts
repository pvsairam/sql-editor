import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { RunDTO, RunStatus, ToWebview, ViewSettings, FromWebview } from './protocol';
import { settings } from '../config';

export interface RunRecord {
  id: string;
  title: string;
  sql: string;
  connectionId: string;
  connectionName: string;
  environment: string;
  status: RunStatus;
  startedAt: number;
  elapsedMs: number;
  columns: string[];
  rows: string[][];
  hasMore: boolean;
  loading: boolean;
  error?: { message: string; hint?: string; kind: string };
  note?: string;
  /** Rows already requested from the server (offset for "fetch more"). */
  offset: number;
  controller?: AbortController;
  /** The statement as sent (after bind substitution), used by fetch-more / rerun. */
  executedSql: string;
  pinned?: boolean;
}

export interface ResultsHandlers {
  onMessage(msg: FromWebview): void | Promise<void>;
}

const MAX_RUNS = 12;

export class ResultsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'fusionSqlDev.results';
  private view?: vscode.WebviewView;
  private ready = false;
  private pending: ToWebview[] = [];
  private readonly runs = new Map<string, RunRecord>();
  private activeRunId?: string;
  private handlers?: ResultsHandlers;
  /** Row limit chosen in the Rows box (persisted by the caller); falls back to the setting. */
  rowLimitOverride?: number;
  private connection?: { name: string; environment: string };

  setConnection(c: { name: string; environment: string } | undefined): void {
    this.connection = c;
    this.post({ type: 'settings', settings: this.viewSettings() });
  }
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('fusionSqlDev.results') || e.affectsConfiguration('fusionSqlDev.fetchSize')) {
          this.post({ type: 'settings', settings: this.viewSettings() });
        }
      })
    );
  }

  setHandlers(h: ResultsHandlers): void {
    this.handlers = h;
  }

  private viewSettings(): ViewSettings {
    return { wrapText: settings.wrapText, maxCellLength: settings.maxCellLength, fetchSize: this.rowLimit, dateFormat: settings.dateFormat, connection: this.connection };
  }

  get rowLimit(): number {
    return this.rowLimitOverride ?? settings.fetchSize;
  }

  setRowLimit(n: number): void {
    this.rowLimitOverride = n;
    this.post({ type: 'settings', settings: this.viewSettings() });
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  all(): RunRecord[] {
    return [...this.runs.values()];
  }

  // ------------------------------------------------------------------- webview plumbing

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const root = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = this.html(view.webview, root);
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === 'ready') {
        this.ready = true;
        // `init` carries the complete current state, so queued run messages would only duplicate it; keep toasts.
        const toasts = this.pending.splice(0).filter((p) => p.type === 'toast');
        this.post({ type: 'init', runs: this.all().map((r) => this.dto(r)), activeRunId: this.activeRunId, settings: this.viewSettings() }, true);
        for (const p of toasts) {
          void this.view?.webview.postMessage(p);
        }
        return;
      }
      if (m.type === 'pin') {
        const r = this.runs.get(m.runId);
        if (r) {
          r.pinned = m.pinned;
        }
        return;
      }
      void this.handlers?.onMessage(m);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview', 'main.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'results.css'));
    const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}' ${webview.cspSource}`, `img-src ${webview.cspSource} data:`, `font-src ${webview.cspSource}`].join('; ');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Fusion SQL Results</title></head>
<body><div id="app"></div><script type="module" nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private post(msg: ToWebview, force = false): void {
    if (this.view && (this.ready || force)) {
      void this.view.webview.postMessage(msg);
    } else {
      this.pending.push(msg);
      if (this.pending.length > 200) {
        this.pending.splice(0, this.pending.length - 200);
      }
    }
  }

  async reveal(preserveFocus = true): Promise<void> {
    // The generated `<viewId>.focus` command also opens the panel when it is closed or collapsed.
    await vscode.commands.executeCommand(`${ResultsView.viewId}.focus`, { preserveFocus });
  }

  toast(text: string, level: 'info' | 'error' = 'info'): void {
    this.post({ type: 'toast', text, level });
  }

  // ------------------------------------------------------------------------- run lifecycle

  private dto(r: RunRecord): RunDTO {
    return {
      runId: r.id,
      title: r.title,
      sql: r.sql,
      connectionName: r.connectionName,
      environment: r.environment,
      status: r.status,
      startedAt: r.startedAt,
      elapsedMs: r.elapsedMs,
      columns: r.columns,
      rows: r.rows,
      hasMore: r.hasMore,
      loading: r.loading,
      error: r.error,
      note: r.note,
      pinned: r.pinned
    };
  }

  beginRun(init: Pick<RunRecord, 'title' | 'sql' | 'executedSql' | 'connectionId' | 'connectionName' | 'environment'>, keepOthers = false): RunRecord {
    const rec: RunRecord = {
      ...init,
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      status: 'running',
      startedAt: Date.now(),
      elapsedMs: 0,
      columns: [],
      rows: [],
      hasMore: false,
      loading: true,
      offset: 0,
      controller: new AbortController()
    };
    // Replace the previous (unpinned, finished) results instead of piling up tabs - like SQL Developer.
    const drop: string[] = [];
    if (settings.reuseTab && !keepOthers) {
      for (const r of this.runs.values()) {
        if (!r.pinned && r.status !== 'running' && !r.loading) {
          drop.push(r.id);
        }
      }
      drop.forEach((id) => this.runs.delete(id));
    }
    this.runs.set(rec.id, rec);
    while (this.runs.size > MAX_RUNS) {
      const oldest = [...this.runs.values()].find((r) => r.status !== 'running');
      if (!oldest) {
        break;
      }
      this.runs.delete(oldest.id);
    }
    this.activeRunId = rec.id;
    this.post({ type: 'run-start', run: this.dto(rec), drop });
    return rec;
  }

  setRows(rec: RunRecord, columns: string[], rows: string[][], hasMore: boolean, elapsedMs: number, append: boolean, note?: string, keepLoading = false): void {
    if (append) {
      for (const r of rows) {
        rec.rows.push(r);
      }
    } else {
      rec.columns = columns;
      rec.rows = rows.slice(); // never alias the array that is posted to the webview
    }
    rec.offset = rec.rows.length;
    rec.hasMore = hasMore;
    rec.elapsedMs = append ? rec.elapsedMs + elapsedMs : elapsedMs;
    rec.status = 'done';
    rec.loading = keepLoading;
    rec.error = undefined;
    if (note !== undefined) {
      rec.note = note;
    }
    this.post({ type: 'run-rows', runId: rec.id, columns, rows, append, hasMore, elapsedMs: rec.elapsedMs, note: rec.note });
    if (keepLoading) {
      this.post({ type: 'run-loading', runId: rec.id, loading: true });
    }
  }

  setLoading(rec: RunRecord, loading: boolean): void {
    rec.loading = loading;
    this.post({ type: 'run-loading', runId: rec.id, loading });
  }

  fail(rec: RunRecord, error: { message: string; hint?: string; kind: string }, status: RunStatus = 'error'): void {
    rec.status = rec.rows.length && status === 'cancelled' ? 'done' : status;
    rec.loading = false;
    rec.error = error;
    rec.elapsedMs = Date.now() - rec.startedAt;
    this.post({ type: 'run-error', runId: rec.id, status: rec.status, error, elapsedMs: rec.elapsedMs });
  }

  remove(runId: string): void {
    this.runs.get(runId)?.controller?.abort();
    this.runs.delete(runId);
  }

  clear(): void {
    for (const r of this.runs.values()) {
      r.controller?.abort();
    }
    this.runs.clear();
    this.activeRunId = undefined;
    this.post({ type: 'init', runs: [], settings: this.viewSettings() }, true);
  }

  focusRun(runId: string): void {
    this.activeRunId = runId;
    this.post({ type: 'focus-run', runId });
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
