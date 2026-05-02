import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

// On Azure App Service, WEBSITE_SITE_NAME is always set; /home/LogFiles is the persistent shared mount.
const ERROR_LOG_FILE = process.env.ADT_ERROR_LOG
  || (process.env.WEBSITE_SITE_NAME ? '/home/LogFiles/dassian-adt-errors.jsonl' : path.join(os.homedir(), '.dassian-adt', 'errors.jsonl'));

export interface ToolErrorEntry {
  tool: string;
  system?: string;
  error_type?: string;
  message: string;
  http_status?: number;
  args?: Record<string, unknown>;
  /** Diagnostic-only: raw response headers + body snippet for HTTP 400s, used to fingerprint session drops vs real bad-requests. */
  raw_headers?: Record<string, unknown>;
  raw_body?: string;
}

// Truncate long string fields so a call like abap_set_source (with multi-KB source)
// doesn't bloat the log. Keeps enough to identify the call (name, type, transport, etc.).
function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 120) out[k] = v.slice(0, 120) + `…(+${v.length - 120})`;
    else out[k] = v;
  }
  return out;
}

export function logToolError(entry: ToolErrorEntry): void {
  const { args, ...rest } = entry;
  const record = {
    ts: new Date().toISOString(),
    ...rest,
    ...(args ? { args: compactArgs(args) } : {})
  };
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG_FILE), { recursive: true });
    fs.appendFileSync(ERROR_LOG_FILE, JSON.stringify(record) + '\n');
  } catch (_) {}
}

/**
 * Pull headers and a body snippet off whatever error shape we got. Used only on HTTP 400s
 * so we can fingerprint real session drops vs real bad-requests after the fact.
 */
export function extractRawResponse(error: any): { headers?: Record<string, unknown>; body?: string } {
  const headers =
    error?.response?.headers ??
    error?.headers ??
    undefined;

  let bodyRaw: unknown =
    error?.response?.data ??
    error?.response?.body ??
    error?.body ??
    undefined;

  let body: string | undefined;
  if (typeof bodyRaw === 'string') body = bodyRaw;
  else if (bodyRaw != null) {
    try { body = JSON.stringify(bodyRaw); } catch { body = String(bodyRaw); }
  }

  return {
    headers: headers ? { ...headers } : undefined,
    body: body ? body.slice(0, 500) : undefined
  };
}

export function createLogger(name: string) {
  return {
    error: (message: string, meta?: Record<string, unknown>) => 
      log('error', name, message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => 
      log('warn', name, message, meta),
    info: (message: string, meta?: Record<string, unknown>) => 
      log('info', name, message, meta),
    debug: (message: string, meta?: Record<string, unknown>) => 
      log('debug', name, message, meta)
  };
}

function log(level: LogLevel, name: string, message: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    service: name,
    message,
    ...meta
  };
  
  const logString = JSON.stringify(logEntry, null, 2);
  
  switch (level) {
    case 'error':
      console.error(logString);
      break;
    case 'warn':
      console.warn(logString);
      break;
    case 'info':
      console.info(logString);
      break;
    case 'debug':
      console.debug(logString);
      break;
  }
}

export type Logger = ReturnType<typeof createLogger>;
