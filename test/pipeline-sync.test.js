/**
 * Independent tests for pipeline-sync.server.js, written from the contract only.
 * Calendar facts used (2026): Jan 1 is a Thursday, so Mondays are Jan 5, 12, 19, 26 and Feb 2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  isSyncDue,
  runPipelineSync,
} from '../app/lib/pipeline/pipeline-sync.server.js';
import {
  makeStore, makeClient, makeSkuSource, opp, deepFreeze, baseArgs, NOW, TODAY,
} from './fixtures/sync-fixtures.js';

const GENERIC = 'The sync failed for an unexpected reason.';
const STORAGE_MSG = 'The sync data could not be saved.';
const SNAP_KEYS = ['openDealCount', 'rawQty', 'sku', 'weekStart', 'weightedQty'];

// ---------- addDaysIso ----------
test('addDaysIso: calendar table (UTC arithmetic)', () => {
  const table = [
    ['2026-01-01', 0, '2026-01-01'],
    ['2026-01-31', 1, '2026-02-01'],
    ['2026-01-01', 90, '2026-04-01'],     // 31 + 28 + 31 = 90
    ['2026-01-31', 90, '2026-05-01'],     // Feb 1 = +1, Mar 1 = +29, Apr 1 = +60, May 1 = +90
    ['2024-02-28', 1, '2024-02-29'],      // leap year
    ['2024-02-29', 1, '2024-03-01'],
    ['2023-02-28', 1, '2023-03-01'],      // non-leap
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2024-03-01', -1, '2024-02-29'],
    ['2026-01-01', 365, '2027-01-01'],
    ['2024-01-01', 366, '2025-01-01'],
    ['2026-01-10', -10, '2025-12-31'],
  ];
  for (const [d, n, want] of table) assert.equal(addDaysIso(d, n), want, `${d} + ${n}`);
});

test('addDaysIso: invalid input date -> null', () => {
  for (const bad of ['2026-02-30', '2026-13-01', 'nope', '', null, undefined, '2026-1-1', 20260101, {}]) {
    assert.equal(addDaysIso(bad, 1), null, String(bad));
  }
});

// ---------- isSyncDue ----------
test('isSyncDue: table around the 6h boundary (now = 12:00Z)', () => {
  const now = '2026-01-01T12:00:00.000Z';
  const nowMs = Date.parse(now);
  const cases = [
    [null, true], [undefined, true], ['garbage', true], [new Date('x'), true],
    ['2026-01-01T06:00:00.000Z', true],        // exactly 6h -> due
    ['2026-01-01T06:00:00.001Z', false],       // 5h59m59.999s
    ['2026-01-01T11:59:00.000Z', false],
    ['2026-01-01T05:59:59.999Z', true],
    ['2025-12-01T00:00:00.000Z', true],
    ['2026-01-01T12:00:00.000Z', false],       // just synced
    ['2026-01-01T12:00:00.001Z', false],       // future
    ['2027-01-01T00:00:00.000Z', false],       // far future
    [new Date('2026-01-01T06:00:00.000Z'), true],
    [new Date('2026-01-01T07:00:00.000Z'), false],
    [nowMs - 6 * 3600 * 1000, true],           // epoch ms input
    [nowMs - 6 * 3600 * 1000 + 1, false],
    [nowMs + 1000, false],
  ];
  for (const [last, want] of cases) {
    assert.equal(isSyncDue({ lastSyncAt: last, now }), want, String(last));
    assert.equal(isSyncDue({ lastSyncAt: last, now: new Date(now) }), want, 'Date now ' + String(last));
    assert.equal(isSyncDue({ lastSyncAt: last, now: nowMs }), want, 'epoch now ' + String(last));
  }
});

test('isSyncDue: custom interval and invalid now', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  assert.equal(isSyncDue({ lastSyncAt: '2026-01-01T11:00:00.000Z', now, intervalHours: 1 }), true);
  assert.equal(isSyncDue({ lastSyncAt: '2026-01-01T11:00:00.001Z', now, intervalHours: 1 }), false);
  assert.equal(isSyncDue({ lastSyncAt: '2026-01-01T00:00:00.000Z', now, intervalHours: 24 }), false);
  assert.equal(isSyncDue({ lastSyncAt: '2025-12-31T12:00:00.000Z', now, intervalHours: 24 }), true);
  for (const badNow of [undefined, null, 'garbage', new Date('x'), NaN]) {
    assert.equal(isSyncDue({ lastSyncAt: '2026-01-01T11:59:59.000Z', now: badNow }), true, String(badNow));
  }
});

// ---------- runPipelineSync: success paths ----------
const workedDeals = () => [
  opp('o1', 'Negotiation', 50, '2026-01-21', [{ productCode: 'SKU-X', quantity: 300 }]),
  opp('o2', 'Negotiation', 20, '2026-01-31', [{ productCode: 'SKU-X', quantity: 200 }]),
];

test('worked example through runPipelineSync', async () => {
  // today 2026-01-01, offset 0. Jan 21 is a Wednesday -> ISO Monday Jan 19; weighted 300*0.5 = 150.
  // Jan 31 is a Saturday -> ISO Monday Jan 26; weighted 200*0.2 = 40.
  const client = makeClient({ opportunities: workedDeals() });
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({ client, store, settings: { shipOffsetDays: 0 } }));
  assert.deepEqual(res, { ok: true, syncedAt: NOW.toISOString(), skuCount: 1, rowCount: 2, unmatchedCount: 0 });
  assert.equal(store.calls.success.length, 1);
  assert.equal(store.calls.failure.length, 0);
  assert.deepEqual(store.calls.success[0], {
    shop: 'demo-shop.myshopify.com',
    syncedAt: '2026-01-01T12:00:00.000Z',
    snapshots: [
      { sku: 'SKU-X', weekStart: '2026-01-19', weightedQty: 150, rawQty: 300, openDealCount: 1 },
      { sku: 'SKU-X', weekStart: '2026-01-26', weightedQty: 40, rawQty: 200, openDealCount: 1 },
    ],
    unmatched: [],
  });
});

test('horizonDate passed to the client: today + horizonDays (default 90)', async () => {
  const c1 = makeClient();
  await runPipelineSync(baseArgs({ client: c1 })); // 2026-01-01 + 90 = 2026-04-01
  assert.deepEqual(c1.calls, [{ horizonDate: '2026-04-01' }]);
  const c2 = makeClient();
  await runPipelineSync(baseArgs({ client: c2, today: '2026-01-31', settings: { horizonDays: 10 } })); // Jan 31 + 10 = Feb 10
  assert.deepEqual(c2.calls, [{ horizonDate: '2026-02-10' }]);
  const c3 = makeClient();
  await runPipelineSync(baseArgs({ client: c3, today: '2026-01-31' })); // + 90 = May 1
  assert.deepEqual(c3.calls, [{ horizonDate: '2026-05-01' }]);
  assert.equal(c3.calls.length, 1);
});

test('exact row keys, sort order across several SKUs and weeks, case-variant match', async () => {
  // offset 0, today 2026-01-01. Shopify SKUs: 'sku-c' (deal code 'SKU-C' matches case-insensitively).
  // o1 Jan 21 (week Jan 19) p100: SKU-B 10, SKU-A 5 -> B{10,10}, A{5,5}
  // o2 Feb 2 (Monday, week Feb 2) p50: SKU-A 20 -> {10,20}
  // o3 Jan 12 (Monday) p10: SKU-B 30 -> {3,30}; SKU-C 7 -> {0.7,7} (7*0.1 = 0.7 after round2)
  // Plain string order: 'SKU-A' < 'SKU-B' < 'sku-c' (uppercase sorts before lowercase).
  const deals = [
    opp('o1', 'Closing', 100, '2026-01-21', [{ productCode: 'SKU-B', quantity: 10 }, { productCode: 'sku-a', quantity: 5 }]),
    opp('o2', 'Closing', 50, '2026-02-02', [{ productCode: 'SKU-A', quantity: 20 }]),
    opp('o3', 'Closing', 10, '2026-01-12', [{ productCode: 'SKU-B', quantity: 30 }, { productCode: 'SKU-C', quantity: 7 }]),
  ];
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({
    client: makeClient({ opportunities: deals }),
    store,
    getShopifySkus: makeSkuSource({ skus: ['sku-c', 'SKU-B', 'SKU-A'] }),
    settings: { shipOffsetDays: 0 },
  }));
  assert.deepEqual(res, { ok: true, syncedAt: NOW.toISOString(), skuCount: 3, rowCount: 5, unmatchedCount: 0 });
  const { snapshots } = store.calls.success[0];
  assert.deepEqual(snapshots, [
    { sku: 'SKU-A', weekStart: '2026-01-19', weightedQty: 5, rawQty: 5, openDealCount: 1 },
    { sku: 'SKU-A', weekStart: '2026-02-02', weightedQty: 10, rawQty: 20, openDealCount: 1 },
    { sku: 'SKU-B', weekStart: '2026-01-12', weightedQty: 3, rawQty: 30, openDealCount: 1 },
    { sku: 'SKU-B', weekStart: '2026-01-19', weightedQty: 10, rawQty: 10, openDealCount: 1 },
    { sku: 'sku-c', weekStart: '2026-01-12', weightedQty: 0.7, rawQty: 7, openDealCount: 1 },
  ]);
  for (const row of snapshots) assert.deepEqual(Object.keys(row).sort(), SNAP_KEYS);
});

test('unmatched rows: exact keys, grouped, sorted; matched rows unaffected', async () => {
  // NOPE-1 (4) in o1 and nope-1 (6) in o2 -> one row, first spelling 'NOPE-1', 2 deals, raw 10. 'ZED' 2 in o3.
  const deals = [
    opp('o1', 'S', 50, '2026-01-21', [{ productCode: 'NOPE-1', quantity: 4 }, { productCode: 'SKU-X', quantity: 10 }]),
    opp('o2', 'S', 50, '2026-01-22', [{ productCode: 'nope-1', quantity: 6 }]),
    opp('o3', 'S', 50, '2026-01-23', [{ productCode: 'ZED', quantity: 2 }]),
  ];
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({ client: makeClient({ opportunities: deals }), store, settings: { shipOffsetDays: 0 } }));
  assert.equal(res.unmatchedCount, 2);
  assert.equal(res.rowCount, 1);
  assert.deepEqual(store.calls.success[0].unmatched, [
    { productCode: 'NOPE-1', openDealCount: 2, rawQty: 10 },
    { productCode: 'ZED', openDealCount: 1, rawQty: 2 },
  ]);
  for (const row of store.calls.success[0].unmatched) {
    assert.deepEqual(Object.keys(row).sort(), ['openDealCount', 'productCode', 'rawQty']);
  }
  // SKU-X: Jan 21 week Jan 19; 10 * 0.5 = 5
  assert.deepEqual(store.calls.success[0].snapshots, [
    { sku: 'SKU-X', weekStart: '2026-01-19', weightedQty: 5, rawQty: 10, openDealCount: 1 },
  ]);
});

test('no Shopify SKUs: everything is unmatched, still a success', async () => {
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({
    client: makeClient({ opportunities: workedDeals() }),
    store,
    getShopifySkus: makeSkuSource({ skus: [] }),
  }));
  assert.equal(res.ok, true);
  assert.equal(res.skuCount, 0);
  assert.equal(res.rowCount, 0);
  assert.equal(res.unmatchedCount, 1);
  assert.deepEqual(store.calls.success[0].snapshots, []);
  assert.deepEqual(store.calls.success[0].unmatched, [{ productCode: 'SKU-X', openDealCount: 2, rawQty: 500 }]);
});

test('empty deal list is a valid success with empty arrays', async () => {
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({ store }));
  assert.deepEqual(res, { ok: true, syncedAt: NOW.toISOString(), skuCount: 0, rowCount: 0, unmatchedCount: 0 });
  assert.equal(store.calls.success.length, 1);
  assert.deepEqual(store.calls.success[0].snapshots, []);
  assert.deepEqual(store.calls.success[0].unmatched, []);
  assert.equal(store.calls.failure.length, 0);
});

test('syncedAt comes from now, not the clock; today is independent of now', async () => {
  const store = makeStore();
  const now = new Date('1999-12-31T23:59:59.123Z');
  const res = await runPipelineSync(baseArgs({ store, now }));
  assert.equal(res.syncedAt, '1999-12-31T23:59:59.123Z');
  assert.equal(store.calls.success[0].syncedAt, '1999-12-31T23:59:59.123Z');
});

test('distinct SKUs counted once even with many weeks', async () => {
  const deals = [
    opp('a', 'S', 100, '2026-01-12', [{ productCode: 'SKU-X', quantity: 1 }]),
    opp('b', 'S', 100, '2026-01-19', [{ productCode: 'SKU-X', quantity: 1 }]),
    opp('c', 'S', 100, '2026-01-26', [{ productCode: 'SKU-X', quantity: 1 }]),
  ];
  const res = await runPipelineSync(baseArgs({ client: makeClient({ opportunities: deals }), settings: { shipOffsetDays: 0 } }));
  assert.equal(res.skuCount, 1);
  assert.equal(res.rowCount, 3);
});

// ---------- settings ----------
const oneDeal = (extra = {}) => [{ ...opp('d', 'Negotiation', 50, '2026-01-21', [{ productCode: 'SKU-X', quantity: 100 }]), ...extra }];

async function weightedFor(settings, deals = oneDeal()) {
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({ client: makeClient({ opportunities: deals }), store, settings }));
  assert.equal(res.ok, true);
  return store.calls.success[0].snapshots;
}

test('settings: haircut 0 keeps raw demand, zero weighted', async () => {
  const rows = await weightedFor({ shipOffsetDays: 0, haircut: 0 });
  assert.deepEqual(rows, [{ sku: 'SKU-X', weekStart: '2026-01-19', weightedQty: 0, rawQty: 100, openDealCount: 1 }]);
});

test('settings: haircut 0.5 -> 100 * 0.5 * 0.5 = 25', async () => {
  const rows = await weightedFor({ shipOffsetDays: 0, haircut: 0.5 });
  assert.equal(rows[0].weightedQty, 25);
});

test('settings: stage override replaces deal probability (80 -> 80)', async () => {
  const rows = await weightedFor({ shipOffsetDays: 0, stageOverrides: { Negotiation: 80 } });
  assert.equal(rows[0].weightedQty, 80);
  assert.equal(rows[0].rawQty, 100);
});

test('settings: shipOffsetDays moves the week (default 7: Jan 21 + 7 = Jan 28 -> week Jan 26)', async () => {
  const dflt = await weightedFor({});
  assert.equal(dflt[0].weekStart, '2026-01-26');
  assert.equal(dflt[0].weightedQty, 50);
  const zero = await weightedFor({ shipOffsetDays: 0 });
  assert.equal(zero[0].weekStart, '2026-01-19');
});

test('settings: non-finite numbers fall back to defaults; undefined settings ok', async () => {
  const defaults = await weightedFor({});
  for (const bad of [NaN, Infinity, -Infinity, undefined]) {
    assert.deepEqual(await weightedFor({ haircut: bad, shipOffsetDays: bad, horizonDays: bad }), defaults);
  }
  const store = makeStore();
  const client = makeClient({ opportunities: oneDeal() });
  await runPipelineSync({ shop: 's', client, store, getShopifySkus: makeSkuSource({ skus: ['SKU-X'] }), today: TODAY, now: NOW });
  assert.deepEqual(store.calls.success[0].snapshots, defaults);
  const c2 = makeClient();
  await runPipelineSync(baseArgs({ client: c2, settings: { horizonDays: Infinity } }));
  assert.deepEqual(c2.calls, [{ horizonDate: '2026-04-01' }]);
});

test('settings: deals beyond the horizon are excluded, the boundary day is included', async () => {
  // horizonDays 10, offset 0: Jan 11 = day 10 (Sunday, week Jan 5) in; Jan 12 = day 11 out.
  const deals = [
    opp('in', 'S', 100, '2026-01-11', [{ productCode: 'SKU-X', quantity: 3 }]),
    opp('out', 'S', 100, '2026-01-12', [{ productCode: 'SKU-X', quantity: 9 }]),
  ];
  const rows = await weightedFor({ shipOffsetDays: 0, horizonDays: 10 }, deals);
  assert.deepEqual(rows, [{ sku: 'SKU-X', weekStart: '2026-01-05', weightedQty: 3, rawQty: 3, openDealCount: 1 }]);
});

test('overdue deal is clamped into the week containing today (Jan 1 -> week Dec 29)', async () => {
  const deals = [opp('late', 'S', 100, '2025-12-01', [{ productCode: 'SKU-X', quantity: 4 }])];
  const rows = await weightedFor({ shipOffsetDays: 0 }, deals);
  assert.deepEqual(rows, [{ sku: 'SKU-X', weekStart: '2025-12-29', weightedQty: 4, rawQty: 4, openDealCount: 1 }]);
});

test('frozen inputs are not mutated and results are deterministic', async () => {
  const deals = deepFreeze(workedDeals());
  const skus = deepFreeze(['SKU-X']);
  const settings = deepFreeze({ shipOffsetDays: 0, stageOverrides: { Negotiation: 60 } });
  const runOnce = async () => {
    const store = makeStore();
    const res = await runPipelineSync({
      shop: 'demo-shop.myshopify.com',
      client: makeClient({ opportunities: deals }),
      store,
      getShopifySkus: async () => skus,
      settings,
      today: TODAY,
      now: NOW,
    });
    return { res, call: store.calls.success[0] };
  };
  const a = await runOnce();
  const b = await runOnce();
  assert.equal(a.res.ok, true);
  assert.deepEqual(a, b);
  // override 60 on both deals: 300*0.6 = 180, 200*0.6 = 120
  assert.deepEqual(a.call.snapshots.map((r) => r.weightedQty), [180, 120]);
});

// ---------- runPipelineSync: failure paths ----------
function assertFailureShape(res) {
  assert.deepEqual(Object.keys(res).sort(), ['errorClass', 'message', 'ok']);
  assert.equal(res.ok, false);
}

test('client rejects with SalesforceError-like object: class and userMessage pass through', async () => {
  const err = Object.assign(new Error('raw internal text with FAKE-TOKEN-abc'), {
    errorClass: 'auth', userMessage: 'Salesforce rejected the credentials.',
  });
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({ client: makeClient({ reject: err }), store }));
  assertFailureShape(res);
  assert.deepEqual(res, { ok: false, errorClass: 'auth', message: 'Salesforce rejected the credentials.' });
  assert.equal(store.calls.success.length, 0);
  assert.deepEqual(store.calls.failure, [{
    shop: 'demo-shop.myshopify.com', failedAt: NOW.toISOString(),
    errorClass: 'auth', message: 'Salesforce rejected the credentials.',
  }]);
  assert.ok(!JSON.stringify(store.calls).includes('FAKE-TOKEN'));
});

test('plain Error with a fake secret: generic message, class unexpected_response, secret absent', async () => {
  const err = new Error('connection to host failed token=FAKE-SECRET-9f3a');
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({ client: makeClient({ reject: err }), store }));
  assert.deepEqual(res, { ok: false, errorClass: 'unexpected_response', message: GENERIC });
  assert.ok(!JSON.stringify(res).includes('FAKE-SECRET'));
  assert.ok(!JSON.stringify(store.calls).includes('FAKE-SECRET'));
  assert.equal(store.calls.success.length, 0);
  assert.deepEqual(store.calls.failure, [{
    shop: 'demo-shop.myshopify.com', failedAt: NOW.toISOString(), errorClass: 'unexpected_response', message: GENERIC,
  }]);
});

test('partial error info: class without userMessage, userMessage without class, empty strings', async () => {
  const run = async (e) => runPipelineSync(baseArgs({ client: makeClient({ reject: e }) }));
  assert.deepEqual(await run(Object.assign(new Error('x FAKE-SECRET'), { errorClass: 'rate_limited' })),
    { ok: false, errorClass: 'rate_limited', message: GENERIC });
  assert.deepEqual(await run(Object.assign(new Error('x'), { userMessage: 'Please retry later.' })),
    { ok: false, errorClass: 'unexpected_response', message: 'Please retry later.' });
  assert.deepEqual(await run(Object.assign(new Error('x'), { errorClass: '', userMessage: '' })),
    { ok: false, errorClass: 'unexpected_response', message: GENERIC });
  assert.deepEqual(await run(Object.assign(new Error('x'), { errorClass: 5, userMessage: { a: 1 } })),
    { ok: false, errorClass: 'unexpected_response', message: GENERIC });
});

test('odd rejection values never make runPipelineSync throw', async () => {
  for (const v of [undefined, null, 'a string FAKE-SECRET', 42, {}]) {
    const store = makeStore();
    const res = await runPipelineSync(baseArgs({ client: makeClient({ reject: v }), store }));
    assert.deepEqual(res, { ok: false, errorClass: 'unexpected_response', message: GENERIC }, String(v));
    assert.equal(store.calls.success.length, 0);
    assert.equal(store.calls.failure.length, 1);
  }
});

test('client throwing synchronously is handled like a rejection', async () => {
  const client = { fetchOpenOpportunities() { throw new Error('sync boom FAKE-SECRET'); } };
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({ client, store }));
  assert.deepEqual(res, { ok: false, errorClass: 'unexpected_response', message: GENERIC });
  assert.equal(store.calls.success.length, 0);
});

test('getShopifySkus rejects: failure recorded, client never called', async () => {
  const client = makeClient();
  const store = makeStore();
  const res = await runPipelineSync(baseArgs({
    client, store, getShopifySkus: makeSkuSource({ reject: new Error('admin api down FAKE-SECRET') }),
  }));
  assert.deepEqual(res, { ok: false, errorClass: 'unexpected_response', message: GENERIC });
  assert.equal(store.calls.success.length, 0);
  assert.equal(store.calls.failure.length, 1);
  assert.equal(store.calls.failure[0].failedAt, NOW.toISOString());
  assert.ok(!JSON.stringify(store.calls).includes('FAKE-SECRET'));
});

test('getShopifySkus rejects with class/userMessage: passed through', async () => {
  const e = Object.assign(new Error('z'), { errorClass: 'shopify_api', userMessage: 'Shopify is unavailable.' });
  const res = await runPipelineSync(baseArgs({ getShopifySkus: makeSkuSource({ reject: e }) }));
  assert.deepEqual(res, { ok: false, errorClass: 'shopify_api', message: 'Shopify is unavailable.' });
});

test('recordSyncSuccess rejects: storage class, fixed message, best-effort failure record', async () => {
  const store = makeStore({ failSuccess: new Error('db password FAKE-DB-PW') });
  const res = await runPipelineSync(baseArgs({ client: makeClient({ opportunities: workedDeals() }), store }));
  assert.deepEqual(res, { ok: false, errorClass: 'storage', message: STORAGE_MSG });
  assert.equal(store.calls.success.length, 1);
  assert.deepEqual(store.calls.failure, [{
    shop: 'demo-shop.myshopify.com', failedAt: NOW.toISOString(), errorClass: 'storage', message: STORAGE_MSG,
  }]);
  assert.ok(!JSON.stringify(res).includes('FAKE-DB-PW'));
  assert.ok(!JSON.stringify(store.calls.failure).includes('FAKE-DB-PW'));
});

test('recordSyncSuccess rejecting with a SalesforceError-like object still reports storage', async () => {
  const store = makeStore({ failSuccess: Object.assign(new Error('q'), { errorClass: 'auth', userMessage: 'nope' }) });
  const res = await runPipelineSync(baseArgs({ store }));
  assert.deepEqual(res, { ok: false, errorClass: 'storage', message: STORAGE_MSG });
});

test('recordSyncFailure rejecting is swallowed on every failure path', async () => {
  const boom = new Error('failure store down');
  // client failure
  let store = makeStore({ failFailure: boom });
  let res = await runPipelineSync(baseArgs({ client: makeClient({ reject: new Error('x') }), store }));
  assert.deepEqual(res, { ok: false, errorClass: 'unexpected_response', message: GENERIC });
  assert.equal(store.calls.failure.length, 1);
  // storage failure and failure store both down
  store = makeStore({ failSuccess: new Error('a'), failFailure: boom });
  res = await runPipelineSync(baseArgs({ store }));
  assert.deepEqual(res, { ok: false, errorClass: 'storage', message: STORAGE_MSG });
  // failure recorder throws synchronously
  store = makeStore({ failSuccess: new Error('a') });
  store.recordSyncFailure = () => { throw new Error('sync throw'); };
  res = await runPipelineSync(baseArgs({ store }));
  assert.deepEqual(res, { ok: false, errorClass: 'storage', message: STORAGE_MSG });
});

test('recordSyncSuccess is never called on any client/sku failure path', async () => {
  const stores = [];
  for (const reject of [new Error('a'), Object.assign(new Error('b'), { errorClass: 'auth', userMessage: 'm' }), undefined]) {
    const store = makeStore();
    stores.push(store);
    await runPipelineSync(baseArgs({ client: makeClient({ reject }), store }));
    await runPipelineSync(baseArgs({ getShopifySkus: makeSkuSource({ reject: reject ?? new Error('c') }), store }));
  }
  for (const s of stores) {
    assert.equal(s.calls.success.length, 0);
    assert.equal(s.calls.failure.length, 2);
  }
});

// ---------- config validation ----------
const badConfigs = {
  'empty shop': { shop: '' },
  'numeric shop': { shop: 123 },
  'missing shop': { shop: undefined },
  'null shop': { shop: null },
  'garbage today': { today: 'tomorrow' },
  'impossible today': { today: '2026-02-30' },
  'missing today': { today: undefined },
  'Date as today': { today: new Date('2026-01-01') },
  'string now': { now: '2026-01-01T12:00:00Z' },
  'invalid Date now': { now: new Date('x') },
  'missing now': { now: undefined },
  'epoch now': { now: 1767268800000 },
  'null client': { client: null },
  'client without fetch': { client: {} },
  'client fetch not a function': { client: { fetchOpenOpportunities: 'x' } },
  'null store': { store: null },
  'store without recordSyncSuccess': { store: { recordSyncFailure: async () => {} } },
  'store without recordSyncFailure': { store: { recordSyncSuccess: async () => {} } },
  'getShopifySkus not a function': { getShopifySkus: ['SKU-X'] },
  'missing getShopifySkus': { getShopifySkus: undefined },
};

for (const [label, override] of Object.entries(badConfigs)) {
  test(`config validation: ${label} -> errorClass config, zero downstream calls`, async () => {
    const client = makeClient({ opportunities: workedDeals() });
    const store = makeStore();
    const skus = makeSkuSource({ skus: ['SKU-X'] });
    const args = baseArgs({ client, store, getShopifySkus: skus });
    // apply the override; replacing client/store/getShopifySkus swaps in the bad value
    Object.assign(args, override);
    const res = await runPipelineSync(args);
    assertFailureShape(res);
    assert.equal(res.errorClass, 'config');
    assert.equal(typeof res.message, 'string');
    assert.ok(res.message.length > 0);
    assert.equal(client.calls.length, 0);
    assert.equal(skus.calls, 0);
    assert.equal(store.calls.success.length, 0);
    assert.equal(store.calls.failure.length, 0);
  });
}

test('config validation with the other collaborators intact: spies untouched when only one is bad', async () => {
  const client = makeClient();
  const store = makeStore();
  const skus = makeSkuSource({ skus: ['SKU-X'] });
  const res = await runPipelineSync({ shop: '', client, store, getShopifySkus: skus, today: TODAY, now: NOW });
  assert.equal(res.errorClass, 'config');
  assert.deepEqual([client.calls.length, skus.calls, store.calls.success.length, store.calls.failure.length], [0, 0, 0, 0]);
});

test('runPipelineSync with no arguments or null never throws', async () => {
  for (const arg of [undefined, null, {}]) {
    const res = await runPipelineSync(arg);
    assert.equal(res.ok, false);
    assert.equal(res.errorClass, 'config');
  }
});

test('success path calls recordSyncSuccess exactly once and never recordSyncFailure', async () => {
  const store = makeStore();
  const client = makeClient({ opportunities: workedDeals() });
  const skus = makeSkuSource({ skus: ['SKU-X'] });
  await runPipelineSync(baseArgs({ store, client, getShopifySkus: skus }));
  assert.equal(store.calls.success.length, 1);
  assert.equal(store.calls.failure.length, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(skus.calls, 1);
});

// ---------- extra branches found in review ----------
test('addDaysIso: fractional days truncate toward zero, non-finite days -> null', () => {
  assert.equal(addDaysIso('2026-01-01', 1.9), '2026-01-02');
  assert.equal(addDaysIso('2026-01-02', -1.9), '2026-01-01');
  for (const bad of [NaN, Infinity, '5', undefined, null]) assert.equal(addDaysIso('2026-01-01', bad), null, String(bad));
});

test('isSyncDue: whitespace/empty string lastSyncAt due; bad intervalHours falls back to 6; interval 0', () => {
  const now = '2026-01-01T12:00:00.000Z';
  assert.equal(isSyncDue({ lastSyncAt: '', now }), true);
  assert.equal(isSyncDue({ lastSyncAt: '   ', now }), true);
  assert.equal(isSyncDue({ lastSyncAt: '2026-01-01T07:00:00.000Z', now, intervalHours: NaN }), false); // 5h < 6h
  assert.equal(isSyncDue({ lastSyncAt: '2026-01-01T06:00:00.000Z', now, intervalHours: NaN }), true);
  assert.equal(isSyncDue({ lastSyncAt: now, now, intervalHours: 0 }), true); // 0ms >= 0h
  assert.equal(isSyncDue({ lastSyncAt: '2026-01-01T12:00:00.001Z', now, intervalHours: 0 }), false); // future
});

test('whitespace-only shop, errorClass and userMessage are treated as missing', async () => {
  let res = await runPipelineSync(baseArgs({ shop: '   ' }));
  assert.equal(res.errorClass, 'config');
  res = await runPipelineSync(baseArgs({
    client: makeClient({ reject: Object.assign(new Error('x'), { errorClass: '  ', userMessage: '  ' }) }),
  }));
  assert.deepEqual(res, { ok: false, errorClass: 'unexpected_response', message: GENERIC });
});

test('settings: null / non-object settings and stageOverrides fall back to defaults', async () => {
  const defaults = await weightedFor({});
  assert.deepEqual(await weightedFor(null), defaults);
  assert.deepEqual(await weightedFor('x'), defaults);
  assert.deepEqual(await weightedFor({ stageOverrides: null }), defaults);
  assert.deepEqual(await weightedFor({ stageOverrides: 'x' }), defaults);
  assert.deepEqual(await weightedFor({ haircut: '0', shipOffsetDays: '0', horizonDays: '1' }), defaults); // strings ignored
});

test('malformed client output never makes runPipelineSync throw', async () => {
  for (const bad of [null, undefined, 'x', {}, [null, 5, { lineItems: 'x' }, { closeDate: 'bad', lineItems: [null] }]]) {
    const store = makeStore();
    const res = await runPipelineSync(baseArgs({ client: makeClient({ opportunities: bad }), store }));
    assert.equal(typeof res.ok, 'boolean');
    if (res.ok) {
      assert.equal(store.calls.success.length, 1);
      assert.equal(store.calls.failure.length, 0);
    } else {
      assert.equal(store.calls.success.length, 0);
      assert.equal(res.message, GENERIC);
    }
  }
});

test('storage failure uses the same timestamp as syncedAt', async () => {
  const store = makeStore({ failSuccess: new Error('a') });
  await runPipelineSync(baseArgs({ store }));
  assert.equal(store.calls.failure[0].failedAt, store.calls.success[0].syncedAt);
});

test('snapshots handed to the store contain only aggregate keys (no ids, stages, dates of deals)', async () => {
  const store = makeStore();
  await runPipelineSync(baseArgs({ client: makeClient({ opportunities: workedDeals() }), store }));
  const call = store.calls.success[0];
  assert.deepEqual(Object.keys(call).sort(), ['shop', 'snapshots', 'syncedAt', 'unmatched']);
  const text = JSON.stringify(call);
  for (const forbidden of ['o1', 'o2', 'Negotiation', '2026-01-21', '2026-01-31']) assert.ok(!text.includes(forbidden), forbidden);
});

test('engine crash after a successful fetch: never rejects, records failure once, no success', async () => {
  // A Proxy array whose element access throws forces a throw inside the engine, after the client returned.
  const hostile = new Proxy([{}], {
    get(target, prop, recv) {
      if (prop === Symbol.iterator || prop === '0' || prop === 'length' || prop === 'forEach' || prop === 'map') {
        throw new Error('hostile getter FAKE-SECRET');
      }
      return Reflect.get(target, prop, recv);
    },
  });
  const getterDeal = { id: 'g', stageName: 'S', probability: 50, closeDate: '2026-01-21' };
  Object.defineProperty(getterDeal, 'lineItems', { get() { throw new Error('getter boom FAKE-SECRET'); } });
  for (const opportunities of [hostile, [getterDeal]]) {
    const store = makeStore();
    const res = await runPipelineSync(baseArgs({ client: makeClient({ opportunities }), store }));
    assert.deepEqual(res, { ok: false, errorClass: 'unexpected_response', message: GENERIC });
    assert.equal(store.calls.success.length, 0);
    assert.deepEqual(store.calls.failure, [{
      shop: 'demo-shop.myshopify.com', failedAt: NOW.toISOString(),
      errorClass: 'unexpected_response', message: GENERIC,
    }]);
    assert.ok(!JSON.stringify(store.calls).includes('FAKE-SECRET'));
  }
});

test('engine crash with a failing failure-recorder still resolves ok:false', async () => {
  const getterDeal = { id: 'g', stageName: 'S', probability: 50, closeDate: '2026-01-21' };
  Object.defineProperty(getterDeal, 'lineItems', { get() { throw new Error('boom'); } });
  const store = makeStore({ failFailure: new Error('down') });
  const res = await runPipelineSync(baseArgs({ client: makeClient({ opportunities: [getterDeal] }), store }));
  assert.deepEqual(res, { ok: false, errorClass: 'unexpected_response', message: GENERIC });
  assert.equal(store.calls.failure.length, 1);
});
