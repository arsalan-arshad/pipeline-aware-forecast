/**
 * Fixtures for the pipeline sync tests: a recording in-memory store whose methods can be scripted
 * to reject, a recording client, and small opportunity builders. Aggregates only.
 */

export function makeStore({ failSuccess = null, failFailure = null } = {}) {
  const calls = { success: [], failure: [] };
  return {
    calls,
    async recordSyncSuccess(arg) {
      calls.success.push(arg);
      if (failSuccess) throw failSuccess;
    },
    async recordSyncFailure(arg) {
      calls.failure.push(arg);
      if (failFailure) throw failFailure;
    },
  };
}

export function makeClient(opts = {}) {
  const { opportunities = [] } = opts;
  const rejects = Object.hasOwn(opts, 'reject');
  const calls = [];
  return {
    calls,
    async fetchOpenOpportunities(arg) {
      calls.push(arg);
      if (rejects) throw opts.reject;
      return opportunities;
    },
  };
}

export function makeSkuSource(opts = {}) {
  const { skus = [] } = opts;
  const rejects = Object.hasOwn(opts, 'reject');
  const fn = async () => {
    fn.calls += 1;
    if (rejects) throw opts.reject;
    return skus;
  };
  fn.calls = 0;
  return fn;
}

export function opp(id, stageName, probability, closeDate, lineItems) {
  return { id, stageName, probability, closeDate, lineItems };
}

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const NOW = new Date('2026-01-01T12:00:00.000Z');
export const TODAY = '2026-01-01';

export function baseArgs(overrides = {}) {
  return {
    shop: 'demo-shop.myshopify.com',
    client: makeClient(),
    store: makeStore(),
    getShopifySkus: makeSkuSource({ skus: ['SKU-X'] }),
    today: TODAY,
    now: NOW,
    ...overrides,
  };
}
