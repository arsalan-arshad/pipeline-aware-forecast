import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateBurnDown, scenarioSet } from '../app/lib/pipeline/burn-down.js';
import { deepFreeze, snapshot } from './fixtures/pipeline-fixtures.js';

const sim = (o) => simulateBurnDown({ leadTimeDays: 14, horizonDays: 90, retailDailyDemand: 0, shipments: [], ...o });

test('retail only: stock 400 at 10/day hits 0 on day 40; order-by 40 - 14 = 26', () => {
  assert.deepEqual(sim({ stock: 400, retailDailyDemand: 10 }), { stockoutDay: 40, orderByDay: 26 });
});

test('shipments argument may be omitted', () => {
  assert.deepEqual(
    simulateBurnDown({ stock: 400, retailDailyDemand: 10, leadTimeDays: 14, horizonDays: 90 }),
    { stockoutDay: 40, orderByDay: 26 },
  );
});

test('no stockout within horizon -> both null', () => {
  // 1000 - 10*90 = 100 > 0
  assert.deepEqual(sim({ stock: 1000, retailDailyDemand: 10 }), { stockoutDay: null, orderByDay: null });
});

test('horizon boundary: stock 900 at 10/day reaches exactly 0 on day 90 (stockout); 901 does not', () => {
  assert.deepEqual(sim({ stock: 900, retailDailyDemand: 10 }), { stockoutDay: 90, orderByDay: 76 });
  assert.deepEqual(sim({ stock: 901, retailDailyDemand: 10 }), { stockoutDay: null, orderByDay: null });
});

test('zero retail demand and no shipments never stocks out', () => {
  assert.deepEqual(sim({ stock: 5, retailDailyDemand: 0 }), { stockoutDay: null, orderByDay: null });
});

test('zero retail demand: a shipment can still cause the stockout', () => {
  // stock 100, ship 100 on day 5 -> 0 on day 5 ; lead 3 -> order-by 2
  assert.deepEqual(
    sim({ stock: 100, retailDailyDemand: 0, leadTimeDays: 3, shipments: [{ day: 5, qty: 100 }] }),
    { stockoutDay: 5, orderByDay: 2 },
  );
});

test('a shipment exactly zeroing stock counts as stockout; one unit short does not', () => {
  assert.equal(sim({ stock: 100, shipments: [{ day: 5, qty: 100 }] }).stockoutDay, 5);
  assert.equal(sim({ stock: 100, shipments: [{ day: 5, qty: 99 }] }).stockoutDay, null);
});

test('stock already zero or negative -> stockout day 0, order-by = -leadTime', () => {
  assert.deepEqual(sim({ stock: 0, retailDailyDemand: 10 }), { stockoutDay: 0, orderByDay: -14 });
  assert.deepEqual(sim({ stock: -50, retailDailyDemand: 0 }), { stockoutDay: 0, orderByDay: -14 });
});

test('order-by can be negative (already late): stock 100 at 10/day -> day 10, lead 14 -> -4', () => {
  assert.deepEqual(sim({ stock: 100, retailDailyDemand: 10 }), { stockoutDay: 10, orderByDay: -4 });
});

test('leadTimeDays 0 -> order-by equals stockout day', () => {
  assert.deepEqual(sim({ stock: 400, retailDailyDemand: 10, leadTimeDays: 0 }), { stockoutDay: 40, orderByDay: 40 });
});

test('retail is not consumed on day 0: stock 100, ship 60 on day 0, 10/day -> 40,30,20,10,0 -> day 4', () => {
  assert.equal(sim({ stock: 100, retailDailyDemand: 10, shipments: [{ day: 0, qty: 60 }] }).stockoutDay, 4);
});

test('a day-0 shipment alone can zero the stock on day 0', () => {
  assert.equal(sim({ stock: 100, retailDailyDemand: 10, shipments: [{ day: 0, qty: 100 }] }).stockoutDay, 0);
});

test('shipment with negative day is treated as day 0', () => {
  assert.equal(sim({ stock: 100, retailDailyDemand: 10, shipments: [{ day: -5, qty: 100 }] }).stockoutDay, 0);
});

test('same-day shipments are summed: 60 + 60 = 120 > 100 -> day 5; 30 + 30 leaves 40 -> none', () => {
  assert.equal(sim({ stock: 100, shipments: [{ day: 5, qty: 60 }, { day: 5, qty: 60 }] }).stockoutDay, 5);
  assert.equal(sim({ stock: 100, shipments: [{ day: 5, qty: 30 }, { day: 5, qty: 30 }] }).stockoutDay, null);
});

test('shipment order in the array does not matter', () => {
  const a = sim({ stock: 100, shipments: [{ day: 8, qty: 50 }, { day: 3, qty: 50 }] });
  const b = sim({ stock: 100, shipments: [{ day: 3, qty: 50 }, { day: 8, qty: 50 }] });
  assert.deepEqual(a, b);
  assert.equal(a.stockoutDay, 8);
});

test('shipment on the horizon day counts; one day past it is ignored', () => {
  assert.equal(sim({ stock: 100, shipments: [{ day: 90, qty: 100 }] }).stockoutDay, 90);
  assert.equal(sim({ stock: 100, shipments: [{ day: 91, qty: 100 }] }).stockoutDay, null);
});

test('stock 25 at 10/day: 15, 5, -5 -> stockout day 3 (retail overshoot counts)', () => {
  assert.equal(sim({ stock: 25, retailDailyDemand: 10 }).stockoutDay, 3);
});

test('negative or non-finite retail demand is treated as 0', () => {
  for (const r of [-5, NaN, Infinity, -Infinity]) {
    assert.deepEqual(sim({ stock: 100, retailDailyDemand: r }), { stockoutDay: null, orderByDay: null }, String(r));
  }
});

test('horizonDays 0 only looks at day 0', () => {
  assert.equal(sim({ stock: 100, retailDailyDemand: 10, horizonDays: 0 }).stockoutDay, null);
  assert.equal(sim({ stock: 0, retailDailyDemand: 10, horizonDays: 0 }).stockoutDay, 0);
});

test('simulateBurnDown is deterministic and does not mutate frozen input', () => {
  const shipments = deepFreeze([{ day: 20, qty: 150 }, { day: 30, qty: 40 }]);
  const before = snapshot(shipments);
  const a = sim({ stock: 400, retailDailyDemand: 10, shipments });
  const b = sim({ stock: 400, retailDailyDemand: 10, shipments });
  assert.deepEqual(a, b);
  assert.deepEqual(shipments, before);
});

// ---- scenarioSet --------------------------------------------------------------------

const ship = (day, weightedQty, rawQty) => ({ day, weightedQty, rawQty, openDealCount: 1 });

test('scenarioSet: weighted uses weightedQty, allClose uses rawQty, retailOnly ignores shipments', () => {
  // stock 100, no retail, lead 2: weighted 100-30=70 never zero; raw 100-100=0 on day 10 -> order-by 8
  const out = scenarioSet({
    stock: 100, retailDailyDemand: 0, leadTimeDays: 2, horizonDays: 90,
    shipments: [ship(10, 30, 100)],
  });
  assert.deepEqual(out.retailOnly, { stockoutDay: null, orderByDay: null });
  assert.deepEqual(out.weighted, { stockoutDay: null, orderByDay: null });
  assert.deepEqual(out.allClose, { stockoutDay: 10, orderByDay: 8 });
});

test('scenarioSet with no shipments: all three scenarios agree', () => {
  const out = scenarioSet({ stock: 400, retailDailyDemand: 10, leadTimeDays: 14, horizonDays: 90, shipments: [] });
  const want = { stockoutDay: 40, orderByDay: 26 };
  assert.deepEqual(out, { retailOnly: want, weighted: want, allClose: want });
});

test('scenarioSet with zero-weight shipments: weighted equals retailOnly, allClose is earlier', () => {
  // retail only: day 40. allClose: 400 - 100 at day 5 = 300, then 10/day: day 5 level 300-... compute:
  // day 5 level = 400 - 50 - 100 = 250 ; 25 more days -> 0 at day 30.
  const out = scenarioSet({
    stock: 400, retailDailyDemand: 10, leadTimeDays: 14, horizonDays: 90,
    shipments: [ship(5, 0, 100)],
  });
  assert.deepEqual(out.weighted, out.retailOnly);
  assert.deepEqual(out.allClose, { stockoutDay: 30, orderByDay: 16 });
});

test('scenarioSet: stock <= 0 gives day 0 in every scenario', () => {
  const out = scenarioSet({ stock: -1, retailDailyDemand: 3, leadTimeDays: 5, horizonDays: 90, shipments: [ship(3, 1, 1)] });
  const want = { stockoutDay: 0, orderByDay: -5 };
  assert.deepEqual(out, { retailOnly: want, weighted: want, allClose: want });
});

test('scenarioSet is deterministic and does not mutate frozen input', () => {
  const shipments = deepFreeze([ship(20, 150, 300), ship(30, 40, 200)]);
  const before = snapshot(shipments);
  const args = { stock: 400, retailDailyDemand: 10, leadTimeDays: 14, horizonDays: 90, shipments };
  assert.deepEqual(scenarioSet(args), scenarioSet(args));
  assert.deepEqual(shipments, before);
});
