import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';

export class GitHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'git_repos',
        annotations: { readOnlyHint: true },
        description: 'List all gCTS repositories registered on this SAP system.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'git_pull',
        description:
          'Pull from a gCTS repository, importing commits into the SAP system. ' +
          'Used in the cherry-pick pipeline to import transports across systems.',
        inputSchema: {
          type: 'object',
          properties: {
            repoId: { type: 'string', description: 'Repository ID or URL as returned by git_repos' },
            branch: { type: 'string', description: 'Branch to pull from (default: current branch)' }
          },
          required: ['repoId']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'git_repos': return this.handleRepos();
      case 'git_pull':  return this.handlePull(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleRepos(): Promise<any> {
    try {
      const repos = await this.withSession(() => this.adtclient.gitRepos());
      return this.success({ repos });
    } catch (error: any) {
      this.fail(formatError('git_repos', error));
    }
  }

  private async handlePull(args: any): Promise<any> {
    try {
      const result = await this.withSession(() =>
        this.adtclient.gitPullRepo(args.repoId, args.branch)
      );
      return this.success({ result });
    } catch (error: any) {
      this.fail(formatError(`git_pull(${args.repoId})`, error));
    }
  }
}
