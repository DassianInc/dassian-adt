import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';

export class RapHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'rap_publish_binding',
        description:
          'Publish or unpublish an OData service binding on the SAP system. ' +
          'Publishing generates the service URL and makes it accessible for consumption. ' +
          'Use after creating or updating a SRVB (service binding) object. ' +
          'Returns the SAP response message indicating success or any issues.',
        inputSchema: {
          type: 'object',
          properties: {
            name:    { type: 'string', description: 'Service binding name (e.g. /DSN/UI_MYSERVICE_O4)' },
            version: { type: 'string', description: 'Binding version number (e.g. 0001)' },
            action:  { type: 'string', description: 'publish or unpublish', enum: ['publish', 'unpublish'] }
          },
          required: ['name', 'version', 'action']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'rap_publish_binding': return this.handlePublishBinding(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handlePublishBinding(args: any): Promise<any> {
    const { name, version, action } = args;
    try {
      await this.notify(`${action === 'publish' ? 'Publishing' : 'Unpublishing'} service binding ${name} v${version}…`);

      const result = action === 'publish'
        ? await this.withSession(() => this.adtclient.publishServiceBinding(name, version))
        : await this.withSession(() => this.adtclient.unPublishServiceBinding(name, version));

      return this.success({
        name,
        version,
        action,
        severity: result.severity,
        message: result.shortText,
        detail: result.longText || undefined
      });
    } catch (error: any) {
      this.fail(formatError(`rap_publish_binding(${name})`, error));
    }
  }
}
