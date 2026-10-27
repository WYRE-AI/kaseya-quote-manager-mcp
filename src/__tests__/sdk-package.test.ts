/** The SDK dependency is pinned to the @wyre-ai scope, locked to one verified tarball, and installed as locked. */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as sdk from '@wyre-ai/node-kaseya-quote-manager';

const root = new URL('../../', import.meta.url);
const readText = (path: string) => readFileSync(new URL(path, root), 'utf8');
const NAME = '@wyre-ai/node-kaseya-quote-manager';
const OLD_NAME = '@wyre-technology/node-kaseya-quote-manager';

const pkgText = readText('package.json');
const lockText = readText('package-lock.json');
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);

describe('locked SDK package', () => {
  it('package.json depends on ^1.0.5 of the @wyre-ai package', () => {
    expect(pkg.dependencies[NAME]).toBe('^1.0.5');
  });

  it('neither file mentions the old @wyre-technology package', () => {
    expect(pkgText).not.toContain(OLD_NAME);
    expect(lockText).not.toContain(OLD_NAME);
  });

  it('the lock entry is the verified 1.0.5 tarball', () => {
    const entry = lock.packages[`node_modules/${NAME}`];
    expect(entry.version).toBe('1.0.5');
    expect(entry.resolved).toBe(
      'https://npm.pkg.github.com/download/@wyre-ai/node-kaseya-quote-manager/1.0.5/12129450c4e1956835fd7f75add8955b2fce2bd7',
    );
    expect(entry.integrity).toBe(
      'sha512-G42+dhTYARkgoXcCF62WrAdp67mcX9nRQ7kf67lhw4TK5//sdS5wq29R7fHZK/6J/kvAd/Vda+q3LV89McYu5A==',
    );
  });

  it('the installed package version equals the locked version', () => {
    const installed = JSON.parse(readText(`node_modules/${NAME}/package.json`));
    expect(installed.name).toBe(NAME);
    expect(installed.version).toBe(lock.packages[`node_modules/${NAME}`].version);
  });
});

/** Every `resource: '...'` named by the entity definitions in src/domains. */
function entityResources(): string[] {
  const dir = new URL('src/domains/', root);
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    for (const m of readFileSync(new URL(file, dir), 'utf8').matchAll(/resource:\s*'(\w+)'/g)) found.add(m[1]);
  }
  return [...found];
}

describe('installed SDK surface', () => {
  it('exports the client and the error classes the MCP uses', () => {
    expect(typeof sdk.KaseyaQuoteManagerClient).toBe('function');
    for (const name of ['KaseyaQuoteManagerError', 'AuthenticationError', 'ForbiddenError', 'NotFoundError', 'RateLimitError', 'ServerError', 'ValidationError'] as const) {
      expect(typeof sdk[name], name).toBe('function');
    }
  });

  it('a client builds with { apiKey, maxRetries: 0 } and exposes every resource the MCP uses, each with list()', () => {
    const client = new sdk.KaseyaQuoteManagerClient({ apiKey: 'k', maxRetries: 0 }) as unknown as Record<string, { list?: unknown }>;
    const used = new Set([
      'quotes', 'quoteSections', 'quoteLines', 'salesOrders', 'salesOrderLines', 'salesOrderPayments',
      'purchaseOrders', 'purchaseOrderLines', 'purchaseOrderCosts', 'productSuppliers',
      ...entityResources(),
    ]);
    expect(used.size).toBeGreaterThanOrEqual(20);
    for (const resource of used) {
      expect(client[resource], resource).toBeDefined();
      expect(typeof client[resource].list, `${resource}.list`).toBe('function');
    }
  });
});
