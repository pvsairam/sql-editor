# Changelog

## 2.0.0

A ground-up rebuild of 1.0.26. Same extension id, so VS Code upgrades it in place and your connections are
migrated automatically.

### Fixed (reported by testers)
- **Single sign-on**: new *Single Sign-On (OAuth)* connection type (browser sign-in with PKCE, device-code flow
  for remote/headless sessions, refresh tokens), *access token / session cookie* connections, automatic
  detection of SSO tenants (redirect / HTML login page) with an actionable message, and an automatic switch of
  the credential style (header vs. body) that is safe against account lock-outs.
- **Copying from results**: the grid is rewritten. Click, drag, Shift/Ctrl-select, row/column selection,
  `Ctrl+C` / `Ctrl+Shift+C`, copy as CSV / JSON / Markdown / INSERT / IN-list, a cell viewer and a record view.
  Clipboard writes go through the extension host, so they work in every VS Code environment.
- **Catalog import**: the helper BI Publisher report is now generated and installed on the pod automatically
  (after a one-time consent). Helpers imported by hand for 1.x or `fusion-query` are discovered and reused.
  *Install Helper From a Catalog File (.xdrz)* remains as a fallback.

### Fixed (found in review)
- Passwords were also written (base64) to `~/FusionDev/Connections/connections.json`; secrets now live only in
  VS Code SecretStorage and the legacy file is scrubbed after migration.
- TLS verification was disabled for every request; it is now on (per-connection opt-out).
- Result parsing split on `|` and newlines and trimmed values, corrupting data; replaced with a real CSV parser.
- CSV / Excel export did not work inside the webview sandbox; export now uses native save dialogs and a built-in
  XLSX writer (real numbers and dates, frozen header, filters). The vulnerable `xlsx` 0.18.5 dependency is gone.
- Paging re-ran the whole query per 1,000 rows; replaced with a fetch window + *Fetch more / Fetch all* and a
  hard memory cap (`fusionSqlDev.maxRows`).
- The webview stylesheet was never loaded (wrong file name) and Monaco came from a CDN at runtime; the editor
  is now VS Code's own.
- The extension opened a panel on every start; it now stays quiet until you use it.
- The "AI copilot" returned canned text; replaced by a real `@fusion` Copilot Chat participant.

### New
- Native SQL worksheets: `Ctrl+Enter` runs the statement under the cursor, `F5` runs the script, CodeLens
  *Run* actions, multiple result tabs, cancel, per-file connections, environment colours and a PROD guard.
- Oracle-aware statement splitting (comments, `q'[ ]'`, quoted identifiers, `/` terminators).
- `:bind` variable prompts, `DESC <table>`, read-only statement guard with clear messages.
- Schema browser, table / column completion and hover, Fusion table catalogue, snippets, SQL formatter.
- Query history with starring, search and grouping; history of 1.x is imported.
- Results panel with sort, per-column filters, quick filter, aggregates for selections, 100k-row virtualisation.
- Zero runtime dependencies, strict CSP, ~150 KB package.

### Changed
- Requires VS Code 1.95 or newer.
- The webview-hosted editor/sidebar are replaced by native views; the command *Fusion SQL DEV: Start Workspace*
  now opens a new worksheet.
