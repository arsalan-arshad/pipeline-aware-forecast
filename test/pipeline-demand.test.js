import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveProbability,
  pipelineShipments,
  pipelineDemandByWeek,
  weeksToShipments,
} from '../app/lib/pipeline/pipeline-demand.js';
import {
  TODAY,
  makeOpp,
  line,
  indexFor,
  deepFreeze,
  snapshot,
  mapToObject,
} from './fixtures/pipeline-fixtures.js';

const skuIndex = indexFor(['SKU-X', 'SKU-Y']);

function run(opportunities, extra = {}) {
  return pipelineShipments({
    opportunities,
    today: TODAY,
    horizonDays: 90,
    shipOffsetDays: 0,
    skuIndex,
    ...extra,
  });
}

// ---- effectiveProbability ----------------------------------------------------------

test('effectiveProbability: scales 0-100 to 0-1 and multiplies by haircut', () => {
  assert.equal(effectiveProbability(50, 'Negotiation', {}, 1), 0.5);
  assert.equal(effectiveProbability(50, 'Negotiation', {}, 0.5), 0.25);
});

test('effectiveProbability: probability 0 gives 0 and probability 100 gives 1', () => {
  assert.equal(effectiveProbability(0, 'Negotiation', {}, 1), 0);
  assert.equal(effectiveProbability(100, 'Negotiation', {}, 1), 1);
});

test('effectiveProbability: haircut 0 gives 0', () => {
  assert.equal(effectiveProbability(100, 'Negotiation', {}, 0), 0);
});

test('effectiveProbability: out-of-range inputs are clamped', () => {
  assert.equal(effectiveProbability(150, 'N', {}, 1), 1);
  assert.equal(effectiveProbability(-10, 'N', {}, 1), 0);
  assert.equal(effectiveProbability(50, 'N', {}, 2), 0.5); // haircut clamped to 1
  assert.equal(effectiveProbability(50, 'N', {}, -1), 0); // haircut clamped to 0
});

test('effectiveProbability: stage override replaces the probability (same 0-100 scale)', () => {
  assert.equal(effectiveProbability(50, 'Proposal', { Proposal: 80 }, 1), 0.8);
  assert.equal(effectiveProbability(50, 'Other', { Proposal: 80 }, 1), 0.5);
});

test('effectiveProbability: an override of 0 is honoured (not treated as missing)', () => {
  assert.equal(effectiveProbability(50, 'Proposal', { Proposal: 0 }, 1), 0);
});

test('effectiveProbability: override is clamped to 0-100 too', () => {
  assert.equal(effectiveProbability(10, 'P', { P: 250 }, 1), 1);
});

// ---- pipelineShipments edge cases ---------------------------------------------------

test('no open deals -> empty Map (empty array, undefined opportunities)', () => {
  assert.equal(run([]).size, 0);
  assert.equal(run(undefined).size, 0);
});

test('deal beyond horizon is excluded; the horizon day itself is included', () => {
  // 2026-04-01 = day 90 (Jan 31 + Feb 28 + Mar 31 = 90) -> included. 2026-04-02 = day 91 -> excluded.
  const out = run([
    makeOpp('a', '2026-04-01', 100, [line('SKU-X', 10)]),
    makeOpp('b', '2026-04-02', 100, [line('SKU-X', 20)]),
  ]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 90, weightedQty: 10, rawQty: 10, openDealCount: 1 }]);
});

test('horizon applies after shipOffsetDays: close day 83 + 7 = 90 in, day 84 + 7 = 91 out', () => {
  // 2026-03-25 = day 83, 2026-03-26 = day 84
  const out = run(
    [
      makeOpp('a', '2026-03-25', 100, [line('SKU-X', 10)]),
      makeOpp('b', '2026-03-26', 100, [line('SKU-X', 20)]),
    ],
    { shipOffsetDays: 7 },
  );
  assert.deepEqual(out.get('SKU-X'), [{ day: 90, weightedQty: 10, rawQty: 10, openDealCount: 1 }]);
});

test('a deal entirely beyond horizon leaves no key for its SKU', () => {
  const out = run([makeOpp('a', '2027-01-01', 100, [line('SKU-X', 10)])]);
  assert.equal(out.size, 0);
});

test('probability 0: still contributes raw qty and deal count, weighted 0', () => {
  const out = run([makeOpp('a', '2026-01-11', 0, [line('SKU-X', 100)])]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 0, rawQty: 100, openDealCount: 1 }]);
});

test('probability 100: weighted equals raw', () => {
  const out = run([makeOpp('a', '2026-01-11', 100, [line('SKU-X', 100)])]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 100, rawQty: 100, openDealCount: 1 }]);
});

test('haircut 0: weighted 0, raw preserved', () => {
  const out = run([makeOpp('a', '2026-01-11', 50, [line('SKU-X', 100)])], { haircut: 0 });
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 0, rawQty: 100, openDealCount: 1 }]);
});

test('haircut 0.5 halves the weighted qty: 100 * 0.5 * 0.5 = 25', () => {
  const out = run([makeOpp('a', '2026-01-11', 50, [line('SKU-X', 100)])], { haircut: 0.5 });
  assert.equal(out.get('SKU-X')[0].weightedQty, 25);
  assert.equal(out.get('SKU-X')[0].rawQty, 100);
});

test('stage override replaces the CRM probability only for that stage', () => {
  // Proposal prob 20 overridden to 90 -> 100 * 0.9 = 90. Negotiation stays 20 -> 100 * 0.2 = 20.
  const out = run(
    [
      makeOpp('a', '2026-01-11', 20, [line('SKU-X', 100)], 'Proposal'),
      makeOpp('b', '2026-01-21', 20, [line('SKU-X', 100)], 'Negotiation'),
    ],
    { stageOverrides: { Proposal: 90 } },
  );
  assert.deepEqual(out.get('SKU-X'), [
    { day: 10, weightedQty: 90, rawQty: 100, openDealCount: 1 },
    { day: 20, weightedQty: 20, rawQty: 100, openDealCount: 1 },
  ]);
});

test('overdue deal clamps to day 0 and is still counted', () => {
  // close 2025-12-20 = day -12, offset 0 -> clamped to 0
  const out = run([makeOpp('a', '2025-12-20', 50, [line('SKU-X', 100)])]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 0, weightedQty: 50, rawQty: 100, openDealCount: 1 }]);
});

test('overdue deal still clamps after a positive offset when the sum stays negative', () => {
  // close 2025-12-01 = day -31, +7 = -24 -> 0
  const out = run([makeOpp('a', '2025-12-01', 50, [line('SKU-X', 100)])], { shipOffsetDays: 7 });
  assert.equal(out.get('SKU-X')[0].day, 0);
});

test('slightly overdue deal that the offset rescues is NOT clamped', () => {
  // close 2025-12-28 = day -4, +7 = 3
  const out = run([makeOpp('a', '2025-12-28', 100, [line('SKU-X', 10)])], { shipOffsetDays: 7 });
  assert.equal(out.get('SKU-X')[0].day, 3);
});

test('shipOffsetDays shifts the ship day; default offset is 7', () => {
  const opp = [makeOpp('a', '2026-01-11', 100, [line('SKU-X', 10)])]; // day 10
  assert.equal(run(opp, { shipOffsetDays: 0 }).get('SKU-X')[0].day, 10);
  assert.equal(run(opp, { shipOffsetDays: 7 }).get('SKU-X')[0].day, 17);
  assert.equal(run(opp, { shipOffsetDays: 14 }).get('SKU-X')[0].day, 24);
  const withDefault = pipelineShipments({ opportunities: opp, today: TODAY, horizonDays: 90, skuIndex });
  assert.equal(withDefault.get('SKU-X')[0].day, 17);
});

test('same-day entries from different deals are summed, deal count is 2', () => {
  // 100 * 0.5 + 40 * 0.25 = 50 + 10 = 60 ; raw 140
  const out = run([
    makeOpp('a', '2026-01-11', 50, [line('SKU-X', 100)]),
    makeOpp('b', '2026-01-11', 25, [line('SKU-X', 40)]),
  ]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 60, rawQty: 140, openDealCount: 2 }]);
});

test('two overdue deals on different original dates both land on day 0 and sum', () => {
  const out = run([
    makeOpp('a', '2025-12-20', 100, [line('SKU-X', 10)]),
    makeOpp('b', '2025-12-25', 100, [line('SKU-X', 5)]),
  ]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 0, weightedQty: 15, rawQty: 15, openDealCount: 2 }]);
});

test('several line items for one SKU in one deal sum and count the deal once', () => {
  // (100 + 50) * 0.5 = 75
  const out = run([makeOpp('a', '2026-01-11', 50, [line('SKU-X', 100), line('SKU-X', 50)])]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 75, rawQty: 150, openDealCount: 1 }]);
});

test('many Salesforce codes resolving to one Shopify SKU are summed under that SKU', () => {
  const out = run([
    makeOpp('a', '2026-01-11', 100, [line('sku-x', 10)]),
    makeOpp('b', '2026-01-11', 100, [line(' SKU-X ', 20), line('Sku-X', 30)]),
  ]);
  assert.equal(out.size, 1);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 60, rawQty: 60, openDealCount: 2 }]);
});

test('case/whitespace-variant codes match and the Map key is the Shopify spelling', () => {
  const idx = indexFor(['Sku X']);
  const out = run([makeOpp('a', '2026-01-11', 100, [line('  sku    x ', 5)])], { skuIndex: idx });
  assert.deepEqual([...out.keys()], ['Sku X']);
});

test('different SKUs are kept apart', () => {
  const out = run([makeOpp('a', '2026-01-11', 100, [line('SKU-X', 5), line('SKU-Y', 7)])]);
  assert.equal(out.get('SKU-X')[0].rawQty, 5);
  assert.equal(out.get('SKU-Y')[0].rawQty, 7);
});

test('unmatched code is skipped and has zero effect on any number', () => {
  const base = [makeOpp('a', '2026-01-11', 50, [line('SKU-X', 100)])];
  const withNoise = [
    makeOpp('a', '2026-01-11', 50, [line('SKU-X', 100), line('NOPE-1', 9999)]),
    makeOpp('z', '2026-01-11', 100, [line('NOPE-2', 5000)]),
  ];
  assert.deepEqual(mapToObject(run(withNoise)), mapToObject(run(base)));
  assert.equal(run(withNoise).size, 1);
});

test('SKU-index collision: the clashing Shopify SKU that lost never appears', () => {
  const idx = indexFor(['SKU-X', 'Sku-x']); // first wins
  const out = run([makeOpp('a', '2026-01-11', 100, [line('sku-x', 5)])], { skuIndex: idx });
  assert.deepEqual([...out.keys()], ['SKU-X']);
});

test('blank productCode is skipped without throwing', () => {
  const out = run([makeOpp('a', '2026-01-11', 100, [line('', 5), line('   ', 5), line(null, 5), line('SKU-X', 1)])]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 1, rawQty: 1, openDealCount: 1 }]);
});

test('non-positive and non-finite quantities are ignored', () => {
  const out = run([
    makeOpp('a', '2026-01-11', 100, [
      line('SKU-X', 0), line('SKU-X', -5), line('SKU-X', NaN), line('SKU-X', Infinity),
      line('SKU-X', -Infinity), line('SKU-X', 10),
    ]),
  ]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 10, rawQty: 10, openDealCount: 1 }]);
});

test('a deal whose only quantities are invalid does not count as a deal', () => {
  const out = run([makeOpp('a', '2026-01-11', 100, [line('SKU-X', 0), line('SKU-X', NaN)])]);
  assert.equal(out.size, 0);
});

test('invalid closeDate is skipped without throwing; valid deals still count', () => {
  const out = run([
    makeOpp('a', 'not-a-date', 100, [line('SKU-X', 1)]),
    makeOpp('b', '', 100, [line('SKU-X', 2)]),
    makeOpp('c', undefined, 100, [line('SKU-X', 4)]),
    makeOpp('d', null, 100, [line('SKU-X', 8)]),
    makeOpp('e', '2026-13-45', 100, [line('SKU-X', 16)]),
    makeOpp('f', '2026-01-11', 100, [line('SKU-X', 32)]),
  ]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 32, rawQty: 32, openDealCount: 1 }]);
});

test('output is sorted by day ascending regardless of input order', () => {
  const out = run([
    makeOpp('c', '2026-01-31', 100, [line('SKU-X', 3)]),
    makeOpp('a', '2026-01-11', 100, [line('SKU-X', 1)]),
    makeOpp('b', '2026-01-21', 100, [line('SKU-X', 2)]),
  ]);
  assert.deepEqual(out.get('SKU-X').map((s) => s.day), [10, 20, 30]);
});

test('weighted quantity is rounded to 2 decimals', () => {
  // 7 * 0.33 = 2.31 ; 10 * 0.01234 = 0.1234 -> 0.12
  const a = run([makeOpp('a', '2026-01-11', 33, [line('SKU-X', 7)])]);
  assert.equal(a.get('SKU-X')[0].weightedQty, 2.31);
  const b = run([makeOpp('a', '2026-01-11', 1.234, [line('SKU-X', 10)])]);
  assert.equal(b.get('SKU-X')[0].weightedQty, 0.12);
});

test('output never leaks the opaque opportunity id', () => {
  const out = run([makeOpp('opaque-id-zq81', '2026-01-11', 100, [line('SKU-X', 1)])]);
  assert.equal(JSON.stringify(mapToObject(out)).includes('opaque-id-zq81'), false);
  const weeks = pipelineDemandByWeek({
    opportunities: [makeOpp('opaque-id-zq81', '2026-01-11', 100, [line('SKU-X', 1)])],
    today: TODAY, horizonDays: 90, shipOffsetDays: 0, skuIndex,
  });
  assert.equal(JSON.stringify(mapToObject(weeks)).includes('opaque-id-zq81'), false);
});

test('determinism: same input twice gives equal output and frozen input is not mutated', () => {
  const opps = deepFreeze([
    makeOpp('a', '2026-01-11', 50, [line('SKU-X', 100), line(' sku-x', 5)]),
    makeOpp('b', '2025-12-20', 20, [line('SKU-Y', 40)]),
    makeOpp('c', '2026-01-21', 20, [line('NOPE', 40)], 'Proposal'),
  ]);
  const overrides = deepFreeze({ Proposal: 90 });
  const before = snapshot(opps);
  const args = { opportunities: opps, stageOverrides: overrides, haircut: 0.8, shipOffsetDays: 3, today: TODAY, horizonDays: 90, skuIndex };
  const r1 = pipelineShipments(args);
  const r2 = pipelineShipments(args);
  assert.deepEqual(r1, r2);
  assert.deepEqual(pipelineDemandByWeek(args), pipelineDemandByWeek(args));
  assert.deepEqual(opps, before);
});

// ---- pipelineDemandByWeek -----------------------------------------------------------

function weeks(opportunities, extra = {}) {
  return pipelineDemandByWeek({
    opportunities, today: TODAY, horizonDays: 90, shipOffsetDays: 0, skuIndex, ...extra,
  });
}

test('ISO-Monday boundaries: Sunday belongs to the previous Monday, Monday starts a new week', () => {
  // 2026-01-04 Sun -> 2025-12-29 ; 2026-01-05 Mon -> 2026-01-05 ; 2026-01-11 Sun -> 2026-01-05 ; 2026-01-12 Mon -> 2026-01-12
  const cases = [
    ['2026-01-04', '2025-12-29'],
    ['2026-01-05', '2026-01-05'],
    ['2026-01-11', '2026-01-05'],
    ['2026-01-12', '2026-01-12'],
  ];
  for (const [close, monday] of cases) {
    const out = weeks([makeOpp('a', close, 100, [line('SKU-X', 1)])]);
    assert.deepEqual(out.get('SKU-X').map((w) => w.weekStart), [monday], `close ${close}`);
  }
});

test('ship date uses shipOffsetDays before bucketing into a week', () => {
  // close 2026-01-01 (Thu) + 7 = 2026-01-08 (Thu) -> Monday 2026-01-05
  const out = weeks([makeOpp('a', '2026-01-01', 100, [line('SKU-X', 1)])], { shipOffsetDays: 7 });
  assert.equal(out.get('SKU-X')[0].weekStart, '2026-01-05');
});

test('weeks sum quantities and count distinct deals per (sku, week), sorted ascending', () => {
  // week 2026-01-05: A (Mon 01-05) 100@50 -> 50, B (Wed 01-07) 50@100 -> 50  => weighted 100, raw 150, 2 deals
  // week 2026-01-12: C (Mon 01-12) 200@10 -> 20 => weighted 20, raw 200, 1 deal
  const out = weeks([
    makeOpp('c', '2026-01-12', 10, [line('SKU-X', 200)]),
    makeOpp('a', '2026-01-05', 50, [line('SKU-X', 100)]),
    makeOpp('b', '2026-01-07', 100, [line('SKU-X', 50)]),
  ]);
  assert.deepEqual(out.get('SKU-X'), [
    { weekStart: '2026-01-05', weightedQty: 100, rawQty: 150, openDealCount: 2 },
    { weekStart: '2026-01-12', weightedQty: 20, rawQty: 200, openDealCount: 1 },
  ]);
});

test('one deal with two lines of the same SKU counts once in its week', () => {
  const out = weeks([makeOpp('a', '2026-01-05', 100, [line('SKU-X', 1), line('sku-x', 2)])]);
  assert.deepEqual(out.get('SKU-X'), [{ weekStart: '2026-01-05', weightedQty: 3, rawQty: 3, openDealCount: 1 }]);
});

test('overdue deal is clamped to day 0 first, so it lands in the week containing today', () => {
  // today 2026-01-01 is in the week starting 2025-12-29
  const out = weeks([makeOpp('a', '2025-12-01', 100, [line('SKU-X', 4)])]);
  assert.deepEqual(out.get('SKU-X'), [{ weekStart: '2025-12-29', weightedQty: 4, rawQty: 4, openDealCount: 1 }]);
});

test('weekly view applies the same horizon rule as shipments', () => {
  const out = weeks([
    makeOpp('a', '2026-04-01', 100, [line('SKU-X', 1)]), // day 90 in
    makeOpp('b', '2026-04-02', 100, [line('SKU-X', 2)]), // day 91 out
  ]);
  assert.equal(out.get('SKU-X').reduce((s, w) => s + w.rawQty, 0), 1);
});

test('weekly view: empty input, unmatched codes and bad dates yield nothing / no throw', () => {
  assert.equal(weeks([]).size, 0);
  assert.equal(weeks(undefined).size, 0);
  assert.equal(weeks([makeOpp('a', 'junk', 100, [line('SKU-X', 1)])]).size, 0);
  assert.equal(weeks([makeOpp('a', '2026-01-05', 100, [line('NOPE', 1)])]).size, 0);
});

test('weekly weighted total equals the shipments weighted total (same rules)', () => {
  const opps = [
    makeOpp('a', '2025-12-20', 30, [line('SKU-X', 10)]),
    makeOpp('b', '2026-01-11', 50, [line('SKU-X', 100)]),
    makeOpp('c', '2026-02-02', 80, [line('SKU-X', 25)]),
    makeOpp('d', '2026-06-01', 80, [line('SKU-X', 25)]), // beyond horizon
  ];
  const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);
  const ships = run(opps).get('SKU-X');
  const wk = weeks(opps).get('SKU-X');
  // 3 + 50 + 20 = 73 ; raw 10 + 100 + 25 = 135
  assert.equal(sum(ships, 'weightedQty'), 73);
  assert.equal(sum(wk, 'weightedQty'), 73);
  assert.equal(sum(ships, 'rawQty'), 135);
  assert.equal(sum(wk, 'rawQty'), 135);
});

// ---- weeksToShipments ---------------------------------------------------------------

test('weeksToShipments places weekly demand at the START of its week', () => {
  // today 2026-01-01; 2026-01-05 is day 4, 2026-01-12 is day 11
  const out = weeksToShipments(
    [
      { weekStart: '2026-01-05', weightedQty: 10, rawQty: 20, openDealCount: 1 },
      { weekStart: '2026-01-12', weightedQty: 3, rawQty: 6, openDealCount: 2 },
    ],
    TODAY,
  );
  assert.deepEqual(out, [
    { day: 4, weightedQty: 10, rawQty: 20, openDealCount: 1 },
    { day: 11, weightedQty: 3, rawQty: 6, openDealCount: 2 },
  ]);
});

test('weeksToShipments clamps the day at 0 when the week started before today', () => {
  // 2025-12-29 is -3 -> 0. Also today 2026-01-07 (Wed), week 2026-01-05 is -2 -> 0.
  const a = weeksToShipments([{ weekStart: '2025-12-29', weightedQty: 5, rawQty: 5, openDealCount: 1 }], TODAY);
  assert.equal(a[0].day, 0);
  const b = weeksToShipments([{ weekStart: '2026-01-05', weightedQty: 5, rawQty: 5, openDealCount: 1 }], '2026-01-07');
  assert.equal(b[0].day, 0);
});

test('weeksToShipments: a week starting exactly today is day 0', () => {
  const out = weeksToShipments([{ weekStart: '2026-01-05', weightedQty: 5, rawQty: 5, openDealCount: 1 }], '2026-01-05');
  assert.equal(out[0].day, 0);
});

test('weeksToShipments sums entries that clamp to the same day and sorts by day', () => {
  // 2025-12-22 (-10) and 2025-12-29 (-3) both -> day 0 : weighted 3+4=7, raw 6+8=14, deals 1+2=3. Then 2026-01-12 = day 11.
  const out = weeksToShipments(
    [
      { weekStart: '2026-01-12', weightedQty: 1, rawQty: 2, openDealCount: 1 },
      { weekStart: '2025-12-29', weightedQty: 4, rawQty: 8, openDealCount: 2 },
      { weekStart: '2025-12-22', weightedQty: 3, rawQty: 6, openDealCount: 1 },
    ],
    TODAY,
  );
  assert.deepEqual(out, [
    { day: 0, weightedQty: 7, rawQty: 14, openDealCount: 3 },
    { day: 11, weightedQty: 1, rawQty: 2, openDealCount: 1 },
  ]);
});

test('weeksToShipments on no weeks returns an empty array', () => {
  assert.deepEqual(weeksToShipments([], TODAY), []);
});

test('weeksToShipments is deterministic and does not mutate frozen input', () => {
  const input = deepFreeze([{ weekStart: '2026-01-05', weightedQty: 10, rawQty: 20, openDealCount: 1 }]);
  const before = snapshot(input);
  assert.deepEqual(weeksToShipments(input, TODAY), weeksToShipments(input, TODAY));
  assert.deepEqual(input, before);
});

// ---- extra branches found after reading the implementation ---------------------------

test('impossible calendar dates (2026-02-30) are skipped rather than rolled over', () => {
  const out = run([
    makeOpp('a', '2026-02-30', 100, [line('SKU-X', 5)]),
    makeOpp('b', '2026-01-11', 100, [line('SKU-X', 1)]),
  ]);
  assert.deepEqual(out.get('SKU-X'), [{ day: 10, weightedQty: 1, rawQty: 1, openDealCount: 1 }]);
});

test('horizonDays 0 keeps only deals shipping on day 0 (including overdue ones)', () => {
  const out = run(
    [
      makeOpp('a', '2025-12-20', 100, [line('SKU-X', 2)]), // overdue -> 0
      makeOpp('b', '2026-01-01', 100, [line('SKU-X', 3)]), // day 0
      makeOpp('c', '2026-01-02', 100, [line('SKU-X', 4)]), // day 1 out
    ],
    { horizonDays: 0 },
  );
  assert.deepEqual(out.get('SKU-X'), [{ day: 0, weightedQty: 5, rawQty: 5, openDealCount: 2 }]);
});

test('an opportunity without lineItems is ignored without throwing', () => {
  const out = run([
    { id: 'x', stageName: 'N', probability: 50, closeDate: '2026-01-11' },
    makeOpp('y', '2026-01-11', 50, []),
  ]);
  assert.equal(out.size, 0);
});

test('null stageOverrides does not throw and falls back to CRM probability', () => {
  const out = run([makeOpp('a', '2026-01-11', 50, [line('SKU-X', 10)])], { stageOverrides: null });
  assert.equal(out.get('SKU-X')[0].weightedQty, 5);
});

test('weeksToShipments skips rows with an invalid weekStart', () => {
  const out = weeksToShipments(
    [
      { weekStart: 'junk', weightedQty: 9, rawQty: 9, openDealCount: 9 },
      { weekStart: '2026-01-05', weightedQty: 1, rawQty: 2, openDealCount: 1 },
    ],
    TODAY,
  );
  assert.deepEqual(out, [{ day: 4, weightedQty: 1, rawQty: 2, openDealCount: 1 }]);
});
