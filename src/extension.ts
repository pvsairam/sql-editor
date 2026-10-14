import * as vscode from 'vscode';
import { OutputLogger } from './log';
import { ConnectionStore } from './connections/ConnectionStore';
import { ConnectionManager } from './connections/ConnectionManager';
import { ConnectionItem, ConnectionTree } from './connections/connectionTree';
import { openConnectionForm } from './connections/connectionPanel';
import { HistoryStore } from './history/HistoryStore';
import { EntryNode, HistoryTree } from './history/historyTree';
import { SchemaService } from './schema/SchemaService';
import { ColumnNode, ObjectNode, SchemaTree } from './schema/schemaTree';
import { ResultsView } from './results/ResultsView';
import { registerResultsHandlers } from './results/resultsActions';
import { QueryService } from './query/QueryService';
import { FusionCodeLensProvider } from './sql/codelens';
import { FusionCompletionProvider, FusionHoverProvider } from './sql/completion';
import { formatSql } from './sql/format';
import { splitStatements } from './sql/lexer';
import { registerChatParticipant } from './ai/chatParticipant';
import { StatusBarController } from './statusBar';
import { Connection, HistoryEntry } from './model';
import { errorMessage, FusionError } from './fusion/errors';
import { settings } from './config';
import { buildCatalogArchive, buildRuntime } from './fusion/runtime';

const DOCS = 'https://github.com/pvsairam/sql-editor/blob/main/docs';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const log = new OutputLogger();
  const store = new ConnectionStore(ctx, log);
  const manager = new ConnectionManager(store, log, ctx.globalStorageUri.fsPath);
  const history = new HistoryStore(ctx, log);
  const schema = new SchemaService(manager, log);
  const results = new ResultsView(ctx);
  const query = new QueryService(ctx, store, manager, history, results, log);
  registerResultsHandlers(results, query, history, log);

  ctx.subscriptions.push(log, store, manager, history, results, query);

  // ------------------------------------------------------------------ one-time migration
  void store.migrateLegacy().then((n) => {
    if (n > 0) {
      void vscode.window.showInformationMessage(`Fusion SQL DEV 2: imported ${n} connection${n === 1 ? '' : 's'} from the previous version. Passwords moved to secure storage.`);
    }
  });
  void vscode.commands.executeCommand('setContext', 'fusionSqlDev.hasActiveConnection', !!store.activeId);
  void vscode.commands.executeCommand('setContext', 'fusionSqlDev.queryRunning', false);

  // ----------------------------------------------------------------------------- views
  const connectionTree = new ConnectionTree(store, manager);
  const historyTree = new HistoryTree(history);
  const schemaTree = new SchemaTree(store, schema);
  ctx.subscriptions.push(
    connectionTree,
    historyTree,
    schemaTree,
    vscode.window.createTreeView('fusionSqlDev.connections', { treeDataProvider: connectionTree, showCollapseAll: false }),
    vscode.window.createTreeView('fusionSqlDev.history', { treeDataProvider: historyTree }),
    vscode.window.createTreeView('fusionSqlDev.schema', { treeDataProvider: schemaTree }),
    vscode.window.registerWebviewViewProvider(ResultsView.viewId, results, { webviewOptions: { retainContextWhenHidden: true } }),
    new StatusBarController(store, query)
  );

  // -------------------------------------------------------------------- language features
  const sqlSelector: vscode.DocumentSelector = [{ language: 'sql' }, { language: 'plsql' }];
  const lens = new FusionCodeLensProvider(store, query);
  ctx.subscriptions.push(
    lens,
    vscode.languages.registerCodeLensProvider(sqlSelector, lens),
    vscode.languages.registerCompletionItemProvider(sqlSelector, new FusionCompletionProvider(store, schema), '.', ' '),
    vscode.languages.registerHoverProvider(sqlSelector, new FusionHoverProvider(store, schema)),
    vscode.languages.registerDocumentFormattingEditProvider(sqlSelector, {
      provideDocumentFormattingEdits: (doc) => [vscode.TextEdit.replace(fullRange(doc), formatScript(doc.getText()))]
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(sqlSelector, {
      provideDocumentRangeFormattingEdits: (doc, range) => [vscode.TextEdit.replace(range, formatScript(doc.getText(range)).trimEnd())]
    }),
    registerChatParticipant(ctx, store, schema, results, log)
  );

  const syncChip = () => {
    const cur = query.currentConnection();
    results.setConnection(
      cur ? { name: cur.name, environment: cur.environment } : undefined,
      store.list().map((c) => ({ id: c.id, name: c.name, environment: c.environment, active: c.id === cur?.id }))
    );
  };
  syncChip();
  ctx.subscriptions.push(store.onDidChange(syncChip), query.onDidChangeBindings(syncChip), vscode.window.onDidChangeActiveTextEditor(syncChip));

  // keep clients fresh when settings change
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fusionSqlDev')) {
        manager.invalidate();
        if (e.affectsConfiguration('fusionSqlDev.schema.owner')) {
          schema.refresh();
        }
      }
    }),
    store.onDidChange(() => manager.invalidate())
  );

  // ---------------------------------------------------------------------------- helpers
  const pickConnection = async (arg: unknown, placeHolder = 'Select a connection'): Promise<Connection | undefined> => {
    if (typeof arg === 'string') {
      return store.get(arg);
    }
    if (arg instanceof ConnectionItem) {
      return arg.conn;
    }
    if (arg && typeof arg === 'object' && 'conn' in arg) {
      return (arg as { conn: Connection }).conn;
    }
    const all = store.list();
    if (all.length === 0) {
      const add = await vscode.window.showInformationMessage('No connections yet.', 'Add Connection');
      if (add) {
        await vscode.commands.executeCommand('fusionSqlDev.addConnection');
      }
      return undefined;
    }
    if (all.length === 1) {
      return all[0];
    }
    const p = await vscode.window.showQuickPick(
      all.map((c) => ({ label: c.name, description: `${c.environment} · ${c.url}`, id: c.id })),
      { placeHolder, ignoreFocusOut: true }
    );
    return p ? store.get(p.id) : undefined;
  };

  const handleError = (title: string, e: unknown): void => {
    if (e instanceof FusionError && e.kind === 'cancelled') {
      return;
    }
    const fe = e instanceof FusionError ? e : undefined;
    log.error(`${title}: ${errorMessage(e)}`);
    void vscode.window.showErrorMessage(`${title}: ${fe?.message ?? errorMessage(e)}`, { detail: fe?.hint }, 'Show Log').then((p) => {
      if (p) {
        log.show();
      }
    });
  };

  const openSqlDocument = async (sql: string, connId?: string): Promise<vscode.TextEditor> => {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const id = connId ?? store.activeId;
    if (id) {
      await query.bindDocToConnection(doc.uri, id);
    }
    return editor;
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ------------------------------------------------------------------------ run commands
  reg('fusionSqlDev.runStatement', (args?: { uri?: vscode.Uri; offset?: number }) => query.runStatement(args));
  reg('fusionSqlDev.runOnConnections', (args?: { uri?: vscode.Uri; offset?: number }) => query.runOnConnections(args));
  reg('fusionSqlDev.runScript', (args?: { uri?: vscode.Uri }) => query.runScript(args));
  reg('fusionSqlDev.cancelQuery', () => query.cancel());
  reg('fusionSqlDev.runSqlText', (sql: string) => query.runSqlText(sql));
  reg('fusionSqlDev.showResults', () => results.reveal(false));
  reg('fusionSqlDev.showLog', () => log.show());
  reg('fusionSqlDev.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:fusion-dev.fusion-sql-dev'));

  reg('fusionSqlDev.newWorksheet', async () => {
    // Blank, numbered like SQL Developer: "Worksheet 1", "Worksheet 2", ... (an untitled doc is named after its first line, so no header comments).
    const used = new Set(vscode.workspace.textDocuments.map((d) => d.uri.path));
    let n = 1;
    while (used.has(`Worksheet ${n}.sql`) || used.has(`/Worksheet ${n}.sql`)) {
      n++;
    }
    const uri = vscode.Uri.from({ scheme: 'untitled', path: `Worksheet ${n}.sql` });
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (store.activeId) {
      await query.bindDocToConnection(doc.uri, store.activeId);
    }
    void editor;
  });
  reg('fusionDevAssistant.start', () => vscode.commands.executeCommand('fusionSqlDev.newWorksheet'));

  reg('fusionSqlDev.insertSql', async (sql: string) => {
    const editor = vscode.window.activeTextEditor?.document.languageId === 'sql' ? vscode.window.activeTextEditor : vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'sql');
    if (!editor) {
      await openSqlDocument(sql + '\n');
      return;
    }
    await editor.edit((b) => b.insert(editor.selection.active, sql + '\n'));
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  });

  reg('fusionSqlDev.formatSql', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const sel = editor.selection;
    const range = sel.isEmpty ? fullRange(editor.document) : sel;
    const out = formatScript(editor.document.getText(range));
    await editor.edit((b) => b.replace(range, sel.isEmpty ? out : out.trimEnd()));
  });

  // ------------------------------------------------------------------- connection commands
  reg('fusionSqlDev.addConnection', () => openConnectionForm(ctx, store, manager, log));

  reg('fusionSqlDev.editConnection', async (arg?: unknown) => {
    const c = await pickConnection(arg, 'Which connection do you want to edit?');
    if (c) {
      openConnectionForm(ctx, store, manager, log, c);
    }
  });

  reg('fusionSqlDev.duplicateConnection', async (arg?: unknown) => {
    const c = await pickConnection(arg);
    if (!c) {
      return;
    }
    const copy: Connection = { ...c, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: `${c.name} (copy)`, reportPath: undefined, createdAt: Date.now() };
    await store.save(copy);
    const pw = await store.getPassword(c.id);
    if (pw) {
      await store.setPassword(copy.id, pw);
    }
    const cs = await store.getClientSecret(c.id);
    if (cs) {
      await store.setClientSecret(copy.id, cs);
    }
  });

  reg('fusionSqlDev.deleteConnection', async (arg?: unknown) => {
    const c = await pickConnection(arg, 'Which connection do you want to delete?');
    if (!c) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Delete connection "${c.name}"?`, { modal: true, detail: 'Stored passwords and tokens are removed too. The helper report on the pod is left untouched.' }, 'Delete');
    if (ok === 'Delete') {
      await store.delete(c.id);
      manager.invalidate(c.id);
      schema.refresh(c.id);
    }
  });

  reg('fusionSqlDev.setActiveConnection', async (arg?: unknown) => {
    const c = await pickConnection(arg);
    if (!c) {
      return;
    }
    await store.setActive(c.id);
    schema.refresh(c.id);
    void vscode.window.setStatusBarMessage(`Active connection: ${c.name}`, 3000);
  });

  /** Used by the results-toolbar dropdown: apply a connection to the SQL editor in view and make it active. */
  reg('fusionSqlDev.pickConnection', async (id?: string) => {
    if (!id) {
      await vscode.commands.executeCommand('fusionSqlDev.switchConnection');
      return;
    }
    const sqlEditor = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'sql');
    if (sqlEditor) {
      await query.bindDocToConnection(sqlEditor.document.uri, id);
    }
    await store.setActive(id);
    schema.refresh(id);
  });
  reg('fusionSqlDev.switchConnection', async (arg?: { uri?: vscode.Uri }) => {
    const all = store.list();
    if (all.length === 0) {
      await vscode.commands.executeCommand('fusionSqlDev.addConnection');
      return;
    }
    const current = query.connectionForDoc(arg?.uri ?? vscode.window.activeTextEditor?.document.uri);
    const picked = await vscode.window.showQuickPick(
      [
        ...all.map((c) => ({ label: `${c.id === current?.id ? '$(check) ' : ''}${c.name}`, description: `${c.environment} · ${c.username}`, detail: c.url, id: c.id })),
        { label: '$(add) Add connection…', description: '', detail: '', id: '__add' }
      ],
      { title: 'Switch connection', placeHolder: 'Run this file on…', matchOnDetail: true }
    );
    if (!picked) {
      return;
    }
    if (picked.id === '__add') {
      await vscode.commands.executeCommand('fusionSqlDev.addConnection');
      return;
    }
    const uri = arg?.uri ?? vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      await query.bindDocToConnection(uri, picked.id);
    }
    await store.setActive(picked.id);
    schema.refresh(picked.id);
  });

  reg('fusionSqlDev.testConnection', async (arg?: unknown) => {
    const c = await pickConnection(arg, 'Test which connection?');
    if (!c) {
      return;
    }
    try {
      const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing ${c.name}…`, cancellable: true }, async (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        const client = await manager.clientFor(c);
        const r = await client.test(() => query.ensureRuntime(c, client, ac.signal).catch(() => false), ac.signal);
        if (r.reportPath && r.reportPath !== c.reportPath) {
          await store.patch(c.id, { reportPath: r.reportPath });
        }
        return r;
      });
      if (res.ok) {
        void vscode.window.showInformationMessage(`${c.name}: ${res.message} (${res.latencyMs} ms)`);
      } else {
        const fe = res.error;
        const pick = await vscode.window.showWarningMessage(`${c.name}: ${res.message}`, { detail: fe?.hint }, ...(fe?.kind === 'sso' || fe?.kind === 'auth' ? ['Edit Connection'] : []), ...(res.authenticated && !res.runtimeReady ? ['Install Helper'] : []));
        if (pick === 'Edit Connection') {
          await vscode.commands.executeCommand('fusionSqlDev.editConnection', c.id);
        } else if (pick === 'Install Helper') {
          await vscode.commands.executeCommand('fusionSqlDev.installRuntime', c.id);
        }
      }
    } catch (e) {
      handleError(`Test failed for ${c.name}`, e);
    }
  });

  reg('fusionSqlDev.signIn', async (arg?: unknown) => {
    const c = await pickConnection(arg, 'Sign in to which connection?');
    if (!c) {
      return;
    }
    try {
      if (await manager.signIn(c)) {
        void vscode.window.showInformationMessage(`Signed in to ${c.name}.`);
      }
    } catch (e) {
      handleError(`Sign-in to ${c.name} failed`, e);
    }
  });

  reg('fusionSqlDev.signOut', async (arg?: unknown) => {
    const c = await pickConnection(arg);
    if (c) {
      await manager.signOut(c);
      void vscode.window.showInformationMessage(`Signed out of ${c.name}.`);
    }
  });

  reg('fusionSqlDev.setToken', async (arg?: unknown) => {
    const c = await pickConnection(arg);
    if (c) {
      await manager.setToken(c);
    }
  });

  reg('fusionSqlDev.installRuntime', async (arg?: unknown) => {
    const c = await pickConnection(arg, 'Install the helper report on which pod?');
    if (!c) {
      return;
    }
    try {
      const client = await manager.clientFor(c);
      const path = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing helper report on ${c.name}…`, cancellable: true }, (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return client.installRuntime(ac.signal);
      });
      await store.patch(c.id, { reportPath: path, runtimeConsent: 'granted' });
      void vscode.window.showInformationMessage(`Helper report installed at ${path}`);
    } catch (e) {
      handleError('Helper install failed', e);
    }
  });

  reg('fusionSqlDev.importRuntimeFile', async (arg?: unknown) => {
    const c = await pickConnection(arg, 'Install the catalog file on which pod?');
    if (!c) {
      return;
    }
    const file = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'BI Publisher catalog archive': ['xdrz', 'zip'] }, title: 'Select FusionQueryProxy.xdrz (or any archive containing a .xdmz and a .xdoz)' });
    if (!file?.[0]) {
      return;
    }
    try {
      const buf = Buffer.from(await vscode.workspace.fs.readFile(file[0]));
      const client = await manager.clientFor(c);
      const path = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing catalog file on ${c.name}…` }, () => client.installRuntimeFromArchive(buf));
      await store.patch(c.id, { reportPath: path, runtimeConsent: 'granted' });
      void vscode.window.showInformationMessage(`Helper installed at ${path}`);
    } catch (e) {
      handleError('Could not install the catalog file', e);
    }
  });

  reg('fusionSqlDev.saveHelperFile', async (arg?: unknown) => {
    const c = await pickConnection(arg, 'Create the helper file for which connection?');
    if (!c) {
      return;
    }
    const spec = { catalogRoot: c.catalogRoot ?? `/~${c.username}`, dataSource: c.dataSource || 'ApplicationDB_FSCM' };
    const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(require('path').join(require('os').homedir(), 'Downloads')), openLabel: 'Save helper files here', title: 'Choose a folder for the helper files' });
    if (!folder) {
      return;
    }
    const art = buildRuntime(spec);
    const out = (n: string) => vscode.Uri.joinPath(folder[0], n);
    await vscode.workspace.fs.writeFile(out('dm.xdmz'), art.dataModelZip);
    await vscode.workspace.fs.writeFile(out('csv.xdoz'), art.reportZip);
    await vscode.workspace.fs.writeFile(out('FusionSqlDevHelper.xdrz'), buildCatalogArchive(spec));
    const dir = `${spec.catalogRoot}/FusionSqlDev/v2`;
    const pick = await vscode.window.showInformationMessage(`Saved dm.xdmz and csv.xdoz. In BI Publisher: Catalog → open ${dir} (create the folders FusionSqlDev and v2 if missing) → Upload: dm.xdmz as a Data Model, then csv.xdoz as a Report. Then use Test Connection.`, 'Reveal Files', 'Test Connection');
    if (pick === 'Reveal Files') {
      await vscode.commands.executeCommand('revealFileInOS', out('csv.xdoz'));
    } else if (pick === 'Test Connection') {
      await vscode.commands.executeCommand('fusionSqlDev.testConnection', c.id);
    }
  });
  reg('fusionSqlDev.refreshConnections', () => connectionTree.refresh());

  // ------------------------------------------------------------------------ schema commands
  reg('fusionSqlDev.refreshSchema', () => schema.refresh(store.activeId));
  reg('fusionSqlDev.searchObjects', async () => {
    const c = store.active;
    if (!c) {
      return;
    }
    const v = await vscode.window.showInputBox({ title: 'Search tables & views', prompt: 'Part of a name, e.g. PER_ALL or %ASSIGN%. Leave empty to list everything (first 2,000).', value: schema.filterFor(c.id), ignoreFocusOut: true });
    if (v !== undefined) {
      await schema.setFilter(c, v);
    }
  });
  reg('fusionSqlDev.clearObjectFilter', async () => {
    const c = store.active;
    if (c) {
      await schema.setFilter(c, '');
    }
  });
  reg('fusionSqlDev.openTable', async (node: ObjectNode) => {
    if (node?.obj) {
      await query.openTable(node.obj.owner, node.obj.name);
    }
  });
  reg('fusionSqlDev.selectFromObject', async (node: ObjectNode) => {
    const o = node?.obj;
    if (!o) {
      return;
    }
    const sql = `SELECT *\nFROM ${o.owner}.${o.name}\nFETCH FIRST 100 ROWS ONLY`;
    const editor = await openSqlDocument(sql + ';\n');
    await query.runStatement({ uri: editor.document.uri, offset: 0 });
  });
  reg('fusionSqlDev.insertObjectName', async (node: ObjectNode | ColumnNode) => {
    const name = node instanceof ObjectNode ? node.obj.name.toLowerCase() : node instanceof ColumnNode ? node.col.name.toLowerCase() : '';
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'sql');
    if (name && editor) {
      await editor.edit((b) => b.insert(editor.selection.active, name));
    } else if (name) {
      await vscode.env.clipboard.writeText(name);
      void vscode.window.setStatusBarMessage(`Copied ${name} (no SQL editor open)`, 3000);
    }
  });
  reg('fusionSqlDev.copyObjectName', async (node: ObjectNode | ColumnNode) => {
    const name = node instanceof ObjectNode ? node.obj.name : node instanceof ColumnNode ? node.col.name : '';
    if (name) {
      await vscode.env.clipboard.writeText(name.toLowerCase());
      void vscode.window.setStatusBarMessage(`Copied ${name.toLowerCase()}`, 2500);
    }
  });

  // ----------------------------------------------------------------------- history commands
  const entryOf = (arg: unknown): HistoryEntry | undefined => (arg instanceof EntryNode ? arg.entry : undefined);
  reg('fusionSqlDev.openHistoryItem', async (arg: unknown) => {
    const e = entryOf(arg);
    if (e) {
      await openSqlDocument(e.sql.trimEnd() + ';\n', e.connectionId && store.get(e.connectionId) ? e.connectionId : undefined);
    }
  });
  reg('fusionSqlDev.runHistoryItem', async (arg: unknown) => {
    const e = entryOf(arg);
    if (e) {
      await query.runSqlText(e.sql);
    }
  });
  reg('fusionSqlDev.copyHistoryItem', async (arg: unknown) => {
    const e = entryOf(arg);
    if (e) {
      await vscode.env.clipboard.writeText(e.sql);
      void vscode.window.setStatusBarMessage('SQL copied', 2500);
    }
  });
  reg('fusionSqlDev.starHistoryItem', (arg: unknown) => {
    const e = entryOf(arg);
    if (e) {
      history.toggleStar(e.id);
    }
  });
  reg('fusionSqlDev.deleteHistoryItem', (arg: unknown) => {
    const e = entryOf(arg);
    if (e) {
      history.remove(e.id);
    }
  });
  reg('fusionSqlDev.searchHistory', async () => {
    const v = await vscode.window.showInputBox({ title: 'Search history', prompt: 'Text in the SQL or the connection name. Empty clears the filter.', ignoreFocusOut: true });
    if (v !== undefined) {
      historyTree.setFilter(v);
    }
  });
  reg('fusionSqlDev.clearHistory', async () => {
    const ok = await vscode.window.showWarningMessage('Clear query history?', { modal: true, detail: 'Starred queries are kept.' }, 'Clear');
    if (ok === 'Clear') {
      history.clear(true);
    }
  });

  // ------------------------------------------------------------------------- first run UX
  if (store.list().length === 0 && !ctx.globalState.get<boolean>('fusionSqlDev.welcomed')) {
    await ctx.globalState.update('fusionSqlDev.welcomed', true);
    void vscode.window.showInformationMessage('Fusion SQL DEV is ready. Add your first Oracle Fusion connection to start running SQL.', 'Add Connection', 'Read the SSO guide').then((p) => {
      if (p === 'Add Connection') {
        void vscode.commands.executeCommand('fusionSqlDev.addConnection');
      } else if (p) {
        void vscode.env.openExternal(vscode.Uri.parse(`${DOCS}/SSO.md`));
      }
    });
  }
  log.info(`Fusion SQL DEV ${ctx.extension.packageJSON.version as string} activated`);
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

/** Format every statement of a script, keeping `;` terminators and blank lines between statements. */
export function formatScript(text: string): string {
  const stmts = splitStatements(text);
  if (stmts.length === 0) {
    return text;
  }
  const opts = { indent: settings.indent, keywordCase: settings.keywordCase };
  return stmts.map((s) => (s.hasCode ? formatSql(s.text, opts).trimEnd() + ';' : s.text)).join('\n\n') + '\n';
}

export function deactivate(): void {
  // disposables are registered on the context
}
