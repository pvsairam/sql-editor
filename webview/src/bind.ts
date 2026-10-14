import { BindField, BindType } from './protocol.js';
import { el } from './util.js';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {} };
const app = document.getElementById('app')!;

function render(binds: BindField[]): void {
  app.textContent = '';
  const card = el('div', 'dialog');
  const head = el('div', 'dialog-head');
  head.append(el('span', 'dialog-title', 'Bind Variables'));
  const grid = el('div', 'bind-grid');
  for (const h of ['Parameter Name', 'Parameter Value', 'Is Null', 'Data Type']) {
    grid.append(el('div', 'bind-h', h));
  }
  const rows = binds.map((b) => {
    const name = el('div', 'bind-name', ':' + b.name);
    const value = el('input', 'bind-value');
    value.value = b.value;
    const nul = el('input', 'bind-null');
    nul.type = 'checkbox';
    nul.checked = b.isNull;
    nul.title = 'Bind NULL';
    const type = el('select', 'bind-type');
    for (const t of ['VARCHAR2', 'NUMBER', 'DATE', 'TIMESTAMP'] as BindType[]) {
      const o = el('option', undefined, t);
      o.value = t;
      type.append(o);
    }
    type.value = b.type;
    const hint = () => {
      value.placeholder = type.value === 'DATE' || type.value === 'TIMESTAMP' ? 'YYYY-MM-DD  or  MM/DD/YYYY' : type.value === 'NUMBER' ? 'number' : '';
      value.disabled = nul.checked;
      value.classList.toggle('disabled', nul.checked);
    };
    nul.addEventListener('change', hint);
    type.addEventListener('change', hint);
    hint();
    const nc = el('div', 'bind-cell');
    nc.append(nul);
    grid.append(name, value, nc, type);
    return { b, value, nul, type };
  });
  const submit = () => vscode.postMessage({ type: 'submit', values: rows.map((r) => ({ name: r.b.name, value: r.value.value, isNull: r.nul.checked, type: r.type.value })) });
  const foot = el('div', 'dialog-foot');
  const cancel = el('button', 'btn secondary', 'Cancel');
  const clear = el('button', 'btn secondary', 'Clear');
  const run = el('button', 'btn primary', 'Execute');
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  clear.addEventListener('click', () => rows.forEach((r) => { r.value.value = ''; r.nul.checked = false; r.value.disabled = false; r.value.classList.remove('disabled'); }));
  run.addEventListener('click', submit);
  foot.append(cancel, clear, run);
  card.append(head, grid, foot);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      vscode.postMessage({ type: 'cancel' });
    }
  });
  app.append(card);
  rows[0]?.value.focus();
}

window.addEventListener('message', (e: MessageEvent<{ type: string; binds: BindField[] }>) => {
  if (e.data.type === 'init') {
    render(e.data.binds);
  }
});
vscode.postMessage({ type: 'ready' });
