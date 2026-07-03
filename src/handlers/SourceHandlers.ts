import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildClassIncludeUrl, buildObjectUrl, buildSourceUrl, getSupportedTypes, NESTED_TYPES } from '../lib/urlBuilder.js';
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
          'PREFER abap_edit_method when changing one method of an existing class — it edits surgically ' +
          'without regenerating (and risking clobbering) the rest of the source. ' +
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
          'runs a syntax check on the reconstructed source, and writes it back. ' +
          'Searches the main class source first, then the implementations (CCIMP) and testclasses (CCAU) includes — ' +
          'so RAP behavior pool (BP_*) handler methods and local test methods are found automatically. ' +
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
        name: 'abap_get_class_include',
        annotations: { readOnlyHint: true },
        description:
          'Read source from a specific include of an ABAP class (implementations, definitions, macros, testclasses). ' +
          'Use this for class-local implementation includes such as CCIMP behavior handler bodies, which are not standalone PROG/I includes.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Class name, e.g. /DSN/BP_S4FD_PD_I_ITM_MAP_HDR'
            },
            include_type: {
              type: 'string',
              description:
                'Which class include to read. Values: ' +
                '"implementations" = CCIMP (local classes, behavior handler bodies), ' +
                '"definitions" = CCDEF (local type/class definitions), ' +
                '"macros" = CCMAC, ' +
                '"testclasses" = CCAU (ABAP Unit tests).',
              enum: ['implementations', 'definitions', 'macros', 'testclasses']
            }
          },
          required: ['name', 'include_type']
        }
      },
      {
        name: 'abap_pretty_print',
        annotations: { readOnlyHint: true },
        description:
          'Format ABAP source code using the SAP Pretty Printer. ' +
          'Returns the formatted source. Does not write back to the system — pass the result to abap_set_source if needed.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'ABAP source code to format' }
          },
          required: ['source']
        }
      },
      {
        name: 'abap_revisions',
        annotations: { readOnlyHint: true },
        description:
          'Get the revision history for an ABAP object (transport-based change log). ' +
          'Returns revisions with date, author, transport number (version), and version title. ' +
          'For classes, optionally specify a class include to see its revision history separately.',
        inputSchema: {
          type: 'object',
          properties: {
            name:    { type: 'string', description: 'Object name, e.g. /DSN/CL_MY_CLASS or ZMY_PROGRAM' },
            type:    { type: 'string', description: 'Object type, e.g. CLAS, PROG/P, FUGR/I, DDLS/DF' },
            include: {
              type: 'string',
              description: 'For CLAS only: which include to inspect. Values: definitions, implementations, macros, testclasses, main.',
              enum: ['definitions', 'implementations', 'macros', 'testclasses', 'main']
            }
          },
          required: ['name', 'type']
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
      case 'abap_get_class_include':    return this.handleGetClassInclude(args);
      case 'abap_edit_method':          return this.handleEditMethod(args);
      case 'abap_pretty_print':         return this.handlePrettyPrint(args);
      case 'abap_revisions':            return this.handleRevisions(args);
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

  private async handleGetClassInclude(args: any): Promise<any> {
    const { name, include_type } = args;
    const sourceUrl = buildClassIncludeUrl(name, include_type);

    try {
      const source = await this.withSession(() =>
        this.adtclient.getObjectSource(sourceUrl)
      ) as string;

      return this.success({ source, name, include_type });
    } catch (error: any) {
      this.fail(formatError(`abap_get_class_include(${name}/${include_type})`, error));
    }
  }

  /**
   * Surgical method edit: find/replace scoped to a single method body,
   * syntax-check the reconstructed source, then write back.
   *
   * Methods are searched in the class main source first, then in the class includes:
   * implementations (CCIMP) and testclasses (CCAU). RAP behavior pool (BP_*) handler
   * methods live in CCIMP — their main source is an empty class shell, which is why a
   * main-only search used to report "not found. Available: (empty)" for them.
   */
  private async handleEditMethod(args: any): Promise<any> {
    const { name, method, old_string, new_string, replace_all, transport } = args;
    const objectUrl = buildObjectUrl(name, 'CLAS');

    // Main source must be readable — that error is a real failure (bad name, auth, …).
    // Includes are best-effort: absent/empty includes read as ''.
    const containers: Array<{ key: string; sourceUrl: string; source: string }> = [];
    try {
      const mainSource = await this.withSession(() =>
        this.adtclient.getObjectSource(buildSourceUrl(name, 'CLAS'))
      ) as string;
      containers.push({ key: 'main', sourceUrl: buildSourceUrl(name, 'CLAS'), source: mainSource });
    } catch (error: any) {
      this.fail(formatError(`abap_edit_method(${name}) get source`, error));
    }

    let located: { container: { key: string; sourceUrl: string; source: string }; start: number; end: number } | null = null;
    const mainHit = locateMethod(containers[0].source, method);
    if (mainHit) {
      located = { container: containers[0], ...mainHit };
    } else {
      for (const includeType of ['implementations', 'testclasses']) {
        const sourceUrl = buildClassIncludeUrl(name, includeType);
        let src = '';
        try {
          src = await this.withSession(() => this.adtclient.getObjectSource(sourceUrl)) as string;
        } catch (_) { /* include doesn't exist on this class */ }
        const container = { key: includeType, sourceUrl, source: src };
        containers.push(container);
        if (!located && src) {
          const hit = locateMethod(src, method);
          if (hit) located = { container, ...hit };
        }
      }
    }

    if (!located) {
      // Aggregate available method names across main + includes so the caller can self-correct
      const methodNames: string[] = [];
      for (const c of containers) {
        const listRe = /^\s*METHOD\s+(\S+)\s*\./gim;
        let m: RegExpExecArray | null;
        while ((m = listRe.exec(c.source)) !== null) {
          methodNames.push(c.key === 'main' ? m[1] : `${m[1]} (in ${c.key} include)`);
        }
      }
      const methodList = methodNames.slice(0, 30).join(', ') + (methodNames.length > 30 ? ` (+${methodNames.length - 30} more)` : '');

      // Try sampling first — ask Claude which method was meant without interrupting the user
      const sampledMethod = await this.askClaude(
        'You are helping resolve an ambiguous ABAP method name. Respond with ONLY the exact method name from the list, nothing else.',
        `The user requested METHOD "${method}" but it was not found in class ${name}.\nAvailable methods: ${methodList}\nWhich method did they most likely mean? Reply with only the method name.`,
        50
      );
      if (sampledMethod?.trim()) {
        // Strip quotes and any "(in xxx include)" location suffix the model may echo back
        const corrected = sampledMethod.trim().replace(/['"]/g, '').replace(/\s*\(in \w+ include\)\s*$/i, '');
        // Verify the sampled answer actually exists in one of the loaded containers
        if (containers.some(c => locateMethod(c.source, corrected))) {
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

    if (located.end < 0) {
      this.fail(`abap_edit_method: Could not find ENDMETHOD for ${method} in ${name}.`);
    }

    const { container, start: methodStart, end: methodEnd } = located;
    const source = container.source;
    const where = container.key === 'main' ? '' : ` (in ${container.key} include)`;
    const methodBody = source.slice(methodStart, methodEnd);

    // Find/replace within method body
    const occurrences = methodBody.split(old_string).length - 1;
    if (occurrences === 0) {
      // The most common cause of this is targeting the wrong method: the string exists in the
      // class, just in a different method. Scan every method and report where it actually lives,
      // so the caller corrects the target instead of assuming the tool is flaky and falling back
      // to a full-class rewrite (which is how a real incident clobbered an adjacent method).
      const otherMethods = containers.flatMap(c =>
        findMethodsContaining(c.source, old_string, method)
          .map(n => c.key === 'main' ? n : `${n} (in ${c.key} include)`));
      const locationHint = otherMethods.length > 0
        ? ` NOTE: that exact string IS present in METHOD ${otherMethods.join(', ')} — did you mean to edit ${otherMethods.length === 1 ? `METHOD ${otherMethods[0]}` : 'one of those'}? Re-run with the correct method.`
        : '';

      // Show the method body so the model can see what's actually there
      const bodyLines = methodBody.split('\n');
      const preview = bodyLines.slice(0, 40).join('\n') + (bodyLines.length > 40 ? `\n... (${bodyLines.length - 40} more lines)` : '');
      const input = await this.elicitForm(
        `abap_edit_method: old_string not found in METHOD ${method}.${locationHint} ` +
        `The search is case-sensitive. Method body (first 40 lines):\n\n${preview}\n\nProvide the corrected old_string to search for.`,
        { old_string: { type: 'string', title: 'old_string', description: 'Exact string to find in the method body (case-sensitive)' } },
        ['old_string']
      );
      if (!input?.old_string) {
        this.fail(`abap_edit_method: old_string "${old_string}" not found within METHOD ${method}.${locationHint}`);
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

    const newSource = source.slice(0, methodStart) + newBody + source.slice(methodEnd);

    // Syntax check before writing — against the container we're editing (main or include)
    const syntaxResult = await this.withSession(() =>
      this.adtclient.syntaxCheck(container.sourceUrl, container.sourceUrl, newSource)
    );
    const syntaxErrors = (syntaxResult as any[]).filter((r: any) => r.severity === 'E' || r.severity === 'A');
    if (syntaxErrors.length > 0) {
      const msgs = syntaxErrors.map((e: any) => `[${e.severity}] line ${e.line}: ${e.description}`).join('\n');
      this.fail(`abap_edit_method: Syntax errors in reconstructed source — change NOT written.\n${msgs}`);
    }

    // Write back — lock → write → unlock in one withSession so session recovery
    // re-acquires the lock atomically with the new session cookie.
    await this.notify(`Writing updated METHOD ${method} to ${name}${where}…`);
    let lockHandle: string | null = null;
    try {
      await this.withSession(async () => {
        const r = await this.adtclient.lock(objectUrl);
        lockHandle = r.LOCK_HANDLE;
        try {
          // Transport guard: reject writes to non-$TMP objects without a transport
          args.transport = this.requireTransport(r, args.transport, name);
          await this.adtclient.setObjectSource(container.sourceUrl, newSource, lockHandle!, args.transport);
        } catch (err) {
          try { await this.adtclient.unLock(objectUrl, lockHandle!); } catch (_) {}
          lockHandle = null;
          throw err;
        }
        await this.adtclient.unLock(objectUrl, lockHandle!);
        lockHandle = null;
      });

      return this.success({
        message: `METHOD ${method} updated${where} (${occurrences} replacement${occurrences > 1 ? 's' : ''}). Call abap_activate(${name}, CLAS) to activate.`,
        name,
        method,
        include: container.key === 'main' ? undefined : container.key,
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
    const objectUrl = buildObjectUrl(name, 'CLAS');
    const sourceUrl = buildClassIncludeUrl(name, include_type);

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

  private async handlePrettyPrint(args: any): Promise<any> {
    try {
      const formatted = await this.withSession(() =>
        this.adtclient.prettyPrinter(args.source)
      ) as string;
      return this.success({ source: formatted });
    } catch (error: any) {
      this.fail(formatError('abap_pretty_print', error));
    }
  }

  private async handleRevisions(args: any): Promise<any> {
    const objectUrl = buildObjectUrl(args.name, args.type);
    try {
      const revisions = await this.withSession(() =>
        this.adtclient.revisions(objectUrl, args.include)
      );
      return this.success({ name: args.name, type: args.type, revisions });
    } catch (error: any) {
      this.fail(formatError(`abap_revisions(${args.name})`, error));
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
 * Locate the METHOD…ENDMETHOD block for `method` (case-insensitive) in `source`.
 * Returns null when the METHOD statement isn't present; end = -1 when the METHOD
 * statement exists but no ENDMETHOD follows (malformed source).
 */
function locateMethod(source: string, method: string): { start: number; end: number } | null {
  const methodEscaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/~/g, '[~]');
  const startRe = new RegExp(`^([ \\t]*)METHOD\\s+${methodEscaped}\\s*\\.`, 'im');
  const startMatch = startRe.exec(source);
  if (!startMatch) return null;
  const start = startMatch.index;
  const afterStart = source.indexOf('\n', start);
  if (afterStart < 0) return { start, end: -1 };
  const endMatch = /^\s*ENDMETHOD\s*\./im.exec(source.slice(afterStart));
  if (!endMatch) return { start, end: -1 };
  return { start, end: afterStart + endMatch.index + endMatch[0].length };
}

/**
 * Scan every METHOD...ENDMETHOD block in a class and return the names of methods (other than
 * `excludeMethod`) whose body contains `needle`. Used by abap_edit_method to tell the caller
 * "your string is in method X, not the one you targeted" instead of a bare "not found".
 */
function findMethodsContaining(source: string, needle: string, excludeMethod: string): string[] {
  if (!needle) return [];
  const exclude = excludeMethod.toUpperCase();
  const startRe = /^\s*METHOD\s+(\S+)\s*\./gim;
  const starts: Array<{ name: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(source)) !== null) {
    starts.push({ name: m[1].replace(/\.$/, ''), index: m.index });
  }
  const hits: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const bodyStart = starts[i].index;
    const rest = source.slice(bodyStart);
    const endMatch = /^\s*ENDMETHOD\s*\./im.exec(rest);
    const bodyEnd = endMatch
      ? bodyStart + endMatch.index + endMatch[0].length
      : (starts[i + 1]?.index ?? source.length);
    const body = source.slice(bodyStart, bodyEnd);
    if (starts[i].name.toUpperCase() !== exclude && body.includes(needle)) {
      hits.push(starts[i].name);
    }
  }
  return hits;
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
