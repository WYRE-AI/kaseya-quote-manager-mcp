import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { runWithCredentials, setGatewayMode } from './utils/client.js';
import { logger } from './utils/logger.js';
import { MAX_REQUEST_BODY_BYTES } from './input-limits.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';

// Conduit service-to-service auth (gateway#377 parity). HTTP startup fails
// closed: an empty CONDUIT_S2S_SECRET, or a known placeholder, refuses to
// boot unless MCP_ALLOW_INSECURE_DEV=1 (placeholders never qualify), and that
// flag is itself refused unless NODE_ENV=development. A secret under 32
// characters also refuses. The bypass skips X-Gateway-S2S and binds 127.0.0.1
// only. A configured secret is always enforced and still honors MCP_HTTP_HOST
// (default 127.0.0.1). The secret value is never logged. See src/s2s-verify.ts.

/** Public example values. A copied placeholder must not verify as a real secret. */
export const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

const LOOPBACK_HOST = '127.0.0.1';

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. ' +
  'Set CONDUIT_S2S_SECRET, or set MCP_ALLOW_INSECURE_DEV=1 with NODE_ENV=development for local development only.';

export const SHORT_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET must be at least 32 characters. ' +
  'Generate one with `openssl rand -hex 32`.';

export const INSECURE_DEV_NODE_ENV_ERROR =
  'Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV requires NODE_ENV=development.';

const MIN_S2S_SECRET_LENGTH = 32;

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value. ' +
  'MCP_ALLOW_INSECURE_DEV does not bypass a placeholder secret.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is not enforcing X-Gateway-S2S and is limited to loopback (127.0.0.1). ' +
  'Do not use this outside local development.';

const S2S_UNAUTHORIZED = {
  error:
    'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
};

const GATEWAY_CREDENTIALS_UNAUTHORIZED = {
  error: 'Unauthorized: missing required gateway credential header x-kaseya-quote-manager-api-key',
};

/** First non-empty string in a Node request header, or undefined when it is absent. */
function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** True for 127.0.0.1, localhost, and ::1, including a bracketed IPv6 literal. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/** Log `message` and exit the process with status 1. Does not return. */
function refuseStart(message: string): never {
  logger.error(message);
  process.exit(1);
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed unless MCP_ALLOW_INSECURE_DEV=1 (and NODE_ENV=development).
 * A known placeholder or a secret under 32 characters always refuses, including
 * when the dev flag is set. The secret is never logged.
 */
function resolveS2sSecret(): string {
  const devFlag = (process.env.MCP_ALLOW_INSECURE_DEV ?? '').trim().toLowerCase();
  if (
    devFlag !== '' &&
    devFlag !== '0' &&
    devFlag !== 'false' &&
    (process.env.NODE_ENV ?? '').trim().toLowerCase() !== 'development'
  ) {
    refuseStart(INSECURE_DEV_NODE_ENV_ERROR);
  }
  const secret = (process.env.CONDUIT_S2S_SECRET ?? '').trim();
  if (secret && KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (secret.length > 0 && secret.length < MIN_S2S_SECRET_LENGTH) {
    refuseStart(SHORT_S2S_SECRET_ERROR);
  }
  if (secret) return secret;

  if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return '';
  }

  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/** AUTH_MODE for HTTP: unset or empty is gateway; anything but gateway|env refuses to start. */
export function resolveAuthMode(): 'gateway' | 'env' {
  const raw = process.env.AUTH_MODE ?? '';
  const mode = raw.trim();
  if (mode === '') return 'gateway';
  if (mode === 'gateway' || mode === 'env') return mode;
  refuseStart(`AUTH_MODE must be 'gateway' or 'env'. Got ${JSON.stringify(raw.slice(0, 40))}.`);
}

/**
 * No secret (insecure-dev only) always binds 127.0.0.1. A non-loopback
 * MCP_HTTP_HOST is overridden and logged. A configured secret honors
 * MCP_HTTP_HOST, defaulting to 127.0.0.1 when it is unset.
 */
function resolveListenHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? '').trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;

  if (configured && !isLoopbackHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        'MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. ' +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

/**
 * Bind the HTTP MCP listener. `/mcp` requires S2S, and gateway mode also
 * requires a per-request API key.
 */
export async function startHttpServer(): Promise<HttpServer> {
  const s2sSecret = resolveS2sSecret();
  const authMode = resolveAuthMode();
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = resolveListenHost(s2sSecret);
  const isGatewayMode = authMode === 'gateway';
  setGatewayMode(isGatewayMode);

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // /health is container LIVENESS, not credential-readiness. In gateway
    // mode, credentials arrive per-request via X-Kaseya-Quote-Manager-Api-Key,
    // not at startup — gating this on credentials would always 503 and the
    // WYRE vendor-monitor would false-red this vendor permanently. Always
    // 200, no auth, and this handler must not read the API key. The
    // `configured` flag is only a presence check for env mode.
    if (url.pathname === '/health') {
      const configured = authMode === 'env' && Boolean(process.env.KASEYA_QUOTE_MANAGER_API_KEY);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        transport: 'http',
        mode: isGatewayMode ? 'gateway' : 'standalone',
        credentials: { configured },
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
      return;
    }

    // S2S guard runs first: a forged request must never reach credential
    // extraction or the MCP server/transport. Empty s2sSecret is only
    // reachable when MCP_ALLOW_INSECURE_DEV=1; startup refuses otherwise.
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(S2S_UNAUTHORIZED));
      return;
    }

    // Body cap runs only after S2S passes so unauthenticated callers still get 401.
    const contentLength = Number(headerValue(req.headers['content-length']));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes` },
        id: null,
      }));
      return;
    }

    // Gateway mode: the API key must arrive on every request via
    // x-kaseya-quote-manager-api-key. Reject explicitly if it is missing
    // rather than falling through — falling through would resolve
    // KASEYA_QUOTE_MANAGER_API_KEY from the process environment, which is
    // not request-scoped (CWE-306).
    const headerApiKey = headerValue(req.headers['x-kaseya-quote-manager-api-key']);
    if (isGatewayMode && !headerApiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(GATEWAY_CREDENTIALS_UNAUTHORIZED));
      return;
    }

    const handle = async () => {
      const server = createServer();
      // SECURITY-CRITICAL invariant: this transport MUST stay stateless
      // (sessionIdGenerator: undefined + enableJsonResponse: true). Per-request
      // tenant credentials are carried in an AsyncLocalStorage context opened by
      // runWithCredentials() below. A stateless request->single-response flow
      // keeps the tool call inside that context. Switching to a stateful/SSE
      // transport (sessionIdGenerator set, persistent stream) would let a
      // long-lived connection serve later messages under a stale/foreign
      // credential context — re-review tenant isolation before changing this.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        // Caps chunked bodies that carry no Content-Length.
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    };

    if (isGatewayMode && headerApiKey) {
      await runWithCredentials({ apiKey: headerApiKey }, handle);
    } else {
      await handle();
    }
  };

  const httpServer = createHttpServer((req, res) => {
    // Never log the error object: it can carry request or upstream content.
    void route(req, res).catch(() => {
      logger.error('HTTP request failed');
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'Request failed.' }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      logger.info(`HTTP streaming server listening on ${host}:${port}`, { s2sEnforced: s2sSecret !== '' });
      resolve();
    });
  });

  return httpServer;
}

// Entry point — check transport mode. Vitest imports this module to call
// startHttpServer; skip the CLI entrypoint there. `node dist/http.js` still
// starts HTTP or falls through to stdio.
if (process.env.VITEST !== 'true') {
  if (process.env.MCP_TRANSPORT === 'http') {
    startHttpServer().catch((error) => {
      logger.error('Fatal startup error', error);
      process.exit(1);
    });
  } else {
    await import('./index.js');
  }
}
