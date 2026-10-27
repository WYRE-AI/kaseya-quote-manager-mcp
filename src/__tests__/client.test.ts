import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCredentials, getClient, runWithCredentials, setGatewayMode } from '../utils/client.js';
import { CredentialsError } from '../errors.js';

describe('getCredentials', () => {
  const originalEnv = process.env.KASEYA_QUOTE_MANAGER_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
    } else {
      process.env.KASEYA_QUOTE_MANAGER_API_KEY = originalEnv;
    }
  });

  it('returns null when env var is unset', () => {
    delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
    expect(getCredentials()).toBeNull();
  });

  it('returns credentials from env var in standalone mode', () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'env-key';
    const creds = getCredentials();
    expect(creds).toEqual({ apiKey: 'env-key' });
  });

  it('ALS scoped credentials take precedence over env var', () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'env-key';
    let creds: ReturnType<typeof getCredentials> = null;
    runWithCredentials({ apiKey: 'scoped-key' }, () => {
      creds = getCredentials();
    });
    expect(creds).toEqual({ apiKey: 'scoped-key' });
  });

  it('ALS credentials do not leak out of the run context', () => {
    delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
    runWithCredentials({ apiKey: 'scoped-key' }, () => {
      // inside context — confirm scoped is visible
      expect(getCredentials()).toEqual({ apiKey: 'scoped-key' });
    });
    // outside context — must return null (no env fallback)
    expect(getCredentials()).toBeNull();
  });

  it('concurrent ALS contexts do not contaminate each other', async () => {
    const results: Array<{ apiKey: string } | null> = [];

    await Promise.all([
      new Promise<void>(resolve =>
        runWithCredentials({ apiKey: 'tenant-A' }, () => {
          setTimeout(() => {
            results[0] = getCredentials();
            resolve();
          }, 5);
        })
      ),
      new Promise<void>(resolve =>
        runWithCredentials({ apiKey: 'tenant-B' }, () => {
          setTimeout(() => {
            results[1] = getCredentials();
            resolve();
          }, 5);
        })
      ),
    ]);

    expect(results[0]).toEqual({ apiKey: 'tenant-A' });
    expect(results[1]).toEqual({ apiKey: 'tenant-B' });
  });
});

describe('getClient', () => {
  afterEach(() => {
    delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
  });

  it('throws when no credentials are available', () => {
    delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
    expect(() => getClient()).toThrow('No Quote Manager API key configured. Set KASEYA_QUOTE_MANAGER_API_KEY.');
  });

  it('returns a client when env var is set', () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'env-key';
    const client = getClient();
    expect(client).toBeTruthy();
  });

  it('returns a fresh client per call (no singleton)', () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'env-key';
    const a = getClient();
    const b = getClient();
    // Each call produces a distinct instance
    expect(a).not.toBe(b);
  });

  it('uses scoped credentials when inside runWithCredentials', () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'env-key';
    let client: ReturnType<typeof getClient> | undefined;
    runWithCredentials({ apiKey: 'scoped-key' }, () => {
      client = getClient();
    });
    expect(client).toBeTruthy();
  });
});

describe('gateway mode', () => {
  beforeEach(() => setGatewayMode(true));
  afterEach(() => {
    setGatewayMode(false);
    delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
  });

  it('never reads KASEYA_QUOTE_MANAGER_API_KEY from the environment', () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'env-key';
    expect(getCredentials()).toBeNull();
  });

  it('still returns request-scoped credentials', () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'env-key';
    runWithCredentials({ apiKey: 'scoped-key' }, () => {
      expect(getCredentials()).toEqual({ apiKey: 'scoped-key' });
    });
  });

  it('getClient throws a CredentialsError that names the gateway header', () => {
    process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'env-key';
    expect(() => getClient()).toThrow(CredentialsError);
    expect(() => getClient()).toThrow(
      'No Quote Manager API key on this request. The gateway must send x-kaseya-quote-manager-api-key.',
    );
  });

  it('passes maxRetries through without error', () => {
    runWithCredentials({ apiKey: 'k' }, () => {
      expect(getClient({ maxRetries: 1 })).toBeTruthy();
    });
  });
});
