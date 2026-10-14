/**
 * A tiny in-memory stand-in for the `vscode` module, good enough to activate the real extension and
 * drive its commands in a plain Node process (no VS Code needed). It records UI interactions so the
 * tests can script answers and assert on what the user would have seen.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');

type Fn = (...a: any[]) => any;

export class Disposable {
  constructor(private readonly fn: () => void = () => {}) {}
  dispose(): void {
    this.fn();
  }
  static from(...ds: { dispose(): any }[]): Disposable {
    return new Disposable(() => ds.forEach((d) => d.dispose()));
  }
}

export class EventEmitter<T> {
  private ls: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.ls.push(l);
    return new Disposable(() => (this.ls = this.ls.filter((x) => x !== l)));
  };
  fire(e: T): void {
    [...this.ls].forEach((l) => l(e));
  }
  dispose(): void {
    this.ls = [];
  }
}

export class Uri {
  constructor(
    readonly scheme: string,
    readonly fsPath: string,
    readonly raw?: string
  ) {}
  static file(p: string): Uri {
    return new Uri('file', p);
  }
  static from(o: { scheme: string; path: string }): Uri {
    return new Uri(o.scheme, o.path);
  }
  static parse(s: string): Uri {
    return new Uri('https', s, s);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, path.join(base.fsPath, ...parts));
  }
  get path(): string {
    return this.fsPath;
  }
  toString(): string {
    return this.raw ?? `${this.scheme}://${this.fsPath}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}
export class Range {
  start: Position;
  end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}
export class Selection extends Range {
  get active(): Position {
    return this.end;
  }
}
export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: unknown
  ) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class MarkdownString {
  value = '';
  constructor(v?: string) {
    this.value = v ?? '';
  }
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
  appendCodeblock(s: string): this {
    this.value += s;
    return this;
  }
}
export class TreeItem {
  [k: string]: unknown;
  constructor(
    public label: string,
    public collapsibleState?: number
  ) {}
}
export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: { title: string; command: string; arguments?: unknown[] }
  ) {}
}
export class CompletionItem {
  [k: string]: unknown;
  constructor(
    public label: string,
    public kind?: number
  ) {}
}
export class SnippetString {
  constructor(readonly value: string) {}
}
export class Hover {
  constructor(
    readonly contents: unknown,
    readonly range?: Range
  ) {}
}
export class TextEdit {
  constructor(
    readonly range: Range,
    readonly newText: string
  ) {}
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
}
export class LanguageModelChatMessage {
  static User(content: string): { role: 'user'; content: string } {
    return { role: 'user', content };
  }
}

export const enums = {
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ViewColumn: { One: 1, Two: 2 },
  CompletionItemKind: { Struct: 21, Field: 4, Keyword: 13, Function: 2, Interface: 7, Variable: 5 },
  ConfigurationTarget: { Global: 1 }
};

export interface UiScript {
  /** answers for showInputBox in order; `undefined` = user pressed Esc */
  inputs: (string | undefined)[];
  /** answers for showQuickPick: label substring or predicate */
  picks: ((items: any[]) => any)[];
  /** button chosen for showInformation/Warning/ErrorMessage: function of the message */
  buttons: (msg: string, items: string[]) => string | undefined;
}

export class FakeHost {
  commands = new Map<string, Fn>();
  executed: string[] = [];
  contexts = new Map<string, unknown>();
  messages: { level: string; text: string; items: string[] }[] = [];
  statusMessages: string[] = [];
  clipboard = '';
  opened: string[] = [];
  savedFiles = new Map<string, Uint8Array>();
  saveDialogPath = '';
  ui: UiScript = { inputs: [], picks: [], buttons: () => undefined };
  config: Record<string, unknown> = {};
  webviewProviders = new Map<string, any>();
  chatParticipants: any[] = [];
  panels: { viewType: string; handler?: (m: any) => void; posted: any[]; disposed: boolean; onDispose?: () => void }[] = [];
  registeredProviders: string[] = [];
  providers: Record<string, any> = {};
  activeTextEditor: any;
  visibleTextEditors: any[] = [];
  docs: any[] = [];
  configListeners: Fn[] = [];
  defaults: Record<string, unknown> = {};

  makeEditor(text: string, languageId = 'sql'): any {
    const lines = () => text.split('\n');
    const doc = {
      languageId,
      uri: Uri.file(`/untitled-${this.docs.length}.sql`),
      getText: (r?: Range) => {
        if (!r) {
          return text;
        }
        return text.slice(doc.offsetAt(r.start), doc.offsetAt(r.end));
      },
      offsetAt: (p: Position) => lines().slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + p.character,
      positionAt: (o: number) => {
        const before = text.slice(0, o).split('\n');
        return new Position(before.length - 1, before[before.length - 1].length);
      },
      get lineCount() {
        return lines().length;
      },
      lineAt: (n: number) => ({ text: lines()[n] })
    };
    const editor: any = { document: doc, selection: new Selection(new Position(0, 0), new Position(0, 0)), edit: async () => true, viewColumn: 1 };
    this.docs.push(doc);
    return editor;
  }

  setCursor(editor: any, offset: number): void {
    const p = editor.document.positionAt(offset);
    editor.selection = new Selection(p, p);
  }
}

export function installFakeVscode(host: FakeHost, packageJson: any): void {
  // defaults from the manifest, like VS Code does
  const props = packageJson.contributes.configuration.properties as Record<string, { default: unknown }>;
  for (const [k, v] of Object.entries(props)) {
    host.defaults[k] = v.default;
  }
  const disposable = () => new Disposable();
  const vscode: any = {
    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    Selection,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    TreeItem,
    CodeLens,
    CompletionItem,
    SnippetString,
    Hover,
    TextEdit,
    LanguageModelChatMessage,
    ...enums,
    commands: {
      registerCommand: (id: string, fn: Fn) => {
        host.commands.set(id, fn);
        return disposable();
      },
      executeCommand: async (id: string, ...args: unknown[]) => {
        host.executed.push(id);
        if (id === 'setContext') {
          host.contexts.set(args[0] as string, args[1]);
          return;
        }
        const fn = host.commands.get(id);
        return fn ? fn(...args) : undefined;
      }
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createTreeView: (id: string) => {
        host.registeredProviders.push(`tree:${id}`);
        return disposable();
      },
      registerWebviewViewProvider: (id: string, provider: unknown) => {
        host.webviewProviders.set(id, provider);
        return disposable();
      },
      createWebviewPanel: (viewType: string) => {
        const rec: (typeof host.panels)[number] = { viewType, posted: [], disposed: false };
        host.panels.push(rec);
        return {
          iconPath: undefined,
          webview: {
            html: '',
            cspSource: 'x',
            asWebviewUri: (u: any) => u,
            postMessage: async (m: unknown) => void rec.posted.push(m),
            onDidReceiveMessage: (fn: (m: any) => void) => {
              rec.handler = fn;
              return new Disposable();
            }
          },
          onDidDispose: (fn: () => void) => {
            rec.onDispose = fn;
            return new Disposable();
          },
          reveal() {},
          dispose() {
            if (!rec.disposed) {
              rec.disposed = true;
              rec.onDispose?.();
            }
          }
        };
      },
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
      onDidChangeActiveTextEditor: () => disposable(),
      showInformationMessage: async (text: string, ...rest: any[]) => message('info', text, rest),
      showWarningMessage: async (text: string, ...rest: any[]) => message('warn', text, rest),
      showErrorMessage: async (text: string, ...rest: any[]) => message('error', text, rest),
      showInputBox: async () => (host.ui.inputs.length ? host.ui.inputs.shift() : undefined),
      showQuickPick: async (items: any[]) => {
        const f = host.ui.picks.shift();
        return f ? f(items) : undefined;
      },
      showOpenDialog: async () => undefined,
      showSaveDialog: async () => (host.saveDialogPath ? Uri.file(host.saveDialogPath) : undefined),
      showTextDocument: async (doc: any) => {
        const ed = { document: doc, selection: new Selection(new Position(0, 0), new Position(0, 0)), edit: async () => true };
        host.activeTextEditor = ed;
        return ed;
      },
      withProgress: async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) => task({ report() {} }, { onCancellationRequested: () => disposable(), isCancellationRequested: false }),
      setStatusBarMessage: (t: string) => {
        host.statusMessages.push(t);
        return disposable();
      },
      get activeTextEditor() {
        return host.activeTextEditor;
      },
      get visibleTextEditors() {
        return host.visibleTextEditors;
      }
    },
    workspace: {
      getConfiguration: (section: string) => ({
        get: (key: string, dflt?: unknown) => {
          const full = `${section}.${key}`;
          return full in host.config ? host.config[full] : full in host.defaults ? host.defaults[full] : dflt;
        }
      }),
      onDidChangeConfiguration: (fn: Fn) => {
        host.configListeners.push(fn);
        return disposable();
      },
      openTextDocument: async (o: { content: string; language: string } | Uri) => {
        const isUri = o instanceof Uri;
        const ed = host.makeEditor(isUri ? '' : o.content, isUri ? 'sql' : o.language);
        if (isUri) {
          ed.document.uri = o;
        }
        return ed.document;
      },
      get textDocuments() {
        return host.docs;
      },
      workspaceFolders: undefined,
      fs: {
        readFile: async (u: Uri) => fs.readFileSync(u.fsPath),
        writeFile: async (u: Uri, data: Uint8Array) => {
          host.savedFiles.set(u.fsPath, data);
        }
      }
    },
    languages: {
      registerCodeLensProvider: (_sel: unknown, provider: unknown) => {
        host.registeredProviders.push('codelens');
        host.providers['codelens'] = provider;
        return disposable();
      },
      registerCompletionItemProvider: (_sel: unknown, provider: unknown) => {
        host.registeredProviders.push('completion');
        host.providers['completion'] = provider;
        return disposable();
      },
      registerHoverProvider: (_sel: unknown, provider: unknown) => {
        host.registeredProviders.push('hover');
        host.providers['hover'] = provider;
        return disposable();
      },
      registerDocumentFormattingEditProvider: (_sel: unknown, provider: unknown) => {
        host.registeredProviders.push('format');
        host.providers['format'] = provider;
        return disposable();
      },
      registerDocumentRangeFormattingEditProvider: (_sel: unknown, provider: unknown) => {
        host.registeredProviders.push('rangeformat');
        host.providers['rangeformat'] = provider;
        return disposable();
      }
    },
    env: {
      clipboard: {
        writeText: async (t: string) => {
          host.clipboard = t;
        },
        readText: async () => host.clipboard
      },
      openExternal: async (u: Uri) => {
        host.opened.push(u.toString());
        return true;
      }
    },
    chat: {
      createChatParticipant: (id: string, handler: Fn) => {
        const p = { id, handler, iconPath: undefined };
        host.chatParticipants.push(p);
        return p;
      }
    },
    lm: { selectChatModels: async () => [] }
  };

  function message(level: string, text: string, rest: any[]): string | undefined {
    const items = rest.filter((r) => typeof r === 'string') as string[];
    host.messages.push({ level, text, items });
    return host.ui.buttons(text, items);
  }

  const M = Module as unknown as { _load: Fn };
  const orig = M._load;
  M._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') {
      return vscode;
    }
    return orig.call(this, request, ...rest);
  };
}

export function fakeContext(host: FakeHost, packageJson: any): any {
  const store = () => {
    const m = new Map<string, unknown>();
    return {
      get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
      update: async (k: string, v: unknown) => {
        if (v === undefined) {
          m.delete(k);
        } else {
          m.set(k, JSON.parse(JSON.stringify(v)));
        }
      },
      keys: () => [...m.keys()],
      _m: m
    };
  };
  const secretMap = new Map<string, string>();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-sql-test-'));
  return {
    subscriptions: [] as { dispose(): void }[],
    globalState: store(),
    workspaceState: store(),
    secrets: {
      get: async (k: string) => secretMap.get(k),
      store: async (k: string, v: string) => void secretMap.set(k, v),
      delete: async (k: string) => void secretMap.delete(k),
      _m: secretMap
    },
    extensionUri: Uri.file(path.resolve(__dirname, '../../..')),
    globalStorageUri: Uri.file(dir),
    extension: { packageJSON: packageJson },
    _dir: dir,
    _host: host
  };
}
