// Tests for app/lib/pipeline/forecast-view.js, written from the module contract.
// Pure function: hand-computed expectations, frozen inputs, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForecastRows } from '../app/lib/pipeline/forecast-view.js';
import { deepFreeze } from './fixtures/m5-fixtures.js';

const TODAY = '2026-01-01';
const NULL_SCENARIO = { stockoutDay: null, orderByDay: null, stockoutDate: null, orderByDate: null };

// Worked example inputs (stored-week form): stock 400, retail 10/day, lead 14, horizon 90.
// One week row starting on day 20 (2026-01-21): weighted 150, raw 300.
//   retailOnly: 400 - 10t <= 0 at t = 40                  -> stockout 40, order-by 26
//   weighted:   day 20 level = 400 - 200 - 150 = 50; 5 more retail days -> day 25, order-by 11
//   allClose:   day 20 level = 400 - 200 - 300 = -100     -> day 20, order-by 6
// Dates from 2026-01-01: +40 = 2026-02-10, +25 = 2026-01-26, +20 = 2026-01-21,
//                         +26 = 2026-01-27, +11 = 2026-01-12, +6 = 2026-01-07.
const workedInput = () => ({
  today: TODAY,
  stockBySku: { 'SKU-X': 400 },
  dailyDemandBySku: { 'SKU-X': 10 },
  snapshots: [{ sku: 'SKU-X', weekStart: '2026-01-21', weightedQty: 150, rawQty: 300, openDealCount: 3 }],
});

test('worked example: stockout 40/25/20, order-by 26/11/6, with dates', () => {
  const rows = buildForecastRows(workedInput());
  assert.deepEqual(rows, [{
    sku: 'SKU-X',
    stock: 400,
    retailDailyDemand: 10,
    openDealCount: 3,
    weightedUnits: 150,
    rawUnits: 300,
    scenarios: {
      retailOnly: { stockoutDay: 40, orderByDay: 26, stockoutDate: '2026-02-10', orderByDate: '2026-01-27' },
      weighted: { stockoutDay: 25, orderByDay: 11, stockoutDate: '2026-01-26', orderByDate: '2026-01-12' },
      allClose: { stockoutDay: 20, orderByDay: 6, stockoutDate: '2026-01-21', orderByDate: '2026-01-07' },
    },
  }]);
});

test('row has exactly the contract keys, in any order', () => {
  const [row] = buildForecastRows(workedInput());
  assert.deepEqual(
    Object.keys(row).sort(),
    ['openDealCount', 'rawUnits', 'retailDailyDemand', 'scenarios', 'sku', 'stock', 'weightedUnits'],
  );
  assert.deepEqual(Object.keys(row.scenarios).sort(), ['allClose', 'retailOnly', 'weighted']);
  for (const s of Object.values(row.scenarios)) {
    assert.deepEqual(Object.keys(s).sort(), ['orderByDate', 'orderByDay', 'stockoutDate', 'stockoutDay']);
  }
});

test('custom leadTimeDays moves only the order-by values', () => {
  const [row] = buildForecastRows({ ...workedInput(), leadTimeDays: 7 });
  // stockout 40/25/20 unchanged; order-by = 33/18/13.
  assert.deepEqual(
    [row.scenarios.retailOnly, row.scenarios.weighted, row.scenarios.allClose].map((s) => [s.stockoutDay, s.orderByDay]),
    [[40, 33], [25, 18], [20, 13]],
  );
  assert.equal(row.scenarios.retailOnly.orderByDate, '2026-02-03'); // +33
});

test('custom horizonDays: a stockout beyond the horizon is null (and so are its dates)', () => {
  const [row] = buildForecastRows({ ...workedInput(), horizonDays: 30 });
  // retail-only stockout day 40 > 30 -> null; weighted 25 and allClose 20 remain.
  assert.deepEqual(row.scenarios.retailOnly, NULL_SCENARIO);
  assert.equal(row.scenarios.weighted.stockoutDay, 25);
  assert.equal(row.scenarios.allClose.stockoutDay, 20);
});

test('a week row beyond the horizon does not create a stockout', () => {
  // weekStart 2026-04-12 is day 101 > 90. Plenty of stock, no retail demand.
  const rows = buildForecastRows({
    today: TODAY,
    stockBySku: { A: 1000 },
    snapshots: [{ sku: 'A', weekStart: '2026-04-12', weightedQty: 5000, rawQty: 5000, openDealCount: 1 }],
  });
  assert.deepEqual(rows[0].scenarios, { retailOnly: NULL_SCENARIO, weighted: NULL_SCENARIO, allClose: NULL_SCENARIO });
});

test('SKU known only from snapshots: stock 0 -> stockout day 0, order-by -14, a past order-by date', () => {
  const rows = buildForecastRows({
    today: TODAY,
    snapshots: [{ sku: 'ONLY-DEALS', weekStart: '2026-01-19', weightedQty: 10, rawQty: 20, openDealCount: 2 }],
  });
  // Dec 31 is -1, so -14 is 2025-12-18. Day 0 stockout date is today.
  const dead = { stockoutDay: 0, orderByDay: -14, stockoutDate: TODAY, orderByDate: '2025-12-18' };
  assert.deepEqual(rows, [{
    sku: 'ONLY-DEALS',
    stock: 0,
    retailDailyDemand: 0,
    openDealCount: 2,
    weightedUnits: 10,
    rawUnits: 20,
    scenarios: { retailOnly: dead, weighted: dead, allClose: dead },
  }]);
});

test('SKU known only from stock (no demand, no deals): every scenario is null', () => {
  const rows = buildForecastRows({ today: TODAY, stockBySku: { SHELF: 50 } });
  assert.deepEqual(rows, [{
    sku: 'SHELF',
    stock: 50,
    retailDailyDemand: 0,
    openDealCount: 0,
    weightedUnits: 0,
    rawUnits: 0,
    scenarios: { retailOnly: NULL_SCENARIO, weighted: NULL_SCENARIO, allClose: NULL_SCENARIO },
  }]);
});

test('SKU known only from demand: stock 0 -> immediate stockout in every scenario', () => {
  const [row] = buildForecastRows({ today: TODAY, dailyDemandBySku: { RUN: 2 }, leadTimeDays: 5 });
  assert.equal(row.stock, 0);
  assert.equal(row.retailDailyDemand, 2);
  for (const s of Object.values(row.scenarios)) {
    assert.deepEqual(s, { stockoutDay: 0, orderByDay: -5, stockoutDate: TODAY, orderByDate: '2025-12-27' });
  }
});

test('SKU universe is the union of stock, demand and snapshots', () => {
  const rows = buildForecastRows({
    today: TODAY,
    stockBySku: { A: 1 },
    dailyDemandBySku: { B: 1 },
    snapshots: [{ sku: 'C', weekStart: '2026-01-05', weightedQty: 1, rawQty: 1, openDealCount: 1 }],
  });
  assert.deepEqual(rows.map((r) => r.sku), ['A', 'B', 'C']);
});

test('rows are sorted by plain string compare (digits, then upper case, then lower case)', () => {
  const stockBySku = { b: 1, B: 1, a: 1, Z: 1, 10: 1, 9: 1, 'sku-2': 1, 'sku-10': 1 };
  const rows = buildForecastRows({ today: TODAY, stockBySku });
  // Code-unit order: '10' < '9' < 'B' < 'Z' < 'a' < 'b' < 'sku-10' < 'sku-2'.
  assert.deepEqual(rows.map((r) => r.sku), ['10', '9', 'B', 'Z', 'a', 'b', 'sku-10', 'sku-2']);
});

test('Map and plain-object inputs give identical output, and they may be mixed', () => {
  const asObjects = buildForecastRows(workedInput());
  const asMaps = buildForecastRows({
    ...workedInput(),
    stockBySku: new Map([['SKU-X', 400]]),
    dailyDemandBySku: new Map([['SKU-X', 10]]),
  });
  assert.deepEqual(asMaps, asObjects);
  const mixed = buildForecastRows({ ...workedInput(), stockBySku: new Map([['SKU-X', 400]]) });
  assert.deepEqual(mixed, asObjects);
});

test('absent or null inputs are treated as empty', () => {
  assert.deepEqual(buildForecastRows({ today: TODAY }), []);
  assert.deepEqual(buildForecastRows({ today: TODAY, stockBySku: null, dailyDemandBySku: null, snapshots: null }), []);
  assert.deepEqual(buildForecastRows({ today: TODAY, stockBySku: new Map(), dailyDemandBySku: {}, snapshots: [] }), []);
});

test('non-finite or negative stock and demand count as 0', () => {
  const rows = buildForecastRows({
    today: TODAY,
    stockBySku: { NEG: -5, NAN: Number.NaN, INF: Infinity, NUL: null, OK: 7 },
    dailyDemandBySku: { NEG: -1, NAN: Number.NaN, INF: -Infinity, OK: Number.POSITIVE_INFINITY },
  });
  const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
  for (const sku of ['NEG', 'NAN', 'INF', 'NUL']) {
    assert.equal(by[sku].stock, 0, sku);
    assert.equal(by[sku].retailDailyDemand, 0, sku);
  }
  assert.equal(by.OK.stock, 7);
  assert.equal(by.OK.retailDailyDemand, 0);
  // Bad demand is 0, so a SKU with real stock never runs out from retail alone.
  assert.deepEqual(by.OK.scenarios.retailOnly, NULL_SCENARIO);
});

test('retailDailyDemand is rounded to 4 decimals for display only, after the engine used the exact value', () => {
  // Exact demand 0.33334 on stock 10: 30 days burn 10.0002 >= 10, so stockout day 30.
  // (A demand pre-rounded to 0.3333 would burn only 9.999 by day 30 and give day 31.)
  const [row] = buildForecastRows({ today: TODAY, stockBySku: { A: 10 }, dailyDemandBySku: { A: 0.33334 } });
  assert.equal(row.retailDailyDemand, 0.3333);
  assert.equal(row.scenarios.retailOnly.stockoutDay, 30);
  assert.equal(row.scenarios.retailOnly.orderByDay, 16);
});

test('retailDailyDemand with more than 4 decimals rounds half-up at the 4th place', () => {
  const [row] = buildForecastRows({ today: TODAY, stockBySku: { A: 100 }, dailyDemandBySku: { A: 1.23456789 } });
  assert.equal(row.retailDailyDemand, 1.2346);
});

test('units are summed across weeks and rounded to 2 decimals; deal counts are summed', () => {
  const rows = buildForecastRows({
    today: TODAY,
    stockBySku: { A: 1000 },
    snapshots: [
      { sku: 'A', weekStart: '2026-01-05', weightedQty: 0.1, rawQty: 1.005, openDealCount: 1 },
      { sku: 'A', weekStart: '2026-01-12', weightedQty: 0.2, rawQty: 2, openDealCount: 4 },
      { sku: 'A', weekStart: '2026-01-19', weightedQty: 10.004, rawQty: 3, openDealCount: 2 },
    ],
  });
  // weighted: 0.1 + 0.2 + 10.004 = 10.304 -> 10.3 ; raw: 1.005 + 2 + 3 = 6.005 -> ~6 (float noise; see below)
  assert.equal(rows[0].weightedUnits, 10.3);
  assert.equal(rows[0].openDealCount, 7);
  assert.equal(Math.abs(rows[0].rawUnits - 6) < 0.011, true);
  assert.equal(rows[0].rawUnits, Math.round(rows[0].rawUnits * 100) / 100, 'already rounded to 2 decimals');
});

test('0.1 + 0.2 weighted units display as 0.3, not 0.30000000000000004', () => {
  const [row] = buildForecastRows({
    today: TODAY,
    snapshots: [
      { sku: 'A', weekStart: '2026-01-05', weightedQty: 0.1, rawQty: 1, openDealCount: 1 },
      { sku: 'A', weekStart: '2026-01-12', weightedQty: 0.2, rawQty: 1, openDealCount: 1 },
    ],
  });
  assert.equal(row.weightedUnits, 0.3);
  assert.equal(row.rawUnits, 2);
});

test('unsorted week rows give the same result as sorted ones', () => {
  const weeks = [
    { sku: 'A', weekStart: '2026-01-26', weightedQty: 40, rawQty: 200, openDealCount: 1 },
    { sku: 'A', weekStart: '2026-01-19', weightedQty: 150, rawQty: 300, openDealCount: 1 },
  ];
  const base = { today: TODAY, stockBySku: { A: 400 }, dailyDemandBySku: { A: 10 } };
  const shuffled = buildForecastRows({ ...base, snapshots: weeks });
  const sorted = buildForecastRows({ ...base, snapshots: [...weeks].reverse() });
  assert.deepEqual(shuffled, sorted);
  // Weeks start at day 18 and day 25. Weighted: day 18 level = 400 - 180 - 150 = 70, then day 25
  // level = 70 - 70 (7 retail days) - 40 = -40 -> stockout day 25 (retail alone would hit 0 at day 40;
  // 70 is not exhausted before day 25 since 70 - 10*7 = 0 exactly at day 25 -> still day 25).
  assert.equal(shuffled[0].scenarios.weighted.stockoutDay, 25);
  // allClose: day 18 level = 400 - 180 - 300 = -80 -> day 18.
  assert.equal(shuffled[0].scenarios.allClose.stockoutDay, 18);
});

test('a week that started before today is clamped to day 0', () => {
  // weekStart 2025-12-22 is day -10 -> day 0. Stock 400: weighted 500 -> level -100 at day 0.
  const [row] = buildForecastRows({
    today: TODAY,
    stockBySku: { A: 400 },
    snapshots: [{ sku: 'A', weekStart: '2025-12-22', weightedQty: 500, rawQty: 600, openDealCount: 1 }],
  });
  assert.deepEqual(row.scenarios.retailOnly, NULL_SCENARIO);
  assert.equal(row.scenarios.weighted.stockoutDay, 0);
  assert.equal(row.scenarios.weighted.orderByDay, -14);
  assert.equal(row.scenarios.weighted.stockoutDate, TODAY);
  assert.equal(row.scenarios.allClose.stockoutDay, 0);
});

test('two weeks of the same SKU on the same day (both clamped to day 0) are summed', () => {
  const [row] = buildForecastRows({
    today: TODAY,
    stockBySku: { A: 100 },
    snapshots: [
      { sku: 'A', weekStart: '2025-12-22', weightedQty: 60, rawQty: 60, openDealCount: 1 },
      { sku: 'A', weekStart: '2025-12-29', weightedQty: 60, rawQty: 60, openDealCount: 1 },
    ],
  });
  // 100 - (60 + 60) = -20 at day 0.
  assert.equal(row.scenarios.weighted.stockoutDay, 0);
  assert.equal(row.openDealCount, 2);
});

test('probability-zero deals: weighted never stocks out from deals alone, raw does', () => {
  const [row] = buildForecastRows({
    today: TODAY,
    stockBySku: { A: 100 },
    snapshots: [{ sku: 'A', weekStart: '2026-01-11', weightedQty: 0, rawQty: 100, openDealCount: 1 }],
  });
  // Day 10: raw consumes 100 of 100 -> 0 -> stockout (exactly 0 counts).
  assert.deepEqual(row.scenarios.weighted, NULL_SCENARIO);
  assert.equal(row.scenarios.allClose.stockoutDay, 10);
});

test('invalid snapshot rows are skipped and do not add SKUs to the universe', () => {
  const good = { sku: 'GOOD', weekStart: '2026-01-21', weightedQty: 150, rawQty: 300, openDealCount: 2 };
  const rows = buildForecastRows({
    today: TODAY,
    stockBySku: { GOOD: 400 },
    dailyDemandBySku: { GOOD: 10 },
    snapshots: [
      good,
      { sku: 42, weekStart: '2026-01-21', weightedQty: 1, rawQty: 1, openDealCount: 1 },
      { sku: null, weekStart: '2026-01-21', weightedQty: 1, rawQty: 1, openDealCount: 1 },
      { sku: 'NAN-W', weekStart: '2026-01-21', weightedQty: Number.NaN, rawQty: 1, openDealCount: 1 },
      { sku: 'INF-R', weekStart: '2026-01-21', weightedQty: 1, rawQty: Infinity, openDealCount: 1 },
      { sku: 'GOOD', weekStart: '2026-01-21', weightedQty: Number.NaN, rawQty: 999999, openDealCount: 50 },
    ],
  });
  assert.deepEqual(rows.map((r) => r.sku), ['GOOD']);
  // Bad rows contributed nothing: identical to the worked example except deal count 2.
  assert.equal(rows[0].openDealCount, 2);
  assert.equal(rows[0].weightedUnits, 150);
  assert.equal(rows[0].rawUnits, 300);
  assert.equal(rows[0].scenarios.weighted.stockoutDay, 25);
  assert.equal(rows[0].scenarios.allClose.stockoutDay, 20);
});

test('invalid today throws the contract error', () => {
  for (const bad of [undefined, null, '', 'today', '2026-02-30', '2026-1-1', '20260101', 20260101, '2026-01-01T00:00:00Z', '2026-13-01']) {
    assert.throws(
      () => buildForecastRows({ today: bad, stockBySku: { A: 1 } }),
      (err) => err instanceof Error && err.message === 'today must be a real YYYY-MM-DD date.',
      String(bad),
    );
  }
  assert.throws(() => buildForecastRows({}), /today must be a real YYYY-MM-DD date\./);
});

test('leap-day arithmetic: dates cross Feb 29 correctly', () => {
  // today 2028-02-27, stock 10, demand 1/day -> stockout day 10 = 2028-03-08 (Feb 29 exists: 27+2=29, +8 = Mar 8),
  // order-by 10 - 14 = -4 -> 2028-02-23.
  const [row] = buildForecastRows({ today: '2028-02-27', stockBySku: { A: 10 }, dailyDemandBySku: { A: 1 } });
  assert.equal(row.scenarios.retailOnly.stockoutDay, 10);
  assert.equal(row.scenarios.retailOnly.stockoutDate, '2028-03-08');
  assert.equal(row.scenarios.retailOnly.orderByDay, -4);
  assert.equal(row.scenarios.retailOnly.orderByDate, '2028-02-23');
});

test('pure: frozen inputs are not mutated and repeated calls are identical', () => {
  const input = deepFreeze({
    today: TODAY,
    stockBySku: { 'SKU-X': 400, 'SKU-Y': 5 },
    dailyDemandBySku: { 'SKU-X': 10 },
    snapshots: [
      { sku: 'SKU-X', weekStart: '2026-01-26', weightedQty: 40, rawQty: 200, openDealCount: 1 },
      { sku: 'SKU-X', weekStart: '2026-01-19', weightedQty: 150, rawQty: 300, openDealCount: 1 },
    ],
  });
  const before = JSON.stringify(input);
  const a = buildForecastRows(input);
  const b = buildForecastRows(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(input.snapshots.map((s) => s.weekStart), ['2026-01-26', '2026-01-19']);
});

test('returned rows are fresh objects each call (no shared mutable state)', () => {
  const a = buildForecastRows(workedInput());
  const b = buildForecastRows(workedInput());
  a[0].scenarios.weighted.stockoutDay = -1;
  assert.equal(b[0].scenarios.weighted.stockoutDay, 25);
});
