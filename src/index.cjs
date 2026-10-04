'use strict';

const DEFAULT_LIMITS = Object.freeze({
  maxPages: 100,
  maxItems: 10_000,
  maxBytes: 16 * 1024 * 1024,
  maxDurationMs: 30_000,
});

const MCP_KINDS = Object.freeze({
  tools: { field: 'tools', identity: 'name' },
  resources: { field: 'resources', identity: 'uri' },
  resourceTemplates: { field: 'resourceTemplates', identity: 'uriTemplate' },
  prompts: { field: 'prompts', identity: 'name' },
});

class CatalogCollectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CatalogCollectionError';
    this.code = code;
  }
}

function positiveInteger(value, fallback, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new CatalogCollectionError(`${name} must be a positive safe integer`, 'invalid_options');
  }
  return result;
}

function nonNegativeInteger(value, fallback, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new CatalogCollectionError(`${name} must be a non-negative safe integer`, 'invalid_options');
  }
  return result;
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stableSerialize(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('circular value');
  seen.add(value);
  const output = Array.isArray(value)
    ? `[${value.map((entry) => stableSerialize(entry, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return output;
}

function outcome(state, reason, error) {
  return Object.freeze({
    complete: reason === 'complete',
    reason,
    items: Object.freeze([...state.items]),
    pages: state.pages,
    bytes: state.bytes,
    elapsedMs: Date.now() - state.startedAt,
    diagnostics: Object.freeze([...state.diagnostics]),
    ...(error ? { error: Object.freeze({ name: error.name || 'Error', message: String(error.message || error) }) } : {}),
  });
}

function abortReason(signal) {
  return signal && signal.aborted ? 'aborted' : undefined;
}

async function collectPages(fetchPage, options = {}) {
  if (typeof fetchPage !== 'function') {
    throw new CatalogCollectionError('fetchPage must be a function', 'invalid_options');
  }
  const limits = {
    maxPages: positiveInteger(options.maxPages, DEFAULT_LIMITS.maxPages, 'maxPages'),
    maxItems: positiveInteger(options.maxItems, DEFAULT_LIMITS.maxItems, 'maxItems'),
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_LIMITS.maxBytes, 'maxBytes'),
    maxDurationMs: positiveInteger(options.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 'maxDurationMs'),
  };
  const getItems = options.getItems || ((page) => page.items);
  const getNextCursor = options.getNextCursor || ((page) => page.nextCursor);
  const hasNextCursor = options.hasNextCursor || ((page) => Object.prototype.hasOwnProperty.call(page, 'nextCursor'));
  const getId = options.getId;
  if (typeof getItems !== 'function' || typeof getNextCursor !== 'function' || typeof hasNextCursor !== 'function') {
    throw new CatalogCollectionError('page accessors must be functions', 'invalid_options');
  }
  if (getId !== undefined && typeof getId !== 'function') {
    throw new CatalogCollectionError('getId must be a function', 'invalid_options');
  }

  const state = { items: [], pages: 0, bytes: 0, diagnostics: [], startedAt: Date.now() };
  const cursors = new Set();
  const identities = new Map();
  let cursor;

  while (true) {
    if (abortReason(options.signal)) return outcome(state, 'aborted');
    if (state.pages >= limits.maxPages) return outcome(state, 'max_pages');
    const remaining = limits.maxDurationMs - (Date.now() - state.startedAt);
    if (remaining <= 0) return outcome(state, 'timeout');

    const controller = new AbortController();
    const interruptionReason = () => {
      if (abortReason(options.signal)) return 'aborted';
      if (Date.now() - state.startedAt >= limits.maxDurationMs) {
        controller.abort(new Error('collection timed out'));
        return 'timeout';
      }
      return undefined;
    };
    let resolveAbort;
    const abort = new Promise((resolve) => { resolveAbort = resolve; });
    const onAbort = () => {
      controller.abort(options.signal && options.signal.reason);
      resolveAbort({ aborted: true });
    };
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error('collection timed out'));
          resolve({ timeout: true });
        }, remaining);
      });
      const request = Promise.resolve()
        .then(() => fetchPage({ cursor, signal: controller.signal, pageIndex: state.pages }))
        .then((page) => ({ page }), (error) => ({ error }));
      const settled = await Promise.race([request, timeout, abort]);
      if (settled.aborted) return outcome(state, 'aborted');
      if (settled.timeout) return outcome(state, 'timeout');
      const interruptedAfterFetch = interruptionReason();
      if (interruptedAfterFetch) return outcome(state, interruptedAfterFetch);
      if (settled.error) return outcome(state, abortReason(options.signal) || 'fetch_error', settled.error);

      const page = settled.page;
      let entries;
      try {
        entries = getItems(page);
        state.bytes += byteLength(page);
      } catch (error) {
        return outcome(state, 'invalid_page', error);
      }
      if (!Array.isArray(entries)) return outcome(state, 'invalid_page', new TypeError('page items must be an array'));
      state.pages += 1;
      if (state.bytes > limits.maxBytes) return outcome(state, 'max_bytes');

      for (const item of entries) {
        const interrupted = interruptionReason();
        if (interrupted) return outcome(state, interrupted);
        if (!getId) {
          if (state.items.length >= limits.maxItems) return outcome(state, 'max_items');
          state.items.push(item);
          continue;
        }
        let id;
        let serialized;
        try {
          id = getId(item);
          if (typeof id !== 'string' || id.length === 0) throw new TypeError('item identity must be a non-empty string');
          serialized = stableSerialize(item);
        } catch (error) {
          return outcome(state, 'invalid_item', error);
        }
        if (identities.has(id)) {
          if (identities.get(id) !== serialized) {
            state.diagnostics.push(Object.freeze({ code: 'conflicting_identity', id, pageIndex: state.pages - 1 }));
            return outcome(state, 'conflicting_identity');
          }
          state.diagnostics.push(Object.freeze({ code: 'duplicate_item', id, pageIndex: state.pages - 1 }));
          continue;
        }
        if (state.items.length >= limits.maxItems) return outcome(state, 'max_items');
        identities.set(id, serialized);
        state.items.push(item);
      }

      let hasNext;
      let nextCursor;
      try {
        hasNext = hasNextCursor(page);
        if (hasNext) nextCursor = getNextCursor(page);
      } catch (error) {
        return outcome(state, 'invalid_page', error);
      }
      const interruptedAfterPage = interruptionReason();
      if (interruptedAfterPage) return outcome(state, interruptedAfterPage);
      if (!hasNext) return outcome(state, 'complete');
      if (typeof nextCursor !== 'string') {
        return outcome(state, 'invalid_page', new TypeError('nextCursor must be a string when present'));
      }
      if (cursors.has(nextCursor)) {
        state.diagnostics.push(Object.freeze({ code: 'cursor_cycle', cursor: nextCursor, pageIndex: state.pages - 1 }));
        return outcome(state, 'cursor_cycle');
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }
}

function createMcpFetcher(listOperation, kind) {
  if (typeof listOperation !== 'function') {
    throw new CatalogCollectionError('listOperation must be a function', 'invalid_options');
  }
  const config = MCP_KINDS[kind];
  if (!config) throw new CatalogCollectionError(`unsupported MCP kind: ${kind}`, 'invalid_options');
  return async ({ cursor, signal }) => {
    const params = cursor === undefined ? {} : { cursor };
    const result = await listOperation(params, { signal });
    if (!result || typeof result !== 'object' || !Array.isArray(result[config.field])) {
      throw new TypeError(`MCP ${kind} response must contain ${config.field}[]`);
    }
    return Object.prototype.hasOwnProperty.call(result, 'nextCursor')
      ? { items: result[config.field], nextCursor: result.nextCursor }
      : { items: result[config.field] };
  };
}

async function collectMcpCatalog(listOperation, kind, options = {}) {
  const config = MCP_KINDS[kind];
  if (!config) throw new CatalogCollectionError(`unsupported MCP kind: ${kind}`, 'invalid_options');
  return collectPages(createMcpFetcher(listOperation, kind), {
    ...options,
    getId: options.getId || ((item) => item && item[config.identity]),
  });
}

class CatalogSnapshotStore {
  constructor(initialSnapshot) {
    this._snapshot = initialSnapshot === undefined ? undefined : Object.freeze({
      revision: 0,
      items: Object.freeze([...initialSnapshot]),
      collectedAt: new Date().toISOString(),
    });
    this._epoch = 0;
  }

  get snapshot() {
    return this._snapshot;
  }

  async refresh(fetchPage, options = {}) {
    const epoch = ++this._epoch;
    const retries = nonNegativeInteger(options.maxStabilityRetries, 1, 'maxStabilityRetries');
    const getVersion = options.getVersion;
    if (getVersion !== undefined && typeof getVersion !== 'function') {
      throw new CatalogCollectionError('getVersion must be a function', 'invalid_options');
    }
    let attempt;
    let stabilityRetries = 0;
    for (let index = 0; index <= retries; index += 1) {
      const versionBefore = getVersion ? await getVersion() : undefined;
      attempt = await collectPages(fetchPage, options);
      const versionAfter = getVersion ? await getVersion() : undefined;
      if (abortReason(options.signal)) {
        attempt = Object.freeze({ ...attempt, complete: false, reason: 'aborted' });
        break;
      }
      if (!attempt.complete || !getVersion || Object.is(versionBefore, versionAfter)) break;
      stabilityRetries += 1;
      attempt = Object.freeze({ ...attempt, complete: false, reason: 'source_changed' });
    }
    if (epoch !== this._epoch) {
      return Object.freeze({ committed: false, reason: 'superseded', stabilityRetries, attempt, snapshot: this._snapshot });
    }
    if (!attempt.complete) {
      return Object.freeze({ committed: false, reason: attempt.reason, stabilityRetries, attempt, snapshot: this._snapshot });
    }
    this._snapshot = Object.freeze({
      revision: (this._snapshot ? this._snapshot.revision : 0) + 1,
      items: Object.freeze([...attempt.items]),
      collectedAt: new Date().toISOString(),
      pages: attempt.pages,
      bytes: attempt.bytes,
    });
    return Object.freeze({ committed: true, reason: 'complete', stabilityRetries, attempt, snapshot: this._snapshot });
  }
}

module.exports = {
  CatalogCollectionError,
  CatalogSnapshotStore,
  DEFAULT_LIMITS,
  MCP_KINDS,
  collectMcpCatalog,
  collectPages,
  createMcpFetcher,
};
