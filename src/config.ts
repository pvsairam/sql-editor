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
    return cfg().get<'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'raw'>('results.dateFormat', 'raw');
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
  },
  get backgroundPollMs(): number {
    return Math.max(1, cfg().get<number>('background.pollIntervalSeconds', 3)) * 1000;
  },
  get backgroundMaxWaitMs(): number {
    return Math.max(30, cfg().get<number>('background.maxWaitSeconds', 1800)) * 1000;
  },
  get schemaMaxObjects(): number {
    return Math.max(2000, cfg().get<number>('schema.maxObjects', 100000));
  },
  get aiProvider(): 'auto' | 'openai' | 'ollama' {
    return cfg().get<'auto' | 'openai' | 'ollama'>('ai.provider', 'auto');
  },
  get aiEndpoint(): string {
    return cfg().get<string>('ai.endpoint', '').trim();
  },
  get aiModel(): string {
    return cfg().get<string>('ai.model', '').trim();
  },
  get aiMaxRepairAttempts(): number {
    return Math.max(1, Math.min(5, cfg().get<number>('ai.maxRepairAttempts', 3)));
  }
};
