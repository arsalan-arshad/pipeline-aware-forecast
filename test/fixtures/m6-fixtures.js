// Fixtures for the M6 tests (settings, sync lock, scheduler, shop registry, feedback).
// No network, no database. Shop domains and counts only.

import { storedConnection, salesforceFetch, variantsBody, makeKey, SHOP, TODAY, NOW } from './m5-fixtures.js';
import { createFakeAdmin } from './shell-fixtures.js';

export { SHOP, TODAY, NOW, makeKey, storedConnection, salesforceFetch, variantsBody, createFakeAdmin };

export const HOUR = 3600000;

const READS = { findUnique: () => null, findFirst: () => null, findMany: () => [], count: () => 0 };

/** Error shaped like a Prisma unique-constraint violation. */
export const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

/**
 * Scriptable fake Prisma.
 *  - Every delegate call is appended to `calls` as { model, method, args } IN ORDER, whether it is made
 *    directly or built for a $transaction array (calling the delegate is what records it).
 *  - results: { 'model.method': value | (args) => value }. A function may throw (sync) to simulate a
 *    rejection; the result is always returned as a promise.
 *  - failOn: { 'model.method': Error } rejects that call.
 *  - Defaults: findUnique/findFirst -> null, findMany -> [], count -> 0 (promises). Every write
 *    (create, update, upsert, createMany, updateMany, deleteMany) returns a plain descriptor
 *    { model, method, args } unless scripted, so tests that need updateMany to report { count } set it.
 *  - $transaction requires an array and is recorded in `transactions`; its ops were already recorded
 *    in `calls` when they were built, and the $transaction marker follows them.
 */
export function createM6Prisma({ results = {}, failOn = {}, transactionError } = {}) {
  const calls = [];
  const transactions = [];
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
              try {
                if (key in results) {
                  const r = results[key];
                  return Promise.resolve(typeof r === 'function' ? r(args) : r);
                }
                if (method in READS) return Promise.resolve(READS[method]());
                // Writes return a plain descriptor so they can sit in a $transaction array and be inspected.
                return { model: prop, method, args };
              } catch (err) {
                return Promise.reject(err);
              }
            };
          },
        }));
      }
      return delegates.get(prop);
    },
  });
}

/** Date `ms` before NOW. */
export const before = (ms) => new Date(NOW.getTime() - ms);

/**
 * Environment for runDueSyncs: connection rows (as the scheduler's narrow select returns them),
 * a lock that can be held for chosen shops, per-shop Shopify admins, and a Salesforce fetch
 * that answers every shop with no open deals.
 *
 * rows: [{ shop, lastSyncAt, lastErrorAt }]
 * busyShops: shops whose lock create throws P2002 and whose takeover updateMany reports count 0.
 * adminFor: { [shop]: admin | Error } overrides; default is an admin with one variant page.
 */
export function schedulerEnv({ rows, busyShops = [], adminFor = {}, getAdminThrows = [], failOn = {} } = {}) {
  const key = makeKey();
  const events = [];
  const prisma = createM6Prisma({
    failOn,
    results: {
      'salesforceConnection.findMany': () => rows,
      'salesforceConnection.findUnique': (a) => storedConnection(key, { shop: a.where.shop }),
      'syncLock.create': (a) => {
        events.push(`lock:${a.data.shop}`);
        if (busyShops.includes(a.data.shop)) throw p2002();
        return a.data;
      },
      'syncLock.updateMany': () => ({ count: 0 }),
      'syncLock.deleteMany': (a) => {
        events.push(`release:${a.where.shop}`);
        return { count: 1 };
      },
    },
  });
  const fetchImpl = salesforceFetch([]);
  const adminCalls = [];
  const getAdmin = async (shop) => {
    events.push(`admin:${shop}`);
    adminCalls.push(shop);
    if (getAdminThrows.includes(shop)) throw new Error('offline token missing');
    const custom = adminFor[shop];
    if (custom instanceof Error) throw custom;
    return custom ?? createFakeAdmin([variantsBody(['SKU-X'])]);
  };
  // sleep is a no-op so Shopify throttling retries never wait for real seconds.
  const args = { prisma, now: NOW, today: TODAY, getAdmin, encryptionKey: key, fetchImpl, sleep: async () => {} };
  return { key, prisma, events, adminCalls, fetchImpl, getAdmin, args };
}
