# mcp-catalog-snapshot

Collect complete Model Context Protocol catalogs without trusting pagination to terminate, then atomically retain the last complete snapshot.

`mcp-catalog-snapshot` is a small, zero-dependency utility for MCP clients, gateways, agent runtimes, and inventory jobs. It follows opaque cursors across `tools/list`, `resources/list`, `resources/templates/list`, or `prompts/list`, while enforcing explicit page, item, serialized-byte, time, and cancellation bounds.

It does **not** implement an MCP transport, connect to servers, authenticate requests, or decide whether a discovered capability is safe to execute.

## Why this exists

The MCP specification uses opaque cursor pagination: clients should follow `nextCursor`, must not interpret it, and cannot assume a fixed page size. Real client failures have appeared at both extremes: stopping after the first `tools/list` page and following endlessly changing cursors until memory exhaustion. This package provides one reusable collection boundary for those cases.

References:

- [MCP pagination specification](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)
- [OpenAI Codex issue #28858: later `tools/list` pages omitted](https://github.com/openai/codex/issues/28858)
- [OpenAI Codex issue #35450: unbounded pagination can cause OOM](https://github.com/openai/codex/issues/35450)

These reports motivate the failure model; this project is independent and is not an official OpenAI or MCP project.

## Install

```sh
npm install mcp-catalog-snapshot
```

Node.js 18 or newer is required. ESM, CommonJS, and TypeScript declarations are included.

## Quick start

```js
import { CatalogSnapshotStore, createMcpFetcher } from 'mcp-catalog-snapshot';

const store = new CatalogSnapshotStore();
const fetchToolsPage = createMcpFetcher(
  client.listTools.bind(client),
  'tools',
);

const refresh = await store.refresh(fetchToolsPage, {
  getId: (tool) => tool.name,
  maxPages: 25,
  maxItems: 2_000,
  maxBytes: 4 * 1024 * 1024,
  maxDurationMs: 10_000,
});

if (!refresh.committed) {
  console.warn('Kept previous catalog:', refresh.reason);
} else {
  console.log(refresh.snapshot.items);
}
```

The first request omits `cursor`. Later requests receive the server's cursor unchanged, including an empty string. A missing `nextCursor` is the only normal end-of-list signal.

## API

### `collectPages(fetchPage, options?)`

Collect any opaque-cursor API into an explicit result:

```js
const result = await collectPages(
  async ({ cursor, signal, pageIndex }) => {
    return fetchCatalogPage({ cursor, signal, pageIndex });
  },
  {
    getItems: (page) => page.entries,
    hasNextCursor: (page) => Object.hasOwn(page, 'after'),
    getNextCursor: (page) => page.after,
    getId: (entry) => entry.id,
  },
);
```

`fetchPage` receives:

- `cursor`: `undefined` for the first request, otherwise the opaque string from the preceding page.
- `signal`: an `AbortSignal` cancelled at the deadline or when the caller's signal aborts.
- `pageIndex`: zero-based request index.

The result includes:

```ts
{
  complete: boolean;
  reason: 'complete' | 'aborted' | 'conflicting_identity' |
    'cursor_cycle' | 'fetch_error' | 'invalid_item' | 'invalid_page' |
    'max_bytes' | 'max_items' | 'max_pages' | 'timeout';
  items: readonly T[];
  pages: number;
  bytes: number;
  elapsedMs: number;
  diagnostics: readonly Diagnostic[];
  error?: { name: string; message: string };
}
```

An incomplete result can contain items that were safely observed before the stop condition. Do not treat them as a complete catalog.

### `createMcpFetcher(listOperation, kind)`

Adapts an MCP SDK-style list function. Supported kinds and identities are:

| Kind | Response array | Default identity |
| --- | --- | --- |
| `tools` | `tools` | `name` |
| `resources` | `resources` | `uri` |
| `resourceTemplates` | `resourceTemplates` | `uriTemplate` |
| `prompts` | `prompts` | `name` |

The operation is called as `listOperation(params, { signal })`. SDKs that ignore the second argument still work, but may continue their underlying request after this package has returned a timeout result.

### `collectMcpCatalog(listOperation, kind, options?)`

Convenience wrapper around `createMcpFetcher` and `collectPages`. It supplies the identity listed above unless `getId` is provided.

```js
const tools = await collectMcpCatalog(
  client.listTools.bind(client),
  'tools',
  { maxPages: 50 },
);
```

### `new CatalogSnapshotStore(initialItems?)`

Holds an immutable array snapshot. `refresh(fetchPage, options)` commits only a complete collection. On timeout, fetch failure, limit, malformed page, cursor cycle, identity conflict, or unstable source, `snapshot` remains the same object.

```js
const store = new CatalogSnapshotStore(cachedTools);

const refresh = await store.refresh(fetchToolsPage, {
  // Increment this value when an MCP list-changed notification arrives.
  getVersion: () => catalogGeneration,
  maxStabilityRetries: 2,
});
```

`getVersion` is sampled before and after each collection. If it changes, the attempt is discarded and retried up to `maxStabilityRetries`. This avoids replacing a complete snapshot with a catalog assembled across a known list change. It cannot detect changes that the caller does not signal.

Overlapping refreshes are fenced: after a newer refresh begins, an older one cannot overwrite its result.

## Defaults and choosing limits

| Option | Default | Meaning |
| --- | ---: | --- |
| `maxPages` | 100 | Maximum accepted pages |
| `maxItems` | 10,000 | Maximum retained unique items |
| `maxBytes` | 16 MiB | Maximum UTF-8 bytes of normalized page JSON |
| `maxDurationMs` | 30,000 | Overall wall-clock deadline per collection attempt |
| `maxStabilityRetries` | 1 | Extra attempts after a signalled source change |

Set limits from your deployment's expected catalog size and memory budget. `maxBytes` is based on `JSON.stringify` of the normalized page object. It is a deterministic application bound, not the HTTP wire size or JavaScript heap size.

## Duplicate and conflict behavior

When `getId` is set:

- An identical item seen again is retained once and reported as `duplicate_item`.
- The same identity with different content ends collection as `conflicting_identity`.
- Missing or empty identities end collection as `invalid_item`.

Object keys are sorted for equality checks, so key insertion order alone does not create a conflict. Arrays remain order-sensitive. Circular values are invalid.

## Troubleshooting

### `max_pages` with a different cursor every time

The server did not produce an end condition within your bound. Inspect server logs and cursor generation. Raise the bound only when the catalog is legitimately larger and your item/byte limits remain appropriate.

### `cursor_cycle`

The server repeated any previously observed cursor. The diagnostic includes the cursor and zero-based page index. This includes non-adjacent cycles such as `a → b → a`.

### `source_changed`

Your `getVersion` value changed during every allowed attempt. Debounce rapid list-change notifications, increase `maxStabilityRetries` cautiously, or retry later. The previous complete snapshot is preserved.

### `timeout` but the underlying request continues

The supplied operation ignored `AbortSignal`. The collection stops waiting at the configured deadline, but transport cleanup depends on your SDK. Pass the signal into a transport API that supports cancellation. Synchronous fetch callbacks and page processing cannot be preempted by JavaScript timers; the deadline and cancellation state are checked again before reporting a complete collection.

### `conflicting_identity`

Two pages exposed different definitions under one identity. Treat this as an inconsistent catalog rather than selecting an arbitrary winner. Investigate server pagination stability or choose a more precise `getId` if the API's identity rules differ.

### TypeScript rejects my client method

Bind class methods to their client (`client.listTools.bind(client)`). If a client has a different signature, wrap it in a two-argument async function and pass through `params.cursor` and `options.signal` as supported.

## Security and operational limits

- Limits reduce the risk of unbounded accumulation; they do not prove a server or item is trustworthy.
- Item objects are returned by reference. Freeze, clone, or validate them if downstream code mutates or executes data-derived behavior.
- Error messages may originate in a remote client. Sanitize them before exposing them to untrusted users.
- This package does not validate tool schemas, authorize tool calls, enforce URL policies, or protect credentials.
- `getVersion` provides caller-supplied change detection, not a cryptographic or distributed transaction.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Runnable example and related tool

[`examples/mcp-tools.mjs`](examples/mcp-tools.mjs) demonstrates a bounded,
atomic `tools/list` refresh against an MCP SDK-compatible client shape. It is
executed by `npm run check` and ships in the npm tarball.

If the transport itself exposes a long-lived `AsyncIterable`,
[`async-iterator-watchdog`](https://www.npmjs.com/package/async-iterator-watchdog)
can enforce first-progress, idle, and total deadlines around that separate
streaming boundary.

## Development

```sh
npm ci
npm run check
node examples/mcp-tools.mjs
```

The test suite covers finite and adversarial pagination, opaque empty cursors, non-adjacent cycles, hard bounds, ignored cancellation, malformed pages, identity duplicates/conflicts, source-change retries, concurrent refresh fencing, and deterministic randomized page chains.

## License

MIT © 2026 Huzaifa Asif
