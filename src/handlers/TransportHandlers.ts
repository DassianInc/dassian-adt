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
          'Create a new transport request (Workbench transport). ' +
          'Returns the transport request number (e.g. D23K900123). ' +
          'Note: a child task is created automatically — objects must be assigned via transport_assign. ' +
          'After creating, use transport_assign to add objects, then transport_release when ready.',
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
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'transport_create':  return this.handleCreate(args);
      case 'transport_assign':  return this.handleAssign(args);
      case 'transport_release': return this.handleRelease(args);
      case 'transport_list':     return this.handleList(args);
      case 'transport_info':     return this.handleInfo(args);
      case 'transport_contents': return this.handleContents(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleCreate(args: any): Promise<any> {
    const sourceUrl = buildSourceUrl(args.objectName, args.objectType);
    // package is optional — when omitted SAP derives it from the anchor object's REF URL.
    // Passing a wrong package causes "Error during deserialization" from SAP.
    const devclass = args.package || '';
    try {
      const result = await this.withSession(() =>
        this.adtclient.createTransport(sourceUrl, args.description, devclass)
      );
      const transportNumber = (result as any)?.transportNumber || result;
      // Resolve the task number — abap_set_source needs the TASK (child), not the REQUEST (parent).
      // The task number is returned by resolveTaskNumber after userTransports becomes available.
      const taskNumber = await this.resolveTaskNumber(transportNumber as string);
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
      if (/deserialization/i.test(msg)) {
        this.fail(
          `transport_create failed: SAP rejected the request — most likely the package name is wrong or the anchor object does not exist. ` +
          `Try omitting the package parameter and let SAP derive it from the object. Original: ${msg}`
        );
      }
      this.fail(formatError('transport_create', error));
    }
  }

  private async handleAssign(args: any): Promise<any> {
    if (!args.name || !args.type || !args.transport) {
      this.fail('transport_assign requires name (object name), type (e.g. CLAS, VIEW), and transport (request number).');
    }
    // Metadata-only types (no text source) — assign via transportReference which registers
    // the object on the transport directly without needing lock+read/write+unlock.
    // These types are containers or have no direct text source — assign via transportReference
    // to avoid creating inactive versions of sub-objects (e.g. FUGR lock/write creates inactive SAPL).
    const METADATA_TYPES = new Set(['VIEW', 'TABL', 'DOMA', 'DTEL', 'SHLP', 'SQLT', 'TTYP', 'DEVC', 'FUGR', 'MSAG', 'ENHS']);
    const typeKey = args.type.toUpperCase().split('/')[0];
    const isMetadata = METADATA_TYPES.has(typeKey);

    if (isMetadata) {
      try {
        await this.withSession(() =>
          this.adtclient.transportReference('R3TR', typeKey, args.name.toUpperCase(), args.transport)
        );
        return this.success({
          message: `${args.name} assigned to transport ${args.transport}`,
          name: args.name,
          transport: args.transport
        });
      } catch (error: any) {
        this.fail(formatError(`transport_assign(${args.name})`, error));
      }
    }

    const objectUrl = buildObjectUrl(args.name, args.type);
    const sourceUrl = `${objectUrl}/source/main`;
    let lockHandle: string | null = null;

    // lock → read → write → unlock must be a SINGLE withSession block.
    // Separate withSession calls risk session recovery between lock() and setObjectSource(),
    // which would invalidate the lock handle for the write.
    const doAssign = async (): Promise<void> => {
      const lockResult = await this.adtclient.lock(objectUrl);
      lockHandle = lockResult.LOCK_HANDLE;
      try {
        const currentSource = await this.adtclient.getObjectSource(sourceUrl);
        await this.adtclient.setObjectSource(sourceUrl, currentSource as string, lockHandle!, args.transport);
      } catch (err: any) {
        try { await this.adtclient.unLock(objectUrl, lockHandle!); } catch (_) {}
        lockHandle = null;
        throw err;
      }
      await this.adtclient.unLock(objectUrl, lockHandle!);
      lockHandle = null;
    };

    try {
      await this.withSession(doAssign);
      return this.success({
        message: `${args.name} assigned to transport ${args.transport}`,
        name: args.name,
        transport: args.transport
      });
    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(objectUrl, lockHandle); } catch (_) {}
      }
      this.fail(formatError(`transport_assign(${args.name})`, error));
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
          // userTransports gives us the full request→task structure.
          const user = (this.adtclient as any).username || (this.adtclient as any).h?.username;
          const transports = await this.withSession(() =>
            this.adtclient.userTransports(user)
          ) as any;

          // Walk workbench targets to find the request and extract its tasks
          const tasks: string[] = [];
          const allRequests = (transports?.workbench ?? []).flatMap((t: any) =>
            [...(t.modifiable ?? []), ...(t.released ?? [])]
          );
          for (const req of allRequests) {
            const reqNum: string = req['tm:number'] || req.number || '';
            if (reqNum.toUpperCase() === args.transport.toUpperCase()) {
              for (const task of (req.tasks ?? [])) {
                const taskNum: string = task['tm:number'] || task.number || '';
                if (taskNum) tasks.push(taskNum);
              }
              break;
            }
          }

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
    try {
      // ADTClient.transportRelease(number, ignoreLocks, IgnoreATC)
      // Pass false for ignoreLocks; use ignoreAtc for the 3rd param.
      return await this.withSession(() =>
        this.adtclient.transportRelease(transportNumber, false, ignoreAtc)
      );
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();
      // Older SAP systems return "System expected the element '{...tm}root'" when the POST body
      // is empty — they require a minimal <tm:root> XML body.
      if (msg.includes('expected the element') || msg.includes('tm}root') || msg.includes('tm:root')) {
        const h = (this.adtclient as any).h;
        const action = ignoreAtc ? 'relObjigchkatc' : 'newreleasejobs';
        return await this.withSession(() =>
          h.request(`/sap/bc/adt/cts/transportrequests/${transportNumber}/${action}`, {
            method: 'POST',
            headers: {
              Accept: 'application/*',
              'Content-Type': 'application/xml'
            },
            body: `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"/>`
          })
        );
      }
      throw err;
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
