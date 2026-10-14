import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/ConnectionStore';
import { QueryService } from '../query/QueryService';
import { splitStatements } from './lexer';
import { settings } from '../config';

export class FusionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    store: ConnectionStore,
    private readonly query: QueryService
  ) {
    this.subs = [store.onDidChange(() => this.emitter.fire()), vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('fusionSqlDev') && this.emitter.fire())];
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!settings.codeLens || doc.lineCount > 5000) {
      return [];
    }
    const statements = splitStatements(doc.getText(), { blankLineEndsStatement: settings.blankLineEndsStatement }).filter((s) => s.hasCode);
    if (statements.length === 0) {
      return [];
    }
    const conn = this.query.connectionForDoc(doc.uri);
    const lenses: vscode.CodeLens[] = [];
    const first = doc.positionAt(statements[0].start);
    lenses.push(
      new vscode.CodeLens(new vscode.Range(first, first), {
        title: conn ? `$(plug) ${conn.name} · ${conn.environment}` : '$(plug) Select connection',
        tooltip: 'Switch the connection used by this file',
        command: 'fusionSqlDev.switchConnection',
        arguments: [{ uri: doc.uri }]
      })
    );
    for (const s of statements) {
      const pos = doc.positionAt(s.start);
      const range = new vscode.Range(pos, pos);
      lenses.push(new vscode.CodeLens(range, { title: '$(play) Run', tooltip: 'Run this statement (Ctrl+Enter)', command: 'fusionSqlDev.runStatement', arguments: [{ uri: doc.uri, offset: s.start }] }));
      if (statements.length > 1 && s === statements[0]) {
        lenses.push(new vscode.CodeLens(range, { title: '$(run-all) Run Script', tooltip: 'Run every statement in this file (F5)', command: 'fusionSqlDev.runScript', arguments: [{ uri: doc.uri }] }));
      }
    }
    return lenses;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
