import * as vscode from 'vscode';
import { ConnectionStore } from './connections/ConnectionStore';
import { QueryService } from './query/QueryService';

/** Status-bar entry: active connection (click to switch) and a spinner while a query runs (click to cancel). */
export class StatusBarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private running = false;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    query: QueryService
  ) {
    this.subs = [
      store.onDidChange(() => this.render()),
      query.onDidChangeRunning((r) => {
        this.running = r;
        this.render();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.render())
    ];
    this.render();
  }

  private render(): void {
    const c = this.store.active;
    const inSql = vscode.window.activeTextEditor?.document.languageId === 'sql';
    if (!c && !inSql) {
      this.item.hide();
      return;
    }
    if (this.running) {
      this.item.text = `$(sync~spin) Running on ${c?.name ?? '…'}`;
      this.item.tooltip = 'A query is running. Click to cancel.';
      this.item.command = 'fusionSqlDev.cancelQuery';
      this.item.backgroundColor = undefined;
    } else if (c) {
      this.item.text = `$(database) ${c.name} · ${c.environment}`;
      this.item.tooltip = `${c.url}\nUser: ${c.username}\nClick to switch connection`;
      this.item.command = 'fusionSqlDev.switchConnection';
      this.item.backgroundColor = c.environment === 'PROD' ? new vscode.ThemeColor('statusBarItem.errorBackground') : c.environment === 'UAT' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    } else {
      this.item.text = '$(database) Fusion SQL: no connection';
      this.item.tooltip = 'Click to add a connection';
      this.item.command = 'fusionSqlDev.addConnection';
      this.item.backgroundColor = undefined;
    }
    this.item.show();
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.item.dispose();
  }
}
