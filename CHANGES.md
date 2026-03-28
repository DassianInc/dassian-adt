# What Changed

Based on the original MCP server by Mario Andreschak. This fork focuses on letting the AI do real development work — not just read code, but write it, activate it, manage transports, and clean up after itself. The changes below address what broke when we started using it that way.

## Crash elimination

Every handler in the original would blow up with `Cannot read properties of undefined` if the AI forgot a parameter. We added a centralized validation middleware in BaseHandler that reads each tool's JSON schema `required` array and rejects calls with missing fields *before* any handler logic runs. One guard for all 25 tools. 163 unit tests verify it.

## Type auto-mapping

The ADT library needs `CLAS/OC`, `PROG/P`, `DDLS/DF`, etc. AIs send `CLAS`, `PROG`, `DDLS`. The server now maps 16 short types to their full subtypes automatically in `abap_create`. No more "Unsupported object type" errors.

## FUGR handling

The original `transport_assign` did lock→write→unlock on function groups, which writes to the main include and creates an inactive SAPL program version. We added FUGR, MSAG, and ENHS to a `METADATA_TYPES` set that uses `transportReference` instead — no lock, no write, no inactive version.

## Delete bypass

The `abap-adt-api` library appends `?corrNr=TRANSPORT` to DELETE requests. SAP's DDLS endpoint rejects that parameter. We bypass the library and call `h.request(objectUrl, { method: 'DELETE', qs: { lockHandle } })` directly.

## ATC workaround

On systems with `ciCheckFlavour=true` (like D25), `createAtcRun` ignores the variant and runs CI-scoped checks. We skip `createAtcRun` entirely and fetch the existing worklist via `atcCheckVariant` → `atcWorklists` — same results as a full Eclipse ATC run.

## Interface method auto-detection

`IF_OO_ADT_CLASSRUN` uses `~run` on ≤2023 and `~main` on 2024+. The original hardcoded `run`. We read the interface source after login to detect the correct method. The `abap_run` tool now works on D23, D25, and M25 without the user knowing which release they're on.

## Session management

`withSession()` wraps every ADT call. If the session expires mid-operation, it re-logs in automatically and retries. Users never see a session timeout error.

## Error intelligence

`parseAdtError` classifies every SAP error: session timeout, upgrade mode (SPAU), locked objects, not found, opaque `I::000` codes, L-prefix include rejection. `formatError` adds actionable hints — "Check SM12 for locks", "Run SPAU_ENH to clear upgrade flag", "Use FUGR/FF instead of the system-generated include name." `formatActivationMessages` adds hints for syntax errors, inactive dependents, locked objects, and pipe character escaping in string templates. The AI reads these hints and self-corrects on the next call.

## Smart redirects

If the AI passes a transport number to `transport_info` (which expects an object name), the server detects the pattern via regex and responds: "Use `transport_contents` instead." This happens for every common mistake we've seen AIs make.

## MCP elicitation

When a required parameter is missing, instead of returning an error, the server sends an `elicitation/create` request back to the client. The user sees a form: "Which package should this object be created in?" with a default of `$TMP`. They pick, the server continues. No round-trip through the AI.

Wired up on:
- `abap_create` — missing package prompt
- `abap_set_source` — missing transport prompt (catches SAP rejection, asks user, retries)
- `abap_delete` — non-$TMP confirmation with object/transport context
- `abap_activate` — inactive dependents offer to activate them
- `abap_run` — leftover class from failed run, offers to delete and retry
- `transport_assign` — confirmation before modifying transport contents
- `transport_release` — irreversible action confirmation

Falls back gracefully on clients that don't support elicitation.

## abap_run rewrite

The original called the library's `runClass()` which sent no Accept header, causing silent failures. We call the classrun endpoint directly with `Accept: text/plain`. We also handle: session state transitions (stateful for activation → stateless for classrun), HTTP 200 with error body detection, 500 with ST22 dump hint, and automatic cleanup with best-effort delete in a `finally` block.

## abap_get_function_group

New tool. Fetches `/objectstructure`, parses all `atom:link` hrefs for includes and function modules, fetches all sources in parallel. One call gives you the entire function group instead of 15 individual `abap_get_source` calls.

## abap_query and abap_table fixes

The library's `runQuery()` omits `Content-Type`, causing 400 on all systems. We set `Content-Type: text/plain` and `Accept: application/*` via direct HTTP. `abap_table` detects LIKE/BETWEEN in WHERE clauses and routes through `datapreview/freestyle` instead of `tableContents` which rejects them.

## Test suite

163 unit tests covering URL builder (every object type, namespace encoding, edge cases), error classification (every SAP error condition), and input validation (every tool with missing required params). Integration test scaffold for live SAP testing. E2E write-path test: create → write → syntax check → activate → delete. AI self-test prompt for exploratory fuzzing. All running on Jest with ts-jest, `npm test` in under 3 seconds.

## What didn't change

The `abap-adt-api` library by Marcello Urbani. The MCP SDK. The basic handler architecture (BaseHandler → subclass per domain). We built on what worked and fixed what broke in real use.

## Credits

- **Mario Andreschak** — original MCP server scaffold
- **Marcello Urbani** — `abap-adt-api` library (the ADT HTTP client underneath everything)
- **Dassian Inc.** — validation, elicitation, error handling, test suite
