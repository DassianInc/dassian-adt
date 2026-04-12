#!/usr/bin/env node

import { config } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { ADTClient, session_types } from 'abap-adt-api';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import { URL } from 'url';

import { SourceHandlers }    from './handlers/SourceHandlers.js';
import { ObjectHandlers }    from './handlers/ObjectHandlers.js';
import { RunHandlers }       from './handlers/RunHandlers.js';
import { TransportHandlers } from './handlers/TransportHandlers.js';
import { DataHandlers }      from './handlers/DataHandlers.js';
import { QualityHandlers }   from './handlers/QualityHandlers.js';
import { GitHandlers }       from './handlers/GitHandlers.js';
import { SystemHandlers }    from './handlers/SystemHandlers.js';
import { TestHandlers }      from './handlers/TestHandlers.js';
import { RapHandlers }       from './handlers/RapHandlers.js';
import { resolveSystemConfigs, AuthConfig } from './lib/auth.js';
import type { BaseHandler } from './handlers/BaseHandler.js';

config({ path: path.resolve(__dirname, '../.env') });

// ─── MCP Prompts ─────────────────────────────────────────────────────────────

interface PromptDef {
  name: string;
  description: string;
  messages: (args: Record<string, string>) => Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>;
}

const PROMPTS: PromptDef[] = [
  {
    name: 'fix-atc',
    description: 'Run ATC on an ABAP object, read all P1 findings, fix each one, and activate.',
    messages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Run ATC on the ABAP object "${args.name || '<name>'}" (type: ${args.type || 'CLAS'}).
For every Priority 1 finding:
1. Read the relevant source (use compact=true first for classes to understand the structure)
2. Fix the finding — prefer a real code fix over an exemption
3. Syntax-check before writing
4. After all fixes, activate the object
Report a summary of what was fixed.`
      }
    }]
  },
  {
    name: 'transport-review',
    description: 'List transport contents, syntax-check all objects, and report issues.',
    messages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Review transport "${args.transport || '<transport>'}":
1. List all objects in the transport with transport_contents
2. For each ABAP source object (CLAS, PROG, FUGR, INTF), run abap_syntax_check
3. Report any syntax errors with line numbers
4. If clean, confirm the transport is ready for release.`
      }
    }]
  },
  {
    name: 'class-overview',
    description: 'Get a compact interface summary of a class plus its where-used count.',
    messages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Give me an overview of ABAP class "${args.name || '<class name>'}":
1. Get the compact source (abap_get_source with compact=true) to see the full interface
2. Get the where-used count (abap_where_used) to understand how widely it's used
3. Summarize: what the class does, its public API, and how many things depend on it.`
      }
    }]
  },
  {
    name: 'release-transport',
    description: 'Check, syntax-validate, and release a transport.',
    messages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Prepare and release transport "${args.transport || '<transport>'}":
1. Show the transport contents
2. Syntax-check every ABAP object in the transport
3. If there are syntax errors, stop and report them — do NOT release
4. If all clean, release the transport (task first, then request)
5. Confirm the release status.`
      }
    }]
  },
];

// ─── Per-system handler bundle ────────────────────────────────────────────────

interface SystemEntry {
  auth: AuthConfig;
  client: ADTClient;
  handlers: BaseHandler[];
}

function createSystemEntry(
  auth: AuthConfig,
  elicitFn: (params: any) => Promise<{ action: string; content?: Record<string, any> }>,
  notifyFn: (level: 'info' | 'warning' | 'error', message: string) => Promise<void>,
  samplingFn: (systemPrompt: string, userMessage: string, maxTokens?: number) => Promise<string>
): SystemEntry {
  const client = new ADTClient(auth.url, auth.user, auth.password, auth.client, auth.language);
  client.stateful = session_types.stateful;

  const handlers: BaseHandler[] = [
    new SourceHandlers(client),
    new ObjectHandlers(client),
    new RunHandlers(client),
    new TransportHandlers(client),
    new DataHandlers(client),
    new QualityHandlers(client),
    new GitHandlers(client),
    new SystemHandlers(client),
    new TestHandlers(client),
    new RapHandlers(client),
  ];

  for (const h of handlers) {
    h.setElicit(elicitFn);
    h.setNotify(notifyFn);
    h.setSampling(samplingFn);
  }

  return { auth, client, handlers };
}

// ─── sap_system_id injection ─────────────────────────────────────────────────

/**
 * When multiple systems are configured, inject a required sap_system_id property
 * into every tool's inputSchema so the LLM knows to pass it.
 */
function injectSystemIdParam(tools: any[], systemIds: string[], defaultId: string): any[] {
  const systemIdProp = {
    type: 'string',
    description: `SAP system to target. Available: ${systemIds.join(', ')}. Default: ${defaultId}.`,
    enum: systemIds,
    default: defaultId,
  };

  return tools.map(tool => {
    const schema = tool.inputSchema as any;
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: { sap_system_id: systemIdProp, ...(schema.properties || {}) },
        // Not required — callers may omit to use the default
      }
    };
  });
}

// ─── Main server class ────────────────────────────────────────────────────────

export class AbapAdtServer extends Server {
  private systems: Map<string, SystemEntry>;
  private defaultSystemId: string;

  /** Single-system constructor (HTTP per-user mode: explicit credentials). */
  static fromBasicAuth(
    url: string,
    user: string,
    password: string,
    client?: string,
    language?: string
  ): AbapAdtServer {
    const auth: AuthConfig = {
      id: 'default',
      url,
      user,
      password,
      client: client ?? '',
      language: language ?? 'EN',
      authType: 'basic',
    };
    return new AbapAdtServer([[auth], 'default']);
  }

  constructor(resolved: [AuthConfig[], string]) {
    super(
      { name: 'dassian-adt', version: '2.0.0' },
      { capabilities: { tools: {}, logging: {}, prompts: {} } }
    );

    const [authConfigs, defaultId] = resolved;
    this.defaultSystemId = defaultId;
    this.systems = new Map();

    const elicitFn  = (params: any) => this.elicitInput(params);
    const notifyFn  = async (level: 'info' | 'warning' | 'error', message: string) => {
      await this.sendLoggingMessage({ level, data: message });
    };
    const samplingFn = async (systemPrompt: string, userMessage: string, maxTokens = 200): Promise<string> => {
      const caps = this.getClientCapabilities();
      if (!(caps as any)?.sampling) throw new Error('Client does not support sampling');
      const result = await this.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: userMessage } }],
        systemPrompt,
        maxTokens,
        includeContext: 'none',
      });
      return result.content.type === 'text' ? result.content.text : '';
    };

    for (const auth of authConfigs) {
      this.systems.set(auth.id, createSystemEntry(auth, elicitFn, notifyFn, samplingFn));
    }

    this.setupHandlers();
  }

  private getSystem(id?: string): SystemEntry {
    const target = id ?? this.defaultSystemId;
    const entry = this.systems.get(target);
    if (!entry) {
      const available = [...this.systems.keys()].join(', ');
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unknown sap_system_id "${target}". Available: ${available}`
      );
    }
    return entry;
  }

  private setupHandlers() {
    const systemIds    = [...this.systems.keys()];
    const multiSystem  = systemIds.length > 1;

    this.setRequestHandler(ListToolsRequestSchema, async () => {
      // All systems expose the same tool set — use the default system's schema.
      const entry = this.getSystem();
      const tools = entry.handlers.flatMap(h => h.getTools());
      return { tools: multiSystem ? injectSystemIdParam(tools, systemIds, this.defaultSystemId) : tools };
    });

    this.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: PROMPTS.map(p => ({ name: p.name, description: p.description }))
    }));

    this.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const p = PROMPTS.find(p => p.name === request.params.name);
      if (!p) throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${request.params.name}`);
      return { messages: p.messages(request.params.arguments || {}) };
    });

    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const args = { ...(rawArgs || {}) };

      // Extract and remove sap_system_id before dispatching to handler
      const systemId = args.sap_system_id as string | undefined;
      delete args.sap_system_id;

      const entry = this.getSystem(systemId);

      for (const handler of entry.handlers) {
        const tools = handler.getTools().map(t => t.name);
        if (tools.includes(name)) {
          try {
            const result = await handler.validateAndHandle(name, args);
            if (result?.content) return result;
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)
              }]
            };
          } catch (error: any) {
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, error.message || 'Unknown error');
          }
        }
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    });
  }

  /** Run in stdio mode. Reads SAP_SYSTEMS / SAP_SYSTEMS_FILE or falls back to single-system env vars. */
  async runStdio() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    const systemIds = [...this.systems.keys()];
    console.error(`dassian-adt v2.0 running on stdio — ${systemIds.length} system(s): ${systemIds.join(', ')}`);
    console.error(`Default system: ${this.defaultSystemId}`);
    console.error('Client capabilities:', JSON.stringify(this.getClientCapabilities(), null, 2));

    process.on('SIGINT',  async () => { await this.close(); process.exit(0); });
    process.on('SIGTERM', async () => { await this.close(); process.exit(0); });
  }
}

// ─── HTTP mode: service-account MCP server ───────────────────────────────────
//
// All systems use service accounts (Entra ID, XSUAA, or basic).
// Credentials are resolved once at startup from SAP_SYSTEMS_FILE / SAP_SYSTEMS
// (or single-system env vars as fallback).
// Each MCP session gets its own AbapAdtServer instance with pre-resolved configs.
//
// Optional auth:
//   MCP_API_KEY — require "Authorization: Bearer <key>" on all MCP requests.
//                 Set this when the server is internet-facing.

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: AbapAdtServer;
}

async function runHttp() {
  const port    = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
  const mcpPath = process.env.MCP_HTTP_PATH || '/mcp';
  const apiKey  = process.env.MCP_API_KEY;  // optional bearer token

  // Resolve all system configs once at startup — not per session.
  const [authConfigs, defaultId] = await resolveSystemConfigs();
  const systemIds = authConfigs.map(a => a.id);

  const sessions = new Map<string, HttpSession>();

  console.error(`dassian-adt v2.0 HTTP mode — ${systemIds.length} system(s): ${systemIds.join(', ')}`);
  console.error(`Default system: ${defaultId}`);
  if (apiKey) console.error('MCP endpoint protected by API key.');

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Health check (unauthenticated) ──────────────────────────────────────
    if (reqUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        sessions: sessions.size,
        systems: systemIds,
        defaultSystem: defaultId,
      }));
      return;
    }

    // ── Route to MCP endpoint ───────────────────────────────────────────────
    if (reqUrl.pathname !== mcpPath && !reqUrl.pathname.startsWith(mcpPath + '?')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // ── Optional API key check ──────────────────────────────────────────────
    if (apiKey) {
      const authHeader = req.headers['authorization'] || '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (provided !== apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', message: 'Valid Authorization: Bearer <MCP_API_KEY> required.' }));
        return;
      }
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // ── Existing session ────────────────────────────────────────────────────
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // ── New session ─────────────────────────────────────────────────────────
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = new AbapAdtServer([authConfigs, defaultId]);
    await server.connect(transport);

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.error(`[HTTP] Session closed: ${transport.sessionId} (${sessions.size} active)`);
      }
    };

    await transport.handleRequest(req, res);

    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, server });
      console.error(`[HTTP] New session: ${transport.sessionId} (${sessions.size} active)`);
    }
  });

  httpServer.listen(port, () => {
    console.error(`MCP endpoint: http://0.0.0.0:${port}${mcpPath}`);
    console.error(`Health check: http://0.0.0.0:${port}/health`);
  });

  process.on('SIGINT',  () => { httpServer.close(); process.exit(0); });
  process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });
}

// ─── Entry point ────────────────────────────────────────────────────────────

const mode = process.env.MCP_TRANSPORT || 'stdio';

if (mode === 'http') {
  runHttp().catch(console.error);
} else {
  resolveSystemConfigs()
    .then(resolved => new AbapAdtServer(resolved).runStdio())
    .catch(console.error);
}
