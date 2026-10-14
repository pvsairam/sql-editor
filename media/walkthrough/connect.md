## Connect to your Fusion pod

1. Click **Add Connection** and enter your pod URL, e.g. `https://abcd.fa.us2.oraclecloud.com`.
2. Pick how you sign in:
   - **Username & password** - a Fusion account that may call APIs.
   - **Single Sign-On (OAuth)** - for SSO / MFA pods. A one-time setup in your identity domain is needed; the
     [SSO guide](https://github.com/pvsairam/sql-editor/blob/main/docs/SSO.md) walks through it.
3. Choose the environment (DEV / TEST / UAT / PROD) - PROD is highlighted and asks for confirmation once per session.

Secrets are kept in VS Code's secure storage, never in files.
