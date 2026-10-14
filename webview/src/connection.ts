import { el } from './util.js';

interface FormData {
  name: string;
  environment: 'DEV' | 'TEST' | 'UAT' | 'PROD' | 'OTHER';
  auth: 'basic' | 'oauth' | 'token';
  url: string;
  username: string;
  password: string;
  issuer: string;
  clientId: string;
  scope: string;
  flow: 'authorization_code' | 'device_code' | 'client_credentials';
  clientSecret: string;
  tokenKind: 'bearer' | 'cookie';
  token: string;
  dataSource: string;
  catalogRoot: string;
  allowInsecureTls: boolean;
}
type ToForm =
  | { type: 'init'; id: string; editing: boolean; form: FormData; hasPassword: boolean; hasSecret: boolean; hasToken: boolean; redirectUrl: string }
  | { type: 'validation'; ok: boolean; title: string; detail?: string; steps?: { label: string; ok: boolean }[] }
  | { type: 'busy'; busy: boolean };

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {} };
const app = document.getElementById('app')!;

let form: FormData;
let editing = false;
let hasPassword = false;
let hasSecret = false;
let hasToken = false;
let redirectUrl = '';
const banner = el('div', 'banner hidden');
let busyEl: HTMLElement | undefined;
let buttons: HTMLButtonElement[] = [];

function field(label: string, input: HTMLElement, opts: { required?: boolean; hint?: string; cls?: string } = {}): HTMLElement {
  const w = el('div', 'field ' + (opts.cls ?? ''));
  const l = el('label', undefined, label);
  if (opts.required) {
    l.append(el('span', 'req', ' *'));
  }
  w.append(l, input);
  if (opts.hint) {
    w.append(el('div', 'hint', opts.hint));
  }
  return w;
}

function text(key: keyof FormData, ph = '', type = 'text'): HTMLInputElement {
  const i = el('input');
  i.type = type;
  i.placeholder = ph;
  i.value = String(form[key] ?? '');
  i.autocomplete = 'off';
  i.addEventListener('input', () => ((form as unknown as Record<string, unknown>)[key] = i.value));
  return i;
}

function select<T extends string>(key: keyof FormData, options: [T, string][]): HTMLSelectElement {
  const s = el('select');
  for (const [v, l] of options) {
    const o = el('option', undefined, l);
    o.value = v;
    s.append(o);
  }
  s.value = String(form[key]);
  s.addEventListener('change', () => ((form as unknown as Record<string, unknown>)[key] = s.value));
  return s;
}

function render(): void {
  app.textContent = '';
  const card = el('div', 'card');
  card.append(el('h1', undefined, editing ? 'Edit Connection' : 'Create Connection'), el('p', 'sub', 'Oracle Fusion Cloud'));

  const row = el('div', 'row2');
  row.append(field('Name', text('name', 'e.g. DEV'), { required: true }));
  const env = select('environment', [['DEV', 'DEV'], ['TEST', 'TEST'], ['UAT', 'UAT'], ['PROD', 'PROD - highlighted in red'], ['OTHER', 'Other']]);
  row.append(field('Environment', env));
  card.append(row);

  const method = el('div', 'radios');
  for (const [v, l] of [['basic', 'Local (user & password)'], ['oauth', 'SSO (OAuth)'], ['token', 'Access token / cookie']] as const) {
    const lab = el('label', 'radio');
    const r = el('input');
    r.type = 'radio';
    r.name = 'auth';
    r.checked = form.auth === v;
    r.addEventListener('change', () => {
      form.auth = v;
      render();
    });
    lab.append(r, el('span', undefined, l));
    method.append(lab);
  }
  card.append(field('Authentication Method', method));

  card.append(field('URL', text('url', 'https://your-instance.oraclecloud.com'), { required: true }));
  card.append(field('User Name', text('username', 'first.last@company.com'), { required: true, hint: form.auth === 'basic' ? undefined : 'Used to find your personal BI Publisher folder (/~user) where the helper report is installed.' }));

  if (form.auth === 'basic') {
    card.append(field('Password', text('password', editing && hasPassword ? 'leave empty to keep the saved password' : '', 'password'), { required: !(editing && hasPassword) }));
  } else if (form.auth === 'oauth') {
    const box = el('div', 'section');
    box.append(el('div', 'section-title', 'Single Sign-On'));
    box.append(field('Identity domain URL', text('issuer', 'https://idcs-xxxxxxxx.identity.oraclecloud.com'), { required: true }));
    const r2 = el('div', 'row2');
    r2.append(field('Client ID', text('clientId'), { required: true }), field('Flow', select('flow', [['authorization_code', 'Browser sign-in'], ['device_code', 'Device code (remote / SSH)'], ['client_credentials', 'Client credentials (service)']])));
    box.append(r2);
    box.append(field('Scope', text('scope'), { required: true }));
    box.append(field('Client secret', text('clientSecret', hasSecret ? 'saved - leave empty to keep' : 'only for confidential applications', 'password')));
    box.append(el('div', 'hint', `Register this redirect URL in the identity domain application: ${redirectUrl}`));
    card.append(box);
  } else {
    const box = el('div', 'section');
    box.append(field('Token type', select('tokenKind', [['bearer', 'Bearer access token (JWT)'], ['cookie', 'Browser session cookie']])));
    box.append(field('Token / cookie value', text('token', hasToken ? 'saved - leave empty to keep' : 'paste here', 'password')));
    card.append(box);
  }

  const adv = el('details', 'advanced');
  adv.open = !!(form.dataSource || form.catalogRoot || form.allowInsecureTls);
  adv.append(el('summary', undefined, 'Advanced options'));
  adv.append(
    field('BI Publisher data source', text('dataSource', 'ApplicationDB_FSCM (default) - or ApplicationDB_HCM, ApplicationDB_CRM'), {}),
    field('Catalog folder for the helper report', text('catalogRoot', 'empty = your personal folder (/~user)'), {})
  );
  const tls = el('label', 'check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = form.allowInsecureTls;
  cb.addEventListener('change', () => (form.allowInsecureTls = cb.checked));
  tls.append(cb, el('span', undefined, 'Allow untrusted TLS certificate (only for lab pods behind a TLS-inspecting proxy)'));
  adv.append(tls);
  card.append(adv);

  card.append(banner);
  const foot = el('div', 'foot');
  const cancel = el('button', 'btn secondary', 'Cancel');
  const validate = el('button', 'btn secondary', 'Validate Setup');
  const save = el('button', 'btn primary', editing ? 'Save Changes' : 'Create Connection');
  buttons = [cancel, validate, save];
  busyEl = el('span', 'spin hidden');
  foot.append(busyEl, cancel, validate, save);
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  validate.addEventListener('click', () => {
    show(undefined);
    vscode.postMessage({ type: 'validate', form });
  });
  save.addEventListener('click', () => {
    show(undefined);
    vscode.postMessage({ type: 'save', form });
  });
  card.append(foot);
  app.append(card);
  card.querySelector<HTMLInputElement>('input[type=text]')?.focus();
}

function show(m: Extract<ToForm, { type: 'validation' }> | undefined): void {
  banner.textContent = '';
  banner.className = 'banner' + (m ? (m.ok ? ' ok' : ' err') : ' hidden');
  if (!m) {
    return;
  }
  banner.append(el('div', 'banner-title', (m.ok ? '✓ ' : '✕ ') + m.title));
  for (const s of m.steps ?? []) {
    banner.append(el('div', 'step ' + (s.ok ? 'ok' : 'pending'), (s.ok ? '✓ ' : '• ') + s.label));
  }
  if (m.detail) {
    banner.append(el('div', 'banner-detail', m.detail));
  }
}

window.addEventListener('message', (e: MessageEvent<ToForm>) => {
  const m = e.data;
  if (m.type === 'init') {
    form = m.form;
    editing = m.editing;
    hasPassword = m.hasPassword;
    hasSecret = m.hasSecret;
    hasToken = m.hasToken;
    redirectUrl = m.redirectUrl;
    render();
  } else if (m.type === 'validation') {
    show(m);
  } else if (m.type === 'busy') {
    busyEl?.classList.toggle('hidden', !m.busy);
    buttons.forEach((b) => (b.disabled = m.busy && b.textContent !== 'Cancel'));
  }
});
vscode.postMessage({ type: 'ready' });
