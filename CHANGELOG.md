# Changelog

## 2.6.3

- **Fixed Schema view re-downloading & slow loading**:
  - Clicking or switching connections no longer wipes the local disk schema cache (only the explicit **Refresh Schema** button or changing `fusionSqlDev.schema.owner` forces a full re-sync), making connection switching and VS Code startup instant.
  - Initial schema sync now fetches up to 100,000 objects in a single round-trip instead of 14 repeated `ALL_OBJECTS` sorts, cutting first-time sync time dramatically and eliminating the lingering progress bar after objects load.

## 2.6.2

- **Fixed "Invalid username or password" on Browser SSO Validate Setup & SOAP v2 endpoints**:
  - SOAP 1.1 `v2/CatalogService` and `v2/ReportService` now send **Cookie-only first** for Browser SSO sessions (omitting `Authorization: Bearer <jwt>`, which WebLogic/BIP v2 rejects as `"Invalid username or password"` when SOAP body credentials are empty), and fall back to Bearer+Cookie only if Cookie-only is rejected.
  - SOAP 1.2 WSS (`ExternalReportWSSService` / `ScheduleReportWSSService`) tries Bearer+Cookie first and automatically falls back to Cookie-only if needed.
  - `test()` / **Validate Setup** now lets WSS/REST discovery verify SSO/Bearer sessions even if legacy SOAP 1.1 `v2/CatalogService` rejects the token, and clears a rejected validation browser session so clicking **Validate Setup** again opens a fresh sign-in.
  - Fixed misleading `"Invalid username or password"` wording when using non-Basic (Browser SSO / OAuth / Token) authentication.

## 2.6.1

- **Full BI Catalog ACLs & Ownership in `FusionSqlDevHelper.catalog`**: Every folder, report, data model, and child file in the generated `.catalog` now embeds explicit Oracle BI Catalog ACLs (`BIAdministrator`: Full Control `65535`, `BIAuthor`: Full Control `65535`, `BIConsumer`: Read+Run `3`, plus the logged-in user: Full Control `65535`), `OwnerId`, `CreatorId`, `LastModifierId`, `CatalogArchiveOptions: 2`, and `online="true"` / `cacheDocument="false"` / `bip:propertyMap="3"` — matching Oracle Fusion's native BI Catalog export format.
- **Automated My Folders upload over SSO (`ExternalReportWSSService` + `saw.dll`)**:
  - Catalog operations (`objectExist`, `createFolder`, `uploadObject`, `deleteObject`, `getFolderContents`) now automatically fall back to **SOAP 1.2 `ExternalReportWSSService`** when legacy SOAP 1.1 `v2/CatalogService` rejects SSO/JWT sessions.
  - Automatic `saw.dll?unArchiveCatalog` fallback into My Folders (`/users/<user>`) now triggers on SSO/permission errors as well as `SECURITY_VIOLATION`, follows same-origin redirects to establish `SAW` session cookies + real `_scid`, uses cookie-only auth (never sending conflicting `Authorization: Bearer` to `saw.dll`), and passes `repl=all` + `acl=preserve` to repair broken installs cleanly.
  - Browser SSO now primes `/analytics/saw.dll?Catalog` right after capturing the Fusion JWT so Presentation Services cookies are ready immediately.
  - Handled Oracle `PublicReportService::generateReport`'s misleading `"does not have permission to run the report"` error when the helper report doesn't exist yet — automatically verifies existence and triggers My Folders installation.

## 2.6.0

### Pillar 1 — Bulletproof SSO, Transport & Shared Helper Install
- **Browser SSO with Fusion JWT capture (`tokenrelay`)**: After signing in through Chrome/Edge/Brave (including Oracle IDCS + Oracle Authenticator MFA, Entra ID, or Okta), the extension captures both the pod session cookies AND a Fusion JWT Bearer token from `/fscmRestApi/anticsrf` + `/fscmRestApi/tokenrelay`, stored securely in VS Code SecretStorage.
- **Fixed premature browser close on transient errors**: Browser SSO verification now only succeeds on genuine authenticated BI Publisher responses (never closing early on transient network/500/redirect errors during MFA).
- **Added `ExternalReportWSSService` (SOAP 1.2) transport fallback**: For Bearer JWT and browser-session SSO connections, the client now tries `v2/ReportService` → `ExternalReportWSSService` (SOAP 1.2) → `rest/v1/reports` and remembers what works.
- **Real Presentation Services `_scid` token**: Catalog Unarchive (`/analytics/saw.dll?unArchiveCatalog`) now fetches the real anti-CSRF `_scid` and session cookies from `/analytics/saw.dll?Catalog` before uploading.
- **Shared `/Custom/FusionSqlDev/v2/` helper support**: Save Helper Catalog File now offers Personal (`/~user`) or Shared team folder (`/Custom`), and runtime discovery automatically finds a shared `/Custom/FusionSqlDev/v2/csv.xdo` deployment.

### Pillar 2 — Background SQL (`ScheduleReportWSSService`)
- New command **Run Statement in Background (Scheduled Job)** executes long-running queries asynchronously through BI Publisher's `ScheduleReportWSSService` (`scheduleReport` → `getAllJobInstanceIDs` → `getReportHistoryInfo` → `getDocumentData`), bypassing the ~500s synchronous gateway timeout with live progress notifications and cancellation (`cancelSchedule`).

### Pillar 3 — Full Persistent Schema Browser
- **Tables, Views, Synonyms & Packages**: Syncs the full schema (not capped at 2,000 objects) in chunks and persists a per-connection local cache for instant startup and sub-millisecond in-memory search/filtering.
- **Grouped Schema Tree**: Organizes objects into `Tables`, `Views`, `Synonyms`, and `Packages` with collision-free node IDs (`owner.type.name`).
- **Package Source & Synonym Inspector**: New commands **View Package Source (`ALL_SOURCE`)** and **Inspect Synonym Target (`ALL_SYNONYMS`)**, plus automatic synonym resolution for column expansion and IntelliSense.

### Pillar 4 — Upgraded `@fusion` AI Copilot
- **BYOK & Any VS Code LM**: Works with GitHub Copilot, any other VS Code Language Model provider, or Bring-Your-Own-Key OpenAI / Azure OpenAI / local Ollama (`fusionSqlDev.ai.provider`, API key in SecretStorage).
- **Per-Connection Fusion Context & Remembered Rules**: Configure Chart of Accounts segments (`SEGMENT1..N`), Ledger, Business Unit, Calendar, and custom SQL rules injected into every `@fusion` prompt.
- **Static Fusion SQL Safety Warnings**: Automatically flags unrestricted scans on high-volume tables (`GL_BALANCES`, `XLA_AE_LINES`, `XLA_AE_HEADERS`, `INV_MATERIAL_TXNS`, etc.), missing effective-date filters on `_F`/`_M` tables, and missing `LANGUAGE` filters on `_TL` tables.
- **Read-Only Validate & Auto-Repair**: New `@fusion /validate` command and **Validate & Auto-Repair SQL (AI)** action tests `SELECT`/`WITH` queries safely (`ROWNUM <= 25` / `FETCH FIRST 25 ROWS ONLY`, neutralizing `:binds`), and feeds `ORA-*` errors + live `ALL_TAB_COLUMNS` back to the LLM to self-heal queries.

### Pillar 5 — UX Polish
- **1-Click Result Diff (`Compare / Diff Two Result Tabs…`)**: Compare any two result tabs (e.g. `[DEV]` vs `[PROD]` after Multi-Connection Run) with a toolbar **Compare** button; opens a pinned diff grid showing `ADDED (+)`, `REMOVED (-)`, and `CHANGED (~)` (`old → new`) rows ready for filtering and Excel/CSV export.
- **Saved Queries Sidebar**: New **Saved Queries** view in the Fusion SQL Activity Bar with folder grouping, inline Run/Open, rename, and delete.
- **Secret-Free Connection Export / Import**: Share connection profiles as clean JSON without passwords, tokens, cookies, or OAuth client secrets.

## 2.5.3

- Helper install now falls back automatically to the Catalog page's own Unarchive call (`/analytics/saw.dll?unArchiveCatalog`) when BI Publisher's SOAP CatalogService refuses to create the report ("Security violation"). Endpoint and form fields taken from a real browser capture; it needs an auth the Presentation Services accept (Basic or a browser session).

## 2.5.2

- **Save Helper Catalog File…** now writes a native `FusionSqlDevHelper.catalog` (same format as Catalog > Download, decoded from a working export) for Catalog > Unarchive, alongside `dm.xdmz`/`csv.xdoz` and the `.xdrz` bundle.

## 2.5.1

- **Save Helper Files…** now writes `dm.xdmz` and `csv.xdoz` separately (plus the bundle). Upload them in the BI Publisher Catalog as a Data Model and a Report, since the Catalog UI does not import our `.xdrz` bundle as a catalog file.

## 2.5.0
- **Helper install: "Security violation" handled.** When BI Publisher accepts the helper's data model but refuses to create the report (a BI authoring role is needed for that, separate from owning My Folders), the message now says exactly that and offers **Save Helper File…**.
- New command **Save Helper Catalog File… (manual upload)** (right-click a connection): saves `FusionSqlDevHelper.xdrz` to upload yourself via *Catalog → My Folders → Upload*; the extension then finds it at `/~user/FusionSqlDev/v2/csv.xdo`.
- New connection option **Existing helper report (full catalog path)**, tried first - for a helper someone else (or you, by hand) already imported anywhere.

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
