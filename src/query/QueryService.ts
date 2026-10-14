import * as vscode from 'vscode';
import { Connection } from '../model';
import { ConnectionStore } from '../connections/ConnectionStore';
import { ConnectionManager } from '../connections/ConnectionManager';
import { HistoryStore } from '../history/HistoryStore';
import { ResultsView, RunRecord } from '../results/ResultsView';
import { FusionClient } from '../fusion/bip';
import { FusionError, errorMessage } from '../fusion/errors';
import { Logger, QueryPage } from '../fusion/types';
import { applyBinds, findBinds, prepareStatement, TypedBind } from '../sql/prepare';
import { BindField } from '../results/protocol';
import { oneLine, splitStatements, statementAt } from '../sql/lexer';
import { settings } from '../config';

const KEY_DOC_CONN = 'fusionSqlDev.docConnections';

export interface RunArgs {
  uri?: vscode.Uri;
  offset?: number;
}

/** Orchestrates "run this SQL": connection choice, binds, helper-report install, results and history. */
export class QueryService implements vscode.Disposable {
  private readonly running = new Set<string>();
  private readonly prodConfirmed = new Set<string>();
  private readonly lastBinds = new Map<string, BindField>();
  private readonly emitter = new vscode.EventEmitter<boolean>();
  /** fires with `true` while at least one query is in flight */
  readonly onDidChangeRunning = this.emitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly history: HistoryStore,
    private readonly results: ResultsView,
    private readonly log: Logger
  ) {
    const saved = ctx.globalState.get<number>('fusionSqlDev.rowLimit');
    if (saved) {
      results.rowLimitOverride = saved;
    }
  }

  setRowLimit(n: number): void {
    const v = Math.max(1, Math.min(1_000_000, Math.floor(n) || 1000));
    void this.ctx.globalState.update('fusionSqlDev.rowLimit', v);
    this.results.setRowLimit(v);
  }

  // ----------------------------------------------------------------- connection resolution

  private docConnections(): Record<string, string> {
    return this.ctx.workspaceState.get<Record<string, string>>(KEY_DOC_CONN, {});
  }

  connectionForDoc(uri: vscode.Uri | undefined): Connection | undefined {
    const id = uri ? this.docConnections()[uri.toString()] : undefined;
    return this.store.get(id) ?? this.store.active;
  }

  async bindDocToConnection(uri: vscode.Uri, id: string): Promise<void> {
    await this.ctx.workspaceState.update(KEY_DOC_CONN, { ...this.docConnections(), [uri.toString()]: id });
  }

  /** Resolve (or ask for) the connection to use for this editor. */
  async resolveConnection(uri: vscode.Uri | undefined): Promise<Connection | undefined> {
    const existing = this.connectionForDoc(uri);
    if (existing) {
      return existing;
    }
    const all = this.store.list();
    if (all.length === 0) {
      const pick = await vscode.window.showInformationMessage('No Fusion connection yet. Add one to run SQL.', 'Add Connection');
      if (pick) {
        await vscode.commands.executeCommand('fusionSqlDev.addConnection');
      }
      return this.store.active;
    }
    if (all.length === 1) {
      await this.store.setActive(all[0].id);
      return all[0];
    }
    const picked = await vscode.window.showQuickPick(
      all.map((c) => ({ label: c.name, description: `${c.environment} · ${c.url}`, id: c.id })),
      { title: 'Run on which connection?', placeHolder: 'Select a Fusion connection', ignoreFocusOut: true }
    );
    if (!picked) {
      return undefined;
    }
    await this.store.setActive(picked.id);
    return this.store.get(picked.id);
  }

  // ------------------------------------------------------------------------------- running

  private editorFor(args?: RunArgs): vscode.TextEditor | undefined {
    if (args?.uri) {
      return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === args.uri!.toString()) ?? vscode.window.activeTextEditor;
    }
    return vscode.window.activeTextEditor;
  }

  /** Ctrl+Enter / CodeLens: the selection, or the statement under the cursor. */
  async runStatement(args?: RunArgs): Promise<void> {
    const editor = this.editorFor(args);
    if (!editor) {
      void vscode.window.showInformationMessage('Open a SQL file (or use "Fusion SQL: New SQL Worksheet") first.');
      return;
    }
    const doc = editor.document;
    let text: string | undefined;
    if (args?.offset !== undefined) {
      text = statementAt(doc.getText(), args.offset, { blankLineEndsStatement: settings.blankLineEndsStatement })?.text;
    } else if (!editor.selection.isEmpty) {
      text = doc.getText(editor.selection);
    } else {
      text = statementAt(doc.getText(), doc.offsetAt(editor.selection.active), { blankLineEndsStatement: settings.blankLineEndsStatement })?.text;
    }
    if (!text || !text.trim()) {
      void vscode.window.showInformationMessage('Nothing to run here. Put the cursor inside a SQL statement.');
      return;
    }
    const statements = splitStatements(text, { blankLineEndsStatement: false }).filter((s) => s.hasCode);
    if (statements.length > 1 && !editor.selection.isEmpty) {
      await this.runMany(doc.uri, statements.map((s) => s.text));
      return;
    }
    await this.runMany(doc.uri, [text]);
  }

  /** F5: every statement in the selection (or the whole file), one result tab each. */
  async runScript(args?: RunArgs): Promise<void> {
    const editor = this.editorFor(args);
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const text = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
    const statements = splitStatements(text, { blankLineEndsStatement: settings.blankLineEndsStatement }).filter((s) => s.hasCode);
    if (statements.length === 0) {
      void vscode.window.showInformationMessage('No SQL statements found.');
      return;
    }
    await this.runMany(doc.uri, statements.map((s) => s.text));
  }

  async runMany(uri: vscode.Uri | undefined, statements: string[]): Promise<void> {
    const conn = await this.resolveConnection(uri);
    if (!conn) {
      return;
    }
    if (conn.environment === 'PROD' && !this.prodConfirmed.has(conn.id)) {
      const ok = await vscode.window.showWarningMessage(`You are about to run SQL against ${conn.name} (PROD).`, { modal: true, detail: 'Queries are read-only, but they still consume production resources. This confirmation appears once per session.' }, 'Run');
      if (ok !== 'Run') {
        return;
      }
      this.prodConfirmed.add(conn.id);
    }
    for (let i = 0; i < statements.length; i++) {
      const rec = await this.executeOne(conn, statements[i], statements.length > 1 ? `${i + 1}/${statements.length}` : undefined, i > 0);
      if (rec?.status === 'error' && statements.length > 1) {
        void vscode.window.showWarningMessage(`Script stopped at statement ${i + 1} of ${statements.length}.`);
        break;
      }
      if (rec?.status === 'cancelled') {
        break;
      }
    }
  }

  private async askBinds(sql: string): Promise<string | undefined> {
    const names = findBinds(sql);
    if (names.length === 0 || !settings.promptForBinds) {
      return sql;
    }
    const fields: BindField[] = names.map((name) => this.lastBinds.get(name) ?? { name, value: '', isNull: false, type: 'VARCHAR2' });
    const answer = await this.results.promptBinds(fields);
    if (!answer) {
      return undefined;
    }
    const values: Record<string, TypedBind> = {};
    for (const f of answer) {
      this.lastBinds.set(f.name, f);
      values[f.name] = { value: f.value, isNull: f.isNull, type: f.type };
    }
    return applyBinds(sql, values);
  }

  private setRunning(id: string, on: boolean): void {
    if (on) {
      this.running.add(id);
    } else {
      this.running.delete(id);
    }
    const any = this.running.size > 0;
    void vscode.commands.executeCommand('setContext', 'fusionSqlDev.queryRunning', any);
    this.emitter.fire(any);
  }

  private async executeOne(conn: Connection, original: string, tag?: string, keepOthers = false): Promise<RunRecord | undefined> {
    let effective: string;
    try {
      effective = prepareStatement(original).sql;
    } catch (e) {
      const rec = this.results.beginRun({ title: oneLine(original, 40), sql: original, executedSql: original, connectionId: conn.id, connectionName: conn.name, environment: conn.environment }, keepOthers);
      await this.results.reveal();
      this.finishWithError(rec, conn, original, e, Date.now());
      return rec;
    }
    let withBinds: string | undefined;
    try {
      withBinds = await this.askBinds(effective);
    } catch (e) {
      const rec = this.results.beginRun({ title: oneLine(original, 40), sql: original, executedSql: original, connectionId: conn.id, connectionName: conn.name, environment: conn.environment }, keepOthers);
      this.finishWithError(rec, conn, original, e, Date.now());
      return rec;
    }
    if (withBinds === undefined) {
      return undefined;
    }
    const rec = this.results.beginRun({
      title: (tag ? `${tag} ` : '') + oneLine(original, 36),
      sql: original,
      executedSql: withBinds,
      connectionId: conn.id,
      connectionName: conn.name,
      environment: conn.environment
    }, keepOthers);
    await this.results.reveal();
    this.setRunning(rec.id, true);
    const started = Date.now();
    try {
      const client = await this.manager.clientFor(conn);
      const want = this.results.rowLimit;
      const first = await this.runWithRuntime(client, conn, withBinds, 0, Math.min(want, settings.requestSize), rec.controller?.signal);
      const more = first.hasMore && first.rows.length < want;
      this.results.setRows(rec, first.columns, first.rows, first.hasMore, first.elapsedMs, false, first.unpaged ? 'Paging was not possible for this query (duplicate or unnamed columns) - all rows were returned.' : undefined, more);
      if (more) {
        try {
          await this.streamRows(client, rec, want - first.rows.length);
        } catch (e) {
          // keep what already arrived; just stop loading
          this.results.setLoading(rec, false);
          this.results.toast(e instanceof FusionError && e.kind === 'cancelled' ? 'Cancelled - showing the rows received so far.' : errorMessage(e), e instanceof FusionError && e.kind === 'cancelled' ? 'info' : 'error');
        }
      }
      const page = { rows: rec.rows };
      this.history.add({ sql: original, timestamp: started, durationMs: Date.now() - started, status: 'success', connectionId: conn.id, connectionName: conn.name, rowCount: page.rows.length });
      if (client.reportPath && client.reportPath !== conn.reportPath) {
        void this.store.patch(conn.id, { reportPath: client.reportPath });
      }
    } catch (e) {
      this.finishWithError(rec, conn, original, e, started);
    } finally {
      this.setRunning(rec.id, false);
    }
    return rec;
  }

  private finishWithError(rec: RunRecord, conn: Connection, original: string, e: unknown, started: number): void {
    if (e instanceof FusionError && e.kind === 'cancelled') {
      this.results.fail(rec, { message: 'Cancelled.', kind: 'cancelled' }, 'cancelled');
      return;
    }
    const fe = e instanceof FusionError ? e : undefined;
    this.log.error(`Query failed on ${conn.name}: ${errorMessage(e)}`);
    this.results.fail(rec, { message: fe?.message ?? errorMessage(e), hint: fe?.hint, kind: fe?.kind ?? 'unknown' });
    this.history.add({ sql: original, timestamp: started, durationMs: Date.now() - started, status: 'error', connectionId: conn.id, connectionName: conn.name, error: (fe?.message ?? errorMessage(e)).slice(0, 500) });
    if (fe && (fe.kind === 'auth' || fe.kind === 'sso')) {
      const actions = conn.auth === 'oauth' || conn.auth === 'browser' ? ['Sign In', 'Edit Connection'] : ['Edit Connection'];
      void vscode.window.showErrorMessage(`${conn.name}: ${fe.message}`, ...actions).then((pick) => {
        if (pick === 'Sign In') {
          void vscode.commands.executeCommand('fusionSqlDev.signIn', conn.id);
        } else if (pick === 'Edit Connection') {
          void vscode.commands.executeCommand('fusionSqlDev.editConnection', conn.id);
        }
      });
    }
  }

  // --------------------------------------------------------------------- helper report

  private async runWithRuntime(client: FusionClient, conn: Connection, sql: string, offset: number, limit: number, signal?: AbortSignal): Promise<QueryPage> {
    try {
      return await client.runSql(sql, { offset, limit, signal });
    } catch (e) {
      if (e instanceof FusionError && e.kind === 'runtime-missing') {
        if (await this.ensureRuntime(conn, client, signal)) {
          return client.runSql(sql, { offset, limit, signal });
        }
        throw new FusionError('runtime-missing', 'The helper BI Publisher report is not installed on this pod.', {
          hint: 'Run "Fusion SQL: Install / Repair Helper Report on Pod" (right-click the connection), or set fusionSqlDev.runtime.install to "auto".'
        });
      }
      throw e;
    }
  }

  /** Apply the install policy; returns true when the helper is now available. */
  async ensureRuntime(conn: Connection, client: FusionClient, signal?: AbortSignal, forceAsk = false): Promise<boolean> {
    const policy = settings.runtimeInstall;
    if (policy === 'never' && !forceAsk) {
      return false;
    }
    if (policy === 'ask' && conn.runtimeConsent !== 'granted' && !forceAsk) {
      const choice = await vscode.window.showInformationMessage(
        `Set up ${conn.name}?`,
        {
          modal: true,
          detail:
            `Fusion SQL DEV runs your SQL through a tiny BI Publisher report that it installs once into your own catalog folder (${client.catalogRoot}/FusionSqlDev). ` +
            `Nothing else on the pod is changed, and you can remove it any time.\n\nInstall it now?`
        },
        'Install'
      );
      if (choice !== 'Install') {
        await this.store.patch(conn.id, { runtimeConsent: 'declined' });
        return false;
      }
    }
    try {
      const path = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing helper report on ${conn.name}…` }, () => client.installRuntime(signal));
      await this.store.patch(conn.id, { runtimeConsent: 'granted', reportPath: path });
      void vscode.window.setStatusBarMessage(`Helper report installed: ${path}`, 6000);
      return true;
    } catch (e) {
      const fe = e instanceof FusionError ? e : undefined;
      this.log.error(`Helper install failed: ${errorMessage(e)}`);
      const pick = await vscode.window.showErrorMessage(`Could not install the helper report: ${fe?.message ?? errorMessage(e)}`, { detail: fe?.hint }, 'Use Catalog File…', 'Show Log');
      if (pick === 'Use Catalog File…') {
        void vscode.commands.executeCommand('fusionSqlDev.importRuntimeFile', conn.id);
      } else if (pick === 'Show Log') {
        void vscode.commands.executeCommand('fusionSqlDev.showLog');
      }
      throw e;
    }
  }

  // ----------------------------------------------------------------------- results actions

  /** Append up to `want` more rows to a run, in request-sized chunks, updating the grid as they arrive. */
  private async streamRows(client: FusionClient, rec: RunRecord, want: number): Promise<void> {
    let remaining = want;
    while (remaining > 0 && rec.hasMore) {
      const take = Math.min(remaining, settings.requestSize);
      const page = await client.runSql(rec.executedSql, { offset: rec.offset, limit: take, signal: rec.controller?.signal });
      remaining -= page.rows.length;
      const keep = page.hasMore && remaining > 0;
      this.results.setRows(rec, rec.columns.length ? rec.columns : page.columns, page.rows, page.hasMore, page.elapsedMs, true, undefined, keep);
      if (page.rows.length === 0) {
        break;
      }
    }
  }

  async fetchMore(runId: string, all: boolean): Promise<void> {
    const rec = this.results.get(runId);
    if (!rec || !rec.hasMore || rec.loading) {
      return;
    }
    const conn = this.store.get(rec.connectionId);
    if (!conn) {
      this.results.toast('The connection of this result no longer exists.', 'error');
      return;
    }
    rec.controller = new AbortController();
    this.results.setLoading(rec, true);
    this.setRunning(rec.id, true);
    try {
      const client = await this.manager.clientFor(conn);
      const room = Math.max(0, (all ? settings.maxRows : rec.rows.length + this.results.rowLimit) - rec.rows.length);
      if (room === 0) {
        this.results.setRows(rec, rec.columns, [], false, 0, true, `Stopped at ${settings.maxRows.toLocaleString()} rows (setting fusionSqlDev.maxRows).`);
      } else {
        await this.streamRows(client, rec, all ? room : this.results.rowLimit);
        if (all && rec.hasMore) {
          this.results.setRows(rec, rec.columns, [], true, 0, true, `Stopped at ${settings.maxRows.toLocaleString()} rows (setting fusionSqlDev.maxRows).`);
        }
      }
    } catch (e) {
      this.results.setLoading(rec, false);
      if (e instanceof FusionError && e.kind === 'cancelled') {
        this.results.toast('Fetch cancelled.');
      } else {
        this.results.toast(errorMessage(e), 'error');
      }
    } finally {
      this.setRunning(rec.id, false);
    }
  }

  cancel(runId?: string): void {
    if (runId) {
      this.results.get(runId)?.controller?.abort();
      return;
    }
    for (const r of this.results.all()) {
      if (r.loading) {
        r.controller?.abort();
      }
    }
  }

  async rerun(runId: string): Promise<void> {
    const rec = this.results.get(runId);
    const conn = rec && this.store.get(rec.connectionId);
    if (rec && conn) {
      await this.executeOne(conn, rec.sql);
    }
  }

  /** Run arbitrary SQL (history, schema "select top 100") on the current connection. */
  async runSqlText(sql: string, uri?: vscode.Uri): Promise<void> {
    await this.runMany(uri, [sql]);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
