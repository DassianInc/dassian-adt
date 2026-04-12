import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl } from '../lib/urlBuilder.js';
import { formatError } from '../lib/errors.js';
import type { UnitTestClass, UnitTestRunFlags } from 'abap-adt-api';

export class TestHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_unit_test',
        description:
          'Run ABAP Unit tests for an object and return pass/fail results. ' +
          'Returns a summary (total/passed/failed/errors) plus per-method detail for failures. ' +
          'Failed tests include the assertion message, details, and stack trace with source locations. ' +
          'Supports classes (CLAS) and programs (PROG/P) that contain local test classes.',
        inputSchema: {
          type: 'object',
          properties: {
            name:     { type: 'string', description: 'Object name (e.g. /DSN/CL_MY_CLASS)' },
            type:     { type: 'string', description: 'Object type — CLAS or PROG/P (default: CLAS)' },
            risk:     { type: 'string', description: 'Risk level filter: harmless, dangerous, critical, or all (default: all)', enum: ['harmless', 'dangerous', 'critical', 'all'] },
            duration: { type: 'string', description: 'Duration filter: short, medium, long, or all (default: all)', enum: ['short', 'medium', 'long', 'all'] }
          },
          required: ['name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_unit_test': return this.handleUnitTest(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleUnitTest(args: any): Promise<any> {
    const type = args.type || 'CLAS';
    const objectUrl = buildObjectUrl(args.name, type);

    const flags: UnitTestRunFlags = {
      harmless: args.risk === 'harmless' || !args.risk || args.risk === 'all',
      dangerous: args.risk === 'dangerous' || !args.risk || args.risk === 'all',
      critical:  args.risk === 'critical'  || !args.risk || args.risk === 'all',
      short:     args.duration === 'short'  || !args.duration || args.duration === 'all',
      medium:    args.duration === 'medium' || !args.duration || args.duration === 'all',
      long:      args.duration === 'long'   || !args.duration || args.duration === 'all',
    };

    try {
      await this.notify(`Running unit tests on ${args.name}…`);
      const classes = await this.withSession(() =>
        this.adtclient.unitTestRun(objectUrl, flags)
      ) as UnitTestClass[];

      if (!classes || classes.length === 0) {
        return this.success({
          name: args.name,
          summary: { total: 0, passed: 0, failed: 0, errors: 0 },
          note: 'No test classes found. Ensure the object contains local test classes (CLASS ... FOR TESTING).'
        });
      }

      let total = 0, passed = 0, failed = 0, errors = 0;
      const classResults: any[] = [];

      for (const cls of classes) {
        const methods = cls.testmethods || [];
        const classAlerts = cls.alerts || [];
        const methodResults: any[] = [];

        for (const method of methods) {
          total++;
          const alerts = method.alerts || [];
          const hasFail = alerts.some(a => a.kind === 'failedAssertion');
          const hasError = alerts.some(a => a.kind === 'exception');

          if (hasError)       errors++;
          else if (hasFail)   failed++;
          else                passed++;

          if (alerts.length > 0) {
            methodResults.push({
              method: method['adtcore:name'],
              executionTime: method.executionTime,
              status: hasError ? 'error' : hasFail ? 'failed' : 'passed',
              alerts: alerts.map(a => ({
                kind: a.kind,
                severity: a.severity,
                title: a.title,
                details: a.details,
                stack: a.stack?.map(s => ({
                  uri: s['adtcore:uri'],
                  name: s['adtcore:name'],
                  description: s['adtcore:description']
                }))
              }))
            });
          }
        }

        // Class-level alerts (setup/teardown failures)
        if (classAlerts.length > 0 && methodResults.length === 0) {
          errors++;
          total++;
        }

        classResults.push({
          class: cls['adtcore:name'],
          riskLevel: cls.riskLevel,
          durationCategory: cls.durationCategory,
          ...(methodResults.length > 0 ? { failures: methodResults } : {}),
          ...(classAlerts.length > 0 ? {
            classAlerts: classAlerts.map(a => ({ kind: a.kind, title: a.title, details: a.details }))
          } : {})
        });
      }

      const summary = { total, passed, failed, errors };
      const allPassed = failed === 0 && errors === 0;

      return this.success({
        name: args.name,
        summary,
        status: allPassed ? 'ALL PASSED' : `${failed + errors} FAILURE(S)`,
        classes: allPassed
          ? classResults.map(c => ({ class: c.class }))  // compact on full pass
          : classResults
      });
    } catch (error: any) {
      this.fail(formatError(`abap_unit_test(${args.name})`, error));
    }
  }
}
