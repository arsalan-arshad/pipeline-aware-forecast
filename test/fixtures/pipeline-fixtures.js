/**
 * Shared test data and helpers. Aggregate-shaped only: opaque ids, stage names,
 * probabilities, close dates, product codes and quantities.
 *
 * Calendar facts used throughout (all UTC, hand-checked):
 *   2026-01-01 is a Thursday = day 0.   2025-12-29 is the ISO Monday on or before it.
 *   2026-01-04 Sunday, 2026-01-05 Monday, 2026-01-11 Sunday, 2026-01-12 Monday.
 *   2026-01-21 = day 20, 2026-01-31 = day 30, 2026-04-01 = day 90, 2026-04-02 = day 91.
 */
import { buildSkuIndex } from '../../app/lib/pipeline/sku-matching.js';

export const TODAY = '2026-01-01';

export function makeOpp(id, closeDate, probability, lineItems, stageName = 'Negotiation') {
  return { id, stageName, probability, closeDate, lineItems };
}

export function line(productCode, quantity) {
  return { productCode, quantity };
}

export function indexFor(skus) {
  return buildSkuIndex(skus).index;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function snapshot(value) {
  return structuredClone(value);
}

/** Shipments Map -> plain object, for readable deepEqual. */
export function mapToObject(map) {
  return Object.fromEntries(map.entries());
}
