import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../server.js';

/** Connect an MCP client to a fresh server over an in-memory transport. */
export async function connect() {
  const server = createServer();
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    async call(name: string, args?: unknown): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> {
      return (await client.callTool({ name, arguments: args as Record<string, unknown> })) as never;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
