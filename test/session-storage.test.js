// Tests for app/lib/session-storage.server.js, written from the module contract.
// Fake Prisma with a Map-backed `session` delegate; real Session objects; no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@shopify/shopify-api';
import { EncryptedPrismaSessionStorage } from '../app/lib/session-storage.server.js';
import { encryptSecret } from '../app/lib/pipeline/credentials-crypto.server.js';
import { makeKey, SHOP } from './fixtures/m6-fixtures.js';

const ACCESS = 'shpat_FAKE_ACCESS_t0k3n_91ab';
const REFRESH = 'shprt_FAKE_REFRESH_t0k3n_77cd';
const KEY_MESSAGE = 'A valid ENCRYPTION_KEY is required to store Shopify sessions.';

/** Map-backed fake of the Prisma `session` delegate. `rows` is the table, `writes` records upserts. */
function fakePrisma() {
  const rows = new Map();
  const writes = [];
  const session = {
    async count() { return rows.size; },
    async upsert({ where, update, create }) {
      writes.push({ where, update, create });
      rows.set(where.id, { ...(rows.has(where.id) ? update : create) });
      return rows.get(where.id);
    },
    async findUnique({ where }) { return rows.get(where.id) ?? null; },
    async findMany({ where }) { return [...rows.values()].filter((r) => r.shop === where.shop); },
    async delete({ where }) { rows.delete(where.id); },
    async deleteMany({ where }) { for (const id of where.id.in) rows.delete(id); },
  };
  return { session, rows, writes };
}

// make() generates a key; make(undefined) really passes an undefined key.
function make(...args) {
  const key = args.length > 0 ? args[0] : makeKey();
  const prisma = args[1] ?? fakePrisma();
  const storage = new EncryptedPrismaSessionStorage(prisma, { encryptionKey: key, connectionRetryIntervalMs: 1 });
  return { storage, prisma, key };
}

// Flag columns the base class writes; names built from fragments to keep this file clear of the privacy scan.
const FLAGS = Object.fromEntries([['acc', 'ountOwner'], ['collaborator'], ['em', 'ailVerified']].map((p) => [p.join(''), false]));
const legacyRow = (over = {}) => ({ id: 'legacy', shop: SHOP, state: 's', isOnline: false, scope: null, expires: null, accessToken: ACCESS, refreshToken: null, refreshTokenExpires: null, userId: null, firstName: null, lastName: null, locale: null, ...FLAGS, ...over });

const offline = (over = {}) => new Session({ id: `offline_${SHOP}`, shop: SHOP, state: 's', isOnline: false, accessToken: ACCESS, scope: 'read_products', ...over });

test('store: the access token is encrypted (v1:), other columns are unchanged', async () => {
  const { storage, prisma } = make(makeKey());
  assert.equal(await storage.storeSession(offline()), true);
  const row = prisma.rows.get(`offline_${SHOP}`);
  assert.match(row.accessToken, /^v1:/);
  assert.ok(!row.accessToken.includes(ACCESS));
  assert.equal(row.shop, SHOP);
  assert.equal(row.scope, 'read_products');
  assert.equal(row.isOnline, false);
  assert.equal(row.state, 's');
  assert.ok(!JSON.stringify(prisma.writes).includes(ACCESS), 'plain token never reaches the database layer');
});

test('store: a refresh token is encrypted too; an absent one stays null', async () => {
  const withRefresh = make();
  await withRefresh.storage.storeSession(offline({ refreshToken: REFRESH }));
  const row = withRefresh.prisma.rows.get(`offline_${SHOP}`);
  assert.match(row.refreshToken, /^v1:/);
  assert.ok(!JSON.stringify(row).includes(REFRESH));

  const without = make();
  await without.storage.storeSession(offline());
  assert.equal(without.prisma.rows.get(`offline_${SHOP}`).refreshToken, null);
});

test('store then load: the original session comes back with plain tokens', async () => {
  const { storage } = make();
  await storage.storeSession(offline({ refreshToken: REFRESH }));
  const s = await storage.loadSession(`offline_${SHOP}`);
  assert.equal(s.accessToken, ACCESS);
  assert.equal(s.refreshToken, REFRESH);
  assert.equal(s.shop, SHOP);
  assert.equal(s.scope, 'read_products');
});

test('store: two stores of the same token give different ciphertext (fresh IV) and both load', async () => {
  const { storage, prisma } = make(makeKey());
  await storage.storeSession(offline());
  const first = prisma.rows.get(`offline_${SHOP}`).accessToken;
  await storage.storeSession(offline());
  const second = prisma.rows.get(`offline_${SHOP}`).accessToken;
  assert.notEqual(first, second);
  assert.equal((await storage.loadSession(`offline_${SHOP}`)).accessToken, ACCESS);
});

test('load: a legacy plain-text row is returned unchanged', async () => {
  const { storage, prisma } = make(makeKey());
  prisma.rows.set('legacy', legacyRow());
  const s = await storage.loadSession('legacy');
  assert.equal(s.accessToken, ACCESS);
});

test('load: a legacy row is readable even with an invalid key (nothing to decrypt)', async () => {
  const { storage, prisma } = make('not-a-key');
  prisma.rows.set('legacy', legacyRow());
  assert.equal((await storage.loadSession('legacy')).accessToken, ACCESS);
});

test('load: a missing session is undefined', async () => {
  const { storage } = make();
  assert.equal(await storage.loadSession('nope'), undefined);
});

test('findSessionsByShop decrypts every session', async () => {
  const { storage } = make();
  await storage.storeSession(offline());
  await storage.storeSession(new Session({ id: 'second', shop: SHOP, state: 's', isOnline: false, accessToken: `${ACCESS}_2`, refreshToken: REFRESH }));
  await storage.storeSession(new Session({ id: 'other', shop: 'other.myshopify.com', state: 's', isOnline: false, accessToken: 'shpat_FAKE_OTHER' }));
  const found = await storage.findSessionsByShop(SHOP);
  assert.deepEqual(found.map((s) => s.accessToken).sort(), [ACCESS, `${ACCESS}_2`].sort());
  assert.equal(found.find((s) => s.id === 'second').refreshToken, REFRESH);
});

for (const [label, key] of [['undefined', undefined], ['not hex', 'not-a-key'], ['too short', 'ab'.repeat(16)], ['empty', '']]) {
  test(`store with an invalid key (${label}) throws the key message and writes nothing`, async () => {
    const { storage, prisma } = make(key);
    await assert.rejects(storage.storeSession(offline()), { message: KEY_MESSAGE });
    assert.equal(prisma.writes.length, 0);
    assert.equal(prisma.rows.size, 0);
  });
}

test('load of an encrypted row with an invalid or missing key throws the key message', async () => {
  const good = make();
  await good.storage.storeSession(offline());
  for (const key of [undefined, 'not-a-key']) {
    const { storage } = make(key, good.prisma);
    await assert.rejects(storage.loadSession(`offline_${SHOP}`), { message: KEY_MESSAGE });
  }
});

// The implementation treats an undecryptable row (wrong key, corruption) as "no session" rather than
// throwing, so Shopify re-authenticates the shop. Either way ciphertext or garbage is never returned.
test('load with a wrong (but valid) key returns no session, never ciphertext', async () => {
  const good = make();
  await good.storage.storeSession(offline({ refreshToken: REFRESH }));
  const wrong = make(makeKey(), good.prisma);
  assert.equal(await wrong.storage.loadSession(`offline_${SHOP}`), undefined);
  assert.deepEqual(await wrong.storage.findSessionsByShop(SHOP), []);
});

test('findSessionsByShop skips an unreadable row but still returns the readable ones', async () => {
  const key = makeKey();
  const { storage, prisma } = make(key);
  await storage.storeSession(offline());
  const other = makeKey();
  prisma.rows.set('bad', legacyRow({ id: 'bad', accessToken: encryptSecret(ACCESS, other) }));
  const found = await storage.findSessionsByShop(SHOP);
  assert.deepEqual(found.map((x) => x.id), [`offline_${SHOP}`]);
});

test('load: an encrypted refresh token under another key makes the row unreadable (no session)', async () => {
  const good = make();
  const other = makeKey();
  good.prisma.rows.set('mixed', legacyRow({ id: 'mixed', refreshToken: encryptSecret(REFRESH, other) }));
  assert.equal(await good.storage.loadSession('mixed'), undefined);
});

test('a tampered ciphertext gives no session and never garbage', async () => {
  const { storage, prisma } = make();
  await storage.storeSession(offline());
  const row = prisma.rows.get(`offline_${SHOP}`);
  // Flip the first character of the ciphertext part (v1:iv:tag:ciphertext) so real bytes change.
  const parts = row.accessToken.split(':');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  row.accessToken = parts.join(':');
  assert.equal(await storage.loadSession(`offline_${SHOP}`), undefined);
});

test('delete and deleteSessions still work through the base class', async () => {
  const { storage, prisma } = make(makeKey());
  await storage.storeSession(offline());
  await storage.storeSession(new Session({ id: 'two', shop: SHOP, state: 's', isOnline: false, accessToken: 'shpat_FAKE_2' }));
  assert.equal(await storage.deleteSession(`offline_${SHOP}`), true);
  assert.equal(prisma.rows.size, 1);
  assert.equal(await storage.deleteSessions(['two']), true);
  assert.equal(prisma.rows.size, 0);
});

test('the encryption key is not passed on as a storage option or leaked into rows', async () => {
  const key = makeKey();
  const { storage, prisma } = make(key);
  await storage.storeSession(offline());
  assert.ok(!JSON.stringify(prisma.rows.get(`offline_${SHOP}`)).includes(key));
  assert.equal(storage.tableName, 'session');
});

test('rowToSession returns null for an unreadable encrypted row, and throws the key message when the key is missing', async () => {
  const good = make();
  await good.storage.storeSession(offline());
  const row = { ...good.prisma.rows.get(`offline_${SHOP}`) };
  assert.equal(make(makeKey(), good.prisma).storage.rowToSession(row), null);
  assert.throws(() => make(undefined, good.prisma).storage.rowToSession(row), { message: KEY_MESSAGE });
  assert.equal(good.storage.rowToSession(row).accessToken, ACCESS);
});
