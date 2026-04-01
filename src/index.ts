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
import { renderLoginPage, renderLoginSuccess } from './auth/loginPage.js';

config({ path: path.resolve(__dirname, '../.env') });

// ─── MCP Prompts ─────────────────────────────────────────────────────────────
// Pre-built workflows callable as slash commands from Claude Code.

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

export class AbapAdtServer extends Server {
  private adtClient: ADTClient;
  private sourceHandlers:    SourceHandlers;
  private objectHandlers:    ObjectHandlers;
  private runHandlers:       RunHandlers;
  private transportHandlers: TransportHandlers;
  private dataHandlers:      DataHandlers;
  private qualityHandlers:   QualityHandlers;
  private gitHandlers:       GitHandlers;
  private systemHandlers:    SystemHandlers;

  constructor(sapUrl?: string, sapUser?: string, sapPassword?: string, sapClient?: string, sapLanguage?: string) {
    super(
      { name: 'dassian-adt', version: '2.0.0' },
      { capabilities: { tools: {}, logging: {}, prompts: {} } }
    );

    const url = sapUrl || process.env.SAP_URL;
    const user = sapUser || process.env.SAP_USER;
    const pass = sapPassword || process.env.SAP_PASSWORD;
    const client = sapClient || process.env.SAP_CLIENT;
    const language = sapLanguage || process.env.SAP_LANGUAGE;

    if (!url) throw new Error('SAP_URL is required.');
    if (!user || !pass) throw new Error('SAP_USER and SAP_PASSWORD are required.');

    this.adtClient = new ADTClient(url, user, pass, client, language);
    this.adtClient.stateful = session_types.stateful;

    this.sourceHandlers    = new SourceHandlers(this.adtClient);
    this.objectHandlers    = new ObjectHandlers(this.adtClient);
    this.runHandlers       = new RunHandlers(this.adtClient);
    this.transportHandlers = new TransportHandlers(this.adtClient);
    this.dataHandlers      = new DataHandlers(this.adtClient);
    this.qualityHandlers   = new QualityHandlers(this.adtClient);
    this.gitHandlers       = new GitHandlers(this.adtClient);
    this.systemHandlers    = new SystemHandlers(this.adtClient);

    const elicitFn = (params: any) => this.elicitInput(params);

    const notifyFn = async (level: 'info' | 'warning' | 'error', message: string) => {
      await this.sendLoggingMessage({ level, data: message });
    };

    const samplingFn = async (systemPrompt: string, userMessage: string, maxTokens = 200): Promise<string> => {
      const caps = this.getClientCapabilities();
      if (!(caps as any)?.sampling) {
        throw new Error('Client does not support sampling');
      }
      const result = await this.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: userMessage } }],
        systemPrompt,
        maxTokens,
        includeContext: 'none',
      });
      return result.content.type === 'text' ? result.content.text : '';
    };

    for (const handler of this.allHandlers()) {
      handler.setElicit(elicitFn);
      handler.setNotify(notifyFn);
      handler.setSampling(samplingFn);
    }

    this.setupHandlers();
  }

  private allHandlers() {
    return [
      this.sourceHandlers, this.objectHandlers, this.runHandlers,
      this.transportHandlers, this.dataHandlers, this.qualityHandlers,
      this.gitHandlers, this.systemHandlers,
    ];
  }

  private setupHandlers() {
    this.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.allHandlers().flatMap(h => h.getTools())
    }));

    this.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: PROMPTS.map(p => ({ name: p.name, description: p.description }))
    }));

    this.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const p = PROMPTS.find(p => p.name === request.params.name);
      if (!p) throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${request.params.name}`);
      const args = request.params.arguments || {};
      return { messages: p.messages(args) };
    });

    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      for (const handler of this.allHandlers()) {
        const tools = handler.getTools().map(t => t.name);
        if (tools.includes(name)) {
          try {
            const result = await handler.validateAndHandle(name, args || {});
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

  /** Run in stdio mode (default). Requires SAP_USER/SAP_PASSWORD in env. */
  async runStdio() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    const clientCaps = this.getClientCapabilities();
    console.error('dassian-adt v2.0 running on stdio');
    console.error('Client capabilities:', JSON.stringify(clientCaps, null, 2));

    process.on('SIGINT',  async () => { await this.close(); process.exit(0); });
    process.on('SIGTERM', async () => { await this.close(); process.exit(0); });
  }
}

// ─── HTTP mode: per-user auth via browser login page ────────────────────────

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: AbapAdtServer;
}

/** Pending sessions waiting for the user to log in via the browser. */
interface PendingSession {
  transport: StreamableHTTPServerTransport;
  sessionId: string;
}

function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const params: Record<string, string> = {};
      for (const pair of body.split('&')) {
        const [key, val] = pair.split('=').map(decodeURIComponent);
        if (key) params[key] = val || '';
      }
      resolve(params);
    });
    req.on('error', reject);
  });
}

async function runHttp() {
  const sapUrl = process.env.SAP_URL;
  if (!sapUrl) throw new Error('SAP_URL is required even in HTTP mode (all users connect to the same SAP system).');

  const port = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
  const mcpPath = process.env.MCP_HTTP_PATH || '/mcp';
  const sapClient = process.env.SAP_CLIENT;
  const sapLanguage = process.env.SAP_LANGUAGE;

  // Shared service account (optional fallback — if SAP_USER + SAP_PASSWORD are set, skip login page)
  const sharedUser = process.env.SAP_USER;
  const sharedPass = process.env.SAP_PASSWORD;
  const requireLogin = !sharedUser || !sharedPass;

  const sessions = new Map<string, HttpSession>();
  // Pending sessions: MCP handshake done, but user hasn't logged in yet
  const pendingSessions = new Map<string, PendingSession>();
  // Session → SAP credentials (set after user logs in via /login)
  const sessionCredentials = new Map<string, { user: string; password: string }>();

  if (requireLogin) {
    console.error('[HTTP] Per-user auth mode: users will log in via /login page');
  } else {
    console.error(`[HTTP] Shared service account mode: ${sharedUser}`);
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Health check ──
    if (reqUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        sessions: sessions.size,
        pendingLogins: pendingSessions.size,
        authMode: requireLogin ? 'per-user' : 'shared'
      }));
      return;
    }

    // ── Login page (GET) ──
    if (reqUrl.pathname === '/login' && req.method === 'GET') {
      const sessionId = reqUrl.searchParams.get('session') || '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderLoginPage(sapUrl!, sessionId));
      return;
    }

    // ── Login submit (POST) ──
    if (reqUrl.pathname === '/login' && req.method === 'POST') {
      const body = await parseFormBody(req);
      const sessionId = body.session || '';
      const username = body.username?.trim();
      const password = body.password;

      if (!username || !password) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderLoginPage(sapUrl!, sessionId, 'Username and password are required.'));
        return;
      }

      // Validate credentials by attempting an ADT login
      try {
        const testClient = new ADTClient(sapUrl!, username, password, sapClient, sapLanguage);
        testClient.stateful = session_types.stateful;
        await testClient.login();
        await testClient.logout();
      } catch (e: any) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderLoginPage(sapUrl!, sessionId, `SAP login failed: ${e.message || 'Invalid credentials'}`));
        return;
      }

      // Store credentials for this session
      sessionCredentials.set(sessionId, { user: username, password });
      console.error(`[HTTP] User ${username} authenticated for session ${sessionId}`);

      // If there's a pending session, promote it to active
      const pending = pendingSessions.get(sessionId);
      if (pending) {
        try {
          const server = new AbapAdtServer(sapUrl!, username, password, sapClient, sapLanguage);
          await server.connect(pending.transport);
          sessions.set(sessionId, { transport: pending.transport, server });
          pendingSessions.delete(sessionId);
          console.error(`[HTTP] Session ${sessionId} activated for ${username} (${sessions.size} active)`);
        } catch (err: any) {
          console.error(`[HTTP] Failed to activate session ${sessionId}: ${err.message}`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderLoginSuccess());
      return;
    }

    // ── MCP endpoint ──
    if (reqUrl.pathname !== mcpPath && !reqUrl.pathname.startsWith(mcpPath + '?')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Existing active session
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    // Existing pending session — user hasn't logged in yet.
    // Allow DELETE through so the MCP client can terminate the session cleanly
    // (triggers onclose, which cleans up pendingSessions/sessionCredentials).
    // All other methods get a 401 directing the user to the login page.
    if (sessionId && pendingSessions.has(sessionId)) {
      if (req.method === 'DELETE') {
        const pending = pendingSessions.get(sessionId)!;
        await pending.transport.handleRequest(req, res);
        return;
      }
      const loginUrl = `/login?session=${encodeURIComponent(sessionId)}`;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Authentication required',
        message: `SAP login required. Open ${loginUrl} in your browser to connect, then retry.`,
        loginUrl
      }));
      return;
    }

    // Invalid session
    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    if (!requireLogin) {
      // Shared service account — create server immediately
      const server = new AbapAdtServer(sapUrl!, sharedUser!, sharedPass!, sapClient, sapLanguage);
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
        console.error(`[HTTP] New session: ${transport.sessionId} [${sharedUser}] (${sessions.size} active)`);
      }
    } else {
      // Per-user auth — the MCP handshake needs a real server to negotiate the session ID.
      // Check if the user already authenticated (login-before-connect race).
      // If not, use a temporary server for the handshake, then park the session as pending.
      // Subsequent requests on a pending session get a clear 401 + login URL (handled above).

      // For the initial handshake we need a connected server. The handshake itself (initialize,
      // listTools) doesn't touch SAP, so dummy creds are fine for this single request.
      const handshakeServer = new AbapAdtServer(sapUrl!, '_HANDSHAKE_', '_HANDSHAKE_', sapClient, sapLanguage);
      await handshakeServer.connect(transport);

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          pendingSessions.delete(transport.sessionId);
          sessionCredentials.delete(transport.sessionId);
          console.error(`[HTTP] Session closed: ${transport.sessionId}`);
        }
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        // Check if user already logged in (race condition: login before MCP connect)
        const creds = sessionCredentials.get(transport.sessionId);
        if (creds) {
          const realServer = new AbapAdtServer(sapUrl!, creds.user, creds.password, sapClient, sapLanguage);
          await realServer.connect(transport);
          sessions.set(transport.sessionId, { transport, server: realServer });
          console.error(`[HTTP] New session: ${transport.sessionId} [${creds.user}] (${sessions.size} active)`);
        } else {
          pendingSessions.set(transport.sessionId, { transport, sessionId: transport.sessionId });
          console.error(`[HTTP] Pending login: ${transport.sessionId} — user must visit /login?session=${transport.sessionId}`);
        }
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`dassian-adt v2.0 running on http://0.0.0.0:${port}${mcpPath}`);
    console.error(`Login page: http://0.0.0.0:${port}/login`);
    console.error(`Health check: http://0.0.0.0:${port}/health`);
    console.error(`SAP system: ${sapUrl}`);
    if (requireLogin) {
      console.error('Auth mode: per-user (users log in via /login page)');
    } else {
      console.error(`Auth mode: shared service account (${sharedUser})`);
    }
  });

  process.on('SIGINT',  () => { httpServer.close(); process.exit(0); });
  process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });
}

// ─── Entry point ────────────────────────────────────────────────────────────

const mode = process.env.MCP_TRANSPORT || 'stdio';

if (mode === 'http') {
  runHttp().catch(console.error);
} else {
  // Stdio mode — requires SAP_USER + SAP_PASSWORD in env
  const server = new AbapAdtServer();
  server.runStdio().catch(console.error);
}
