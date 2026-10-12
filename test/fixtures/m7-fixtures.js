// Fixtures for the M7 tests (cache, key rotation, policy text, routes, two-shop database test).
// No network. Keys and secrets are generated in memory per run and never written anywhere.

import { randomBytes } from 'node:crypto';
import { encryptSecret } from '../../app/lib/pipeline/credentials-crypto.server.js';
import { createM6Prisma } from './m6-fixtures.js';

export const makeKey = () => randomBytes(32).toString('hex');
export const makeCronSecret = () => randomBytes(16).toString('hex'); // 32 chars

/** Manual clock for the TTL cache: { now, set(ms), advance(ms) }. */
export function createClock(start = 0) {
  let t = start;
  return { now: () => t, set: (ms) => { t = ms; }, advance: (ms) => { t += ms; } };
}

/** A promise you resolve or reject from the outside. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let queued microtasks and timers run. */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Stored connection rows for the shops, encrypted with `key`. Plaintexts are distinctive per shop
 * so a leak check cannot match by accident.
 * @returns {{ rows: Array<{shop, clientIdEnc, clientSecretEnc}>, plain: Record<string, {id: string, secret: string}> }}
 */
export function makeRows(key, shops) {
  const plain = {};
  const rows = shops.map((shop, i) => {
    plain[shop] = { id: `M7_ID_${i}_Zk3v9q`, secret: `M7_SECRET_${i}_pL8w2xRt` };
    return {
      shop,
      clientIdEnc: encryptSecret(plain[shop].id, key),
      clientSecretEnc: encryptSecret(plain[shop].secret, key),
    };
  });
  return { rows, plain };
}

/** Fake Prisma whose connection read returns `rows`; writes come back as descriptors. */
export function rotationPrisma(rows, extra = {}) {
  const { results = {}, ...rest } = extra;
  return createM6Prisma({ results: { 'salesforceConnection.findMany': () => rows, ...results }, ...rest });
}

/** Number of delegate calls (excluding the $transaction marker) plus transactions. */
export const callCount = (prisma) => prisma.calls.length;

/** ISO date `n` days after `iso`. */
export function plusDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Salesforce-shaped open deal (stage, probability, close date, [code, quantity] items). */
export function deal(id, stageName, probability, closeDate, items) {
  return {
    Id: id,
    StageName: stageName,
    Probability: probability,
    CloseDate: closeDate,
    OpportunityLineItems: { done: true, records: items.map(([ProductCode, Quantity]) => ({ ProductCode, Quantity })) },
  };
}

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => structuredClone(body),
  text: async () => JSON.stringify(body),
});

/**
 * One fake fetch for several Salesforce orgs, answering by request host.
 *  hosts: { [host]: { deals: [...], tokenFails?: boolean } }
 * Token endpoint -> { access_token, instance_url: same host } (or 400 invalid_client when tokenFails);
 * anything else -> a one-page query result with that host's deals. `calls` records every URL.
 * `hosts[host].tokenFails` is read on each call, so a test can flip it mid-run.
 */
export function hostFetch(hosts) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    calls.push(String(url));
    const cfg = hosts[u.host];
    if (!cfg) throw new Error(`unexpected host ${u.host}`);
    if (u.pathname.includes('/services/oauth2/token')) {
      if (cfg.tokenFails) return json(400, { error: 'invalid_client', error_description: 'no' });
      return json(200, { access_token: 't', instance_url: `https://${u.host}`, token_type: 'Bearer' });
    }
    return json(200, { totalSize: cfg.deals.length, done: true, records: cfg.deals });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Fake Shopify admin that answers every variant-SKU query with the same single page. */
export function skuAdmin(skus) {
  return {
    async graphql() {
      return {
        async json() {
          return {
            data: {
              productVariants: {
                nodes: skus.map((sku) => ({ sku })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        },
      };
    },
  };
}
