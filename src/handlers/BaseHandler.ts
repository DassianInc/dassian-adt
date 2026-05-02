import type { ToolDefinition } from '../types/tools';
import { ADTClient, session_types } from 'abap-adt-api';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { performance } from 'perf_hooks';
import { createLogger } from '../lib/logger';
import { parseAdtError } from '../lib/errors';
import { NESTED_TYPES, encodeAbapName, buildFunctionModuleUrl } from '../lib/urlBuilder';

/** Function signature matching Server.elicitInput — injected from AbapAdtServer. */
export type ElicitFn = (params: any) => Promise<{ action: string; content?: Record<string, any> }>;

/** Send a progress/status message visible in the Claude Code UI. */
export type NotifyFn = (level: 'info' | 'warning' | 'error', message: string) => Promise<void>;

/** Ask Claude to make a decision without interrupting the human. Returns Claude's text response. */
export type SamplingFn = (systemPrompt: string, userMessage: string, maxTokens?: number) => Promise<string>;

export abstract class BaseHandler {
  protected readonly adtclient: ADTClient;
  protected readonly logger = createLogger(this.constructor.name);
  private _elicit?: ElicitFn;
  private _notify?: NotifyFn;
  private _sampling?: SamplingFn;

  constructor(adtclient: ADTClient) {
    this.adtclient = adtclient;
  }

  /** Inject the server's elicitInput function after construction. */
  setElicit(fn: ElicitFn): void {
    this._elicit = fn;
  }

  /** Inject a progress notification function (sendLoggingMessage wrapper). */
  setNotify(fn: NotifyFn): void {
    this._notify = fn;
  }

  /** Inject a sampling function (server.createMessage wrapper). */
  setSampling(fn: SamplingFn): void {
    this._sampling = fn;
  }

  /**
   * Send a progress/status message visible in Claude Code's UI during long operations.
   * No-ops silently if logging capability is not available.
   */
  protected async notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
    if (this._notify) {
      try { await this._notify(level, message); } catch (_) {}
    }
  }

  /**
   * Ask Claude to make a simple decision without interrupting the user.
   * Falls back to returning null if sampling is not available — callers must handle null.
   */
  protected async askClaude(systemPrompt: string, userMessage: string, maxTokens = 200): Promise<string | null> {
    if (!this._sampling) return null;
    try {
      return await this._sampling(systemPrompt, userMessage, maxTokens);
    } catch (_) {
      return null;
    }
  }

  /**
   * Request confirmation from the user via MCP elicitation.
   * Falls back to proceeding without confirmation if elicitation is not available.
   */
  protected async confirmWithUser(message: string, details?: Record<string, string>): Promise<boolean> {
    if (!this._elicit) return true;
    try {
      const properties: Record<string, any> = {
        confirm: { type: 'boolean', title: 'Confirm', description: message, default: false }
      };
      if (details) {
        for (const [key, value] of Object.entries(details)) {
          properties[key] = { type: 'string', title: key, description: value, default: value };
        }
      }
      const result = await this._elicit({
        message,
        requestedSchema: { type: 'object' as const, properties, required: ['confirm'] }
      });
      if (result.action !== 'accept') return false;
      return result.content?.confirm === true;
    } catch (e: any) {
      console.error(`[ELICIT] confirmWithUser failed: ${e.message}`, e.code || '', e.stack?.split('\n')[1] || '');
      return true;
    }
  }

  /**
   * Request structured input from the user via MCP elicitation.
   * Returns the user's input or null if they declined/cancelled/elicitation unavailable.
   * Use for: missing parameters, disambiguation, choices.
   */
  protected async elicitForm(
    message: string,
    properties: Record<string, any>,
    required?: string[]
  ): Promise<Record<string, any> | null> {
    if (!this._elicit) {
      console.error('[ELICIT] no elicit function injected');
      return null;
    }
    try {
      const params = {
        message,
        requestedSchema: {
          type: 'object' as const,
          properties,
          ...(required ? { required } : {})
        }
      };
      console.error(`[ELICIT] sending: ${message}`);
      const result = await this._elicit(params);
      console.error(`[ELICIT] response: action=${result.action}, content=${JSON.stringify(result.content)}`);
      if (result.action === 'accept' && result.content) {
        return result.content;
      }
      return null;
    } catch (e: any) {
      console.error(`[ELICIT] elicitForm THREW: ${e.message}`, e.code || '');
      return null;
    }
  }

  /**
   * Ask the user to pick from a list of options.
   * Returns the selected value or null if declined/cancelled/unavailable.
   */
  protected async elicitChoice(
    message: string,
    fieldName: string,
    options: string[],
    defaultValue?: string
  ): Promise<string | null> {
    const result = await this.elicitForm(message, {
      [fieldName]: {
        type: 'string',
        title: fieldName,
        enum: options,
        ...(defaultValue ? { default: defaultValue } : {})
      }
    }, [fieldName]);
    return result?.[fieldName] as string ?? null;
  }

  /**
   * Check lock response and enforce transport requirement for non-$TMP objects.
   * Call immediately after lock() inside write/delete handlers.
   *
   * - IS_LOCAL === 'X' → object is in $TMP, no transport needed
   * - CORRNR set → SAP auto-assigned a transport, use it
   * - Otherwise → throw so the handler's existing transport-elicit catch block fires
   *
   * Returns the effective transport to pass to setObjectSource / corrNr.
   */
  protected requireTransport(
    lockResult: { CORRNR: string; IS_LOCAL: string },
    transport: string | undefined,
    objectName: string
  ): string | undefined {
    // $TMP objects never need a transport
    if (lockResult.IS_LOCAL === 'X') return transport;
    // CORRNR from the lock response is authoritative — it is the TASK number SAP assigned.
    // Always prefer it over the caller-provided value, which may be the parent REQUEST number.
    // Using the request number as corrNr captures nothing on the transport.
    if (lockResult.CORRNR) return lockResult.CORRNR;
    // Caller provided a transport and SAP didn't auto-assign one (shouldn't happen for non-$TMP)
    if (transport) return transport;
    // No transport available — reject the operation
    throw new Error(
      `Transport required: ${objectName} is in a transportable package (not $TMP). ` +
      `Provide a transport request number to record this change.`
    );
  }

  /**
   * Resolve the user's transport TASK number from a REQUEST number.
   * transport_create returns the request; setObjectSource needs the task (CORRNR).
   * Walks userTransports to find the task belonging to the current user on that request.
   * Falls back to the original number if no task found (so the caller can surface the error).
   */
  protected async resolveTaskNumber(requestNumber: string): Promise<string> {
    // Primary: query E070 directly for child tasks (WHERE STRKORR = request).
    // This is more reliable than userTransports which may not return task details
    // for requests owned by other users or in certain transport states.
    try {
      const e070 = await this.withSession(() =>
        this.adtclient.tableContents('E070', 10, false,
          `SELECT TRKORR FROM E070 WHERE STRKORR = '${requestNumber.toUpperCase()}'`)
      ) as any;
      const rows: any[] = e070?.values || e070?.records || e070?.value || [];
      if (rows.length > 0) {
        const taskNum: string = rows[0].TRKORR || rows[0].trkorr || '';
        if (taskNum) return taskNum;
      }
    } catch (_) {}

    // Fallback: walk userTransports tree (may be incomplete for some request states).
    try {
      const user = (this.adtclient as any).username || (this.adtclient as any).h?.username;
      if (user) {
        const transports = await this.withSession(() => this.adtclient.userTransports(user)) as any;
        const allRequests = (transports?.workbench ?? []).flatMap((t: any) =>
          [...(t.modifiable ?? []), ...(t.released ?? [])]
        );
        for (const req of allRequests) {
          const reqNum: string = req['tm:number'] || req.number || '';
          if (reqNum.toUpperCase() === requestNumber.toUpperCase()) {
            const task = req.tasks?.[0];
            const taskNum: string = task?.['tm:number'] || task?.number || '';
            if (taskNum) return taskNum;
          }
        }
      }
    } catch (_) {}

    return requestNumber; // unchanged if both resolution methods fail
  }

  /**
   * Execute an ADT operation with automatic re-login on session timeout.
   * Every handler should wrap client calls in this — it makes session errors invisible to users.
   */
  protected async withSession<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      const info = parseAdtError(error);
      if (info.isSessionTimeout) {
        this.logger.info('Session expired — clearing state and re-logging in');
        await this.notify('SAP session expired — reconnecting…');
        try {
          // Drop stale session state before re-login to avoid cookie conflicts
          try { await this.adtclient.dropSession(); } catch (_) {}
          this.adtclient.stateful = session_types.stateful;
          await this.adtclient.login();
          return await fn();
        } catch (loginError: any) {
          // One more attempt after a short pause (handles transient network blips)
          await new Promise(r => setTimeout(r, 1500));
          try {
            await this.adtclient.login();
            return await fn();
          } catch (finalError: any) {
            throw new McpError(
              ErrorCode.InternalError,
              `Session expired and re-login failed: ${finalError.message || 'Unknown error'}`
            );
          }
        }
      }
      throw error;
    }
  }

  protected success(data: Record<string, any>) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'success', ...data }, null, 2)
      }]
    };
  }

  protected fail(message: string): never {
    throw new McpError(ErrorCode.InternalError, message);
  }

  /**
   * Resolve the ADT object and source URLs for nested types (FUGR/I, FUGR/FF).
   * FUGR/I: searchObject with typed query returns the include's nested URL directly.
   * FUGR/FF: see resolveFunctionModuleUrl — requires special handling.
   */
  protected async resolveNestedUrl(name: string, type: string, fugr?: string): Promise<{ objectUrl: string; sourceUrl: string }> {
    if (type.toUpperCase() === 'FUGR/FF') {
      return this.resolveFunctionModuleUrl(name, fugr);
    }

    const results = await this.withSession(() =>
      this.adtclient.searchObject(name.toUpperCase(), type.toUpperCase(), 5)
    ) as any[];

    if (!results || results.length === 0) {
      throw new Error(`Could not find ${type} object named ${name}. Verify the name and that it exists on this system.`);
    }

    const match = results.find((r: any) =>
      (r.name || r['adtcore:name'] || '').toUpperCase() === name.toUpperCase()
    ) || results[0];

    const objectUrl: string = match.url || match['adtcore:uri'] || match.uri;
    if (!objectUrl) {
      throw new Error(`Search found ${name} but returned no URL. Result: ${JSON.stringify(match)}`);
    }

    return { objectUrl, sourceUrl: `${objectUrl}/source/main` };
  }

  /**
   * Resolve the ADT URL for a function module.
   * ADT endpoint: /functions/groups/{fugr}/fmodules/{fm}/source/main
   *
   * If fugr is provided, construct directly.
   * Otherwise, do a broad search (no type filter) and look for a result whose URL
   * contains /functions/groups/ so we can extract the parent FUGR.
   */
  protected async resolveFunctionModuleUrl(fmName: string, fugr?: string): Promise<{ objectUrl: string; sourceUrl: string }> {
    if (fugr) {
      const objectUrl = buildFunctionModuleUrl(fugr, fmName);
      return { objectUrl, sourceUrl: `${objectUrl}/source/main` };
    }

    const results = await this.withSession(() =>
      this.adtclient.searchObject(fmName.toUpperCase(), '', 10)
    ) as any[];

    if (results && results.length > 0) {
      for (const r of results) {
        const url: string = r.url || r['adtcore:uri'] || r.uri || '';
        if ((r.name || r['adtcore:name'] || '').toUpperCase() === fmName.toUpperCase() && url.includes('/fmodules/')) {
          return { objectUrl: url, sourceUrl: `${url}/source/main` };
        }
      }
      for (const r of results) {
        const url: string = r.url || r['adtcore:uri'] || r.uri || '';
        const fugrMatch = url.match(/\/functions\/groups\/([^/]+)/);
        if (fugrMatch) {
          const objectUrl = `/sap/bc/adt/functions/groups/${fugrMatch[1]}/fmodules/${encodeAbapName(fmName)}`;
          return { objectUrl, sourceUrl: `${objectUrl}/source/main` };
        }
      }
    }

    throw new Error(
      `FUGR/FF: could not auto-discover parent function group for "${fmName}". ` +
      `Provide the fugr parameter explicitly (e.g. fugr="/DSN/010BWE" for FM /DSN/010BWE_SC).`
    );
  }

  /**
   * Classify a transport task as Correction (TRFUNCTION=S).
   * Unclassified tasks (X) silently discard all E071 assignments — this fixes that.
   * Call after any lock() that returns a CORRNR to prevent orphaned Unclassified tasks.
   */
  protected async classifyTask(taskNumber: string): Promise<void> {
    const h = (this.adtclient as any).h;
    await this.withSession(() =>
      h.request(`/sap/bc/adt/cts/transportrequests/${taskNumber}`, {
        method: 'PUT',
        headers: { Accept: 'application/*' },
        body: `<?xml version="1.0" encoding="ASCII"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${taskNumber}" tm:useraction="classify" tm:trfunction="S"/>`
      })
    );
  }

  /** Build the ABAP source for a temporary IF_OO_ADT_CLASSRUN class. */
  protected buildClassSource(className: string, methodBody: string, methodName: string): string {
    const indented = (methodBody || '').split('\n').map(line => `    ${line}`).join('\n');
    return `CLASS ${className} DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS ${className} IMPLEMENTATION.

  METHOD if_oo_adt_classrun~${methodName}.
${indented}
  ENDMETHOD.

ENDCLASS.`;
  }

  /**
   * Create a temporary ABAP classrun, execute methodBody, delete the class, return the output.
   * Shared by any handler that needs to run arbitrary ABAP without exposing abap_run to the LLM.
   * Does NOT paginate — callers are responsible for keeping output manageable.
   */
  protected async runClassrun(methodBody: string, className = 'ZCL_TMP_ADT_RUN'): Promise<string> {
    const upperName = className.toUpperCase();
    const classUrl  = `/sap/bc/adt/oo/classes/${upperName.toLowerCase()}`;
    const sourceUrl = `${classUrl}/source/main`;
    let classCreated = false;
    let lockHandle: string | null = null;

    this.adtclient.stateful = session_types.stateful;
    await this.adtclient.login();

    let methodName = 'run';
    try {
      const ifSource = await this.adtclient.getObjectSource(
        '/sap/bc/adt/oo/interfaces/if_oo_adt_classrun/source/main'
      ) as string;
      methodName = ifSource.toLowerCase().includes('main') ? 'main' : 'run';
    } catch (_) {}

    try {
      const tryCreate = async (): Promise<boolean> => {
        try {
          await this.adtclient.createObject(
            'CLAS/OC', upperName, '$TMP', 'Temporary runner',
            '/sap/bc/adt/packages/%24tmp'
          );
          return true;
        } catch (e: any) {
          const m = (e?.message || '').toLowerCase();
          if (m.includes('already exist') || m.includes('exists already')) return false;
          throw e;
        }
      };

      if (!await tryCreate()) {
        try {
          const dl = await this.adtclient.lock(classUrl);
          if (dl.CORRNR) { try { await this.classifyTask(dl.CORRNR); } catch (_) {} }
          await this.adtclient.deleteObject(classUrl, dl.LOCK_HANDLE);
        } catch (_) {}
        if (!await tryCreate()) {
          throw new Error(`${upperName} already exists and could not be cleaned up — pass a different className.`);
        }
      }
      classCreated = true;

      const lr = await this.adtclient.lock(classUrl);
      lockHandle = lr.LOCK_HANDLE;
      if (lr.CORRNR) { try { await this.classifyTask(lr.CORRNR); } catch (_) {} }
      await this.adtclient.setObjectSource(sourceUrl, this.buildClassSource(upperName, methodBody, methodName), lockHandle);
      await this.adtclient.unLock(classUrl, lockHandle);
      lockHandle = null;

      const activation = await this.adtclient.activate(upperName, classUrl);
      if (activation?.success !== true) {
        const msgs = (activation?.messages || []).map((m: any) => m.shortText || m.objDescr).filter(Boolean).join('; ');
        throw new Error(`Activation failed: ${msgs || JSON.stringify(activation)}`);
      }

      await this.adtclient.logout();
      this.adtclient.stateful = session_types.stateless;
      await this.adtclient.login();

      const h = (this.adtclient as any).h;
      const response = await h.request(
        `/sap/bc/adt/oo/classrun/${upperName}`,
        { method: 'POST', headers: { Accept: 'text/plain' } }
      );
      const output = String(response.body ?? response.data ?? '');
      if (output.startsWith('Error:') || output.startsWith('Exception:')) {
        throw new Error(`classrun returned error: ${output}`);
      }
      return output;

    } finally {
      if (lockHandle) { try { await this.adtclient.unLock(classUrl, lockHandle); } catch (_) {} }
      if (classCreated) {
        try {
          this.adtclient.stateful = session_types.stateful;
          await this.adtclient.login();
          const dl = await this.adtclient.lock(classUrl);
          if (dl.CORRNR) { try { await this.classifyTask(dl.CORRNR); } catch (_) {} }
          await this.adtclient.deleteObject(classUrl, dl.LOCK_HANDLE);
        } catch (_) {}
      }
    }
  }

  /**
   * Validate required parameters from the tool schema, then dispatch to the handler.
   * This prevents "Cannot read properties of undefined" crashes by checking required
   * fields BEFORE any handler logic runs — one guard for all 25 tools.
   */
  async validateAndHandle(toolName: string, args: any): Promise<any> {
    const tool = this.getTools().find(t => t.name === toolName);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }

    // Normalize common LLM parameter-name mistakes before required-field validation
    if (args && !args.name && args.object_name) args.name = args.object_name;
    if (args && !args.type && args.object_type) args.type = args.object_type;

    const required = (tool.inputSchema as any).required || [];
    const missing = required.filter((f: string) => {
      const val = args?.[f];
      return val === undefined || val === null || val === '';
    });

    if (missing.length > 0) {
      this.fail(`${toolName}: missing required parameter(s): ${missing.join(', ')}`);
    }

    return this.handle(toolName, args);
  }

  abstract getTools(): ToolDefinition[];
  abstract handle(toolName: string, args: any): Promise<any>;
}
