import { describe, it, expect } from 'vitest';
import { DOMAINS, getNavigationTools } from '../domains/navigation.js';
import { getDomainHandler } from '../domains/index.js';

describe('navigation', () => {
  it('exposes navigate + status tools', () => {
    const names = getNavigationTools().map(t => t.name);
    expect(names).toContain('kqm_navigate');
    expect(names).toContain('kqm_status');
  });

  it('navigate enum matches the domain list', () => {
    const nav = getNavigationTools().find(t => t.name === 'kqm_navigate')!;
    const enumVals = (nav.inputSchema as any).properties.domain.enum;
    expect(enumVals.sort()).toEqual([...DOMAINS].sort());
  });
});

describe('domain handlers', () => {
  it('loads every domain and all tools use the kqm_ prefix', async () => {
    for (const domain of DOMAINS) {
      const handler = await getDomainHandler(domain);
      const tools = handler.getTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.name).toMatch(/^kqm_/);
        expect(tool.description).toBeTruthy();
        // Read-only API: no tool should be marked destructive.
        expect((tool.annotations as any)?.destructiveHint ?? false).toBe(false);
      }
    }
  });

  it('every tool description, including navigate and status, is under 300 characters', async () => {
    const tools = [...getNavigationTools()];
    for (const domain of DOMAINS) {
      tools.push(...(await getDomainHandler(domain)).getTools());
    }
    expect(tools.length).toBeGreaterThan(48);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.description!.length, `${tool.name} description length`).toBeLessThan(300);
    }
  });

  it('every entity exposes a *_list tool', async () => {
    const all: string[] = [];
    for (const domain of DOMAINS) {
      const handler = await getDomainHandler(domain);
      all.push(...handler.getTools().map(t => t.name));
    }
    expect(all).toContain('kqm_quote_list');
    expect(all).toContain('kqm_sales_order_list');
    expect(all).toContain('kqm_purchase_order_list');
    expect(all).toContain('kqm_product_list');
    expect(all).toContain('kqm_customer_list');
    // 39 entity tools + 3 get_full tools + 6 reports
    expect(all.length).toBe(48);
    expect(all).toContain('kqm_pipeline_summary');
    expect(all).toContain('kqm_quote_get_full');
  });

  it('returns navigation help for a valid domain', async () => {
    const handler = await getDomainHandler('sales');
    expect(handler.getTools().some(t => t.name === 'kqm_quote_list')).toBe(true);
  });
});
