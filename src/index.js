import api from './index.cjs';

export const {
  CatalogCollectionError,
  CatalogSnapshotStore,
  DEFAULT_LIMITS,
  MCP_KINDS,
  collectMcpCatalog,
  collectPages,
  createMcpFetcher,
} = api;

export default api;
