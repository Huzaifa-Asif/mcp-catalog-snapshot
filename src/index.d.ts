export type IncompleteReason =
  | 'aborted' | 'conflicting_identity' | 'cursor_cycle' | 'fetch_error'
  | 'invalid_item' | 'invalid_page' | 'max_bytes' | 'max_items'
  | 'max_pages' | 'source_changed' | 'timeout';

export interface FetchContext {
  cursor: string | undefined;
  signal: AbortSignal;
  pageIndex: number;
}

export interface CollectionDiagnostic {
  code: 'conflicting_identity' | 'cursor_cycle' | 'duplicate_item';
  id?: string;
  cursor?: string;
  pageIndex: number;
}

export interface CollectionResult<T> {
  complete: boolean;
  reason: 'complete' | IncompleteReason;
  items: readonly T[];
  pages: number;
  bytes: number;
  elapsedMs: number;
  diagnostics: readonly CollectionDiagnostic[];
  error?: Readonly<{ name: string; message: string }>;
}

export interface CollectOptions<T, Page = { items: T[]; nextCursor?: string }> {
  maxPages?: number;
  maxItems?: number;
  maxBytes?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  getItems?: (page: Page) => T[];
  getNextCursor?: (page: Page) => string;
  hasNextCursor?: (page: Page) => boolean;
  getId?: (item: T) => string;
}

export type FetchPage<T, Page = { items: T[]; nextCursor?: string }> = (context: FetchContext) => Promise<Page> | Page;
export type McpKind = 'tools' | 'resources' | 'resourceTemplates' | 'prompts';
export type McpListOperation<T> = (params: { cursor?: string }, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

export declare const DEFAULT_LIMITS: Readonly<{ maxPages: number; maxItems: number; maxBytes: number; maxDurationMs: number }>;
export declare const MCP_KINDS: Readonly<Record<McpKind, Readonly<{ field: string; identity: string }>>>;

export declare class CatalogCollectionError extends Error {
  readonly code: string;
}

export declare function collectPages<T, Page = { items: T[]; nextCursor?: string }>(fetchPage: FetchPage<T, Page>, options?: CollectOptions<T, Page>): Promise<CollectionResult<T>>;
export declare function createMcpFetcher<T>(listOperation: McpListOperation<T>, kind: McpKind): FetchPage<T>;
export declare function collectMcpCatalog<T>(listOperation: McpListOperation<T>, kind: McpKind, options?: CollectOptions<T>): Promise<CollectionResult<T>>;

export interface CatalogSnapshot<T> {
  readonly revision: number;
  readonly items: readonly T[];
  readonly collectedAt: string;
  readonly pages?: number;
  readonly bytes?: number;
}

export interface RefreshOptions<T, Page = { items: T[]; nextCursor?: string }> extends CollectOptions<T, Page> {
  maxStabilityRetries?: number;
  getVersion?: () => unknown | Promise<unknown>;
}

export interface RefreshResult<T> {
  readonly committed: boolean;
  readonly reason: 'complete' | 'superseded' | IncompleteReason;
  readonly stabilityRetries: number;
  readonly attempt: CollectionResult<T>;
  readonly snapshot: CatalogSnapshot<T> | undefined;
}

export declare class CatalogSnapshotStore<T> {
  constructor(initialSnapshot?: readonly T[]);
  get snapshot(): CatalogSnapshot<T> | undefined;
  refresh<Page = { items: T[]; nextCursor?: string }>(fetchPage: FetchPage<T, Page>, options?: RefreshOptions<T, Page>): Promise<RefreshResult<T>>;
}

declare const api: {
  CatalogCollectionError: typeof CatalogCollectionError;
  CatalogSnapshotStore: typeof CatalogSnapshotStore;
  DEFAULT_LIMITS: typeof DEFAULT_LIMITS;
  MCP_KINDS: typeof MCP_KINDS;
  collectMcpCatalog: typeof collectMcpCatalog;
  collectPages: typeof collectPages;
  createMcpFetcher: typeof createMcpFetcher;
};
export default api;
