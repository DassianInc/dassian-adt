import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import { session_types } from 'abap-adt-api';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';

export class SystemHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'login',
        annotations: { idempotentHint: true },
        description:
          'Establish a stateful session with the SAP system. ' +
          'Most tools call this automatically via withSession() — you only need to call login() explicitly ' +
          'before abap_run (which requires a fresh session for the classrun endpoint).',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'healthcheck',
        annotations: { readOnlyHint: true },
        description: 'Verify connectivity to the SAP system. Returns system ID and login status.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'abap_get_dump',
        annotations: { readOnlyHint: true },
        description:
          'Retrieve recent ABAP short dumps (ST22). ' +
          'Returns dump list with error text, program, and timestamp. ' +
          'Use after a failed abap_run or to investigate customer-reported short dumps. ' +
          'Optionally filter by a search query (e.g. program name or error class).',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Optional filter — program name, error class, or free text. Omit to get all recent dumps.'
            }
          }
        }
      },
      {
        name: 'abap_inactive_objects',
        annotations: { readOnlyHint: true },
        description:
          'List all objects with inactive versions (objects that have been modified but not yet activated). ' +
          'Returns each inactive object with its type, name, and user. ' +
          'Use before abap_activate to see what needs to be activated.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'abap_annotation_defs',
        annotations: { readOnlyHint: true },
        description:
          'Retrieve all CDS annotation definitions available on this SAP system. ' +
          'Returns the raw XML containing annotation names, types, and allowed values. ' +
          'Useful when writing CDS views to discover valid annotations and their structure.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'raw_http',
        description:
          'Execute a raw HTTP request to the SAP ADT API. ' +
          'Use this for operations not covered by other tools — specifically: ' +
          '(1) SITO objects (require Content-Type: application/json for source writes), ' +
          '(2) SICF path management, ' +
          '(3) Any ADT endpoint not exposed as a dedicated tool. ' +
          'NOTE: BSP/UI5 filestore paths (/sap/bc/adt/filestore/ui5-bsp/...) are NOT accessible via raw_http — ' +
          'use the dedicated bsp_read_file and bsp_search_content tools for reading BSP application files. ' +
          'For SITO source writes: method=PUT, path=/sap/bc/adt/ddls/SITO_NAME/source/main?lockHandle=LOCK, ' +
          'contentType=application/json, body=<JSON source>. ' +
          'HARD RULE — NEVER use raw_http to POST to lock endpoints (?method=adtLock) or attempt to ' +
          'acquire, probe, or release locks via raw_http. Even a failed lock POST leaves a stale ICM ' +
          'session lock with no matching handle on our side, causing every subsequent abap_set_source to ' +
          'fail with "locked by another" until the user manually kills sessions in SM04. ' +
          'raw_http also CANNOT be used for any stateful multi-step sequence (lock → write → unlock): ' +
          'each call may get a different ICM session, making lock handles invalid for subsequent calls. ' +
          'Use abap_set_source, abap_set_class_include, or abap_edit_method for any write operation.',
        inputSchema: {
          type: 'object',
          properties: {
            method: {
              type: 'string',
              description: 'HTTP method: GET, POST, PUT, DELETE, PATCH'
            },
            path: {
              type: 'string',
              description: 'ADT path starting with /sap/bc/adt/..., including any query parameters'
            },
            body: {
              type: 'string',
              description: 'Request body (for POST, PUT, PATCH)'
            },
            contentType: {
              type: 'string',
              description: 'Content-Type header. Default: application/xml. Use application/json for SITO.'
            },
            accept: {
              type: 'string',
              description: 'Accept header. Default: application/xml.'
            }
          },
          required: ['method', 'path']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'login':                  return this.handleLogin();
      case 'healthcheck':            return this.handleHealthcheck();
      case 'abap_get_dump':          return this.handleGetDump(args);
      case 'abap_inactive_objects':  return this.handleInactiveObjects();
      case 'abap_annotation_defs':   return this.handleAnnotationDefs();
      case 'raw_http':               return this.handleRawHttp(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleLogin(): Promise<any> {
    try {
      this.adtclient.stateful = session_types.stateful;
      const result = await this.adtclient.login();
      return this.success({ loggedIn: true, result });
    } catch (error: any) {
      this.fail(formatError('login', error));
    }
  }

  private async handleHealthcheck(): Promise<any> {
    try {
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.login();
      return this.success({ healthy: true, timestamp: new Date().toISOString() });
    } catch (error: any) {
      return this.success({ healthy: false, error: error.message, timestamp: new Date().toISOString() });
    }
  }

  private async handleGetDump(args: any): Promise<any> {
    try {
      // Call the dumps endpoint directly — the library's parseDumps() destructures
      // summary.#text unconditionally and throws on dumps with empty/missing summaries.
      const h = (this.adtclient as any).h;
      const qs: Record<string, string> = {};
      if (args.query) qs['$query'] = args.query;
      const response = await this.withSession(() =>
        h.request('/sap/bc/adt/runtime/dumps', {
          method: 'GET', qs,
          headers: { Accept: 'application/atom+xml;type=feed' }
        })
      );

      // Parse defensively — fast-xml-parser is already a dep of abap-adt-api
      const { XMLParser } = await import('fast-xml-parser');
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: true,
        isArray: (name) => name === 'entry' || name === 'category' || name === 'link'
      });
      const raw = parser.parse((response as any).body || '');
      const entries: any[] = raw?.feed?.entry || [];

      const dumps = entries.map((e: any) => {
        const id = e.id || '';
        const author = e.author?.name || '';
        // summary may be a string, an object with #text, or missing
        const sumNode = e.summary;
        const text = typeof sumNode === 'string'
          ? sumNode
          : (sumNode?.['#text'] || sumNode?.['#cdata-section'] || '');
        const type = sumNode?.['@_type'] || '';
        const categories = (e.category || []).map((c: any) =>
          c['@_label'] || c['@_term'] || ''
        );
        const links = (e.link || []).map((l: any) => ({
          href: l['@_href'] || l['@_rel'] || '',
          rel: l['@_rel'] || ''
        }));
        return { id, author, text, type, categories, links };
      });

      return this.success({ count: dumps.length, dumps });
    } catch (error: any) {
      this.fail(`abap_get_dump failed: ${error.message || 'Unknown error'}`);
    }
  }

  private async handleInactiveObjects(): Promise<any> {
    try {
      const records = await this.withSession(() => this.adtclient.inactiveObjects());
      return this.success({ count: (records as any[]).length, objects: records });
    } catch (error: any) {
      this.fail(formatError('abap_inactive_objects', error));
    }
  }

  private async handleAnnotationDefs(): Promise<any> {
    try {
      const xml = await this.withSession(() => this.adtclient.annotationDefinitions());
      return this.success({ annotations: xml });
    } catch (error: any) {
      this.fail(formatError('abap_annotation_defs', error));
    }
  }

  private async handleRawHttp(args: any): Promise<any> {
    if (!args.method || !args.path) {
      this.fail('raw_http requires method (GET, POST, PUT, DELETE, PATCH) and path (/sap/bc/adt/...).');
    }
    try {
      // Access the underlying HTTP client directly
      const h = (this.adtclient as any).h;
      if (!h) {
        this.fail('raw_http: Cannot access underlying HTTP client. The abap-adt-api version may not expose it.');
      }

      const response = await this.withSession(async () => {
        const options: any = {
          method: args.method.toUpperCase(),
          headers: {} as Record<string, string>
        };

        if (args.contentType) {
          options.headers['Content-Type'] = args.contentType;
        }
        if (args.accept) {
          options.headers['Accept'] = args.accept;
        }
        if (args.body) {
          options.body = args.body;
        }

        return h.request(args.path, options);
      });

      return this.success({
        status: (response as any).status || (response as any).statusCode,
        body: (response as any).body || (response as any).data
      });
    } catch (error: any) {
      this.fail(formatError(`raw_http(${args.method} ${args.path})`, error));
    }
  }
}
