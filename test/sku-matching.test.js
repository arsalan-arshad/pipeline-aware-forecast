import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSku,
  buildSkuIndex,
  resolveSku,
  summarizeUnmatched,
} from '../app/lib/pipeline/sku-matching.js';
import { makeOpp, line, deepFreeze, snapshot } from './fixtures/pipeline-fixtures.js';

test('normalizeSku trims, collapses inner whitespace and lowercases', () => {
  assert.equal(normalizeSku('  Sku   X  '), 'sku x');
  assert.equal(normalizeSku('a\t\n b'), 'a b');
  assert.equal(normalizeSku('SKU-X'), 'sku-x');
});

test('normalizeSku maps null, undefined and blank to empty string', () => {
  assert.equal(normalizeSku(null), '');
  assert.equal(normalizeSku(undefined), '');
  assert.equal(normalizeSku(''), '');
  assert.equal(normalizeSku('   '), '');
});

test('normalizeSku stringifies non-strings', () => {
  assert.equal(normalizeSku(42), '42');
});

test('buildSkuIndex maps normalized -> original Shopify SKU', () => {
  const { index, collisions } = buildSkuIndex(['SKU-X', 'Sku Y']);
  assert.equal(index.get('sku-x'), 'SKU-X');
  assert.equal(index.get('sku y'), 'Sku Y');
  assert.equal(index.size, 2);
  assert.deepEqual(collisions, []);
});

test('buildSkuIndex skips blank, empty and null skus', () => {
  const { index, collisions } = buildSkuIndex(['', '   ', null, undefined, 'B']);
  assert.equal(index.size, 1);
  assert.equal(index.get('b'), 'B');
  assert.deepEqual(collisions, []);
});

test('buildSkuIndex reports a collision, first SKU wins, nothing merged silently', () => {
  const { index, collisions } = buildSkuIndex(['SKU-X', 'Sku-x', 'B']);
  assert.equal(index.get('sku-x'), 'SKU-X');
  assert.equal(index.size, 2);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].normalized, 'sku-x');
  assert.deepEqual(collisions[0].skus, ['SKU-X', 'Sku-x']);
});

test('buildSkuIndex with an empty list gives an empty index', () => {
  const { index, collisions } = buildSkuIndex([]);
  assert.equal(index.size, 0);
  assert.deepEqual(collisions, []);
});

test('resolveSku matches case/whitespace variants to the Shopify spelling', () => {
  const { index } = buildSkuIndex(['Sku X']);
  assert.equal(resolveSku('sku x', index), 'Sku X');
  assert.equal(resolveSku('  SKU    X ', index), 'Sku X');
});

test('resolveSku returns null for unknown, blank, null and near-miss codes (no fuzzy)', () => {
  const { index } = buildSkuIndex(['SKU-X']);
  assert.equal(resolveSku('SKU-Y', index), null);
  assert.equal(resolveSku('SKU-', index), null);
  assert.equal(resolveSku('SKUX', index), null);
  assert.equal(resolveSku('', index), null);
  assert.equal(resolveSku(null, index), null);
  assert.equal(resolveSku(undefined, index), null);
});

// Opportunities used for summarizeUnmatched. Index only knows SKU-X.
//  o1: ZZ-1 qty 10 and zz-1 qty 5 in one deal -> counts as 1 deal, raw 15
//  o2: ' ZZ-1' qty 7                          -> 2nd deal, raw 22 total
//  o3: AA-9 qty 3 (unmatched) and SKU-X qty 100 (matched, must not appear)
//  o4: blank '' qty 4 and '  ' qty 6          -> one blank row, 1 deal, raw 10
//  o5: QQ with qty 0, -5, NaN, Infinity       -> all ignored, no row at all
const unmatchedFixture = () => [
  makeOpp('o1', '2026-01-10', 50, [line('ZZ-1', 10), line('zz-1', 5)]),
  makeOpp('o2', '2026-01-11', 50, [line(' ZZ-1', 7)]),
  makeOpp('o3', '2026-01-12', 50, [line('AA-9', 3), line('SKU-X', 100)]),
  makeOpp('o4', '2026-01-13', 50, [line('', 4), line('  ', 6)]),
  makeOpp('o5', '2026-01-14', 50, [line('QQ', 0), line('QQ', -5), line('QQ', NaN), line('QQ', Infinity)]),
];

test('summarizeUnmatched: sorted rows, first spelling, distinct deal count, summed raw qty, blank reported as empty code', () => {
  const { index } = buildSkuIndex(['SKU-X']);
  const out = summarizeUnmatched(unmatchedFixture(), index);
  // sort key is the normalised code: '' < 'aa-9' < 'zz-1'
  assert.deepEqual(out, [
    { productCode: '', openDealCount: 1, rawQty: 10 },
    { productCode: 'AA-9', openDealCount: 1, rawQty: 3 },
    { productCode: 'ZZ-1', openDealCount: 2, rawQty: 22 },
  ]);
});

test('summarizeUnmatched ignores non-positive and non-finite quantities (no row created)', () => {
  const { index } = buildSkuIndex(['SKU-X']);
  const out = summarizeUnmatched(unmatchedFixture(), index);
  assert.equal(out.some((r) => r.productCode === 'QQ'), false);
});

test('summarizeUnmatched does not list matched codes, including case variants', () => {
  const { index } = buildSkuIndex(['SKU-X']);
  const out = summarizeUnmatched(
    [makeOpp('a', '2026-01-10', 50, [line(' sku-x ', 5), line('SKU-X', 5)])],
    index,
  );
  assert.deepEqual(out, []);
});

test('summarizeUnmatched on no opportunities returns an empty list', () => {
  const { index } = buildSkuIndex(['SKU-X']);
  assert.deepEqual(summarizeUnmatched([], index), []);
});

test('sku-matching is deterministic and does not mutate frozen inputs', () => {
  const opps = deepFreeze(unmatchedFixture());
  const before = snapshot(opps);
  const skus = deepFreeze(['SKU-X', 'Sku-x']);
  const a = buildSkuIndex(skus);
  const b = buildSkuIndex(skus);
  assert.deepEqual(a, b);
  const r1 = summarizeUnmatched(opps, a.index);
  const r2 = summarizeUnmatched(opps, a.index);
  assert.deepEqual(r1, r2);
  assert.deepEqual(opps, before);
});
