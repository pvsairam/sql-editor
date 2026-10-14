# Review of Fusion SQL DEV 1.0.26

Scope: the shipped VSIX (extension host, bundled webview, sources, build config). Findings are ordered by impact.
"Fix" says what 2.0.0 does about it. File references are to the 1.0.26 source tree inside the VSIX.

## Functional defects reported by testers

| # | Finding | Root cause (1.0.26) | Fix in 2.0 |
|---|---|---|---|
| 1 | **SSO does not work** | Only HTTP Basic + credentials in the SOAP body (`fusionClient.js`). No OAuth/token path (listed as "future enhancement" in `INTERNAL_ARCHITECTURE.md`). Basic header is sent together with body credentials, so an IdP redirect/login page produced the opaque *"HTTP 200 - SOAP Fault returned"* (`extractSoapError` step 7). | OAuth (PKCE, device code, client credentials, refresh), token/cookie connections, SSO detection with explicit guidance, safe credential-style fallback. See [SSO.md](SSO.md). |
| 2 | **Cannot copy from results** | `ResultGrid.tsx` uses **AG Grid Community**: range selection, clipboard and the context menu (`getContextMenuItems`, `'export'`) are *Enterprise* features, so the "Copy Cell/Row" menu never rendered; `suppressCopyRowsToClipboard` + `suppressCopySingleCellRanges` disabled the built-in copy; the fallback `Ctrl+C` handler only handled a single cell. | New grid with its own selection model; copy built in the webview, written by the host via `vscode.env.clipboard`; copy formats; tests drive real mouse/keyboard. |
| 3 | **Catalog file must be imported by hand** | `FusionClient.deploy()` exists but is never called, and the `.xdrz` it needs is not in the package (`xdrzPath` defaults to `''`). `extension.ts` goes straight to `queryAll`, so queries fail until the user imports the archive at exactly `/~user/FusionQuery/v1/`. | Helper generated in code and uploaded through CatalogService after consent; legacy locations discovered; archive import as fallback. |

## Security

| Sev | Finding | Fix |
|---|---|---|
| High | **Passwords stored twice**: besides SecretStorage, `SAVE_CONNECTION` writes `encoded_p = base64(password)` into `~/FusionDev/Connections/connections.json` and later *prefers* it as a fallback (`extension.ts` EXECUTE_SQL). Base64 is not encryption. | Secrets only in SecretStorage; legacy file migrated, then scrubbed. |
| High | **TLS verification disabled** for every request (`rejectUnauthorized: false` in `req()`), also for the Basic-auth header: trivial MITM credential theft. | Verification on; explicit per-connection opt-out; certificate errors explained. |
| Medium | **Vulnerable dependency** `xlsx@0.18.5` (prototype pollution CVE-2023-30533, ReDoS CVE-2024-22363), plus `@monaco-editor/react` loading code from **jsdelivr at runtime** (supply chain; fails behind proxies/offline). | No runtime dependencies; native editor. |
| Medium | Webviews had **no CSP**, inline scripts, `localResourceRoots: [extensionUri]` (whole extension folder) for the sidebar. | `default-src 'none'`, nonce, `localResourceRoots` = `media/`. |
| Low | SQL/credentials could appear in error strings; `console.log`/`console.error` used. | Output channel logger; debug logging never includes credentials or data. |

## Correctness

| Finding | Fix |
|---|---|
| `parseCSV` split on `\n` and `\|` and **trimmed every value**: embedded newlines/pipes shift columns, significant spaces vanish. | RFC-4180 state machine with quote handling, BOM, CRLF, stray-quote recovery (tests). |
| Paging re-executed the full query for each 1,000-row page without a stable order (duplicates/missing rows possible) and "All Rows" meant 999,999 rows in one array. | Fetch window + explicit *Fetch more/all*, `maxRows` cap, `hasMore` via limit+1, unwrapped fallback for duplicate column names. |
| Statement splitter understood only `'…'`: `;` or `'` inside comments, `q'[…]'` or `"ids"` broke detection; multi-statement selections silently ran only the first. | Oracle-aware lexer; selection with several statements runs them; F5 runs script. |
| REST attempted first on *every page*, then SOAP (double latency); REST path not URL-encoded. | SOAP first; REST only as token-auth fallback and remembered per client. |
| CSV/Excel export used `<a download>` (blocked in webviews) and `XLSX.writeFile`. | Host-side export with save dialog; own XLSX writer (typed cells, dates, frozen header, filters). |
| Webview HTML referenced `main.css` / `sidebar.css`, but the build emits `index.css`: **the grid was unstyled**. | Single stylesheet, referenced by tests. |
| `Ctrl+Enter` implemented by writing `data-sql` onto a hidden DOM button and clicking it; tab state mutated in place inside `setTabs`; worksheets lost whenever the webview reloaded. | Native documents (saved/unsaved like any file), per-file connection. |
| `APPLY_HISTORY_SQL` waited `setTimeout(500)` hoping the panel had opened. | Direct document open/run. |
| Custom `Ctrl+V`/`Ctrl+X` overrides in Monaco to work around the sandbox, breaking native paste/undo. | Not needed with the native editor. |

## UX gaps

No cancel, no timeout control, no bind variables, no `DESC`, no schema browser, no formatter, no snippets, no column
or table completion beyond 12 hard-coded names, no per-file connection, no PROD safety, no starred history. The panel
opened on every activation. All addressed (see CHANGELOG).

## Packaging / maintainability

* `icon.png` was a **JPEG with a .png extension** (1024², 200 KB); Marketplace requires PNG. Replaced by a real 256² PNG.
* `engines.vscode` `^1.80` vs README "1.90+"; the chat participant API needs ≥ 1.90 (now `^1.95`).
* Source tree shipped inside the VSIX; `INTERNAL_ARCHITECTURE.md` described `HistoryPanel.tsx`/`Sidebar.tsx` that do not
  exist and an `ExternalReportWSSService` endpoint the code never uses.
* Dead code: `AICopilotService.ts` (mock), `SecureStore` indirection, unused `fs`/`https` paths, TS port that is actually
  committed as compiled `.js`.
* Two placeholder tests (vitest not even in the build) - now 67 automated tests plus a 29-check browser test.
* The "AI copilot" returned canned strings (`if prompt includes "join"`); replaced by a real Copilot Chat participant.
* Synchronous file I/O on every history/connection write; ids from `Date.now()`.

## Known limitations of 2.0 (honest list)

* Behaviour against a **live pod** is verified only through mocks written from Oracle's documented and observed
  protocol (including the `fusion-query` helper). The generated helper objects are byte-compatible in structure with
  the proven `FusionQueryProxy.xdrz`, and the archive-import fallback exists for that reason.
* Whether a given pod's BI Publisher accepts OAuth bearer tokens is configuration dependent (see SSO.md).
* The `@fusion` chat participant needs GitHub Copilot Chat; it was exercised against a stub only.
* Read-only by design: BI Publisher cannot run DML/DDL/PL/SQL.
