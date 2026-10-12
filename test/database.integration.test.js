/**
 * Real-Postgres integration test for the store, sync and deletion code.
 *
 * Skipped unless PAF_TEST_DATABASE_URL is set. It deletes rows for a fixed test shop, so it REFUSES to
 * run unless the URL points at localhost and the database name ends in `_test`.
 *
 *   createdb paf_test
 *   DATABASE_URL=postgresql://localhost:5432/paf_test npx prisma migrate deploy
 *   PAF_TEST_DATABASE_URL=postgresql://localhost:5432/paf_test npm run test:db
 *
 * Uses a fake Salesforce client (no network) with the README worked example deals.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaPipelineStore } from '../app/lib/pipeline-store.server.js';
import { deleteShopData, deleteUninstallData } from '../app/lib/shop-data.server.js';
import { runPipelineSync } from '../app/lib/pipeline/pipeline-sync.server.js';
import { encryptSecret, decryptSecret } from '../app/lib/pipeline/credentials-crypto.server.js';
import { acquireSyncLock, releaseSyncLock } from '../app/lib/sync-lock.server.js';
import { loadPipelineSettings, savePipelineSettings } from '../app/lib/settings.server.js';
import { saveFeedback } from '../app/lib/feedback.server.js';
import { recordShopSeen, recordShopUninstalled } from '../app/lib/shop-registry.server.js';

const url = process.env.PAF_TEST_DATABASE_URL;
const parsed = (() => { try { return new URL(url); } catch { return null; } })();
const safe =
  parsed &&
  ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
  /_test$/.test(parsed.pathname.replace(/^\//, ''));
const skip = !url ? 'set PAF_TEST_DATABASE_URL to run' : safe ? false : 'refused: URL must be localhost and a database ending in _test';

const SHOP = 'paf-db-test.myshopify.com';
const GHOST = 'paf-db-ghost.myshopify.com';
const KEY = crypto.randomBytes(32).toString('hex'); // in memory only
const SKUS = ['SKU-X'];
const TODAY = '2026-01-01';

// README worked example: 300 @ 50% closing day 20, 200 @ 20% closing day 30 (shipOffsetDays 0).
const fakeClient = {
  fetchOpenOpportunities: async () => [
    { id: 'a', stageName: 'Value Proposition', probability: 50, closeDate: '2026-01-21', lineItems: [{ productCode: 'SKU-X', quantity: 300 }] },
    { id: 'b', stageName: 'Needs Analysis', probability: 20, closeDate: '2026-01-31', lineItems: [{ productCode: 'sku-x', quantity: 200 }, { productCode: 'NOPE-1', quantity: 5 }] },
  ],
};
const failingClient = {
  fetchOpenOpportunities: async () => { throw Object.assign(new Error('x'), { errorClass: 'auth', userMessage: 'Reconnect Salesforce.' }); },
};
const settings = { shipOffsetDays: 0 };

let prisma;
let store;
const counts = async (shop = SHOP) => ({
  snapshots: await prisma.pipelineSnapshot.count({ where: { shop } }),
  unmatched: await prisma.unmatchedProduct.count({ where: { shop } }),
  connection: await prisma.salesforceConnection.count({ where: { shop } }),
  sessions: await prisma.session.count({ where: { shop } }),
  settings: await prisma.pipelineSetting.count({ where: { shop } }),
  installs: await prisma.shopInstall.count({ where: { shop } }),
  feedback: await prisma.feedback.count({ where: { shop } }),
  locks: await prisma.syncLock.count({ where: { shop } }),
});
const sync = (client, now = new Date('2026-01-01T06:00:00Z')) =>
  runPipelineSync({ shop: SHOP, client, store, getShopifySkus: async () => SKUS, settings, today: TODAY, now });

before(async () => {
  if (skip) return;
  prisma = new PrismaClient({ datasources: { db: { url } } });
  store = createPrismaPipelineStore(prisma);
  await deleteShopData(prisma, SHOP);
  await deleteShopData(prisma, GHOST);
  await prisma.salesforceConnection.create({
    data: {
      shop: SHOP,
      instanceUrl: 'https://example.my.salesforce.com',
      clientIdEnc: encryptSecret('test-client-id', KEY),
      clientSecretEnc: encryptSecret('test-client-secret-value', KEY),
    },
  });
});

after(async () => {
  if (skip || !prisma) return;
  await deleteShopData(prisma, SHOP);
  await deleteShopData(prisma, GHOST);
  await prisma.$disconnect();
});

test('credentials are stored encrypted and decrypt back', { skip }, async () => {
  const row = await prisma.salesforceConnection.findUnique({ where: { shop: SHOP } });
  assert.ok(!JSON.stringify(row).includes('test-client-secret-value'));
  assert.equal(decryptSecret(row.clientSecretEnc, KEY), 'test-client-secret-value');
});

test('sync writes the worked-example rows, reports the unmatched code and clears errors', { skip }, async () => {
  const res = await sync(fakeClient);
  assert.equal(res.ok, true);
  const rows = await prisma.pipelineSnapshot.findMany({ where: { shop: SHOP }, orderBy: { weekStart: 'asc' } });
  // Hand check: day 20 = 2026-01-21 (week of Mon 2026-01-19), day 30 = 2026-01-31 (week of Mon 2026-01-26).
  assert.deepEqual(rows.map((r) => [r.sku, r.weekStart.toISOString().slice(0, 10), r.weightedQty, r.rawQty]), [
    ['SKU-X', '2026-01-19', 150, 300],
    ['SKU-X', '2026-01-26', 40, 200],
  ]);
  const unmatched = await prisma.unmatchedProduct.findMany({ where: { shop: SHOP } });
  assert.deepEqual(unmatched.map((u) => [u.productCode, u.openDealCount, u.rawQty]), [['NOPE-1', 1, 5]]);
  const conn = await prisma.salesforceConnection.findUnique({ where: { shop: SHOP } });
  assert.equal(conn.lastSyncAt.toISOString(), '2026-01-01T06:00:00.000Z');
  assert.equal(conn.lastErrorClass, null);
});

test('a second sync replaces the rows instead of duplicating them', { skip }, async () => {
  const before = await counts();
  const res = await sync(fakeClient, new Date('2026-01-01T12:00:00Z'));
  assert.equal(res.ok, true);
  assert.deepEqual(await counts(), before);
});

test('a failed sync keeps the last good rows and records the error', { skip }, async () => {
  const before = await counts();
  const lastGood = (await prisma.salesforceConnection.findUnique({ where: { shop: SHOP } })).lastSyncAt;
  const res = await sync(failingClient, new Date('2026-01-01T18:00:00Z'));
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, 'auth');
  assert.deepEqual(await counts(), before);
  const conn = await prisma.salesforceConnection.findUnique({ where: { shop: SHOP } });
  assert.equal(conn.lastErrorClass, 'auth');
  assert.equal(conn.lastErrorMessage, 'Reconnect Salesforce.');
  assert.equal(conn.lastSyncAt.getTime(), lastGood.getTime());
});

test('a missing connection aborts the whole write and rolls everything back', { skip }, async () => {
  await assert.rejects(
    store.recordSyncSuccess({
      shop: GHOST,
      syncedAt: '2026-01-01T06:00:00.000Z',
      snapshots: [{ sku: 'X', weekStart: '2026-01-05', weightedQty: 1, rawQty: 1, openDealCount: 1 }],
      unmatched: [{ productCode: 'Y', openDealCount: 1, rawQty: 1 }],
    }),
  );
  assert.deepEqual(await counts(GHOST), { snapshots: 0, unmatched: 0, connection: 0, sessions: 0, settings: 0, installs: 0, feedback: 0, locks: 0 });
});

test('a large shop (4,500 rows, chunked) is written in one go; a duplicate row rolls back', { skip }, async () => {
  const big = Array.from({ length: 4500 }, (_, i) => ({ sku: `BULK-${i}`, weekStart: '2026-01-05', weightedQty: i, rawQty: i, openDealCount: 1 }));
  await store.recordSyncSuccess({ shop: SHOP, syncedAt: '2026-01-02T00:00:00.000Z', snapshots: big, unmatched: [] });
  assert.equal((await counts()).snapshots, 4500);
  await assert.rejects(
    store.recordSyncSuccess({ shop: SHOP, syncedAt: '2026-01-03T00:00:00.000Z', snapshots: [big[0], big[0]], unmatched: [] }),
  );
  assert.equal((await counts()).snapshots, 4500); // previous data kept
});

test('uninstall removes sessions and credentials only; shop/redact removes everything', { skip }, async () => {
  await prisma.session.create({ data: { id: 'paf-db-test-session', shop: SHOP, state: 's', accessToken: 'tok' } });
  await prisma.pipelineSetting.create({ data: { shop: SHOP } });
  await deleteUninstallData(prisma, SHOP);
  assert.deepEqual(await counts(), { snapshots: 4500, unmatched: 0, connection: 0, sessions: 0, settings: 1, installs: 0, feedback: 0, locks: 0 });
  await deleteShopData(prisma, SHOP);
  assert.deepEqual(await counts(), { snapshots: 0, unmatched: 0, connection: 0, sessions: 0, settings: 0, installs: 0, feedback: 0, locks: 0 });
});

test('sync lock: a live lock blocks (real unique-violation path), release frees it, an expired lock is taken over', { skip }, async () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: t0, ttlMs: 60000 }), true);
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: new Date(t0.getTime() + 1000), ttlMs: 60000 }), false); // still live
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: new Date(t0.getTime() + 61000), ttlMs: 60000 }), true); // expired -> takeover
  await releaseSyncLock({ prisma, shop: SHOP });
  assert.equal((await counts()).locks, 0);
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: t0, ttlMs: 60000 }), true);
  await releaseSyncLock({ prisma, shop: SHOP });
});

test('sync lock: two simultaneous attempts, exactly one wins', { skip }, async () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const results = await Promise.all(Array.from({ length: 8 }, () => acquireSyncLock({ prisma, shop: SHOP, now, ttlMs: 60000 })));
  assert.equal(results.filter(Boolean).length, 1);
  await releaseSyncLock({ prisma, shop: SHOP });
});

test('settings: save then load round-trips, overrides are replaced, bad input writes nothing', { skip }, async () => {
  assert.deepEqual(await savePipelineSettings({ prisma, shop: SHOP, haircut: '0.5', shipOffsetDays: 3, horizonDays: 60, leadTimeDays: 21, stageOverrides: [{ stageName: ' Won ', probability: 100 }, { stageName: 'Lost', probability: 0 }] }), { ok: true });
  let loaded = await loadPipelineSettings({ prisma, shop: SHOP });
  assert.deepEqual(loaded, { haircut: 0.5, shipOffsetDays: 3, horizonDays: 60, leadTimeDays: 21, stageOverrides: [{ stageName: 'Lost', probability: 0 }, { stageName: 'Won', probability: 100 }] });
  await savePipelineSettings({ prisma, shop: SHOP, haircut: 1, shipOffsetDays: 7, horizonDays: 90, leadTimeDays: 14, stageOverrides: [{ stageName: 'Won', probability: 90 }] });
  loaded = await loadPipelineSettings({ prisma, shop: SHOP });
  assert.deepEqual(loaded.stageOverrides, [{ stageName: 'Won', probability: 90 }]); // old 'Lost' row removed
  const bad = await savePipelineSettings({ prisma, shop: SHOP, haircut: 2, shipOffsetDays: 7, horizonDays: 90, leadTimeDays: 14 });
  assert.equal(bad.ok, false);
  assert.equal((await loadPipelineSettings({ prisma, shop: SHOP })).haircut, 1); // unchanged
});

test('feedback: stored, rate-limited at 5 per hour, and removed by shop/redact', { skip }, async () => {
  const now = new Date();
  for (let i = 0; i < 5; i++) assert.deepEqual(await saveFeedback({ prisma, shop: SHOP, message: `msg ${i}`, rating: 4, now }), { ok: true });
  const sixth = await saveFeedback({ prisma, shop: SHOP, message: 'one more', rating: null, now });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.errorClass, 'rate_limited');
  assert.equal((await counts()).feedback, 5);
});

test('shop install record: first seen, throttled refresh, uninstall, reinstall', { skip }, async () => {
  const t0 = new Date('2026-02-01T00:00:00Z');
  await recordShopSeen({ prisma, shop: SHOP, now: t0 });
  let row = await prisma.shopInstall.findUnique({ where: { shop: SHOP } });
  assert.equal(row.installedAt.toISOString(), t0.toISOString());
  await recordShopSeen({ prisma, shop: SHOP, now: new Date(t0.getTime() + 60000) }); // within an hour: no write
  row = await prisma.shopInstall.findUnique({ where: { shop: SHOP } });
  assert.equal(row.lastSeenAt.toISOString(), t0.toISOString());
  const t1 = new Date(t0.getTime() + 2 * 3600000);
  await recordShopUninstalled({ prisma, shop: SHOP, now: t1 });
  row = await prisma.shopInstall.findUnique({ where: { shop: SHOP } });
  assert.equal(row.uninstalledAt.toISOString(), t1.toISOString());
  const t2 = new Date(t1.getTime() + 86400000);
  await recordShopSeen({ prisma, shop: SHOP, now: t2 }); // reinstall
  row = await prisma.shopInstall.findUnique({ where: { shop: SHOP } });
  assert.equal(row.uninstalledAt, null);
  assert.equal(row.installedAt.toISOString(), t2.toISOString());
});

test('shop/redact also removes install, feedback and lock rows', { skip }, async () => {
  await acquireSyncLock({ prisma, shop: SHOP, now: new Date(), ttlMs: 60000 });
  await deleteShopData(prisma, SHOP);
  assert.deepEqual(await counts(), { snapshots: 0, unmatched: 0, connection: 0, sessions: 0, settings: 0, installs: 0, feedback: 0, locks: 0 });
});
