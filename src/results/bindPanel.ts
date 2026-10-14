import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { BindField } from './protocol';

/** Bind-variable dialog: a centred editor-area tab (a webview cannot draw outside its own panel). */
export function promptBinds(ctx: vscode.ExtensionContext, binds: BindField[]): Promise<BindField[] | undefined> {
  return new Promise((resolve) => {
    const root = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('fusionSqlDev.binds', 'Bind Variables', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, localResourceRoots: [root] });
    panel.iconPath = vscode.Uri.joinPath(root, 'icon.png');
    const nonce = randomBytes(16).toString('hex');
    const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview', 'bind.js'));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'bind.css'));
    const csp = [`default-src 'none'`, `style-src ${panel.webview.cspSource}`, `script-src 'nonce-${nonce}' ${panel.webview.cspSource}`].join('; ');
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Bind Variables</title></head><body><div id="app"></div><script type="module" nonce="${nonce}" src="${js}"></script></body></html>`;
    let answered = false;
    const finish = (v: BindField[] | undefined) => {
      if (!answered) {
        answered = true;
        resolve(v);
      }
      panel.dispose();
    };
    panel.webview.onDidReceiveMessage((m: { type: string; values?: BindField[] }) => {
      if (m.type === 'ready') {
        void panel.webview.postMessage({ type: 'init', binds });
      } else if (m.type === 'submit') {
        finish(m.values);
      } else if (m.type === 'cancel') {
        finish(undefined);
      }
    });
    panel.onDidDispose(() => finish(undefined));
  });
}
