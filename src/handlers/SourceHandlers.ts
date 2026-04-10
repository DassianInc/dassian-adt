import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl, buildSourceUrl, getSupportedTypes, NESTED_TYPES } from '../lib/urlBuilder.js';
import { formatError, parseAdtError } from '../lib/errors.js';

const SUPPORTED = getSupportedTypes().join(', ');

export class SourceHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_get_source',
        annotations: { readOnlyHint: true },
        description:
          'Get the ABAP source code for any object by name and type. ' +
          'NOT for TABL or STRU — those are DDIC objects with no source; use abap_table instead. ' +
          'No URL construction needed — just provide the object name and type. ' +
          `Supported types: ${SUPPORTED}. ` +
          'For namespaced objects pass the raw name including slashes, e.g. /DSN/MY_CLASS. ' +
          'For large classes, use compact=true to get only the CLASS DEFINITION (method signatures, no bodies) — 10-30x smaller.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Object name, e.g. ZCL_MY_CLASS or /DSN/MY_CLASS'
            },
            type: {
              type: 'string',
              description: `Object type. FUGR/F = function group CONTAINER (no source — use abap_get_function_group to get all its source). FUGR/I = specific function group include (auto-discovers parent). FUGR/FF = specific function module source — provide fugr param if known. Other common: CLAS, PROG/I, PROG/P, DDLS/DF, ENHO/XHH. Full list: ${SUPPORTED}`
            },
            fugr: {
              type: 'string',
              description: 'Parent function group name. Required for FUGR/FF if auto-discovery fails. E.g. if FM is /DSN/010BWE_SC, fugr is /DSN/010BWE.'
            },
            compact: {
              type: 'boolean',
              description: 'If true and type=CLAS, strips all METHOD...ENDMETHOD bodies and returns only the CLASS DEFINITION block. Use this to understand a large class\'s interface without loading its full implementation.'
            }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_set_source',
        annotations: { idempotentHint: true },
        description:
          'Write ABAP source code for an object. Handles lock → write → unlock automatically. ' +
          'For objects outside $TMP, provide a transport number. ' +
          'IMPORTANT: After writing source, call abap_activate to make it active.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Object name, e.g. ZCL_MY_CLASS or /DSN/MY_CLASS'
            },
            type: {
              type: 'string',
              description: `Object type. Common: CLAS, PROG/I, DDLS/DF, ENHO/XHH, FUGR/FF (function module). Full list: ${SUPPORTED}`
            },
            source: {
              type: 'string',
              description: 'Full ABAP source code to write'
            },
            transport: {
              type: 'string',
              description: 'Transport request number (e.g. D23K900123). Required for objects outside $TMP. Omit for $TMP objects.'
            },
            fugr: {
              type: 'string',
              description: 'Parent function group name. Required for FUGR/FF if auto-discovery fails. E.g. if FM is /DSN/010BWE_SC, fugr is /DSN/010BWE.'
            }
          },
          required: ['name', 'type', 'source']
        }
      },
      {
        name: 'abap_edit_method',
        annotations: { idempotentHint: true },
        description:
          'Surgically edit a single method inside an ABAP class without touching the rest of the source. ' +
          'Finds the method boundaries, does a find/replace scoped only to that method body, ' +
          'runs a syntax check on the reconstructed class, and writes it back. ' +
          'Much safer than abap_set_source for targeted fixes — no risk of clobbering other methods. ' +
          'After success, call abap_activate to activate the change.',
        inputSchema: {
          type: 'object',
          properties: {
            name:        { type: 'string',  description: 'Class name, e.g. /DSN/CL_S4CM_CMB_CONTRACT' },
            method:      { type: 'string',  description: 'Method name (case-insensitive), e.g. GET_HEADER or /DSN/IF_SOMETHING~GET_HEADER' },
            old_string:  { type: 'string',  description: 'Exact string to find within the method body' },
            new_string:  { type: 'string',  description: 'Replacement string' },
            replace_all: { type: 'boolean', description: 'If true, replace all occurrences. Default: false (error if more than one match).' },
            transport:   { type: 'string',  description: 'Transport number. Required for objects outside $TMP.' }
          },
          required: ['name', 'method', 'old_string', 'new_string']
        }
      },
      {
        name: 'abap_set_class_include',
        annotations: { idempotentHint: true },
        description:
          'Write source to a specific include of an ABAP class (implementations, definitions, macros, testclasses). ' +
          'Use this instead of raw_http lock/PUT/unlock sequences — those break because each raw_http call ' +
          'gets a fresh ICM session, making the lock handle invalid for the write. ' +
          'This tool handles lock → write → unlock atomically on one session. ' +
          'After writing, call abap_activate(name, CLAS) to activate.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Class name, e.g. /DSN/BP_R_MOD'
            },
            include_type: {
              type: 'string',
              description:
                'Which class include to write. Values: ' +
                '"implementations" = CCIMP (local classes, behavior handler bodies), ' +
                '"definitions" = CCDEF (local type/class definitions), ' +
                '"macros" = CCMAC, ' +
                '"testclasses" = CCAU (ABAP Unit tests).'
            },
            source: {
              type: 'string',
              description: 'Full source to write into the include'
            },
            transport: {
              type: 'string',
              description: 'Transport request number. Required for objects outside $TMP.'
            }
          },
          required: ['name', 'include_type', 'source']
        }
      },
      {
        name: 'abap_get_function_group',
        annotations: { readOnlyHint: true },
        description:
          'Get all source for a function group in one call: top include, all user includes (U01..UXX), ' +
          'and all function module sources. Returns a map of include/FM name → source. ' +
          'Use this instead of multiple abap_get_source calls when you need to understand or search a whole function group.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Function group name, e.g. /DSN/010BWE or ZBILLING'
            }
          },
          required: ['name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_get_source':           return this.handleGetSource(args);
      case 'abap_set_source':           return this.handleSetSource(args);
      case 'abap_set_class_include':    return this.handleSetClassInclude(args);
      case 'abap_edit_method':          return this.handleEditMethod(args);
      case 'abap_get_function_group':   return this.handleGetFunctionGroup(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleGetSource(args: any): Promise<any> {
    // Tables and structures are DDIC objects — they don't have ABAP source code.
    // Redirect immediately so the agent doesn't hit SAP with a confusing error.
    const typeKey = args.type?.toUpperCase();
    if (['TABL', 'TABL/DT', 'TABL/DS', 'STRU'].includes(typeKey)) {
      this.fail(
        `abap_get_source does not work for ${args.type} objects — DDIC tables and structures ` +
        `have no ABAP source. Use abap_table(name="${args.name}") to get field definitions instead.`
      );
    }

    try {
      let sourceUrl: string;

      if (NESTED_TYPES.has(args.type?.toUpperCase())) {
        const resolved = await this.resolveNestedUrl(args.name, args.type, args.fugr);
        sourceUrl = resolved.sourceUrl;
      } else {
        sourceUrl = buildSourceUrl(args.name, args.type);
      }

      const source = await this.withSession(() =>
        this.adtclient.getObjectSource(sourceUrl)
      ) as string;

      // compact=true: strip METHOD...ENDMETHOD bodies, keep only CLASS DEFINITION
      if (args.compact && args.type?.toUpperCase() === 'CLAS') {
        const compact = stripMethodBodies(source);
        return this.success({ source: compact, name: args.name, type: args.type, compact: true });
      }

      return this.success({ source, name: args.name, type: args.type });
    } catch (error: any) {
      const msg = String(error?.message || error || '');
      // DDIC objects (TABL, STRU) that have never been modified only exist in active form.
      // ADT's source endpoint returns "inactive version does not exist" in that case.
      if (/inactive version/i.test(msg)) {
        const typeHint = ['TABL', 'STRU', 'TABL/DT', 'TABL/DS'].includes(args.type?.toUpperCase())
          ? ' For DDIC objects with no pending changes, use abap_table to read field metadata instead.'
          : ' The object exists but has no inactive version — it may have never been edited.';
        this.fail(formatError(`abap_get_source(${args.name})`, error) + typeHint);
      }
      this.fail(formatError(`abap_get_source(${args.name})`, error));
    }
  }

  /**
   * Surgical method edit: find/replace scoped to a single method body,
   * syntax-check the reconstructed class, then write back.
   */
  private async handleEditMethod(args: any): Promise<any> {
    const { name, method, old_string, new_string, replace_all, transport } = args;
    const sourceUrl = buildSourceUrl(name, 'CLAS');
    const objectUrl = buildObjectUrl(name, 'CLAS');

    let source: string;
    try {
      source = await this.withSession(() =>
        this.adtclient.getObjectSource(sourceUrl)
      ) as string;
    } catch (error: any) {
      this.fail(formatError(`abap_edit_method(${name}) get source`, error));
    }

    // Find METHOD boundaries (case-insensitive)
    const methodEscaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/~/g, '[~]');
    const startRe = new RegExp(`^([ \\t]*)METHOD\\s+${methodEscaped}\\s*\\.`, 'im');
    let startMatch = startRe.exec(source!);
    if (!startMatch) {
      // Extract available method names from source
      const methodNames: string[] = [];
      const listRe = /^\s*METHOD\s+(\S+)\s*\./gim;
      let m: RegExpExecArray | null;
      while ((m = listRe.exec(source!)) !== null) {
        methodNames.push(m[1]);
      }
      const methodList = methodNames.slice(0, 30).join(', ') + (methodNames.length > 30 ? ` (+${methodNames.length - 30} more)` : '');

      // Try sampling first — ask Claude which method was meant without interrupting the user
      const sampledMethod = await this.askClaude(
        'You are helping resolve an ambiguous ABAP method name. Respond with ONLY the exact method name from the list, nothing else.',
        `The user requested METHOD "${method}" but it was not found in class ${name}.\nAvailable methods: ${methodList}\nWhich method did they most likely mean? Reply with only the method name.`,
        50
      );
      if (sampledMethod?.trim()) {
        const corrected = sampledMethod.trim().replace(/['"]/g, '');
        // Verify the sampled answer actually exists
        const verifyRe = new RegExp(`^\\s*METHOD\\s+${corrected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.`, 'im');
        if (verifyRe.test(source!)) {
          args.method = corrected;
          return this.handleEditMethod(args);
        }
      }

      // Sampling unavailable or returned a bad answer — fall back to eliciting from the user
      const input = await this.elicitForm(
        `abap_edit_method: METHOD "${method}" not found in ${name}. ` +
        `Available methods: ${methodList}. Please provide the correct method name.`,
        { method: { type: 'string', title: 'Method name', description: 'Correct method name from the list above' } },
        ['method']
      );
      if (!input?.method) {
        this.fail(`abap_edit_method: METHOD "${method}" not found in ${name}. Available: ${methodList}`);
      }
      args.method = input!.method;
      return this.handleEditMethod(args);
    }

    const methodStart = startMatch.index;
    // Find matching ENDMETHOD. after the METHOD line
    const afterStart = source!.indexOf('\n', methodStart);
    const endRe = /^\s*ENDMETHOD\s*\./im;
    const remaining = source!.slice(afterStart);
    const endMatch = endRe.exec(remaining);
    if (!endMatch) {
      this.fail(`abap_edit_method: Could not find ENDMETHOD for ${method} in ${name}.`);
    }

    const methodEnd = afterStart + endMatch!.index + endMatch![0].length;
    const methodBody = source!.slice(methodStart, methodEnd);

    // Find/replace within method body
    const occurrences = methodBody.split(old_string).length - 1;
    if (occurrences === 0) {
      // Show the method body so the model can see what's actually there
      const bodyLines = methodBody.split('\n');
      const preview = bodyLines.slice(0, 40).join('\n') + (bodyLines.length > 40 ? `\n... (${bodyLines.length - 40} more lines)` : '');
      const input = await this.elicitForm(
        `abap_edit_method: old_string not found in METHOD ${method}. ` +
        `The search is case-sensitive. Method body (first 40 lines):\n\n${preview}\n\nProvide the corrected old_string to search for.`,
        { old_string: { type: 'string', title: 'old_string', description: 'Exact string to find in the method body (case-sensitive)' } },
        ['old_string']
      );
      if (!input?.old_string) {
        this.fail(`abap_edit_method: old_string "${old_string}" not found within METHOD ${method}.`);
      }
      args.old_string = input!.old_string;
      return this.handleEditMethod(args);
    }
    if (occurrences > 1 && !replace_all) {
      const input = await this.elicitForm(
        `abap_edit_method: old_string appears ${occurrences} times in METHOD ${method}. Replace all occurrences?`,
        { replace_all: { type: 'boolean', title: 'Replace all', description: `Replace all ${occurrences} occurrences`, default: false } },
        ['replace_all']
      );
      if (input?.replace_all) {
        args.replace_all = true;
      } else {
        this.fail(`abap_edit_method: old_string appears ${occurrences} times in METHOD ${method}. Make old_string more specific or set replace_all=true.`);
      }
    }

    const newBody = replace_all
      ? methodBody.split(old_string).join(new_string)
      : methodBody.replace(old_string, new_string);

    const newSource = source!.slice(0, methodStart) + newBody + source!.slice(methodEnd);

    // Syntax check before writing
    const syntaxResult = await this.withSession(() =>
      this.adtclient.syntaxCheck(sourceUrl, sourceUrl, newSource)
    );
    const syntaxErrors = (syntaxResult as any[]).filter((r: any) => r.severity === 'E' || r.severity === 'A');
    if (syntaxErrors.length > 0) {
      const msgs = syntaxErrors.map((e: any) => `[${e.severity}] line ${e.line}: ${e.description}`).join('\n');
      this.fail(`abap_edit_method: Syntax errors in reconstructed source — change NOT written.\n${msgs}`);
    }

    // Write back — lock → write → unlock in one withSession so session recovery
    // re-acquires the lock atomically with the new session cookie.
    await this.notify(`Writing updated METHOD ${method} to ${name}…`);
    let lockHandle: string | null = null;
    try {
      await this.withSession(async () => {
        const r = await this.adtclient.lock(objectUrl);
        lockHandle = r.LOCK_HANDLE;
        try {
          // Transport guard: reject writes to non-$TMP objects without a transport
          args.transport = this.requireTransport(r, args.transport, name);
          await this.adtclient.setObjectSource(sourceUrl, newSource, lockHandle!, args.transport);
        } catch (err) {
          try { await this.adtclient.unLock(objectUrl, lockHandle!); } catch (_) {}
          lockHandle = null;
          throw err;
        }
        await this.adtclient.unLock(objectUrl, lockHandle!);
        lockHandle = null;
      });

      return this.success({
        message: `METHOD ${method} updated (${occurrences} replacement${occurrences > 1 ? 's' : ''}). Call abap_activate(${name}, CLAS) to activate.`,
        name,
        method,
        replacements: occurrences
      });
    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(objectUrl, lockHandle); } catch (_) {}
      }
      const errMsg = (error?.message || '').toLowerCase();
      if (!transport && (errMsg.includes('transport') || errMsg.includes('correction') || errMsg.includes('request'))) {
        const input = await this.elicitForm(
          `abap_edit_method(${name}): This object requires a transport. Which transport?`,
          { transport: { type: 'string', title: 'Transport', description: 'Transport request number (e.g. D25K900161)' } },
          ['transport']
        );
        if (input?.transport) {
          args.transport = input.transport;
          return this.handleEditMethod(args);
        }
      }
      this.fail(formatError(`abap_edit_method(${name})`, error));
    }
  }

  private async handleSetSource(args: any): Promise<any> {
    let objectUrl: string;
    let sourceUrl: string;

    if (NESTED_TYPES.has(args.type?.toUpperCase())) {
      try {
        const resolved = await this.resolveNestedUrl(args.name, args.type, args.fugr);
        objectUrl = resolved.objectUrl;
        sourceUrl = resolved.sourceUrl;
      } catch (error: any) {
        this.fail(formatError(`abap_set_source(${args.name}) resolve`, error));
      }
    } else {
      objectUrl = buildObjectUrl(args.name, args.type);
      sourceUrl = `${objectUrl}/source/main`;
    }

    let lockHandle: string | null = null;

    // Lock → write → unlock as a SINGLE withSession block.
    // This is critical: if a session timeout fires mid-sequence and withSession re-logins,
    // the entire block retries — so the new lock handle is acquired in the new session,
    // preventing "lock handle from dead session used in new session" rejections.
    //
    // The most common failure pattern is:
    //   lock() OK → setObjectSource() → HTTP 400 (stale CSRF / SM04 killed our session)
    //   → unLock() ALSO fails (same dead session) → lock persists on SAP's enqueue server
    //   → withSession re-logins → doWrite retries → lock() → "locked by another" (us!)
    //
    // Fix: when unLock fails after a dead-session 400, sleep briefly before rethrowing.
    // withSession will re-login during that sleep, and by the time doWrite runs again SAP's
    // session cleanup has released the orphaned enqueue entry.
    let unlockFailedAfterDeadSession = false;

    const doWrite = async (): Promise<void> => {
      unlockFailedAfterDeadSession = false;
      const r = await this.adtclient.lock(objectUrl!);
      lockHandle = r.LOCK_HANDLE;
      try {
        // Transport guard: reject writes to non-$TMP objects without a transport
        args.transport = this.requireTransport(r, args.transport, args.name);
        await this.adtclient.setObjectSource(sourceUrl!, args.source, lockHandle!, args.transport);
      } catch (writeErr: any) {
        let unlockOk = false;
        try {
          await this.adtclient.unLock(objectUrl!, lockHandle!);
          unlockOk = true;
        } catch (_) {}
        lockHandle = null;

        // If unLock failed AND the write error looks like a dead session (ambiguous 400),
        // SAP's enqueue server still holds our lock handle. Sleep so session cleanup can run
        // before withSession's immediate re-login retry calls lock() again.
        if (!unlockOk) {
          const writeInfo = parseAdtError(writeErr);
          if (writeInfo.isAmbiguous400 || writeInfo.isSessionTimeout) {
            unlockFailedAfterDeadSession = true;
            await new Promise(r => setTimeout(r, 3000));
          }
        }

        throw writeErr;
      }
      await this.adtclient.unLock(objectUrl!, lockHandle!);
      lockHandle = null;
    };

    // Lockless write for DDIC types: PUT with corrNr only, no lockHandle.
    // DDLS, DDLX, TABL, etc. use DDIC-internal enqueue locks and return 405 on ?_action=LOCK.
    const doLocklessWrite = async (): Promise<void> => {
      if (!args.transport) {
        throw new Error(
          `Transport required: ${args.name} is a DDIC object that does not support ADT HTTP locks. ` +
          `A transport request number is required to write this object.`
        );
      }
      // Resolve the TASK number — transport_create returns the request, but corrNr needs the task.
      // resolveTaskNumber walks userTransports to find the user's task on the given request.
      const taskNumber = await this.resolveTaskNumber(args.transport);
      const h = (this.adtclient as any).h;
      const ctype = args.source.match(/^<\?xml\s/i) ? 'application/*' : 'text/plain; charset=utf-8';
      await h.request(sourceUrl!, {
        body: args.source,
        method: 'PUT',
        headers: { 'content-type': ctype },
        qs: { corrNr: taskNumber }
      });
    };

    try {
      // Retry up to twice if locked by another session (stale locks clear within seconds).
      // Use abap_unlock to force-release if retries all fail.
      let lastError: any;
      for (let i = 0; i < 3; i++) {
        const delay = [0, 3000, 8000][i];
        if (delay > 0) {
          await this.notify(`Object locked — waiting ${delay / 1000}s before retry (attempt ${i + 1}/3)…`, 'warning');
          await new Promise(r => setTimeout(r, delay));
        }
        try {
          await this.withSession(doWrite);
          lastError = null;
          break;
        } catch (e: any) {
          lastError = e;
          const errInfo = parseAdtError(e);

          // Lock not supported (HTTP 405) — DDIC type, fall back to lockless write
          if (errInfo.isLockNotSupported) {
            await this.notify(`Lock not supported for ${args.type} — attempting lockless write with transport…`, 'warning');
            try {
              await this.withSession(doLocklessWrite);
              lastError = null;
            } catch (locklessErr: any) {
              lastError = locklessErr;
            }
            break;
          }

          // Only retry when the error is a lock contention ("already locked", "locked by user", etc.)
          // isLocked covers all SAP lock message variants; break on any other error type.
          if (!errInfo.isLocked) break;
        }
      }
      if (lastError) {
        if (lockHandle) {
          try { await this.adtclient.unLock(objectUrl!, lockHandle); } catch (_) {}
        }
        throw lastError;
      }

      return this.success({
        message: `Source written. Call abap_activate(${args.name}, ${args.type}) to activate.`,
        name: args.name,
        type: args.type
      });
    } catch (error: any) {
      // If the error is about a missing transport, elicit it from the user and retry
      const errMsg = (error?.message || '').toLowerCase();
      if (!args.transport && (errMsg.includes('transport') || errMsg.includes('correction') || errMsg.includes('request'))) {
        const input = await this.elicitForm(
          `abap_set_source(${args.name}): This object requires a transport. Which transport should the change be recorded on?`,
          {
            transport: {
              type: 'string',
              title: 'Transport',
              description: 'Transport request number (e.g. D25K900161)'
            }
          },
          ['transport']
        );
        if (input?.transport) {
          args.transport = input.transport;
          return this.handleSetSource(args); // retry with the transport
        }
      }
      this.fail(formatError(`abap_set_source(${args.name})`, error));
    }
  }

  private async handleSetClassInclude(args: any): Promise<any> {
    const { name, include_type, source, transport } = args;
    const encoded = name.replace(/\//g, '%2f').replace(/\$/g, '%24').toLowerCase();
    const objectUrl = `/sap/bc/adt/oo/classes/${encoded}`;
    const sourceUrl = `${objectUrl}/includes/${include_type}`;

    let lockHandle: string | null = null;

    const doWrite = async (): Promise<void> => {
      const r = await this.adtclient.lock(objectUrl);
      lockHandle = r.LOCK_HANDLE;
      try {
        // Transport guard: reject writes to non-$TMP objects without a transport
        args.transport = this.requireTransport(r, args.transport, name);
        await this.adtclient.setObjectSource(sourceUrl, source, lockHandle!, args.transport);
      } catch (err: any) {
        let unlockOk = false;
        try { await this.adtclient.unLock(objectUrl, lockHandle!); unlockOk = true; } catch (_) {}
        lockHandle = null;
        if (!unlockOk) {
          const writeInfo = parseAdtError(err);
          if (writeInfo.isAmbiguous400 || writeInfo.isSessionTimeout) {
            await new Promise(r => setTimeout(r, 3000));
          }
        }
        throw err;
      }
      await this.adtclient.unLock(objectUrl, lockHandle!);
      lockHandle = null;
    };

    try {
      let lastError: any;
      for (let i = 0; i < 3; i++) {
        const delay = [0, 3000, 8000][i];
        if (delay > 0) {
          await this.notify(`Object locked — waiting ${delay / 1000}s before retry (attempt ${i + 1}/3)…`, 'warning');
          await new Promise(r => setTimeout(r, delay));
        }
        try {
          await this.withSession(doWrite);
          lastError = null;
          break;
        } catch (e: any) {
          lastError = e;
          if (!parseAdtError(e).isLocked) break;
        }
      }
      if (lastError) throw lastError;

      return this.success({
        message: `${include_type} include written for ${name}. Call abap_activate(${name}, CLAS) to activate.`,
        name,
        include_type
      });
    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(objectUrl, lockHandle); } catch (_) {}
      }
      const errMsg = (error?.message || '').toLowerCase();
      if (!transport && (errMsg.includes('transport') || errMsg.includes('correction') || errMsg.includes('request'))) {
        const input = await this.elicitForm(
          `abap_set_class_include(${name}): This object requires a transport. Which transport?`,
          { transport: { type: 'string', title: 'Transport', description: 'Transport request number (e.g. D23K900123)' } },
          ['transport']
        );
        if (input?.transport) {
          args.transport = input.transport;
          return this.handleSetClassInclude(args);
        }
      }
      this.fail(formatError(`abap_set_class_include(${name}/${include_type})`, error));
    }
  }

  private async handleGetFunctionGroup(args: any): Promise<any> {
    if (!args.name) {
      this.fail('abap_get_function_group requires name (function group name, e.g. /DSN/010BWE or ZBILLING).');
    }
    const fgroupName = args.name.toUpperCase();
    const fgroupEncoded = fgroupName.replace(/\//g, '%2f').toLowerCase();
    const fgroupUrl = `/sap/bc/adt/functions/groups/${fgroupEncoded}`;
    const objectStructureUrl = `${fgroupUrl}/objectstructure`;
    const sources: Record<string, string> = {};
    const errors: Record<string, string> = {};

    try {
      // Fetch the /objectstructure endpoint for this function group.
      // This returns an XML tree of abapsource:objectStructureElement children, each with
      // an atom:link href pointing to the source URL for includes (FUGR/I) and FMs (FUGR/FF).
      // The FUGR base URL only returns top-level navigation links (versions, objectstructure link, etc.)
      // and does NOT contain the include/FM hrefs — those are only in /objectstructure.
      const h = (this.adtclient as any).h;
      const response = await this.withSession(async () =>
        h.request(objectStructureUrl, { headers: { Accept: '*/*' } })
      ) as any;

      const rawXml: string = response.body || '';

      // Parse atom:link hrefs from the objectStructureElement children.
      // Includes:  href matches /includes/...
      // FMs:       href matches /fmodules/.../source/main (no fragment)
      // Skip entries with a fragment (#type=...) — those are sub-symbols within an include, not the include itself.
      const seen = new Set<string>();
      const links: Array<{ name: string; sourceUrl: string }> = [];

      // Match all href values in atom:link elements
      const hrefRegex = /href="([^"#]+\/(?:includes|fmodules)\/[^"#]+\/source\/main)"/g;
      let m: RegExpExecArray | null;
      while ((m = hrefRegex.exec(rawXml)) !== null) {
        const href = m[1];
        if (seen.has(href)) continue;
        seen.add(href);
        // Derive a readable name from the URL (last path segment before /source/main)
        const nameMatch = href.match(/\/(?:includes|fmodules)\/([^/]+)\/source\/main$/);
        const name = nameMatch
          ? decodeURIComponent(nameMatch[1]).toUpperCase()
          : href;
        // Make sure href is absolute
        const sourceUrl = href.startsWith('/') ? href : `/${href}`;
        links.push({ name, sourceUrl });
      }

      // Fetch source for each include and FM in parallel
      await Promise.all(links.map(async ({ name, sourceUrl }) => {
        try {
          const src = await this.withSession(() =>
            this.adtclient.getObjectSource(sourceUrl)
          );
          sources[name] = src as string;
        } catch (e: any) {
          errors[name] = e.message || 'Unknown error';
        }
      }));

      return this.success({
        functionGroup: fgroupName,
        includeCount: Object.keys(sources).length,
        sources,
        errors: Object.keys(errors).length > 0 ? errors : undefined
      });
    } catch (error: any) {
      this.fail(formatError(`abap_get_function_group(${args.name})`, error));
    }
  }
}

/**
 * Strip all METHOD...ENDMETHOD bodies from ABAP class source,
 * leaving only method signatures (empty stubs) and the CLASS DEFINITION block.
 * Used by abap_get_source(compact=true) to reduce large classes to their interface.
 */
function stripMethodBodies(source: string): string {
  const lines = source.split('\n');
  const result: string[] = [];
  let depth = 0; // nesting depth inside METHOD blocks

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();

    if (depth === 0) {
      // Check for METHOD start (but not ENDMETHOD, CLASS-METHODS, METHODS declarations)
      if (/^METHOD\s+\S/.test(trimmed)) {
        result.push(line); // keep the METHOD line itself
        depth = 1;
        continue;
      }
      result.push(line);
    } else {
      // Inside a method body — skip lines, track nested METHOD (rare but possible via macro expansion)
      if (/^METHOD\s+\S/.test(trimmed)) {
        depth++;
      } else if (/^ENDMETHOD\s*\./.test(trimmed)) {
        depth--;
        if (depth === 0) {
          result.push(line); // keep the ENDMETHOD line
        }
      }
      // All other lines inside the body are dropped
    }
  }

  return result.join('\n');
}
