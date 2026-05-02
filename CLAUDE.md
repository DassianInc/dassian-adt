# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Compile TypeScript → dist/
npm test               # Unit tests only (~180 tests, no SAP needed, <3s)
npm run test:coverage  # Unit tests with coverage report
npm run test:live      # Integration tests (needs SAP env vars)
npm run test:e2e       # End-to-end write lifecycle (create → write → activate → delete)
npm run dev            # Launch MCP Inspector for interactive tool testing
```

Run a single test file:
```bash
npx jest src/__tests__/unit/urlBuilder.test.ts
npx jest src/__tests__/unit/errors.test.ts
```

After any source change: `npm run build` — the MCP server runs from `dist/`, not `src/`.

## Architecture

### Request Flow

```
index.ts (AbapAdtServer)
  → handler.validateAndHandle(toolName, args)   ← centralized required-field check
    → handler.handle(toolName, args)             ← switch to concrete method
      → this.withSession(() => adtclient.xxx())  ← auto-reconnect wrapper
```

`index.ts` registers all handlers, wires elicitation/notify/sampling callbacks, and dispatches every `tools/call` to the correct handler's `validateAndHandle`. No tool routing logic lives outside `index.ts`.

### Handler Hierarchy

All 8 handlers extend `BaseHandler` (`src/handlers/BaseHandler.ts`), which provides:
- `withSession(fn)` — wraps every ADT call; detects session expiry (401, ambiguous 400) and re-logins transparently
- `validateAndHandle(toolName, args)` — checks JSON schema `required` fields before any handler code runs
- `elicitForm / elicitChoice / confirmWithUser` — MCP elicitation forms injected from `index.ts`
- `notify(msg, level)` — progress messages visible in Claude Code's UI
- `askClaude(system, user)` — sampling to ask Claude a question without interrupting the user
- `fail(msg)` — throws McpError; never returns

### Lock → Write → Unlock Pattern

**Critical invariant**: lock, write, and unlock for any object MUST happen inside a single `withSession(async () => { ... })` block — never in separate `withSession` calls.

Reason: if a session timeout fires between calls, `withSession` re-logins and retries only the one operation it wraps. A lock handle acquired in session A is invalid in session B.

The canonical pattern (from `handleSetSource`):
```typescript
const doWrite = async (): Promise<void> => {
  const r = await this.adtclient.lock(objectUrl);
  lockHandle = r.LOCK_HANDLE;
  try {
    await this.adtclient.setObjectSource(sourceUrl, source, lockHandle!, transport);
  } catch (err) {
    try { await this.adtclient.unLock(objectUrl, lockHandle!); } catch (_) {}
    lockHandle = null;
    // If unLock also failed (dead session), sleep before rethrowing so SAP's
    // session cleanup can release the orphaned enqueue entry before withSession retries.
    if (writeWasDeadSession) await new Promise(r => setTimeout(r, 3000));
    throw err;
  }
  await this.adtclient.unLock(objectUrl, lockHandle!);
  lockHandle = null;
};
await this.withSession(doWrite);
```

`handleSetSource` and `handleSetClassInclude` also retry up to 3 times (0s / 3s / 8s) on "locked by another" errors with `notify()` progress messages.

### Error Classification Pipeline

`src/lib/errors.ts`:
- `parseAdtError(error)` — classifies SAP errors into `AdtErrorInfo` fields: `isSessionTimeout`, `isLocked`, `isNotFound`, `isUpgradeMode`, `isAmbiguous400`
- `isAmbiguous400` — HTTP 400 with no meaningful body; treated as session expiry (stale CSRF token). `withSession` detects this and re-logins automatically.
- `formatError(operation, error)` — converts classified errors into actionable human-readable messages with self-correction hints (what to call next, why it failed)

**`AdtErrorException` field layout:** The library stores the HTTP status in `.err` (not `.response.status` — `.response` is often `undefined`). `parseAdtError` reads `error?.response?.status ?? error?.err` so both shapes are covered. Do not rely on `error?.response?.status` alone.

When adding a new error condition, update `parseAdtError` first (adds detection), then `formatError` (adds the message).

### URL Construction

`src/lib/urlBuilder.ts` is the single source of truth for all ADT paths. `TYPE_PATHS` maps ABAP type strings to their ADT base paths. `buildObjectUrl(name, type)` is for lock/unlock/delete; `buildSourceUrl(name, type)` appends `/source/main` for read/write.

Namespace encoding: `/` → `%2f`, `$` → `%24`, always lowercase. Handled by `encodeAbapName()`.

Nested types (FUGR/I, FUGR/FF) require runtime URL discovery via `searchObject` — see `resolveNestedUrl` in `BaseHandler`.

### Transport Request vs Task Number (corrNr)

`transport_create` returns the **request** number (e.g. D25K900183). SAP source writes (`setObjectSource`, `corrNr` param) require the **task** number (a child of the request, e.g. D25K900184). Using the request number as `corrNr` captures nothing on the transport.

How each path handles this:
- **Locked writes** (`abap_set_source`, `abap_set_class_include`): `requireTransport()` in `BaseHandler` reads `lockResult.CORRNR`, which SAP populates with the task number at lock time. This is always preferred over the caller-supplied transport.
- **Lockless writes** (`doLocklessWrite` for DDLS/DDIC types): calls `resolveTaskNumber()` which walks `userTransports` to find the user's task on the given request.
- **`transport_create`**: after creation, calls `resolveTaskNumber()` and includes both the request and task in its response, with an explicit hint to pass the task to downstream tools.

### Transport Release: Older System Compatibility

`TransportHandlers.releaseOne(number, ignoreAtc)` wraps `adtclient.transportRelease`. Older SAP systems (S/4 2022, X22) require an XML `<tm:root>` request body in the release POST — the library sends no body. When the "expected the element" error appears, `releaseOne` retries via `h.request` with the body.

`ADTClient.transportRelease` signature: `(transportNumber, ignoreLocks, IgnoreATC)` — `ignoreAtc` goes in the **third** slot, not second.

### Transport Assign: Metadata vs Source Types

`TransportHandlers.handleAssign` has two paths:
- **METADATA_TYPES** (`VIEW`, `TABL`, `DOMA`, `DTEL`, `SHLP`, `SQLT`, `TTYP`, `DEVC`, `FUGR`, `MSAG`, `ENHS`): uses `transportReference()` — no lock, no write, no inactive version created
- **All others** (CLAS, PROG, DDLS, etc.): lock → read current source → write same source with corrNr → unlock

Adding a type that breaks on lock/write (e.g., generates inactive includes) to `METADATA_TYPES` is the right fix.

### `raw_http` Hard Rule

**Never use `raw_http` to POST to lock endpoints** (`?method=adtLock`). Each `raw_http` call may use a different ICM HTTP session from the ADT client. A failed lock POST leaves a stale enqueue entry with no handle on our side, blocking all subsequent writes until SM04/SM12 cleanup. The `raw_http` tool description states this explicitly.

### MCP Prompts

`index.ts` defines 4 built-in prompts callable as slash commands: `fix-atc`, `transport-review`, `class-overview`, `release-transport`. These are multi-step ABAP workflows pre-scripted as MCP prompt messages. Add new ones to the `PROMPTS` array.

## Deployment

The server runs in two modes:
- **Stdio** — local Claude Code integration (one process per SAP system config)
- **HTTP streaming** — `dassian-adt-mcp` Azure App Service (East US 2, `rg-dsn-ai`), used by claude.ai

### Deploy to Azure App Service

```bash
npm run build
zip -r /tmp/dassian-adt.zip dist package.json node_modules -x "node_modules/.cache/*"
az webapp deploy --resource-group rg-dsn-ai --name dassian-adt-mcp --src-path /tmp/dassian-adt.zip --type zip
```

Deployment takes ~60 seconds. The App Service URL is `https://dassian-adt-mcp.azurewebsites.net`.

### Pull the Error Log

Errors are appended to `/home/LogFiles/dassian-adt-errors.jsonl` on the App Service (persistent Azure Files mount, survives redeploys). Kudu basic auth is disabled — use an ARM bearer token:

```bash
TOKEN=$(az account get-access-token --resource "https://management.azure.com/" --query accessToken -o tsv)
curl -H "Authorization: Bearer $TOKEN" \
  "https://dassian-adt-mcp.scm.azurewebsites.net/api/vfs/LogFiles/dassian-adt-errors.jsonl"
```

Each line is a JSON record: `{ ts, tool, system, error_type, message, http_status, args }`. The `args` field captures the input parameters with long strings truncated to 120 chars. Error types: `session_timeout`, `locked`, `not_found`, `upgrade_mode`, `lock_not_supported`, `soft_failure`, `internal`.

Locally (stdio mode) errors go to `~/.dassian-adt/errors.jsonl`. Override either path with `ADT_ERROR_LOG` env var.

## Test Structure

Unit tests (`src/__tests__/unit/`) test `urlBuilder.ts` and `errors.ts` exhaustively and `BaseHandler` validation — no mocking of `adtclient`. Integration and E2E tests require live SAP connection via environment variables (`SAP_URL`, `SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`).

The 2 known failing unit tests are stale expectations for SRVD/SRVB URL paths — the code is correct, the test assertions need updating.
