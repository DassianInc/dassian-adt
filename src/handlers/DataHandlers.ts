import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';
import { parseQueryResponse, decodeQueryResult } from 'abap-adt-api/build/api/tablecontents.js';

export class DataHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_query',
        annotations: { readOnlyHint: true },
        description:
          'Execute a SQL query against the SAP database via ADT. ' +
          'Use OpenSQL syntax (FROM clause, WHERE, ORDER BY). ' +
          'For complex data investigations, prefer abap_run which gives full ABAP logic.',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'The SQL query string (parameter name is "sql", not "query"). OpenSQL syntax, e.g. SELECT * FROM VBRP WHERE VBELN = \'0090001234\' UP TO 10 ROWS' },
            limit: { type: 'number', description: 'Max rows to return (default 100)' }
          },
          required: ['sql']
        }
      },
      {
        name: 'abap_table',
        annotations: { readOnlyHint: true },
        description:
          'Read contents of an ABAP table or CDS view. ' +
          'Supports an optional WHERE clause including LIKE, BETWEEN, and comparisons. ' +
          'For multi-table joins or subqueries, use abap_query instead.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Table or CDS view name, e.g. VBRP or /DSN/C_CPR_SQL_VIEW' },
            where: { type: 'string', description: 'Optional WHERE clause (OpenSQL), e.g. VBELN = \'0090001234\' or STATUS LIKE \'A%\'' },
            limit: { type: 'number', description: 'Max rows to return (default 100)' }
          },
          required: ['name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_query': return this.handleQuery(args);
      case 'abap_table': return this.handleTable(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleQuery(args: any): Promise<any> {
    try {
      // The library's runQuery() omits Content-Type, causing a 400 on all systems.
      // Also strip UP TO N ROWS from the SQL — the endpoint uses ?rowNumber instead.
      let sql: string = args.sql || args.query || '';
      let rowNumber: number = args.limit || 100;
      const upToMatch = sql.match(/\bUP\s+TO\s+(\d+)\s+ROWS\b/i);
      if (upToMatch) {
        rowNumber = parseInt(upToMatch[1], 10) || rowNumber;
        sql = sql.replace(/\s*\bUP\s+TO\s+\d+\s+ROWS\b/i, '').trim();
      }

      const h = (this.adtclient as any).h;
      const result = await this.withSession(async () => {
        const response = await h.request(
          `/sap/bc/adt/datapreview/freestyle`,
          {
            qs: { rowNumber },
            headers: { Accept: 'application/*', 'Content-Type': 'text/plain' },
            method: 'POST',
            body: sql
          }
        );
        return decodeQueryResult(parseQueryResponse(response.body));
      });
      return this.success({ result });
    } catch (error: any) {
      this.fail(formatError('abap_query', error));
    }
  }

  private async handleTable(args: any): Promise<any> {
    try {
      const limit = args.limit || 100;
      const where = args.where || '';
      // tableContents rejects LIKE/BETWEEN in WHERE — route through datapreview/freestyle instead
      const needsFreestyle = /\bLIKE\b|\bBETWEEN\b/i.test(where);
      if (needsFreestyle || where) {
        const sql = where
          ? `SELECT * FROM ${args.name} WHERE ${where}`
          : `SELECT * FROM ${args.name}`;
        const h = (this.adtclient as any).h;
        const result = await this.withSession(async () => {
          const response = await h.request(
            `/sap/bc/adt/datapreview/freestyle`,
            {
              qs: { rowNumber: limit },
              headers: { Accept: 'application/*', 'Content-Type': 'text/plain' },
              method: 'POST',
              body: sql
            }
          );
          return decodeQueryResult(parseQueryResponse(response.body));
        });
        return this.success({ result });
      }
      const result = await this.withSession(() =>
        this.adtclient.tableContents(args.name, limit, false, undefined)
      );
      return this.success({ result });
    } catch (error: any) {
      this.fail(formatError(`abap_table(${args.name})`, error));
    }
  }
}
