# dassian-adt

MCP server for SAP ABAP development via the ADT API. Connect AI assistants to your SAP system — read, write, test, and deploy ABAP code without SAP GUI.

The AI can create objects, write source, activate, manage transports, run code, query tables, and check quality. Full development lifecycle, not just read-only or code generation.

## Origins

Based on [mcp-abap-abap-adt-api](https://github.com/mario-andreschak/mcp-abap-abap-adt-api) by **[Mario Andreschak](https://github.com/mario-andreschak)** and the [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) library by **[Marcello Urbani](https://github.com/marcellourbani)**.

Dassian's fork adds input validation, error intelligence, MCP elicitation, session recovery, and a test suite. See [CHANGES.md](CHANGES.md) for the full list.

## What It Does

25 tools covering the full ABAP development lifecycle:

| Category | Tools | What They Do |
|----------|-------|-------------|
| **Source** | `abap_get_source`, `abap_set_source`, `abap_get_function_group` | Read/write ABAP source for any object type. Function group tool fetches all includes and FMs in one call. |
| **Objects** | `abap_create`, `abap_delete`, `abap_activate`, `abap_search`, `abap_object_info` | Full object lifecycle. Create in $TMP or real packages. Automatic type mapping (CLAS -> CLAS/OC). |
| **Transports** | `transport_create`, `transport_assign`, `transport_release`, `transport_list`, `transport_info`, `transport_contents` | Create, populate, and release transports. Smart metadata handling for FUGR/VIEW/TABL. |
| **Quality** | `abap_syntax_check`, `abap_atc_run` | Syntax check and ATC with variant support. Workaround for CI-mode systems. |
| **Data** | `abap_table`, `abap_query` | Read tables/CDS views with WHERE/LIKE/BETWEEN. Execute freestyle SQL. |
| **Run** | `abap_run` | Create temp class, run ABAP code, capture output, clean up. Auto-detects ~run vs ~main across SAP releases. |
| **System** | `login`, `healthcheck`, `abap_get_dump`, `raw_http` | Session management, connectivity test, ST22 dumps, raw ADT access. |
| **Git** | `git_repos`, `git_pull` | gCTS repository listing and pull. |

## Quick Start

### Prerequisites

- Node.js 18+
- Access to an SAP system with ADT enabled (port 44300)
- SAP user with development authorization

### Install

```bash
git clone https://github.com/DassianInc/dassian-adt.git
cd dassian-adt
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
# Edit .env with your SAP connection details:
#   SAP_URL=https://your-sap-server:44300
#   SAP_USER=YOUR_USER
#   SAP_PASSWORD=YOUR_PASSWORD
#   SAP_CLIENT=100
#   SAP_LANGUAGE=EN
```

For self-signed certificates, add to your `.env`:
```
NODE_TLS_REJECT_UNAUTHORIZED=0
```

### Connect to Claude Code

Add to your Claude Code MCP settings (`~/.config/claude-code/config.json` or project `.claude/settings.local.json`):

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/path/to/dassian-adt/dist/index.js"],
      "env": {
        "SAP_URL": "https://your-sap-server:44300",
        "SAP_USER": "YOUR_USER",
        "SAP_PASSWORD": "YOUR_PASSWORD",
        "SAP_CLIENT": "100",
        "SAP_LANGUAGE": "EN"
      }
    }
  }
}
```

Multiple systems? Add one entry per system:

```json
{
  "mcpServers": {
    "abap-dev": {
      "command": "node",
      "args": ["/path/to/dassian-adt/dist/index.js"],
      "env": { "SAP_URL": "https://dev-system:44300", "SAP_USER": "...", "SAP_PASSWORD": "..." }
    },
    "abap-qa": {
      "command": "node",
      "args": ["/path/to/dassian-adt/dist/index.js"],
      "env": { "SAP_URL": "https://qa-system:44300", "SAP_USER": "...", "SAP_PASSWORD": "..." }
    }
  }
}
```

### HTTP Mode (Team Deployment)

For team-wide access, run the server as a centralized HTTP service:

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 \
  SAP_URL=https://your-sap-server:44300 \
  SAP_USER=SERVICE_USER \
  SAP_PASSWORD=... \
  node dist/index.js
```

Each client gets its own MCP session (and SAP session). Health check at `http://your-server:3000/health`.

Connect from Claude Code using the remote URL:

```json
{
  "mcpServers": {
    "abap": {
      "type": "url",
      "url": "http://your-server:3000/mcp"
    }
  }
}
```

Or register as a team integration on claude.ai for the whole org.

| Env Var | Default | Description |
|---------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` (local) or `http` (remote) |
| `MCP_HTTP_PORT` | `3000` | HTTP server port |
| `MCP_HTTP_PATH` | `/mcp` | MCP endpoint path |

### Test

```bash
npm test              # 165 unit tests, <3 seconds, no SAP needed
npm run test:live     # Integration tests against live SAP (needs env vars)
npm run test:e2e      # Write-path lifecycle test (create -> write -> activate -> delete)
```

## Key Features

### Zero-Crash Input Validation

Centralized validation middleware checks every tool's required parameters before any handler logic runs. Missing `name`? Missing `type`? The error names exactly what's missing. No stack traces, no `Cannot read properties of undefined`.

### MCP Elicitation

When the AI forgets a required parameter, instead of failing, the server asks the user directly:

- **Missing package** on `abap_create` -> "Which package?" form with $TMP default
- **Missing transport** on `abap_set_source` -> "Which transport?" prompt, then retries
- **Transport release** -> "Release D25K900161? This is IRREVERSIBLE" confirmation
- **Leftover class** on `abap_run` -> "Delete ZCL_TMP_ADT_RUN and retry?" prompt
- **Inactive dependents** on `abap_activate` -> "Activate them too?" with list

Falls back gracefully on clients that don't support elicitation.

### Self-Correcting Error Messages

Every SAP error is classified and annotated with actionable hints:

- Locked object -> "Check SM12 for active locks"
- Upgrade mode -> "Run SPAU_ENH to clear the upgrade flag"
- Opaque `I::000` code -> "The URL path is wrong -- check the object type"
- Transport number passed as object name -> "Use transport_contents instead"
- Pipe characters in string templates -> "Escape with \\| or use CONCATENATE"

The AI reads these hints and self-corrects on the next call.

### Automatic Session Recovery

Every ADT call is wrapped in `withSession()`. If the SAP session expires mid-operation, the server re-logs in automatically and retries. Users never see a session timeout.

### SAP Release Detection

`abap_run` auto-detects whether the system uses `IF_OO_ADT_CLASSRUN~run` (<=2023) or `~main` (2024+) by reading the interface source after login. Works on any S/4HANA release without configuration.

## Architecture

```
Client (Claude Code, VS Code, etc.)
    |
    | MCP protocol (stdio)
    |
AbapAdtServer (index.ts)
    |
    +-- BaseHandler (session mgmt, validation, elicitation)
    |       |
    |       +-- SourceHandlers    (get/set source, function groups)
    |       +-- ObjectHandlers    (create, delete, activate, search)
    |       +-- TransportHandlers (create, assign, release, list)
    |       +-- QualityHandlers   (syntax check, ATC)
    |       +-- DataHandlers      (table read, SQL query)
    |       +-- RunHandlers       (temp class execution)
    |       +-- SystemHandlers    (login, healthcheck, dumps)
    |       +-- GitHandlers       (gCTS repos, pull)
    |
    +-- lib/urlBuilder.ts  (ADT URL construction for 30+ object types)
    +-- lib/errors.ts      (SAP error classification + hints)
    +-- lib/logger.ts      (JSON structured logging)
```

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch
3. Run `npm test` and ensure all tests pass
4. Open a pull request

## Credits

- **[Mario Andreschak](https://github.com/mario-andreschak)** -- original [mcp-abap-abap-adt-api](https://github.com/mario-andreschak/mcp-abap-abap-adt-api) server scaffold
- **[Marcello Urbani](https://github.com/marcellourbani)** -- [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) library powering all ADT HTTP communication
- **[Dassian Inc.](https://github.com/DassianInc)** -- fork maintainer

## License

MIT -- see [LICENSE](LICENSE).
