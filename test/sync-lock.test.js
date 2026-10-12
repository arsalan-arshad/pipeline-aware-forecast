// Tests for app/lib/sync-lock.server.js, written from the module contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSyncLock, releaseSyncLock } from '../app/lib/sync-lock.server.js';
import { createM6Prisma, p2002, SHOP } from './fixtures/m6-fixtures.js';

const NOW_MS = Date.parse('2026-01-01T12:00:00.000Z');
const NOW_D = new Date(NOW_MS); // syncShop passes `now` as a Date, so the lock takes a Date
const TEN_MIN = 600000;

test('acquireSyncLock: free lock -> one direct create with lockedUntil = now + 10 minutes, true', async () => {
  const prisma = createM6Prisma();
  const got = await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D });
  assert.equal(got, true);
  assert.equal(prisma.calls.length, 1);
  assert.equal(prisma.transactions.length, 0, 'not inside a transaction');
  const [c] = prisma.calls;
  assert.equal(`${c.model}.${c.method}`, 'syncLock.create');
  // 12:00:00 + 10 min = 12:10:00.
  assert.deepEqual(c.args, { data: { shop: SHOP, lockedUntil: new Date('2026-01-01T12:10:00.000Z') } });
  assert.ok(c.args.data.lockedUntil instanceof Date);
});

test('acquireSyncLock: ttlMs override is used', async () => {
  const prisma = createM6Prisma();
  await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D, ttlMs: 1000 });
  assert.equal(prisma.calls[0].args.data.lockedUntil.getTime(), NOW_MS + 1000);
});

test('acquireSyncLock: default ttl is exactly 600000 ms', async () => {
  const prisma = createM6Prisma();
  await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D });
  assert.equal(prisma.calls[0].args.data.lockedUntil.getTime() - NOW_MS, TEN_MIN);
});

test('acquireSyncLock: P2002 on create then updateMany count 1 (expired lock taken over) -> true', async () => {
  const prisma = createM6Prisma({
    failOn: { 'syncLock.create': p2002() },
    results: { 'syncLock.updateMany': { count: 1 } },
  });
  const got = await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D });
  assert.equal(got, true);
  assert.deepEqual(prisma.calls.map((c) => `${c.model}.${c.method}`), ['syncLock.create', 'syncLock.updateMany']);
  const lockedUntil = new Date(NOW_MS + TEN_MIN);
  // Only an expired lock (lockedUntil <= now) may be taken over.
  const { where, data } = prisma.calls[1].args;
  assert.equal(where.shop, SHOP);
  assert.deepEqual(Object.keys(where.lockedUntil), ['lte']);
  assert.equal(new Date(where.lockedUntil.lte).getTime(), NOW_MS);
  assert.deepEqual(data, { lockedUntil });
});

test('acquireSyncLock: a Date for now (as syncShop passes it) gives the same lockedUntil', async () => {
  const prisma = createM6Prisma();
  await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D });
  assert.equal(prisma.calls[0].args.data.lockedUntil.getTime(), NOW_MS + TEN_MIN);
});

test('acquireSyncLock: updateMany where.lockedUntil.lte equals now (Date or number form)', async () => {
  const prisma = createM6Prisma({ failOn: { 'syncLock.create': p2002() } });
  await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D });
  const lte = prisma.calls[1].args.where.lockedUntil.lte;
  assert.equal(new Date(lte).getTime(), NOW_MS);
});

test('acquireSyncLock: P2002 then count 0 (lock still held) -> false', async () => {
  const prisma = createM6Prisma({
    failOn: { 'syncLock.create': p2002() },
    results: { 'syncLock.updateMany': { count: 0 } },
  });
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D }), false);
});

test('acquireSyncLock: only count === 1 means acquired (count 2 or missing is not)', async () => {
  for (const result of [{ count: 2 }, {}, { count: 0 }]) {
    const prisma = createM6Prisma({ failOn: { 'syncLock.create': p2002() }, results: { 'syncLock.updateMany': result } });
    assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D }), false, JSON.stringify(result));
  }
});

test('acquireSyncLock: a non-P2002 create error propagates and no takeover is attempted', async () => {
  const prisma = createM6Prisma({ failOn: { 'syncLock.create': Object.assign(new Error('conn reset'), { code: 'P1001' }) } });
  await assert.rejects(acquireSyncLock({ prisma, shop: SHOP, now: NOW_D }), /conn reset/);
  assert.equal(prisma.callsOf('syncLock', 'updateMany').length, 0);
});

test('acquireSyncLock: a plain error without a code propagates', async () => {
  const prisma = createM6Prisma({ failOn: { 'syncLock.create': new Error('boom') } });
  await assert.rejects(acquireSyncLock({ prisma, shop: SHOP, now: NOW_D }), /boom/);
});

test('acquireSyncLock: an error thrown by the takeover updateMany propagates', async () => {
  const prisma = createM6Prisma({ failOn: { 'syncLock.create': p2002(), 'syncLock.updateMany': new Error('update broke') } });
  await assert.rejects(acquireSyncLock({ prisma, shop: SHOP, now: NOW_D }), /update broke/);
});

test('acquireSyncLock: two holders, one lock: second caller loses while the first is unexpired', async () => {
  // Tiny in-memory lock table behind the same call shapes: create fails with P2002 once a row exists,
  // updateMany only matches when lockedUntil <= now.
  const rows = new Map();
  const prisma = createM6Prisma({
    results: {
      'syncLock.create': ({ data }) => {
        if (rows.has(data.shop)) throw p2002();
        rows.set(data.shop, data.lockedUntil.getTime());
        return data;
      },
      'syncLock.updateMany': ({ where, data }) => {
        const held = rows.get(where.shop);
        if (held !== undefined && held <= new Date(where.lockedUntil.lte).getTime()) {
          rows.set(where.shop, data.lockedUntil.getTime());
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  });
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: NOW_D }), true);
  // 5 minutes later: lock (until +10 min) is still held.
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: new Date(NOW_MS + 5 * 60000) }), false);
  // Exactly at expiry (lockedUntil <= now) it can be taken over.
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: new Date(NOW_MS + TEN_MIN) }), true);
  // A different shop is unaffected.
  assert.equal(await acquireSyncLock({ prisma, shop: 'other.myshopify.com', now: NOW_D }), true);
});

test('releaseSyncLock: one direct deleteMany by shop, returns undefined', async () => {
  const prisma = createM6Prisma();
  const r = await releaseSyncLock({ prisma, shop: SHOP });
  assert.equal(r, undefined);
  assert.equal(prisma.calls.length, 1);
  assert.equal(prisma.transactions.length, 0);
  assert.equal(`${prisma.calls[0].model}.${prisma.calls[0].method}`, 'syncLock.deleteMany');
  assert.deepEqual(prisma.calls[0].args, { where: { shop: SHOP } });
});

test('releaseSyncLock: errors are swallowed', async () => {
  const prisma = createM6Prisma({ failOn: { 'syncLock.deleteMany': new Error('gone') } });
  assert.equal(await releaseSyncLock({ prisma, shop: SHOP }), undefined);
});

test('releaseSyncLock: even a synchronous throw from the client is swallowed', async () => {
  const prisma = { syncLock: { deleteMany() { throw new Error('sync throw'); } } };
  assert.equal(await releaseSyncLock({ prisma, shop: SHOP }), undefined);
});

test('releaseSyncLock: with a Date lockedUntil the delete is conditional on that exact lock', async () => {
  const prisma = createM6Prisma();
  const lockedUntil = new Date('2026-01-01T12:30:00.000Z');
  assert.equal(await releaseSyncLock({ prisma, shop: SHOP, lockedUntil }), undefined);
  assert.deepEqual(prisma.calls[0].args, { where: { shop: SHOP, lockedUntil } });
  assert.equal(prisma.calls[0].args.where.lockedUntil, lockedUntil);
});

test('releaseSyncLock: a non-Date lockedUntil is ignored (delete by shop only)', async () => {
  for (const lockedUntil of [undefined, null, '2026-01-01T12:30:00.000Z', 5]) {
    const prisma = createM6Prisma();
    await releaseSyncLock({ prisma, shop: SHOP, lockedUntil });
    assert.deepEqual(prisma.calls[0].args, { where: { shop: SHOP } }, String(lockedUntil));
  }
});

test('releaseSyncLock: a conditional delete errors are still swallowed', async () => {
  const prisma = createM6Prisma({ failOn: { 'syncLock.deleteMany': new Error('gone') } });
  assert.equal(await releaseSyncLock({ prisma, shop: SHOP, lockedUntil: new Date(NOW_MS) }), undefined);
});

test('lock lifecycle: a run whose lock expired and was taken over does not delete the newer lock', async () => {
  const rows = new Map();
  const prisma = createM6Prisma({
    results: {
      'syncLock.create': ({ data }) => { if (rows.has(data.shop)) throw p2002(); rows.set(data.shop, data.lockedUntil.getTime()); return data; },
      'syncLock.updateMany': ({ where, data }) => {
        const held = rows.get(where.shop);
        if (held !== undefined && held <= new Date(where.lockedUntil.lte).getTime()) { rows.set(where.shop, data.lockedUntil.getTime()); return { count: 1 }; }
        return { count: 0 };
      },
      'syncLock.deleteMany': ({ where }) => {
        // Honour the conditional where like the database would.
        const held = rows.get(where.shop);
        if (held === undefined || (where.lockedUntil && where.lockedUntil.getTime() !== held)) return { count: 0 };
        rows.delete(where.shop);
        return { count: 1 };
      },
    },
  });
  const t0 = new Date(NOW_MS);
  const t1 = new Date(NOW_MS + TEN_MIN); // first lock expires here
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: t0 }), true);
  assert.equal(await acquireSyncLock({ prisma, shop: SHOP, now: t1 }), true, 'second run takes over');
  await releaseSyncLock({ prisma, shop: SHOP, lockedUntil: new Date(NOW_MS + TEN_MIN) }); // first run finishes late
  assert.equal(rows.get(SHOP), NOW_MS + 2 * TEN_MIN, 'the newer lock survived');
  await releaseSyncLock({ prisma, shop: SHOP, lockedUntil: new Date(NOW_MS + 2 * TEN_MIN) });
  assert.equal(rows.size, 0);
});
