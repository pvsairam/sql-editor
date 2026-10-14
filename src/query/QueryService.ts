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
import { promptBinds } from '../results/bindPanel';
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

  /** Table browser: columns (with PK + comments), constraints, indexes and the first rows, as four result tabs. */
  async openTable(owner: string, table: string): Promise<void> {
    const conn = this.store.active;
    if (!conn) {
      return;
    }
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const O = q(owner.toUpperCase());
    const T = q(table.toUpperCase());
    const sqls: [string, string][] = [
      [
        'Columns',
        `SELECT c.column_id AS "#", c.column_name AS "COLUMN", c.data_type || CASE WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR') THEN '(' || c.char_length || ')' WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN '(' || c.data_precision || CASE WHEN c.data_scale > 0 THEN ',' || c.data_scale END || ')' END AS "TYPE", CASE WHEN c.nullable = 'N' THEN 'NOT NULL' END AS "NULLABLE", CASE WHEN pk.column_name IS NOT NULL THEN 'PK' END AS "KEY", cc.comments AS "COMMENTS"
` +
          `FROM all_tab_columns c
LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
` +
          `LEFT JOIN (SELECT acc.owner, acc.table_name, acc.column_name FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name WHERE ac.constraint_type = 'P') pk ON pk.owner = c.owner AND pk.table_name = c.table_name AND pk.column_name = c.column_name
` +
          `WHERE c.owner = ${O} AND c.table_name = ${T}
ORDER BY c.column_id`
      ],
      [
        'Constraints',
        `SELECT ac.constraint_name AS "NAME", DECODE(ac.constraint_type, 'P', 'Primary key', 'U', 'Unique', 'R', 'Foreign key', 'C', 'Check', ac.constraint_type) AS "TYPE", (SELECT LISTAGG(acc.column_name, ', ') WITHIN GROUP (ORDER BY acc.position) FROM all_cons_columns acc WHERE acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name) AS "COLUMNS", ac.r_constraint_name AS "REFERENCES", ac.status AS "STATUS"
` +
          `FROM all_constraints ac
WHERE ac.owner = ${O} AND ac.table_name = ${T}
ORDER BY ac.constraint_type, ac.constraint_name`
      ],
      [
        'Indexes',
        `SELECT ai.index_name AS "NAME", ai.uniqueness AS "UNIQUENESS", (SELECT LISTAGG(aic.column_name, ', ') WITHIN GROUP (ORDER BY aic.column_position) FROM all_ind_columns aic WHERE aic.index_owner = ai.owner AND aic.index_name = ai.index_name) AS "COLUMNS", ai.status AS "STATUS"
` +
          `FROM all_indexes ai
WHERE ai.table_owner = ${O} AND ai.table_name = ${T}
ORDER BY ai.index_name`
      ],
      ['Data', `SELECT *
FROM ${owner}.${table}`]
    ];
    const recs = await Promise.all(sqls.map(([name, sql], i) => this.executeOne(conn, sql, undefined, i > 0, undefined, `[${name}] ${table}`)));
    if (recs[0]) {
      this.results.focusRun(recs[0].id);
    }
  }

  /** Run the statement under the cursor (or the selection) on several connections at once, one result tab per connection. */
  async runOnConnections(args?: RunArgs): Promise<void> {
    const editor = this.editorFor(args);
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const text = args?.offset !== undefined ? statementAt(doc.getText(), args.offset, { blankLineEndsStatement: settings.blankLineEndsStatement })?.text : !editor.selection.isEmpty ? doc.getText(editor.selection) : statementAt(doc.getText(), doc.offsetAt(editor.selection.active), { blankLineEndsStatement: settings.blankLineEndsStatement })?.text;
    if (!text?.trim()) {
      void vscode.window.showInformationMessage('Nothing to run here. Put the cursor inside a SQL statement.');
      return;
    }
    const all = this.store.list();
    if (all.length < 2) {
      void vscode.window.showInformationMessage('Add at least two connections to compare environments.');
      return;
    }
    const current = this.connectionForDoc(doc.uri);
    const picks = await vscode.window.showQuickPick(
      all.map((c) => ({ label: c.name, description: `${c.environment} · ${c.username}`, detail: c.url, picked: c.id === current?.id, id: c.id })),
      { canPickMany: true, title: 'Run on which connections?', placeHolder: 'Select two or more - results open side by side as separate tabs', ignoreFocusOut: true }
    );
    if (!picks || picks.length === 0) {
      return;
    }
    const conns = picks.map((p) => this.store.get(p.id)).filter((c): c is Connection => !!c);
    const prod = conns.filter((c) => c.environment === 'PROD' && !this.prodConfirmed.has(c.id));
    if (prod.length) {
      const ok = await vscode.window.showWarningMessage(`Run on ${prod.map((c) => c.name).join(', ')} (PROD)?`, { modal: true, detail: 'Queries are read-only, but they still consume production resources.' }, 'Run');
      if (ok !== 'Run') {
        return;
      }
      prod.forEach((c) => this.prodConfirmed.add(c.id));
    }
    let bound: string;
    try {
      const prepared = prepareStatement(text).sql;
      const asked = await this.askBinds(prepared);
      if (asked === undefined) {
        return;
      }
      bound = asked;
    } catch (e) {
      void vscode.window.showErrorMessage(errorMessage(e));
      return;
    }
    await Promise.all(conns.map((c, i) => this.executeOne(c, text, c.name, i > 0, bound)));
  }

  private async askBinds(sql: string): Promise<string | undefined> {
    const names = findBinds(sql);
    if (names.length === 0 || !settings.promptForBinds) {
      return sql;
    }
    const fields: BindField[] = names.map((name) => this.lastBinds.get(name) ?? { name, value: '', isNull: false, type: /(^|_)DATE$|^DATE_|_DATE_/.test(name) ? 'DATE' : 'VARCHAR2' });
    const answer = await promptBinds(this.ctx, fields);
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

  private async executeOne(conn: Connection, original: string, tag?: string, keepOthers = false, preBound?: string, titleOverride?: string): Promise<RunRecord | undefined> {
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
      withBinds = preBound ?? (await this.askBinds(effective));
    } catch (e) {
      const rec = this.results.beginRun({ title: oneLine(original, 40), sql: original, executedSql: original, connectionId: conn.id, connectionName: conn.name, environment: conn.environment }, keepOthers);
      this.finishWithError(rec, conn, original, e, Date.now());
      return rec;
    }
    if (withBinds === undefined) {
      return undefined;
    }
    const rec = this.results.beginRun({
      title: titleOverride ?? ((tag ? `[${tag}] ` : '') + oneLine(original, 36)),
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
