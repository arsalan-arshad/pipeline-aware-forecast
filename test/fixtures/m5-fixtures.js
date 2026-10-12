// Fixtures for the connection / sync-shop / forecast-view tests (M5).
// No network, no database. Encryption keys are generated in memory per run, never written anywhere.
// Aggregates only: SKUs, stage names, quantities.

import { randomBytes } from 'node:crypto';
import { encryptSecret } from '../../app/lib/pipeline/credentials-crypto.server.js';
import { createFakeFetch, tokenOk, page, INSTANCE_URL } from './salesforce-fixtures.js';

export { INSTANCE_URL };
export const SHOP = 'demo-shop.myshopify.com';
export const TODAY = '2026-01-01';
export const NOW = new Date('2026-01-01T12:00:00.000Z');

// Fake credentials with distinctive text so leak checks cannot match by accident.
export const CLIENT_ID = 'M5_FAKE_CLIENT_ID_q7w2e9';
export const CLIENT_SECRET = 'M5_FAKE_SECRET_r4t8y1uPLM';

export const makeKey = () => randomBytes(32).toString('hex');

/** A stored connection row, encrypted the way saveSalesforceConnection must store it. */
export function storedConnection(key, over = {}) {
  return {
    shop: SHOP,
    instanceUrl: INSTANCE_URL,
    authMode: 'client_credentials',
    clientIdEnc: encryptSecret(CLIENT_ID, key),
    clientSecretEnc: encryptSecret(CLIENT_SECRET, key),
    lastSyncAt: null,
    lastErrorClass: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    ...over,
  };
}

/**
 * Fake Prisma with scripted reads.
 *  - Reads (salesforceConnection.findUnique, pipelineSetting.findUnique,
 *    stageProbabilityOverride.findMany) resolve to the configured values.
 *  - Any other delegate method returns a plain descriptor { model, method, args } (so it can be
 *    put into a $transaction array and inspected).
 *  - failOn: { 'model.method': Error } makes that call return a rejected promise.
 *  - $transaction requires an array; it is recorded in `transactions` and resolves to the array.
 * Every delegate call and every $transaction is appended to `calls` in order.
 */
export function createM5Prisma({ connection = null, setting = null, overrides = [], failOn = {}, transactionError } = {}) {
  const calls = [];
  const transactions = [];
  const reads = {
    'salesforceConnection.findUnique': () => connection,
    'pipelineSetting.findUnique': () => setting,
    'stageProbabilityOverride.findMany': () => overrides,
  };
  const base = {
    calls,
    transactions,
    callsOf(model, method) {
      return calls.filter((c) => c.model === model && c.method === method);
    },
    $transaction(ops) {
      calls.push({ model: '$', method: '$transaction', args: ops });
      if (!Array.isArray(ops)) throw new TypeError('$transaction expects an array');
      transactions.push(ops);
      if (failOn.$transaction) return Promise.reject(failOn.$transaction);
      if (transactionError) return Promise.reject(transactionError);
      return Promise.resolve(ops);
    },
  };
  const delegates = new Map();
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (!delegates.has(prop)) {
        delegates.set(prop, new Proxy({}, {
          get(_d, method) {
            if (typeof method !== 'string' || method === 'then') return undefined;
            return (args) => {
              calls.push({ model: prop, method, args });
              const key = `${prop}.${method}`;
              if (failOn[key]) return Promise.reject(failOn[key]);
              if (key in reads) return Promise.resolve(reads[key]());
              return { model: prop, method, args };
            };
          },
        }));
      }
      return delegates.get(prop);
    },
  });
}

/** Salesforce-shaped open deal with the fields the client copies (no extras needed). */
export function sfDeal(id, stageName, probability, closeDate, items) {
  return {
    Id: id,
    StageName: stageName,
    Probability: probability,
    CloseDate: closeDate,
    OpportunityLineItems: {
      done: true,
      records: items.map(([ProductCode, Quantity]) => ({ ProductCode, Quantity })),
    },
  };
}

/** Fake fetch: token endpoint answers with a token, everything else with one query page. */
export function salesforceFetch(records) {
  return createFakeFetch((call) => (call.url.includes('/services/oauth2/token') ? tokenOk(INSTANCE_URL) : page(records)));
}

// README worked example, deal level: today 2026-01-01, shipOffsetDays 0.
//   Deal A: 300 of SKU-X at stage 'Value Proposition', probability 50, closes 2026-01-21 (day 20, Wed)
//           -> ISO Monday 2026-01-19, weighted 150
//   Deal B: 200 of SKU-X at stage 'Negotiation', probability 20, closes 2026-01-31 (day 30, Sat)
//           -> ISO Monday 2026-01-26, weighted 40
//   Deal C: 5 of NOPE-1 (not a Shopify SKU) -> unmatched
export function workedExampleDeals() {
  return [
    sfDeal('d-a', 'Value Proposition', 50, '2026-01-21', [['SKU-X', 300]]),
    sfDeal('d-b', 'Negotiation', 20, '2026-01-31', [['SKU-X', 200]]),
    sfDeal('d-c', 'Negotiation', 40, '2026-01-21', [['NOPE-1', 5]]),
  ];
}

export function variantsBody(skus) {
  return {
    data: {
      productVariants: {
        nodes: skus.map((sku) => ({ sku })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

export const THROTTLED_BODY = { errors: [{ extensions: { code: 'THROTTLED' } }] };

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze(value[k]);
  }
  return value;
}
