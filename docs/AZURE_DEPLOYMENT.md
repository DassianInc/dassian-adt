# dassian-adt: Azure Deployment Guide

## What This Is

The production deployment that claude.ai and Claude Code connect to is a single
**Azure App Service** running this server in HTTP mode. Each user authenticates
with their own SAP credentials through a browser login page, behind a Microsoft
Entra sign-in gateway. One process serves all users; each gets its own MCP
session and its own SAP session.

| | |
|---|---|
| **App Service** | `dassian-adt-mcp` |
| **URL** | `https://dassian-adt-mcp.azurewebsites.net` |
| **Resource group** | `rg-dsn-ai` |
| **Region** | East US 2 |
| **OS / runtime** | Linux, Node 22 LTS (`NODE|22-lts`) |
| **MCP endpoint** | `/` (the site root) |
| **Health check** | `/health` (anonymous) |
| **Auth mode** | `oauth` — per-user SAP login (see below) |
| **Sign-in gateway** | Microsoft Entra — see [ENTRA_GATEWAY.md](ENTRA_GATEWAY.md) |

## Topology

```
Claude client (claude.ai connector / Claude Code)
    │   MCP OAuth handshake + streamable HTTP
    ▼
dassian-adt-mcp  (App Service, Node 22, this server in HTTP mode)
    │   in-app Entra gate on /oauth/authorize → Microsoft sign-in (see ENTRA_GATEWAY.md)
    │   per-user SAP session (basic auth with the user's own credentials)
    ▼
SAP ADT endpoints  (…app.dassian.org / .dassian.azure : 44300)
```

Two auth layers sit in front of SAP and must not be confused — the in-app Entra
gate on `/oauth/authorize` (Microsoft sign-in) and the app's own MCP OAuth (which
issues the Bearer token MCP clients use). The gate is implemented in the app, not
Easy Auth (which was tried and abandoned). [ENTRA_GATEWAY.md](ENTRA_GATEWAY.md)
covers it in detail.

## Auth modes

`MCP_AUTH_MODE` (in `src/index.ts` `runHttp()`) selects how sessions get SAP
credentials. Production runs **`oauth`**.

| Mode | Behavior |
|------|----------|
| `service` | All sessions share the service-account credentials from `SAP_SYSTEMS`. No login page. |
| `oauth` *(production)* | Each user signs in at `/oauth/authorize` with their **own** SAP credentials; the server issues a 30-day MCP Bearer token bound to that session. Per-user audit trail. |
| `hybrid` | OAuth users get their own credentials; unauthenticated callers fall back to the service account. |

In `oauth` mode the `/oauth/authorize` page lists every configured system and
asks for a password per system (the "Fill all passwords at once" box sets them
together). The system list comes from `SAP_SYSTEMS`.

## App Service configuration

Application settings (Configuration → Application settings). Secrets are marked
— never commit their values.

| Setting | Value | Purpose |
|---------|-------|---------|
| `MCP_TRANSPORT` | `http` | Run the HTTP server (not stdio). |
| `MCP_HTTP_PATH` | `/` | MCP endpoint path. Clients connect to the site root. |
| `MCP_AUTH_MODE` | `oauth` | Per-user SAP login (see above). |
| `SAP_DEFAULT_SYSTEM` | `x22` | Default `sap_system_id` when a tool call omits it. |
| `SAP_SYSTEMS` | *(secret)* | JSON array of system configs (`id`, `url`, `client`, `language`, + optional creds). Drives the login form's system list. |
| `MCP_API_KEY` | *(secret)* | Optional. If set, a client may pass `Authorization: Bearer <key>` to use the service account instead of logging in. |
| `MS_GATE_ENABLED` | `true` | Enable the in-app Entra sign-in gate — see [ENTRA_GATEWAY.md](ENTRA_GATEWAY.md). |
| `ENTRA_TENANT_ID` | `d95719aa-…` | Dassian tenant; the gate admits only this tenant's users. |
| `ENTRA_GATE_CLIENT_ID` | `e9bd0ad9-…` | Entra app for the gate. |
| `MS_SESSION_SECRET` | *(secret)* | HMAC key signing the gate's `state` + `ms_session` cookie. |
| `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` | *(secret)* | Entra gate client secret (the gate's `ENTRA_GATE_CLIENT_SECRET` falls back to this). |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` | Deploy a prebuilt artifact; do **not** run an Oryx build. The zip must include `node_modules`. |
| `WEBSITE_NODE_DEFAULT_VERSION` | `~22` | Node 22. |

> **`SAP_SYSTEMS` shape** — see `SystemConfig` in `src/lib/auth.ts`. Each entry
> needs at least `id` and `url`; auth fields (`user`/`password`, `serviceKey`,
> `oauthTokenUrl`+client creds, or `entra*`) are only needed for `service`/
> `hybrid` fallback. In pure `oauth` mode the entries just supply the id/url/
> client/language used to build the login form.

## Deploy

Deployment is a prebuilt zip pushed with `az webapp deploy`. Because
`SCM_DO_BUILD_DURING_DEPLOYMENT=false`, build locally and include `node_modules`
in the zip.

```bash
npm run build
zip -r /tmp/dassian-adt.zip dist package.json node_modules -x "node_modules/.cache/*"
az webapp deploy \
  --resource-group rg-dsn-ai \
  --name dassian-adt-mcp \
  --src-path /tmp/dassian-adt.zip \
  --type zip
```

Deployment takes ~60 seconds. The App Service restarts automatically.

## Verify

```bash
BASE="https://dassian-adt-mcp.azurewebsites.net"

# Health — anonymous, lists auth mode, configured systems, and running versions
curl -s "$BASE/health"
# {"status":"ok","version":"2.0.0","sessions":0,"authMode":"oauth",
#  "systems":[...],"defaultSystem":"x22",
#  "versions":{"node":"v22...","abap-adt-api":"7.1.3","axios":"1.20.0",
#              "hono":"4.13.13","@modelcontextprotocol/sdk":"1.32.1"}}

# The login page is gated by Entra — a browser request 302s to Microsoft sign-in
curl -s -D - -o /dev/null -H "Accept: text/html" "$BASE/oauth/authorize" | grep -i '^location:'
```

The `version` and `versions` fields report what the **running process** actually
loaded (app version, Node, and key dependencies), read at startup via
`require.resolve`. Use them to confirm a deploy is live — e.g. that a dependency
bump actually shipped — rather than inferring from `package-lock.json`.

## How users connect

The server is registered as a remote MCP connector (e.g. the "Dassian ADT"
claude.ai connector / a Claude Code URL entry pointing at
`https://dassian-adt-mcp.azurewebsites.net`). On first use the MCP client runs
the OAuth handshake:

1. Client discovers `/.well-known/oauth-*`, registers, and opens `/oauth/authorize`
   (with its OAuth params) in the browser.
2. The **in-app Entra gate** requires a Dassian Microsoft sign-in first.
3. The **SAP login page** appears — the user enters their SAP password(s).
4. The server issues a 30-day MCP Bearer token; SAP tools work from then on.

> **Always connect through the MCP client**, which supplies the OAuth params.
> Opening `https://…/oauth/authorize` directly in a browser has no `redirect_uri`
> and dead-ends at *"Missing or invalid redirect_uri"* — expected, not a bug.

SAP password rotation needs no redeploy — each user logs in with their own
credentials, and MCP tokens expire after 30 days.

## Error logs

Errors are appended to `/home/LogFiles/dassian-adt-errors.jsonl` on the App
Service (persistent mount, survives redeploys). Kudu basic auth is disabled —
pull with an ARM bearer token:

```bash
TOKEN=$(az account get-access-token --resource "https://management.azure.com/" --query accessToken -o tsv)
curl -H "Authorization: Bearer $TOKEN" \
  "https://dassian-adt-mcp.scm.azurewebsites.net/api/vfs/LogFiles/dassian-adt-errors.jsonl"
```

Each line: `{ ts, tool, system, error_type, message, http_status, args }`. See
the "Pull the Error Log" section in [CLAUDE.md](../CLAUDE.md) for error-type
meanings.

## SAP connectivity

The App Service must be able to reach the SAP ADT endpoints on port **44300**
(hosts under `*.dassian.org` and `*.dassian.azure`). The authoritative list of
systems and URLs lives in the `SAP_SYSTEMS` app setting; `/health` returns the
current system ids. If SAP presents self-signed certificates, set
`NODE_TLS_REJECT_UNAUTHORIZED=0` as an app setting.

## Self-hosting (non-App-Service)

To run outside App Service (a VM, container, etc.), the only requirement is a
Node 22 process running `node dist/index.js` with the same environment variables
(`MCP_TRANSPORT=http`, `MCP_HTTP_PATH`, `MCP_AUTH_MODE`, `SAP_SYSTEMS`, …) behind
TLS. There is no Entra gateway in that case unless you put one in front
yourself; restrict network exposure accordingly.
