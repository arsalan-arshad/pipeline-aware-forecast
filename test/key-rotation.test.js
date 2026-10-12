/**
 * Tests for re-encrypting stored Salesforce credentials under a new key (written from the contract).
 * Real crypto, fake Prisma, keys generated in memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reencryptConnections } from '../app/lib/key-rotation.server.js';
import { decryptSecret, encryptSecret } from '../app/lib/pipeline/credentials-crypto.server.js';
import { makeKey, makeRows, rotationPrisma } from './fixtures/m7-fixtures.js';

const SHOPS = ['b-shop.myshopify.com', 'a-shop.myshopify.com', 'c-shop.myshopify.com'];
const BAD_KEYS = 'Both keys must be 64 hex characters.';
const SAME_KEY = 'The new key must differ from the old key.';
const UNREADABLE = 'Some stored credentials could not be decrypted with the old key. Nothing was changed.';
const STORAGE = 'The credentials could not be read or saved. Nothing was changed.';

const writes = (prisma) => prisma.calls.filter((c) => c.method !== 'findMany');
const leaks = (result, strings) => {
  const text = JSON.stringify(result);
  for (const s of strings) assert.ok(!text.includes(s), 'result must not contain a key, secret or ciphertext');
};

// ---- validation: first, and with zero Prisma calls ----

test('invalid keys give a config error and make no Prisma call', async () => {
  const good = makeKey();
  const bad = [undefined, null, '', 'abc', 'g'.repeat(64), good.slice(1), `${good}0`, 12345, {}, ` ${good}`];
  for (const b of bad) {
    for (const [oldKey, newKey] of [[b, good], [good, b], [b, b]]) {
      const prisma = rotationPrisma([]);
      const res = await reencryptConnections({ prisma, oldKey, newKey });
      assert.deepEqual(res, { ok: false, errorClass: 'config', message: BAD_KEYS }, JSON.stringify([oldKey, newKey]));
      assert.equal(prisma.calls.length, 0);
    }
  }
});

test('identical keys (also differing only in letter case) give a config error and make no Prisma call', async () => {
  const key = 'ab'.repeat(32);
  for (const [oldKey, newKey] of [[key, key], [key, key.toUpperCase()], [key.toUpperCase(), key]]) {
    const prisma = rotationPrisma([]);
    const res = await reencryptConnections({ prisma, oldKey, newKey });
    assert.deepEqual(res, { ok: false, errorClass: 'config', message: SAME_KEY });
    assert.equal(prisma.calls.length, 0);
  }
});

test('an uppercase hex key is accepted as a valid key', async () => {
  const oldKey = makeKey();
  const newKey = makeKey().toUpperCase();
  const { rows } = makeRows(oldKey, [SHOPS[0]]);
  const res = await reencryptConnections({ prisma: rotationPrisma(rows), oldKey, newKey });
  assert.deepEqual(res, { ok: true, rotated: 1 });
});

test('an empty argument object never rejects', async () => {
  const res = await reencryptConnections({});
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, 'config');
});

test('a missing prisma never rejects', async () => {
  const res = await reencryptConnections({ oldKey: makeKey(), newKey: makeKey() });
  assert.equal(res.ok, false);
  assert.equal(typeof res.errorClass, 'string');
  assert.equal(typeof res.message, 'string');
});

// ---- success ----

test('success: reads once with the narrow select, then one transaction of per-shop updates', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const { rows, plain } = makeRows(oldKey, SHOPS);
  const prisma = rotationPrisma(rows);
  const res = await reencryptConnections({ prisma, oldKey, newKey });
  assert.deepEqual(res, { ok: true, rotated: 3 });

  const reads = prisma.callsOf('salesforceConnection', 'findMany');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].args, {
    select: { shop: true, clientIdEnc: true, clientSecretEnc: true },
    orderBy: { shop: 'asc' },
  });

  assert.equal(prisma.transactions.length, 1);
  const ops = prisma.transactions[0];
  assert.equal(ops.length, 3);
  const byShop = {};
  for (const op of ops) {
    assert.equal(op.model, 'salesforceConnection');
    assert.equal(op.method, 'update');
    assert.deepEqual(Object.keys(op.args).sort(), ['data', 'where']);
    assert.deepEqual(Object.keys(op.args.data).sort(), ['clientIdEnc', 'clientSecretEnc']);
    byShop[op.args.where.shop] = op.args.data;
  }
  assert.deepEqual(Object.keys(byShop).sort(), [...SHOPS].sort());
  for (const shop of SHOPS) {
    const { clientIdEnc, clientSecretEnc } = byShop[shop];
    assert.equal(decryptSecret(clientIdEnc, newKey), plain[shop].id);
    assert.equal(decryptSecret(clientSecretEnc, newKey), plain[shop].secret);
    assert.throws(() => decryptSecret(clientIdEnc, oldKey));
    assert.throws(() => decryptSecret(clientSecretEnc, oldKey));
  }
  // The only writes are the transaction's updates.
  assert.deepEqual([...new Set(writes(prisma).map((c) => `${c.model}.${c.method}`))].sort(), ['$.$transaction', 'salesforceConnection.update']);
  leaks(res, [oldKey, newKey, plain[SHOPS[0]].id, plain[SHOPS[0]].secret, rows[0].clientIdEnc]);
});

test('success: new ciphertext differs from the old ciphertext', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const { rows } = makeRows(oldKey, [SHOPS[0]]);
  const prisma = rotationPrisma(rows);
  await reencryptConnections({ prisma, oldKey, newKey });
  const { data } = prisma.transactions[0][0].args;
  assert.notEqual(data.clientIdEnc, rows[0].clientIdEnc);
  assert.notEqual(data.clientSecretEnc, rows[0].clientSecretEnc);
});

test('success with a single row still uses one transaction array', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const { rows } = makeRows(oldKey, [SHOPS[0]]);
  const prisma = rotationPrisma(rows);
  assert.deepEqual(await reencryptConnections({ prisma, oldKey, newKey }), { ok: true, rotated: 1 });
  assert.equal(prisma.transactions.length, 1);
  assert.equal(prisma.transactions[0].length, 1);
});

test('zero rows: ok with rotated 0 and no transaction', async () => {
  const prisma = rotationPrisma([]);
  const res = await reencryptConnections({ prisma, oldKey: makeKey(), newKey: makeKey() });
  assert.deepEqual(res, { ok: true, rotated: 0 });
  assert.equal(prisma.transactions.length, 0);
  assert.equal(prisma.calls.filter((c) => c.method === 'update').length, 0);
});

test('plaintext values that look unusual round-trip (long and non-ASCII)', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const longId = 'x'.repeat(500);
  const oddSecret = 'sécret-ünï-' + '9'.repeat(40);
  const rows = [{ shop: SHOPS[0], clientIdEnc: encryptSecret(longId, oldKey), clientSecretEnc: encryptSecret(oddSecret, oldKey) }];
  const prisma = rotationPrisma(rows);
  assert.equal((await reencryptConnections({ prisma, oldKey, newKey })).ok, true);
  const { data } = prisma.transactions[0][0].args;
  assert.equal(decryptSecret(data.clientIdEnc, newKey), longId);
  assert.equal(decryptSecret(data.clientSecretEnc, newKey), oddSecret);
});

// ---- undecryptable rows: nothing is written ----

test('one row that fails to decrypt: credentials error naming the shop, and no write at all', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const { rows, plain } = makeRows(oldKey, SHOPS);
  const other = makeRows(makeKey(), [SHOPS[1]]).rows[0];
  const mixed = rows.map((r) => (r.shop === SHOPS[1] ? other : r));
  const prisma = rotationPrisma(mixed);
  const res = await reencryptConnections({ prisma, oldKey, newKey });
  assert.deepEqual(res, { ok: false, errorClass: 'credentials', message: UNREADABLE, failedShops: [SHOPS[1]] });
  assert.equal(writes(prisma).length, 0);
  assert.equal(prisma.transactions.length, 0);
  leaks(res, [oldKey, newKey, plain[SHOPS[0]].id, plain[SHOPS[0]].secret, other.clientIdEnc, other.clientSecretEnc]);
});

test('several failing rows: failedShops lists all of them, sorted, and nothing is written', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const { rows } = makeRows(oldKey, ['m.myshopify.com']);
  const strangers = makeRows(makeKey(), ['z.myshopify.com', 'c.myshopify.com']).rows;
  const prisma = rotationPrisma([strangers[0], rows[0], strangers[1]]); // z, m, c in that order
  const res = await reencryptConnections({ prisma, oldKey, newKey });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, 'credentials');
  assert.deepEqual(res.failedShops, ['c.myshopify.com', 'z.myshopify.com']);
  assert.equal(writes(prisma).length, 0);
});

test('a row whose only the secret column fails still fails the whole run', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const [good, half] = makeRows(oldKey, [SHOPS[0], SHOPS[1]]).rows;
  const wrongSecret = encryptSecret('whatever', makeKey());
  const prisma = rotationPrisma([good, { ...half, clientSecretEnc: wrongSecret }]);
  const res = await reencryptConnections({ prisma, oldKey, newKey });
  assert.equal(res.errorClass, 'credentials');
  assert.deepEqual(res.failedShops, [SHOPS[1]]);
  assert.equal(writes(prisma).length, 0);
});

test('garbage, empty or missing ciphertext counts as undecryptable (never throws)', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const base = makeRows(oldKey, ['ok.myshopify.com']).rows[0];
  const badValues = ['not-a-ciphertext', '', null, undefined, 42];
  for (const v of badValues) {
    const prisma = rotationPrisma([base, { shop: 'bad.myshopify.com', clientIdEnc: v, clientSecretEnc: base.clientSecretEnc }]);
    const res = await reencryptConnections({ prisma, oldKey, newKey });
    assert.equal(res.ok, false, String(v));
    assert.equal(res.errorClass, 'credentials', String(v));
    assert.deepEqual(res.failedShops, ['bad.myshopify.com'], String(v));
    assert.equal(writes(prisma).length, 0);
  }
});

test('running with the wrong old key fails every shop and writes nothing', async () => {
  const realOld = makeKey();
  const { rows } = makeRows(realOld, SHOPS);
  const prisma = rotationPrisma(rows);
  const res = await reencryptConnections({ prisma, oldKey: makeKey(), newKey: makeKey() });
  assert.equal(res.errorClass, 'credentials');
  assert.deepEqual(res.failedShops, [...SHOPS].sort());
  assert.equal(writes(prisma).length, 0);
});

test('running the same rotation twice: the second run fails safely because rows are already on the new key', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const { rows } = makeRows(oldKey, [SHOPS[0]]);
  const first = rotationPrisma(rows);
  await reencryptConnections({ prisma: first, oldKey, newKey });
  const { data } = first.transactions[0][0].args;
  const second = rotationPrisma([{ shop: SHOPS[0], ...data }]);
  const res = await reencryptConnections({ prisma: second, oldKey, newKey });
  assert.equal(res.errorClass, 'credentials');
  assert.equal(writes(second).length, 0);
});

// ---- storage failures ----

test('a rejecting read gives a storage error with the fixed message', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const prisma = rotationPrisma([], { failOn: { 'salesforceConnection.findMany': new Error(`db down ${oldKey}`) } });
  const res = await reencryptConnections({ prisma, oldKey, newKey });
  assert.deepEqual(res, { ok: false, errorClass: 'storage', message: STORAGE });
  assert.equal(writes(prisma).length, 0);
});

test('a read that throws synchronously also gives a storage error', async () => {
  const prisma = rotationPrisma([], { results: { 'salesforceConnection.findMany': () => { throw new Error('sync'); } } });
  const res = await reencryptConnections({ prisma, oldKey: makeKey(), newKey: makeKey() });
  assert.deepEqual(res, { ok: false, errorClass: 'storage', message: STORAGE });
});

test('a rejecting transaction gives a storage error that leaks nothing from the error', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const { rows, plain } = makeRows(oldKey, SHOPS);
  const prisma = rotationPrisma(rows, { transactionError: new Error(`write failed ${newKey} ${plain[SHOPS[0]].secret}`) });
  const res = await reencryptConnections({ prisma, oldKey, newKey });
  assert.deepEqual(res, { ok: false, errorClass: 'storage', message: STORAGE });
  assert.equal(prisma.transactions.length, 1); // it was attempted once, not retried
  leaks(res, [oldKey, newKey, plain[SHOPS[0]].secret]);
});

test('the result of every outcome is plain data with no key or ciphertext in it', async () => {
  const oldKey = makeKey();
  const newKey = makeKey();
  const { rows } = makeRows(oldKey, SHOPS);
  const results = [
    await reencryptConnections({ prisma: rotationPrisma(rows), oldKey, newKey }),
    await reencryptConnections({ prisma: rotationPrisma(rows), oldKey: 'x', newKey }),
    await reencryptConnections({ prisma: rotationPrisma(rows), oldKey, newKey: oldKey }),
    await reencryptConnections({ prisma: rotationPrisma(rows), oldKey: makeKey(), newKey }),
  ];
  for (const r of results) leaks(r, [oldKey, newKey, rows[0].clientIdEnc, rows[0].clientSecretEnc]);
});
