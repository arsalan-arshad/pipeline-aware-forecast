import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pipelineShipments,
  pipelineDemandByWeek,
  weeksToShipments,
} from '../app/lib/pipeline/pipeline-demand.js';
import { scenarioSet } from '../app/lib/pipeline/burn-down.js';
import { makeOpp, line, indexFor } from './fixtures/pipeline-fixtures.js';

// stock 400, retail 10/day, lead 14, horizon 90, today 2026-01-01, offset 0.
// Deal A: 300 units, prob 50, close 2026-01-21 (day 20) -> weighted 150.
// Deal B: 200 units, prob 20, close 2026-01-31 (day 30) -> weighted 40.
const opportunities = [
  makeOpp('deal-a', '2026-01-21', 50, [line('SKU-X', 300)]),
  makeOpp('deal-b', '2026-01-31', 20, [line('SKU-X', 200)]),
];
const common = { stock: 400, retailDailyDemand: 10, leadTimeDays: 14, horizonDays: 90 };
const pipelineArgs = {
  opportunities, today: '2026-01-01', horizonDays: 90, shipOffsetDays: 0, skuIndex: indexFor(['SKU-X']),
};

test('worked example: pipelineShipments produces the two hand-computed shipments', () => {
  const ships = pipelineShipments(pipelineArgs).get('SKU-X');
  assert.deepEqual(ships, [
    { day: 20, weightedQty: 150, rawQty: 300, openDealCount: 1 },
    { day: 30, weightedQty: 40, rawQty: 200, openDealCount: 1 },
  ]);
});

test('worked example end to end: stockout 40 / 25 / 20 and order-by 26 / 11 / 6', () => {
  const shipments = pipelineShipments(pipelineArgs).get('SKU-X');
  const out = scenarioSet({ ...common, shipments });
  // retailOnly: 400 - 10*40 = 0 -> day 40 ; order-by 40 - 14 = 26
  assert.deepEqual(out.retailOnly, { stockoutDay: 40, orderByDay: 26 });
  // weighted: day 20 level = 400 - 200 - 150 = 50 ; 5 more days -> 0 on day 25 (before day 30) ; 25 - 14 = 11
  assert.deepEqual(out.weighted, { stockoutDay: 25, orderByDay: 11 });
  // allClose: day 20 level = 400 - 200 - 300 = -100 -> day 20 ; 20 - 14 = 6
  assert.deepEqual(out.allClose, { stockoutDay: 20, orderByDay: 6 });
});

test('worked example via the weekly path is conservative: never later than the deal-level answer', () => {
  // A ships Wed 2026-01-21 -> week 2026-01-19 = day 18. B ships Sat 2026-01-31 -> week 2026-01-26 = day 25.
  const weeks = pipelineDemandByWeek(pipelineArgs).get('SKU-X');
  assert.deepEqual(weeks, [
    { weekStart: '2026-01-19', weightedQty: 150, rawQty: 300, openDealCount: 1 },
    { weekStart: '2026-01-26', weightedQty: 40, rawQty: 200, openDealCount: 1 },
  ]);
  const shipments = weeksToShipments(weeks, '2026-01-01');
  assert.deepEqual(shipments.map((s) => s.day), [18, 25]);
  const out = scenarioSet({ ...common, shipments });
  // retailOnly unchanged: 40
  assert.equal(out.retailOnly.stockoutDay, 40);
  // weighted: day 18 level = 400 - 180 - 150 = 70 ; day 25: 70 - 70 - 40 = -40 -> day 25
  assert.equal(out.weighted.stockoutDay, 25);
  // allClose: day 18 level = 400 - 180 - 300 = -80 -> day 18
  assert.equal(out.allClose.stockoutDay, 18);
  assert.ok(out.weighted.stockoutDay <= 25 && out.allClose.stockoutDay <= 20);
});
