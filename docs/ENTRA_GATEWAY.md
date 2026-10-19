# Microsoft Entra Sign-In Gate (in-app)

The production App Service `dassian-adt-mcp` puts a **Microsoft Entra sign-in in
front of the SAP login page**: a user must sign in with their Dassian account
before the `/oauth/authorize` SAP form is shown. This is implemented **in the
application** (`src/index.ts`), not with App Service Easy Auth — see
[Why not Easy Auth](#why-not-easy-auth).

> Applies to the Azure App Service deployment. In stdio mode, or any self-hosted
> HTTP deployment that leaves `MS_GATE_ENABLED` unset, there is no gate.

## Why not Easy Auth

The first attempt used App Service **Easy Auth** (authSettingsV2) to gate
`/oauth/authorize`. It **breaks the MCP OAuth flow on fresh logins**: Easy Auth
does not preserve the original `/oauth/authorize?...` query string across the
Microsoft round-trip, so `redirect_uri` (and the other OAuth params) are lost and
the SAP form submits with nothing to redirect back to. It *looked* fine in
testing only because a warm Easy Auth cookie skips the round-trip entirely.

**Lesson: do not gate an OAuth `/authorize` endpoint with Easy Auth.** Easy Auth
is now disabled on the site (`authsettingsV2.platform.enabled = false`).

## How it works

The gate lives in the `/oauth/authorize` GET handler plus one new route. It
carries the original OAuth query through Entra in a signed `state`, so the MCP
flow's params survive.

```
Claude connector
    │  GET /oauth/authorize?...client_id=…&redirect_uri=https://claude.ai/…&code_challenge=…
    ▼
[gate] no ms_session cookie? → 302 to Entra
    │     state = sign(base64({ q: <original ?query>, e: <expiry>, n: <nonce> }))
    ▼
login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize   (scope: openid profile email)
    │  user signs in
    ▼
GET /oauth/ms-callback?code=…&state=…
    │  verify state sig+expiry → exchange code → check id_token tid == Dassian tenant
    │  Set-Cookie: ms_session=<signed expiry:oid>  (HttpOnly, Secure, SameSite=Lax)
    ▼
302 → /oauth/authorize?<original query restored>
    │  cookie present → SAP form renders WITH redirect_uri
    ▼
POST /oauth/authorize → code → claude.ai callback → /oauth/token → MCP token
```

Only the interactive `GET /oauth/authorize` is gated. The machine endpoints are
never touched, so the MCP handshake is unaffected:

| Path | Gated? |
|------|--------|
| `GET /oauth/authorize` | **Yes** — redirects to Entra if no valid `ms_session` cookie |
| `GET /oauth/ms-callback` | No (the gate's own callback) |
| `/` (MCP transport) | No — app enforces its own Bearer token |
| `/health`, `/.well-known/*`, `/oauth/token`, `/oauth/register` | No |

**Fail-open:** if `MS_GATE_ENABLED=true` but the gate is misconfigured (missing
secret/tenant/client), it logs a warning and serves the SAP form **without** the
gate — a config mistake can never lock users out.

## Entra app registration

Reuses the app registration created for the original attempt.

| Field | Value |
|-------|-------|
| Display name | `Dassian ADT MCP - Entra Gateway` |
| Application (client) ID | `e9bd0ad9-ff8f-4e79-ba60-68a0309bda40` |
| Tenant (Dassian) | `d95719aa-8e62-45b0-90d2-760342351c59` |
| Redirect URI (Web) | `https://dassian-adt-mcp.azurewebsites.net/oauth/ms-callback` |
| Client secret | App setting `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` (never in source) |

Client ID and tenant ID are not secrets (they appear in the sign-in redirect).
Only the client secret is confidential.

## Configuration (App Service settings)

| Setting | Purpose |
|---------|---------|
| `MS_GATE_ENABLED` | `true` to enable the gate. Unset/`false` = no gate. |
| `ENTRA_TENANT_ID` | `d95719aa-…` — the id_token `tid` is checked against this (Dassian only). |
| `ENTRA_GATE_CLIENT_ID` | `e9bd0ad9-…` |
| `ENTRA_GATE_CLIENT_SECRET` | *(optional)* client secret; falls back to `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`. |
| `MS_SESSION_SECRET` | Random string (e.g. `openssl rand -hex 32`) — HMAC key for the signed `state` and `ms_session` cookie. |
| `MS_SESSION_TTL_HOURS` | *(optional, default 8)* session cookie lifetime. |

## Enable / disable

```bash
# Enable
az webapp config appsettings set -g rg-dsn-ai -n dassian-adt-mcp --settings MS_GATE_ENABLED=true
# Disable (instant off-switch — restarts the app)
az webapp config appsettings set -g rg-dsn-ai -n dassian-adt-mcp --settings MS_GATE_ENABLED=false
```

Setting up from scratch also requires: the `/oauth/ms-callback` redirect URI on
the Entra app, and the `ENTRA_*` + `MS_SESSION_SECRET` settings:

```bash
APPID=e9bd0ad9-ff8f-4e79-ba60-68a0309bda40
az ad app update --id "$APPID" --web-redirect-uris \
  "https://dassian-adt-mcp.azurewebsites.net/oauth/ms-callback"
az webapp config appsettings set -g rg-dsn-ai -n dassian-adt-mcp --settings \
  ENTRA_TENANT_ID=d95719aa-8e62-45b0-90d2-760342351c59 \
  ENTRA_GATE_CLIENT_ID="$APPID" \
  MS_SESSION_SECRET="$(openssl rand -hex 32)"
```

## Verifying

```bash
BASE="https://dassian-adt-mcp.azurewebsites.net"

# Gated page → 302 to login.microsoftonline.com (browser request)
curl -s -D - -o /dev/null -H "Accept: text/html" \
  "$BASE/oauth/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fex.com%2Fcb&code_challenge=a&code_challenge_method=S256" \
  | grep -i '^location:'

# Machine endpoints stay anonymous
curl -s -o /dev/null -w "health:  %{http_code}\n" "$BASE/health"            # 200
curl -s -o /dev/null -w "root:    %{http_code}\n" "$BASE/"                   # 401 (app's own bearer)
```

To confirm the full round-trip preserves params, decode the `state` on the 302:
it base64-decodes to `{ "q": "?response_type=code&…&redirect_uri=…", … }`.

## Rotating the client secret

The Entra client secret has a ~2-year lifetime (set 2026-10-19). Before expiry:

```bash
APPID=e9bd0ad9-ff8f-4e79-ba60-68a0309bda40
# Capture stdout ONLY — see the gotcha below.
SECRET=$(az ad app credential reset --id "$APPID" --display-name "easyauth-gateway" --years 2 --query password -o tsv)
az webapp config appsettings set -g rg-dsn-ai -n dassian-adt-mcp \
  --settings MICROSOFT_PROVIDER_AUTHENTICATION_SECRET="$SECRET"
```

## Gotchas

- **Use the MCP client, not the bare URL.** The gate (and the SAP flow generally)
  only completes when driven by the **connector's OAuth flow**, which supplies
  `client_id` and `redirect_uri`. Opening `https://…/oauth/authorize` directly in
  a browser has no `redirect_uri`, so it dead-ends at *"Missing or invalid
  redirect_uri"* — **expected, not a bug.** (The app also validates `redirect_uri`
  so a bare/malformed value returns 400 instead of crashing the process.)
- **Don't capture stderr into the secret.** `az ad app credential reset` prints a
  long credential-protection *warning* to **stderr**; capturing with `2>&1` stores
  that warning as the "secret" and the Entra token exchange then fails. Capture
  **stdout only** (`--query password -o tsv`, no `2>&1`). A valid secret is ~40 chars.
- **`tid` restriction.** The gate only admits users whose id_token `tid` equals
  `ENTRA_TENANT_ID` (the Dassian tenant); others get a 403.
