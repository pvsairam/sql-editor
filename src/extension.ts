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
import { splitStatements, statementAt } from './sql/lexer';
import { KEY_AI_RULES, getAiRules, registerChatParticipant } from './ai/chatParticipant';
import { AI_API_KEY_SECRET } from './ai/llmClient';
import { validateAndRepairSql } from './ai/repair';
import { diffTables, guessKeyColumns } from './results/diff';
import { SavedQueriesStore } from './saved/SavedQueriesStore';
import { SavedQueriesTree, SavedQueryNode } from './saved/savedQueriesTree';
import { parseImportedConnections, serializeConnectionsForExport } from './connections/exportImport';
import { StatusBarController } from './statusBar';
import { Connection, FusionContext, HistoryEntry, SavedQuery } from './model';
import { errorMessage, FusionError } from './fusion/errors';
import { settings } from './config';
import { SHARED_CATALOG_ROOT, buildCatalogArchive, buildCatalogFile, buildRuntime } from './fusion/runtime';

const DOCS = 'https://github.com/pvsairam/sql-editor/blob/main/docs';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const log = new OutputLogger();
  const store = new ConnectionStore(ctx, log);
  const manager = new ConnectionManager(store, log, ctx.globalStorageUri.fsPath);
  const history = new HistoryStore(ctx, log);
  const savedQueries = new SavedQueriesStore(ctx);
  const schema = new SchemaService(manager, log, ctx.globalStorageUri.fsPath);
  const results = new ResultsView(ctx);
  const query = new QueryService(ctx, store, manager, history, results, log);
  registerResultsHandlers(results, query, history, log);

  ctx.subscriptions.push(log, store, manager, history, savedQueries, results, query);

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
  const savedQueriesTree = new SavedQueriesTree(savedQueries);
  const schemaTree = new SchemaTree(store, schema);
  ctx.subscriptions.push(
    connectionTree,
    historyTree,
    savedQueriesTree,
    schemaTree,
    vscode.window.createTreeView('fusionSqlDev.connections', { treeDataProvider: connectionTree, showCollapseAll: false }),
    vscode.window.createTreeView('fusionSqlDev.schema', { treeDataProvider: schemaTree }),
    vscode.window.createTreeView('fusionSqlDev.savedQueries', { treeDataProvider: savedQueriesTree }),
    vscode.window.createTreeView('fusionSqlDev.history', { treeDataProvider: historyTree }),
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
    registerChatParticipant(ctx, store, manager, schema, results, log)
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
  reg('fusionSqlDev.runStatementBackground', (args?: { uri?: vscode.Uri; offset?: number }) => query.runStatementBackground(args));
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
    let catalogRoot = c.catalogRoot ?? `/~${c.username}`;
    if (!c.catalogRoot) {
      const targetPick = await vscode.window.showQuickPick(
        [
          { label: `Personal folder (/~${c.username})`, description: 'Only for your user (Catalog → My Folders → Unarchive)', root: `/~${c.username}` },
          { label: `Shared team folder (${SHARED_CATALOG_ROOT})`, description: 'Deploy once for your whole team (Catalog → Shared Folders → Custom → Unarchive)', root: SHARED_CATALOG_ROOT }
        ],
        { title: 'Where will this helper catalog be uploaded?', ignoreFocusOut: true }
      );
      if (targetPick) {
        catalogRoot = targetPick.root;
      }
    }
    const spec = { catalogRoot, dataSource: c.dataSource || 'ApplicationDB_FSCM' };
    const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(require('path').join(require('os').homedir(), 'Downloads')), openLabel: 'Save helper files here', title: 'Choose a folder for the helper files' });
    if (!folder) {
      return;
    }
    const art = buildRuntime(spec);
    const out = (n: string) => vscode.Uri.joinPath(folder[0], n);
    await vscode.workspace.fs.writeFile(out('dm.xdmz'), art.dataModelZip);
    await vscode.workspace.fs.writeFile(out('csv.xdoz'), art.reportZip);
    await vscode.workspace.fs.writeFile(out('FusionSqlDevHelper.catalog'), buildCatalogFile(spec, c.username));
    await vscode.workspace.fs.writeFile(out('FusionSqlDevHelper.xdrz'), buildCatalogArchive(spec));
    const dir = `${spec.catalogRoot}/FusionSqlDev/v2`;
    const where = catalogRoot.startsWith(SHARED_CATALOG_ROOT) ? 'Catalog → Shared Folders → Custom → Unarchive' : 'Catalog → My Folders → Unarchive';
    const pick = await vscode.window.showInformationMessage(`Saved FusionSqlDevHelper.catalog (use ${where}) plus dm.xdmz / csv.xdoz as a fallback (Upload into ${dir}). Then use Test Connection.`, 'Reveal Files', 'Test Connection');
    if (pick === 'Reveal Files') {
      await vscode.commands.executeCommand('revealFileInOS', out('csv.xdoz'));
    } else if (pick === 'Test Connection') {
      await vscode.commands.executeCommand('fusionSqlDev.testConnection', c.id);
    }
  });
  reg('fusionSqlDev.refreshConnections', () => connectionTree.refresh());

  reg('fusionSqlDev.exportConnections', async () => {
    const all = store.list();
    if (all.length === 0) {
      void vscode.window.showInformationMessage('No connections to export.');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(require('path').join(require('os').homedir(), 'fusion-sql-connections.json')),
      filters: { JSON: ['json'] },
      title: 'Export Connections (Secret-Free JSON)'
    });
    if (!target) {
      return;
    }
    const json = serializeConnectionsForExport(all);
    await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
    void vscode.window.showInformationMessage(`Exported ${all.length} connection${all.length === 1 ? '' : 's'} without secrets.`);
  });

  reg('fusionSqlDev.importConnections', async () => {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { JSON: ['json'] },
      title: 'Import Connections (JSON)'
    });
    if (!files?.[0]) {
      return;
    }
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8');
      const { connections: incoming, skipped } = parseImportedConnections(raw);
      if (incoming.length === 0) {
        void vscode.window.showWarningMessage('No valid connections found in that file.');
        return;
      }
      const existing = store.list();
      const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
      let added = 0;
      let updated = 0;
      for (const c of incoming) {
        const match = byName.get(c.name.toLowerCase());
        if (match) {
          await store.save({ ...match, ...c, id: match.id, reportPath: match.reportPath, runtimeConsent: match.runtimeConsent });
          updated++;
        } else {
          await store.save(c);
          added++;
        }
      }
      if (!store.activeId && incoming[0]) {
        await store.setActive(incoming[0].id);
      }
      void vscode.window.showInformationMessage(
        `Imported ${added} new and updated ${updated} connection(s)${skipped ? ` (${skipped} invalid skipped)` : ''}. Passwords and SSO sessions are not stored in export files — sign in or edit credentials when ready.`
      );
    } catch (e) {
      handleError('Import connections failed', e);
    }
  });

  // ------------------------------------------------------------------------ schema commands
  reg('fusionSqlDev.refreshSchema', () => schema.refresh(store.activeId));
  reg('fusionSqlDev.searchObjects', async () => {
    const c = store.active;
    if (!c) {
      return;
    }
    const v = await vscode.window.showInputBox({ title: 'Search tables, views, synonyms & packages', prompt: 'Part of a name, e.g. PER_ALL or %ASSIGN%. Filters the full cached schema instantly. Leave empty to clear.', value: schema.filterFor(c.id), ignoreFocusOut: true });
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
  reg('fusionSqlDev.viewPackageSource', async (node?: ObjectNode) => {
    const c = store.active;
    if (!c) {
      return;
    }
    const name = node?.obj?.name ?? (await vscode.window.showInputBox({ title: 'View Package Source', prompt: 'Enter Oracle package name (from ALL_SOURCE)', ignoreFocusOut: true }));
    if (!name?.trim()) {
      return;
    }
    try {
      const src = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading package source ${name.toUpperCase()}…` },
        () => schema.packageSource(c, name.trim(), node?.obj?.owner)
      );
      await openSqlDocument(src, c.id);
    } catch (e) {
      handleError(`Could not load package ${name}`, e);
    }
  });
  reg('fusionSqlDev.inspectSynonym', async (node?: ObjectNode) => {
    const c = store.active;
    if (!c) {
      return;
    }
    const name = node?.obj?.name ?? (await vscode.window.showInputBox({ title: 'Inspect Synonym Target', prompt: 'Enter Oracle synonym name (from ALL_SYNONYMS)', ignoreFocusOut: true }));
    if (!name?.trim()) {
      return;
    }
    try {
      const target = await schema.synonymTarget(c, name.trim(), node?.obj?.owner);
      if (!target) {
        void vscode.window.showInformationMessage(`No target found in ALL_SYNONYMS for ${name.toUpperCase()}.`);
        return;
      }
      const qualified = `${target.tableOwner}.${target.tableName}${target.dbLink ? `@${target.dbLink}` : ''}`;
      const pick = await vscode.window.showInformationMessage(`${target.synonymOwner}.${target.synonymName} → ${qualified}`, 'Open Target Table', 'Copy Target');
      if (pick === 'Open Target Table') {
        await query.openTable(target.tableOwner, target.tableName);
      } else if (pick === 'Copy Target') {
        await vscode.env.clipboard.writeText(qualified.toLowerCase());
      }
    } catch (e) {
      handleError(`Could not inspect synonym ${name}`, e);
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

  // ------------------------------------------------------------------ saved queries commands
  const savedOf = (arg: unknown): SavedQuery | undefined => (arg instanceof SavedQueryNode ? arg.query : typeof arg === 'string' ? savedQueries.get(arg) : undefined);

  reg('fusionSqlDev.saveQuery', async (sqlArg?: string) => {
    let sql = typeof sqlArg === 'string' ? sqlArg.trim() : '';
    if (!sql) {
      const editor = vscode.window.activeTextEditor?.document.languageId === 'sql' ? vscode.window.activeTextEditor : vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'sql');
      if (editor) {
        sql = !editor.selection.isEmpty
          ? editor.document.getText(editor.selection).trim()
          : (statementAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active))?.text ?? editor.document.getText()).trim();
      }
    }
    if (!sql) {
      void vscode.window.showInformationMessage('Open a SQL worksheet with a query to save.');
      return;
    }
    const name = await vscode.window.showInputBox({ title: 'Save Query', prompt: 'Query name (e.g. Active Employees by BU)', ignoreFocusOut: true });
    if (!name?.trim()) {
      return;
    }
    const folder = await vscode.window.showInputBox({ title: 'Folder (optional)', prompt: 'Group under a folder name (e.g. HCM, GL, AP) or leave empty', ignoreFocusOut: true });
    await savedQueries.add({ name: name.trim(), folder: folder?.trim() || undefined, sql });
    void vscode.window.setStatusBarMessage(`Saved query "${name.trim()}"`, 3000);
  });

  reg('fusionSqlDev.openSavedQuery', async (arg?: unknown) => {
    const q = savedOf(arg);
    if (q) {
      await openSqlDocument(q.sql.trimEnd() + ';\n');
    }
  });

  reg('fusionSqlDev.runSavedQuery', async (arg?: unknown) => {
    const q = savedOf(arg);
    if (q) {
      await query.runSqlText(q.sql);
    }
  });

  reg('fusionSqlDev.renameSavedQuery', async (arg?: unknown) => {
    const q = savedOf(arg);
    if (!q) {
      return;
    }
    const name = await vscode.window.showInputBox({ title: 'Rename Saved Query', value: q.name, ignoreFocusOut: true });
    if (name?.trim()) {
      await savedQueries.update(q.id, { name: name.trim() });
    }
  });

  reg('fusionSqlDev.deleteSavedQuery', async (arg?: unknown) => {
    const q = savedOf(arg);
    if (!q) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Delete saved query "${q.name}"?`, { modal: true }, 'Delete');
    if (ok === 'Delete') {
      await savedQueries.delete(q.id);
    }
  });

  // ------------------------------------------------------------------- compare / diff results
  reg('fusionSqlDev.compareResults', async () => {
    const done = results.all().filter((r) => r.status === 'done' && r.columns.length > 0);
    if (done.length < 2) {
      void vscode.window.showInformationMessage('Run at least two queries (or use "Run Statement on Multiple Connections") to compare results.');
      return;
    }
    let left = done[done.length - 2];
    let right = done[done.length - 1];
    if (done.length > 2) {
      const pickLeft = await vscode.window.showQuickPick(
        done.map((r) => ({ label: r.title, description: `${r.connectionName} · ${r.rows.length} rows`, id: r.id })),
        { title: 'Compare Results (1/2): Select baseline (Left)', ignoreFocusOut: true }
      );
      if (!pickLeft) {
        return;
      }
      const remaining = done.filter((r) => r.id !== pickLeft.id);
      const pickRight = await vscode.window.showQuickPick(
        remaining.map((r) => ({ label: r.title, description: `${r.connectionName} · ${r.rows.length} rows`, id: r.id })),
        { title: 'Compare Results (2/2): Select target (Right)', ignoreFocusOut: true }
      );
      if (!pickRight) {
        return;
      }
      left = done.find((r) => r.id === pickLeft.id)!;
      right = done.find((r) => r.id === pickRight.id)!;
    }
    const guessed = guessKeyColumns(left.columns, right.columns);
    const diff = diffTables(
      { columns: left.columns, rows: left.rows },
      { columns: right.columns, rows: right.rows },
      { leftLabel: left.title, rightLabel: right.title, keyColumns: guessed }
    );
    results.addStaticResult({
      title: `[DIFF] ${left.connectionName} vs ${right.connectionName}`,
      sql: `-- ${diff.summary}\n${left.sql}`,
      connectionName: `${left.connectionName} ↔ ${right.connectionName}`,
      environment: 'OTHER',
      columns: diff.columns,
      rows: diff.rows,
      note: diff.summary
    });
    await results.reveal();
  });

  // ----------------------------------------------------------------------- AI & context commands
  reg('fusionSqlDev.validateAndRepairSql', async (sqlArg?: string) => {
    const conn = query.currentConnection() ?? store.active;
    if (!conn) {
      void vscode.window.showInformationMessage('Select an active Fusion connection first.');
      return;
    }
    const editor = vscode.window.activeTextEditor?.document.languageId === 'sql' ? vscode.window.activeTextEditor : vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'sql');
    let sql = typeof sqlArg === 'string' ? sqlArg.trim() : '';
    if (!sql && editor) {
      sql = !editor.selection.isEmpty
        ? editor.document.getText(editor.selection).trim()
        : (statementAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active))?.text ?? '').trim();
    }
    if (!sql) {
      void vscode.window.showInformationMessage('Put the cursor inside a SELECT statement to validate.');
      return;
    }
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Validating SQL on ${conn.name}…`, cancellable: true },
        async (progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return validateAndRepairSql({
            ctx,
            conn,
            sql,
            manager,
            schema,
            log,
            signal: ac.signal,
            onStatus: (m) => progress.report({ message: m })
          });
        }
      );
      if (res.ok) {
        const warnText = res.warnings.length ? ` (${res.warnings.length} safety note${res.warnings.length === 1 ? '' : 's'})` : '';
        if (res.repaired) {
          const pick = await vscode.window.showInformationMessage(
            `Auto-repaired and validated on ${conn.name} in ${res.attempts.length} attempts (${res.sampleRowCount ?? 0} sample rows)${warnText}.`,
            'Open Repaired SQL',
            'Run Now'
          );
          if (pick === 'Open Repaired SQL') {
            await openSqlDocument(res.sql + ';\n', conn.id);
          } else if (pick === 'Run Now') {
            await query.runSqlText(res.sql);
          }
        } else {
          void vscode.window.showInformationMessage(`SQL validated cleanly on ${conn.name} (${res.sampleRowCount ?? 0} sample rows)${warnText}.`);
        }
      } else {
        void vscode.window.showWarningMessage(`Validation failed after ${res.attempts.length} attempt(s): ${res.error ?? 'Unknown error'}`);
      }
    } catch (e) {
      handleError('Validate & Auto-Repair failed', e);
    }
  });

  reg('fusionSqlDev.editFusionContext', async (arg?: unknown) => {
    const c = await pickConnection(arg, 'Configure Fusion context (COA / Ledger / BU) for which connection?');
    if (!c) {
      return;
    }
    const prev: FusionContext = c.fusionContext ?? {};
    const coaSegments = await vscode.window.showInputBox({
      title: `${c.name} — Chart of Accounts Segments`,
      prompt: 'Describe SEGMENT1..N (e.g. SEGMENT1=Company, SEGMENT2=Department, SEGMENT3=Account). Leave empty to omit.',
      value: prev.coaSegments ?? '',
      ignoreFocusOut: true
    });
    if (coaSegments === undefined) {
      return;
    }
    const ledger = await vscode.window.showInputBox({
      title: `${c.name} — Default Ledger`,
      prompt: 'e.g. US Primary Ledger (LEDGER_ID=300000001234)',
      value: prev.ledger ?? '',
      ignoreFocusOut: true
    });
    if (ledger === undefined) {
      return;
    }
    const businessUnit = await vscode.window.showInputBox({
      title: `${c.name} — Default Business Unit`,
      prompt: 'e.g. US1 Business Unit (BU_ID=300000005678)',
      value: prev.businessUnit ?? '',
      ignoreFocusOut: true
    });
    if (businessUnit === undefined) {
      return;
    }
    const calendar = await vscode.window.showInputBox({
      title: `${c.name} — Accounting Calendar / Period Format`,
      prompt: 'e.g. Monthly Calendar (JAN-26, FEB-26)',
      value: prev.calendar ?? '',
      ignoreFocusOut: true
    });
    if (calendar === undefined) {
      return;
    }
    const notes = await vscode.window.showInputBox({
      title: `${c.name} — Additional Pod Notes for @fusion AI`,
      prompt: 'Any custom DFFs, org conventions, or table preferences',
      value: prev.notes ?? '',
      ignoreFocusOut: true
    });
    if (notes === undefined) {
      return;
    }
    const next: FusionContext = {
      coaSegments: coaSegments.trim() || undefined,
      ledger: ledger.trim() || undefined,
      businessUnit: businessUnit.trim() || undefined,
      calendar: calendar.trim() || undefined,
      notes: notes.trim() || undefined
    };
    const empty = !next.coaSegments && !next.ledger && !next.businessUnit && !next.calendar && !next.notes;
    await store.patch(c.id, { fusionContext: empty ? undefined : next });
    void vscode.window.showInformationMessage(`Updated Fusion AI context for ${c.name}.`);
  });

  reg('fusionSqlDev.manageAiRules', async () => {
    const rules = getAiRules(ctx);
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(add) Add a new SQL rule…', description: 'Injected into every @fusion prompt', idx: -1 },
        ...rules.map((r, idx) => ({ label: r, description: 'Click to remove', idx }))
      ],
      { title: 'Remembered @fusion AI SQL Rules', ignoreFocusOut: true }
    );
    if (!pick) {
      return;
    }
    if (pick.idx === -1) {
      const rule = await vscode.window.showInputBox({
        title: 'Add AI SQL Rule',
        prompt: 'e.g. Always filter business unit to US1 BU, or always alias GL_CODE_COMBINATIONS as gcc',
        ignoreFocusOut: true
      });
      if (rule?.trim()) {
        await ctx.globalState.update(KEY_AI_RULES, [...rules, rule.trim()]);
        void vscode.window.showInformationMessage('AI SQL rule saved.');
      }
    } else {
      const next = rules.filter((_, i) => i !== pick.idx);
      await ctx.globalState.update(KEY_AI_RULES, next);
      void vscode.window.showInformationMessage('AI SQL rule removed.');
    }
  });

  reg('fusionSqlDev.setAiApiKey', async () => {
    const key = await vscode.window.showInputBox({
      title: 'Set AI API Key (OpenAI / Azure OpenAI / Compatible)',
      prompt: 'Stored securely in VS Code SecretStorage. Leave empty to clear.',
      password: true,
      ignoreFocusOut: true
    });
    if (key === undefined) {
      return;
    }
    if (key.trim()) {
      await ctx.secrets.store(AI_API_KEY_SECRET, key.trim());
      void vscode.window.showInformationMessage('AI API key saved in VS Code SecretStorage.');
    } else {
      await ctx.secrets.delete(AI_API_KEY_SECRET);
      void vscode.window.showInformationMessage('AI API key cleared.');
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
