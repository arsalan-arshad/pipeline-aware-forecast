// Tests for app/lib/shop-registry.server.js, written from the module contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordShopSeen, recordShopUninstalled } from '../app/lib/shop-registry.server.js';
import { createM6Prisma, SHOP, NOW, HOUR } from './fixtures/m6-fixtures.js';

const names = (prisma) => prisma.calls.map((c) => `${c.model}.${c.method}`);
const ago = (ms) => new Date(NOW.getTime() - ms);
const withRow = (row) => createM6Prisma({ results: { 'shopInstall.findUnique': row } });

// ------------------------------------------------------------------ recordShopSeen

test('recordShopSeen: unknown shop -> findUnique then create with installedAt = lastSeenAt = now', async () => {
  const prisma = withRow(null);
  const r = await recordShopSeen({ prisma, shop: SHOP, now: NOW });
  assert.equal(r, undefined);
  assert.deepEqual(names(prisma), ['shopInstall.findUnique', 'shopInstall.create']);
  assert.deepEqual(prisma.calls[0].args, { where: { shop: SHOP } });
  assert.deepEqual(prisma.calls[1].args, { data: { shop: SHOP, installedAt: NOW, lastSeenAt: NOW } });
});

test('recordShopSeen: reinstall (uninstalledAt set) -> update clears uninstalledAt and resets installedAt', async () => {
  const prisma = withRow({ shop: SHOP, installedAt: ago(1000 * HOUR), uninstalledAt: ago(10 * HOUR), lastSeenAt: ago(0) });
  await recordShopSeen({ prisma, shop: SHOP, now: NOW });
  assert.deepEqual(names(prisma), ['shopInstall.findUnique', 'shopInstall.update']);
  // Even though lastSeenAt is "just now", the reinstall branch wins and always writes.
  assert.deepEqual(prisma.calls[1].args, {
    where: { shop: SHOP },
    data: { installedAt: NOW, uninstalledAt: null, lastSeenAt: NOW },
  });
});

test('recordShopSeen: lastSeenAt null -> update lastSeenAt only', async () => {
  const prisma = withRow({ shop: SHOP, installedAt: ago(5 * HOUR), uninstalledAt: null, lastSeenAt: null });
  await recordShopSeen({ prisma, shop: SHOP, now: NOW });
  assert.deepEqual(names(prisma), ['shopInstall.findUnique', 'shopInstall.update']);
  assert.deepEqual(prisma.calls[1].args, { where: { shop: SHOP }, data: { lastSeenAt: NOW } });
});

test('recordShopSeen: throttle boundary: 1h - 1ms ago -> no write; exactly 1h ago -> write', async () => {
  const fresh = withRow({ shop: SHOP, uninstalledAt: null, lastSeenAt: ago(HOUR - 1) });
  await recordShopSeen({ prisma: fresh, shop: SHOP, now: NOW });
  assert.deepEqual(names(fresh), ['shopInstall.findUnique']);

  const stale = withRow({ shop: SHOP, uninstalledAt: null, lastSeenAt: ago(HOUR) });
  await recordShopSeen({ prisma: stale, shop: SHOP, now: NOW });
  assert.deepEqual(names(stale), ['shopInstall.findUnique', 'shopInstall.update']);
  assert.deepEqual(stale.calls[1].args.data, { lastSeenAt: NOW });
});

test('recordShopSeen: lastSeenAt returned as an ISO string is compared correctly', async () => {
  const fresh = withRow({ shop: SHOP, uninstalledAt: null, lastSeenAt: ago(HOUR - 1).toISOString() });
  await recordShopSeen({ prisma: fresh, shop: SHOP, now: NOW });
  assert.equal(fresh.callsOf('shopInstall', 'update').length, 0);
  const stale = withRow({ shop: SHOP, uninstalledAt: null, lastSeenAt: ago(2 * HOUR).toISOString() });
  await recordShopSeen({ prisma: stale, shop: SHOP, now: NOW });
  assert.equal(stale.callsOf('shopInstall', 'update').length, 1);
});

test('recordShopSeen: custom minIntervalMs is honoured', async () => {
  const row = { shop: SHOP, uninstalledAt: null, lastSeenAt: ago(5000) };
  const skip = withRow(row);
  await recordShopSeen({ prisma: skip, shop: SHOP, now: NOW, minIntervalMs: 6000 });
  assert.equal(skip.callsOf('shopInstall', 'update').length, 0);
  const write = withRow(row);
  await recordShopSeen({ prisma: write, shop: SHOP, now: NOW, minIntervalMs: 5000 });
  assert.equal(write.callsOf('shopInstall', 'update').length, 1);
});

for (const [label, shop] of [['empty', ''], ['undefined', undefined], ['null', null], ['number', 3]]) {
  test(`recordShopSeen: invalid shop (${label}) -> no prisma call, no throw`, async () => {
    const prisma = withRow(null);
    assert.equal(await recordShopSeen({ prisma, shop, now: NOW }), undefined);
    assert.equal(prisma.calls.length, 0);
  });
}

for (const [label, now] of [['invalid Date', new Date('x')], ['string', '2026-01-01'], ['number', 5], ['undefined', undefined]]) {
  test(`recordShopSeen: invalid now (${label}) -> no prisma call, no throw`, async () => {
    const prisma = withRow(null);
    assert.equal(await recordShopSeen({ prisma, shop: SHOP, now }), undefined);
    assert.equal(prisma.calls.length, 0);
  });
}

test('recordShopSeen: never throws when findUnique rejects, or the write rejects, or prisma is missing', async () => {
  const a = createM6Prisma({ failOn: { 'shopInstall.findUnique': new Error('db') } });
  assert.equal(await recordShopSeen({ prisma: a, shop: SHOP, now: NOW }), undefined);
  const b = createM6Prisma({ failOn: { 'shopInstall.create': new Error('db') } });
  assert.equal(await recordShopSeen({ prisma: b, shop: SHOP, now: NOW }), undefined);
  const c = createM6Prisma({ results: { 'shopInstall.findUnique': { shop: SHOP, lastSeenAt: null } }, failOn: { 'shopInstall.update': new Error('db') } });
  assert.equal(await recordShopSeen({ prisma: c, shop: SHOP, now: NOW }), undefined);
  assert.equal(await recordShopSeen({ prisma: undefined, shop: SHOP, now: NOW }), undefined);
  assert.equal(await recordShopSeen({ prisma: { shopInstall: { findUnique() { throw new Error('sync'); } } }, shop: SHOP, now: NOW }), undefined);
});

// ------------------------------------------------------------------ recordShopUninstalled

test('recordShopUninstalled: one upsert that stamps uninstalledAt, creating the row if absent', async () => {
  const prisma = createM6Prisma();
  assert.equal(await recordShopUninstalled({ prisma, shop: SHOP, now: NOW }), undefined);
  assert.deepEqual(names(prisma), ['shopInstall.upsert']);
  assert.deepEqual(prisma.calls[0].args, {
    where: { shop: SHOP },
    create: { shop: SHOP, installedAt: NOW, uninstalledAt: NOW },
    update: { uninstalledAt: NOW },
  });
});

for (const [label, shop] of [['empty', ''], ['undefined', undefined], ['number', 1]]) {
  test(`recordShopUninstalled: invalid shop (${label}) -> no prisma call`, async () => {
    const prisma = createM6Prisma();
    assert.equal(await recordShopUninstalled({ prisma, shop, now: NOW }), undefined);
    assert.equal(prisma.calls.length, 0);
  });
}

for (const [label, now] of [['invalid Date', new Date('x')], ['string', 'now'], ['undefined', undefined]]) {
  test(`recordShopUninstalled: invalid now (${label}) -> no prisma call`, async () => {
    const prisma = createM6Prisma();
    assert.equal(await recordShopUninstalled({ prisma, shop: SHOP, now }), undefined);
    assert.equal(prisma.calls.length, 0);
  });
}

test('recordShopUninstalled: never throws', async () => {
  const a = createM6Prisma({ failOn: { 'shopInstall.upsert': new Error('db') } });
  assert.equal(await recordShopUninstalled({ prisma: a, shop: SHOP, now: NOW }), undefined);
  assert.equal(await recordShopUninstalled({ prisma: undefined, shop: SHOP, now: NOW }), undefined);
});

test('recordShopSeen / recordShopUninstalled: never throw, even called with no argument at all', async () => {
  assert.equal(await recordShopSeen(undefined), undefined);
  assert.equal(await recordShopUninstalled(undefined), undefined);
});
