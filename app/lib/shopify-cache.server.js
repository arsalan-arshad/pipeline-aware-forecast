/**
 * Short-lived in-memory cache for the Shopify reads behind the dashboard.
 * Entries expire after a TTL, the oldest entry is evicted when the cache is
 * full, and concurrent loads of one key share a single in-flight request.
 * Failed loads are never cached. Only Shopify stock and sales are cached,
 * never forecast rows, Salesforce data or database data.
 */

/**
 * @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [options]
 */
export function createTtlCache({
  ttlMs = 60000,
  maxEntries = 500,
  now = () => Date.now(),
} = {}) {
  // Map keeps insertion order; set() re-inserts so the first key is the oldest stored.
  const entries = new Map();
  // Bumped by every delete/clear so a load that started before an invalidation never stores
  // its (possibly stale) result afterwards.
  let generation = 0;
  return {
    generation() {
      return generation;
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.storedAt >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      while (entries.size >= maxEntries && entries.size > 0) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, storedAt: now() });
    },
    delete(key) {
      generation += 1;
      return entries.delete(key);
    },
    deleteByPrefix(prefix) {
      generation += 1;
      let removed = 0;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    clear() {
      generation += 1;
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

// In-flight loads per cache, so separate caches never share a promise.
const inflightByCache = new WeakMap();

/**
 * Return the cached value for `key`, or run `loader` once (shared by all
 * concurrent callers) and cache what it resolves to. Rejections are not cached.
 */
export function readThrough({ cache, key, loader }) {
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  let inflight = inflightByCache.get(cache);
  if (!inflight) {
    inflight = new Map();
    inflightByCache.set(cache, inflight);
  }
  const startedAt = typeof cache.generation === "function" ? cache.generation() : 0;
  const pending = inflight.get(key);
  // Join an in-flight load only if no invalidation happened since it started.
  if (pending && pending.generation === startedAt) return pending.promise;
  const promise = (async () => {
    try {
      // Yield once so the in-flight record is registered before the loader runs; otherwise a loader
      // that throws synchronously would be cleaned up first and registered (rejected) afterwards.
      await null;
      const value = await loader();
      const unchanged =
        typeof cache.generation !== "function" || cache.generation() === startedAt;
      if (unchanged) cache.set(key, value);
      return value;
    } finally {
      const current = inflight.get(key);
      if (current && current.promise === promise) inflight.delete(key);
    }
  })();
  inflight.set(key, { promise, generation: startedAt });
  return promise;
}

export const dashboardCache = createTtlCache({ ttlMs: 60000 });

const CACHE_KINDS = new Set(["stock", "demand"]);

export function shopCacheKey(shop, kind) {
  if (!CACHE_KINDS.has(kind)) throw new Error("Unknown cache kind.");
  return `${shop}::${kind}`;
}

export function invalidateShop(cache, shop) {
  return cache.deleteByPrefix(`${shop}::`);
}
