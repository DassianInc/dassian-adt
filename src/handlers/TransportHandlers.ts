import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl, buildSourceUrl } from '../lib/urlBuilder.js';
import { formatError } from '../lib/errors.js';

export class TransportHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'transport_create',
        description:
          'Create a new transport request. ' +
          'Returns the transport request number (e.g. D23K900123). ' +
          'Note: a child task is created automatically — objects must be assigned via transport_assign. ' +
          'After creating, use transport_assign to add objects, then transport_release when ready. ' +
          'Set transportType="toc" to create a Transport of Copies (TOC) instead of a Workbench request.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Short description for the transport (shown in STMS)' },
            package: {
              type: 'string',
              description: 'Target package, e.g. /DSN/CORE. If omitted, SAP derives it from the anchor object.'
            },
            objectName: {
              type: 'string',
              description: 'Name of one object to anchor the transport to (required by ADT API)'
            },
            objectType: {
              type: 'string',
              description: 'Type of the anchor object (e.g. CLAS, DDLS/DF)'
            },
            transportType: {
              type: 'string',
              enum: ['workbench', 'toc'],
              description: 'Transport type: "workbench" (default, TRFUNCTION=K) or "toc" (Transport of Copies, TRFUNCTION=T)'
            }
          },
          required: ['description', 'objectName', 'objectType']
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
          'WARNING: Irreversible. Only call when explicitly asked to release. ' +
          'NEVER call automatically after activation — always wait for explicit instruction.',
        inputSchema: {
          type: 'object',
          properties: {
            transport: { type: 'string', description: 'Transport request number (e.g. D23K900123)' },
            ignoreAtc: { type: 'boolean', description: 'Skip ATC checks on release (default false)' }
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
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'transport_create':    return this.handleCreate(args);
      case 'transport_assign':    return this.handleAssign(args);
      case 'transport_release':   return this.handleRelease(args);
      case 'transport_list':      return this.handleList(args);
      case 'transport_info':      return this.handleInfo(args);
      case 'transport_contents':  return this.handleContents(args);
      case 'transport_delete':    return this.handleDelete(args);
      case 'transport_set_owner': return this.handleSetOwner(args);
      case 'transport_add_user':  return this.handleAddUser(args);
      case 'transport_log':       return this.handleLog(args);
      case 'transport_find':      return this.handleFind(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleCreate(args: any): Promise<any> {
    const sourceUrl = buildSourceUrl(args.objectName, args.objectType);
    // package is optional — when omitted SAP derives it from the anchor object's REF URL.
    // Passing a wrong package causes "Error during deserialization" from SAP.
    const devclass = args.package || '';
    // SAP transport descriptions are capped at 60 characters — longer strings cause "deserialization" errors.
    const description: string = args.description.length > 60
      ? args.description.slice(0, 60)
      : args.description;
    // ADTClient.createTransport posts to /sap/bc/adt/cts/transports with
    // dataname=com.sap.adt.CreateCorrectionRequest — that content type always creates
    // a Workbench (K) regardless of any OPERATION parameter.
    // For a Transport of Copies (TOC), we create a Workbench request first, then
    // immediately reclassify the request header to TRFUNCTION='T' via PUT/classify.
    const isToc = args.transportType === 'toc';
    try {
      const result = await this.withSession(() =>
        this.adtclient.createTransport(sourceUrl, description, devclass)
      );
      const transportNumber = (result as any)?.transportNumber || result;

      if (isToc) {
        // Reclassify the REQUEST header from K (Workbench) to T (Transport of Copies).
        // TOCs don't have child tasks — objects are assigned directly on the request.
        const h = (this.adtclient as any).h;
        await this.withSession(() =>
          h.request(`/sap/bc/adt/cts/transportrequests/${transportNumber}`, {
            method: 'PUT',
            headers: { Accept: 'application/*' },
            body: `<?xml version="1.0" encoding="ASCII"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${transportNumber}" tm:useraction="classify" tm:trfunction="T"/>`
          })
        );
        return this.success({
          transport: transportNumber,
          message:
            `TOC ${transportNumber} created. ` +
            `Objects go directly on the request — pass ${transportNumber} (not a task) to transport_assign.`
        });
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

    try {
      try {
        await this.notify(`Releasing ${args.transport}…`);
        const result = await this.releaseOne(args.transport, args.ignoreAtc || false);
        return this.success({ transport: args.transport, released: true, result });
      } catch (firstError: any) {
        const msg = (firstError?.message || '').toLowerCase();
        if (msg.includes('task') && (msg.includes('not yet released') || msg.includes('referencing'))) {
          // Parent request can't release yet — find and release its tasks first.
          // Query E070 directly (fast) instead of userTransports (slow on large systems).
          const e070 = await this.withSession(() =>
            this.adtclient.tableContents('E070', 20, false,
              `SELECT trkorr FROM e070 WHERE strkorr = '${args.transport.toUpperCase()}' AND trstatus = 'D'`)
          ) as any;
          const rows: any[] = e070?.values || e070?.records || e070?.value || [];
          const tasks: string[] = rows.map((r: any) => r.TRKORR || r.trkorr).filter(Boolean);

          for (const task of tasks) {
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

    // When ignoreAtc=true the ADT library generates a blank transport number in the URL.
    // Always use the raw HTTP path — it works on all systems and avoids the library bug.
    if (ignoreAtc) {
      return await this.withSession(() =>
        h.request(`/sap/bc/adt/cts/transportrequests/${transportNumber}/${action}`, {
          method: 'POST',
          headers: { Accept: 'application/*', 'Content-Type': 'application/xml' },
          body: `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"/>`
        })
      );
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
        const retryResult = await this.withSession(() =>
          h.request(`/sap/bc/adt/cts/transportrequests/${transportNumber}/${action}`, {
            method: 'POST',
            headers: { Accept: 'application/*', 'Content-Type': 'application/xml' },
            body: `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"/>`
          })
        );
        this.assertReleaseSucceeded(retryResult);
        return retryResult;
      }
      throw err;
    }
  }

  // ADT returns abortrelapifail (not a thrown error) when tasks are unreleased or other
  // soft failures occur. Throw so callers can catch and handle (e.g. auto-release tasks).
  private assertReleaseSucceeded(result: any): void {
    const items: any[] = Array.isArray(result) ? result : [result];
    const item = items[0] || {};
    const status: string = item['chkrun:status'] || '';
    if (status.includes('fail') || status.includes('abort')) {
      const msgs: string = (item.messages || [])
        .map((m: any) => m['chkrun:shortText'])
        .filter(Boolean)
        .join('; ');
      throw new Error(msgs || item['chkrun:statusText'] || `Release failed: ${status}`);
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
}
