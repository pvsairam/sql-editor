import * as vscode from 'vscode';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('fusionSqlDev');
}

export const settings = {
  get fetchSize(): number {
    return cfg().get<number>('fetchSize', 1000);
  },
  get requestSize(): number {
    return cfg().get<number>('requestSize', 5000);
  },
  get dateFormat(): 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'raw' {
    return cfg().get<'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'raw'>('results.dateFormat', 'MM/DD/YYYY');
  },
  get reuseTab(): boolean {
    return cfg().get<boolean>('results.reuseTab', true);
  },
  get maxRows(): number {
    return cfg().get<number>('maxRows', 100000);
  },
  get timeoutMs(): number {
    return cfg().get<number>('queryTimeoutSeconds', 300) * 1000;
  },
  get codeLens(): boolean {
    return cfg().get<boolean>('codeLens.enabled', true);
  },
  get blankLineEndsStatement(): boolean {
    return cfg().get<boolean>('blankLineEndsStatement', false);
  },
  get promptForBinds(): boolean {
    return cfg().get<boolean>('promptForBinds', true);
  },
  get runtimeInstall(): 'ask' | 'auto' | 'never' {
    return cfg().get<'ask' | 'auto' | 'never'>('runtime.install', 'ask');
  },
  get keywordCase(): 'upper' | 'lower' | 'preserve' {
    return cfg().get<'upper' | 'lower' | 'preserve'>('format.keywordCase', 'upper');
  },
  get indent(): number {
    return cfg().get<number>('format.indent', 2);
  },
  get completion(): boolean {
    return cfg().get<boolean>('completion.enabled', true);
  },
  get schemaOwner(): string {
    return cfg().get<string>('schema.owner', 'FUSION').trim().toUpperCase() || 'FUSION';
  },
  get historyMax(): number {
    return cfg().get<number>('history.maxEntries', 500);
  },
  get maxCellLength(): number {
    return cfg().get<number>('results.maxCellLength', 5000);
  },
  get wrapText(): boolean {
    return cfg().get<boolean>('results.wrapText', false);
  },
  get csvDelimiter(): string {
    return cfg().get<string>('export.csvDelimiter', ',');
  },
  get loopbackPort(): number {
    return cfg().get<number>('oauth.loopbackPort', 53682);
  },
  get redirectHost(): string {
    return cfg().get<string>('oauth.redirectHost', 'localhost');
  }
};
