/**
 * Auth resolution for dassian-adt.
 *
 * Supports three modes (checked in order):
 *   1. SAP_SERVICE_KEY  — BTP service key JSON string or file path
 *   2. SAP_OAUTH_TOKEN_URL + SAP_CLIENT_ID + SAP_CLIENT_SECRET  — individual OAuth vars
 *   3. SAP_USER + SAP_PASSWORD  — basic auth (on-prem default)
 *
 * The library's ADTClient accepts a token-fetcher function in place of a password string.
 * Token is cached with expiry awareness; re-fetched with a 60-second buffer before expiry.
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';

export interface AuthConfig {
  url: string;
  user: string;
  /** String for basic auth; function for OAuth (passed to ADTClient as password param). */
  password: string | (() => Promise<string>);
  client: string;
  language: string;
  authType: 'basic' | 'oauth';
}

// ─── Token fetching ──────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

function fetchTokenFromEndpoint(
  tokenUrl: string,
  clientId: string,
  clientSecret: string
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = 'grant_type=client_credentials';
    const url = new URL(tokenUrl);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`OAuth token fetch failed (${res.statusCode}): ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as TokenResponse);
        } catch {
          reject(new Error(`OAuth token endpoint returned non-JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Returns a caching token fetcher suitable for ADTClient's password parameter.
 * Refreshes the token 60 seconds before it expires.
 */
export function makeTokenFetcher(
  tokenUrl: string,
  clientId: string,
  clientSecret: string
): () => Promise<string> {
  let cachedToken: string | null = null;
  let expiresAt = 0;

  return async (): Promise<string> => {
    const now = Date.now();
    if (cachedToken && expiresAt > now + 60_000) {
      return cachedToken;
    }
    const result = await fetchTokenFromEndpoint(tokenUrl, clientId, clientSecret);
    cachedToken = result.access_token;
    expiresAt = now + result.expires_in * 1000;
    return cachedToken;
  };
}

// ─── Service key parsing ─────────────────────────────────────────────────────

interface Uaa {
  url: string;
  clientid: string;
  clientsecret: string;
}

interface ServiceKey {
  uaa?: Uaa;
  credentials?: { uaa: Uaa; url?: string };
  url?: string;
}

function parseServiceKey(raw: string): { uaa: Uaa; systemUrl: string } {
  let key: ServiceKey;
  try {
    // Inline JSON or file path
    const src = raw.trimStart().startsWith('{') ? raw : fs.readFileSync(raw.trim(), 'utf8');
    key = JSON.parse(src) as ServiceKey;
  } catch (e: any) {
    throw new Error(`SAP_SERVICE_KEY: could not parse as JSON or read file — ${e.message}`);
  }

  const uaa = key.uaa ?? key.credentials?.uaa;
  const systemUrl = key.url ?? key.credentials?.url;

  if (!uaa?.url || !uaa?.clientid || !uaa?.clientsecret) {
    throw new Error(
      'SAP_SERVICE_KEY: missing required fields (uaa.url, uaa.clientid, uaa.clientsecret). ' +
      'Ensure the service key is a valid BTP ABAP Cloud service key.'
    );
  }

  return { uaa, systemUrl: systemUrl || '' };
}

// ─── Main resolver ───────────────────────────────────────────────────────────

/**
 * Resolve auth configuration from environment variables.
 * Called once at server startup in stdio mode.
 * In HTTP per-user mode, basic credentials are passed directly — don't call this.
 */
export function resolveAuth(): AuthConfig {
  const client   = process.env.SAP_CLIENT   ?? '';
  const language = process.env.SAP_LANGUAGE ?? 'EN';

  // ── 1. Service key ──────────────────────────────────────────────────────────
  const serviceKeyEnv = process.env.SAP_SERVICE_KEY;
  if (serviceKeyEnv) {
    const { uaa, systemUrl } = parseServiceKey(serviceKeyEnv);
    const url = process.env.SAP_URL ?? systemUrl;
    if (!url) throw new Error('SAP_URL is required (or provide it in the service key).');
    const tokenUrl = `${uaa.url.replace(/\/$/, '')}/oauth/token`;
    return {
      url,
      user: process.env.SAP_OAUTH_USER ?? uaa.clientid,
      password: makeTokenFetcher(tokenUrl, uaa.clientid, uaa.clientsecret),
      client,
      language,
      authType: 'oauth'
    };
  }

  // ── 2. Individual OAuth vars ────────────────────────────────────────────────
  const oauthTokenUrl  = process.env.SAP_OAUTH_TOKEN_URL;
  const clientId       = process.env.SAP_CLIENT_ID;
  const clientSecret   = process.env.SAP_CLIENT_SECRET;
  if (oauthTokenUrl && clientId && clientSecret) {
    const url = process.env.SAP_URL;
    if (!url) throw new Error('SAP_URL is required.');
    return {
      url,
      user: process.env.SAP_OAUTH_USER ?? clientId,
      password: makeTokenFetcher(oauthTokenUrl, clientId, clientSecret),
      client,
      language,
      authType: 'oauth'
    };
  }

  // ── 3. Basic auth ───────────────────────────────────────────────────────────
  const url  = process.env.SAP_URL;
  const user = process.env.SAP_USER;
  const pass = process.env.SAP_PASSWORD;

  if (!url) throw new Error('SAP_URL is required.');
  if (!user || !pass) {
    throw new Error(
      'Authentication required. Provide one of:\n' +
      '  Basic auth:    SAP_USER + SAP_PASSWORD\n' +
      '  Service key:   SAP_SERVICE_KEY (BTP JSON string or file path)\n' +
      '  OAuth vars:    SAP_OAUTH_TOKEN_URL + SAP_CLIENT_ID + SAP_CLIENT_SECRET'
    );
  }

  return { url, user, password: pass, client, language, authType: 'basic' };
}
