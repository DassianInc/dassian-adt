# Entra ID Sign-In Gateway (Azure App Service)

The production App Service `dassian-adt-mcp` is fronted by a **Microsoft Entra ID
sign-in gateway**, implemented with **App Service Easy Auth** (`authSettingsV2`).
It forces an interactive Microsoft sign-in **before** a user can reach the SAP
login page — with **no change to the application code**. The server's own OAuth
flow (the SAP-credentials login described in `src/index.ts` `runHttp()`) is
untouched; the gateway simply sits in front of it.

> This applies only to the Azure App Service deployment. In stdio mode, and in
> any self-hosted HTTP deployment that doesn't enable Easy Auth, there is no
> Entra gateway.

## Why

The MCP server is a custom OAuth **authorization server** (it serves
`/.well-known/oauth-*`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`).
Its `/oauth/authorize` page collects raw **SAP** credentials. Putting it on the
public internet with only that page in front of it means anyone who finds the URL
can reach the SAP login prompt. The gateway requires a valid **Dassian Entra
account** first, so only employees ever see the SAP form.

## Two-layer auth model

There are two independent layers. They must not interfere, which is why the
gateway excludes the machine endpoints.

| Layer | Enforced by | Protects |
|-------|-------------|----------|
| Entra sign-in (this gateway) | App Service Easy Auth, at the edge | The interactive `/oauth/authorize` page (and any future interactive route) |
| MCP bearer token | The app itself (`issuedTokens` in `src/index.ts`) | The MCP transport at `/` and the token-issuing flow |

The MCP OAuth handshake (discovery → dynamic client registration → token
exchange → connecting to `/`) is **machine-to-machine** and must stay anonymous
at the edge, or every MCP client breaks. Only the browser-facing authorize page
is gated.

### Endpoint behavior

| Path | Easy Auth | Who calls it | Result |
|------|-----------|--------------|--------|
| `/oauth/authorize` | **Gated** | Browser (human) | Unauthenticated browser → **302** to Microsoft sign-in |
| `/` (MCP transport) | Excluded | MCP client | App enforces its own `Bearer` token → `401` if missing |
| `/health` | Excluded | Monitoring | `200` JSON, anonymous |
| `/.well-known/oauth-authorization-server` | Excluded | MCP client | `200` anonymous |
| `/.well-known/oauth-protected-resource` | Excluded | MCP client | `200` anonymous |
| `/oauth/token` | Excluded | MCP client | App handles, anonymous |
| `/oauth/register` | Excluded | MCP client | App handles (dynamic client registration), anonymous |

`RedirectToLoginPage` only issues the `302` to Microsoft for requests whose
`Accept` header asks for HTML. A non-HTML request to a gated path gets a plain
`401` — which is the desired behavior for anything that isn't a browser.

## Entra app registration

A dedicated single-tenant app registration backs the gateway.

| Field | Value |
|-------|-------|
| Display name | `Dassian ADT MCP - Entra Gateway` |
| Application (client) ID | `e9bd0ad9-ff8f-4e79-ba60-68a0309bda40` |
| Tenant (Dassian) | `d95719aa-8e62-45b0-90d2-760342351c59` |
| Sign-in audience | Single tenant (`AzureADMyOrg`) |
| Redirect URI (Web) | `https://dassian-adt-mcp.azurewebsites.net/.auth/login/aad/callback` |
| ID token issuance | Enabled |
| Client secret | Stored **only** as the App Service setting `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` (never in source) |

The client ID and tenant ID are not secrets — they are visible in the sign-in
redirect of the live site. The **client secret** is confidential and lives only
in App Service configuration.

## Easy Auth configuration (`authSettingsV2`)

This is the full config applied to
`Microsoft.Web/sites/dassian-adt-mcp/config/authsettingsV2`:

```json
{
  "properties": {
    "platform": { "enabled": true },
    "globalValidation": {
      "requireAuthentication": true,
      "unauthenticatedClientAction": "RedirectToLoginPage",
      "excludedPaths": [
        "/",
        "/health",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
        "/oauth/token",
        "/oauth/register"
      ]
    },
    "identityProviders": {
      "azureActiveDirectory": {
        "enabled": true,
        "registration": {
          "openIdIssuer": "https://login.microsoftonline.com/d95719aa-8e62-45b0-90d2-760342351c59/v2.0",
          "clientId": "e9bd0ad9-ff8f-4e79-ba60-68a0309bda40",
          "clientSecretSettingName": "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET"
        },
        "validation": {
          "allowedAudiences": ["e9bd0ad9-ff8f-4e79-ba60-68a0309bda40"]
        }
      }
    },
    "login": {
      "tokenStore": { "enabled": true }
    }
  }
}
```

`excludedPaths` matches exact paths (a trailing `/*` makes it a prefix match).
The gate applies to everything **not** listed — most importantly
`/oauth/authorize`.

> **Adding a new anonymous route?** If you add any new machine-facing or
> monitoring endpoint to `src/index.ts`, add its path to `excludedPaths` too, or
> the gateway will start returning `401` to non-browser callers. `/health` was
> added here for exactly this reason.

## Applying / reproducing the config

Requires Azure CLI logged in to the Dassian tenant with rights on `rg-dsn-ai`.

```bash
SUB=$(az account show --query id -o tsv)          # subscription for rg-dsn-ai
# Save the JSON above to authsettingsV2.json, then:
az rest --method PUT \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/rg-dsn-ai/providers/Microsoft.Web/sites/dassian-adt-mcp/config/authsettingsV2?api-version=2023-12-01" \
  --body @authsettingsV2.json
```

The App Service restarts automatically; changes take ~30–60s to propagate.

### Recreating the app registration from scratch

```bash
# 1. App registration (single tenant, Easy Auth callback, ID tokens on)
az ad app create \
  --display-name "Dassian ADT MCP - Entra Gateway" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://dassian-adt-mcp.azurewebsites.net/.auth/login/aad/callback" \
  --enable-id-token-issuance true

APPID=<appId-from-above>
az ad sp create --id "$APPID"

# 2. Client secret — capture stdout ONLY (see gotcha below), store as app setting
SECRET=$(az ad app credential reset --id "$APPID" --display-name "easyauth-gateway" --years 2 --query password -o tsv)
az webapp config appsettings set -g rg-dsn-ai -n dassian-adt-mcp \
  --settings MICROSOFT_PROVIDER_AUTHENTICATION_SECRET="$SECRET"

# 3. Apply the authsettingsV2.json above (with this appId / tenant).
```

## Verifying

```bash
BASE="https://dassian-adt-mcp.azurewebsites.net"

# Interactive page is gated → 302 to login.microsoftonline.com
curl -s -D - -o /dev/null -H "Accept: text/html" \
  "$BASE/oauth/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fex.com%2Fcb&code_challenge=a&code_challenge_method=S256" \
  | grep -iE '^(HTTP/|location:)'

# Machine endpoints stay anonymous
curl -s -o /dev/null -w "health:      %{http_code}\n" "$BASE/health"            # 200
curl -s -o /dev/null -w "authz-meta:  %{http_code}\n" "$BASE/.well-known/oauth-authorization-server"  # 200
curl -s -o /dev/null -w "mcp root:    %{http_code}\n" "$BASE/"                   # 401 (app's own bearer check)
```

## Rotating the client secret

The secret has a 2-year lifetime. Before it expires:

```bash
APPID="e9bd0ad9-ff8f-4e79-ba60-68a0309bda40"
SECRET=$(az ad app credential reset --id "$APPID" --display-name "easyauth-gateway" --years 2 --query password -o tsv)
az webapp config appsettings set -g rg-dsn-ai -n dassian-adt-mcp \
  --settings MICROSOFT_PROVIDER_AUTHENTICATION_SECRET="$SECRET"
```

Setting the app setting restarts the app and Easy Auth reloads the secret. No
`authsettingsV2` change is needed — it references the secret by setting name.

## Disabling the gateway (rollback)

```bash
az webapp auth update -g rg-dsn-ai -n dassian-adt-mcp --enabled false
```

This turns off Easy Auth entirely; the app falls back to its own OAuth/SAP login
with no Microsoft sign-in in front. Re-apply the `authsettingsV2.json` to restore.

## Gotchas

- **Don't capture stderr into the secret.** `az ad app credential reset` prints a
  long credential-protection *warning* to **stderr**. If you capture with
  `2>&1`, that warning text gets stored as the "secret" and the Microsoft token
  exchange fails at `/.auth/login/aad/callback` with a `401`. Capture **stdout
  only** (`--query password -o tsv`, no `2>&1`). A valid secret is ~40 chars.
- **`RedirectToLoginPage` returns `401`, not `302`, for non-HTML requests.** When
  testing the gate with `curl`, send `-H "Accept: text/html"` to see the real
  browser redirect.
- **Keep machine/monitoring paths in `excludedPaths`.** See the note under the
  config above.
