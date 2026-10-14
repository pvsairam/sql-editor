/** Messages exchanged between the extension host and the results webview. Keep in sync with webview/src/protocol.ts. */

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface RunDTO {
  runId: string;
  title: string;
  sql: string;
  connectionName: string;
  environment: string;
  status: RunStatus;
  startedAt: number;
  elapsedMs: number;
  columns: string[];
  rows: string[][];
  hasMore: boolean;
  loading: boolean;
  error?: { message: string; hint?: string; kind: string };
  note?: string;
  pinned?: boolean;
}

export interface ViewSettings {
  wrapText: boolean;
  maxCellLength: number;
  /** Rows to fetch per run (the "Rows" box). */
  fetchSize: number;
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'raw';
  /** active connection, shown as a switcher chip */
  connection?: { name: string; environment: string };
  connections?: { id: string; name: string; environment: string; active: boolean }[];
}

export type BindType = 'VARCHAR2' | 'NUMBER' | 'DATE' | 'TIMESTAMP';

export interface BindField {
  name: string;
  value: string;
  isNull: boolean;
  type: BindType;
}

export type ToWebview =
  | { type: 'init'; runs: RunDTO[]; activeRunId?: string; settings: ViewSettings }
  | { type: 'run-start'; run: RunDTO; drop?: string[] }
  | { type: 'run-rows'; runId: string; columns: string[]; rows: string[][]; append: boolean; hasMore: boolean; elapsedMs: number; note?: string }
  | { type: 'run-loading'; runId: string; loading: boolean }
  | { type: 'run-error'; runId: string; status: RunStatus; error: { message: string; hint?: string; kind: string }; elapsedMs: number }
  | { type: 'settings'; settings: ViewSettings }
  | { type: 'toast'; text: string; level: 'info' | 'error' }
  | { type: 'focus-run'; runId: string };

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'insert' | 'inlist';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'copy'; text: string; label: string }
  | { type: 'copy-as'; runId: string; format: CopyFormat; headers: boolean; rowIdx: number[] | null; colIdx: number[] | null }
  | { type: 'export'; runId: string; format: 'csv' | 'xlsx' | 'json'; rowIdx: number[] | null; colIdx: number[] | null }
  | { type: 'fetch-more'; runId: string; all: boolean }
  | { type: 'cancel'; runId: string }
  | { type: 'rerun'; runId: string }
  | { type: 'open-sql'; runId: string }
  | { type: 'close-run'; runId: string }
  | { type: 'pin'; runId: string; pinned: boolean }
  | { type: 'set-fetch-size'; value: number }
  | { type: 'switch-connection'; id?: string }
  | { type: 'log'; text: string };
