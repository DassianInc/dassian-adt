import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import type { InactiveObject } from 'abap-adt-api';
import { buildObjectUrl, buildPackageUrl, getSupportedTypes } from '../lib/urlBuilder.js';
import { formatError, parseAdtError, formatActivationMessages } from '../lib/errors.js';

const SUPPORTED = getSupportedTypes().join(', ');

export class ObjectHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_create',
        description:
          'Create a new ABAP object. For temporary objects use package=$TMP — no transport needed. ' +
          'For permanent objects, provide both a named package and transport. ' +
          'After creation, write source with abap_set_source and activate with abap_activate.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name, e.g. ZCL_MY_CLASS or /DSN/MY_CLASS' },
            type: {
              type: 'string',
              description: `Object type. Common: CLAS/OC (class), PROG/P (program), PROG/I (include), FUGR/F (function group), DDLS/DF (CDS view), INTF/OI (interface), TABL/DT (table). Full list: ${SUPPORTED}`
            },
            package: { type: 'string', description: 'Package name, e.g. $TMP or /DSN/CORE. Also accepted as "devclass".' },
            devclass: { type: 'string', description: 'Alias for package.' },
            description: { type: 'string', description: 'Short description shown in ABAP Workbench' },
            transport: { type: 'string', description: 'Transport number. Required for non-$TMP packages.' }
          },
          required: ['name', 'type', 'description']
        }
      },
      {
        name: 'abap_delete',
        description:
          'Delete an ABAP object. Locks the object, deletes it, and the lock is released implicitly by the delete. ' +
          'For objects in a transport, provide the transport number.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: `Object type. ${SUPPORTED}` },
            transport: { type: 'string', description: 'Transport number (required for non-$TMP objects)' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_activate',
        description:
          'Activate an ABAP object, making it the active version. ' +
          'Must be called after abap_set_source or abap_create. ' +
          'Returns success:true with empty messages if clean. ' +
          'Returns success:false with error messages if activation fails — read them, fix the source, and retry. ' +
          'For FUGR/FF (function modules): activation always targets the parent function group — provide fugr param.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: `Object type. ${SUPPORTED}` },
            fugr: { type: 'string', description: 'Parent function group name. Required when type=FUGR/FF, e.g. /DSN/010BWE.' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_search',
        description:
          'Search for ABAP objects by name pattern. Returns object names, types, and ADT URLs. ' +
          'IMPORTANT: Only TRAILING wildcards work. Use "/DSN/BIL*" not "/DSN/*BIL*". ' +
          'Leading wildcards (*SOMETHING) and mid-name wildcards (/DSN/*FOO*BAR*) will fail. ' +
          'If you need to find an object by partial name, put the known prefix first: /DSN/BIL*.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search string. Only trailing wildcards (*) work. E.g. ZCL_MY_* or /DSN/BIL*. Leading wildcards like *BILL* will fail.' },
            type: { type: 'string', description: `Filter by object type. ${SUPPORTED}. Omit to search all types.` },
            max: { type: 'number', description: 'Max results (default 50)' }
          },
          required: ['query']
        }
      },
      {
        name: 'abap_activate_batch',
        description:
          'Activate multiple ABAP objects in a single ADT request. ' +
          'More efficient than calling abap_activate repeatedly for each object. ' +
          'Returns activated:true if all objects activated cleanly, or activated:false with error messages if any failed. ' +
          'Use this after writing source for several objects at once (e.g. after a set of transport_assign calls).',
        inputSchema: {
          type: 'object',
          properties: {
            objects: {
              type: 'array',
              description: 'List of objects to activate. Each item must be an object with "name" (e.g. /DSN/MY_CLASS) and "type" (e.g. CLAS, PROG/P, DDLS).'
            }
          },
          required: ['objects']
        }
      },
      {
        name: 'abap_object_info',
        description:
          'Get metadata for an ABAP object: package, transport layer, active/inactive status, ' +
          'upgrade flag (upgradeFlag=true means object is in SPAU adjustment mode and cannot be edited via ADT), ' +
          'and structural information. Use this before attempting to edit an object you are unfamiliar with.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: `Object type. ${SUPPORTED}` }
          },
          required: ['name', 'type']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_create':          return this.handleCreate(args);
      case 'abap_delete':          return this.handleDelete(args);
      case 'abap_activate':        return this.handleActivate(args);
      case 'abap_activate_batch':  return this.handleActivateBatch(args);
      case 'abap_search':          return this.handleSearch(args);
      case 'abap_object_info':     return this.handleObjectInfo(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  // The library's createObject expects full subtypes (CLAS/OC, PROG/P, etc.)
  // but AIs often send just the short form. Map them automatically.
  private static readonly CREATE_TYPE_MAP: Record<string, string> = {
    'CLAS': 'CLAS/OC', 'INTF': 'INTF/OI', 'PROG': 'PROG/P',
    'FUGR': 'FUGR/F', 'DDLS': 'DDLS/DF', 'DDLX': 'DDLX/EX',
    'TABL': 'TABL/DT', 'DTEL': 'DTEL/DE', 'DOMA': 'DOMA/DD',
    'DCLS': 'DCLS/DL', 'SRVD': 'SRVD/SRV', 'SRVB': 'SRVB/SVB',
    'ENHO': 'ENHO/XHH', 'DEVC': 'DEVC/K', 'MSAG': 'MSAG/N',
    'VIEW': 'VIEW/DV',
  };

  private async handleCreate(args: any): Promise<any> {
    // Accept devclass as alias for package (common SAP terminology)
    if (args.devclass && !args.package) args.package = args.devclass;
    if (!args.package) {
      // Elicit the package from the user instead of just failing
      const input = await this.elicitForm(
        `abap_create(${args.name}): Which package should this object be created in?`,
        {
          package: {
            type: 'string',
            title: 'Package',
            description: 'Package name. Use $TMP for temporary/test objects, or a real package like /DSN/CORE for permanent objects.',
            default: '$TMP'
          }
        },
        ['package']
      );
      if (input?.package) {
        args.package = input.package;
      } else {
        this.fail('abap_create: package is required (e.g. $TMP or /DSN/MYPACKAGE). Also accepted as "devclass".');
      }
    }
    // Map short types to full subtypes (CLAS → CLAS/OC, PROG → PROG/P, etc.)
    const typeKey = args.type?.toUpperCase();
    const createType = ObjectHandlers.CREATE_TYPE_MAP[typeKey] || args.type;
    const packageUrl = buildPackageUrl(args.package);
    try {
      await this.withSession(() =>
        this.adtclient.createObject(
          createType,
          args.name,
          args.package,
          args.description,
          packageUrl,
          undefined,
          args.transport
        )
      );
      return this.success({
        message: `Created ${args.type} ${args.name}. Now write source with abap_set_source and activate with abap_activate.`,
        name: args.name,
        type: args.type,
        package: args.package
      });
    } catch (error: any) {
      this.fail(formatError(`abap_create(${args.name})`, error));
    }
  }

  private async handleDelete(args: any): Promise<any> {
    // Elicit confirmation for non-$TMP objects (they're in a real package with a transport)
    if (args.transport) {
      const confirmed = await this.confirmWithUser(
        `Delete ${args.type} ${args.name} on transport ${args.transport}? This removes the object from the system.`,
        { object: args.name, type: args.type, transport: args.transport }
      );
      if (!confirmed) {
        this.fail(`abap_delete(${args.name}): cancelled by user.`);
      }
    }

    const objectUrl = buildObjectUrl(args.name, args.type);
    let lockHandle: string | null = null;
    try {
      const lockResult = await this.withSession(() =>
        this.adtclient.lock(objectUrl)
      );
      lockHandle = lockResult.LOCK_HANDLE;

      await this.withSession(async () => {
        // The library appends ?corrNr=TRANSPORT which some ADT endpoints (e.g. DDLS) reject.
        // The lock handle already encodes the transport — call DELETE directly without corrNr.
        const h = (this.adtclient as any).h;
        await h.request(objectUrl, { method: 'DELETE', qs: { lockHandle: lockHandle! } });
      });
      lockHandle = null;

      return this.success({ message: `Deleted ${args.type} ${args.name}` });
    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(objectUrl, lockHandle); } catch (_) {}
      }
      this.fail(formatError(`abap_delete(${args.name})`, error));
    }
  }

  private async handleActivate(args: any): Promise<any> {
    if (!args.name || !args.type) {
      this.fail('abap_activate requires name (object name) and type (e.g. CLAS, PROG/P).');
    }
    // Function modules can't be activated individually — SAP activates the whole function group.
    // When type is FUGR/FF, activate the parent FUGR instead.
    let activateName: string;
    let objectUrl: string;

    if (args.type?.toUpperCase() === 'FUGR/FF') {
      if (!args.fugr) {
        this.fail(
          `abap_activate: type FUGR/FF requires the fugr parameter (parent function group name). ` +
          `Example: fugr="/DSN/010BWE" to activate function group /DSN/010BWE.`
        );
      }
      activateName = args.fugr.toUpperCase();
      objectUrl = buildObjectUrl(args.fugr, 'FUGR/F');
    } else {
      activateName = args.name.toUpperCase();
      objectUrl = buildObjectUrl(args.name, args.type);
    }

    try {
      const result = await this.withSession(() =>
        this.adtclient.activate(activateName, objectUrl)
      );

      if (result && !result.success) {
        const errorText = formatActivationMessages(result.messages || []);

        // If the error mentions a dump but gives no ID, try to fetch the most recent dump
        // automatically — SAP sometimes fails to write the full ST22 entry.
        let recentDump: any = undefined;
        const hasDumpHint = errorText.toLowerCase().includes('dump') || errorText.toLowerCase().includes('runtime');
        const hasEmptyDumpId = /dump id:\s*\)/i.test(errorText) || /dump id:\s*"?\s*"?\s*\)/i.test(errorText);
        if (hasDumpHint && hasEmptyDumpId) {
          try {
            const feed = await this.withSession(() => this.adtclient.dumps());
            const dumps = (feed as any)?.dumps || [];
            recentDump = dumps[0] || null;
          } catch (_) {}
        }

        return this.success({
          activated: false,
          name: args.name,
          errors: errorText,
          ...(recentDump ? {
            recentDump: {
              hint: 'Empty dump ID — fetched most recent ST22 entry automatically:',
              text: recentDump.text,
              type: recentDump.type,
              id: recentDump.id
            }
          } : {})
        });
      }

      // Check for still-inactive dependents — offer to activate them
      const inactive = result?.inactive || [];
      const inactiveNames = inactive
        .map((i: any) => i.object?.['adtcore:name'])
        .filter(Boolean);

      if (inactiveNames.length > 0) {
        const activateMore = await this.confirmWithUser(
          `${args.name} activated successfully, but ${inactiveNames.length} dependent object(s) are still inactive: ${inactiveNames.join(', ')}. Activate them too?`,
          { dependents: inactiveNames.join(', ') }
        );
        if (activateMore) {
          const activatedDeps: string[] = [];
          const failedDeps: string[] = [];
          for (const dep of inactive) {
            const depName = dep.object?.['adtcore:name'];
            const depUrl = dep.object?.['adtcore:uri'];
            if (depName && depUrl) {
              try {
                await this.withSession(() => this.adtclient.activate(depName, depUrl));
                activatedDeps.push(depName);
              } catch (_) {
                failedDeps.push(depName);
              }
            }
          }
          return this.success({
            activated: true,
            name: args.name,
            dependentsActivated: activatedDeps,
            dependentsFailed: failedDeps.length > 0 ? failedDeps : undefined
          });
        }
      }

      return this.success({
        activated: true,
        name: args.name,
        dependentsStillInactive: inactiveNames.length > 0 ? inactiveNames : []
      });
    } catch (error: any) {
      this.fail(formatError(`abap_activate(${args.name})`, error));
    }
  }

  // Map short types to their ADT adtcore:type subtype for activation
  private static readonly ACTIVATE_TYPE_MAP: Record<string, string> = {
    'CLAS': 'CLAS/OC', 'INTF': 'INTF/OI', 'PROG': 'PROG/P',
    'FUGR': 'FUGR/F', 'DDLS': 'DDLS/DF', 'DDLX': 'DDLX/EX',
    'TABL': 'TABL/DT', 'DTEL': 'DTEL/DE', 'DOMA': 'DOMA/DD',
    'DCLS': 'DCLS/DL', 'SRVD': 'SRVD/SRV', 'SRVB': 'SRVB/SVB',
    'ENHO': 'ENHO/XHH', 'DEVC': 'DEVC/K', 'MSAG': 'MSAG/N',
    'VIEW': 'VIEW/DV', 'BDEF': 'BDEF',
  };

  private async handleActivateBatch(args: any): Promise<any> {
    if (!args.objects || !Array.isArray(args.objects) || args.objects.length === 0) {
      this.fail('abap_activate_batch: objects array is required and must not be empty.');
    }
    try {
      const inactiveObjects: InactiveObject[] = args.objects.map((o: any) => {
        if (!o.name || !o.type) {
          throw new Error(`Each object must have name and type. Got: ${JSON.stringify(o)}`);
        }
        const typeKey = o.type.toUpperCase();
        const adtType = ObjectHandlers.ACTIVATE_TYPE_MAP[typeKey] || typeKey;
        const uri = buildObjectUrl(o.name, o.type);
        return {
          'adtcore:uri': uri,
          'adtcore:type': adtType,
          'adtcore:name': o.name.toUpperCase(),
          'adtcore:parentUri': ''
        };
      });

      const result = await this.withSession(() =>
        this.adtclient.activate(inactiveObjects)
      );

      if (result && !result.success) {
        const errorText = formatActivationMessages(result.messages || []);

        // Offer to retry each object individually to isolate which one(s) are failing
        const choice = await this.elicitChoice(
          `Batch activation failed for ${inactiveObjects.length} object(s).\n${errorText}\n\n` +
          `Retry each object individually to find which one(s) are causing the failure?`,
          'action',
          ['Retry individually', 'Abort'],
          'Retry individually'
        );

        if (choice === 'Retry individually') {
          const passed: string[] = [];
          const failed: Array<{ name: string; error: string }> = [];
          for (const obj of inactiveObjects) {
            try {
              const r = await this.withSession(() =>
                this.adtclient.activate(obj)
              );
              if (r && !r.success) {
                failed.push({ name: obj['adtcore:name'], error: formatActivationMessages(r.messages || []) });
              } else {
                passed.push(obj['adtcore:name']);
              }
            } catch (e: any) {
              failed.push({ name: obj['adtcore:name'], error: e.message });
            }
          }
          return this.success({
            activated: failed.length === 0,
            mode: 'individual_retry',
            passed,
            failed
          });
        }

        this.fail(`abap_activate_batch: activation failed.\n${errorText}`);
      }

      const inactive = result?.inactive || [];
      const inactiveNames = inactive
        .map((i: any) => i.object?.['adtcore:name'])
        .filter(Boolean);

      // Offer to activate still-inactive dependents
      if (inactiveNames.length > 0) {
        const activateDeps = await this.confirmWithUser(
          `${inactiveObjects.length} object(s) activated. ` +
          `${inactiveNames.length} dependent(s) are still inactive: ${inactiveNames.join(', ')}. Activate them too?`,
          { dependents: inactiveNames.join(', ') }
        );
        if (activateDeps) {
          const activatedDeps: string[] = [];
          const failedDeps: string[] = [];
          for (const dep of inactive) {
            const depName = dep.object?.['adtcore:name'];
            const depUrl = dep.object?.['adtcore:uri'];
            if (depName && depUrl) {
              try {
                await this.withSession(() => this.adtclient.activate(depName, depUrl));
                activatedDeps.push(depName);
              } catch (_) {
                failedDeps.push(depName);
              }
            }
          }
          return this.success({
            activated: true,
            objectCount: inactiveObjects.length,
            objects: args.objects.map((o: any) => o.name),
            dependentsActivated: activatedDeps,
            dependentsFailed: failedDeps.length > 0 ? failedDeps : undefined
          });
        }
      }

      return this.success({
        activated: true,
        objectCount: inactiveObjects.length,
        objects: args.objects.map((o: any) => o.name),
        dependentsStillInactive: inactiveNames.length > 0 ? inactiveNames : []
      });
    } catch (error: any) {
      this.fail(formatError('abap_activate_batch', error));
    }
  }

  /**
   * Sanitize search query for SAP ADT quick search.
   * SAP only supports trailing wildcards (e.g. /DSN/BIL*).
   * Leading wildcards (*BILL*) and multi-wildcards (/DSN/*FOO*BAR*) return 400.
   * This method rewrites bad patterns into valid ones and returns a warning.
   */
  private sanitizeSearchQuery(query: string): { query: string; warning?: string } {
    if (!query) return { query };
    const original = query;

    // Pattern: *SOMETHING or *SOMETHING* (leading wildcard, no namespace)
    // e.g. *SF1403* → SF1403*
    if (query.startsWith('*')) {
      query = query.replace(/^\*+/, '').replace(/\*+$/, '') + '*';
      return {
        query,
        warning: `Rewrote "${original}" → "${query}" (SAP ADT only supports trailing wildcards)`
      };
    }

    // Pattern: /NS/*SOMETHING* (namespace + leading wildcard in name part)
    // e.g. /DSN/*BILL* → /DSN/BILL*
    // e.g. /VNO/*FORM* → /VNO/FORM*
    const nsMatch = query.match(/^(\/[^/]+\/)\*(.+)$/);
    if (nsMatch) {
      const ns = nsMatch[1];
      const rest = nsMatch[2].replace(/\*+$/, '') + '*';
      query = ns + rest;
      return {
        query,
        warning: `Rewrote "${original}" → "${query}" (SAP ADT only supports trailing wildcards)`
      };
    }

    // Pattern: multiple wildcards in the name e.g. /DSN/FOO*BAR*
    const wildcardCount = (query.match(/\*/g) || []).length;
    if (wildcardCount > 1) {
      // Keep everything up to the first wildcard
      const firstStar = query.indexOf('*');
      query = query.substring(0, firstStar + 1);
      return {
        query,
        warning: `Rewrote "${original}" → "${query}" (SAP ADT does not support multiple wildcards)`
      };
    }

    return { query };
  }

  private async handleSearch(args: any): Promise<any> {
    const { query, warning } = this.sanitizeSearchQuery(args.query);
    try {
      const results = await this.withSession(() =>
        this.adtclient.searchObject(query, args.type, args.max || 50)
      );
      const count = Array.isArray(results) ? results.length : 0;
      const hint = count === 0 && query && !query.includes('*')
        ? ` No results — try adding a wildcard, e.g. "${query}*"`
        : undefined;
      return this.success({ results, count, ...(warning ? { warning } : {}), ...(hint ? { hint } : {}) });
    } catch (error: any) {
      this.fail(formatError(`abap_search(${query})`, error) +
        (warning ? ` (original query "${args.query}" was rewritten to "${query}")` : ''));
    }
  }

  private async handleObjectInfo(args: any): Promise<any> {
    // For FUGR/FF (function modules), objectStructure is not meaningful on the FM directly.
    // Redirect to the parent FUGR if available, otherwise explain.
    const effectiveType = args.type?.toUpperCase() === 'FUGR/FF' ? 'FUGR/F' : args.type;
    const effectiveName = args.type?.toUpperCase() === 'FUGR/FF'
      ? (args.fugr || args.name)  // use fugr param if provided, else fall through and let buildObjectUrl fail clearly
      : args.name;

    const objectUrl = buildObjectUrl(effectiveName, effectiveType);

    try {
      const structure = await this.withSession(() =>
        this.adtclient.objectStructure(objectUrl)
      );

      // Surface the upgrade flag prominently — if true, edits will fail with "adjustment mode"
      const structureStr = JSON.stringify(structure).toLowerCase();
      const upgradeFlag = (structure as any)?.upgradeFlag === true ||
        structureStr.includes('"upgradeflag":true');

      return this.success({
        name: args.name,
        type: args.type,
        structure,
        upgradeFlag,
        upgradeWarning: upgradeFlag
          ? 'WARNING: This object is in SPAU adjustment mode. All lock/edit/delete operations will fail with "Enhancement is in adjustment mode." Use SPAU_ENH in SAP GUI to clear this before editing.'
          : undefined
      });
    } catch (error: any) {
      const info = parseAdtError(error);
      // For FUGRs, objectStructure may return an unusual shape or temporarily fail during
      // activation processing. Surface what we know rather than a raw API error.
      if (args.type?.toUpperCase() === 'FUGR/F' || args.type?.toUpperCase() === 'FUGR') {
        this.fail(
          `abap_object_info(${args.name}): Could not retrieve function group structure. ` +
          `If the function group is mid-activation or has an active lock, try again after activation completes. ` +
          `Details: ${info.message}`
        );
      }
      this.fail(formatError(`abap_object_info(${args.name})`, error));
    }
  }
}
