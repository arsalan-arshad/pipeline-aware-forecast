// Tests for app/lib/run-due-syncs.server.js, written from the module contract.
// Uses the real syncShop over a scripted fake Prisma, fake fetch and fake Shopify admins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDueSyncs } from '../app/lib/run-due-syncs.server.js';
import { schedulerEnv, createM6Prisma, createFakeAdmin, before, HOUR, NOW } from './fixtures/m6-fixtures.js';

const row = (shop, lastSyncAt = null, lastErrorAt = null) => ({ shop, lastSyncAt, lastErrorAt });
const shopsProcessed = (e) => e.adminCalls;
const THROTTLED = { errors: [{ extensions: { code: 'THROTTLED' } }] };

test('runDueSyncs: empty table -> all zeros, no sync', async () => {
  const e = schedulerEnv({ rows: [] });
  const r = await runDueSyncs(e.args);
  assert.deepEqual({ ...r, results: undefined }, { checked: 0, due: 0, synced: 0, failed: 0, busy: 0, results: undefined });
  assert.deepEqual(r.results, []);
  assert.equal(e.adminCalls.length, 0);
});

test('runDueSyncs: reads only the narrow select, with no credential column', async () => {
  const e = schedulerEnv({ rows: [] });
  await runDueSyncs(e.args);
  const reads = e.prisma.callsOf('salesforceConnection', 'findMany');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].args.select, { shop: true, lastSyncAt: true, lastErrorAt: true });
  const dump = JSON.stringify(reads[0].args);
  assert.ok(!/enc|secret|client|instance|token/i.test(dump), dump);
});

test('runDueSyncs: a never-synced shop is due and syncs (counts + result)', async () => {
  const e = schedulerEnv({ rows: [row('a.myshopify.com')] });
  const r = await runDueSyncs(e.args);
  assert.equal(r.checked, 1);
  assert.equal(r.due, 1);
  assert.equal(r.synced, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.busy, 0);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].shop, 'a.myshopify.com');
  assert.equal(r.results[0].ok, true);
  assert.equal(e.prisma.transactions.length, 1, 'syncShop wrote its snapshot batch');
});

test('runDueSyncs: 6 hour boundary: exactly 6h ago is due, 6h minus 1 ms is not', async () => {
  const e = schedulerEnv({ rows: [row('exact.myshopify.com', before(6 * HOUR)), row('almost.myshopify.com', before(6 * HOUR - 1))] });
  const r = await runDueSyncs(e.args);
  assert.equal(r.checked, 2);
  assert.equal(r.due, 1);
  assert.deepEqual(shopsProcessed(e), ['exact.myshopify.com']);
});

test('runDueSyncs: intervalHours is honoured', async () => {
  const rows = [row('a.myshopify.com', before(2 * HOUR)), row('b.myshopify.com', before(HOUR))];
  const e = schedulerEnv({ rows });
  const r = await runDueSyncs({ ...e.args, intervalHours: 2 });
  assert.equal(r.due, 1);
  assert.deepEqual(shopsProcessed(e), ['a.myshopify.com']);
});

test('runDueSyncs: failure backoff: recent error blocks, error exactly 1h old does not', async () => {
  const old = before(24 * HOUR);
  const e = schedulerEnv({
    rows: [
      row('recent.myshopify.com', old, before(HOUR - 1)),
      row('edge.myshopify.com', old, before(HOUR)),
      row('clean.myshopify.com', old, null),
    ],
  });
  const r = await runDueSyncs(e.args);
  assert.equal(r.checked, 3);
  assert.equal(r.due, 2);
  assert.deepEqual([...shopsProcessed(e)].sort(), ['clean.myshopify.com', 'edge.myshopify.com']);
});

test('runDueSyncs: failureBackoffHours is honoured', async () => {
  const e = schedulerEnv({ rows: [row('a.myshopify.com', before(24 * HOUR), before(2 * HOUR))] });
  const r = await runDueSyncs({ ...e.args, failureBackoffHours: 3 });
  assert.equal(r.due, 0);
  assert.equal(e.adminCalls.length, 0);
});

test('runDueSyncs: a shop that is not due by interval is skipped even with no error', async () => {
  const e = schedulerEnv({ rows: [row('fresh.myshopify.com', before(HOUR), null)] });
  const r = await runDueSyncs(e.args);
  assert.deepEqual([r.checked, r.due, r.synced], [1, 0, 0]);
});

test('runDueSyncs: oldest lastSyncAt first, never-synced before everything, processed one by one', async () => {
  const rows = [
    row('c.myshopify.com', before(8 * HOUR)),
    row('a.myshopify.com', before(48 * HOUR)),
    row('n.myshopify.com', null),
    row('b.myshopify.com', before(20 * HOUR)),
  ];
  const e = schedulerEnv({ rows });
  const r = await runDueSyncs(e.args);
  assert.deepEqual(shopsProcessed(e), ['n.myshopify.com', 'a.myshopify.com', 'b.myshopify.com', 'c.myshopify.com']);
  assert.deepEqual(r.results.map((x) => x.shop), shopsProcessed(e));
  // Sequential: each shop's lock is released before the next shop's admin is even requested.
  assert.deepEqual(e.events, [
    'admin:n.myshopify.com', 'lock:n.myshopify.com', 'release:n.myshopify.com',
    'admin:a.myshopify.com', 'lock:a.myshopify.com', 'release:a.myshopify.com',
    'admin:b.myshopify.com', 'lock:b.myshopify.com', 'release:b.myshopify.com',
    'admin:c.myshopify.com', 'lock:c.myshopify.com', 'release:c.myshopify.com',
  ]);
});

test('runDueSyncs: maxShops cuts the batch to the oldest shops; due counts the whole backlog', async () => {
  const rows = [];
  for (let i = 1; i <= 5; i += 1) rows.push(row(`s${i}.myshopify.com`, before((10 + i) * HOUR)));
  rows.push(row('fresh.myshopify.com', before(HOUR)));
  const e = schedulerEnv({ rows });
  const r = await runDueSyncs({ ...e.args, maxShops: 3 });
  // Oldest are s5 (15h), s4 (14h), s3 (13h).
  assert.equal(r.checked, 6);
  assert.equal(r.due, 5);
  assert.equal(r.synced, 3);
  assert.deepEqual(shopsProcessed(e), ['s5.myshopify.com', 's4.myshopify.com', 's3.myshopify.com']);
  assert.equal(r.results.length, 3);
});

test('runDueSyncs: default maxShops is 50', async () => {
  const rows = [];
  for (let i = 0; i < 52; i += 1) rows.push(row(`s${String(i).padStart(2, '0')}.myshopify.com`, null));
  const e = schedulerEnv({ rows });
  const r = await runDueSyncs(e.args);
  assert.equal(r.checked, 52);
  assert.equal(r.due, 52);
  assert.equal(r.results.length, 50);
  assert.equal(e.adminCalls.length, 50);
});

test('runDueSyncs: getAdmin throwing -> failed with shopify_auth, others still run, no sync attempted for it', async () => {
  const e = schedulerEnv({
    rows: [row('bad.myshopify.com', before(30 * HOUR)), row('good.myshopify.com', before(20 * HOUR))],
    getAdminThrows: ['bad.myshopify.com'],
  });
  const r = await runDueSyncs(e.args);
  assert.deepEqual([r.synced, r.failed, r.busy], [1, 1, 0]);
  assert.deepEqual(r.results.map((x) => [x.shop, x.ok]), [['bad.myshopify.com', false], ['good.myshopify.com', true]]);
  assert.equal(r.results[0].errorClass, 'shopify_auth');
  // Nothing was locked or released for the shop with no admin.
  assert.ok(!e.events.includes('lock:bad.myshopify.com'));
  assert.ok(!JSON.stringify(r).includes('offline token'), 'raw error text is not returned');
});

test('runDueSyncs: a held lock is counted busy, not failed, and the next shop still runs', async () => {
  const e = schedulerEnv({
    rows: [row('held.myshopify.com', before(30 * HOUR)), row('free.myshopify.com', before(20 * HOUR))],
    busyShops: ['held.myshopify.com'],
  });
  const r = await runDueSyncs(e.args);
  assert.deepEqual([r.synced, r.failed, r.busy], [1, 0, 1]);
  assert.equal(r.results[0].shop, 'held.myshopify.com');
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[0].errorClass, 'busy');
});

test('runDueSyncs: a sync failure (Shopify throttled) is counted failed with the sync errorClass', async () => {
  const e = schedulerEnv({
    rows: [row('t.myshopify.com', null), row('ok.myshopify.com', before(24 * HOUR))],
    adminFor: { 't.myshopify.com': createFakeAdmin(Array(4).fill(THROTTLED)) },
  });
  const r = await runDueSyncs(e.args);
  assert.deepEqual([r.synced, r.failed, r.busy], [1, 1, 0]);
  assert.deepEqual(r.results[0], { shop: 't.myshopify.com', ok: false, errorClass: 'shopify' });
});

test('runDueSyncs: counts add up: synced + failed + busy equals the processed count', async () => {
  const e = schedulerEnv({
    rows: [row('a.myshopify.com'), row('b.myshopify.com'), row('c.myshopify.com'), row('d.myshopify.com')],
    busyShops: ['b.myshopify.com'],
    getAdminThrows: ['c.myshopify.com'],
  });
  const r = await runDueSyncs(e.args);
  assert.equal(r.synced + r.failed + r.busy, r.results.length);
  assert.deepEqual([r.synced, r.failed, r.busy], [2, 1, 1]);
});

test('runDueSyncs: connection read rejecting -> resolved with error storage and all counts 0', async () => {
  const e = schedulerEnv({ rows: [], failOn: { 'salesforceConnection.findMany': new Error('db host unreachable') } });
  const r = await runDueSyncs(e.args);
  assert.equal(r.error, 'storage');
  assert.deepEqual([r.checked, r.due, r.synced, r.failed, r.busy], [0, 0, 0, 0, 0]);
  assert.deepEqual(r.results, []);
  assert.ok(!JSON.stringify(r).includes('unreachable'));
  assert.equal(e.adminCalls.length, 0);
});

test('runDueSyncs: success has no error field', async () => {
  const e = schedulerEnv({ rows: [row('a.myshopify.com')] });
  const r = await runDueSyncs(e.args);
  assert.equal(r.error, undefined);
});

test('runDueSyncs: never rejects, even with missing arguments or a broken prisma', async () => {
  for (const args of [undefined, {}, null, { prisma: undefined, now: NOW }]) {
    await assert.doesNotReject(runDueSyncs(args), String(args));
  }
  const prisma = { salesforceConnection: { findMany() { throw new Error('sync throw'); } } };
  const e = schedulerEnv({ rows: [] });
  const r = await runDueSyncs({ ...e.args, prisma });
  assert.equal(r.error, 'storage');
});

test('runDueSyncs: a plain fake with no lock delegate cannot make it reject', async () => {
  const prisma = createM6Prisma({ results: { 'salesforceConnection.findMany': [row('a.myshopify.com')] } });
  const e = schedulerEnv({ rows: [] });
  await assert.doesNotReject(runDueSyncs({ ...e.args, prisma }));
});

test('runDueSyncs: maxShops 0 processes nothing but still reports the backlog', async () => {
  const e = schedulerEnv({ rows: [row('a.myshopify.com'), row('b.myshopify.com')] });
  const r = await runDueSyncs({ ...e.args, maxShops: 0 });
  assert.deepEqual([r.checked, r.due, r.synced, r.results.length], [2, 2, 0, 0]);
  assert.equal(e.adminCalls.length, 0);
});

test('runDueSyncs: timestamps given as ISO strings are understood', async () => {
  const e = schedulerEnv({
    rows: [row('s.myshopify.com', before(7 * HOUR).toISOString(), before(10 * 60000).toISOString()), row('t.myshopify.com', before(7 * HOUR).toISOString(), null)],
  });
  const r = await runDueSyncs(e.args);
  // s had an error 10 minutes ago (inside the 1h backoff); t is due.
  assert.equal(r.due, 1);
  assert.deepEqual(e.adminCalls, ['t.myshopify.com']);
});

test('runDueSyncs: the input rows are not mutated by the sort', async () => {
  const rows = [row('b.myshopify.com', before(8 * HOUR)), row('a.myshopify.com', before(9 * HOUR))];
  const copy = rows.map((x) => ({ ...x }));
  const e = schedulerEnv({ rows });
  await runDueSyncs(e.args);
  assert.deepEqual(rows, copy);
});

// ------------------------------------------------------------------ hardening

const AUTH_LOST = 'Shopify access for this shop is no longer valid. Open the app to reconnect.';

test('runDueSyncs: a getAdmin failure is recorded with ONE updateMany on that shop', async () => {
  const e = schedulerEnv({ rows: [row('bad.myshopify.com'), row('good.myshopify.com', before(24 * HOUR))], getAdminThrows: ['bad.myshopify.com'] });
  await runDueSyncs(e.args);
  const writes = e.prisma.callsOf('salesforceConnection', 'updateMany');
  const forBad = writes.filter((c) => c.args.where.shop === 'bad.myshopify.com');
  assert.equal(forBad.length, 1);
  assert.deepEqual(forBad[0].args, {
    where: { shop: 'bad.myshopify.com' },
    data: { lastErrorClass: 'shopify_auth', lastErrorMessage: AUTH_LOST, lastErrorAt: NOW },
  });
  assert.equal(writes.filter((c) => c.args.where.shop === 'good.myshopify.com').length, 0);
});

test('runDueSyncs: a rejecting updateMany while recording a getAdmin failure is swallowed', async () => {
  const e = schedulerEnv({
    rows: [row('bad.myshopify.com'), row('good.myshopify.com', before(24 * HOUR))],
    getAdminThrows: ['bad.myshopify.com'],
    failOn: { 'salesforceConnection.updateMany': new Error('db down') },
  });
  const r = await runDueSyncs(e.args);
  assert.deepEqual([r.synced, r.failed], [1, 1]);
  assert.equal(r.results[0].errorClass, 'shopify_auth');
  assert.equal(r.error, undefined);
});

test('runDueSyncs: sorted by LAST ATTEMPT = max(lastSyncAt, lastErrorAt), never-attempted first', async () => {
  // Backoff 1h passes for all. Last attempts: x = max(30h, 2h) = 2h ago; y = max(10h, 20h) = 10h ago; z = 8h.
  const e = schedulerEnv({
    rows: [
      row('x.myshopify.com', before(30 * HOUR), before(2 * HOUR)),
      row('y.myshopify.com', before(10 * HOUR), before(20 * HOUR)),
      row('z.myshopify.com', before(8 * HOUR)),
      row('n.myshopify.com'),
    ],
  });
  await runDueSyncs({ ...e.args, intervalHours: 1 });
  // n (never) -> y (10h) -> z (8h) -> x (2h). x had an error 2h ago which is outside the 1h backoff.
  assert.deepEqual(e.adminCalls, ['n.myshopify.com', 'y.myshopify.com', 'z.myshopify.com', 'x.myshopify.com']);
});

test('runDueSyncs: a shop that keeps failing does not starve a healthy older-success shop', async () => {
  // flaky: synced 100h ago but failed 2h ago -> attempted 2h ago. healthy: synced 50h ago.
  const e = schedulerEnv({ rows: [row('flaky.myshopify.com', before(100 * HOUR), before(2 * HOUR)), row('healthy.myshopify.com', before(50 * HOUR))] });
  await runDueSyncs({ ...e.args, maxShops: 1 });
  assert.deepEqual(e.adminCalls, ['healthy.myshopify.com']);
});

test('runDueSyncs: maxDurationMs stops starting shops and reports deferred', async () => {
  const ticks = [0, 0, 100, 300]; // startedAt, then one reading before each shop
  let i = 0;
  const clock = () => ticks[Math.min(i++, ticks.length - 1)];
  const e = schedulerEnv({ rows: [row('a.myshopify.com'), row('b.myshopify.com'), row('c.myshopify.com'), row('d.myshopify.com')] });
  // Readings: startedAt 0; before a: 0 (<250 run); before b: 100 (run); before c: 300 (>=250 stop); d deferred too.
  const r = await runDueSyncs({ ...e.args, maxDurationMs: 250, clock });
  assert.equal(r.results.length, 2);
  assert.equal(r.synced, 2);
  assert.equal(r.deferred, 2);
  assert.equal(r.due, 4);
  assert.equal(e.adminCalls.length, 2);
});

test('runDueSyncs: the duration check uses >= (exactly maxDurationMs stops)', async () => {
  const readings = [0, 500];
  let i = 0;
  const e = schedulerEnv({ rows: [row('a.myshopify.com')] });
  const r = await runDueSyncs({ ...e.args, maxDurationMs: 500, clock: () => readings[Math.min(i++, 1)] });
  assert.equal(r.deferred, 1);
  assert.equal(r.results.length, 0);
});

test('runDueSyncs: no deferred property when everything started', async () => {
  const e = schedulerEnv({ rows: [row('a.myshopify.com'), row('b.myshopify.com')] });
  const r = await runDueSyncs({ ...e.args, clock: () => 0 });
  assert.equal('deferred' in r, false);
  const empty = await runDueSyncs({ ...schedulerEnv({ rows: [] }).args });
  assert.equal('deferred' in empty, false);
});

test('runDueSyncs: the default time budget is 240000 ms (just under: runs; at the limit: stops)', async () => {
  const under = schedulerEnv({ rows: [row('a.myshopify.com')] });
  let i = 0;
  const r1 = await runDueSyncs({ ...under.args, clock: () => (i++ === 0 ? 0 : 239999) });
  assert.equal(r1.synced, 1);
  const at = schedulerEnv({ rows: [row('a.myshopify.com')] });
  let j = 0;
  const r2 = await runDueSyncs({ ...at.args, clock: () => (j++ === 0 ? 0 : 240000) });
  assert.equal(r2.deferred, 1);
});

test('runDueSyncs: sleep is passed through to syncShop (throttle retries use it)', async () => {
  const slept = [];
  const e = schedulerEnv({ rows: [row('t.myshopify.com')], adminFor: { 't.myshopify.com': createFakeAdmin(Array(4).fill(THROTTLED)) } });
  await runDueSyncs({ ...e.args, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(slept, [1000, 2000, 4000]);
});
