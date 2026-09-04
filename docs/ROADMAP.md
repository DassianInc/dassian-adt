# dassian-adt Roadmap

## Planned Features

### 1. Fix Proposals (`abap_fix_proposals`)
**Priority: High — pairs with existing `abap_syntax_check`**

Single tool: given an object URL + source + error position, return the ADT-suggested quick fixes.
Claude calls syntax check → gets errors with positions → calls fix proposals → applies the fix.

| Parameter | Type | Notes |
|-----------|------|-------|
| `name` | string | Object name |
| `type` | string | Object type |
| `line` | number | Error line (from syntax check result) |
| `column` | number | Error column |

Returns: array of `{ title, description, changes: [{ uri, range, newText }] }`

Library: `fixProposals(url, source, line, col)` + `fixEdits(url, source, proposal)`

---

### 2. Unit Test Runner (`abap_unit_test`)
**Priority: High**

Single tool: run unit tests for a given object, return pass/fail summary with failure details.

| Parameter | Type | Notes |
|-----------|------|-------|
| `name` | string | Object name (class or program) |
| `type` | string | Object type (default `CLAS`) |
| `risk` | string | `harmless`, `dangerous`, `critical`, or `all` (default `all`) |
| `duration` | string | `short`, `medium`, `long`, or `all` (default `all`) |

Returns:
- Summary: total tests, passed, failed, errors
- Per-class breakdown with method-level results
- For failures: alert title, details, stack trace with source locations

Library: `unitTestRun(url, flags)` → `UnitTestClass[]`

---

### 4. RAP Objects
**Priority: Medium — relevant for Clean Core / BTP work**

Extend existing `abap_get_source`, `abap_write`, `abap_activate`, `abap_syntax_check`, `abap_create` to handle these additional object types. No new tools needed — just register the types.

#### Object Types to Add

| Type Code | Description | ADT Base Path | Notes |
|-----------|-------------|---------------|-------|
| `BDEF` | Behavior Definition | `/sap/bc/adt/bo/behaviordefinitions` | Full CRUD |
| `DDLS` | CDS View | `/sap/bc/adt/ddic/ddl/sources` | Full CRUD |
| `DDLX` | Metadata Extension | `/sap/bc/adt/ddic/ddlx/sources` | Full CRUD |
| `SRVD` | Service Definition | `/sap/bc/adt/ddic/srvd/sources` | Full CRUD |
| `SRVB` | Service Binding | `/sap/bc/adt/businessservices/bindings` | Full CRUD |

#### Additional RAP-specific Tools

**`rap_publish_binding`** — publish or unpublish a service binding

| Parameter | Type | Notes |
|-----------|------|-------|
| `name` | string | Service binding name |
| `version` | string | Binding version e.g. `"0001"` |
| `action` | string | `publish` or `unpublish` |

Returns: severity + result message from SAP.

Library: `publishServiceBinding(name, version)` / `unPublishServiceBinding(name, version)`

---

### 5. Semantic Navigation (enhancement of existing tools)
**Priority: Low — library has it, value unclear until tested**

`findDefinition` and `typeHierarchy` are in `abap-adt-api` but require cursor position (line/col) which is awkward to drive from Claude without an editor. Defer until there's a clear use case.

`usageReferences` with snippets is essentially what `abap_where_used` already does — check for overlap before building.

---

## Technical Debt

### Generated ABAP lives in TypeScript strings — nothing checks it
**Priority: Medium — no user-visible bug, but every mistake here is found the expensive way**

Roughly eight places build ABAP source as template literals in TypeScript and ship it
to SAP to run (`TransportHandlers`, `ObjectHandlers`, `RunHandlers`, all funnelling
through `runClassrun` in `BaseHandler`). To the toolchain that ABAP is just a string:
no syntax highlighting, no syntax check, no linting, no review-time readability. A typo
or a wrong parameter type is invisible until it runs against a live SAP system — and in
some cases only after it has already half-written data. The `CALL_FUNCTION_CONFLICT_TYPE`
trap documented in `cleanupDdicRepositoryEntries` is exactly this failure mode.

The fix is not to eliminate the strings. That code runs on the SAP server, so it has to
travel as text, and TypeScript can no more check ABAP than it can check SQL. The goal is
to **move the moment we find out we're wrong** from "we ran it against a live system" to
"the build failed."

Three options, worst to best value:

1. **Syntax-check before executing.** Have `runClassrun` push the generated class through
   SAP's syntax-check endpoint (already exposed as `abap_syntax_check`) and refuse to run
   if it doesn't parse. Cheap and safe, but catches only typos, and still needs a live system.
2. **Move the ABAP into real `.abap` files** read at build time instead of template literals.
   Mostly mechanical. Buys syntax highlighting, readable diffs, and reviewable code.
3. **Lint those files in CI** with `abaplint` — an open-source ABAP parser that runs on Node,
   offline, no SAP connection needed.

**Recommendation: 2 and 3 together.** 2 on its own is cosmetic; it is what makes 3 possible,
and 3 is where the safety actually comes from. Skip 1 — it is redundant once 3 is in place.

Already in place and worth keeping: the `q()` escaping helper stops interpolated values
breaking out of the generated code, and the DOMA/DTEL unit tests assert on the generated
text. The missing piece is that nothing checks whether the ABAP is valid ABAP.

---

## Completed
- Multi-system support (`sap_system_id` per tool call, `SAP_SYSTEMS_FILE`, `SAP_LANDSCAPE_URL`)
- ABAP source CRUD (get, write, activate, delete, syntax check)
- ATC quality checks
- Transport management (create, assign, release, contents, TOC support)
- Object search, where-used, class hierarchy, object info
- Table contents reader
- ABAP run (classrun / console)
- abapGit integration
- ABAP dump viewer (`abap_get_dump` in SystemHandlers, auto-fetches on failed `abap_run`)
- OAuth/Entra ID auth (code present, untested)
