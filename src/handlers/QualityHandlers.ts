import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl, buildSourceUrl, buildMethodUrl, NESTED_TYPES } from '../lib/urlBuilder.js';
import { formatError } from '../lib/errors.js';
import type { UsageReference } from 'abap-adt-api';

export class QualityHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_syntax_check',
        annotations: { readOnlyHint: true },
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
        annotations: { readOnlyHint: true },
        description:
          'Run ABAP Test Cockpit (ATC) checks on an object. ' +
          'Returns findings grouped by severity (error, warning, info). ' +
          'Clean core compliance issues appear here. ' +
          'The response includes worklistId and variantWarning — if variantWarning is set, SAP silently fell back to DEFAULT (variant name did not match SATC configuration). ' +
          'Use abap_atc_variants to see what the system reports as its configured properties.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: 'Object type' },
            variant: { type: 'string', description: 'ATC check variant name — must match exactly what is configured in SATC transaction (case-sensitive). Default: DEFAULT' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_atc_variants',
        annotations: { readOnlyHint: true },
        description:
          'Return ATC system customizing (configured properties and exemption kinds). ' +
          'Use this to diagnose ATC variant issues. Note: SAP does not expose a standard endpoint to list all variant names — ' +
          'variant names must be checked in SATC transaction on the SAP system. ' +
          'This tool also probes whether "DEFAULT" and a given variant resolve to the same worklist ID (silent fallback detection).',
        inputSchema: {
          type: 'object',
          properties: {
            probe_variant: { type: 'string', description: 'Optional: a variant name to probe. Returns worklistId for both DEFAULT and this variant so you can detect silent fallback (same ID = SAP fell back to DEFAULT).' }
          }
        }
      },
      {
        name: 'abap_where_used',
        annotations: { readOnlyHint: true },
        description:
          'Find all references to an ABAP object (where-used list). ' +
          'Returns every object that references the target, with object name, type, package, and description. ' +
          'Equivalent to Ctrl+Shift+G in Eclipse ADT or SE12 where-used in SAP GUI. ' +
          'Use this before deleting or modifying objects to understand the impact. ' +
          'For class methods use type CLAS/OM with name="CLASS_NAME::METHOD_NAME" (e.g. "/DSN/MY_CLASS::GET_CONT") ' +
          'or pass name=class and method=method_name separately.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name, e.g. /DSN/GPD_DISRP or /DSN/CL_S4CM_CMB_CONTRACT. For methods: /DSN/MY_CLASS::GET_CONT or just the class name when method param is used.' },
            type: { type: 'string', description: 'Object type (e.g. CLAS, VIEW, TABL, DTEL, INTF, PROG, FUGR, DDLS). Use CLAS/OM for class methods.' },
            method: { type: 'string', description: 'Method name when type=CLAS/OM (alternative to CLASS::METHOD syntax in name)' },
            line: { type: 'number', description: 'Optional: line number to find references to a specific symbol at that position' },
            column: { type: 'number', description: 'Optional: column number (used with line) for symbol-level where-used' },
            snippets: { type: 'boolean', description: 'If true, also fetch code snippets showing exactly how the object is used at each location (default: false)' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_find_definition',
        annotations: { readOnlyHint: true },
        description:
          'Jump to the definition of an ABAP symbol at a specific cursor position in source code. ' +
          'Requires a source object (name+type) AND the exact line/column where the symbol appears — ' +
          'NOT an object name lookup. First call abap_get_source to read the code and locate the symbol, ' +
          'then pass those coordinates here. Equivalent to F3 / Ctrl+Click in Eclipse ADT.',
        inputSchema: {
          type: 'object',
          properties: {
            name:   { type: 'string',  description: 'Object name containing the symbol, e.g. /DSN/CL_S4CM_CMB_CONTRACT' },
            type:   { type: 'string',  description: 'Object type, e.g. CLAS, PROG/I' },
            line:   { type: 'number',  description: 'Line number (1-based) of the symbol in the source' },
            column: { type: 'number',  description: 'Column number (1-based) of the symbol start' },
            end_column: { type: 'number', description: 'Column number of the symbol end (inclusive). Defaults to column+1 if omitted.' },
            implementation: { type: 'boolean', description: 'If true, jump to the implementation rather than the declaration (default: false)' }
          },
          required: ['name', 'type', 'line', 'column']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_syntax_check':    return this.handleSyntaxCheck(args);
      case 'abap_atc_run':         return this.handleAtcRun(args);
      case 'abap_atc_variants':    return this.handleAtcVariants(args);
      case 'abap_where_used':      return this.handleWhereUsed(args);
      case 'abap_find_definition': return this.handleFindDefinition(args);
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
      this.fail('abap_where_used requires name (object name) and type (e.g. CLAS, VIEW, TABL). For class methods use type CLAS/OM with name="CLASS::METHOD" or name=class + method=method_name.');
    }
    try {
      let objectUrl: string;
      if (args.type?.toUpperCase() === 'CLAS/OM') {
        // Method where-used: name="CLASS::METHOD" or name=class + method=method_name
        let className: string;
        let methodName: string;
        if (args.method) {
          className = args.name;
          methodName = args.method;
        } else if (args.name.includes('::')) {
          [className, methodName] = args.name.split('::');
        } else {
          this.fail('For CLAS/OM where-used, provide name="CLASS::METHOD_NAME" or name=class + method=method_name.');
        }
        objectUrl = buildMethodUrl(className!, methodName!);
      } else {
        objectUrl = buildObjectUrl(args.name, args.type);
      }

      // Basis 759 (S/4HANA 2025) returns "usagereferences:" namespace prefix (all lowercase)
      // but the library's XML parser looks for "usageReferences:" (camelCase), giving 0 results.
      // Fix: inject a temporary Axios response interceptor to normalise the casing before parsing.
      // Safe on all basis versions — camelCase is correct per the SAP XML schema.
      const axiosInst = (this.adtclient as any).httpClient?.httpclient?.axios;
      let interceptorId: number | undefined;
      if (axiosInst?.interceptors?.response) {
        interceptorId = axiosInst.interceptors.response.use((resp: any) => {
          if (typeof resp.data === 'string' && resp.data.includes('usagereferences:')) {
            resp.data = resp.data.replace(/usagereferences:/g, 'usageReferences:');
          }
          return resp;
        });
      }

      let references: UsageReference[];
      try {
        references = await this.withSession(() =>
          this.adtclient.usageReferences(objectUrl, args.line, args.column)
        );
      } finally {
        if (axiosInst && interceptorId !== undefined) {
          axiosInst.interceptors.response.eject(interceptorId);
        }
      }

      // Use all references — isResult flag is unreliable across SAP versions
      const summary = references.map(r => ({
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
      if (args.snippets && references.length > 0) {
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
      // SAP silently falls back to DEFAULT if the variant name doesn't exist in SATC.
      const worklistId = await this.withSession(() =>
        this.adtclient.atcCheckVariant(variant)
      );

      // Step 1b: Fallback detection — if a non-DEFAULT variant was requested,
      // probe DEFAULT and compare IDs. Same ID = SAP silently fell back.
      // Intercept BEFORE running so results aren't silently from the wrong variant.
      let resolvedVariant = variant;
      if (variant !== 'DEFAULT') {
        try {
          const defaultWorklistId = await this.withSession(() =>
            this.adtclient.atcCheckVariant('DEFAULT')
          );
          if (worklistId === defaultWorklistId) {
            const choice = await this.elicitChoice(
              `Variant "${variant}" was not found in SATC — SAP would silently run DEFAULT instead.\n` +
              `Proceed with DEFAULT, or cancel and fix the variant name (check SATC, names are case-sensitive)?`,
              'action',
              ['Proceed with DEFAULT', 'Cancel'],
              'Cancel'
            );
            if (!choice || choice === 'Cancel') {
              this.fail(
                `abap_atc_run cancelled: variant "${variant}" does not exist in SATC. ` +
                `Use abap_atc_variants with probe_variant to test names, or check SATC transaction directly.`
              );
            }
            resolvedVariant = 'DEFAULT';
          }
        } catch (e: any) {
          // If the probe itself throws (e.g. elicitation not supported), proceed as before
          if (e.message?.includes('cancelled')) throw e;
        }
      }

      // Step 2: Trigger a fresh ATC run using the resolved ID.
      await this.notify(`Running ATC on ${args.name} (variant: ${variant})…`);
      const runResult = await this.withSession(() =>
        this.adtclient.createAtcRun(worklistId, objectUrl, 100)
      );

      // Step 3: Fetch findings using run ID + timestamp.
      await this.notify(`ATC run complete — fetching findings…`);
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

      return this.success({
        name: args.name,
        variant: resolvedVariant,
        requestedVariant: variant !== resolvedVariant ? variant : undefined,
        worklistId,
        runId: runResult.id,
        findings: grouped,
        totalFindings
      });
    } catch (error: any) {
      this.fail(formatError(`abap_atc_run(${args.name})`, error));
    }
  }

  private async handleAtcVariants(args: any): Promise<any> {
    try {
      // Get system-level ATC customizing (properties + exemption kinds)
      const customizing = await this.withSession(() =>
        this.adtclient.atcCustomizing()
      );

      // Probe DEFAULT worklist ID
      const defaultWorklistId = await this.withSession(() =>
        this.adtclient.atcCheckVariant('DEFAULT')
      ).catch(() => null);

      // Optionally probe a specific variant for fallback detection
      let probeResult: Record<string, any> | undefined;
      if (args.probe_variant && args.probe_variant !== 'DEFAULT') {
        try {
          const probeWorklistId = await this.withSession(() =>
            this.adtclient.atcCheckVariant(args.probe_variant)
          );
          const fellBack = probeWorklistId === defaultWorklistId;
          probeResult = {
            variant: args.probe_variant,
            worklistId: probeWorklistId,
            defaultWorklistId,
            fellBackToDefault: fellBack,
            diagnosis: fellBack
              ? `"${args.probe_variant}" does NOT exist in SATC — SAP returned the same worklistId as DEFAULT. Check SATC for the exact variant name (case-sensitive).`
              : `"${args.probe_variant}" is a valid variant — it returned a different worklistId than DEFAULT.`
          };
        } catch (e: any) {
          probeResult = { variant: args.probe_variant, error: e.message };
        }
      }

      return this.success({
        note: 'Variant names are configured in SATC transaction and cannot be listed via API. Use probe_variant to test if a specific name exists.',
        defaultWorklistId,
        systemProperties: customizing.properties,
        exemptionKinds: customizing.excemptions,
        ...(probeResult ? { probeResult } : {})
      });
    } catch (error: any) {
      this.fail(formatError('abap_atc_variants', error));
    }
  }

  private async handleFindDefinition(args: any): Promise<any> {
    try {
      const sourceUrl = buildSourceUrl(args.name, args.type);
      const source = await this.withSession(() =>
        this.adtclient.getObjectSource(sourceUrl)
      ) as string;

      const startCol = args.column;
      const endCol = args.end_column ?? args.column + 1;
      const implementation = args.implementation ?? false;

      const location = await this.withSession(() =>
        this.adtclient.findDefinition(sourceUrl, source, args.line, startCol, endCol, implementation)
      );

      return this.success({
        name: args.name,
        type: args.type,
        definition: {
          uri: location.url,
          line: location.line,
          column: location.column
        }
      });
    } catch (error: any) {
      this.fail(formatError(`abap_find_definition(${args.name})`, error));
    }
  }
}
