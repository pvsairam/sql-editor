# Single Sign-On (SSO) with Fusion SQL DEV

Many Fusion pods authenticate people through a company identity provider (Azure AD, Okta, Ping, Oracle IAM …) with
MFA. Those users often have **no usable Fusion password**, so "username + password" cannot work. Fusion SQL DEV
therefore supports three ways to sign in. Pick the first one that applies to you.

| # | Method | Needs | Best for |
|---|---|---|---|
| 1 | **Username & password** | A Fusion local password that works for API calls | Pods without enforced SSO, service accounts |
| 2a | **SSO - Browser session** | A Chromium browser (Chrome / Edge / Brave) | SSO / MFA pods, no admin help needed (recommended first try) |
| 2b | **SSO - OAuth application** | A one-time *integrated application* in the pod's IAM identity domain | Teams that can register the app; refreshable tokens |
| 3 | **Access token / session cookie** | A token or browser cookie you obtain yourself | Quick tests, break-glass |

> **Status of this feature:** the OAuth flows (authorization code + PKCE, device code, client credentials, refresh)
> are covered by automated tests against a mock identity provider. Which authentication schemes the `/xmlpserver`
> endpoints of *your* pod accept (bearer tokens on SOAP and/or REST) is a pod-side setting that could not be tested
> against a live tenant. The extension tries SOAP first and falls back to REST automatically, and prints precise
> reasons when a pod refuses. If yours does, enable `fusionSqlDev.debugLogging` and send the log excerpt.

## 1. Username & password on an SSO pod

Version 1.x sent your credentials twice (HTTP header **and** SOAP body). On pods that put a login redirect in
front of API calls that produced a confusing failure. Version 2 detects the redirect/login page and retries with the
credentials in the SOAP body only - safe, because a redirect means the pod never evaluated the password, so it cannot
count as a failed attempt. A genuinely wrong password is tried **exactly once**.

If you still get *"The server returned a web page … Single Sign-On"*, use method 2.

## 2a. SSO - Browser session

*Add Connection → SSO → Browser session*, choose the browser, create. On first use (or *Sign In (SSO)…*) a window opens on your pod; sign in normally. The extension reads the session cookies for the pod through the browser's local DevTools port (bound to 127.0.0.1, private profile, random port), tests them against BI Publisher, closes the window and stores the cookie header in VS Code SecretStorage. When the session expires you are offered *Sign In* again.

Not verified against a live pod: whether the pod's `/xmlpserver` accepts the browser session cookie. If it answers with a login page the message says so; then use 2b.

## 2b. Single Sign-On (OAuth) - one-time setup (≈5 minutes, needs an IAM administrator)

Fusion SaaS uses an Oracle IAM identity domain (formerly IDCS). In its console:

1. **Identity & Security → Domains → *your domain* → Integrated applications → Add application**.
2. Choose **Confidential application** (or *Mobile application* for a public client; both work with PKCE).
   Name it e.g. `Fusion SQL DEV`.
3. **Client configuration → Configure this application as a client now**
   - Allowed grant types: **Authorization code** (browser sign-in) and/or **Device code** (SSH / WSL / Codespaces),
     plus **Refresh token**.
   - Redirect URL: `http://localhost:53682/callback` (the value of `fusionSqlDev.oauth.loopbackPort`; change both together).
   - *Client type* confidential → note the **client secret**; public → no secret needed.
4. **Resources → Add scope**: add your **Fusion Applications** resource and select its
   `…urn:opc:resource:consumer::all` scope. The full scope string looks like
   `https://<pod-host>:443/urn:opc:resource:fa:instanceid=<id>urn:opc:resource:consumer::all`.
5. **Activate** the application. Copy the **Client ID** and the **Domain URL** (`https://idcs-<id>.identity.oraclecloud.com`).

Menu names differ slightly between IAM releases; the settings above are what matters.

Then in VS Code: **Add Connection → Single Sign-On (OAuth)**, enter the domain URL, client ID and scope, choose
*Browser sign-in*, finish. Right-click the connection → **Sign In (SSO)…**. Your company IdP page opens in the
browser (MFA included). Tokens are refreshed silently and stored in VS Code SecretStorage - **no password is ever typed
into or stored by the extension**.

The user name you enter is only used to find your personal BI Publisher folder (`/~<user>`), where the helper report is
installed.

### Remote / headless sessions
Choose **Device code**: a short code is shown, you enter it at the identity provider from any browser. No local redirect
port is needed.

### Service accounts
Choose **Client credentials** (needs the client secret). No person is involved.

## 3. Access token / session cookie

*Bearer token*: paste a JWT issued for the Fusion resource (for example by your own script using a JWT assertion).
The expiry is read from the token and shown in the Connections view.

*Browser session cookie*: sign in to Fusion in your browser, open developer tools → Network, pick a request to the pod,
copy the **Cookie** request header and paste it via *Set Access Token / Session Cookie…*. It lasts for the browser
session. Treat it like a password.

## If it still fails

| Message | Meaning / next step |
|---|---|
| `invalid_client` | Client ID/secret wrong, or the application is not activated. |
| `unauthorized_client` | Enable the *Authorization code* (or *Device code*) grant on the application. |
| `invalid_scope` | The scope is not assigned to the application (step 4). |
| `invalid_request … redirect_uri` | The redirect URL registered in IAM differs from `http://<redirectHost>:<port>/callback`. |
| *token rejected (HTTP 401)* on every call | The pod's BI Publisher does not accept bearer tokens for your application/scope. Use method 1 with a dedicated integration user, or ask your Fusion administrator which scope BI Publisher expects. |
| Port in use | Change `fusionSqlDev.oauth.loopbackPort` **and** the redirect URL in IAM. |
