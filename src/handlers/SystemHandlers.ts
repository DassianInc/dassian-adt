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
        name: 'raw_http',
        description:
          'Execute a raw HTTP request to the SAP ADT API. ' +
          'Use this for operations not covered by other tools — specifically: ' +
          '(1) SITO objects (require Content-Type: application/json for source writes), ' +
          '(2) SICF path management, ' +
          '(3) Any ADT endpoint not exposed as a dedicated tool. ' +
          'For SITO source writes: method=PUT, path=/sap/bc/adt/ddls/SITO_NAME/source/main?lockHandle=LOCK, ' +
          'contentType=application/json, body=<JSON source>.',
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
      case 'login':          return this.handleLogin();
      case 'healthcheck':    return this.handleHealthcheck();
      case 'abap_get_dump':  return this.handleGetDump(args);
      case 'raw_http':       return this.handleRawHttp(args);
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
      const feed = await this.withSession(() =>
        this.adtclient.dumps(args.query)
      );
      const dumps = (feed as any).dumps || [];
      return this.success({
        count: dumps.length,
        dumps: dumps.map((d: any) => ({
          id: d.id,
          text: d.text,
          type: d.type,
          author: d.author,
          categories: (d.categories || []).map((c: any) => c.label || c.term)
        }))
      });
    } catch (error: any) {
      this.fail(`abap_get_dump failed: ${error.message || 'Unknown error'}`);
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
