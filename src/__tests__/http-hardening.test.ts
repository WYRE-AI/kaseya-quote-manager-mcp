/**
 * HTTP hardening: AUTH_MODE resolution, S2S secret rules, request body cap,
 * and gateway-mode credential isolation.
 */

import { createHmac } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSECURE_DEV_NODE_ENV_ERROR, SHORT_S2S_SECRET_ERROR, logFatalStartup, resolveAuthMode, startHttpServer } from '../http.js';
import { setGatewayMode } from '../utils/client.js';
import { MAX_REQUEST_BODY_BYTES } from '../input-limits.js';
import { unwrap } from './helpers/unwrap.js';

const S2S_SECRET = 'hardening-test-secret-0123456789abcdef';
const ENV_API_KEY = 'env-api-key-must-not-be-used';
const HEADER_API_KEY = 'header-api-key-for-this-request';
const ENV_KEYS = ['CONDUIT_S2S_SECRET', 'MCP_ALLOW_INSECURE_DEV', 'MCP_HTTP_PORT', 'MCP_HTTP_HOST', 'AUTH_MODE', 'NODE_ENV', 'KASEYA_QUOTE_MANAGER_API_KEY', 'LOG_LEVEL'] as const;

const saved = new Map<string, string | undefined>();
const servers: Server[] = [];

const s2s = () => {
  const message = `t=${Math.floor(Date.now() / 1000)}`;
  return `${message},v1=${createHmac('sha256', S2S_SECRET).update(message).digest('hex')}`;
};

function post(port: number, headers: Record<string, string>, body: string, declaredLength?: number | null, path = '/mcp') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
    if (declaredLength !== null) h['content-length'] = String(declaredLength ?? Buffer.byteLength(body));
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function listen(): Promise<number> {
  const server = await startHttpServer();
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  return { text: () => lines.join('\n'), restore: () => spy.mockRestore() };
}

const OVERSIZED = JSON.stringify({ pad: 'a'.repeat(MAX_REQUEST_BODY_BYTES + 1) });
const statusCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kqm_status', arguments: {} } });
const brandCall = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kqm_brand_list', arguments: {} } });

beforeEach(() => {
  for (const k of ENV_KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setGatewayMode(false);
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveAuthMode', () => {
  it.each([[undefined], [''], ['   '], ['gateway'], [' gateway ']])('%j resolves to gateway', (value) => {
    if (value === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = value;
    expect(resolveAuthMode()).toBe('gateway');
  });

  it.each([['env'], [' env\n']])('%j resolves to env', (value) => {
    process.env.AUTH_MODE = value;
    expect(resolveAuthMode()).toBe('env');
  });

  it.each([['Gateway'], ['ENV'], ['standalone'], ['gateway,env'], ['x'.repeat(100)]])('%j refuses to start', (value) => {
    process.env.AUTH_MODE = value;
    const logs = captureStderr();
    mockExit();
    try {
      expect(() => resolveAuthMode()).toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start: AUTH_MODE must be "gateway" or "env".');
      // The configured value is never echoed.
      expect(logs.text()).not.toContain(value);
      expect(logs.text()).not.toContain('Got');
    } finally {
      logs.restore();
    }
  });
});

describe('fatal startup log', () => {
  it('logs only the error type and a message capped at 200 characters', () => {
    const logs = captureStderr();
    try {
      const error = Object.assign(new TypeError(`bad ${'y'.repeat(500)}`), { apiKey: 'leaky-key', config: { secret: 'leaky-secret' } });
      logFatalStartup(error);
      const text = logs.text();
      expect(text).toContain('Fatal startup error {"errorType":"TypeError","message":"bad ');
      expect(text).not.toContain('leaky');
      expect(text).not.toContain('stack');
      expect(text).not.toContain('y'.repeat(201));
    } finally {
      logs.restore();
    }
  });
});

describe('startup rules', () => {
  it('unset AUTH_MODE behaves as gateway over HTTP: a missing key header is 401', async () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = ENV_API_KEY;
    const port = await listen();
    const res = await post(port, { 'x-gateway-s2s': s2s() }, statusCall);
    expect(res.status).toBe(401);
    expect(res.body).toContain('x-kaseya-quote-manager-api-key');
  });

  it("AUTH_MODE='env' uses the env key", async () => {
    process.env.AUTH_MODE = 'env';
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = ENV_API_KEY;
    const port = await listen();
    const res = await post(port, { 'x-gateway-s2s': s2s() }, statusCall);
    expect(res.status).toBe(200);
    expect(unwrap({ content: [{ text: JSON.parse(res.body).result.content[0].text }] }).connected).toBe(true);
  });

  it('refuses AUTH_MODE=Gateway at startup', async () => {
    process.env.AUTH_MODE = 'Gateway';
    const logs = captureStderr();
    mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('AUTH_MODE must be "gateway" or "env"');
    } finally {
      logs.restore();
    }
  });

  it('accepts AUTH_MODE with surrounding whitespace', async () => {
    process.env.AUTH_MODE = ' gateway ';
    const port = await listen();
    expect((await post(port, { 'x-gateway-s2s': s2s() }, statusCall)).status).toBe(401);
  });

  it('refuses a secret shorter than 32 characters without logging it', async () => {
    process.env.CONDUIT_S2S_SECRET = 'short-but-not-a-placeholder-123';
    expect(process.env.CONDUIT_S2S_SECRET).toHaveLength(31);
    const logs = captureStderr();
    mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain(SHORT_S2S_SECRET_ERROR);
      expect(logs.text()).not.toContain('short-but-not-a-placeholder-123');
    } finally {
      logs.restore();
    }
  });

  it('accepts a secret of exactly 32 characters', async () => {
    process.env.CONDUIT_S2S_SECRET = 'a'.repeat(32);
    await expect(listen()).resolves.toBeGreaterThan(0);
  });

  it.each([[undefined], ['test'], ['production'], ['']])('refuses MCP_ALLOW_INSECURE_DEV=1 when NODE_ENV=%j', async (nodeEnv) => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
    const logs = captureStderr();
    mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain(INSECURE_DEV_NODE_ENV_ERROR);
    } finally {
      logs.restore();
    }
  });

  it.each([['0'], ['false'], ['']])('MCP_ALLOW_INSECURE_DEV=%j is off, so an empty secret refuses with the missing-secret error', async (flag) => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = flag;
    const logs = captureStderr();
    mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('CONDUIT_S2S_SECRET is empty');
      expect(logs.text()).toContain('NODE_ENV=development');
    } finally {
      logs.restore();
    }
  });

  it('starts on loopback with MCP_ALLOW_INSECURE_DEV=1 and NODE_ENV=development', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.NODE_ENV = 'development';
    const logs = captureStderr();
    try {
      const server = await startHttpServer();
      servers.push(server);
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
      expect(logs.text()).toContain('SECURITY WARNING');
    } finally {
      logs.restore();
    }
  });

  it.each([[' Development '], ['Development'], ['DEVELOPMENT'], ['development '], [' development'], ['development\n'], ['']])(
    'refuses MCP_ALLOW_INSECURE_DEV=1 when NODE_ENV is %j (exact match only)',
    async (nodeEnv) => {
      delete process.env.CONDUIT_S2S_SECRET;
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.NODE_ENV = nodeEnv;
      const logs = captureStderr();
      mockExit();
      try {
        await expect(startHttpServer()).rejects.toThrow('process.exit:1');
        expect(logs.text()).toContain('MCP_ALLOW_INSECURE_DEV requires NODE_ENV=development');
      } finally {
        logs.restore();
      }
    },
  );
});

describe('request body cap', () => {
  beforeEach(() => {
    process.env.AUTH_MODE = 'env';
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = ENV_API_KEY;
  });

  it('returns 413 with the JSON-RPC error after a valid S2S check', async () => {
    const port = await listen();
    const res = await post(port, { 'x-gateway-s2s': s2s() }, OVERSIZED);
    expect(res.status).toBe(413);
    expect(res.body).toBe('{"jsonrpc":"2.0","error":{"code":-32600,"message":"Request body exceeds 262144 bytes"},"id":null}');
  });

  it('does not 413 a body of exactly the cap', async () => {
    const port = await listen();
    const exact = JSON.stringify({ pad: 'a'.repeat(MAX_REQUEST_BODY_BYTES - 10) });
    expect(Buffer.byteLength(exact)).toBe(MAX_REQUEST_BODY_BYTES);
    const res = await post(port, { 'x-gateway-s2s': s2s() }, exact);
    expect(res.status).not.toBe(413);
  });

  it('returns 401, not 413, without a valid S2S header', async () => {
    const port = await listen();
    expect((await post(port, {}, OVERSIZED)).status).toBe(401);
    expect((await post(port, { 'x-gateway-s2s': 't=1,v1=deadbeef' }, OVERSIZED)).status).toBe(401);
  });

  it('gateway mode: the cap runs after S2S and before the credential check', async () => {
    process.env.AUTH_MODE = 'gateway';
    const port = await listen();
    expect((await post(port, {}, OVERSIZED)).status).toBe(401);
    expect((await post(port, { 'x-gateway-s2s': s2s() }, OVERSIZED)).status).toBe(413);
    expect((await post(port, { 'x-gateway-s2s': s2s(), 'x-kaseya-quote-manager-api-key': 'k' }, OVERSIZED)).status).toBe(413);
  });

  it('rejects a chunked oversized body (no Content-Length) via the transport cap and keeps serving', async () => {
    const port = await listen();
    const res = await post(port, { 'x-gateway-s2s': s2s() }, OVERSIZED, null);
    expect(res.status).toBe(413);
    const ok = await post(port, { 'x-gateway-s2s': s2s() }, statusCall);
    expect(ok.status).toBe(200);
  });

  it('serves normal initialize and tools/list', async () => {
    const port = await listen();
    const init = await post(port, { 'x-gateway-s2s': s2s() }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }));
    expect(init.status).toBe(200);
    const list = await post(port, { 'x-gateway-s2s': s2s() }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const names = JSON.parse(list.body).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('kqm_pipeline_summary');
  });
});

describe('gateway credential isolation', () => {
  it('a tool call uses the header key and never the env key', async () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = ENV_API_KEY;
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get('apiKey') ?? '');
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const port = await listen();
    const res = await post(port, { 'x-gateway-s2s': s2s(), 'x-kaseya-quote-manager-api-key': HEADER_API_KEY }, brandCall);
    expect(res.status).toBe(200);
    expect(seen).toEqual([HEADER_API_KEY]);
    expect(res.body).not.toContain(HEADER_API_KEY);
  });

  it('/health in gateway mode never reports env credentials as configured', async () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = ENV_API_KEY;
    const port = await listen();
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/health' }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ mode: 'gateway', credentials: { configured: false } });
    expect(res.body).not.toContain(ENV_API_KEY);
  });
});
