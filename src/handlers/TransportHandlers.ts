import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl, buildSourceUrl } from '../lib/urlBuilder.js';
import { formatError, parseAdtError } from '../lib/errors.js';

export class TransportHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'transport_create',
        description:
          'Create a new transport request. Returns the transport request number (e.g. D23K900123). ' +
          'WORKBENCH (default): creates request + classified Correction task — anchor object required, pass the TASK number to abap_set_source/transport_assign. ' +
          'TOC (transportType="toc"): creates a Transport of Copies via FM TR_INSERT_NEW_COMM — no child task, no anchor object required, ' +
          'requires targetSystem (e.g. "C23", "VD3"). Use transport_bundle_into_toc to copy E071 rows from source transports into the ToC.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Short description for the transport (shown in STMS)' },
            package: {
              type: 'string',
              description: 'Target package, e.g. /DSN/CORE. If omitted, SAP derives it from the anchor object (workbench only).'
            },
            objectName: {
              type: 'string',
              description: 'Name of one object to anchor the transport to. Required for workbench; ignored for ToC.'
            },
            objectType: {
              type: 'string',
              description: 'Type of the anchor object (e.g. CLAS, DDLS/DF). Required for workbench; ignored for ToC.'
            },
            transportType: {
              type: 'string',
              enum: ['workbench', 'toc'],
              description: 'Transport type: "workbench" (default, TRFUNCTION=K) or "toc" (Transport of Copies, TRFUNCTION=T)'
            },
            targetSystem: {
              type: 'string',
              description: 'Target system for the transport (e.g. "C23", "VD3"). REQUIRED for ToC. Ignored for workbench (system is derived from package transport layer).'
            }
          },
          required: ['description']
        }
      },
      {
        name: 'transport_assign',
        annotations: { idempotentHint: true },
        description:
          'Assign an existing object to a transport request via no-op save ' +
          '(lock → read source → write same source with transport number → unlock). ' +
          'The source is not changed — only the transport linkage is created. ' +
          'Call abap_activate after assigning if the object is not yet active.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: 'Object type (e.g. CLAS, DDLS/DF, PROG/I)' },
            transport: { type: 'string', description: 'Transport request number. Pass the request number, not the child task.' }
          },
          required: ['name', 'type', 'transport']
        }
      },
      {
        name: 'transport_release',
        annotations: { destructiveHint: true },
        description:
          'Release a transport request. Automatically releases child tasks first, then the parent request. ' +
          'Performs a pre-release check for inactive objects — if any objects in the transport are inactive, ' +
          'release would hang at the SAP backend (the agent sees "operation timed out" with no useful detail). ' +
          'When inactive objects are detected, fail-fast with the list. Pass autoActivate=true to activate them ' +
          'automatically before releasing. ' +
          'WARNING: Irreversible. Only call when explicitly asked to release. ' +
          'NEVER call automatically after activation — always wait for explicit instruction.',
        inputSchema: {
          type: 'object',
          properties: {
            transport:    { type: 'string',  description: 'Transport request number (e.g. D23K900123)' },
            ignoreAtc:    { type: 'boolean', description: 'Skip ATC checks on release (default false)' },
            autoActivate: { type: 'boolean', description: 'If inactive objects are detected in the transport, activate them automatically before releasing (default false — fail-fast instead).' }
          },
          required: ['transport']
        }
      },
      {
        name: 'transport_list',
        annotations: { readOnlyHint: true },
        description: 'List open transport requests for a user. Defaults to the current session user.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'SAP user ID. Omit to use the session user.' }
          }
        }
      },
      {
        name: 'transport_info',
        annotations: { readOnlyHint: true },
        description: 'Get the current transport assignment for an object.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: 'Object type' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'transport_delete',
        annotations: { destructiveHint: true },
        description:
          'Delete a transport request. ' +
          'WARNING: Irreversible. Only works on modifiable (not yet released) requests. ' +
          'Only call when explicitly requested.',
        inputSchema: {
          type: 'object',
          properties: {
            transport: { type: 'string', description: 'Transport request number (e.g. D23K900123)' }
          },
          required: ['transport']
        }
      },
      {
        name: 'transport_set_owner',
        description:
          'Change the owner of a transport request. ' +
          'Returns the updated transport header.',
        inputSchema: {
          type: 'object',
          properties: {
            transport: { type: 'string', description: 'Transport request number' },
            user:      { type: 'string', description: 'New owner user ID (SAP login name)' }
          },
          required: ['transport', 'user']
        }
      },
      {
        name: 'transport_add_user',
        description:
          'Add a user to a transport request (gives them edit access). ' +
          'Returns the updated user list.',
        inputSchema: {
          type: 'object',
          properties: {
            transport: { type: 'string', description: 'Transport request number' },
            user:      { type: 'string', description: 'SAP user ID to add' }
          },
          required: ['transport', 'user']
        }
      },
      {
        name: 'transport_contents',
        annotations: { readOnlyHint: true },
        description:
          'List all objects on a transport request (E071). ' +
          'Returns the PGMID, object type, and object name for every entry. ' +
          'Use this to audit what will be released or to verify an object was captured.',
        inputSchema: {
          type: 'object',
          properties: {
            transport: { type: 'string', description: 'Transport request number, e.g. D23K900123' }
          },
          required: ['transport']
        }
      },
      {
        name: 'transport_log',
        annotations: { readOnlyHint: true },
        description:
          'Read the CTS import/activation log for a transport on a specific system. ' +
          'Returns the raw log showing programs generated/activated, syntax errors, ' +
          'return codes, and timestamps for every import run of that transport. ' +
          'IMPORTANT: call this on the system where the log lives — e.g. sap_system_id=c22 ' +
          'to read C22 logs, sap_system_id=d25 for D25 GT5K* transports. ' +
          'The "system" parameter is the SAP system name that appears in the log filename (e.g. "C22", "D25"). ' +
          'Common acttypes — try in this order if one returns nothing: ' +
          '"G" (default) = ABAP generation, "A" = activation, "I" = main import, ' +
          '"J" = DDIC activation, "H" = ABAP Dictionary import, "R" = after-import methods/XPRAs, ' +
          '"B" = inactive import, "<" = forward to follow-on system. ' +
          'The acttype letter replaces position 4 of the transport number in the log filename (e.g. GT5K… → GT5A… for acttype A).',
        inputSchema: {
          type: 'object',
          properties: {
            trkorr:  { type: 'string', description: 'Transport request number, e.g. X22K904025 or GT5K900123' },
            system:  { type: 'string', description: 'SAP system name for the log file, e.g. C22, D25, C23' },
            client:  { type: 'string', description: 'SAP client number (default: 100)' },
            acttype: { type: 'string', description: 'Log file action type (default: G = program generation). Use I for import phase.' }
          },
          required: ['trkorr', 'system']
        }
      },
      {
        name: 'transport_find',
        annotations: { readOnlyHint: true },
        description:
          'Search for transport requests by description fragment. ' +
          'Queries E07T on the connected system — use the target system (e.g. sap_system_id=d25) ' +
          'to find GT5K* transports created there by gCTS, or sap_system_id=x22 to find source transports. ' +
          'Useful for locating the GT5K transport number that corresponds to a GitHub issue or Jira key.',
        inputSchema: {
          type: 'object',
          properties: {
            query:  { type: 'string', description: 'Text to search in transport description, e.g. "DSNMANN-571" or "FPA Adjustment"' },
            owner:  { type: 'string', description: 'Filter by transport owner/user (optional)' },
            prefix: { type: 'string', description: 'Filter by transport number prefix, e.g. "GT5K" for D25 gCTS transports' }
          },
          required: ['query']
        }
      },
      {
        name: 'transport_bundle_into_toc',
        description:
          'Copy the object contents (E071/E071K rows) of one or more source transports into an existing ' +
          'Transport of Copies (ToC). The source transports are NOT modified — the ToC ends up with ' +
          'duplicate E071 rows referencing the same objects, which is the deliverable snapshot pattern ' +
          'used for point fixes. The ToC must already exist (create it with transport_create transportType="toc") ' +
          'and must be in modifiable state (TRSTATUS=D). Drives standard FM TR_COPY_COMM in a loop.',
        inputSchema: {
          type: 'object',
          properties: {
            toc: { type: 'string', description: 'Target Transport of Copies number, e.g. C23K900150' },
            sources: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of source transport request numbers to copy into the ToC, e.g. ["D23K900671","D23K901481","D23K901483"]'
            }
          },
          required: ['toc', 'sources']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'transport_create':            return this.handleCreate(args);
      case 'transport_assign':            return this.handleAssign(args);
      case 'transport_release':           return this.handleRelease(args);
      case 'transport_list':              return this.handleList(args);
      case 'transport_info':              return this.handleInfo(args);
      case 'transport_contents':          return this.handleContents(args);
      case 'transport_delete':            return this.handleDelete(args);
      case 'transport_set_owner':         return this.handleSetOwner(args);
      case 'transport_add_user':          return this.handleAddUser(args);
      case 'transport_log':               return this.handleLog(args);
      case 'transport_find':              return this.handleFind(args);
      case 'transport_bundle_into_toc':   return this.handleBundleIntoToc(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleCreate(args: any): Promise<any> {
    // SAP transport descriptions are capped at 60 characters — longer strings cause "deserialization" errors.
    const description: string = args.description.length > 60
      ? args.description.slice(0, 60)
      : args.description;
    const isToc = args.transportType === 'toc';

    // ─── ToC path ────────────────────────────────────────────────────────────
    // Use FM TR_INSERT_NEW_COMM directly — it creates a clean ToC with no auto-task
    // and lets us set the target system explicitly. The old approach (create Workbench
    // then PUT-reclassify to T) left an orphan Unclassified child task and silently
    // succeeded when the reclassify didn't actually persist.
    if (isToc) {
      const targetSystem = String(args.targetSystem || '').toUpperCase().trim();
      if (!targetSystem) {
        this.fail(
          `transport_create(toc): targetSystem is required for a Transport of Copies (e.g. "C23", "VD3"). ` +
          `This determines where the ToC will be delivered — Dassian point fixes typically go to a customer system.`
        );
      }

      const safeDesc = description.replace(/'/g, "''");
      const safeTarget = targetSystem.replace(/'/g, "''");

      const methodBody = `
DATA: lv_trkorr TYPE e070-trkorr,
      ls_e070   TYPE e070.

CALL FUNCTION 'TR_INSERT_NEW_COMM'
  EXPORTING
    wi_kurztext   = '${safeDesc}'
    wi_trfunction = 'T'
    iv_tarsystem  = '${safeTarget}'
    wi_client     = sy-mandt
  IMPORTING
    we_trkorr     = lv_trkorr
    we_e070       = ls_e070
  EXCEPTIONS
    invalid_targetsystem = 1
    no_authorization     = 2
    unallowed_user       = 3
    unallowed_trfunction = 4
    OTHERS               = 5.

IF sy-subrc <> 0.
  out->write( |TR_INSERT_NEW_COMM sy-subrc={ sy-subrc } ({ sy-msgid }/{ sy-msgno }) { sy-msgv1 } { sy-msgv2 } { sy-msgv3 }| ).
  RETURN.
ENDIF.

IF ls_e070-trfunction <> 'T' OR ls_e070-tarsystem <> '${safeTarget}'.
  out->write( |Created but verification failed: trfunction={ ls_e070-trfunction } target={ ls_e070-tarsystem }| ).
  RETURN.
ENDIF.

" Defensive: make sure no auto-task got created (it shouldn't, but check anyway)
DATA lt_tasks TYPE STANDARD TABLE OF e070.
SELECT * FROM e070 INTO TABLE lt_tasks WHERE strkorr = lv_trkorr.
IF lines( lt_tasks ) > 0.
  LOOP AT lt_tasks INTO DATA(lt).
    DELETE FROM e070 WHERE trkorr = lt-trkorr.
    DELETE FROM e07t WHERE trkorr = lt-trkorr.
  ENDLOOP.
ENDIF.

COMMIT WORK.
out->write( |OK { lv_trkorr } target={ ls_e070-tarsystem }| ).
`;

      try {
        const output = await this.runClassrun(methodBody, 'ZCL_TMP_TOC_CREATE');
        const match = output.match(/OK\s+([A-Z0-9]+)\s+target=([A-Z0-9]+)/);
        if (!match) {
          this.fail(`transport_create(toc): ${output.trim() || 'TR_INSERT_NEW_COMM returned non-zero sy-subrc'}`);
        }
        const transportNumber = match![1];
        return this.success({
          transport: transportNumber,
          transportType: 'toc',
          targetSystem,
          message:
            `Transport of Copies ${transportNumber} created (target ${targetSystem}). ` +
            `ToCs have no child task — pass ${transportNumber} to transport_assign or transport_bundle_into_toc.`
        });
      } catch (error: any) {
        this.fail(formatError('transport_create(toc)', error));
      }
    }

    // ─── Workbench path ─────────────────────────────────────────────────────
    if (!args.objectName || !args.objectType) {
      this.fail(
        `transport_create(workbench): objectName and objectType are required to anchor the request. ` +
        `For ToC use transportType="toc" with targetSystem instead.`
      );
    }
    const sourceUrl = buildSourceUrl(args.objectName, args.objectType);
    // SAP can't always derive the package from the anchor object URL — many object types
    // (CLAS, BDEF, PROG/I, namespaced classes) fail with "specify a package". When the
    // caller didn't pass one, do the objectStructure lookup automatically before creating
    // the transport — saves an agent round-trip and prevents the most-common failure mode.
    let devclass = args.package || '';
    if (!devclass) {
      devclass = (await this.lookupPackageForObject(args.objectName, args.objectType)) || '';
    }

    try {
      // createTransport is NOT idempotent — each call creates a new request. On some systems
      // (S/4 2022) the call can persist the request header and then throw TK164 ("Request X is
      // locked; action canceled") when the follow-on task-creation step races the request's own
      // enqueue lock, leaving an orphaned, taskless request. A naive retry would spawn ANOTHER
      // orphan every time (observed in the error log: 904156, 904157, …).
      //
      // Instead: on a lock error, recover the request number from the message. The request DID
      // get created, so adopt it once the lock clears — and only if it still has no task do we
      // delete the empty husk and do one clean re-create. parseAdtError.isLocked now matches TK164.
      const tryCreate = async (): Promise<string> => {
        const result = await this.withSession(() =>
          this.adtclient.createTransport(sourceUrl, description, devclass)
        );
        return ((result as any)?.transportNumber || result) as string;
      };
      const extractRequestNumber = (err: any): string => {
        const m = String(err?.message || '').match(/T100KEY-V1=([A-Z]\d{2}[KT]\d{6})/i)
               || String(err?.message || '').match(/\b([A-Z]\d{2}[KT]\d{6})\b\s+is locked/i);
        return m ? m[1].toUpperCase() : '';
      };

      let transportNumber = '';
      let adopted = '';        // request number recovered from a TK164 lock error
      let lastError: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          const delay = [0, 3000, 8000][attempt];
          await this.notify(`Transport request locked — retrying create in ${delay / 1000}s (attempt ${attempt + 1}/3)…`, 'warning');
          await new Promise(r => setTimeout(r, delay));
        }
        try {
          if (adopted) {
            // A prior attempt left a dangling request. If the lock has cleared and a task now
            // exists, adopt it; otherwise delete the empty husk and create one cleanly below.
            const t = await this.resolveTaskNumber(adopted);
            if (t && t !== adopted) { transportNumber = adopted; lastError = null; break; }
            try { await this.withSession(() => this.adtclient.transportDelete(adopted)); } catch (_) {}
            adopted = '';
          }
          transportNumber = await tryCreate();
          lastError = null;
          break;
        } catch (e: any) {
          lastError = e;
          const recovered = extractRequestNumber(e);
          if (recovered) adopted = recovered;
          // Only retry on lock contention (TK164 etc.); surface any other error immediately.
          if (!parseAdtError(e).isLocked) break;
        }
      }
      if (!transportNumber) {
        // Unrecoverable — don't leak the dangling request we created.
        if (adopted) { try { await this.withSession(() => this.adtclient.transportDelete(adopted)); } catch (_) {} }
        throw lastError || new Error('transport_create: request could not be created.');
      }

      // Resolve the task number — abap_set_source needs the TASK (child), not the REQUEST (parent).
      const taskNumber = await this.resolveTaskNumber(transportNumber as string);
      // Workbench tasks sometimes get created as Unclassified (X) on certain systems.
      // Classify as Correction (S) immediately.
      if (taskNumber && taskNumber !== transportNumber) {
        try {
          await this.classifyTask(taskNumber);
        } catch (_) {
          // Non-fatal — transport_assign will re-classify if needed
        }
      }
      return this.success({
        transport: transportNumber,
        task: taskNumber !== transportNumber ? taskNumber : undefined,
        message:
          `Transport ${transportNumber} created` +
          (taskNumber !== transportNumber ? ` (task: ${taskNumber})` : '') +
          `. Pass the TASK number (${taskNumber}) — not the request — to abap_set_source, abap_create, etc. ` +
          `Use transport_assign to add objects, then transport_release when ready.`
      });
    } catch (error: any) {
      const msg = String(error?.message || error || '');
      if (/specify a package/i.test(msg)) {
        this.fail(
          `transport_create failed: SAP requires a package for this object — add the package parameter (e.g. package: "/DSN/MYPACKAGE"). ` +
          `Use abap_object_info to look up the object's package if unknown.`
        );
      }
      if (/deserialization/i.test(msg)) {
        this.fail(
          `transport_create failed: SAP rejected the anchor object. Common causes: ` +
          `(1) object does not exist on this system, ` +
          `(2) wrong package name, ` +
          `(3) PROG includes (PROG/I) are not valid anchors — use the parent program (PROG/P) or a class instead. ` +
          `Original: ${msg}`
        );
      }
      this.fail(formatError('transport_create', error));
    }
  }

  /**
   * Return the list of inactive objects whose transport assignment matches `transportNumber`
   * or any of its child tasks. SAP's release pipeline activates objects before exporting them —
   * if any are inactive (or have unresolvable activation errors), the release hangs and the
   * HTTP client times out with no actionable detail. Detecting this up-front lets us fail fast.
   */
  private async findInactiveObjectsForTransport(
    transportNumber: string
  ): Promise<Array<{ name: string; type: string; uri: string }>> {
    try {
      // Collect the parent + all child tasks so we catch objects on either.
      const taskRows = await this.withSession(() =>
        this.adtclient.tableContents('E070', 100, false,
          `SELECT trkorr FROM e070 WHERE strkorr = '${transportNumber}' AND trstatus = 'D'`)
      ) as any;
      const tasks: string[] = (taskRows?.values || taskRows?.records || taskRows?.value || [])
        .map((r: any) => (r.TRKORR || r.trkorr || '').toUpperCase())
        .filter(Boolean);
      const scope = new Set<string>([transportNumber, ...tasks]);

      const records: any[] = await this.withSession(() =>
        this.adtclient.inactiveObjects()
      ) as any[];

      const blocking: Array<{ name: string; type: string; uri: string }> = [];
      for (const rec of records || []) {
        const obj = rec?.object;
        const trans = rec?.transport;
        if (!obj || !trans) continue;
        const transName: string = String(trans['adtcore:name'] || '').toUpperCase();
        if (!scope.has(transName)) continue;
        const name = String(obj['adtcore:name'] || '');
        const type = String(obj['adtcore:type'] || '');
        const uri  = String(obj['adtcore:uri']  || '');
        if (name && uri) blocking.push({ name, type, uri });
      }
      return blocking;
    } catch (_) {
      // If the check itself fails, don't block the release path — let SAP surface
      // whatever error it would have surfaced. The check is a usability nicety, not a gate.
      return [];
    }
  }

  /**
   * Look up the package an existing object belongs to.
   * Returns '' on any failure — callers should fall back to letting SAP report
   * "specify a package" so the user can supply one manually.
   *
   * objectStructure() doesn't include packageRef for many types (CLAS, BDEF, etc.),
   * but transportInfo() always returns DEVCLASS as part of its header.
   */
  private async lookupPackageForObject(name: string, type: string): Promise<string> {
    if (!name || !type) return '';
    try {
      const sourceUrl = buildSourceUrl(name, type);
      const info: any = await this.withSession(() =>
        this.adtclient.transportInfo(sourceUrl)
      );
      const pkg: string =
        info?.DEVCLASS ||
        info?.devclass ||
        info?.packageRef?.name ||
        info?.packageRef?.['adtcore:name'] ||
        '';
      return String(pkg || '').trim();
    } catch (_) {
      return '';
    }
  }

  private async handleAssign(args: any): Promise<any> {
    if (!args.name || !args.type || !args.transport) {
      this.fail('transport_assign requires name (object name), type (e.g. CLAS, VIEW), and transport (request number).');
    }
    // SAP E071 entries live under the TASK (child), not the REQUEST (parent).
    // Resolve the task number once here — every assignment path below uses it.
    const taskNumber = await this.resolveTaskNumber(args.transport);

    // Check for Unclassified task (TRFUNCTION='X') — SAP silently discards all E071 assignments to them.
    // Auto-classify as Correction (S) before proceeding rather than failing or requiring SE01.
    try {
      const e070 = await this.withSession(() =>
        this.adtclient.tableContents('E070', 1, false,
          `SELECT TRFUNCTION FROM E070 WHERE TRKORR = '${taskNumber.toUpperCase()}'`)
      ) as any;
      const rows: any[] = e070?.values || e070?.records || e070?.value || [];
      const trfunction: string = rows[0]?.TRFUNCTION || rows[0]?.trfunction || '';
      if (trfunction === 'X') {
        await this.notify(`Task ${taskNumber} is Unclassified — classifying as Correction (S)…`, 'warning');
        // Let classification failure propagate — if we can't classify, we must not proceed:
        // assigning to an Unclassified task silently writes nothing to E071.
        await this.classifyTask(taskNumber);
        await this.notify(`Task ${taskNumber} classified — proceeding with assignment…`);
      }
    } catch (e: any) {
      // Rethrow anything that came from classifyTask or our own fail() calls
      if (e?.message?.includes('classif') || e?.message?.includes('Unclassified') ||
          (e as any)?.code === 'InternalError') throw e;
      // E070 lookup itself failed — proceed and let SAP surface any task state errors naturally
    }

    // Metadata-only types (no text source) — assign via transportReference which registers
    // the object on the transport directly without needing lock+read/write+unlock.
    // These types are containers or have no direct text source — assign via transportReference
    // to avoid creating inactive versions of sub-objects (e.g. FUGR lock/write creates inactive SAPL).
    const METADATA_TYPES = new Set(['VIEW', 'TABL', 'DOMA', 'DTEL', 'SHLP', 'SQLT', 'TTYP', 'DEVC', 'FUGR', 'MSAG', 'ENHS']);
    const typeKey = args.type.toUpperCase().split('/')[0];
    const isMetadata = METADATA_TYPES.has(typeKey);

    // transportReference: registers the TADIR key on the transport task with no source manipulation.
    // Must use the TASK number — passing the request number results in silent no-ops.
    const doTransportReference = async (): Promise<void> => {
      await this.withSession(() =>
        this.adtclient.transportReference('R3TR', typeKey, args.name.toUpperCase(), taskNumber)
      );
    };

    if (isMetadata) {
      try {
        await doTransportReference();
        return this.success({
          message: `${args.name} assigned to transport ${args.transport} (task: ${taskNumber})`,
          name: args.name,
          transport: args.transport,
          task: taskNumber
        });
      } catch (error: any) {
        this.fail(formatError(`transport_assign(${args.name})`, error));
      }
    }

    // For source types: try lock → read → write → unlock.
    // If buildObjectUrl throws (unknown type) or the source path fails for any reason,
    // fall back to transportReference — it handles any valid TADIR object type.
    let objectUrl: string;
    try {
      objectUrl = buildObjectUrl(args.name, args.type);
    } catch (_) {
      // Unknown type — no URL path defined; use transportReference directly.
      try {
        await doTransportReference();
        return this.success({
          message: `${args.name} assigned to transport ${args.transport} (task: ${taskNumber}, via reference — no ADT source path for type ${args.type})`,
          name: args.name,
          transport: args.transport,
          task: taskNumber
        });
      } catch (refError: any) {
        this.fail(formatError(`transport_assign(${args.name})`, refError));
      }
    }

    const sourceUrl = `${objectUrl!}/source/main`;
    let lockHandle: string | null = null;

    // lock → read → write → unlock must be a SINGLE withSession block.
    // Separate withSession calls risk session recovery between lock() and setObjectSource(),
    // which would invalidate the lock handle for the write.
    const doAssign = async (): Promise<void> => {
      const lockResult = await this.adtclient.lock(objectUrl!);
      lockHandle = lockResult.LOCK_HANDLE;
      // Prefer CORRNR from lock response (SAP's authoritative task number).
      // Fall back to our pre-resolved taskNumber if CORRNR is empty.
      const corrNr = lockResult.CORRNR || taskNumber;
      try {
        const currentSource = await this.adtclient.getObjectSource(sourceUrl);
        await this.adtclient.setObjectSource(sourceUrl, currentSource as string, lockHandle!, corrNr);
      } catch (err: any) {
        try { await this.adtclient.unLock(objectUrl!, lockHandle!); } catch (_) {}
        lockHandle = null;
        throw err;
      }
      await this.adtclient.unLock(objectUrl!, lockHandle!);
      lockHandle = null;
    };

    try {
      await this.withSession(doAssign);
      return this.success({
        message: `${args.name} assigned to transport ${args.transport} (task: ${taskNumber})`,
        name: args.name,
        transport: args.transport,
        task: taskNumber
      });
    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(objectUrl!, lockHandle); } catch (_) {}
      }
      // Source path failed — fall back to transportReference.
      // This handles types with ADT URLs but no lockable source (CHDO, IWMO, SICF, WAPA, etc.).
      try {
        await doTransportReference();
        return this.success({
          message: `${args.name} assigned to transport ${args.transport} (task: ${taskNumber}, via reference — source path failed: ${error?.message || error})`,
          name: args.name,
          transport: args.transport,
          task: taskNumber
        });
      } catch (_) {
        // Both paths failed — surface the original source error.
        this.fail(formatError(`transport_assign(${args.name})`, error));
      }
    }
  }

  private async handleRelease(args: any): Promise<any> {
    // Elicit confirmation — transport release is irreversible
    const confirmed = await this.confirmWithUser(
      `Release transport ${args.transport}? This is IRREVERSIBLE — the transport will be exported and cannot be undone.`,
      { transport: args.transport }
    );
    if (!confirmed) {
      this.fail(`transport_release(${args.transport}): cancelled by user.`);
    }

    // Pre-release check: inactive objects in the transport cause SAP's release pipeline to hang
    // at the activation step. The HTTP timeout that surfaces is uninformative.
    // Find inactive objects scoped to this transport BEFORE attempting release.
    const transportUpper = args.transport.toUpperCase();
    const blockingInactive = await this.findInactiveObjectsForTransport(transportUpper);
    if (blockingInactive.length > 0) {
      if (args.autoActivate) {
        await this.notify(
          `${blockingInactive.length} inactive object(s) detected — activating before release…`,
          'warning'
        );
        for (const obj of blockingInactive) {
          try {
            await this.withSession(() =>
              this.adtclient.activate(obj.name, obj.uri)
            );
          } catch (e: any) {
            this.fail(
              `transport_release(${args.transport}): auto-activation of ${obj.type} ${obj.name} failed: ${e?.message || e}. ` +
              `Activate it manually via abap_activate, then retry release.`
            );
          }
        }
        // Re-check after activation — anything still inactive blocks the release.
        const stillInactive = await this.findInactiveObjectsForTransport(transportUpper);
        if (stillInactive.length > 0) {
          const list = stillInactive.map(o => `  - ${o.type} ${o.name}`).join('\n');
          this.fail(
            `transport_release(${args.transport}): ${stillInactive.length} object(s) still inactive after auto-activate:\n${list}\n` +
            `Activate them manually via abap_activate (and fix any syntax errors), then retry.`
          );
        }
      } else {
        const list = blockingInactive.map(o => `  - ${o.type} ${o.name}`).join('\n');
        this.fail(
          `transport_release(${args.transport}): ${blockingInactive.length} inactive object(s) would block release:\n${list}\n` +
          `Run abap_activate on these objects first, or call transport_release again with autoActivate=true.`
        );
      }
    }

    try {
      try {
        await this.notify(`Releasing ${args.transport}…`);
        const result = await this.releaseOne(args.transport, args.ignoreAtc || false);
        return this.success({ transport: args.transport, released: true, result });
      } catch (firstError: any) {
        const msg = (firstError?.message || '').toLowerCase();
        // Three patterns trigger the auto-task-release path:
        //  - "task not yet released" / "referencing" — child task still open
        //  - "is unclassified" — child task has trfunction='X' (Dassian rule rejects this)
        if (msg.includes('task') && (
          msg.includes('not yet released') ||
          msg.includes('referencing') ||
          msg.includes('is unclassified') ||
          msg.includes('unclassified')
        )) {
          // Parent request can't release yet — find and release its tasks first.
          // Query E070 directly (fast) instead of userTransports (slow on large systems).
          const e070 = await this.withSession(() =>
            this.adtclient.tableContents('E070', 20, false,
              `SELECT trkorr FROM e070 WHERE strkorr = '${args.transport.toUpperCase()}' AND trstatus = 'D'`)
          ) as any;
          const rows: any[] = e070?.values || e070?.records || e070?.value || [];
          const tasks: string[] = rows.map((r: any) => r.TRKORR || r.trkorr).filter(Boolean);

          for (const task of tasks) {
            // Dassian's CTS rules reject "Unclassified" task releases. Classify each
            // task to Correction first (no-op if already correct) before releasing.
            try { await this.classifyTask(task); } catch (_) { /* ignore */ }
            await this.notify(`Releasing task ${task}…`);
            await this.releaseOne(task, args.ignoreAtc || false);
          }

          await this.notify(`Releasing request ${args.transport}…`);
          const result = await this.releaseOne(args.transport, args.ignoreAtc || false);
          return this.success({ transport: args.transport, released: true, tasksReleased: tasks, result });
        }
        throw firstError;
      }
    } catch (error: any) {
      this.fail(formatError(`transport_release(${args.transport})`, error));
    }
  }

  /**
   * Release a single transport or task.
   * Older SAP systems (S/4 2022) require an XML request body for the POST;
   * the library sends none. When we get the "expected element" error, retry
   * via the underlying HTTP client with a minimal <tm:root> body.
   */
  private async releaseOne(transportNumber: string, ignoreAtc: boolean): Promise<any> {
    const h = (this.adtclient as any).h;
    const action = ignoreAtc ? 'relObjigchkatc' : 'newreleasejobs';

    // A transport release commits server-side but the POST can take longer than the HTTP client
    // timeout — the call rejects while SAP completes the release. Detect that case and confirm via
    // the transport's status instead of surfacing a misleading "release failed". (Previously the
    // agent had to manually re-check the open-transport list after every release timeout.)
    const isTimeout = (e: any): boolean => {
      const code = String(e?.code || e?.err?.code || '').toUpperCase();
      const m = String(e?.message || '').toLowerCase();
      return code === 'ECONNABORTED' || code === 'ETIMEDOUT' ||
        m.includes('timeout') || m.includes('timed out') || m.includes('socket hang up') ||
        m.includes('network') || m.includes('econnreset');
    };
    const recoverIfReleased = async (err: any): Promise<any> => {
      if (isTimeout(err) && await this.wasReleased(transportNumber)) {
        await this.notify(`Release POST timed out but ${transportNumber} is no longer modifiable — release completed server-side.`);
        return { 'chkrun:status': 'released', recoveredFromTimeout: true, transport: transportNumber };
      }
      throw err;
    };

    // When ignoreAtc=true the ADT library generates a blank transport number in the URL.
    // Always use the raw HTTP path — it works on all systems and avoids the library bug.
    if (ignoreAtc) {
      try {
        return await this.withSession(() =>
          h.request(`/sap/bc/adt/cts/transportrequests/${transportNumber}/${action}`, {
            method: 'POST',
            headers: { Accept: 'application/*', 'Content-Type': 'application/xml' },
            body: `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"/>`
          })
        );
      } catch (err: any) {
        return await recoverIfReleased(err);
      }
    }

    try {
      // ADTClient.transportRelease(number, ignoreLocks, ignoreAtc)
      const result = await this.withSession(() =>
        this.adtclient.transportRelease(transportNumber, false, false)
      );
      this.assertReleaseSucceeded(result);
      return result;
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();
      // Older SAP systems (S/4 2022) require an XML body on the POST — retry with one.
      if (msg.includes('expected the element') || msg.includes('tm}root') || msg.includes('tm:root')) {
        try {
          const retryResult = await this.withSession(() =>
            h.request(`/sap/bc/adt/cts/transportrequests/${transportNumber}/${action}`, {
              method: 'POST',
              headers: { Accept: 'application/*', 'Content-Type': 'application/xml' },
              body: `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"/>`
            })
          );
          this.assertReleaseSucceeded(retryResult);
          return retryResult;
        } catch (retryErr: any) {
          return await recoverIfReleased(retryErr);
        }
      }
      return await recoverIfReleased(err);
    }
  }

  /**
   * Check whether a transport request is no longer modifiable (i.e. release has started/completed).
   * Used to confirm a release that succeeded server-side after the HTTP POST timed out.
   * E070 TRSTATUS: 'D' = modifiable, 'L' = modifiable/protected; anything else (O/R) = released.
   */
  private async wasReleased(transportNumber: string): Promise<boolean> {
    try {
      const e070 = await this.withSession(() =>
        this.adtclient.tableContents('E070', 1, false,
          `SELECT trstatus FROM e070 WHERE trkorr = '${transportNumber.toUpperCase()}'`)
      ) as any;
      const rows: any[] = e070?.values || e070?.records || e070?.value || [];
      const st = String(rows[0]?.TRSTATUS || rows[0]?.trstatus || '').toUpperCase();
      return st !== '' && st !== 'D' && st !== 'L';
    } catch (_) {
      return false;
    }
  }

  // ADT returns abortrelapifail (not a thrown error) when tasks are unreleased or other
  // soft failures occur. Throw so callers can catch and handle (e.g. auto-release tasks).
  // Known status values:
  //   "released" / "ok"      — success
  //   "abortrelapifail"      — failed, do not retry
  //   "relwithignlock"       — SAP wants confirmation to ignore locks; treat as failure so
  //                            the caller surfaces the underlying error (often an E071 schema
  //                            problem like wrong objfunc).
  //   "lock*" / *fail* / *abort* — failure
  // We also flag failure when the response contains any error-type check messages.
  private assertReleaseSucceeded(result: any): void {
    const items: any[] = Array.isArray(result) ? result : [result];
    const item = items[0] || {};
    const status: string = (item['chkrun:status'] || '').toLowerCase();

    // Walk all check reports for error messages even when status is benign.
    const reports: any[] = (item['tm:releasereports'] && Array.isArray(item['tm:releasereports']['chkrun:checkReport']))
      ? item['tm:releasereports']['chkrun:checkReport']
      : (item['tm:releasereports']?.['chkrun:checkReport'] ? [item['tm:releasereports']['chkrun:checkReport']] : []);
    const errorMsgs: string[] = [];
    for (const rep of reports) {
      const ml = rep?.['chkrun:checkMessageList']?.['chkrun:checkMessage'];
      const msgs = Array.isArray(ml) ? ml : (ml ? [ml] : []);
      for (const m of msgs) {
        if ((m?.['chkrun:type'] || '').toUpperCase() === 'E' && m?.['chkrun:shortText']) {
          errorMsgs.push(String(m['chkrun:shortText']));
        }
      }
    }

    const isFailure =
      status.includes('fail') ||
      status.includes('abort') ||
      status.includes('lock') ||      // relwithignlock — needs confirmation we can't give
      status.includes('relwithign') ||
      errorMsgs.length > 0;

    if (isFailure) {
      const legacyMsgs: string = (item.messages || [])
        .map((m: any) => m['chkrun:shortText'])
        .filter(Boolean)
        .join('; ');
      const combined = [errorMsgs.join('; '), legacyMsgs].filter(Boolean).join('; ');
      throw new Error(combined || item['chkrun:statusText'] || `Release failed: ${status}`);
    }
  }

  private async handleList(args: any): Promise<any> {
    try {
      // Use provided user, or fall back to the session user
      const user = args.user || (this.adtclient as any).username || (this.adtclient as any).h?.username;
      const transports = await this.withSession(() =>
        this.adtclient.userTransports(user)
      );
      // The ADT CTS endpoint may return empty arrays even when transports exist.
      // Fall back to querying E070 directly in that case.
      const wb = transports?.workbench ?? [];
      const cu = transports?.customizing ?? [];
      if (wb.length === 0 && cu.length === 0 && user) {
        const h = (this.adtclient as any).h;
        const e070 = await this.withSession(() =>
          this.adtclient.tableContents('E070', 200, false,
            `SELECT trkorr, as4user, trstatus FROM e070 WHERE as4user = '${user.toUpperCase()}' AND trstatus = 'D'`)
        ) as any;
        const rows = e070?.values || e070?.records || [];
        if (rows.length > 0) {
          return this.success({ transports: { workbench: rows, customizing: [] }, source: 'E070' });
        }
      }
      return this.success({ transports });
    } catch (error: any) {
      this.fail(formatError('transport_list', error));
    }
  }

  private async handleContents(args: any): Promise<any> {
    if (!args.transport) {
      this.fail('transport_contents requires transport (transport request number, e.g. D25K900123).');
    }
    try {
      const trkorr = args.transport.toUpperCase();
      const result = await this.withSession(() =>
        this.adtclient.tableContents(
          'E071',
          500,
          false,
          `SELECT pgmid,object,obj_name FROM e071 WHERE trkorr = '${trkorr}'`
        )
      ) as any;

      const rows = result?.values || result?.records || result?.value || result || [];
      return this.success({
        transport: trkorr,
        count: Array.isArray(rows) ? rows.length : 0,
        objects: rows
      });
    } catch (error: any) {
      this.fail(formatError(`transport_contents(${args.transport})`, error));
    }
  }

  private async handleDelete(args: any): Promise<any> {
    const confirmed = await this.confirmWithUser(
      `Delete transport ${args.transport}? This is IRREVERSIBLE.`,
      { transport: args.transport }
    );
    if (!confirmed) this.fail(`transport_delete(${args.transport}): cancelled.`);
    try {
      await this.withSession(() => this.adtclient.transportDelete(args.transport));
      return this.success({ transport: args.transport, deleted: true });
    } catch (error: any) {
      this.fail(formatError(`transport_delete(${args.transport})`, error));
    }
  }

  private async handleSetOwner(args: any): Promise<any> {
    try {
      const result = await this.withSession(() =>
        this.adtclient.transportSetOwner(args.transport, args.user)
      );
      return this.success({ transport: args.transport, owner: args.user, result });
    } catch (error: any) {
      this.fail(formatError(`transport_set_owner(${args.transport})`, error));
    }
  }

  private async handleAddUser(args: any): Promise<any> {
    try {
      const result = await this.withSession(() =>
        this.adtclient.transportAddUser(args.transport, args.user)
      );
      return this.success({ transport: args.transport, user: args.user, result });
    } catch (error: any) {
      this.fail(formatError(`transport_add_user(${args.transport})`, error));
    }
  }

  private async handleLog(args: any): Promise<any> {
    const trkorr  = String(args.trkorr  || '').toUpperCase().trim();
    const system  = String(args.system  || '').toUpperCase().trim();
    const client  = String(args.client  || '100').trim();
    const acttype = String(args.acttype || 'G').trim().charAt(0).toUpperCase();

    if (!/^[A-Z0-9]{10,20}$/.test(trkorr)) {
      this.fail(`transport_log: invalid trkorr "${args.trkorr}" — expected transport number like X22K904025 (10 chars) or GT5KB1E8TJCMBE00SUEB (20-char gCTS ID).`);
    }
    if (!/^[A-Z0-9]{2,4}$/.test(system)) {
      this.fail(`transport_log: invalid system "${args.system}" — expected 2-4 character SAP system ID like C22 or D25.`);
    }
    if (!/^\d{1,3}$/.test(client)) {
      this.fail(`transport_log: invalid client "${args.client}" — expected 1-3 digit number.`);
    }

    const methodBody = `
DATA lt_lines TYPE TABLE OF trlog.
DATA lv_file  TYPE tstrf01-file.
DATA lv_fname TYPE tstrf01-filename.

CALL FUNCTION 'STRF_SETNAME_PROT'
  EXPORTING
    acttype  = '${acttype}'
    dirtype  = 'T'
    sysname  = '${system}'
    trkorr   = '${trkorr}'
  IMPORTING
    file     = lv_file
    filename = lv_fname
  EXCEPTIONS
    wrong_call = 1.

IF sy-subrc <> 0.
  out->write( 'STRF_SETNAME_PROT failed - check acttype/dirtype' ).
  RETURN.
ENDIF.

CALL FUNCTION 'TR_READ_LOG'
  EXPORTING
    iv_log_type     = 'FILE'
    iv_logname_file = lv_file
    iv_client       = '${client}'
  TABLES
    et_lines        = lt_lines
  EXCEPTIONS
    invalid_input = 1
    access_error  = 2
    OTHERS        = 3.

IF sy-subrc <> 0.
  out->write( |Log file not found: { lv_file }| ).
  out->write( 'The transport may not have been imported on this system, or try a different acttype (e.g. I).' ).
ELSE.
  out->write( |=== { lv_fname } ({ lines( lt_lines ) } lines) ===| ).
  LOOP AT lt_lines INTO DATA(ls).
    out->write( ls-line ).
  ENDLOOP.
ENDIF.
`;

    try {
      const output = await this.runClassrun(methodBody, 'ZCL_TMP_TR_LOG');
      return this.success({ trkorr, system, client, acttype, log: output });
    } catch (error: any) {
      this.fail(formatError(`transport_log(${trkorr}/${system})`, error));
    }
  }

  private async handleFind(args: any): Promise<any> {
    const query  = String(args.query  || '').trim();
    const owner  = String(args.owner  || '').toUpperCase().trim();
    const prefix = String(args.prefix || '').toUpperCase().trim();

    if (!query) this.fail('transport_find: query is required.');
    if (query.includes("'") || owner.includes("'") || prefix.includes("'")) {
      this.fail('transport_find: parameters must not contain single quotes.');
    }

    const prefixClause = prefix ? `AND trkorr LIKE '${prefix}%'` : '';
    const ownerClause  = owner  ? `AND as4user = '${owner}'`    : '';

    // E07T has: trkorr, sprsl/langu, as4text (description only)
    // E070 has: trkorr, as4user, as4date, as4time, trstatus
    // Use a local TYPES struct — SELECT with partial field list maps positionally,
    // so TYPE TABLE OF e07t would put as4text into the sprsl/langu field.
    const methodBody = `
TYPES: BEGIN OF ty_e07t_row,
         trkorr  TYPE e07t-trkorr,
         as4text TYPE e07t-as4text,
       END OF ty_e07t_row.
DATA lt_e07t TYPE TABLE OF ty_e07t_row.
DATA ls_e07t TYPE ty_e07t_row.
DATA ls_e070  TYPE e070.
DATA lv_count TYPE i.

SELECT trkorr as4text
  FROM e07t
  INTO TABLE lt_e07t
  WHERE as4text LIKE '%${query}%'
    ${prefixClause}.

SORT lt_e07t BY trkorr DESCENDING.
DELETE ADJACENT DUPLICATES FROM lt_e07t COMPARING trkorr.
DELETE lt_e07t FROM 50.

lv_count = 0.
LOOP AT lt_e07t INTO ls_e07t.
  CLEAR ls_e070.
  SELECT SINGLE trkorr as4user as4date as4time trstatus
    FROM e070
    INTO CORRESPONDING FIELDS OF ls_e070
    WHERE trkorr = ls_e07t-trkorr
    ${ownerClause}.
  IF sy-subrc = 0.
    out->write( |{ ls_e07t-trkorr } { ls_e070-as4date } { ls_e070-as4user } [{ ls_e070-trstatus }]: { ls_e07t-as4text }| ).
    lv_count = lv_count + 1.
  ENDIF.
ENDLOOP.
IF lv_count = 0.
  out->write( 'No transports found.' ).
ENDIF.
`;

    try {
      const output = await this.runClassrun(methodBody, 'ZCL_TMP_TR_FIND');
      return this.success({ query, owner, prefix, results: output });
    } catch (error: any) {
      this.fail(formatError(`transport_find(${query})`, error));
    }
  }

  private async handleInfo(args: any): Promise<any> {
    // Detect common mistake: passing a transport number (e.g. D25K900138) instead of an object name
    const candidate = args.name || args.transport;
    if (candidate && /^[A-Z]\d{2}[KUT]\d{6}$/i.test(String(candidate))) {
      this.fail(
        `transport_info looks up which transport an OBJECT is assigned to — it takes an object name and type, not a transport number. ` +
        `To see the objects on transport ${candidate}, use transport_contents with transport="${candidate}".`
      );
    }
    if (!args.name || !args.type) {
      this.fail('transport_info requires name (object name, e.g. /DSN/MY_CLASS) and type (e.g. CLAS, DDLS). ' +
        'To see objects on a transport number, use transport_contents.');
    }
    const sourceUrl = buildSourceUrl(args.name, args.type);
    try {
      const info = await this.withSession(() =>
        this.adtclient.transportInfo(sourceUrl)
      );
      return this.success({ name: args.name, transportInfo: info });
    } catch (error: any) {
      this.fail(formatError(`transport_info(${args.name})`, error));
    }
  }

  private async handleBundleIntoToc(args: any): Promise<any> {
    const toc = String(args.toc || '').toUpperCase().trim();
    const sources: string[] = Array.isArray(args.sources)
      ? args.sources.map((s: any) => String(s || '').toUpperCase().trim()).filter(Boolean)
      : [];

    if (!/^[A-Z0-9]{10,20}$/.test(toc)) {
      this.fail(`transport_bundle_into_toc: invalid toc "${args.toc}" — expected transport number.`);
    }
    if (sources.length === 0) {
      this.fail(`transport_bundle_into_toc: pass at least one source transport in "sources".`);
    }
    for (const s of sources) {
      if (!/^[A-Z0-9]{10,20}$/.test(s)) {
        this.fail(`transport_bundle_into_toc: invalid source transport "${s}".`);
      }
    }

    const safeToc = toc.replace(/'/g, "''");
    const sourceLiterals = sources.map(s => `'${s.replace(/'/g, "''")}'`).join(', ');

    // Validate that the target is a modifiable ToC, then call TR_COPY_COMM per source.
    const methodBody = `
DATA: ls_e070 TYPE e070.
SELECT SINGLE * FROM e070 INTO ls_e070 WHERE trkorr = '${safeToc}'.
IF sy-subrc <> 0.
  out->write( |Target ToC ${safeToc} not found in E070| ).
  RETURN.
ENDIF.
IF ls_e070-trfunction <> 'T'.
  out->write( |Target ${safeToc} is not a Transport of Copies (trfunction='{ ls_e070-trfunction }' — expected 'T')| ).
  RETURN.
ENDIF.
IF ls_e070-trstatus <> 'D'.
  out->write( |Target ToC ${safeToc} is not modifiable (trstatus='{ ls_e070-trstatus }' — expected 'D')| ).
  RETURN.
ENDIF.

DATA lt_sources TYPE STANDARD TABLE OF trkorr.
lt_sources = VALUE #( ${sources.map(s => `( '${s.replace(/'/g, "''")}' )`).join(' ')} ).

DATA lt_copied TYPE STANDARD TABLE OF string.

LOOP AT lt_sources INTO DATA(lv_src).
  " Verify source exists
  DATA ls_src_e070 TYPE e070.
  SELECT SINGLE * FROM e070 INTO ls_src_e070 WHERE trkorr = lv_src.
  IF sy-subrc <> 0.
    out->write( |Source { lv_src } not found, skipping| ).
    CONTINUE.
  ENDIF.

  CALL FUNCTION 'TR_COPY_COMM'
    EXPORTING
      wi_trkorr_from           = lv_src
      wi_trkorr_to             = '${safeToc}'
      wi_without_documentation = 'X'
      wi_dialog                = ' '
    EXCEPTIONS
      db_access_error          = 1
      no_authorization         = 2
      trkorr_from_not_exist    = 3
      trkorr_to_is_repair      = 4
      trkorr_to_locked         = 5
      trkorr_to_not_exist      = 6
      trkorr_to_released       = 7
      user_not_owner           = 8
      wrong_client             = 9
      wrong_category           = 10
      object_not_patchable     = 11
      OTHERS                   = 12.

  IF sy-subrc <> 0.
    out->write( |TR_COPY_COMM { lv_src } -> { '${safeToc}' } sy-subrc={ sy-subrc } ({ sy-msgid }/{ sy-msgno }) { sy-msgv1 } { sy-msgv2 }| ).
    " Don't abort — keep going for the remaining sources, but flag overall failure
    APPEND |FAIL { lv_src } subrc={ sy-subrc }| TO lt_copied.
  ELSE.
    APPEND |OK { lv_src }| TO lt_copied.
  ENDIF.
ENDLOOP.

COMMIT WORK.

" Final E071 count on the ToC
SELECT COUNT(*) FROM e071 INTO @DATA(lv_count) WHERE trkorr = '${safeToc}'.
out->write( |--- Result ---| ).
LOOP AT lt_copied INTO DATA(lv_r).
  out->write( lv_r ).
ENDLOOP.
out->write( |Total E071 entries on ${safeToc}: { lv_count }| ).
out->write( 'DONE' ).
`;

    try {
      const output = await this.runClassrun(methodBody, 'ZCL_TMP_TOC_BUNDLE');
      if (!output.includes('DONE')) {
        this.fail(`transport_bundle_into_toc(${toc}): ${output.trim()}`);
      }
      if (output.includes('FAIL ')) {
        this.fail(`transport_bundle_into_toc(${toc}): one or more sources failed:\n${output}`);
      }
      return this.success({
        toc,
        sourcesCopied: sources,
        details: output.trim()
      });
    } catch (error: any) {
      this.fail(formatError(`transport_bundle_into_toc(${toc})`, error));
    }
  }
}
