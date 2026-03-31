import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl, buildSourceUrl, NESTED_TYPES } from '../lib/urlBuilder.js';
import { formatError } from '../lib/errors.js';
import type { UsageReference } from 'abap-adt-api';

export class QualityHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_syntax_check',
        description:
          'Run a syntax check on an ABAP object. Returns errors and warnings. ' +
          'Use this after writing source to verify correctness before activating. ' +
          'Supports all types including FUGR/FF (function modules).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: 'Object type (e.g. CLAS, PROG/I, FUGR/FF)' },
            fugr: { type: 'string', description: 'Parent function group — required for FUGR/FF if auto-discovery fails' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_atc_run',
        description:
          'Run ABAP Test Cockpit (ATC) checks on an object. ' +
          'Returns findings grouped by severity (error, warning, info). ' +
          'Clean core compliance issues appear here.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: 'Object type' },
            variant: { type: 'string', description: 'ATC check variant to use (default: DEFAULT)' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_where_used',
        description:
          'Find all references to an ABAP object (where-used list). ' +
          'Returns every object that references the target, with object name, type, package, and description. ' +
          'Equivalent to Ctrl+Shift+G in Eclipse ADT or SE12 where-used in SAP GUI. ' +
          'Use this before deleting or modifying objects to understand the impact.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name, e.g. /DSN/GPD_DISRP or /DSN/CL_S4CM_CMB_CONTRACT' },
            type: { type: 'string', description: 'Object type (e.g. CLAS, VIEW, TABL, DTEL, INTF, PROG, FUGR, DDLS)' },
            line: { type: 'number', description: 'Optional: line number to find references to a specific symbol at that position' },
            column: { type: 'number', description: 'Optional: column number (used with line) for symbol-level where-used' },
            snippets: { type: 'boolean', description: 'If true, also fetch code snippets showing exactly how the object is used at each location (default: false)' }
          },
          required: ['name', 'type']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_syntax_check': return this.handleSyntaxCheck(args);
      case 'abap_atc_run':      return this.handleAtcRun(args);
      case 'abap_where_used':   return this.handleWhereUsed(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleSyntaxCheck(args: any): Promise<any> {
    if (!args.name || !args.type) {
      this.fail('abap_syntax_check requires name (object name) and type (e.g. CLAS, PROG/I).');
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
      );
      const result = await this.withSession(() =>
        this.adtclient.syntaxCheck(sourceUrl, sourceUrl, source as string)
      );
      return this.success({ name: args.name, syntaxResult: result });
    } catch (error: any) {
      this.fail(formatError(`abap_syntax_check(${args.name})`, error));
    }
  }

  private async handleWhereUsed(args: any): Promise<any> {
    if (!args.name || !args.type) {
      this.fail('abap_where_used requires name (object name) and type (e.g. CLAS, VIEW, TABL).');
    }
    try {
      const objectUrl = buildObjectUrl(args.name, args.type);
      const references: UsageReference[] = await this.withSession(() =>
        this.adtclient.usageReferences(objectUrl, args.line, args.column)
      );

      // Use all references — isResult flag is unreliable across SAP versions
      const results = references;

      // Build a clean summary for each reference
      const summary = results.map(r => ({
        name: r['adtcore:name'],
        type: r['adtcore:type'] || '',
        description: r['adtcore:description'] || '',
        package: r.packageRef?.['adtcore:name'] || '',
        responsible: r['adtcore:responsible'] || '',
        uri: r.uri,
        usage: r.usageInformation || ''
      }));

      // Optionally fetch code snippets
      let snippets: any[] | undefined;
      if (args.snippets && results.length > 0) {
        const rawSnippets = await this.withSession(() =>
          this.adtclient.usageReferenceSnippets(references)
        );
        snippets = rawSnippets.map(s => ({
          objectIdentifier: s.objectIdentifier,
          snippets: s.snippets.map(sn => ({
            content: sn.content,
            matches: sn.matches,
            description: sn.description
          }))
        }));
      }

      return this.success({
        name: args.name,
        type: args.type,
        referenceCount: summary.length,
        references: summary,
        ...(snippets ? { snippets } : {})
      });
    } catch (error: any) {
      this.fail(formatError(`abap_where_used(${args.name})`, error));
    }
  }

  private async handleAtcRun(args: any): Promise<any> {
    if (!args.name || !args.type) {
      this.fail('abap_atc_run requires name (object name) and type (e.g. CLAS, PROG/P). ' +
        'To check a transport\'s objects, first list them with transport_contents, then run ATC per object.');
    }
    const objectUrl = buildObjectUrl(args.name, args.type);
    const variant = args.variant || 'DEFAULT';
    try {
      // Step 1: Resolve variant name to internal worklist ID.
      // Passing the variant name string directly to createAtcRun causes a silent fallback to DEFAULT.
      const worklistId = await this.withSession(() =>
        this.adtclient.atcCheckVariant(variant)
      );

      // Step 2: Trigger a fresh ATC run using the resolved ID.
      const runResult = await this.withSession(() =>
        this.adtclient.createAtcRun(worklistId, objectUrl, 100)
      );

      // Step 3: Fetch findings using run ID + timestamp.
      const worklist = await this.withSession(() =>
        this.adtclient.atcWorklists(runResult.id, runResult.timestamp, '', false)
      );

      // Group findings by priority: 1=error, 2=warning, else=info
      const grouped: { error: any[]; warning: any[]; info: any[] } = { error: [], warning: [], info: [] };
      let totalFindings = 0;
      for (const obj of (worklist.objects || [])) {
        for (const f of (obj.findings || [])) {
          totalFindings++;
          const finding = {
            object: obj.name,
            objectType: obj.type,
            checkId: f.checkId,
            checkTitle: f.checkTitle,
            messageTitle: f.messageTitle,
            priority: f.priority,
            location: f.location ? {
              uri: f.location.uri,
              line: f.location.range ? f.location.range.start.line : undefined,
              column: f.location.range ? f.location.range.start.column : undefined
            } : undefined,
            exemptionKind: f.exemptionKind || ''
          };
          if (f.priority === 1) grouped.error.push(finding);
          else if (f.priority === 2) grouped.warning.push(finding);
          else grouped.info.push(finding);
        }
      }

      return this.success({ name: args.name, variant, runId: runResult.id, findings: grouped, totalFindings });
    } catch (error: any) {
      this.fail(formatError(`abap_atc_run(${args.name})`, error));
    }
  }
}
