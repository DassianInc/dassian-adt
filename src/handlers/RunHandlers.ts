import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import { session_types } from 'abap-adt-api';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';
import { randomUUID } from 'crypto';

// ── Output pagination store ───────────────────────────────────────────────────
// Stores large abap_run outputs split into PAGE_SIZE chunks, keyed by run_id.
// Entries expire after PAGE_TTL_MS so memory doesn't grow unbounded.
const PAGE_SIZE    = 60_000;   // chars per page
const PAGE_TTL_MS  = 30 * 60 * 1000; // 30 minutes

interface PagedRun { pages: string[]; created: number; className: string }
const pagedRuns = new Map<string, PagedRun>();

function evictExpiredRuns(): void {
  const now = Date.now();
  for (const [id, run] of pagedRuns) {
    if (now - run.created > PAGE_TTL_MS) pagedRuns.delete(id);
  }
}

export class RunHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_unlock',
        description:
          'Release the ABAP enqueue lock (SM12) for an object. Use when abap_set_source or ' +
          'abap_edit_method fails because a previous MCP operation crashed before unlocking. ' +
          'Calls the appropriate DEQUEUE FM. Only affects locks held by the current SAP user. ' +
          'LIMITATION: clears the enqueue lock (SM12) only — NOT the ICM HTTP session lock. ' +
          'If the object is still blocked after this, a stale ICM session holds the ADT lock: ' +
          'kill it in SM04 (delete work process entries for this user showing the ADT class path). ' +
          'Supported types: CLAS, INTF, PROG, FUGR.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name, e.g. /DSN/BP_R_MOD or ZCL_MY_CLASS' },
            type: { type: 'string', description: 'Object type: CLAS, INTF, PROG, or FUGR' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_run',
        description:
          'Create a temporary ABAP class in $TMP, run it via IF_OO_ADT_CLASSRUN, capture output, then delete it. ' +
          'This is the standard pattern for querying live SAP data or executing one-off ABAP logic. ' +
          'Provide only the body of the run method — the class wrapper is generated automatically. ' +
          'Use out->write() to produce output. ' +
          'IMPORTANT: Declare variables with DATA before SELECT. ' +
          'Use "SELECT * FROM table INTO TABLE lt WHERE ..." (old-style, no inline @DATA) — ' +
          'inline declarations with UP TO N ROWS do not work inside this method. ' +
          'To limit rows, use "DELETE lt FROM N." after the SELECT. ' +
          'LARGE OUTPUT: When the method produces more than 60 000 characters, output is automatically ' +
          'split into pages. The first page is returned with run_id, total_pages, and has_more=true. ' +
          'Use abap_fetch_page(run_id, page) to retrieve subsequent pages (retained for 30 minutes). ' +
          'If the class name already exists from a previous failed run it is deleted and retried automatically. ' +
          'KNOWN LIMITATION: HTTP calls from within abap_run code to http://localhost/... will fail with ' +
          'ICMECONNREFUSED — the ABAP process cannot reach the ICM listener via loopback. ' +
          'Use CL_HTTP_CLIENT=>CREATE_BY_DESTINATION with a configured RFC destination instead, ' +
          'or use the dedicated bsp_read_file / bsp_search_content tools to read BSP/UI5 file content.',
        inputSchema: {
          type: 'object',
          properties: {
            methodBody: {
              type: 'string',
              description: 'ABAP code to execute. Use out->write() for output. Also accepted as "code".'
            },
            className: {
              type: 'string',
              description: 'Optional class name for the temp class (default: ZCL_TMP_ADT_RUN). Must start with Z. Will be deleted after run. Change this if you get "already exists" errors from a prior failed run.'
            },
            interfaceMethod: {
              type: 'string',
              description: 'Override the detected interface method: "run" (S/4HANA ≤2023) or "main" (S/4HANA 2024+). Auto-detected from the system by default — only set this if auto-detection fails.'
            },
            keepClass: {
              type: 'boolean',
              description: 'If true, skip deletion of the temp class after run. Useful for debugging — lets you inspect the generated source via abap_get_source. Default: false.'
            }
          },
          required: ['methodBody']
        }
      },
      {
        name: 'abap_fetch_page',
        annotations: { readOnlyHint: true },
        description:
          'Retrieve a subsequent page of output from a large abap_run result. ' +
          'When abap_run output exceeds 60 000 characters it is automatically split into pages. ' +
          'The first page is returned inline with the run result along with a run_id and total_pages. ' +
          'Call abap_fetch_page with that run_id and the desired page number to retrieve additional pages. ' +
          'Pages are retained for 30 minutes after the run.',
        inputSchema: {
          type: 'object',
          properties: {
            run_id:   { type: 'string', description: 'The run_id returned by abap_run when output was paginated.' },
            page:     { type: 'number', description: 'Page number to retrieve (1-based).' }
          },
          required: ['run_id', 'page']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_unlock':     return this.handleUnlock(args);
      case 'abap_run':        return this.handleRun(args);
      case 'abap_fetch_page': return this.handleFetchPage(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private handleFetchPage(args: any): any {
    evictExpiredRuns();
    const runId = (args.run_id || '').trim();
    const page  = Math.floor(args.page ?? 1);

    const run = pagedRuns.get(runId);
    if (!run) {
      this.fail(`abap_fetch_page: run_id "${runId}" not found — it may have expired (30-minute TTL) or never existed.`);
    }

    const idx = page - 1;
    if (idx < 0 || idx >= run!.pages.length) {
      this.fail(`abap_fetch_page: page ${page} out of range (1–${run!.pages.length}) for run_id "${runId}".`);
    }

    return this.success({
      run_id:       runId,
      page,
      total_pages:  run!.pages.length,
      has_more:     page < run!.pages.length,
      className:    run!.className,
      output:       run!.pages[idx]
    });
  }

  private async handleUnlock(args: any): Promise<any> {
    const name = (args.name || '').toUpperCase();
    const baseType = (args.type || '').toUpperCase().split('/')[0];

    // Per-type ABAP CALL FUNCTION templates.
    // _scope='2' = all sessions of current user — covers stale locks from dead MCP sessions.
    // CLAS/INTF: FM is DEQUEUE_ESEOCLASS (named after the transaction, not the lock object).
    //   Lock object in SM12 shows as SEOCLSENQ, but the FM is DEQUEUE_ESEOCLASS with
    //   MODE_SEOCLSENQ, CLSNAME, INCTYPE (include type, blank = wildcard), CPDNAME params.
    // PROG/FUGR: FM names are best-guess — correct if they fail.
    const DEQUEUE_ABAP: Record<string, (n: string) => string> = {
      'CLAS': (n) =>
        `CALL FUNCTION 'DEQUEUE_ESEOCLASS'\n` +
        `  EXPORTING\n` +
        `    mode_seoclsenq = 'E'\n` +
        `    clsname        = '${n}'\n` +
        `    inctype        = ' '\n` +
        `    cpdname        = ' '\n` +
        `    _scope         = '2'\n` +
        `    _synchron      = 'X'.`,
      'INTF': (n) =>
        `CALL FUNCTION 'DEQUEUE_ESEOCLASS'\n` +
        `  EXPORTING\n` +
        `    mode_seoclsenq = 'E'\n` +
        `    clsname        = '${n}'\n` +
        `    inctype        = ' '\n` +
        `    cpdname        = ' '\n` +
        `    _scope         = '2'\n` +
        `    _synchron      = 'X'.`,
      'PROG': (n) =>
        `CALL FUNCTION 'DEQUEUE_EENREPSRC'\n` +
        `  EXPORTING\n` +
        `    progname  = '${n}'\n` +
        `    _scope    = '2'\n` +
        `    _synchron = 'X'.`,
      'FUGR': (n) =>
        `CALL FUNCTION 'DEQUEUE_EENLOGOPG'\n` +
        `  EXPORTING\n` +
        `    area      = '${n}'\n` +
        `    _scope    = '2'\n` +
        `    _synchron = 'X'.`,
    };

    const template = DEQUEUE_ABAP[baseType];
    if (!template) {
      this.fail(
        `abap_unlock: unsupported type '${baseType}'. ` +
        `Supported: CLAS, INTF, PROG, FUGR. For other types, use SM12 in SAP GUI.`
      );
    }

    const methodBody =
      `TRY.\n` +
      `  ${template!(name).split('\n').join('\n  ')}\n` +
      `  out->write( |abap_unlock: DEQUEUE FM called for '${name}'. Enqueue lock (SM12) cleared. If object still blocked, a stale ICM session in SM04 holds the ADT lock.| ).\n` +
      `CATCH cx_root INTO DATA(lx).\n` +
      `  out->write( |abap_unlock failed: { lx->get_text( ) }| ).\n` +
      `ENDTRY.`;

    return this.handleRun({ methodBody, className: 'ZCL_TMP_UNLOCK' });
  }

  private async handleRun(args: any): Promise<any> {
    // Accept 'code' as an alias for 'methodBody'
    if (args.code && !args.methodBody) args.methodBody = args.code;
    if (!args.methodBody) {
      this.fail('abap_run: methodBody is required — provide the ABAP code to run as the methodBody parameter.');
    }

    const className     = (args.className || 'ZCL_TMP_ADT_RUN').toUpperCase();
    let actualClassName = className;
    let classUrl        = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
    let sourceUrl       = `${classUrl}/source/main`;

    let methodName: string = 'run';
    let classCreated = false;
    let lockHandle: string | null = null;

    try {
      // Ensure stateful session — must be established before auto-detecting the interface method,
      // otherwise getObjectSource may fail silently and fall back to 'run' (wrong on 2024+ systems).
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.login();

      // Auto-detect the correct interface method for this system by reading IF_OO_ADT_CLASSRUN.
      // Older systems (≤2023) use ~run; newer systems (2024+) use ~main.
      // Explicit interfaceMethod param overrides detection.
      if (args.interfaceMethod) {
        methodName = args.interfaceMethod.toLowerCase();
      } else {
        try {
          const ifSource = await this.adtclient.getObjectSource(
            '/sap/bc/adt/oo/interfaces/if_oo_adt_classrun/source/main'
          ) as string;
          methodName = ifSource.toLowerCase().includes('main') ? 'main' : 'run';
        } catch (_) {
          methodName = 'run'; // safe default if interface source unreadable
        }
      }

      // Create temp class in $TMP.
      // If it already exists (leftover from a failed run), delete it and retry automatically.
      // If that also fails, try incrementing the name suffix (ZCL_TMP_ADT_RUN_2, _3, ...) up to 5 times.
      const tryCreate = async (name: string): Promise<boolean> => {
        try {
          await this.adtclient.createObject(
            'CLAS/OC', name, '$TMP', 'Temporary ADT runner class',
            '/sap/bc/adt/packages/%24tmp', undefined, undefined
          );
          return true;
        } catch (e: any) {
          const m = (e?.message || '').toLowerCase();
          if (m.includes('already exist') || m.includes('exists already')) return false;
          throw e;
        }
      };

      const deleteStale = async (name: string): Promise<void> => {
        const url = `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
        try {
          const delLock = await this.adtclient.lock(url);
          if (delLock.CORRNR) { try { await this.classifyTask(delLock.CORRNR); } catch (_) {} }
          await this.adtclient.deleteObject(url, delLock.LOCK_HANDLE);
        } catch (_) {}
      };

      if (!await tryCreate(actualClassName)) {
        // Stale class exists — try to clean it up and re-create
        await deleteStale(actualClassName);
        if (!await tryCreate(actualClassName)) {
          // Deletion didn't work (locked by another user?) — try suffixed names
          let created = false;
          for (let i = 2; i <= 6; i++) {
            const alt = `${className}_${i}`;
            if (await tryCreate(alt)) { actualClassName = alt; created = true; break; }
          }
          if (!created) {
            this.fail(
              `abap_run: ${className} already exists and could not be cleaned up. ` +
              `Pass a different className or delete the class manually in Eclipse.`
            );
          }
        }
      }
      // Update outer vars so catch/finally and subsequent steps use the resolved name
      classUrl  = `/sap/bc/adt/oo/classes/${actualClassName.toLowerCase()}`;
      sourceUrl = `${classUrl}/source/main`;
      classCreated = true;

      // Lock → write source → unlock
      const lockResult = await this.adtclient.lock(classUrl);
      lockHandle = lockResult.LOCK_HANDLE;
      // Classify any auto-created workbench task as Correction — prevents orphaned Unclassified tasks.
      if (lockResult.CORRNR) {
        try { await this.classifyTask(lockResult.CORRNR); } catch (_) {}
      }

      const source = this.buildClassSource(actualClassName, args.methodBody, methodName);
      await this.adtclient.setObjectSource(sourceUrl, source, lockHandle);

      await this.adtclient.unLock(classUrl, lockHandle);
      lockHandle = null;

      // Activate — if it fails because the method name is wrong for this release, surface a clear hint
      const activationResult = await this.adtclient.activate(actualClassName, classUrl);
      // Surface the raw activation result so callers can diagnose unexpected shapes (e.g. release differences)
      const activationSucceeded = activationResult?.success === true;
      if (!activationSucceeded) {
        const messages = (activationResult?.messages || [])
          .map((m: any) => m.shortText || m.objDescr)
          .filter(Boolean)
          .join('; ');
        const lower = messages.toLowerCase();
        const isWrongMethod = lower.includes('main') || lower.includes('run');
        const isPipeError = lower.includes('unmasked') || lower.includes('string template');
        const altMethod = methodName === 'run' ? 'main' : 'run';
        let hint = '';
        if (isPipeError) {
          hint = ' Pipe characters (|) are ABAP string template delimiters. Escape literal pipes with \\| or use CONCATENATE instead.';
        } else if (isWrongMethod) {
          hint = ` Try passing interfaceMethod="${altMethod}" — this system may use if_oo_adt_classrun~${altMethod}.`;
        }
        throw new Error(
          `Activation failed: ${messages || 'no error messages returned'}${hint} ` +
          `[raw activationResult: ${JSON.stringify(activationResult)}]`
        );
      }

      // End the stateful session before classrun — on some systems (e.g. D25/759), activation is only
      // fully committed once the session closes. classrun on an in-session activation sees "not implemented".
      await this.adtclient.logout();
      // Re-login stateless to get a fresh CSRF token for the classrun POST.
      this.adtclient.stateful = session_types.stateless;
      await this.adtclient.login();

      // Call classrun via the underlying HTTP client directly so we can set Accept: text/plain.
      // The library's runClass() sends no Accept header, which causes silent failures on some releases.
      const h = (this.adtclient as any).h;
      let output: any;
      try {
        const response = await h.request(
          `/sap/bc/adt/oo/classrun/${actualClassName.toUpperCase()}`,
          { method: 'POST', headers: { Accept: 'text/plain' } }
        );
        output = response.body ?? response.data ?? '';
      } catch (runError: any) {
        const msg = runError?.message || '';
        const status = runError?.response?.status;
        // Extract SAP error body if present — distinguishes "service inactive" (403/404) from runtime errors
        const body = runError?.response?.data || runError?.response?.body || '';
        const bodyStr = typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400);
        if (status === 500 || msg.includes('500')) {
          const detail = bodyStr ? ` SAP response: ${bodyStr}` : '';
          throw new Error(
            `classrun endpoint returned 500. Possible causes: ` +
            `(1) IF_OO_ADT_CLASSRUN is not available on this system release, ` +
            `(2) the ABAP code has a runtime error — check abap_get_dump for a ST22 entry.${detail}`
          );
        }
        const detail = bodyStr ? ` SAP response: ${bodyStr}` : '';
        throw new Error(`classrun failed: ${msg}${detail}`);
      }

      // SAP sometimes returns HTTP 200 with an error string in the body (e.g. "Error: Class does not implement ~main").
      // Detect this and surface it as a real error rather than silently returning garbage output.
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output ?? '');
      if (outputStr.startsWith('Error:') || outputStr.startsWith('Exception:')) {
        const altMethod = methodName === 'run' ? 'main' : 'run';
        const isMethodError = outputStr.toLowerCase().includes('does not implement') ||
          outputStr.toLowerCase().includes(`~${methodName}`);
        const hint = isMethodError
          ? ` Try passing interfaceMethod="${altMethod}" — this system may use if_oo_adt_classrun~${altMethod}.`
          : '';
        throw new Error(`classrun returned error in body (HTTP 200): ${outputStr}${hint}`);
      }

      // Paginate large output: split into PAGE_SIZE chunks, cache server-side, return page 1.
      // abap_fetch_page(run_id, page) retrieves subsequent pages (30-minute TTL).
      evictExpiredRuns();
      if (outputStr.length > PAGE_SIZE) {
        const pages: string[] = [];
        for (let off = 0; off < outputStr.length; off += PAGE_SIZE) {
          pages.push(outputStr.slice(off, off + PAGE_SIZE));
        }
        const runId = randomUUID();
        pagedRuns.set(runId, { pages, created: Date.now(), className: actualClassName });
        return this.success({
          output:       pages[0],
          className:    actualClassName,
          paginated:    true,
          run_id:       runId,
          page:         1,
          total_pages:  pages.length,
          total_chars:  outputStr.length,
          has_more:     pages.length > 1,
          note:         `Output split into ${pages.length} pages. Use abap_fetch_page(run_id="${runId}", page=N) to retrieve remaining pages.`
        });
      }

      return this.success({ output: outputStr, className: actualClassName });

    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(classUrl, lockHandle); } catch (_) {}
      }
      this.fail(formatError('abap_run', error));
    } finally {
      // Delete the temp class unless keepClass=true was requested.
      // Re-login first — the session may be in a bad state after an error.
      if (classCreated && !args.keepClass) {
        try {
          this.adtclient.stateful = session_types.stateful;
          await this.adtclient.login();
          const deleteLock = await this.adtclient.lock(classUrl);
          if (deleteLock.CORRNR) { try { await this.classifyTask(deleteLock.CORRNR); } catch (_) {} }
          await this.adtclient.deleteObject(classUrl, deleteLock.LOCK_HANDLE);
        } catch (_) {
          // Best-effort — if cleanup fails, the class stays in $TMP.
          // Inspect it with abap_get_source(name=className, type=CLAS) or pass a different className on retry.
        }
      }
    }
  }
}
