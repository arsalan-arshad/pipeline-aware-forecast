// Tests for app/lib/sync-shop.server.js, written from the module contract.
// Real runPipelineSync, real Prisma-backed store and Salesforce client, over a fake Prisma,
// a fake fetch and a fake Shopify admin. No network, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncShop } from '../app/lib/sync-shop.server.js';
import { createFakeAdmin } from './fixtures/shell-fixtures.js';
import { createFakeFetch, tokenError, response, tokenOk, page, INSTANCE_URL } from './fixtures/salesforce-fixtures.js';
import {
  SHOP, TODAY, NOW, CLIENT_ID, CLIENT_SECRET, makeKey, storedConnection, createM5Prisma,
  sfDeal, salesforceFetch, workedExampleDeals, variantsBody, THROTTLED_BODY,
} from './fixtures/m5-fixtures.js';

const NOT_CONNECTED = 'Salesforce is not connected yet.';
const CREDS_MESSAGE = 'The stored Salesforce credentials could not be read. Please reconnect Salesforce.';
const STORAGE_MESSAGE = 'The sync data could not be read or saved.';

/** Build a full environment. Worked example deals by default; settings default to shipOffsetDays 0. */
function env(over = {}) {
  const key = over.key ?? makeKey();
  const prisma = over.prisma ?? createM5Prisma({
    connection: over.connection === undefined ? storedConnection(key) : over.connection,
    setting: over.setting === undefined ? { shop: SHOP, haircut: 1, shipOffsetDays: 0, horizonDays: 90 } : over.setting,
    overrides: over.overrides ?? [],
    failOn: over.failOn ?? {},
    transactionError: over.transactionError,
  });
  const fetchImpl = over.fetchImpl ?? salesforceFetch(over.deals ?? workedExampleDeals());
  const admin = over.admin ?? createFakeAdmin([variantsBody(over.skus ?? ['SKU-X', 'SKU-Y'])]);
  // sleep is a no-op: Shopify throttling is retried with real delays otherwise.
  const args = { prisma, shop: SHOP, admin, encryptionKey: key, today: TODAY, now: NOW, fetchImpl, sleep: async () => {}, ...(over.args ?? {}) };
  return { key, prisma, fetchImpl, admin, args };
}

// The shop lock (syncLock.create ... syncLock.deleteMany) wraps every run that passes validation.
// createM5Prisma answers a lock create with a plain descriptor, which counts as "acquired".
const lockCreates = (prisma) => prisma.callsOf('syncLock', 'create');
const lockReleases = (prisma) => prisma.callsOf('syncLock', 'deleteMany');
const heldByOther = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const failureWrites = (prisma) => prisma.callsOf('salesforceConnection', 'updateMany');

function opsOf(prisma, model, method) {
  assert.equal(prisma.transactions.length, 1, 'exactly one transaction');
  return prisma.transactions[0].filter((o) => o.model === model && o.method === method);
}

// ------------------------------------------------------------------ validation

const NOW_BAD = [['invalid Date', new Date('nope')], ['string', '2026-01-01T00:00:00Z'], ['undefined', undefined], ['number', 5]];
const TODAY_BAD = [['not a date', 'today'], ['impossible day', '2026-02-30'], ['month 13', '2026-13-01'], ['day 31 in April', '2026-04-31'], ['unpadded', '2026-1-1'], ['undefined', undefined], ['number', 20260101], ['with time', '2026-01-01T00:00:00Z']];

for (const [label, bad] of [['empty', ''], ['undefined', undefined], ['number', 1], ['null', null]]) {
  test(`syncShop: invalid shop (${label}) -> config failure, zero prisma calls`, async () => {
    const e = env({ args: { shop: bad } });
    const r = await syncShop(e.args);
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'config');
    assert.equal(typeof r.message, 'string');
    assert.equal(e.prisma.calls.length, 0);
    assert.equal(e.fetchImpl.calls.length, 0);
  });
}

for (const [label, bad] of [['missing', undefined], ['no graphql', {}], ['graphql not a function', { graphql: 'x' }], ['null', null]]) {
  test(`syncShop: invalid admin (${label}) -> config failure, zero prisma calls`, async () => {
    const e = env({ args: { admin: bad } });
    const r = await syncShop(e.args);
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'config');
    assert.equal(e.prisma.calls.length, 0);
  });
}

for (const [label, bad] of TODAY_BAD) {
  test(`syncShop: invalid today (${label}) -> config failure, zero prisma calls`, async () => {
    const e = env({ args: { today: bad } });
    const r = await syncShop(e.args);
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'config');
    assert.equal(e.prisma.calls.length, 0);
  });
}

for (const [label, bad] of NOW_BAD) {
  test(`syncShop: invalid now (${label}) -> config failure, zero prisma calls`, async () => {
    const e = env({ args: { now: bad } });
    const r = await syncShop(e.args);
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'config');
    assert.equal(e.prisma.calls.length, 0);
  });
}

test('syncShop: never rejects, even with no arguments or an empty object', async () => {
  for (const args of [undefined, {}, null]) {
    const r = await syncShop(args);
    assert.equal(r.ok, false, String(args));
    assert.equal(r.errorClass, 'config', String(args));
  }
});

// ------------------------------------------------------------------ not connected / credentials

test('syncShop: no connection row -> not_connected and nothing is recorded', async () => {
  const e = env({ connection: null });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'not_connected', message: NOT_CONNECTED });
  assert.deepEqual(e.prisma.callsOf('salesforceConnection', 'findUnique').map((c) => c.args), [{ where: { shop: SHOP } }]);
  assert.equal(failureWrites(e.prisma).length, 0);
  assert.equal(e.prisma.transactions.length, 0);
  assert.equal(e.fetchImpl.calls.length, 0);
  assert.equal(e.admin.calls.length, 0);
});

test('syncShop: credentials under another key -> one updateMany with the credentials error, returned', async () => {
  const e = env({ connection: storedConnection(makeKey()) });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'credentials', message: CREDS_MESSAGE });
  const writes = failureWrites(e.prisma);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, {
    where: { shop: SHOP },
    data: { lastErrorClass: 'credentials', lastErrorMessage: CREDS_MESSAGE, lastErrorAt: new Date(NOW) },
  });
  assert.equal(e.prisma.transactions.length, 0);
  assert.equal(e.fetchImpl.calls.length, 0);
  assert.equal(e.admin.calls.length, 0);
});

test('syncShop: corrupted stored credential -> credentials error recorded', async () => {
  const key = makeKey();
  const e = env({ key, connection: storedConnection(key, { clientIdEnc: 'garbage' }) });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'credentials', message: CREDS_MESSAGE });
  assert.equal(failureWrites(e.prisma).length, 1);
});

test('syncShop: invalid server key -> credentials error recorded, no rejection', async () => {
  const key = makeKey();
  const e = env({ key, args: { encryptionKey: 'not-a-key' } });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'credentials', message: CREDS_MESSAGE });
  assert.equal(failureWrites(e.prisma).length, 1);
});

test('syncShop: stored instanceUrl off the allow-list -> recorded with the client error and returned', async () => {
  const key = makeKey();
  const e = env({ key, connection: storedConnection(key, { instanceUrl: 'http://evil.example.com' }) });
  const r = await syncShop(e.args);
  const message = 'instanceUrl must be an https Salesforce My Domain address, e.g. https://yourcompany.my.salesforce.com.';
  assert.deepEqual(r, { ok: false, errorClass: 'config', message });
  const writes = failureWrites(e.prisma);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, {
    where: { shop: SHOP },
    data: { lastErrorClass: 'config', lastErrorMessage: message, lastErrorAt: new Date(NOW) },
  });
  assert.equal(e.fetchImpl.calls.length, 0);
});

// ------------------------------------------------------------------ settings reads

test('syncShop: reads settings and overrides by shop', async () => {
  const e = env();
  await syncShop(e.args);
  assert.deepEqual(e.prisma.callsOf('pipelineSetting', 'findUnique').map((c) => c.args), [{ where: { shop: SHOP } }]);
  assert.deepEqual(e.prisma.callsOf('stageProbabilityOverride', 'findMany').map((c) => c.args), [{ where: { shop: SHOP } }]);
});

// ------------------------------------------------------------------ happy path

test('syncShop: README worked example lands as two weekly snapshot rows in one transaction', async () => {
  const e = env();
  const r = await syncShop(e.args);
  // 1 SKU, 2 weekly rows, 1 unmatched product (NOPE-1).
  assert.deepEqual(r, { ok: true, syncedAt: NOW.toISOString(), skuCount: 1, rowCount: 2, unmatchedCount: 1 });

  // Deal A day 20 -> Monday 2026-01-19, 300 * 50% = 150 weighted. Deal B day 30 -> Monday 2026-01-26,
  // 200 * 20% = 40 weighted.
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(snapshotCreate.args.data, [
    { shop: SHOP, sku: 'SKU-X', weekStart: new Date('2026-01-19T00:00:00.000Z'), weightedQty: 150, rawQty: 300, openDealCount: 1, syncedAt: NOW },
    { shop: SHOP, sku: 'SKU-X', weekStart: new Date('2026-01-26T00:00:00.000Z'), weightedQty: 40, rawQty: 200, openDealCount: 1, syncedAt: NOW },
  ]);

  const [unmatchedCreate] = opsOf(e.prisma, 'unmatchedProduct', 'createMany');
  assert.deepEqual(unmatchedCreate.args.data, [
    { shop: SHOP, productCode: 'NOPE-1', openDealCount: 1, rawQty: 5, syncedAt: NOW },
  ]);

  // Old rows are replaced and the connection's error fields are cleared in the same batch.
  assert.equal(opsOf(e.prisma, 'pipelineSnapshot', 'deleteMany').length, 1);
  assert.equal(opsOf(e.prisma, 'unmatchedProduct', 'deleteMany').length, 1);
  const [conn] = opsOf(e.prisma, 'salesforceConnection', 'update');
  assert.deepEqual(conn.args, {
    where: { shop: SHOP },
    data: { lastSyncAt: NOW, lastErrorClass: null, lastErrorMessage: null, lastErrorAt: null },
  });
  // Success records no separate failure write.
  assert.equal(failureWrites(e.prisma).length, 0);
});

test('syncShop: the Salesforce requests use the decrypted credentials and the horizon date', async () => {
  const e = env();
  await syncShop(e.args);
  const tokenCall = e.fetchImpl.calls[0];
  assert.match(tokenCall.url, /\/services\/oauth2\/token$/);
  const form = new URLSearchParams(tokenCall.body);
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.equal(form.get('client_secret'), CLIENT_SECRET);
  // horizonDays 90 from 2026-01-01: Jan 31 + Feb 28 + Mar 31 = 90 days -> 2026-04-01.
  const query = new URL(e.fetchImpl.calls[1].url).searchParams.get('q');
  assert.match(query, /CloseDate <= 2026-04-01 /);
});

test('syncShop: no pipelineSetting row -> defaults haircut 1, shipOffsetDays 7, horizonDays 90', async () => {
  const e = env({ setting: null });
  const r = await syncShop(e.args);
  assert.equal(r.ok, true);
  // Offset 7: Jan 21 -> Jan 28 (Wed) -> Monday Jan 26, weighted 150; Jan 31 -> Feb 7 (Sat) -> Monday Feb 2, weighted 40.
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(
    snapshotCreate.args.data.map((d) => [d.weekStart.toISOString().slice(0, 10), d.weightedQty, d.rawQty]),
    [['2026-01-26', 150, 300], ['2026-02-02', 40, 200]],
  );
  const query = new URL(e.fetchImpl.calls[1].url).searchParams.get('q');
  assert.match(query, /CloseDate <= 2026-04-01 /);
});

test('syncShop: haircut from the settings row scales weighted quantity only', async () => {
  const e = env({ setting: { shop: SHOP, haircut: 0.5, shipOffsetDays: 0, horizonDays: 90 } });
  await syncShop(e.args);
  // 300 * 50% * 0.5 = 75 ; 200 * 20% * 0.5 = 20 ; raw unchanged.
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(snapshotCreate.args.data.map((d) => [d.weightedQty, d.rawQty]), [[75, 300], [20, 200]]);
});

test('syncShop: stage override replaces the Salesforce probability', async () => {
  const e = env({ overrides: [{ id: 'o1', shop: SHOP, stageName: 'Value Proposition', probability: 100 }] });
  await syncShop(e.args);
  // Deal A: 300 * 100% = 300 (was 150). Deal B unchanged at 40.
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(snapshotCreate.args.data.map((d) => d.weightedQty), [300, 40]);
});

test('syncShop: horizonDays from the settings row drops later deals and shortens the query', async () => {
  const e = env({ setting: { shop: SHOP, haircut: 1, shipOffsetDays: 0, horizonDays: 25 } });
  const r = await syncShop(e.args);
  // Deal B ships on day 30 > 25 so it is excluded; only the day-20 row remains.
  assert.deepEqual(r, { ok: true, syncedAt: NOW.toISOString(), skuCount: 1, rowCount: 1, unmatchedCount: 1 });
  const query = new URL(e.fetchImpl.calls[1].url).searchParams.get('q');
  assert.match(query, /CloseDate <= 2026-01-26 /); // 2026-01-01 + 25 days
});

test('syncShop: no open deals still succeeds and replaces the old snapshot with nothing', async () => {
  const e = env({ deals: [] });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: true, syncedAt: NOW.toISOString(), skuCount: 0, rowCount: 0, unmatchedCount: 0 });
  assert.equal(opsOf(e.prisma, 'pipelineSnapshot', 'deleteMany').length, 1);
  assert.equal(opsOf(e.prisma, 'pipelineSnapshot', 'createMany').length, 0);
  assert.equal(opsOf(e.prisma, 'salesforceConnection', 'update').length, 1);
});

test('syncShop: Shopify SKU matching is case-insensitive and keeps the Shopify spelling', async () => {
  const e = env({ deals: [sfDeal('d1', 'Negotiation', 100, '2026-01-21', [['  sku-x ', 10]])], skus: ['SKU-X'] });
  const r = await syncShop(e.args);
  assert.equal(r.ok, true);
  assert.equal(r.unmatchedCount, 0);
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(snapshotCreate.args.data.map((d) => [d.sku, d.weightedQty]), [['SKU-X', 10]]);
});

// ------------------------------------------------------------------ failures recorded

test('syncShop: Shopify throttling is recorded as a shopify failure and returned', async () => {
  const e = env({ admin: createFakeAdmin(Array(4).fill(THROTTLED_BODY)) });
  const r = await syncShop(e.args);
  const message = 'Shopify is rate limiting requests. Try again shortly.';
  assert.deepEqual(r, { ok: false, errorClass: 'shopify', message });
  const writes = failureWrites(e.prisma);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, {
    where: { shop: SHOP },
    data: { lastErrorClass: 'shopify', lastErrorMessage: message, lastErrorAt: new Date(NOW) },
  });
  assert.equal(e.prisma.transactions.length, 0, 'last good snapshot untouched');
});

test('syncShop: other Shopify data errors are also class shopify with the userMessage', async () => {
  const e = env({ admin: createFakeAdmin([{ errors: [{ message: 'nope' }] }]) });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'shopify', message: 'Shopify rejected the data request.' });
  assert.equal(failureWrites(e.prisma).length, 1);
  assert.equal(e.prisma.transactions.length, 0);
});

test('syncShop: Salesforce auth failure is recorded with the client class and message', async () => {
  const e = env({ fetchImpl: createFakeFetch([tokenError(400, 'invalid_client')]) });
  const r = await syncShop(e.args);
  const message = 'Salesforce did not recognise the client ID or client secret.';
  assert.deepEqual(r, { ok: false, errorClass: 'auth', message });
  const writes = failureWrites(e.prisma);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args.data, { lastErrorClass: 'auth', lastErrorMessage: message, lastErrorAt: new Date(NOW) });
  assert.equal(e.prisma.transactions.length, 0);
  // Neither the stored secret nor the client id is echoed anywhere.
  const dump = JSON.stringify([r, writes[0].args]);
  assert.ok(!dump.includes(CLIENT_SECRET));
  assert.ok(!dump.includes(CLIENT_ID));
});

test('syncShop: a Salesforce network failure is recorded as network', async () => {
  const e = env({ fetchImpl: createFakeFetch([{ reject: new TypeError('fetch failed') }]) });
  const r = await syncShop(e.args);
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'network');
  assert.equal(failureWrites(e.prisma).length, 1);
  assert.equal(failureWrites(e.prisma)[0].args.data.lastErrorClass, 'network');
});

test('syncShop: an unexpected Salesforce shape is a resolved failure with a recorded error', async () => {
  const e = env({ fetchImpl: createFakeFetch([tokenOk(INSTANCE_URL), response(200, { nothing: true })]) });
  const r = await syncShop(e.args);
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'unexpected_response');
  assert.equal(failureWrites(e.prisma).length, 1);
  assert.equal(e.prisma.transactions.length, 0);
});

test('syncShop: a Shopify admin that throws a plain error still resolves as a failure', async () => {
  const admin = { graphql: async () => { throw new Error('socket hang up'); } };
  const e = env({ admin });
  const r = await syncShop(e.args);
  assert.equal(r.ok, false);
  assert.equal(typeof r.errorClass, 'string');
  assert.ok(!JSON.stringify(r).includes('socket'), 'raw error text is not returned');
  assert.equal(e.prisma.transactions.length, 0);
});

// ------------------------------------------------------------------ storage failures

for (const key of ['salesforceConnection.findUnique', 'pipelineSetting.findUnique', 'stageProbabilityOverride.findMany']) {
  test(`syncShop: rejecting ${key} -> storage failure, no rejection`, async () => {
    const e = env({ failOn: { [key]: new Error('connection refused to db host') } });
    const r = await syncShop(e.args);
    assert.deepEqual(r, { ok: false, errorClass: 'storage', message: STORAGE_MESSAGE });
    assert.equal(e.prisma.transactions.length, 0);
    assert.equal(e.fetchImpl.calls.length, 0, 'no Salesforce traffic once a read failed');
    assert.ok(!JSON.stringify(r).includes('refused'));
  });
}

test('syncShop: a failing write transaction resolves as a storage failure and keeps old data', async () => {
  const e = env({ transactionError: new Error('deadlock detected') });
  const r = await syncShop(e.args);
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'storage');
  assert.ok(!JSON.stringify(r).includes('deadlock'));
  // The only transaction attempted is the (failed) success batch; failure is recorded by updateMany.
  assert.equal(e.prisma.transactions.length, 1);
  assert.equal(failureWrites(e.prisma).length, 1);
  assert.equal(failureWrites(e.prisma)[0].args.data.lastErrorClass, 'storage');
});

test('syncShop: inputs are not mutated and a repeat run gives an identical result', async () => {
  const a = env();
  const b = env();
  const ra = await syncShop(a.args);
  const rb = await syncShop(b.args);
  assert.deepEqual(ra, rb);
  assert.deepEqual(a.prisma.transactions, b.prisma.transactions);
  assert.equal(NOW.toISOString(), '2026-01-01T12:00:00.000Z');
});

// ------------------------------------------------------------------ extra branches

test('syncShop: haircut 0 in the settings row is honoured (0 is not "missing")', async () => {
  const e = env({ setting: { shop: SHOP, haircut: 0, shipOffsetDays: 0, horizonDays: 90 } });
  const r = await syncShop(e.args);
  assert.equal(r.ok, true);
  // Weighted quantity is 0 for both deals; raw quantities and deal counts remain.
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(snapshotCreate.args.data.map((d) => [d.weightedQty, d.rawQty, d.openDealCount]), [[0, 300, 1], [0, 200, 1]]);
});

test('syncShop: a stage override of 0 is honoured (0 is not "missing")', async () => {
  const e = env({ overrides: [{ id: 'o1', shop: SHOP, stageName: 'Value Proposition', probability: 0 }] });
  await syncShop(e.args);
  // Deal A: 300 * 0% = 0 (was 150). Deal B unchanged at 40.
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(snapshotCreate.args.data.map((d) => d.weightedQty), [0, 40]);
});

test('syncShop: an override for an unrelated stage changes nothing', async () => {
  const e = env({ overrides: [{ id: 'o1', shop: SHOP, stageName: 'Some Other Stage', probability: 100 }] });
  await syncShop(e.args);
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(snapshotCreate.args.data.map((d) => d.weightedQty), [150, 40]);
});

test('syncShop: a failure that cannot be recorded (updateMany rejects) is still returned', async () => {
  const e = env({
    admin: createFakeAdmin(Array(4).fill(THROTTLED_BODY)),
    failOn: { 'salesforceConnection.updateMany': new Error('db gone') },
  });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'shopify', message: 'Shopify is rate limiting requests. Try again shortly.' });
});

test('syncShop: a credentials failure that cannot be recorded is still returned', async () => {
  const e = env({
    connection: storedConnection(makeKey()),
    failOn: { 'salesforceConnection.updateMany': new Error('db gone') },
  });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'credentials', message: CREDS_MESSAGE });
});

test('syncShop: a non-function fetchImpl is a recorded config failure, not a rejection', async () => {
  const e = env({ args: { fetchImpl: 'not a function' } });
  const r = await syncShop(e.args);
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'config');
  assert.equal(failureWrites(e.prisma).length, 1);
  assert.equal(e.prisma.transactions.length, 0);
});

test('syncShop: a missing prisma client resolves as a failure rather than rejecting', async () => {
  const e = env();
  const r = await syncShop({ ...e.args, prisma: undefined });
  assert.equal(r.ok, false);
  assert.equal(typeof r.errorClass, 'string');
});

test('syncShop: success text never contains credentials', async () => {
  const e = env();
  const r = await syncShop(e.args);
  const dump = JSON.stringify([r, e.prisma.calls.map((c) => c.args)]);
  assert.ok(!dump.includes(CLIENT_SECRET));
  assert.ok(!dump.includes(CLIENT_ID));
});

// ------------------------------------------------------------------ shop lock

test('syncShop: takes the lock for now + 30 minutes and releases exactly that lock', async () => {
  const e = env();
  await syncShop(e.args);
  assert.deepEqual(lockCreates(e.prisma).map((c) => c.args), [
    // 2026-01-01T12:00:00Z + 30 min = 12:30:00Z.
    { data: { shop: SHOP, lockedUntil: new Date('2026-01-01T12:30:00.000Z') } },
  ]);
  // The delete is conditional on the exact lockedUntil this run set.
  assert.deepEqual(lockReleases(e.prisma).map((c) => c.args), [
    { where: { shop: SHOP, lockedUntil: new Date('2026-01-01T12:30:00.000Z') } },
  ]);
});

test('syncShop: the lock is taken BEFORE the connection is read, and released LAST', async () => {
  const e = env();
  await syncShop(e.args);
  const order = e.prisma.calls.map((c) => `${c.model}.${c.method}`);
  assert.ok(order.indexOf('syncLock.create') >= 0);
  assert.ok(order.indexOf('syncLock.create') < order.indexOf('salesforceConnection.findUnique'), order.join(','));
  assert.equal(order[0], 'syncLock.create', 'nothing touches the database before the lock');
  assert.equal(order[order.length - 1], 'syncLock.deleteMany', 'release is the last call');
});

test('syncShop: lock held by another run (P2002, nothing to take over) -> busy, nothing recorded', async () => {
  const e = env({ failOn: { 'syncLock.create': heldByOther() } });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'busy', message: 'A sync is already running for this shop. Try again in a minute.' });
  assert.equal(e.prisma.callsOf('salesforceConnection', 'findUnique').length, 0, 'no connection lookup');
  assert.equal(failureWrites(e.prisma).length, 0, 'nothing recorded on the connection');
  assert.equal(e.prisma.transactions.length, 0);
  assert.equal(e.fetchImpl.calls.length, 0);
  assert.equal(e.admin.calls.length, 0);
  // Only the attempt itself touched the lock; the other run's lock is not released by this one.
  assert.deepEqual(e.prisma.calls.map((c) => `${c.model}.${c.method}`), ['syncLock.create', 'syncLock.updateMany']);
  assert.equal(lockReleases(e.prisma).length, 0);
});

test('syncShop: an expired lock held by a crashed run is taken over and the sync proceeds', async () => {
  const e = env({ failOn: { 'syncLock.create': heldByOther() } });
  const wrapped = new Proxy(e.prisma, {
    get(t, p) {
      if (p !== 'syncLock') return t[p];
      // Take-over succeeds: the conditional updateMany reports one row.
      return { create: (a) => t.syncLock.create(a), deleteMany: (a) => t.syncLock.deleteMany(a), updateMany: async (a) => { t.syncLock.updateMany(a); return { count: 1 }; } };
    },
  });
  const r = await syncShop({ ...e.args, prisma: wrapped });
  assert.equal(r.ok, true);
  assert.equal(lockReleases(e.prisma).length, 1);
});

test('syncShop: lock acquisition throwing (not a unique violation) -> storage failure, nothing else touched', async () => {
  const e = env({ failOn: { 'syncLock.create': new Error('connection refused to db host') } });
  const r = await syncShop(e.args);
  assert.deepEqual(r, { ok: false, errorClass: 'storage', message: STORAGE_MESSAGE });
  assert.ok(!JSON.stringify(r).includes('refused'));
  assert.equal(e.prisma.callsOf('salesforceConnection', 'findUnique').length, 0);
  assert.equal(failureWrites(e.prisma).length, 0);
  assert.equal(lockReleases(e.prisma).length, 0, 'never acquired, so nothing to release');
  assert.equal(e.fetchImpl.calls.length, 0);
});

test('syncShop: lock released after a successful sync', async () => {
  const e = env();
  const r = await syncShop(e.args);
  assert.equal(r.ok, true);
  assert.equal(lockReleases(e.prisma).length, 1);
});

test('syncShop: lock released after a recorded failure (Shopify throttled)', async () => {
  const e = env({ admin: createFakeAdmin(Array(4).fill(THROTTLED_BODY)) });
  const r = await syncShop(e.args);
  assert.equal(r.errorClass, 'shopify');
  assert.equal(failureWrites(e.prisma).length, 1);
  assert.equal(lockReleases(e.prisma).length, 1);
});

test('syncShop: lock released on not_connected, credentials failure and storage read failure', async () => {
  const a = env({ connection: null });
  assert.equal((await syncShop(a.args)).errorClass, 'not_connected');
  assert.equal(lockReleases(a.prisma).length, 1);
  const b = env({ connection: storedConnection(makeKey()) });
  assert.equal((await syncShop(b.args)).errorClass, 'credentials');
  assert.equal(lockReleases(b.prisma).length, 1);
  const c = env({ failOn: { 'pipelineSetting.findUnique': new Error('db') } });
  assert.equal((await syncShop(c.args)).errorClass, 'storage');
  assert.equal(lockReleases(c.prisma).length, 1);
});

test('syncShop: lock released after an unexpected crash, and the result still resolves', async () => {
  // A number is not iterable: the loop over the override rows throws outside the storage try/catch.
  const e = env({ overrides: 5 });
  const r = await syncShop(e.args);
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'unexpected_response');
  assert.equal(lockReleases(e.prisma).length, 1);
  assert.equal(lockReleases(e.prisma)[0].args.where.shop, SHOP);
});

test('syncShop: lock released after a failing write transaction', async () => {
  const e = env({ transactionError: new Error('deadlock detected') });
  const r = await syncShop(e.args);
  assert.equal(r.errorClass, 'storage');
  assert.equal(lockReleases(e.prisma).length, 1);
});

test('syncShop: a release that fails does not change the result', async () => {
  const e = env({ failOn: { 'syncLock.deleteMany': new Error('release broke') } });
  const r = await syncShop(e.args);
  assert.equal(r.ok, true);
});

test('syncShop: invalid input never touches the lock (validation runs first)', async () => {
  for (const over of [{ shop: '' }, { today: 'x' }, { now: new Date('x') }, { admin: null }]) {
    const e = env({ args: over });
    const r = await syncShop(e.args);
    assert.equal(r.errorClass, 'config');
    assert.equal(e.prisma.calls.length, 0);
  }
});

test('syncShop: two runs for one shop, the second while the first holds the lock, is busy', async () => {
  // First run is paused inside the Shopify call; the second run starts then.
  const key = makeKey();
  const table = new Map();
  const shared = new Proxy(createM5Prisma({ connection: storedConnection(key), setting: null }), {
    get(t, p) {
      if (p !== 'syncLock') return t[p];
      return {
        create: async ({ data }) => {
          t.syncLock.create({ data });
          if (table.has(data.shop)) throw heldByOther();
          table.set(data.shop, data.lockedUntil.getTime());
          return data;
        },
        updateMany: async (a) => { t.syncLock.updateMany(a); return { count: 0 }; },
        deleteMany: async (a) => { t.syncLock.deleteMany(a); table.delete(a.where.shop); return { count: 1 }; },
      };
    },
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowAdmin = { async graphql() { await gate; return { json: async () => variantsBody(['SKU-X']) }; } };
  const args = { prisma: shared, shop: SHOP, encryptionKey: key, today: TODAY, now: NOW, fetchImpl: salesforceFetch(workedExampleDeals()) };
  const first = syncShop({ ...args, admin: slowAdmin });
  await new Promise((r) => setImmediate(r));
  const second = await syncShop({ ...args, admin: createFakeAdmin([variantsBody(['SKU-X'])]) });
  assert.equal(second.errorClass, 'busy');
  release();
  assert.equal((await first).ok, true);
  assert.equal(table.size, 0, 'lock table empty after the first run finishes');
  const third = await syncShop({ ...args, admin: createFakeAdmin([variantsBody(['SKU-X'])]) });
  assert.equal(third.ok, true);
});

// ------------------------------------------------------------------ hardening: too_soon, sleep, null prototype

const TOO_SOON = { ok: false, errorClass: 'too_soon', message: 'A sync just ran. Please wait a minute and try again.' };
const MIN = 60000;
const agoMs = (ms) => new Date(NOW.getTime() - ms);

test('syncShop: minIntervalMs with a sync 30 s ago -> too_soon, nothing recorded, lock released', async () => {
  const key = makeKey();
  const e = env({ key, connection: storedConnection(key, { lastSyncAt: agoMs(30000) }), args: { minIntervalMs: MIN } });
  const r = await syncShop(e.args);
  assert.deepEqual(r, TOO_SOON);
  assert.equal(failureWrites(e.prisma).length, 0);
  assert.equal(e.prisma.transactions.length, 0);
  assert.equal(e.fetchImpl.calls.length, 0);
  assert.equal(e.admin.calls.length, 0);
  assert.equal(lockReleases(e.prisma).length, 1);
  // Checked after the connection read, before the client is built or settings are read.
  assert.equal(e.prisma.callsOf('pipelineSetting', 'findUnique').length, 0);
});

test('syncShop: too_soon also looks at lastErrorAt (the later of the two counts)', async () => {
  const key = makeKey();
  const e = env({ key, connection: storedConnection(key, { lastSyncAt: agoMs(3600000), lastErrorAt: agoMs(10000), lastErrorClass: 'network' }), args: { minIntervalMs: MIN } });
  assert.deepEqual(await syncShop(e.args), TOO_SOON);
});

test('syncShop: exactly minIntervalMs ago proceeds; one ms less is too_soon', async () => {
  const key = makeKey();
  const edge = env({ key, connection: storedConnection(key, { lastSyncAt: agoMs(MIN) }), args: { minIntervalMs: MIN } });
  assert.equal((await syncShop(edge.args)).ok, true);
  const key2 = makeKey();
  const inside = env({ key: key2, connection: storedConnection(key2, { lastSyncAt: agoMs(MIN - 1) }), args: { minIntervalMs: MIN } });
  assert.deepEqual(await syncShop(inside.args), TOO_SOON);
});

test('syncShop: never-attempted rows and old attempts proceed under minIntervalMs', async () => {
  const a = env({ args: { minIntervalMs: MIN } });
  assert.equal((await syncShop(a.args)).ok, true);
  const key = makeKey();
  const b = env({ key, connection: storedConnection(key, { lastSyncAt: agoMs(3600000) }), args: { minIntervalMs: MIN } });
  assert.equal((await syncShop(b.args)).ok, true);
});

test('syncShop: without minIntervalMs (or with 0, negative, NaN) a recent sync does not block', async () => {
  for (const minIntervalMs of [undefined, 0, -5, NaN]) {
    const key = makeKey();
    const e = env({ key, connection: storedConnection(key, { lastSyncAt: agoMs(1000) }), args: { minIntervalMs } });
    assert.equal((await syncShop(e.args)).ok, true, String(minIntervalMs));
  }
});

test('syncShop: a stage named __proto__ is ordinary data and does not leak onto other stages', async () => {
  const e = env({ overrides: [{ id: 'o1', shop: SHOP, stageName: '__proto__', probability: 100 }] });
  const r = await syncShop(e.args);
  assert.equal(r.ok, true);
  // Deals keep their own probabilities (150 and 40), the __proto__ stage matches no deal.
  const [snapshotCreate] = opsOf(e.prisma, 'pipelineSnapshot', 'createMany');
  assert.deepEqual(snapshotCreate.args.data.map((d) => d.weightedQty), [150, 40]);
});

test('syncShop: Shopify throttling is retried through the injected sleep (1s, 2s, 4s) then given up', async () => {
  const slept = [];
  const e = env({
    admin: createFakeAdmin([THROTTLED_BODY, THROTTLED_BODY, THROTTLED_BODY, THROTTLED_BODY]),
    args: { sleep: async (ms) => { slept.push(ms); } },
  });
  const r = await syncShop(e.args);
  assert.equal(r.errorClass, 'shopify');
  assert.deepEqual(slept, [1000, 2000, 4000]);
  assert.equal(e.admin.calls.length, 4, 'one try plus three retries');
});

test('syncShop: a throttle that clears on retry still syncs', async () => {
  const e = env({ admin: createFakeAdmin([THROTTLED_BODY, variantsBody(['SKU-X'])]) });
  const r = await syncShop(e.args);
  assert.equal(r.ok, true);
});
