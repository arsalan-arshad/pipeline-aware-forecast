/**
 * Two-shop isolation test against a real Postgres.
 *
 * Skipped unless PAF_TEST_DATABASE_URL is set. It deletes rows for two fixed test shops, so it REFUSES
 * to run unless the URL points at localhost and the database name ends in `_test`.
 *
 *   PAF_TEST_DATABASE_URL=postgresql://localhost:5432/paf_test node --test test/database.multishop.test.js
 *
 * Salesforce and Shopify are faked (no network): one fake fetch answers by request host, one fake
 * admin per shop. The scheduler is given a view of the connection table limited to the two test
 * shops, so rows that other tests may have left behind are never synced or touched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { saveSalesforceConnection } from '../app/lib/connection.server.js';
import { runDueSyncs } from '../app/lib/run-due-syncs.server.js';
import { syncShop } from '../app/lib/sync-shop.server.js';
import { acquireSyncLock, releaseSyncLock } from '../app/lib/sync-lock.server.js';
import { deleteShopData, deleteUninstallData } from '../app/lib/shop-data.server.js';
import { decryptSecret } from '../app/lib/pipeline/credentials-crypto.server.js';
import { deal, hostFetch, makeKey, plusDays, skuAdmin } from './fixtures/m7-fixtures.js';

const url = process.env.PAF_TEST_DATABASE_URL;
const parsed = (() => { try { return new URL(url); } catch { return null; } })();
const safe =
  parsed &&
  ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
  /_test$/.test(parsed.pathname.replace(/^\//, ''));
const skip = !url ? 'set PAF_TEST_DATABASE_URL to run' : safe ? false : 'refused: URL must be localhost and a database ending in _test';

const A = 'paf-multi-a.myshopify.com';
const B = 'paf-multi-b.myshopify.com';
const HOST_A = 'a-org.my.salesforce.com';
const HOST_B = 'b-org.my.salesforce.com';
const KEY = makeKey(); // in memory only
const TODAY = '2026-01-01';
const T0 = new Date('2026-01-01T12:00:00.000Z');
const minutes = (n) => new Date(T0.getTime() + n * 60000);
const hours = (n) => new Date(T0.getTime() + n * 3600000);

const SKUS = { [A]: ['SKU-X'], [B]: ['SKU-Y'] };
const hosts = {
  [HOST_A]: { deals: [deal('opp-a', 'Negotiation/Review', 90, plusDays(TODAY, 5), [['SKU-X', 100]])] },
  [HOST_B]: { deals: [deal('opp-b', 'Proposal', 50, plusDays(TODAY, 9), [['SKU-Y', 50]])] },
};
const fetchImpl = hostFetch(hosts);
const getAdmin = async (shop) => skuAdmin(SKUS[shop]);

let prisma;
let scoped; // same client, but the scheduler only sees the two test connections

const counts = async (shop) => ({
  snapshots: await prisma.pipelineSnapshot.count({ where: { shop } }),
  unmatched: await prisma.unmatchedProduct.count({ where: { shop } }),
  connection: await prisma.salesforceConnection.count({ where: { shop } }),
  sessions: await prisma.session.count({ where: { shop } }),
  locks: await prisma.syncLock.count({ where: { shop } }),
});
const rowsOf = async (shop) =>
  (await prisma.pipelineSnapshot.findMany({ where: { shop }, orderBy: [{ sku: 'asc' }, { weekStart: 'asc' }] })).map((r) => ({
    sku: r.sku,
    weekStart: r.weekStart.toISOString().slice(0, 10),
    weightedQty: r.weightedQty,
    rawQty: r.rawQty,
    openDealCount: r.openDealCount,
  }));
const run = (now) => runDueSyncs({ prisma: scoped, now, today: TODAY, getAdmin, encryptionKey: KEY, fetchImpl });
const hostsCalled = () => new Set(fetchImpl.calls.map((u) => new URL(u).host));

function scopeToTestShops(client) {
  const bind = (target, prop) => {
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  };
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== 'salesforceConnection') return bind(target, prop);
      return new Proxy(target.salesforceConnection, {
        get(delegate, method) {
          if (method === 'findMany') return (args = {}) => delegate.findMany({ ...args, where: { shop: { in: [A, B] } } });
          return bind(delegate, method);
        },
      });
    },
  });
}

before(async () => {
  if (skip) return;
  prisma = new PrismaClient({ datasources: { db: { url } } });
  scoped = scopeToTestShops(prisma);
  await deleteShopData(prisma, A);
  await deleteShopData(prisma, B);
  for (const [shop, host] of [[A, HOST_A], [B, HOST_B]]) {
    const saved = await saveSalesforceConnection({
      prisma,
      shop,
      instanceUrl: `https://${host}`,
      clientId: `multi-id-${shop}`,
      clientSecret: `multi-secret-${shop}`,
      encryptionKey: KEY,
    });
    assert.deepEqual(saved, { ok: true });
  }
});

after(async () => {
  if (skip || !prisma) return;
  await deleteShopData(prisma, A);
  await deleteShopData(prisma, B);
  await prisma.$disconnect();
});

test('each shop has its own connection: own instance URL and own encrypted credentials', { skip }, async () => {
  const a = await prisma.salesforceConnection.findUnique({ where: { shop: A } });
  const b = await prisma.salesforceConnection.findUnique({ where: { shop: B } });
  assert.equal(a.instanceUrl, `https://${HOST_A}`);
  assert.equal(b.instanceUrl, `https://${HOST_B}`);
  assert.equal(decryptSecret(a.clientIdEnc, KEY), `multi-id-${A}`);
  assert.equal(decryptSecret(b.clientSecretEnc, KEY), `multi-secret-${B}`);
  assert.ok(!JSON.stringify([a, b]).includes('multi-secret'));
  assert.notEqual(a.clientSecretEnc, b.clientSecretEnc);
});

test('one scheduler run syncs both shops', { skip }, async () => {
  const res = await run(T0);
  assert.equal(res.error, undefined);
  assert.equal(res.checked, 2);
  assert.equal(res.due, 2);
  assert.equal(res.synced, 2);
  assert.equal(res.failed, 0);
  assert.equal(res.busy, 0);
  assert.deepEqual(res.results.map((r) => r.ok), [true, true]);
  assert.deepEqual(res.results.map((r) => r.shop).sort(), [A, B]);
  assert.deepEqual([...hostsCalled()].sort(), [HOST_A, HOST_B]); // each org was asked, nothing else
});

test('rows are isolated per shop', { skip }, async () => {
  // Hand check: A closes 2026-01-06, B 2026-01-10; default ship offset 7 days -> 01-13 and 01-17,
  // both in the ISO week starting Monday 2026-01-12. A: 100 * 90% = 90. B: 50 * 50% = 25.
  assert.deepEqual(await rowsOf(A), [{ sku: 'SKU-X', weekStart: '2026-01-12', weightedQty: 90, rawQty: 100, openDealCount: 1 }]);
  assert.deepEqual(await rowsOf(B), [{ sku: 'SKU-Y', weekStart: '2026-01-12', weightedQty: 25, rawQty: 50, openDealCount: 1 }]);
  for (const shop of [A, B]) {
    const conn = await prisma.salesforceConnection.findUnique({ where: { shop } });
    assert.equal(conn.lastSyncAt.toISOString(), T0.toISOString());
    assert.equal(conn.lastErrorClass, null);
  }
});

test('a second run right after finds nothing due', { skip }, async () => {
  const callsBefore = fetchImpl.calls.length;
  const res = await run(minutes(1));
  assert.equal(res.checked, 2);
  assert.equal(res.due, 0);
  assert.equal(res.synced, 0);
  assert.equal(res.failed, 0);
  assert.equal(fetchImpl.calls.length, callsBefore); // no Salesforce traffic at all
});

test('locks are per shop: holding A does not block B, and A reports busy', { skip }, async () => {
  const now = minutes(2);
  assert.equal(await acquireSyncLock({ prisma, shop: A, now }), true);
  try {
    const forB = await syncShop({ prisma, shop: B, admin: skuAdmin(SKUS[B]), encryptionKey: KEY, today: TODAY, now, fetchImpl });
    assert.equal(forB.ok, true);
    const forA = await syncShop({ prisma, shop: A, admin: skuAdmin(SKUS[A]), encryptionKey: KEY, today: TODAY, now, fetchImpl });
    assert.equal(forA.ok, false);
    assert.equal(forA.errorClass, 'busy');
    assert.equal((await counts(A)).locks, 1); // the busy attempt did not release A's lock
    assert.equal((await counts(B)).locks, 0); // B released its own
  } finally {
    await releaseSyncLock({ prisma, shop: A });
  }
  assert.equal((await counts(A)).locks, 0);
  assert.deepEqual(await rowsOf(A), [{ sku: 'SKU-X', weekStart: '2026-01-12', weightedQty: 90, rawQty: 100, openDealCount: 1 }]);
});

test('a failing Salesforce login for B fails B only; A is untouched and B keeps its rows with the error recorded', { skip }, async () => {
  const aBefore = await rowsOf(A);
  const bBefore = await rowsOf(B);
  const bSyncedBefore = (await prisma.salesforceConnection.findUnique({ where: { shop: B } })).lastSyncAt;
  hosts[HOST_B].tokenFails = true;
  const now = hours(8); // both shops are due again (A last synced 8 h ago, B 7 h 58 min ago)
  const res = await run(now);
  assert.equal(res.due, 2);
  assert.equal(res.synced, 1);
  assert.equal(res.failed, 1);
  const byShop = Object.fromEntries(res.results.map((r) => [r.shop, r]));
  assert.equal(byShop[A].ok, true);
  assert.equal(byShop[B].ok, false);
  assert.equal(byShop[B].errorClass, 'auth');

  assert.deepEqual(await rowsOf(A), aBefore); // same content as before
  assert.deepEqual(await rowsOf(B), bBefore); // last good rows kept
  const a = await prisma.salesforceConnection.findUnique({ where: { shop: A } });
  const b = await prisma.salesforceConnection.findUnique({ where: { shop: B } });
  assert.equal(a.lastErrorClass, null);
  assert.equal(a.lastSyncAt.toISOString(), now.toISOString());
  assert.equal(b.lastErrorClass, 'auth');
  assert.equal(typeof b.lastErrorMessage, 'string');
  assert.ok(b.lastErrorMessage.length > 0);
  assert.ok(!b.lastErrorMessage.includes('multi-secret'));
  assert.equal(b.lastErrorAt.toISOString(), now.toISOString());
  assert.equal(b.lastSyncAt.getTime(), bSyncedBefore.getTime()); // not advanced by the failure
  assert.equal((await counts(A)).locks + (await counts(B)).locks, 0);
});

test('deleting shop A leaves shop B intact', { skip }, async () => {
  await prisma.session.create({ data: { id: 'paf-multi-a-session', shop: A, state: 's', accessToken: 'tok-a' } });
  await prisma.session.create({ data: { id: 'paf-multi-b-session', shop: B, state: 's', accessToken: 'tok-b' } });
  const bBefore = await counts(B);
  const bRows = await rowsOf(B);
  const bConn = await prisma.salesforceConnection.findUnique({ where: { shop: B } });

  await deleteShopData(prisma, A);

  assert.deepEqual(await counts(A), { snapshots: 0, unmatched: 0, connection: 0, sessions: 0, locks: 0 });
  assert.deepEqual(await counts(B), bBefore);
  assert.deepEqual(await rowsOf(B), bRows);
  assert.deepEqual(await prisma.salesforceConnection.findUnique({ where: { shop: B } }), bConn);
});

test('uninstalling shop B removes its connection and session but keeps its snapshots until redact', { skip }, async () => {
  await deleteUninstallData(prisma, B);
  const c = await counts(B);
  assert.equal(c.connection, 0);
  assert.equal(c.sessions, 0);
  assert.equal(c.snapshots, 1);
  assert.deepEqual(await rowsOf(B), [{ sku: 'SKU-Y', weekStart: '2026-01-12', weightedQty: 25, rawQty: 50, openDealCount: 1 }]);

  await deleteShopData(prisma, B);
  assert.deepEqual(await counts(B), { snapshots: 0, unmatched: 0, connection: 0, sessions: 0, locks: 0 });
});
