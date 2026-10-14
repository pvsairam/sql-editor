# Changelog

## 2.4.1
- **Dates toggle** in the results toolbar (calendar icon, shown when a result has date columns): raw database text by default, click to show formatted dates (format from `fusionSqlDev.results.dateFormat`, `MM/DD/YYYY` when that is `raw`). The choice is remembered; columns re-fit when you toggle.

## 2.4.0
- **Dates show the raw database text by default** (`fusionSqlDev.results.dateFormat` = `raw`); `MM/DD/YYYY`, `DD/MM/YYYY` and `YYYY-MM-DD` remain available.
- **Smarter column auto-fit**: columns are sized from the header and the widest values across up to 1,000 rows (the top 2% outliers are ignored so one long description does not stretch a column), capped at 560 px. Columns re-fit as more rows are fetched, unless you resized that column yourself. New toolbar button *Fit all columns*; double-click a column border to fit one.

## 2.3.2
- The connection chip (results toolbar) and the status bar now show the connection of the **SQL file in view** (its own binding), not only the globally active one, so they always match the CodeLens and where the query runs.

## 2.3.1
- The connection chip in the results toolbar now opens a **dropdown right under it** (list of connections with environment, plus *Add connection…*); picking one applies it to the SQL file in view.

## 2.3.0
- **Table browser**: in the Schema view, right-click a table/view (or use the inline button) → *Open Table*. Four result tabs open: **Columns** (type, nullability, primary key, column comments), **Constraints**, **Indexes** and **Data** (all rows via the Rows limit).
- **Connection switcher in the results toolbar**: a chip with the active connection (colour-coded by environment); click to switch, like SQL Connect's dropdown.

## 2.2.0
- **Dates in the grid** are shown as `raw by default. Setting `fusionSqlDev.results.dateFormat` (`MM/DD/YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, `raw`). Copy uses what you see; filters match both forms; exports keep the ISO value (Excel gets real dates).
- **Run on multiple connections**: *Fusion SQL: Run Statement on Multiple Connections…* (right-click menu / Command Palette). Pick two or more connections; the bind dialog appears once and each connection gets its own result tab named `[DEV]`, `[QA]`... running concurrently.

## 2.1.1
- Bind-variable dialog is now a **centred tab in the editor area** (a webview cannot draw outside its own panel); `P_*_DATE`-style names default to DATE; dates accept `YYYY-MM-DD` or `MM/DD/YYYY`.
- **New worksheets are blank** and named `Worksheet 1`, `Worksheet 2`, ... (no starter comments).
- The result tab strip is hidden while there is only one result; the pin moved to the toolbar.

## 2.1.0
- **SSO via your browser (new, recommended for SSO pods)**: choose *SSO* → *Browser session* and pick Chrome, Edge, Brave or a custom path (like SQL Connect). A window opens on your pod, you sign in with your company login (MFA included), the window closes itself and the session is stored in VS Code secure storage. No IAM administrator or OAuth application needed. A private browser profile keeps your IdP session, so later sign-ins are one click. *OAuth application* remains available as the second SSO type.
- New logo.

## 2.0.1

Feedback round from the first testers.
- **One result tab by default**: a new query replaces the previous result (like SQL Developer). Click the pin on a tab to keep it; scripts still get one tab per statement. Setting `fusionSqlDev.results.reuseTab`.
- **Bind variables dialog**: a proper dialog in the results panel (name, value, *Is Null*, data type VARCHAR2/NUMBER/DATE/TIMESTAMP) instead of search-box prompts; values are remembered. Numeric binds (`:1`) are now detected.
- **Rows box** in the results toolbar (type or pick 100 ... 1,000,000, press Enter); remembered across sessions. Large limits are fetched in chunks (`fusionSqlDev.requestSize`) and rows appear as they arrive.
- **Connection form**: a real form (name, environment, Local / SSO / token, URL, user, password, advanced options) with **Validate Setup** replaces the step-by-step prompts. Validating an SSO setup signs in and keeps the tokens when you save.

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
