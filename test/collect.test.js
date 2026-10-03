import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CatalogCollectionError,
  CatalogSnapshotStore,
  collectMcpCatalog,
  collectPages,
  createMcpFetcher,
} from '../src/index.js';

test('collects every page and passes opaque cursors unchanged', async () => {
  const seen = [];
  const pages = new Map([
    [undefined, { items: [{ id: 'a' }], nextCursor: '' }],
    ['', { items: [{ id: 'b' }], nextCursor: 'opaque+/=' }],
    ['opaque+/=', { items: [{ id: 'c' }] }],
  ]);
  const result = await collectPages(({ cursor }) => {
    seen.push(cursor);
    return pages.get(cursor);
  }, { getId: (item) => item.id });
  assert.equal(result.complete, true);
  assert.equal(result.reason, 'complete');
  assert.deepEqual(result.items.map(({ id }) => id), ['a', 'b', 'c']);
  assert.deepEqual(seen, [undefined, '', 'opaque+/=']);
  assert.equal(result.pages, 3);
});

test('stops infinitely changing cursors at maxPages', async () => {
  const result = await collectPages(({ pageIndex }) => ({
    items: [{ pageIndex }],
    nextCursor: `cursor-${pageIndex}`,
  }), { maxPages: 4 });
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'max_pages');
  assert.equal(result.pages, 4);
  assert.equal(result.items.length, 4);
});

test('detects non-adjacent cursor cycles', async () => {
  const cursors = ['a', 'b', 'a'];
  const result = await collectPages(({ pageIndex }) => ({
    items: [pageIndex],
    nextCursor: cursors[pageIndex],
  }));
  assert.equal(result.reason, 'cursor_cycle');
  assert.deepEqual(result.diagnostics, [{ code: 'cursor_cycle', cursor: 'a', pageIndex: 2 }]);
});

test('enforces item and byte bounds without claiming completeness', async () => {
  const items = await collectPages(() => ({ items: [1, 2, 3] }), { maxItems: 2 });
  assert.equal(items.reason, 'max_items');
  assert.deepEqual(items.items, [1, 2]);

  const bytes = await collectPages(() => ({ items: ['a very large value'] }), { maxBytes: 2 });
  assert.equal(bytes.reason, 'max_bytes');
  assert.deepEqual(bytes.items, []);
});

test('times out even when a fetch ignores AbortSignal', async () => {
  const result = await collectPages(() => new Promise(() => {}), { maxDurationMs: 10 });
  assert.equal(result.reason, 'timeout');
});

test('reports external abort', async () => {
  const controller = new AbortController();
  controller.abort('stop');
  const result = await collectPages(() => ({ items: [] }), { signal: controller.signal });
  assert.equal(result.reason, 'aborted');
  assert.equal(result.pages, 0);
});

test('classifies fetch errors and invalid pages', async () => {
  const failed = await collectPages(() => { throw new Error('offline'); });
  assert.equal(failed.reason, 'fetch_error');
  assert.deepEqual(failed.error, { name: 'Error', message: 'offline' });

  const missingItems = await collectPages(() => ({ nextCursor: 'x' }));
  assert.equal(missingItems.reason, 'invalid_page');

  const badCursor = await collectPages(() => ({ items: [], nextCursor: 2 }));
  assert.equal(badCursor.reason, 'invalid_page');
});

test('deduplicates identical identities but rejects conflicting identities', async () => {
  const duplicate = await collectPages(() => ({ items: [{ name: 'x', description: 'same' }, { description: 'same', name: 'x' }] }), {
    getId: (item) => item.name,
  });
  assert.equal(duplicate.complete, true);
  assert.equal(duplicate.items.length, 1);
  assert.equal(duplicate.diagnostics[0].code, 'duplicate_item');

  const conflict = await collectPages(() => ({ items: [{ name: 'x', description: 'a' }, { name: 'x', description: 'b' }] }), {
    getId: (item) => item.name,
  });
  assert.equal(conflict.reason, 'conflicting_identity');
  assert.equal(conflict.items.length, 1);
});

test('MCP adapter maps all four catalog kinds and omits the initial cursor', async () => {
  for (const [kind, field, identity] of [
    ['tools', 'tools', { name: 'one' }],
    ['resources', 'resources', { uri: 'file:///one' }],
    ['resourceTemplates', 'resourceTemplates', { uriTemplate: 'file:///{id}' }],
    ['prompts', 'prompts', { name: 'one' }],
  ]) {
    const requests = [];
    const result = await collectMcpCatalog((params, options) => {
      requests.push(params);
      assert.ok(options.signal instanceof AbortSignal);
      return Promise.resolve({ [field]: [identity] });
    }, kind);
    assert.equal(result.complete, true);
    assert.deepEqual(requests, [{}]);
  }
});

test('MCP adapter validates kind and result shape', async () => {
  assert.throws(() => createMcpFetcher(() => {}, 'unknown'), CatalogCollectionError);
  const result = await collectMcpCatalog(async () => ({ wrong: [] }), 'tools');
  assert.equal(result.reason, 'fetch_error');
});

test('snapshot store preserves last known good data on incomplete refresh', async () => {
  const store = new CatalogSnapshotStore([{ name: 'old' }]);
  const before = store.snapshot;
  const failed = await store.refresh(({ pageIndex }) => ({ items: [{ name: `new-${pageIndex}` }], nextCursor: String(pageIndex) }), {
    maxPages: 2,
  });
  assert.equal(failed.committed, false);
  assert.equal(failed.reason, 'max_pages');
  assert.strictEqual(failed.snapshot, before);
  assert.deepEqual(store.snapshot.items, [{ name: 'old' }]);
});

test('snapshot store retries source changes and commits only a stable collection', async () => {
  const store = new CatalogSnapshotStore();
  let generation = 0;
  let calls = 0;
  const result = await store.refresh(() => {
    calls += 1;
    if (calls === 1) generation += 1;
    return { items: [{ generation }] };
  }, { getVersion: () => generation, maxStabilityRetries: 2 });
  assert.equal(result.committed, true);
  assert.equal(result.stabilityRetries, 1);
  assert.deepEqual(result.snapshot.items, [{ generation: 1 }]);
});

test('snapshot store refuses an unstable source after bounded retries', async () => {
  const store = new CatalogSnapshotStore([{ name: 'old' }]);
  let version = 0;
  const result = await store.refresh(() => ({ items: [{ name: 'new' }] }), {
    getVersion: () => version++,
    maxStabilityRetries: 2,
  });
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'source_changed');
  assert.deepEqual(result.snapshot.items, [{ name: 'old' }]);
});

test('snapshot store permits zero stability retries', async () => {
  const store = new CatalogSnapshotStore([{ name: 'old' }]);
  let version = 0;
  const result = await store.refresh(() => {
    version += 1;
    return { items: [{ name: 'new' }] };
  }, { getVersion: () => version, maxStabilityRetries: 0 });
  assert.equal(result.reason, 'source_changed');
  assert.deepEqual(result.snapshot.items, [{ name: 'old' }]);
});

test('newer concurrent refresh supersedes an older result', async () => {
  const store = new CatalogSnapshotStore();
  let release;
  const slow = store.refresh(() => new Promise((resolve) => { release = () => resolve({ items: ['slow'] }); }));
  await new Promise((resolve) => setImmediate(resolve));
  const fast = await store.refresh(() => ({ items: ['fast'] }));
  release();
  const stale = await slow;
  assert.equal(fast.committed, true);
  assert.equal(stale.reason, 'superseded');
  assert.deepEqual(store.snapshot.items, ['fast']);
});

test('random finite page chains preserve order and completeness', async () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let run = 0; run < 100; run += 1) {
    const pageCount = 1 + Math.floor(random() * 20);
    const expected = [];
    const result = await collectPages(({ pageIndex }) => {
      const count = Math.floor(random() * 8);
      const entries = Array.from({ length: count }, (_, index) => `${run}:${pageIndex}:${index}`);
      expected.push(...entries);
      return pageIndex + 1 < pageCount
        ? { items: entries, nextCursor: `opaque-${run}-${pageIndex}` }
        : { items: entries };
    }, { maxPages: 25, maxItems: 10_000 });
    assert.equal(result.complete, true);
    assert.deepEqual(result.items, expected);
  }
});

test('invalid numeric options fail before calling user code', async () => {
  let called = false;
  await assert.rejects(
    collectPages(() => { called = true; }, { maxPages: 0 }),
    (error) => error instanceof CatalogCollectionError && error.code === 'invalid_options',
  );
  assert.equal(called, false);
});
