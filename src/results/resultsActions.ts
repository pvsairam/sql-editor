import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ResultsView } from './ResultsView';
import { FromWebview } from './protocol';
import { QueryService } from '../query/QueryService';
import { HistoryStore } from '../history/HistoryStore';
import { Logger } from '../fusion/types';
import { render, subset, toCsvText, toJson, Table } from './formats';
import { buildXlsx } from './xlsx';
import { settings } from '../config';
import { errorMessage } from '../fusion/errors';

/** Handles everything the results webview asks the host to do: clipboard, export, fetch-more, cancel ... */
export function registerResultsHandlers(results: ResultsView, query: QueryService, _history: HistoryStore, log: Logger): void {
  const tableOf = (runId: string, rowIdx: number[] | null, colIdx: number[] | null): { table: Table; sql: string } | undefined => {
    const rec = results.get(runId);
    if (!rec) {
      return undefined;
    }
    return { table: subset({ columns: rec.columns, rows: rec.rows }, rowIdx, colIdx), sql: rec.sql };
  };

  results.setHandlers({
    async onMessage(msg: FromWebview): Promise<void> {
      try {
        switch (msg.type) {
          case 'copy': {
            await vscode.env.clipboard.writeText(msg.text);
            results.toast(msg.label);
            break;
          }
          case 'copy-as': {
            const t = tableOf(msg.runId, msg.rowIdx, msg.colIdx);
            if (!t) {
              break;
            }
            const text = render(t.table, msg.format, { headers: msg.headers, sql: t.sql, delimiter: settings.csvDelimiter });
            await vscode.env.clipboard.writeText(text);
            results.toast(`Copied ${t.table.rows.length.toLocaleString()} row${t.table.rows.length === 1 ? '' : 's'} as ${msg.format.toUpperCase()}`);
            break;
          }
          case 'export': {
            const t = tableOf(msg.runId, msg.rowIdx, msg.colIdx);
            if (!t) {
              break;
            }
            await exportFile(t.table, msg.format);
            break;
          }
          case 'switch-connection':
            await vscode.commands.executeCommand('fusionSqlDev.pickConnection', msg.id);
            break;
          case 'set-fetch-size':
            query.setRowLimit(msg.value);
            break;
          case 'fetch-more':
            await query.fetchMore(msg.runId, msg.all);
            break;
          case 'cancel':
            query.cancel(msg.runId);
            break;
          case 'rerun':
            await query.rerun(msg.runId);
            break;
          case 'open-sql': {
            const rec = results.get(msg.runId);
            if (rec) {
              const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: rec.sql.trimEnd() + ';\n' });
              await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
            }
            break;
          }
          case 'close-run':
            results.remove(msg.runId);
            break;
          case 'log':
            log.debug(`[webview] ${msg.text}`);
            break;
        }
      } catch (e) {
        log.error(`Results action failed: ${errorMessage(e)}`);
        results.toast(errorMessage(e), 'error');
      }
    }
  });
}

async function exportFile(table: Table, format: 'csv' | 'xlsx' | 'json'): Promise<void> {
  const ext = format;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(base, `fusion-query-${stamp}.${ext}`)),
    filters: format === 'xlsx' ? { 'Excel workbook': ['xlsx'] } : format === 'csv' ? { 'CSV (UTF-8)': ['csv'] } : { JSON: ['json'] },
    title: `Export ${table.rows.length.toLocaleString()} rows`
  });
  if (!target) {
    return;
  }
  let data: Uint8Array;
  if (format === 'xlsx') {
    data = buildXlsx(table);
  } else if (format === 'csv') {
    // UTF-8 BOM so Excel detects the encoding of non-ASCII names.
    data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(toCsvText(table, true, settings.csvDelimiter), 'utf8')]);
  } else {
    data = Buffer.from(toJson(table), 'utf8');
  }
  await vscode.workspace.fs.writeFile(target, data);
  const pick = await vscode.window.showInformationMessage(`Exported ${table.rows.length.toLocaleString()} rows to ${path.basename(target.fsPath)}`, 'Open', 'Reveal in Folder');
  if (pick === 'Open') {
    await vscode.commands.executeCommand('vscode.open', target);
  } else if (pick === 'Reveal in Folder') {
    await vscode.commands.executeCommand('revealFileInOS', target);
  }
}
