/**
 * Tests for the short-lived Shopify read cache (written from the contract, not the code).
 * A manual clock drives every expiry; no real time passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTtlCache,
  readThrough,
  dashboardCache,
  shopCacheKey,
  invalidateShop,
} from '../app/lib/shopify-cache.server.js';
import { createClock, deferred, tick } from './fixtures/m7-fixtures.js';

const make = (opts = {}) => {
  const clock = createClock(0);
  return { clock, cache: createTtlCache({ ttlMs: 1000, now: clock.now, ...opts }) };
};

// ---- createTtlCache ----

test('get returns undefined for a key that was never set', () => {
  const { cache } = make();
  assert.equal(cache.get('nope'), undefined);
  assert.equal(cache.size(), 0);
});

test('a stored value is returned exactly as stored (same reference)', () => {
  const { cache } = make();
  const value = { a: [1, 2] };
  cache.set('k', value);
  assert.equal(cache.get('k'), value);
});

test('an entry lives for ttlMs - 1 and expires at exactly ttlMs', () => {
  const { cache, clock } = make();
  cache.set('k', 'v'); // stored at 0
  clock.set(999);
  assert.equal(cache.get('k'), 'v');
  clock.set(1000);
  assert.equal(cache.get('k'), undefined);
});

test('an expired entry is removed when it is accessed', () => {
  const { cache, clock } = make();
  cache.set('k', 'v');
  assert.equal(cache.size(), 1);
  clock.set(5000);
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.size(), 0);
  clock.set(0); // even if time somehow went back, the entry is gone
  assert.equal(cache.get('k'), undefined);
});

test('set overwrites the value and refreshes the stored time', () => {
  const { cache, clock } = make();
  cache.set('k', 'one'); // stored at 0
  clock.set(600);
  cache.set('k', 'two'); // stored at 600
  clock.set(1200); // 1200 - 600 = 600 < 1000 -> still there (it would be expired if storedAt stayed 0)
  assert.equal(cache.get('k'), 'two');
  clock.set(1600); // 1000 -> expired
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.size(), 0);
});

test('entries expire independently', () => {
  const { cache, clock } = make();
  cache.set('old', 1); // 0
  clock.set(500);
  cache.set('new', 2); // 500
  clock.set(1000);
  assert.equal(cache.get('old'), undefined);
  assert.equal(cache.get('new'), 2); // 1000 - 500 = 500 < 1000
});

test('default ttl is 60000 ms', () => {
  const clock = createClock(0);
  const cache = createTtlCache({ now: clock.now });
  cache.set('k', 'v');
  clock.set(59999);
  assert.equal(cache.get('k'), 'v');
  clock.set(60000);
  assert.equal(cache.get('k'), undefined);
});

test('createTtlCache() with no arguments works', () => {
  const cache = createTtlCache();
  cache.set('k', 'v');
  assert.equal(cache.get('k'), 'v');
  assert.equal(cache.size(), 1);
});

test('exceeding maxEntries evicts the oldest-stored entry first', () => {
  const { cache, clock } = make({ maxEntries: 2 });
  cache.set('a', 1);
  clock.advance(1);
  cache.set('b', 2);
  clock.advance(1);
  cache.set('c', 3); // 3 entries -> evict a
  assert.equal(cache.size(), 2);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  clock.advance(1);
  cache.set('d', 4); // evict b (older than c)
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.get('d'), 4);
  assert.equal(cache.size(), 2);
});

test('overwriting a key at the limit does not evict anything', () => {
  const { cache, clock } = make({ maxEntries: 2 });
  cache.set('a', 1);
  clock.advance(1);
  cache.set('b', 2);
  clock.advance(1);
  cache.set('a', 10);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get('a'), 10);
  assert.equal(cache.get('b'), 2);
});

test('an overwritten key counts as newly stored when choosing what to evict', () => {
  const { cache, clock } = make({ maxEntries: 2 });
  cache.set('a', 1); // 0
  clock.advance(1);
  cache.set('b', 2); // 1
  clock.advance(1);
  cache.set('a', 11); // a refreshed at 2, so b is now the oldest
  clock.advance(1);
  cache.set('c', 3); // evicts b
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 11);
  assert.equal(cache.get('c'), 3);
});

test('maxEntries of 1 keeps only the latest entry', () => {
  const { cache, clock } = make({ maxEntries: 1 });
  cache.set('a', 1);
  clock.advance(1);
  cache.set('b', 2);
  assert.equal(cache.size(), 1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
});

test('delete removes one key and leaves the others', () => {
  const { cache } = make();
  cache.set('a', 1);
  cache.set('b', 2);
  cache.delete('a');
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.size(), 1);
  cache.delete('missing'); // no throw
  assert.equal(cache.size(), 1);
});

test('deleteByPrefix removes only keys that start with the prefix', () => {
  const { cache } = make();
  cache.set('x::1', 1);
  cache.set('x::2', 2);
  cache.set('xx::1', 3);
  cache.set('y::x::1', 4);
  cache.deleteByPrefix('x::');
  assert.equal(cache.get('x::1'), undefined);
  assert.equal(cache.get('x::2'), undefined);
  assert.equal(cache.get('xx::1'), 3);
  assert.equal(cache.get('y::x::1'), 4);
  assert.equal(cache.size(), 2);
});

test('clear empties the cache and it can be used again', () => {
  const { cache } = make();
  cache.set('a', 1);
  cache.set('b', 2);
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 3);
  assert.equal(cache.get('a'), 3);
});

test('two caches do not share entries', () => {
  const one = createTtlCache();
  const two = createTtlCache();
  one.set('k', 1);
  assert.equal(two.get('k'), undefined);
});

// ---- readThrough ----

test('readThrough loads on a miss, stores the result and serves the next call from the cache', async () => {
  const { cache } = make();
  let calls = 0;
  const loader = async () => { calls += 1; return { n: calls }; };
  const first = await readThrough({ cache, key: 'k', loader });
  const second = await readThrough({ cache, key: 'k', loader });
  assert.deepEqual(first, { n: 1 });
  assert.equal(second, first);
  assert.equal(calls, 1);
  assert.equal(cache.get('k'), first);
});

test('readThrough returns an already cached value without calling the loader', async () => {
  const { cache } = make();
  cache.set('k', 'cached');
  const out = await readThrough({ cache, key: 'k', loader: async () => assert.fail('loader must not run') });
  assert.equal(out, 'cached');
});

test('readThrough reloads after the entry expires', async () => {
  const { cache, clock } = make();
  let calls = 0;
  const loader = async () => ++calls;
  assert.equal(await readThrough({ cache, key: 'k', loader }), 1);
  clock.set(1000);
  assert.equal(await readThrough({ cache, key: 'k', loader }), 2);
  assert.equal(calls, 2);
});

test('readThrough keeps different keys apart', async () => {
  const { cache } = make();
  const a = await readThrough({ cache, key: 'a', loader: async () => 'A' });
  const b = await readThrough({ cache, key: 'b', loader: async () => 'B' });
  assert.deepEqual([a, b], ['A', 'B']);
});

test('concurrent callers for the same key share one loader call', async () => {
  const { cache } = make();
  const gate = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return gate.promise; };
  const pending = [1, 2, 3, 4].map(() => readThrough({ cache, key: 'k', loader }));
  await tick();
  assert.equal(calls, 1);
  gate.resolve('value');
  assert.deepEqual(await Promise.all(pending), ['value', 'value', 'value', 'value']);
  assert.equal(calls, 1);
  assert.equal(cache.get('k'), 'value');
});

test('concurrent callers for different keys each run their own loader', async () => {
  const { cache } = make();
  const gates = { a: deferred(), b: deferred() };
  const seen = [];
  const run = (key) => readThrough({ cache, key, loader: () => { seen.push(key); return gates[key].promise; } });
  const pa = run('a');
  const pb = run('b');
  await tick();
  assert.deepEqual(seen.sort(), ['a', 'b']);
  gates.a.resolve(1);
  gates.b.resolve(2);
  assert.deepEqual(await Promise.all([pa, pb]), [1, 2]);
});

test('a loader rejection is not cached, reaches every concurrent caller, and the next call retries', async () => {
  const { cache } = make();
  const gate = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return calls === 1 ? gate.promise : Promise.resolve('ok'); };
  const failure = new Error('boom');
  const pending = [0, 1, 2].map(() => readThrough({ cache, key: 'k', loader }).then(() => 'resolved', (e) => e));
  await tick();
  gate.reject(failure);
  const outcomes = await Promise.all(pending);
  assert.deepEqual(outcomes, [failure, failure, failure]);
  assert.equal(calls, 1);
  assert.equal(cache.get('k'), undefined);
  assert.equal(await readThrough({ cache, key: 'k', loader }), 'ok');
  assert.equal(calls, 2);
});

test('a synchronous throw from the loader surfaces as a rejection and is retried next time', async () => {
  const { cache } = make();
  let calls = 0;
  const loader = () => { calls += 1; if (calls === 1) throw new Error('sync'); return 'fine'; };
  await assert.rejects(readThrough({ cache, key: 'k', loader }), /sync/);
  assert.equal(await readThrough({ cache, key: 'k', loader }), 'fine');
  assert.equal(calls, 2);
});

test('the in-flight record is removed after settling (a deleted entry is loaded again)', async () => {
  const { cache } = make();
  let calls = 0;
  const loader = async () => ++calls;
  assert.equal(await readThrough({ cache, key: 'k', loader }), 1);
  cache.delete('k');
  assert.equal(await readThrough({ cache, key: 'k', loader }), 2);
  assert.equal(calls, 2);
});

test('falsy loader results (0, null, empty string) are cached like any other value', async () => {
  for (const value of [0, null, '']) {
    const { cache } = make();
    let calls = 0;
    const loader = async () => { calls += 1; return value; };
    assert.equal(await readThrough({ cache, key: 'k', loader }), value);
    assert.equal(await readThrough({ cache, key: 'k', loader }), value);
    assert.equal(calls, 1, `loader called once for ${JSON.stringify(value)}`);
  }
});

// ---- dashboardCache, shopCacheKey, invalidateShop ----

test('dashboardCache is a cache with the full interface', () => {
  for (const name of ['get', 'set', 'delete', 'deleteByPrefix', 'clear', 'size']) {
    assert.equal(typeof dashboardCache[name], 'function', name);
  }
  dashboardCache.clear();
  dashboardCache.set('t::k', 1);
  assert.equal(dashboardCache.get('t::k'), 1);
  dashboardCache.clear();
  assert.equal(dashboardCache.size(), 0);
});

test('shopCacheKey builds shop::kind for stock and demand', () => {
  assert.equal(shopCacheKey('a.myshopify.com', 'stock'), 'a.myshopify.com::stock');
  assert.equal(shopCacheKey('a.myshopify.com', 'demand'), 'a.myshopify.com::demand');
});

test('shopCacheKey rejects any other kind', () => {
  for (const kind of ['other', '', undefined, null, 'STOCK', 'stock ']) {
    assert.throws(() => shopCacheKey('a.myshopify.com', kind), { message: 'Unknown cache kind.' }, String(kind));
  }
});

test('invalidateShop removes every key of that shop and nothing else', () => {
  const { cache } = make();
  const a = 'a.myshopify.com';
  const evil = 'a.myshopify.com.evil';
  cache.set(shopCacheKey(a, 'stock'), 1);
  cache.set(shopCacheKey(a, 'demand'), 2);
  cache.set(shopCacheKey(evil, 'stock'), 3); // shares a text prefix with the first shop
  cache.set(shopCacheKey('b.myshopify.com', 'stock'), 4);
  invalidateShop(cache, a);
  assert.equal(cache.get(shopCacheKey(a, 'stock')), undefined);
  assert.equal(cache.get(shopCacheKey(a, 'demand')), undefined);
  assert.equal(cache.get(shopCacheKey(evil, 'stock')), 3);
  assert.equal(cache.get(shopCacheKey('b.myshopify.com', 'stock')), 4);
  assert.equal(cache.size(), 2);
});

test('invalidateShop on a shop with no entries changes nothing', () => {
  const { cache } = make();
  cache.set(shopCacheKey('b.myshopify.com', 'stock'), 4);
  invalidateShop(cache, 'a.myshopify.com');
  assert.equal(cache.size(), 1);
});

test('after invalidateShop a readThrough reloads that shop', async () => {
  const { cache } = make();
  const shop = 'a.myshopify.com';
  const key = shopCacheKey(shop, 'stock');
  let calls = 0;
  const loader = async () => ++calls;
  assert.equal(await readThrough({ cache, key, loader }), 1);
  invalidateShop(cache, shop);
  assert.equal(await readThrough({ cache, key, loader }), 2);
});

// ---- invalidation during a load (behaviour beyond the written contract) ----

test('a load that finishes after invalidateShop returns its value but does not store it', async () => {
  const { cache } = make();
  const shop = 'a.myshopify.com';
  const key = shopCacheKey(shop, 'stock');
  const gate = deferred();
  const pending = readThrough({ cache, key, loader: () => gate.promise });
  await tick();
  invalidateShop(cache, shop);
  gate.resolve('stale');
  assert.equal(await pending, 'stale');
  assert.equal(cache.get(key), undefined);
});

test('a caller arriving after an invalidation starts a fresh load instead of joining the old one', async () => {
  const { cache } = make();
  const shop = 'a.myshopify.com';
  const key = shopCacheKey(shop, 'stock');
  const oldGate = deferred();
  const first = readThrough({ cache, key, loader: () => oldGate.promise });
  await tick();
  invalidateShop(cache, shop);
  const second = readThrough({ cache, key, loader: async () => 'fresh' });
  assert.equal(await second, 'fresh');
  assert.equal(cache.get(key), 'fresh');
  oldGate.resolve('stale');
  assert.equal(await first, 'stale');
  assert.equal(cache.get(key), 'fresh'); // the old load did not overwrite the newer value
});

test('two caches never share an in-flight load for the same key', async () => {
  const one = createTtlCache();
  const two = createTtlCache();
  const gate = deferred();
  const p1 = readThrough({ cache: one, key: 'k', loader: () => gate.promise });
  const p2 = readThrough({ cache: two, key: 'k', loader: async () => 'other' });
  assert.equal(await p2, 'other');
  gate.resolve('mine');
  assert.equal(await p1, 'mine');
});

// ---- generation counter ----

test('generation() starts as an integer and is bumped by delete, deleteByPrefix and clear', () => {
  const { cache } = make();
  const g0 = cache.generation();
  assert.ok(Number.isInteger(g0));
  cache.delete('missing');
  const g1 = cache.generation();
  assert.ok(g1 > g0);
  cache.deleteByPrefix('x::');
  const g2 = cache.generation();
  assert.ok(g2 > g1);
  cache.clear();
  assert.ok(cache.generation() > g2);
});

test('set(), get() and expiry do not change generation()', () => {
  const { cache, clock } = make({ maxEntries: 1 });
  const g = cache.generation();
  cache.set('a', 1);
  cache.set('b', 2); // evicts a
  cache.set('b', 3);
  cache.get('b');
  clock.set(5000);
  cache.get('b'); // expires
  assert.equal(cache.generation(), g);
});

test('two concurrent callers before an invalidation still share one loader call', async () => {
  const { cache } = make();
  const gate = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return gate.promise; };
  const p1 = readThrough({ cache, key: 'k', loader });
  const p2 = readThrough({ cache, key: 'k', loader });
  await tick();
  assert.equal(calls, 1);
  gate.resolve('v');
  assert.deepEqual(await Promise.all([p1, p2]), ['v', 'v']);
  assert.equal(cache.get('k'), 'v'); // no invalidation happened, so it is stored
});

test('invalidation while a slow load is in flight: stale value returned to its callers, not stored; new read gets its own result', async () => {
  const { cache } = make();
  const slow = deferred();
  const pStale = readThrough({ cache, key: 'k', loader: () => slow.promise });
  const pStale2 = readThrough({ cache, key: 'k', loader: () => assert.fail('joined the same load') });
  await tick();
  cache.clear();
  let freshCalls = 0;
  const pFresh = readThrough({ cache, key: 'k', loader: async () => { freshCalls += 1; return 'fresh'; } });
  assert.equal(await pFresh, 'fresh');
  assert.equal(freshCalls, 1);
  slow.resolve('stale');
  assert.deepEqual(await Promise.all([pStale, pStale2]), ['stale', 'stale']);
  assert.equal(cache.get('k'), 'fresh');
});

test('a stale load that fails after an invalidation does not disturb a newer load', async () => {
  const { cache } = make();
  const slow = deferred();
  const stale = readThrough({ cache, key: 'k', loader: () => slow.promise }).then(() => 'ok', (e) => e);
  await tick();
  cache.delete('k');
  const newer = deferred();
  const pNewer = readThrough({ cache, key: 'k', loader: () => newer.promise });
  slow.reject(new Error('late'));
  assert.equal((await stale).message, 'late');
  // a third caller still joins the newer load rather than starting another
  const pJoin = readThrough({ cache, key: 'k', loader: () => assert.fail('should join the newer load') });
  newer.resolve('n');
  assert.deepEqual(await Promise.all([pNewer, pJoin]), ['n', 'n']);
  assert.equal(cache.get('k'), 'n');
});
