# Architecture

```
┌────────────── VS Code ───────────────┐          ┌──────────── Oracle Fusion pod ───────────┐
│ SQL editor (native)  CodeLens, F5    │          │  /xmlpserver/services/v2/ReportService   │
│ Trees: Connections · Schema · History│  HTTPS   │  /xmlpserver/services/v2/CatalogService  │
│ Results panel (webview, strict CSP)  │◄────────►│  /xmlpserver/services/rest/v1/reports/…  │
│            ▲   ▼ postMessage         │          │   helper: dm.xdm + csv.xdo  (REF CURSOR) │
│ Extension host (Node, no deps)       │          └──────────────────────────────────────────┘
└──────────────────────────────────────┘
```

## Layers (src/)

| Module | Responsibility |
|---|---|
| `fusion/http.ts` | promise HTTP client on node core; TLS verified; no redirects followed; abort + deadline; error mapping |
| `fusion/soap.ts` | SOAP envelopes, `reportBytes` parsing, **fault classification** (ORA-/XDO- extraction, SSO/HTML detection, auth vs permission vs missing) |
| `fusion/bip.ts` | `FusionClient`: run SQL (paging, unwrapped fallback), discover/install/remove the helper, test connection, auth-style fallback, SOAP→REST fallback |
| `fusion/runtime.ts` | generates the helper's data model / report / config / template archives |
| `fusion/zip.ts`, `csv.ts`, `xml.ts` | ZIP reader/writer, RFC-4180 parser/serialiser, XML helpers |
| `auth/oauth.ts` | OIDC discovery, PKCE loopback listener, device code, client credentials, refresh single-flight |
| `sql/lexer.ts` | Oracle-aware spans (strings, `q'[]'`, `"idents"`, comments), statement splitting, statement-at-cursor |
| `sql/prepare.ts` | read-only guard, `DESC` rewrite, paging wrapper, bind detection/substitution |
| `sql/format.ts` | whitespace-only formatter (token stream preserved - tested) |
| `query/QueryService.ts` | the run workflow: connection → binds → helper consent/install → results → history |
| `results/*` | webview provider, message protocol, copy/export serialisers, XLSX writer |
| `connections/*`, `history/*`, `schema/*` | stores (globalState + SecretStorage), trees, wizard, dictionary cache |
| `ai/chatParticipant.ts` | `@fusion` Copilot Chat participant (prompt = Fusion rules + editor SQL + last error + cached columns) |

`webview/src` is the results UI: `grid.ts` (virtualised grid, selection, copy), `main.ts` (tabs, toolbar, menus,
record view, cell viewer). It is compiled with `tsc` to ES modules; no bundler, no framework.

## Key decisions

* **Native editor instead of an embedded Monaco webview.** Free clipboard, themes, IntelliSense, Copilot, find, multi-cursor
  and no CDN/bundle; the webview is only used for the grid.
* **Clipboard through the host.** Webviews cannot rely on `navigator.clipboard`; the grid builds the text and the host
  calls `vscode.env.clipboard.writeText`.
* **Fetch window, not blind paging.** First `fetchSize` rows (+1 to learn `hasMore`), then explicit *Fetch more/all* with a
  `maxRows` cap. Paging uses `OFFSET … FETCH` over the user's query, so deterministic order needs an `ORDER BY`.
* **Never retry a failing password.** Only SSO-style responses (credentials unevaluated) trigger the alternative credential
  style. Prevents account lock-outs.
* **Consent before touching the pod.** The helper is uploaded only after a one-time confirmation (or `auto`).
* **No runtime dependencies.** Smaller attack surface; the old `xlsx` dependency had known CVEs.
* **Strict webview CSP** (`default-src 'none'`, nonce for scripts, `localResourceRoots` = `media/`).

## Test strategy

* `test/*.test.ts` (node:test): unit tests for parsers/serialisers/lexer/formatter, a **mock BI Publisher** (SOAP + REST,
  auth modes, catalog, zip validation, ORA errors) and a **mock IdP**, then end-to-end client flows.
* `test/extension.test.ts`: activates the *real* extension against an in-memory `vscode` fake and drives commands, the
  results protocol, export (XLSX verified with openpyxl), history, completion, CodeLens, formatting, manifest/command parity.
* `test/webview/webview.e2e.mjs`: Playwright + Chromium drives the real grid (selection, copy, keyboard, sort, filters,
  menus, record view, 100k rows).

What is **not** covered by automation: behaviour of a real Fusion pod (helper acceptance, bearer-token acceptance on
`/xmlpserver`), real Copilot responses, and the VS Code UI chrome itself.
