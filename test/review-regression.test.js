import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogSnapshotStore, collectPages } from '../src/index.js';

function spin(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {}
}

test('duplicate at maxItems does not exceed the unique-item limit', async () => {
  const result = await collectPages(() => ({ items: [{ name: 'a' }, { name: 'a' }] }), {
    getId: (item) => item.name,
    maxItems: 1,
  });
  assert.equal(result.reason, 'complete');
  assert.equal(result.items.length, 1);
  assert.equal(result.diagnostics[0].code, 'duplicate_item');
});

test('a later duplicate-only final page completes a catalog at maxItems', async () => {
  const result = await collectPages(({ pageIndex }) => pageIndex === 0
    ? { items: [{ name: 'a' }], nextCursor: 'next' }
    : { items: [{ name: 'a' }] }, {
    getId: (item) => item.name,
    maxItems: 1,
  });
  assert.equal(result.reason, 'complete');
  assert.equal(result.pages, 2);
});

test('identity conflict is detected even after unique item capacity is full', async () => {
  const result = await collectPages(() => ({ items: [
    { name: 'a', description: 'one' },
    { name: 'a', description: 'two' },
  ] }), { getId: (item) => item.name, maxItems: 1 });
  assert.equal(result.reason, 'conflicting_identity');
});

test('terminal synchronous fetch cannot commit after the deadline', async () => {
  const store = new CatalogSnapshotStore(['old']);
  const before = store.snapshot;
  let requestSignal;
  const result = await store.refresh(({ signal }) => {
    requestSignal = signal;
    spin(35);
    return { items: ['late'] };
  }, { maxDurationMs: 5 });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.committed, false);
  assert.equal(requestSignal.aborted, true);
  assert.strictEqual(store.snapshot, before);
});

test('terminal page processing cannot commit after the deadline', async () => {
  const store = new CatalogSnapshotStore([{ name: 'old' }]);
  const before = store.snapshot;
  const result = await store.refresh(() => ({ items: [{ name: 'late' }] }), {
    maxDurationMs: 5,
    getId: (item) => { spin(35); return item.name; },
  });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.committed, false);
  assert.strictEqual(store.snapshot, before);
});

test('terminal page processing cannot commit after cancellation', async () => {
  const controller = new AbortController();
  const store = new CatalogSnapshotStore(['old']);
  const before = store.snapshot;
  const result = await store.refresh(() => ({ items: ['new'] }), {
    signal: controller.signal,
    getItems: (page) => { controller.abort('stop'); return page.items; },
  });
  assert.equal(result.reason, 'aborted');
  assert.equal(result.committed, false);
  assert.strictEqual(store.snapshot, before);
});

test('throwing cursor-presence accessor returns invalid_page instead of rejecting', async () => {
  const result = await collectPages(() => ({ items: [] }), {
    hasNextCursor: (page) => Object.hasOwn(page.pagination, 'cursor'),
  });
  assert.equal(result.reason, 'invalid_page');
  assert.equal(result.error.name, 'TypeError');
});

test('cancellation during post-collection version sampling cannot commit', async () => {
  const controller = new AbortController();
  const store = new CatalogSnapshotStore(['old']);
  const before = store.snapshot;
  let reads = 0;
  const result = await store.refresh(() => ({ items: ['new'] }), {
    signal: controller.signal,
    getVersion: async () => {
      reads += 1;
      if (reads === 2) {
        await Promise.resolve();
        controller.abort('stop');
      }
      return 1;
    },
  });
  assert.equal(result.reason, 'aborted');
  assert.equal(result.attempt.reason, 'aborted');
  assert.equal(result.attempt.complete, false);
  assert.equal(result.committed, false);
  assert.equal(result.stabilityRetries, 0);
  assert.strictEqual(store.snapshot, before);
});

test('falsy fetch rejections retain the fetch_error classification and value', async () => {
  for (const rejection of [undefined, null, false, 0, '']) {
    const store = new CatalogSnapshotStore(['old']);
    const before = store.snapshot;
    const result = await store.refresh(() => Promise.reject(rejection));
    assert.equal(result.reason, 'fetch_error');
    assert.equal(result.committed, false);
    assert.strictEqual(store.snapshot, before);
    assert.equal(result.attempt.error.name, 'Error');
    assert.equal(result.attempt.error.message, String(rejection));
  }
});
