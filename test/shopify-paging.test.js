// Independent tests for Shopify nested paging, shared page budget and throttle retry, written from the contract only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as data from '../app/lib/shopify-data.server.js';
import {
  ShopifyDataError, VARIANT_SKUS_QUERY, SKU_STOCK_QUERY, ORDERS_DEMAND_QUERY,
  INVENTORY_LEVELS_MORE_QUERY, ORDER_LINE_ITEMS_MORE_QUERY,
  fetchVariantSkus, fetchSkuStock, fetchDailyDemand,
} from '../app/lib/shopify-data.server.js';
import {
  createFakeAdmin, variantsPage, stockPage, ordersPage, levelsMorePage, lineItemsMorePage, THROTTLED,
} from './fixtures/shell-fixtures.js';

const NOW = new Date('2026-03-30T12:00:00.000Z');
const BAD_WORDS = new RegExp(['customer', ['e', 'mail'].join(''), ['pho', 'ne'].join(''), 'address', 'billing', 'shipping'].join('|'), 'i');
const more = (cursor) => ({ hasNextPage: true, endCursor: cursor });

const isErr = (code) => (e) => e instanceof ShopifyDataError && e.code === code;

// Admin whose answer is computed from (query, variables, callIndex); records every call.
function handlerAdmin(handler) {
  const calls = [];
  return {
    calls,
    async graphql(query, options) {
      const variables = options?.variables;
      const index = calls.length;
      calls.push({ query, variables });
      const body = handler(query, variables, index);
      if (body instanceof Error) throw body;
      return { async json() { return body; } };
    },
  };
}

function sleeper() {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  return { sleep, waits };
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---- exported constants ----
test('follow-up query constants are exported strings, read-only and free of personal-data words', () => {
  for (const q of [INVENTORY_LEVELS_MORE_QUERY, ORDER_LINE_ITEMS_MORE_QUERY]) {
    assert.equal(typeof q, 'string');
    assert.match(q.replace(/^\s*#graphql/, '').trim(), /^query\b/);
    assert.ok(!BAD_WORDS.test(q));
    assert.ok(!/\bmutation\b/i.test(q));
    assert.match(q, /pageInfo/);
    assert.match(q, /hasNextPage/);
    assert.match(q, /endCursor/);
    assert.match(q, /\$id\b/);
    assert.match(q, /\$cursor\b/);
  }
  assert.match(INVENTORY_LEVELS_MORE_QUERY, /inventoryLevels/);
  assert.match(ORDER_LINE_ITEMS_MORE_QUERY, /lineItems/);
  assert.match(ORDER_LINE_ITEMS_MORE_QUERY, /currentQuantity/);
});

test('every query, top-level and follow-up, is read-only and personal-data free', () => {
  for (const q of [VARIANT_SKUS_QUERY, SKU_STOCK_QUERY, ORDERS_DEMAND_QUERY, INVENTORY_LEVELS_MORE_QUERY, ORDER_LINE_ITEMS_MORE_QUERY]) {
    assert.ok(!BAD_WORDS.test(q));
    assert.ok(!/\bmutation\b/i.test(q));
  }
});

test('top-level queries select the nested paging fields', () => {
  assert.match(SKU_STOCK_QUERY, /inventoryItem\s*\{[^]*\bid\b/);
  assert.match(SKU_STOCK_QUERY, /inventoryLevels\s*\([^)]*first/);
  assert.match(SKU_STOCK_QUERY, /pageInfo/);
  assert.match(ORDERS_DEMAND_QUERY, /\bid\b/);
  assert.match(ORDERS_DEMAND_QUERY, /lineItems\s*\([^)]*first/);
  assert.match(ORDERS_DEMAND_QUERY, /currentQuantity/);
});

test('exported query constants cannot be reassigned through the module namespace', () => {
  for (const name of ['INVENTORY_LEVELS_MORE_QUERY', 'ORDER_LINE_ITEMS_MORE_QUERY']) {
    assert.throws(() => { data[name] = 'x'; }, TypeError);
  }
});

// ---- stock nested paging ----
test('fetchSkuStock: item with 25 locations (10+10+5) sums all of them and records follow-up calls', async () => {
  // 1..25 sums to 325
  const item = 'gid://shopify/InventoryItem/900';
  const admin = createFakeAdmin([
    stockPage([{ sku: 'S', itemId: item, levels: range(1, 10), more: more('L1') }]),
    levelsMorePage(range(11, 20), more('L2')),
    levelsMorePage(range(21, 25)),
  ]);
  const stock = await fetchSkuStock(admin);
  assert.equal(stock.get('S'), 325);
  assert.equal(admin.calls.length, 3);
  assert.equal(admin.calls[0].query, SKU_STOCK_QUERY);
  assert.equal(admin.calls[1].query, INVENTORY_LEVELS_MORE_QUERY);
  assert.deepEqual(admin.calls[1].variables, { id: item, cursor: 'L1' });
  assert.equal(admin.calls[2].query, INVENTORY_LEVELS_MORE_QUERY);
  assert.deepEqual(admin.calls[2].variables, { id: item, cursor: 'L2' });
});

test('fetchSkuStock: no follow-up when pageInfo.hasNextPage is false', async () => {
  const admin = createFakeAdmin([stockPage([{ sku: 'S', levels: [4, 5] }])]);
  assert.equal((await fetchSkuStock(admin)).get('S'), 9);
  assert.equal(admin.calls.length, 1);
});

test('fetchSkuStock: SKU shared by two variants sums, with nested paging on both', async () => {
  // V1 item: 1+2 then 3 ; V2 item: 10 then 20+30 ; total 66
  const admin = handlerAdmin((query, variables) => {
    if (query === SKU_STOCK_QUERY) {
      return stockPage([
        { sku: 'SH', itemId: 'item-1', levels: [1, 2], more: more('a') },
        { sku: ' SH ', itemId: 'item-2', levels: [10], more: more('b') },
      ]);
    }
    if (variables.id === 'item-1' && variables.cursor === 'a') return levelsMorePage([3]);
    if (variables.id === 'item-2' && variables.cursor === 'b') return levelsMorePage([20, 30]);
    return new Error('unexpected follow-up');
  });
  const stock = await fetchSkuStock(admin);
  assert.equal(stock.get('SH'), 66);
  const followUps = admin.calls.filter((c) => c.query === INVENTORY_LEVELS_MORE_QUERY);
  assert.deepEqual(followUps.map((c) => c.variables.id).sort(), ['item-1', 'item-2']);
});

test('fetchSkuStock: nested paging combined with top-level paging', async () => {
  // page1: X = 1 + (follow 2) ; page2: X(second variant) = 4, Y = 8
  const admin = handlerAdmin((query, variables, i) => {
    if (query === SKU_STOCK_QUERY) {
      return variables?.cursor
        ? stockPage([{ sku: 'X', itemId: 'i2', levels: [4] }, { sku: 'Y', levels: [8] }])
        : stockPage([{ sku: 'X', itemId: 'i1', levels: [1], more: more('m') }], more('top1'));
    }
    return levelsMorePage([2]);
  });
  const stock = await fetchSkuStock(admin);
  assert.equal(stock.get('X'), 7);
  assert.equal(stock.get('Y'), 8);
  assert.equal(admin.calls.filter((c) => c.query === SKU_STOCK_QUERY).length, 2);
  assert.equal(admin.calls.filter((c) => c.query === INVENTORY_LEVELS_MORE_QUERY).length, 1);
});

test('fetchSkuStock: negative and non-finite follow-up quantities count as 0', async () => {
  const admin = createFakeAdmin([
    stockPage([{ sku: 'N', levels: [5], more: more('c') }]),
    levelsMorePage([-3, Number.NaN, Infinity, 2], more('d')),
    levelsMorePage([null, 1]),
  ]);
  assert.equal((await fetchSkuStock(admin)).get('N'), 8);
});

test('fetchSkuStock: follow-up ignores non-available quantity names', async () => {
  const follow = levelsMorePage([6]);
  follow.data.node.inventoryLevels.nodes.push({ quantities: [{ name: 'on_hand', quantity: 99 }] });
  const admin = createFakeAdmin([stockPage([{ sku: 'Q', levels: [1], more: more('c') }]), follow]);
  assert.equal((await fetchSkuStock(admin)).get('Q'), 7);
});

// ---- orders nested paging ----
test('fetchDailyDemand: order with 60 line items (25+25+10) is counted fully, cancelled order extras ignored', async () => {
  // days 10: A = (25*1 + 25*2) / 10 = 7.5 ; B = 10*3 / 10 = 3 ; cancelled order contributes nothing
  const admin = handlerAdmin((query, variables) => {
    if (query === ORDERS_DEMAND_QUERY) {
      return ordersPage([
        { id: 'o-live', items: range(1, 25).map(() => ['A', 1]), more: more('p1') },
        { id: 'o-dead', cancelledAt: '2026-03-20T00:00:00Z', items: [['A', 500]], more: more('q1') },
      ]);
    }
    if (variables.id === 'o-live' && variables.cursor === 'p1') return lineItemsMorePage(range(1, 25).map(() => ['A', 2]), more('p2'));
    if (variables.id === 'o-live' && variables.cursor === 'p2') return lineItemsMorePage(range(1, 10).map(() => ['B', 3]));
    if (variables.id === 'o-dead') return lineItemsMorePage([['A', 500]]);
    return new Error('unexpected follow-up');
  });
  const demand = await fetchDailyDemand(admin, { days: 10, now: NOW });
  assert.deepEqual([...demand.entries()].sort(), [['A', 7.5], ['B', 3]]);
  const live = admin.calls.filter((c) => c.query === ORDER_LINE_ITEMS_MORE_QUERY && c.variables.id === 'o-live');
  assert.deepEqual(live.map((c) => c.variables.cursor), ['p1', 'p2']);
});

test('fetchDailyDemand: nested paging combined with top-level paging, variables recorded', async () => {
  // days 10: A = (10 + 5 + 20) / 10 = 3.5
  const admin = handlerAdmin((query, variables) => {
    if (query === ORDERS_DEMAND_QUERY) {
      return variables.cursor
        ? ordersPage([{ id: 'o2', items: [['A', 20]] }])
        : ordersPage([{ id: 'o1', items: [['A', 10]], more: more('x') }], more('top'));
    }
    return lineItemsMorePage([['A', 5]]);
  });
  const demand = await fetchDailyDemand(admin, { days: 10, now: NOW });
  assert.equal(demand.get('A'), 3.5);
  const follow = admin.calls.find((c) => c.query === ORDER_LINE_ITEMS_MORE_QUERY);
  assert.deepEqual(follow.variables, { id: 'o1', cursor: 'x' });
  assert.equal(admin.calls.length, 3);
});

// ---- throttle retry ----
test('throttled then success: sleep called once with 1000 and the same request is retried', async () => {
  const { sleep, waits } = sleeper();
  const admin = createFakeAdmin([THROTTLED, variantsPage(['B', 'A'])]);
  assert.deepEqual(await fetchVariantSkus(admin, { sleep }), ['A', 'B']);
  assert.deepEqual(waits, [1000]);
  assert.equal(admin.calls.length, 2);
  assert.equal(admin.calls[1].query, admin.calls[0].query);
  assert.deepEqual(admin.calls[1].variables, admin.calls[0].variables);
});

test('four consecutive throttles: throttled after exactly sleeps 1000, 2000, 4000', async () => {
  for (const run of [
    (admin, o) => fetchVariantSkus(admin, o),
    (admin, o) => fetchSkuStock(admin, o),
    (admin, o) => fetchDailyDemand(admin, { ...o, now: NOW }),
  ]) {
    const { sleep, waits } = sleeper();
    const admin = createFakeAdmin([THROTTLED, THROTTLED, THROTTLED, THROTTLED, variantsPage([])]);
    await assert.rejects(run(admin, { sleep }), isErr('throttled'));
    assert.deepEqual(waits, [1000, 2000, 4000]);
    assert.equal(admin.calls.length, 4);
  }
});

test('maxRetries bounds the retries', async () => {
  const one = sleeper();
  const a1 = createFakeAdmin([THROTTLED, THROTTLED, variantsPage([])]);
  await assert.rejects(fetchVariantSkus(a1, { sleep: one.sleep, maxRetries: 1 }), isErr('throttled'));
  assert.deepEqual(one.waits, [1000]);
  assert.equal(a1.calls.length, 2);

  const zero = sleeper();
  const a0 = createFakeAdmin([THROTTLED, variantsPage([])]);
  await assert.rejects(fetchVariantSkus(a0, { sleep: zero.sleep, maxRetries: 0 }), isErr('throttled'));
  assert.deepEqual(zero.waits, []);
  assert.equal(a0.calls.length, 1);
});

test('throttle counter is per request: later requests get a fresh set of retries starting at 1000', async () => {
  const { sleep, waits } = sleeper();
  const admin = createFakeAdmin([
    THROTTLED, THROTTLED, variantsPage(['A'], more('c')),
    THROTTLED, variantsPage(['B']),
  ]);
  assert.deepEqual(await fetchVariantSkus(admin, { sleep }), ['A', 'B']);
  assert.deepEqual(waits, [1000, 2000, 1000]);
});

test('throttle on a stock follow-up request is retried with the same variables', async () => {
  const { sleep, waits } = sleeper();
  const admin = createFakeAdmin([
    stockPage([{ sku: 'T', itemId: 'it', levels: [1], more: more('c') }]),
    THROTTLED,
    levelsMorePage([2]),
  ]);
  assert.equal((await fetchSkuStock(admin, { sleep })).get('T'), 3);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(admin.calls[2], admin.calls[1]);
});

test('throttle on an order follow-up request is retried', async () => {
  const { sleep, waits } = sleeper();
  const admin = createFakeAdmin([
    ordersPage([{ id: 'oo', items: [['A', 10]], more: more('c') }]),
    THROTTLED, THROTTLED,
    lineItemsMorePage([['A', 10]]),
  ]);
  const demand = await fetchDailyDemand(admin, { days: 10, now: NOW, sleep });
  assert.equal(demand.get('A'), 2);
  assert.deepEqual(waits, [1000, 2000]);
});

test('non-throttle graphql errors are not retried and never sleep', async () => {
  const { sleep, waits } = sleeper();
  const admin = createFakeAdmin([{ errors: [{ message: 'no', extensions: { code: 'ACCESS_DENIED' } }] }, variantsPage([])]);
  await assert.rejects(fetchVariantSkus(admin, { sleep }), isErr('graphql_error'));
  assert.equal(admin.calls.length, 1);
  assert.deepEqual(waits, []);

  const admin2 = createFakeAdmin([{ data: null }, variantsPage([])]);
  await assert.rejects(fetchVariantSkus(admin2, { sleep }), isErr('unexpected_response'));
  assert.equal(admin2.calls.length, 1);
});

test('admin.graphql rejection propagates unchanged and is not retried', async () => {
  const { sleep, waits } = sleeper();
  const boom = new Error('network down');
  const admin = createFakeAdmin([boom, variantsPage([])]);
  await assert.rejects(fetchSkuStock(admin, { sleep }), (e) => e === boom);
  assert.equal(admin.calls.length, 1);
  assert.deepEqual(waits, []);
});

test('retries do not consume maxPages', async () => {
  const { sleep } = sleeper();
  const admin = createFakeAdmin([THROTTLED, THROTTLED, THROTTLED, variantsPage(['A'], more('c')), THROTTLED, variantsPage(['B'])]);
  assert.deepEqual(await fetchVariantSkus(admin, { sleep, maxPages: 2 }), ['A', 'B']);
  assert.equal(admin.calls.length, 6);
});

// ---- shared page budget ----
test('fetchSkuStock: maxPages is shared between top-level and follow-up requests', async () => {
  const script = (followPages) => handlerAdmin((query, variables) => {
    if (query === SKU_STOCK_QUERY) return stockPage([{ sku: 'B', itemId: 'i', levels: [1], more: more('0') }]);
    const n = Number(variables.cursor);
    return levelsMorePage([1], n + 1 < followPages ? more(String(n + 1)) : undefined);
  });
  // 1 top + 2 follow-ups = 3 requests: ok at maxPages 3, too many at 2
  const ok = script(2);
  assert.equal((await fetchSkuStock(ok, { maxPages: 3 })).get('B'), 3);
  assert.equal(ok.calls.length, 3);
  const bad = script(2);
  await assert.rejects(fetchSkuStock(bad, { maxPages: 2 }), isErr('too_many_pages'));
  assert.ok(bad.calls.length <= 2);
});

test('fetchDailyDemand: maxPages is shared between top-level and follow-up requests', async () => {
  const script = () => handlerAdmin((query, variables) => {
    if (query === ORDERS_DEMAND_QUERY) {
      return variables.cursor
        ? ordersPage([{ id: 'o2', items: [['A', 1]] }])
        : ordersPage([{ id: 'o1', items: [['A', 1]], more: more('f') }], more('t'));
    }
    return lineItemsMorePage([['A', 1]]);
  });
  // top, follow-up, top = 3 requests
  const ok = script();
  assert.equal((await fetchDailyDemand(ok, { days: 10, now: NOW, maxPages: 3 })).get('A'), 0.3);
  const bad = script();
  await assert.rejects(fetchDailyDemand(bad, { days: 10, now: NOW, maxPages: 2 }), isErr('too_many_pages'));
  assert.ok(bad.calls.length <= 2);
});

test('default maxPages: 400 for stock and demand (follow-ups included), 100 for variants', async () => {
  const stockWith = (requests) => handlerAdmin((query, variables) => {
    if (query === SKU_STOCK_QUERY) return stockPage([{ sku: 'D', itemId: 'i', levels: [1], more: more('1') }]);
    const n = Number(variables.cursor);
    return levelsMorePage([1], n + 1 < requests ? more(String(n + 1)) : undefined);
  });
  // requests = total GraphQL pages including the top-level one
  const okStock = stockWith(400); // 1 top + 399 follow-ups = 400 requests
  assert.equal((await fetchSkuStock(okStock)).get('D'), 400);
  assert.equal(okStock.calls.length, 400);
  await assert.rejects(fetchSkuStock(stockWith(401)), isErr('too_many_pages')); // 401 requests

  const demandWith = (requests) => handlerAdmin((query, variables) => {
    if (query === ORDERS_DEMAND_QUERY) return ordersPage([{ id: 'o', items: [['A', 4]], more: more('1') }]);
    const n = Number(variables.cursor);
    return lineItemsMorePage([['A', 4]], n + 1 < requests ? more(String(n + 1)) : undefined);
  });
  const okDemand = demandWith(400);
  assert.equal((await fetchDailyDemand(okDemand, { days: 1, now: NOW })).get('A'), 1600);
  assert.equal(okDemand.calls.length, 400);
  await assert.rejects(fetchDailyDemand(demandWith(401), { days: 1, now: NOW }), isErr('too_many_pages'));

  const variants = (pages) => handlerAdmin((q, v, i) => variantsPage([`S${i}`], i + 1 < pages ? more(`c${i}`) : undefined));
  assert.equal((await fetchVariantSkus(variants(100))).length, 100);
  await assert.rejects(fetchVariantSkus(variants(101)), isErr('too_many_pages'));
});

// ---- malformed nested data ----
test('stock: malformed nested data -> unexpected_response', async () => {
  const noPageInfo = stockPage([{ sku: 'M', levels: [1] }]);
  delete noPageInfo.data.productVariants.nodes[0].inventoryItem.inventoryLevels.pageInfo;
  const noCursor = stockPage([{ sku: 'M', levels: [1], more: { hasNextPage: true, endCursor: null } }]);
  const numCursor = stockPage([{ sku: 'M', levels: [1], more: { hasNextPage: true, endCursor: 5 } }]);
  const first = () => stockPage([{ sku: 'M', levels: [1], more: more('c') }]);
  const cases = [
    [noPageInfo],
    [noCursor],
    [numCursor],
    [first(), { data: { node: null } }],
    [first(), { data: {} }],
    [first(), { data: { node: { inventoryLevels: { nodes: [] } } } }],
    [first(), { data: { node: { inventoryLevels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }],
    [first(), { data: { node: { inventoryLevels: { pageInfo: { hasNextPage: false } } } } }],
  ];
  for (const script of cases) {
    const admin = createFakeAdmin(script);
    await assert.rejects(fetchSkuStock(admin), isErr('unexpected_response'), JSON.stringify(script).slice(0, 120));
  }
});

test('orders: malformed nested data -> unexpected_response', async () => {
  const noPageInfo = ordersPage([{ items: [['A', 1]] }]);
  delete noPageInfo.data.orders.nodes[0].lineItems.pageInfo;
  const noCursor = ordersPage([{ items: [['A', 1]], more: { hasNextPage: true, endCursor: '' } }]);
  const first = () => ordersPage([{ id: 'o', items: [['A', 1]], more: more('c') }]);
  const cases = [
    [noPageInfo],
    [noCursor],
    [first(), { data: { node: null } }],
    [first(), { data: {} }],
    [first(), { data: { node: { lineItems: { nodes: [] } } } }],
    [first(), { data: { node: { lineItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }],
  ];
  for (const script of cases) {
    const admin = createFakeAdmin(script);
    await assert.rejects(fetchDailyDemand(admin, { days: 10, now: NOW }), isErr('unexpected_response'), JSON.stringify(script).slice(0, 120));
  }
});
