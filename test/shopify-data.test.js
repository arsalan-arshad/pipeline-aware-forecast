import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ShopifyDataError, VARIANT_SKUS_QUERY, SKU_STOCK_QUERY, ORDERS_DEMAND_QUERY,
  fetchVariantSkus, fetchSkuStock, computeDailyDemand, fetchDailyDemand,
} from '../app/lib/shopify-data.server.js';
import { createFakeAdmin, deepFreeze, variantsPage, stockPage, ordersPage } from './fixtures/shell-fixtures.js';

const FAKE_TOKEN = 'shpat_FAKE_SECRET_TOKEN_123';
const BAD_WORDS = new RegExp(['customer', ['e', 'mail'].join(''), ['pho', 'ne'].join(''), 'address', 'billing', 'shipping'].join('|'), 'i');
const CODES = ['bad_input', 'throttled', 'graphql_error', 'unexpected_response', 'too_many_pages'];

function isErr(code) {
  return (e) => e instanceof ShopifyDataError && e.name === 'ShopifyDataError' && e.code === code
    && e.userMessage === e.message && !e.message.includes(FAKE_TOKEN) && !String(e.stack).includes(FAKE_TOKEN);
}

test('queries are read-only and free of personal-data selections', () => {
  for (const q of [VARIANT_SKUS_QUERY, SKU_STOCK_QUERY, ORDERS_DEMAND_QUERY]) {
    assert.equal(typeof q, 'string');
    assert.match(q.replace(/^\s*#graphql/, '').trim(), /^query\b/);
    assert.ok(!BAD_WORDS.test(q));
    assert.ok(!/\bmutation\b/i.test(q));
    assert.match(q, /pageInfo/);
  }
  for (const word of ['createdAt', 'cancelledAt', 'sku', 'currentQuantity', 'pageInfo']) assert.ok(ORDERS_DEMAND_QUERY.includes(word), word);
});

test('ShopifyDataError: code, userMessage', () => {
  for (const code of CODES) {
    const e = new ShopifyDataError(code);
    assert.equal(e.name, 'ShopifyDataError');
    assert.equal(e.code, code);
    assert.equal(e.userMessage, e.message);
    assert.ok(e.message.length > 0);
  }
});

// ---- fetchVariantSkus ----
test('fetchVariantSkus: 3 pages, dedupe, trim, drop blanks, sorted', async () => {
  // page1: B, " A ", "" ; page2: A, null, "  ", C ; page3: B, a  -> distinct {A,B,C,a}; sorted default order A,B,C,a
  const admin = createFakeAdmin([
    variantsPage(['B', ' A ', ''], { hasNextPage: true, endCursor: 'c1' }),
    variantsPage(['A', null, '  ', 'C'], { hasNextPage: true, endCursor: 'c2' }),
    variantsPage(['B', 'a']),
  ]);
  const skus = await fetchVariantSkus(admin);
  assert.deepEqual(skus, ['A', 'B', 'C', 'a']);
  assert.equal(admin.calls.length, 3);
  assert.equal(admin.calls[0].query, VARIANT_SKUS_QUERY);
  assert.deepEqual(skus, [...skus].sort());
});

test('fetchVariantSkus: cursor passed on later pages', async () => {
  const admin = createFakeAdmin([variantsPage(['A'], { hasNextPage: true, endCursor: 'c1' }), variantsPage(['B'])]);
  await fetchVariantSkus(admin);
  assert.equal(admin.calls[1].variables.cursor ?? admin.calls[1].variables.after, 'c1');
  const first = admin.calls[0].variables ?? {};
  assert.ok(first.cursor == null && first.after == null);
});

test('fetchVariantSkus: empty store', async () => {
  assert.deepEqual(await fetchVariantSkus(createFakeAdmin([variantsPage([])])), []);
});

test('fetchVariantSkus: more than maxPages -> too_many_pages', async () => {
  const admin = createFakeAdmin([
    variantsPage(['A'], { hasNextPage: true, endCursor: 'c1' }),
    variantsPage(['B'], { hasNextPage: true, endCursor: 'c2' }),
    variantsPage(['C']),
  ]);
  await assert.rejects(fetchVariantSkus(admin, { maxPages: 2 }), isErr('too_many_pages'));
  assert.ok(admin.calls.length <= 2);
});

test('fetchVariantSkus: exactly maxPages pages is fine', async () => {
  const admin = createFakeAdmin([variantsPage(['A'], { hasNextPage: true, endCursor: 'c1' }), variantsPage(['B'])]);
  assert.deepEqual(await fetchVariantSkus(admin, { maxPages: 2 }), ['A', 'B']);
});

// ---- error mapping, run against every fetcher ----
// Throttled responses are now retried (see shopify-paging.test.js); a no-wait sleep keeps these tests fast.
const noSleep = async () => {};
const fetchers = {
  fetchVariantSkus: (admin) => fetchVariantSkus(admin, { sleep: noSleep }),
  fetchSkuStock: (admin) => fetchSkuStock(admin, { sleep: noSleep }),
  fetchDailyDemand: (admin) => fetchDailyDemand(admin, { days: 28, now: new Date('2026-03-30T12:00:00.000Z'), sleep: noSleep }),
};

const errorTable = [
  ['throttled', { errors: [{ message: `Throttled ${FAKE_TOKEN}`, extensions: { code: 'THROTTLED' } }] }, 'throttled'],
  ['throttled among others', { errors: [{ message: 'x', extensions: { code: 'OTHER' } }, { message: FAKE_TOKEN, extensions: { code: 'THROTTLED' } }] }, 'throttled'],
  ['other error', { errors: [{ message: `bad ${FAKE_TOKEN}`, extensions: { code: 'ACCESS_DENIED' } }] }, 'graphql_error'],
  ['error without extensions', { errors: [{ message: FAKE_TOKEN }] }, 'graphql_error'],
  ['errors with data', { data: {}, errors: [{ message: FAKE_TOKEN }] }, 'graphql_error'],
  ['missing data', {}, 'unexpected_response'],
  ['null data', { data: null }, 'unexpected_response'],
  ['wrong shape', { data: { unrelated: 1 } }, 'unexpected_response'],
  ['null body', null, 'unexpected_response'],
  ['json throws', { jsonThrows: true }, 'unexpected_response'],
];
for (const [fname, run] of Object.entries(fetchers)) {
  for (const [name, body, code] of errorTable) {
    test(`${fname}: ${name} -> ${code}`, async () => {
      // throttled responses are retried 3 times before giving up (4 requests); every other error is not retried
      const attempts = code === 'throttled' ? 4 : 1;
      const admin = createFakeAdmin(Array.from({ length: attempts }, () => body));
      await assert.rejects(run(admin), isErr(code));
      assert.equal(admin.calls.length, attempts, code === 'throttled' ? 'retried until maxRetries' : 'no retries');
    });
  }
  test(`${fname}: admin rejection propagates unchanged`, async () => {
    const boom = new Error(`network ${FAKE_TOKEN}`);
    await assert.rejects(run(createFakeAdmin([boom])), (e) => e === boom);
  });
  test(`${fname}: error on a later page maps too`, async () => {
    const first = fname === 'fetchVariantSkus' ? variantsPage(['A'], { hasNextPage: true, endCursor: 'c' })
      : fname === 'fetchSkuStock' ? stockPage([{ sku: 'A', levels: [1] }], { hasNextPage: true, endCursor: 'c' })
        : ordersPage([{ items: [['A', 1]] }], { hasNextPage: true, endCursor: 'c' });
    const throttled = { errors: [{ message: 'x', extensions: { code: 'THROTTLED' } }] };
    const admin = createFakeAdmin([first, throttled, throttled, throttled, throttled]);
    await assert.rejects(run(admin), isErr('throttled'));
  });
}

// ---- fetchSkuStock ----
test('fetchSkuStock: sums locations and shared SKUs across pages; clamps bad values', async () => {
  // X: 5+3 (two locations) + 4 (second variant, page 2) = 12 ; Y: -2 -> 0, plus NaN->0 => 0 ; Z: 7 ; blank sku ignored
  const admin = createFakeAdmin([
    stockPage([{ sku: 'X', levels: [5, 3] }, { sku: 'Y', levels: [-2, Number.NaN] }], { hasNextPage: true, endCursor: 'c' }),
    stockPage([{ sku: ' X ', levels: [4] }, { sku: 'Z', levels: [7] }, { sku: '', levels: [9] }]),
  ]);
  const stock = await fetchSkuStock(admin);
  assert.ok(stock instanceof Map);
  assert.equal(stock.get('X'), 12);
  assert.equal(stock.get('Y') ?? 0, 0);
  assert.equal(stock.get('Z'), 7);
  assert.ok(!stock.has(''));
  assert.equal(admin.calls[0].query, SKU_STOCK_QUERY);
});

test('fetchSkuStock: too many pages', async () => {
  const admin = createFakeAdmin([stockPage([{ sku: 'A', levels: [1] }], { hasNextPage: true, endCursor: 'c' }), stockPage([{ sku: 'A', levels: [1] }], { hasNextPage: true, endCursor: 'd' }), stockPage([])]);
  await assert.rejects(fetchSkuStock(admin, { maxPages: 2 }), isErr('too_many_pages'));
});

// ---- computeDailyDemand ----
test('computeDailyDemand: sums per trimmed sku / days, rounded to 4 decimals, ignores junk', () => {
  // A: 10 + 5 (" A ") = 15 ; /28 = 0.535714... -> 0.5357 ; B: 3/28 = 0.107142.. -> 0.1071
  // cancelled order ignored; blank/non-string sku ignored; negative / NaN / Infinity qty ignored
  const orders = deepFreeze([
    { cancelledAt: null, lineItems: [{ sku: 'A', currentQuantity: 10 }, { sku: 'B', currentQuantity: 3 }, { sku: '', currentQuantity: 5 }, { sku: null, currentQuantity: 5 }, { sku: 7, currentQuantity: 5 }] },
    { cancelledAt: null, lineItems: [{ sku: ' A ', currentQuantity: 5 }, { sku: 'B', currentQuantity: -4 }, { sku: 'B', currentQuantity: Number.NaN }, { sku: 'B', currentQuantity: Infinity }] },
    { cancelledAt: '2026-03-01T00:00:00Z', lineItems: [{ sku: 'A', currentQuantity: 100 }] },
  ]);
  const demand = computeDailyDemand(orders, 28);
  assert.ok(demand instanceof Map);
  assert.deepEqual([...demand.entries()].sort(), [['A', 0.5357], ['B', 0.1071]]);
});

test('computeDailyDemand: deterministic; empty orders -> empty map; days=1 identity', () => {
  const orders = [{ cancelledAt: null, lineItems: [{ sku: 'A', currentQuantity: 2 }] }];
  assert.deepEqual([...computeDailyDemand(orders, 1)], [['A', 2]]);
  assert.deepEqual([...computeDailyDemand(orders, 1)], [...computeDailyDemand(orders, 1)]);
  assert.equal(computeDailyDemand([], 28).size, 0);
});

for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '28', null, undefined]) {
  test(`computeDailyDemand: days ${String(bad)} -> bad_input`, () => {
    assert.throws(() => computeDailyDemand([], bad), isErr('bad_input'));
  });
}

// ---- fetchDailyDemand ----
const NOW = new Date('2026-03-30T12:00:00.000Z');

test('fetchDailyDemand: filter variable is created_at >= now - days (exact)', async () => {
  // 2026-03-30T12:00Z minus 28 days = 2026-03-02T12:00:00.000Z
  const admin = createFakeAdmin([ordersPage([])]);
  await fetchDailyDemand(admin, { days: 28, now: NOW });
  assert.equal(admin.calls[0].query, ORDERS_DEMAND_QUERY);
  assert.equal(admin.calls[0].variables.query, 'created_at:>=2026-03-02T12:00:00.000Z');
});

test('fetchDailyDemand: days clamped to integer [1,60]', async () => {
  const cases = [[0, 1], [-5, 1], [61, 60], [1000, 60], [Number.NaN, 28], [Infinity, 28], [28.5, 28], [undefined, 28]];
  for (const [input, effective] of cases) {
    const admin = createFakeAdmin([ordersPage([{ items: [['A', 60]] }])]);
    const demand = await fetchDailyDemand(admin, { days: input, now: NOW });
    const expectedStart = new Date(NOW.getTime() - effective * 86400000).toISOString();
    assert.equal(admin.calls[0].variables.query, `created_at:>=${expectedStart}`, `days=${input}`);
    assert.equal(demand.get('A'), Math.round((60 / effective) * 10000) / 10000, `days=${input}`);
  }
});

test('fetchDailyDemand: paginates orders, ignores cancelled', async () => {
  // days=10: A = (20 + 10) / 10 = 3 ; B = 5/10 = 0.5
  const admin = createFakeAdmin([
    ordersPage([{ items: [['A', 20]] }, { cancelledAt: '2026-03-20T00:00:00Z', items: [['A', 99]] }], { hasNextPage: true, endCursor: 'o1' }),
    ordersPage([{ items: [['A', 10], ['B', 5]] }]),
  ]);
  const demand = await fetchDailyDemand(admin, { days: 10, now: NOW });
  assert.deepEqual([...demand.entries()].sort(), [['A', 3], ['B', 0.5]]);
  assert.equal(admin.calls.length, 2);
  assert.equal(admin.calls[1].variables.cursor ?? admin.calls[1].variables.after, 'o1');
});

test('fetchDailyDemand: too many pages', async () => {
  const admin = createFakeAdmin([
    ordersPage([], { hasNextPage: true, endCursor: 'a' }), ordersPage([], { hasNextPage: true, endCursor: 'b' }), ordersPage([]),
  ]);
  await assert.rejects(fetchDailyDemand(admin, { days: 28, now: NOW, maxPages: 2 }), isErr('too_many_pages'));
});

for (const bad of [undefined, null, 'x', 1772446530000, new Date('nope'), {}]) {
  test(`fetchDailyDemand: invalid now ${String(bad)} -> bad_input before admin call`, async () => {
    const admin = createFakeAdmin([ordersPage([])]);
    await assert.rejects(fetchDailyDemand(admin, { days: 28, now: bad }), isErr('bad_input'));
    assert.equal(admin.calls.length, 0);
  });
}

test('pagination: hasNextPage without a cursor -> unexpected_response', async () => {
  const admin = createFakeAdmin([variantsPage(['A'], { hasNextPage: true, endCursor: null })]);
  await assert.rejects(fetchVariantSkus(admin), isErr('unexpected_response'));
});

test('fetchVariantSkus: sorting is plain string order (uppercase before lowercase)', async () => {
  assert.deepEqual(await fetchVariantSkus(createFakeAdmin([variantsPage(['b', 'B', 'a', 'A', '10', '9'])])), ['10', '9', 'A', 'B', 'a', 'b']);
});

test('fetchSkuStock: ignores non-available quantity names', async () => {
  const body = stockPage([{ sku: 'Q', levels: [5] }]);
  body.data.productVariants.nodes[0].inventoryItem.inventoryLevels.nodes.push({ quantities: [{ name: 'on_hand', quantity: 99 }] });
  assert.equal((await fetchSkuStock(createFakeAdmin([body]))).get('Q'), 5);
});

test('fetchSkuStock: variant with no inventory levels is present with 0', async () => {
  const body = stockPage([{ sku: 'Q', levels: [] }]);
  assert.equal((await fetchSkuStock(createFakeAdmin([body]))).get('Q'), 0);
});

test('fetchDailyDemand: now is not mutated and a null cancelledAt counts', async () => {
  const now = new Date(NOW.getTime());
  const admin = createFakeAdmin([ordersPage([{ cancelledAt: null, items: [['A', 28]] }])]);
  const demand = await fetchDailyDemand(admin, { now });
  assert.equal(now.getTime(), NOW.getTime());
  assert.equal(demand.get('A'), 1); // 28 / 28
});

test('fetchDailyDemand: maxPages invalid -> bad_input', async () => {
  await assert.rejects(fetchDailyDemand(createFakeAdmin([]), { now: NOW, maxPages: 0 }), isErr('bad_input'));
});
