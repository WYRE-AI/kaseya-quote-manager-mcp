/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders never qualify for that bypass. The bypass binds 127.0.0.1
 * only. /mcp rejects a missing or invalid X-Gateway-S2S header. AUTH_MODE=gateway
 * rejects requests that omit x-kaseya-quote-manager-api-key and must not fall
 * back to KASEYA_QUOTE_MANAGER_API_KEY.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSpy = vi.hoisted(() => vi.fn());
const getCredsSpy = vi.hoisted(() => vi.fn());

vi.mock('../utils/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/client.js')>();
  return {
    ...actual,
    getCredentials: () => {
      getCredsSpy();
      return actual.getCredentials();
    },
    runWithCredentials: <T>(creds: { apiKey: string }, fn: () => T): T => {
      runSpy(creds);
      return actual.runWithCredentials(creds, fn);
    },
  };
});

import { KNOWN_PLACEHOLDER_SECRETS, startHttpServer } from '../http.js';
import { unwrapText } from './helpers/unwrap.js';

const S2S_SECRET = 's2s-do-not-log-7f3a-0123456789abcdef';
const ENV_API_KEY = 'env-api-key-must-not-be-used';
const HEADER_API_KEY = 'header-api-key-must-not-leak';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'NODE_ENV',
  'KASEYA_QUOTE_MANAGER_API_KEY',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Array<{ close: () => Promise<void> }> = [];

/** Build an `X-Gateway-S2S` value: `t=<unix seconds>,v1=<hmac-sha256 hex>`. */
function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

/** Capture `console.error` lines until `restore()` is called. */
function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return {
    text: () => lines.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

/** Stub `process.exit` so a startup refusal throws instead of ending the test process. */
function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

/** Assert `text` does not contain the fixture S2S secret or API keys. */
function assertNoSecrets(text: string, extra: string[] = []): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_API_KEY);
  expect(text).not.toContain(HEADER_API_KEY);
  for (const value of extra) {
    expect(text).not.toContain(value);
  }
}

interface HttpResult {
  status: number;
  body: string;
}

/** Send one HTTP request to the test server and return the status and body. */
function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Start the HTTP server on an ephemeral port and register it for cleanup. */
async function listen(): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const server = await startHttpServer();
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  const handle = {
    port: bound.port,
    address: bound.address,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
  servers.push(handle);
  return handle;
}

/** JSON and SSE headers required by the MCP HTTP transport. */
function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'kqm_status', arguments: {} },
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'info';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  process.env.NODE_ENV = 'development';
  delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
  delete process.env.MCP_TRANSPORT;
  runSpy.mockReset();
  getCredsSpy.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await server.close();
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('HTTP startup', () => {
  it('refuses to start when CONDUIT_S2S_SECRET is empty', async () => {
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    process.env.CONDUIT_S2S_SECRET = '   ';
    const logs = captureStderr();
    mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start HTTP transport');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it.each([...KNOWN_PLACEHOLDER_SECRETS])(
    'refuses placeholder %s even when MCP_ALLOW_INSECURE_DEV=1',
    async (placeholder) => {
      const padded = `  ${placeholder.toUpperCase()}  `;
      process.env.CONDUIT_S2S_SECRET = padded;
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        await expect(startHttpServer()).rejects.toThrow('process.exit:1');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain('known placeholder');
        expect(text).toContain('Refusing to start HTTP transport');
        expect(text).not.toContain(padded);
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      const server = await listen();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV');
      expect(text).toContain('127.0.0.1');
      expect(text).not.toContain('not a loopback address');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it.each(['0.0.0.0', '10.1.2.3'])(
    'overrides non-loopback MCP_HTTP_HOST=%s when the dev bypass is on',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        const server = await listen();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(server.address).toBe('127.0.0.1');
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain('Binding 127.0.0.1 only');
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it('forces 127.0.0.1 when the dev bypass host is localhost', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_HTTP_HOST = 'localhost';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('127.0.0.1');
      expect(logs.text()).toContain('SECURITY WARNING');
      expect(logs.text()).not.toContain('not a loopback address');
    } finally {
      logs.restore();
    }
  });

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      expect(logs.text()).not.toContain('not a loopback address');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('binds 127.0.0.1 when a secret is set and MCP_HTTP_HOST is unset', async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe('127.0.0.1');
  });
});

describe('HTTP /mcp authentication', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = ENV_API_KEY;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
  });

  it('returns 401 when the S2S header is missing or invalid and does not log the secret', async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const missing = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({ 'x-kaseya-quote-manager-api-key': HEADER_API_KEY }),
        body: statusCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader('wrong-secret'),
          'x-kaseya-quote-manager-api-key': HEADER_API_KEY,
        }),
        body: statusCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain('X-Gateway-S2S');
      expect(invalid.body).toContain('X-Gateway-S2S');
      assertNoSecrets(missing.body);
      assertNoSecrets(invalid.body);
      assertNoSecrets(logs.text());
      expect(runSpy).not.toHaveBeenCalled();
      expect(getCredsSpy).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it('returns 401 in gateway mode without credential headers and does not use env credentials', async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain('x-kaseya-quote-manager-api-key');
    expect(response.body).toContain('Unauthorized');
    assertNoSecrets(response.body);
    expect(runSpy).not.toHaveBeenCalled();
    expect(getCredsSpy).not.toHaveBeenCalled();

    const empty = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({
        'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
        'x-kaseya-quote-manager-api-key': '',
      }),
      body: statusCall,
    });
    expect(empty.status).toBe(401);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid S2S header plus the credential header and uses that key', async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-kaseya-quote-manager-api-key': HEADER_API_KEY,
        }),
        body: statusCall,
      });

      expect(response.status).toBe(200);
      const payload = JSON.parse(response.body) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = payload.result?.content?.[0]?.text ?? '';
      const status = JSON.parse(unwrapText(text)) as { connected?: boolean };
      expect(status.connected).toBe(true);
      assertNoSecrets(response.body);
      assertNoSecrets(logs.text());
      expect(runSpy).toHaveBeenCalledWith({ apiKey: HEADER_API_KEY });
    } finally {
      logs.restore();
    }
  });

  it('serves /health without authentication and without returning credentials', async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'GET',
      path: '/health',
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      status?: string;
      mode?: string;
      credentials?: { configured?: boolean };
    };
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('gateway');
    expect(body.credentials?.configured).toBe(false);
    assertNoSecrets(response.body);
    expect(getCredsSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe('HTTP AUTH_MODE=env', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'env';
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = ENV_API_KEY;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
  });

  it('accepts a signed request that omits the vendor header and uses the env key', async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = payload.result?.content?.[0]?.text ?? '';
    const status = JSON.parse(unwrapText(text)) as { connected?: boolean };
    expect(status.connected).toBe(true);
    assertNoSecrets(response.body);
    expect(runSpy).not.toHaveBeenCalled();
    expect(getCredsSpy).toHaveBeenCalled();
  });
});

describe('deploy config', () => {
  it('leaves CONDUIT_S2S_SECRET empty and gives the gateway service no static creds', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    expect(example).toMatch(/^CONDUIT_S2S_SECRET=\s*$/m);

    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
    const gateway = compose.split('kaseya-quote-manager-mcp-dev')[0] ?? compose;
    expect(gateway).toContain('CONDUIT_S2S_SECRET=${CONDUIT_S2S_SECRET:?set CONDUIT_S2S_SECRET}');
    expect(gateway).toContain('AUTH_MODE=gateway');
    expect(gateway).toContain('127.0.0.1:8080:8080');
    expect(gateway).not.toMatch(/^\s*- KASEYA_QUOTE_MANAGER_API_KEY=/m);
    expect(gateway).not.toMatch(/^\s*env_file:/m);
  });
});
