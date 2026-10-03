import { CatalogSnapshotStore, createMcpFetcher } from 'mcp-catalog-snapshot';

// Works with any MCP SDK/client exposing a compatible listTools operation.
const client = {
  async listTools({ cursor }) {
    if (cursor === undefined) {
      return { tools: [{ name: 'search' }], nextCursor: 'page-2' };
    }
    return { tools: [{ name: 'fetch' }] };
  },
};

const store = new CatalogSnapshotStore();
const result = await store.refresh(createMcpFetcher(client.listTools.bind(client), 'tools'), {
  getId: (tool) => tool.name,
  maxPages: 25,
  maxItems: 2_000,
  maxBytes: 4 * 1024 * 1024,
  maxDurationMs: 10_000,
});

if (!result.committed) {
  console.error('Catalog refresh incomplete:', result.reason);
  process.exitCode = 1;
} else {
  console.log(result.snapshot.items);
}
