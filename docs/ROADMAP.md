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
