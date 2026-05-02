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
import { randomUUID, createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
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
import { TraceHandlers }     from './handlers/TraceHandlers.js';
import { DdicHandlers }      from './handlers/DdicHandlers.js';
import { resolveSystemConfigs, AuthConfig } from './lib/auth.js';
import { logToolError, extractRawResponse } from './lib/logger.js';
import { parseAdtError } from './lib/errors.js';
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
    new TraceHandlers(client),
    new DdicHandlers(client),
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
            // Log soft failures (activation errors, batch failures) returned as success:false / activated:false
            try {
              const text = result?.content?.[0]?.text
                ?? JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v);
              const parsed = JSON.parse(text);
              if (parsed.activated === false || parsed.success === false) {
                const msgs: string[] = parsed.messages || parsed.errors || [];
                logToolError({
                  tool: name,
                  system: systemId,
                  error_type: 'soft_failure',
                  message: msgs.join(' | ') || 'Tool returned failure',
                  args
                });
              }
            } catch (_) {}
            if (result?.content) return result;
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)
              }]
            };
          } catch (error: any) {
            const info = parseAdtError(error);
            const errorType = info.isSessionTimeout   ? 'session_timeout'
                            : info.isLocked           ? 'locked'
                            : info.isNotFound         ? 'not_found'
                            : info.isUpgradeMode      ? 'upgrade_mode'
                            : info.isLockNotSupported ? 'lock_not_supported'
                            :                           'internal';
            const raw = info.httpStatus === 400 ? extractRawResponse(error) : {};
            logToolError({
              tool: name,
              system: systemId,
              error_type: errorType,
              message: error.message || 'Unknown error',
              http_status: info.httpStatus,
              args,
              raw_headers: raw.headers,
              raw_body: raw.body
            });
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

// ─── OAuth: per-user auth ─────────────────────────────────────────────────────

interface SystemTemplate { id: string; url: string; client: string; language: string; }

interface OAuthSession { authConfigs: AuthConfig[]; defaultId: string; }

interface PendingCode {
  session: OAuthSession;
  redirectUri: string; clientId: string; state: string;
  codeChallenge?: string; codeChallengeMethod?: string;
  expiresAt: number;
}

const TOKEN_TTL_MS  = 30 * 24 * 3600 * 1000; // 30 days
const TOKEN_FILE    = process.env.TOKEN_FILE || '/home/mcp-tokens.json';

interface IssuedToken { session: OAuthSession; expiresAt: number; }

function loadTokensFromDisk(): Map<string, IssuedToken> {
  const map = new Map<string, IssuedToken>();
  try {
    const raw = readFileSync(TOKEN_FILE, 'utf-8');
    const stored: Record<string, IssuedToken> = JSON.parse(raw);
    const now = Date.now();
    for (const [tok, entry] of Object.entries(stored)) {
      if (entry.expiresAt > now) map.set(tok, entry);
    }
    console.error(`[TOKENS] Loaded ${map.size} valid token(s) from disk`);
  } catch { /* file absent or corrupt — start fresh */ }
  return map;
}

function saveTokensToDisk(tokens: Map<string, IssuedToken>): void {
  try {
    const obj: Record<string, IssuedToken> = {};
    for (const [tok, entry] of tokens) obj[tok] = entry;
    writeFileSync(TOKEN_FILE, JSON.stringify(obj), 'utf-8');
  } catch (e) { console.error(`[TOKENS] Failed to persist tokens: ${e}`); }
}

const pendingCodes = new Map<string, PendingCode>();
const issuedTokens = loadTokensFromDisk();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingCodes) if (v.expiresAt < now) pendingCodes.delete(k);
  let expired = 0;
  for (const [k, v] of issuedTokens) if (v.expiresAt < now) { issuedTokens.delete(k); expired++; }
  if (expired > 0) { console.error(`[TOKENS] Purged ${expired} expired token(s)`); saveTokensToDisk(issuedTokens); }
}, 600_000);

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === 'plain') return verifier === challenge;
  if (method === 'S256') {
    const encoded = createHash('sha256').update(verifier).digest()
      .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    return encoded === challenge;
  }
  return false;
}

function buildLoginHtml(
  templates: SystemTemplate[],
  params: { clientId: string; redirectUri: string; state: string; codeChallenge?: string; codeChallengeMethod?: string },
  error?: string
): string {
  const rows = templates.map(t =>
    `<tr><td class="sn">${escHtml(t.id.toUpperCase())}</td>` +
    `<td class="su">${escHtml(t.url)}</td>` +
    `<td><input type="password" name="password_${escHtml(t.id)}" placeholder="Password" autocomplete="current-password"></td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dassian ADT — SAP Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px}
.card{background:#fff;border-radius:10px;box-shadow:0 2px 16px rgba(0,0,0,.1);padding:32px;width:100%;max-width:680px}
h1{font-size:20px;font-weight:700;color:#111;margin-bottom:4px}
.sub{color:#666;font-size:14px;margin-bottom:24px}
.err{background:#fff5f5;border:1px solid #fed7d7;color:#c53030;padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:16px}
.field{margin-bottom:14px}
label{display:block;font-size:13px;font-weight:500;color:#444;margin-bottom:5px}
input[type=text],input[type=password]{width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;outline:none;transition:border .15s}
input:focus{border-color:#0070f3;box-shadow:0 0 0 3px rgba(0,112,243,.12)}
.fill-row{display:flex;gap:8px;align-items:flex-end;margin-bottom:14px}
.fill-row .field{flex:1;margin-bottom:0}
.fill-btn{padding:8px 14px;background:#f1f5f9;border:1px solid #d1d5db;border-radius:6px;font-size:13px;cursor:pointer;white-space:nowrap;height:38px}
.fill-btn:hover{background:#e2e8f0}
.tbl-wrap{max-height:360px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{position:sticky;top:0;background:#f8f9fa;padding:8px 10px;text-align:left;border-bottom:1px solid #e5e7eb;color:#555;font-weight:500;z-index:1}
tbody tr:hover{background:#fafafa}
td{padding:6px 10px;border-bottom:1px solid #f3f4f6;vertical-align:middle}
tr:last-child td{border-bottom:none}
.sn{font-weight:600;white-space:nowrap;width:56px}
.su{color:#888;font-size:11px;font-family:monospace;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td input{width:100%;padding:5px 9px;font-size:13px}
.btn{width:100%;padding:11px;background:#0070f3;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer}
.btn:hover{background:#005ce6}
</style>
</head>
<body>
<div class="card">
  <h1>Dassian ADT</h1>
  <p class="sub">Sign in with your SAP credentials to connect to ABAP development tools.</p>
  ${error ? `<div class="err">${escHtml(error)}</div>` : ''}
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${escHtml(params.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escHtml(params.redirectUri)}">
    <input type="hidden" name="state" value="${escHtml(params.state)}">
    ${params.codeChallenge ? `<input type="hidden" name="code_challenge" value="${escHtml(params.codeChallenge)}">` : ''}
    ${params.codeChallengeMethod ? `<input type="hidden" name="code_challenge_method" value="${escHtml(params.codeChallengeMethod)}">` : ''}
    <div class="field">
      <label for="un">SAP Username</label>
      <input type="text" id="un" name="username" placeholder="e.g. JSMITH" autocomplete="username" required>
    </div>
    <div class="fill-row">
      <div class="field">
        <label for="gpw">Fill all passwords at once</label>
        <input type="password" id="gpw" placeholder="Common password" autocomplete="new-password">
      </div>
      <button type="button" class="fill-btn" onclick="fillAll()">Fill All ↓</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>System</th><th>URL</th><th>Password</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <button type="submit" class="btn">Connect</button>
  </form>
</div>
<script>
function fillAll(){var pw=document.getElementById('gpw').value;document.querySelectorAll('input[name^="password_"]').forEach(function(i){i.value=pw;});}
document.getElementById('gpw').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();fillAll();}});
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: AbapAdtServer;
}

async function runHttp() {
  const port     = parseInt(process.env.PORT || process.env.MCP_HTTP_PORT || '3000', 10);
  const mcpPath  = process.env.MCP_HTTP_PATH || '/';
  console.error(`[CONFIG] PORT=${port} MCP_HTTP_PATH=${mcpPath} MCP_AUTH_MODE=${process.env.MCP_AUTH_MODE}`);
  // MCP_AUTH_MODE:
  //   service (default) — all sessions use SAP_SYSTEMS service account credentials, no OAuth
  //   oauth             — OAuth login required; users supply their own SAP credentials
  //   hybrid            — OAuth users get their own creds; unauthenticated falls back to service account
  const authMode = (process.env.MCP_AUTH_MODE || 'service') as 'service' | 'oauth' | 'hybrid';

  // Load global system configs (service/hybrid mode credentials + system list for OAuth form).
  let authConfigs: AuthConfig[] = [];
  let defaultId = '';
  try {
    [authConfigs, defaultId] = await resolveSystemConfigs();
  } catch (e) {
    if (authMode === 'service') throw e; // credentials required in service mode
    // oauth/hybrid: OK if no global credentials — system list comes from SAP_SYSTEMS_TEMPLATE
  }

  // System templates for the OAuth login form.
  // SAP_SYSTEMS_TEMPLATE: JSON array of {id,url,client?,language?} with no credentials.
  // Falls back to deriving from SAP_SYSTEMS if not set.
  let systemTemplates: SystemTemplate[];
  const templateEnv = process.env.SAP_SYSTEMS_TEMPLATE;
  if (templateEnv) {
    systemTemplates = JSON.parse(templateEnv) as SystemTemplate[];
  } else {
    systemTemplates = authConfigs.map(a => ({ id: a.id, url: a.url, client: a.client, language: a.language }));
  }

  const systemIds = authConfigs.map(a => a.id);
  console.error(`dassian-adt v2.0 HTTP mode (${authMode}) — ${systemTemplates.length} system(s): ${systemTemplates.map(t => t.id).join(', ')}`);
  if (defaultId) console.error(`Default system: ${defaultId}`);

  const sessions = new Map<string, HttpSession>();

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
        status: 'ok', sessions: sessions.size, authMode,
        systems: systemTemplates.map(t => t.id),
        defaultSystem: defaultId || systemTemplates[0]?.id,
      }));
      return;
    }

    // Log all requests for OAuth debugging
    console.error(`[REQ] ${req.method} ${reqUrl.pathname}${reqUrl.search || ''} | auth:${(req.headers['authorization']||'').slice(0,20)||'none'}`);

    // ── OAuth: protected resource metadata ─────────────────────────────────
    if (reqUrl.pathname === '/.well-known/oauth-protected-resource') {
      const base = `https://${req.headers.host}`;
      const resource = mcpPath === '/' ? base : `${base}${mcpPath}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resource, authorization_servers: [base] }));
      return;
    }

    // ── OAuth: authorization server metadata ────────────────────────────────
    if (reqUrl.pathname === '/.well-known/oauth-authorization-server') {
      const base = `https://${req.headers.host}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [],
        client_id_metadata_document_supported: true,
      }));
      return;
    }

    // ── OAuth: Dynamic Client Registration ─────────────────────────────────
    if (reqUrl.pathname === '/oauth/register' && req.method === 'POST') {
      const body = await readBody(req);
      const ct = req.headers['content-type'] || '';
      let reg: any = {};
      try { reg = ct.includes('application/json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)); }
      catch { /* leave reg empty */ }
      const clientId = typeof reg.client_id === 'string' && reg.client_id ? reg.client_id : randomUUID();
      console.error(`[DCR] register client_id=${clientId} redirect_uris=${JSON.stringify(reg.redirect_uris || [])}`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: reg.redirect_uris || [],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(reg.client_name ? { client_name: reg.client_name } : {}),
        ...(reg.client_uri  ? { client_uri:  reg.client_uri  } : {}),
      }));
      return;
    }

    // ── OAuth: show login form ──────────────────────────────────────────────
    if (reqUrl.pathname === '/oauth/authorize' && req.method === 'GET') {
      const p = {
        clientId:            reqUrl.searchParams.get('client_id')             || '',
        redirectUri:         reqUrl.searchParams.get('redirect_uri')          || '',
        state:               reqUrl.searchParams.get('state')                 || '',
        codeChallenge:       reqUrl.searchParams.get('code_challenge')        || undefined,
        codeChallengeMethod: reqUrl.searchParams.get('code_challenge_method') || undefined,
      };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildLoginHtml(systemTemplates, p));
      return;
    }

    // ── OAuth: process login ────────────────────────────────────────────────
    if (reqUrl.pathname === '/oauth/authorize' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const username           = (form.get('username')             || '').trim();
      const clientId           = form.get('client_id')             || '';
      const redirectUri        = form.get('redirect_uri')          || '';
      const state              = form.get('state')                 || '';
      const codeChallenge      = form.get('code_challenge')        || undefined;
      const codeChallengeMethod = form.get('code_challenge_method') || undefined;
      const p = { clientId, redirectUri, state, codeChallenge, codeChallengeMethod };

      if (!username) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildLoginHtml(systemTemplates, p, 'SAP username is required.'));
        return;
      }

      const newConfigs: AuthConfig[] = [];
      for (const tmpl of systemTemplates) {
        const password = (form.get(`password_${tmpl.id}`) || '').trim();
        if (!password) continue;
        newConfigs.push({
          id: tmpl.id, url: tmpl.url, user: username, password,
          client: tmpl.client, language: tmpl.language, authType: 'basic',
        });
      }

      if (newConfigs.length === 0) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildLoginHtml(systemTemplates, p, 'Enter a password for at least one system.'));
        return;
      }

      const code = randomUUID();
      pendingCodes.set(code, {
        session: { authConfigs: newConfigs, defaultId: newConfigs[0].id },
        redirectUri, clientId, state, codeChallenge, codeChallengeMethod,
        expiresAt: Date.now() + 600_000,
      });

      const dest = new URL(redirectUri);
      dest.searchParams.set('code', code);
      if (state) dest.searchParams.set('state', state);
      console.error(`[AUTH] redirect_uri=${redirectUri} state=${state ? state.slice(0,12)+'...' : 'MISSING'} callback=${dest.toString().slice(0,80)}`);
      const callbackUrlJs = JSON.stringify(dest.toString()); // safe for JS string — do NOT escHtml here
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Authenticated</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5}
.card{background:#fff;border-radius:10px;box-shadow:0 2px 16px rgba(0,0,0,.1);padding:40px;text-align:center;max-width:400px}
h2{color:#111;margin-bottom:8px}p{color:#666;font-size:14px}</style>
</head><body>
<div class="card">
  <h2>&#x2713; Authenticated</h2>
  <p>Returning to Claude Code&hellip;</p>
</div>
<script>
window.location.href = ${callbackUrlJs};
</script>
</body></html>`);
      return;
    }

    // ── OAuth: token exchange ───────────────────────────────────────────────
    if (reqUrl.pathname === '/oauth/token' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const ct = req.headers['content-type'] || '';
      let tok: any = {};
      try { tok = ct.includes('application/json') ? JSON.parse(rawBody) : Object.fromEntries(new URLSearchParams(rawBody)); }
      catch { /* leave tok empty */ }
      const code         = String(tok.code          || '');
      const codeVerifier = String(tok.code_verifier || '');
      console.error(`[TOKEN] code=${code.slice(0,8)}... verifier=${codeVerifier ? 'present' : 'absent'} ct=${ct.split(';')[0]}`);
      const pending      = pendingCodes.get(code);

      if (!pending || pending.expiresAt < Date.now()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired or not found.' }));
        return;
      }

      if (pending.codeChallenge && codeVerifier) {
        if (!verifyPkce(codeVerifier, pending.codeChallenge, pending.codeChallengeMethod || 'plain')) {
          pendingCodes.delete(code);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed.' }));
          return;
        }
      }

      pendingCodes.delete(code);
      const token = randomUUID();
      issuedTokens.set(token, { session: pending.session, expiresAt: Date.now() + TOKEN_TTL_MS });
      saveTokensToDisk(issuedTokens);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_MS / 1000 }));
      return;
    }

    // ── Route to MCP endpoint ───────────────────────────────────────────────
    if (reqUrl.pathname !== mcpPath && !reqUrl.pathname.startsWith(mcpPath + '?')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // ── Resolve credentials for this session ────────────────────────────────
    const authHeader  = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    let sessionAuth: [AuthConfig[], string] | null = null;

    const apiKey = process.env.MCP_API_KEY;
    if (bearerToken && issuedTokens.has(bearerToken)) {
      const entry = issuedTokens.get(bearerToken)!;
      if (entry.expiresAt > Date.now()) {
        sessionAuth = [entry.session.authConfigs, entry.session.defaultId];
      }
    } else if (apiKey && bearerToken === apiKey && authConfigs.length > 0) {
      sessionAuth = [authConfigs, defaultId];
    } else if ((authMode === 'service' || authMode === 'hybrid') && authConfigs.length > 0) {
      sessionAuth = [authConfigs, defaultId];
    }

    if (!sessionAuth) {
      const base = `https://${req.headers.host}`;
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Dassian ADT", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: 'Unauthorized', message: 'Sign in at ' + base + '/oauth/authorize' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // ── Existing session ────────────────────────────────────────────────────
    if (sessionId && sessions.has(sessionId)) {
      const rawBody = await readBody(req);
      let parsedBody: unknown;
      try { parsedBody = rawBody ? JSON.parse(rawBody) : undefined; } catch { /* not JSON */ }
      await sessions.get(sessionId)!.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // ── New session ─────────────────────────────────────────────────────────
    try {
      const rawBody = await readBody(req);
      let parsedBody: unknown;
      try { parsedBody = rawBody ? JSON.parse(rawBody) : undefined; } catch { /* not JSON */ }
      console.error(`[MCP-INIT] ${req.method} ct:${(req.headers['content-type']||'').split(';')[0]} body:${rawBody.slice(0,300)}`);

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server    = new AbapAdtServer(sessionAuth!);
      await server.connect(transport);

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          console.error(`[HTTP] Session closed: ${transport.sessionId} (${sessions.size} active)`);
        }
      };

      await transport.handleRequest(req, res, parsedBody);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server });
        console.error(`[HTTP] New session: ${transport.sessionId} (${sessions.size} active)`);
      } else {
        console.error(`[MCP-INIT] No session ID — transport did not initialize (method=${req.method})`);
      }
    } catch (err: any) {
      console.error(`[MCP-INIT] Error: ${err?.message || err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error', message: err?.message }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`MCP endpoint: http://0.0.0.0:${port}${mcpPath}`);
    console.error(`Health check: http://0.0.0.0:${port}/health`);
    if (authMode !== 'service') console.error(`OAuth login:   https://dassian-adt-mcp.azurewebsites.net/oauth/authorize`);
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
