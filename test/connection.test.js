// Tests for app/lib/connection.server.js, written from the module contract.
// No network, no database: fake Prisma and fake fetch only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSalesforceConnection, testStoredConnection, deleteSalesforceConnection } from '../app/lib/connection.server.js';
import { decryptSecret } from '../app/lib/pipeline/credentials-crypto.server.js';
import { createFakeFetch, tokenOk, tokenError, page, response, sfError, INSTANCE_URL } from './fixtures/salesforce-fixtures.js';
import {
  SHOP, CLIENT_ID, CLIENT_SECRET, makeKey, storedConnection, createM5Prisma,
} from './fixtures/m5-fixtures.js';

const URL_MESSAGE = 'Enter your Salesforce My Domain address, e.g. https://yourcompany.my.salesforce.com.';
const KEY_MESSAGE = 'The server is missing a valid ENCRYPTION_KEY.';
const NOT_CONNECTED = 'Salesforce is not connected yet.';
const CREDS_MESSAGE = 'The stored Salesforce credentials could not be read. Please reconnect Salesforce.';

function validInput(over = {}) {
  return {
    prisma: createM5Prisma(),
    shop: SHOP,
    instanceUrl: 'https://acme-dev.my.salesforce.com',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    encryptionKey: makeKey(),
    ...over,
  };
}

// ---------------------------------------------------------------- saveSalesforceConnection

test('save: success makes exactly one upsert with the contract shape', async () => {
  const input = validInput();
  const result = await saveSalesforceConnection(input);
  assert.deepEqual(result, { ok: true });

  assert.equal(input.prisma.calls.length, 1);
  const [call] = input.prisma.calls;
  assert.equal(call.model, 'salesforceConnection');
  assert.equal(call.method, 'upsert');
  const { where, create, update } = call.args;
  assert.deepEqual(where, { shop: SHOP });
  assert.deepEqual(Object.keys(create).sort(), ['authMode', 'clientIdEnc', 'clientSecretEnc', 'instanceUrl', 'shop']);
  assert.equal(create.shop, SHOP);
  assert.equal(create.instanceUrl, 'https://acme-dev.my.salesforce.com');
  assert.equal(create.authMode, 'client_credentials');
  assert.deepEqual(
    Object.keys(update).sort(),
    ['authMode', 'clientIdEnc', 'clientSecretEnc', 'instanceUrl', 'lastErrorAt', 'lastErrorClass', 'lastErrorMessage'],
  );
  assert.equal(update.instanceUrl, 'https://acme-dev.my.salesforce.com');
  assert.equal(update.authMode, 'client_credentials');
  assert.equal(update.lastErrorClass, null);
  assert.equal(update.lastErrorMessage, null);
  assert.equal(update.lastErrorAt, null);
  // lastSyncAt is never touched, on create or on update.
  assert.ok(!('lastSyncAt' in create));
  assert.ok(!('lastSyncAt' in update));
});

test('save: stored values are encrypted and decrypt back to the trimmed inputs', async () => {
  const key = makeKey();
  const input = validInput({ encryptionKey: key, clientId: `  ${CLIENT_ID}\n`, clientSecret: `\t${CLIENT_SECRET}  ` });
  assert.deepEqual(await saveSalesforceConnection(input), { ok: true });
  const { create, update } = input.prisma.calls[0].args;
  for (const row of [create, update]) {
    assert.notEqual(row.clientIdEnc, CLIENT_ID);
    assert.notEqual(row.clientSecretEnc, CLIENT_SECRET);
    assert.ok(!row.clientIdEnc.includes(CLIENT_ID));
    assert.ok(!row.clientSecretEnc.includes(CLIENT_SECRET));
    assert.equal(decryptSecret(row.clientIdEnc, key), CLIENT_ID);
    assert.equal(decryptSecret(row.clientSecretEnc, key), CLIENT_SECRET);
  }
  // The stored values never contain the plaintext anywhere in the whole call.
  const dump = JSON.stringify(input.prisma.calls[0].args);
  assert.ok(!dump.includes(CLIENT_SECRET));
  assert.ok(!dump.includes(CLIENT_ID));
});

test('save: instanceUrl is stored as its origin (path, query and trailing slash dropped)', async () => {
  for (const given of [
    'https://acme-dev.my.salesforce.com/',
    'https://acme-dev.my.salesforce.com/lightning/page/home?x=1#top',
    'https://acme-dev.my.salesforce.com:443/',
  ]) {
    const input = validInput({ instanceUrl: given });
    assert.deepEqual(await saveSalesforceConnection(input), { ok: true }, given);
    const { create, update } = input.prisma.calls[0].args;
    assert.equal(create.instanceUrl, 'https://acme-dev.my.salesforce.com', given);
    assert.equal(update.instanceUrl, 'https://acme-dev.my.salesforce.com', given);
  }
});

test('save: .force.com hosts are rejected (only Salesforce My Domain API hosts are allowed)', async () => {
  const input = validInput({ instanceUrl: 'https://acme.sandbox.my.force.com' });
  const result = await saveSalesforceConnection(input);
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'config');
  assert.equal(input.prisma.calls.length, 0);
});

test('save: uppercase hex key is accepted', async () => {
  const input = validInput({ encryptionKey: makeKey().toUpperCase() });
  assert.deepEqual(await saveSalesforceConnection(input), { ok: true });
});

test('save: each call uses fresh ciphertext (random IV)', async () => {
  const key = makeKey();
  const a = validInput({ encryptionKey: key });
  const b = validInput({ encryptionKey: key });
  await saveSalesforceConnection(a);
  await saveSalesforceConnection(b);
  assert.notEqual(a.prisma.calls[0].args.create.clientSecretEnc, b.prisma.calls[0].args.create.clientSecretEnc);
});

test('save: a rejecting upsert propagates (storage errors are not swallowed)', async () => {
  const boom = new Error('db down');
  const input = validInput({ prisma: createM5Prisma({ failOn: { 'salesforceConnection.upsert': boom } }) });
  await assert.rejects(saveSalesforceConnection(input), (err) => err === boom);
});

const BAD_URLS = [
  ['http scheme', 'http://acme-dev.my.salesforce.com'],
  ['foreign host', 'https://evil.example.com'],
  ['lookalike suffix host', 'https://acme.salesforce.com.evil.example.com'],
  ['bare apex without subdomain dot', 'https://salesforce.com'],
  ['embedded credentials', 'https://user:pw@acme-dev.my.salesforce.com'],
  ['not a url', 'acme-dev.my.salesforce.com'],
  ['empty', ''],
  ['undefined', undefined],
  ['number', 42],
  ['null', null],
];

for (const [label, bad] of BAD_URLS) {
  test(`save: rejects instanceUrl (${label}) with the My Domain message and no prisma call`, async () => {
    const input = validInput({ instanceUrl: bad });
    const result = await saveSalesforceConnection(input);
    assert.deepEqual(result, { ok: false, errorClass: 'config', message: URL_MESSAGE });
    assert.equal(input.prisma.calls.length, 0);
  });
}

for (const [label, bad] of [['empty', ''], ['blank', '   \n\t'], ['undefined', undefined], ['number', 7], ['null', null]]) {
  test(`save: rejects clientId (${label}) as config, no prisma call, no leaks`, async () => {
    const input = validInput({ clientId: bad });
    const result = await saveSalesforceConnection(input);
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, 'config');
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0);
    assert.notEqual(result.message, URL_MESSAGE);
    assert.notEqual(result.message, KEY_MESSAGE);
    assert.ok(!result.message.includes(CLIENT_SECRET));
    assert.equal(input.prisma.calls.length, 0);
  });
  test(`save: rejects clientSecret (${label}) as config, no prisma call, no leaks`, async () => {
    const input = validInput({ clientSecret: bad });
    const result = await saveSalesforceConnection(input);
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, 'config');
    assert.notEqual(result.message, URL_MESSAGE);
    assert.notEqual(result.message, KEY_MESSAGE);
    assert.ok(!result.message.includes(CLIENT_ID));
    assert.equal(input.prisma.calls.length, 0);
  });
}

for (const [label, bad] of [
  ['undefined', undefined],
  ['empty', ''],
  ['too short', 'abcd'],
  ['63 hex', 'a'.repeat(63)],
  ['65 hex', 'a'.repeat(65)],
  ['non-hex 64', 'g'.repeat(64)],
  ['number', 12345],
]) {
  test(`save: rejects encryptionKey (${label}) with the server-key message and no prisma call`, async () => {
    const input = validInput({ encryptionKey: bad });
    const result = await saveSalesforceConnection(input);
    assert.deepEqual(result, { ok: false, errorClass: 'config', message: KEY_MESSAGE });
    assert.equal(input.prisma.calls.length, 0);
    assert.ok(!result.message.includes(CLIENT_SECRET));
    assert.ok(!result.message.includes(CLIENT_ID));
  });
}

for (const [label, bad] of [['empty', ''], ['undefined', undefined], ['number', 5], ['null', null]]) {
  test(`save: rejects shop (${label}) as config, no prisma call`, async () => {
    const input = validInput({ shop: bad });
    const result = await saveSalesforceConnection(input);
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, 'config');
    assert.equal(input.prisma.calls.length, 0);
  });
}

test('save: validation order is shop, instanceUrl, clientId/clientSecret, key', async () => {
  // Bad URL and bad key together: URL message wins.
  let r = await saveSalesforceConnection(validInput({ instanceUrl: 'http://x.example.com', encryptionKey: 'nope' }));
  assert.equal(r.message, URL_MESSAGE);
  // Empty client id and bad key together: the key message must NOT win.
  r = await saveSalesforceConnection(validInput({ clientId: ' ', encryptionKey: 'nope' }));
  assert.equal(r.ok, false);
  assert.notEqual(r.message, KEY_MESSAGE);
  // Empty secret and bad key together: likewise.
  r = await saveSalesforceConnection(validInput({ clientSecret: '', encryptionKey: 'nope' }));
  assert.notEqual(r.message, KEY_MESSAGE);
  // Bad shop and bad URL together: the URL message must NOT win.
  r = await saveSalesforceConnection(validInput({ shop: '', instanceUrl: 'http://x.example.com' }));
  assert.equal(r.ok, false);
  assert.notEqual(r.message, URL_MESSAGE);
});

test('save: a validation failure never contains the secret or client id, even when they are odd', async () => {
  const sneaky = 'SNEAKY_SECRET_VALUE_zz91';
  const sneakyId = 'SNEAKY_ID_VALUE_zz92';
  const cases = [
    { instanceUrl: 'http://x.example.com' },
    { encryptionKey: 'short' },
    { shop: '' },
  ];
  for (const over of cases) {
    const input = validInput({ clientId: sneakyId, clientSecret: sneaky, ...over });
    const r = await saveSalesforceConnection(input);
    assert.equal(r.ok, false);
    const dump = JSON.stringify(r);
    assert.ok(!dump.includes(sneaky), JSON.stringify(over));
    assert.ok(!dump.includes(sneakyId), JSON.stringify(over));
    assert.equal(input.prisma.calls.length, 0);
  }
});

test('save: never rejects for validation, even with no arguments or an empty object', async () => {
  const r1 = await saveSalesforceConnection({});
  assert.equal(r1.ok, false);
  assert.equal(r1.errorClass, 'config');
  const r2 = await saveSalesforceConnection();
  assert.equal(r2.ok, false);
  assert.equal(r2.errorClass, 'config');
});

// ---------------------------------------------------------------- testStoredConnection

const connectionOk = () => [tokenOk(INSTANCE_URL), page([]), page([]), page([])];

test('test: no stored row -> not_connected, only a findUnique by shop, nothing fetched', async () => {
  const prisma = createM5Prisma({ connection: null });
  const fetchImpl = createFakeFetch([]);
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: makeKey(), fetchImpl });
  assert.deepEqual(r, { ok: false, errorClass: 'not_connected', message: NOT_CONNECTED });
  assert.equal(prisma.calls.length, 1);
  assert.equal(prisma.calls[0].model, 'salesforceConnection');
  assert.equal(prisma.calls[0].method, 'findUnique');
  assert.deepEqual(prisma.calls[0].args.where, { shop: SHOP });
  assert.equal(fetchImpl.calls.length, 0);
});

test('test: credentials encrypted under a different key -> credentials error, no fetch', async () => {
  const prisma = createM5Prisma({ connection: storedConnection(makeKey()) });
  const fetchImpl = createFakeFetch([]);
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: makeKey(), fetchImpl });
  assert.deepEqual(r, { ok: false, errorClass: 'credentials', message: CREDS_MESSAGE });
  assert.equal(fetchImpl.calls.length, 0);
});

test('test: corrupted stored payload -> credentials error', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key, { clientSecretEnc: 'v1:not:a:payload' }) });
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl: createFakeFetch([]) });
  assert.deepEqual(r, { ok: false, errorClass: 'credentials', message: CREDS_MESSAGE });
});

test('test: invalid or missing server key -> credentials error, never a rejection', async () => {
  const key = makeKey();
  for (const bad of [undefined, '', 'zz', 'a'.repeat(63)]) {
    const prisma = createM5Prisma({ connection: storedConnection(key) });
    const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: bad, fetchImpl: createFakeFetch([]) });
    assert.deepEqual(r, { ok: false, errorClass: 'credentials', message: CREDS_MESSAGE }, String(bad));
  }
});

test('test: success returns the client result unchanged and sends the decrypted credentials', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key) });
  const fetchImpl = createFakeFetch(connectionOk());
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl });
  assert.equal(r.ok, true);
  assert.match(r.message, /Opportunity/);
  assert.match(r.message, /OpportunityLineItem/);
  assert.match(r.message, /Product2/);
  assert.deepEqual(Object.keys(r).sort(), ['message', 'ok']);

  // 1 token request + 3 access checks, all to the stored host.
  assert.equal(fetchImpl.calls.length, 4);
  const tokenCall = fetchImpl.calls[0];
  assert.match(tokenCall.url, /^https:\/\/acme-dev\.my\.salesforce\.com\/services\/oauth2\/token$/);
  const form = new URLSearchParams(tokenCall.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.equal(form.get('client_secret'), CLIENT_SECRET);
  // Result never echoes the secret.
  assert.ok(!JSON.stringify(r).includes(CLIENT_SECRET));
});

test('test: a Salesforce auth failure is returned with the client class and message', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key) });
  const fetchImpl = createFakeFetch([tokenError(400, 'invalid_client')]);
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl });
  assert.deepEqual(r, {
    ok: false,
    errorClass: 'auth',
    message: 'Salesforce did not recognise the client ID or client secret.',
  });
  assert.ok(!JSON.stringify(r).includes(CLIENT_SECRET));
  assert.ok(!JSON.stringify(r).includes(CLIENT_ID));
});

test('test: a permission failure on a data check keeps its class', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key) });
  const fetchImpl = createFakeFetch([tokenOk(INSTANCE_URL), sfError(403, 'INSUFFICIENT_ACCESS')]);
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'permission');
});

test('test: a network failure resolves as a network error rather than rejecting', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key) });
  const fetchImpl = createFakeFetch([{ reject: new TypeError('fetch failed') }]);
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'network');
});

test('test: a stored instanceUrl off the allow-list -> config with the client message, nothing fetched', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key, { instanceUrl: 'https://evil.example.com' }) });
  const fetchImpl = createFakeFetch([]);
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl });
  assert.deepEqual(r, {
    ok: false,
    errorClass: 'config',
    message: 'instanceUrl must be an https Salesforce My Domain address, e.g. https://yourcompany.my.salesforce.com.',
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('test: an unexpected response shape is still a resolved failure', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key) });
  const fetchImpl = createFakeFetch([response(200, { nothing: true })]);
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'unexpected_response');
});

// ---------------------------------------------------------------- deleteSalesforceConnection

test('delete: one $transaction array of three deleteMany calls in the contract order', async () => {
  const prisma = createM5Prisma();
  const result = await deleteSalesforceConnection({ prisma, shop: SHOP });
  assert.equal(result, undefined);
  assert.equal(prisma.transactions.length, 1);
  assert.deepEqual(prisma.transactions[0], [
    { model: 'salesforceConnection', method: 'deleteMany', args: { where: { shop: SHOP } } },
    { model: 'pipelineSnapshot', method: 'deleteMany', args: { where: { shop: SHOP } } },
    { model: 'unmatchedProduct', method: 'deleteMany', args: { where: { shop: SHOP } } },
  ]);
  // 3 delegate calls + 1 transaction, nothing else (no reads, no direct writes beyond the batch).
  assert.equal(prisma.calls.length, 4);
  assert.deepEqual(prisma.calls.map((c) => `${c.model}.${c.method}`), [
    'salesforceConnection.deleteMany',
    'pipelineSnapshot.deleteMany',
    'unmatchedProduct.deleteMany',
    '$.$transaction',
  ]);
});

for (const [label, bad] of [['empty', ''], ['undefined', undefined], ['number', 12], ['null', null], ['object', {}]]) {
  test(`delete: shop (${label}) throws 'A shop is required.' before any prisma call`, async () => {
    const prisma = createM5Prisma();
    await assert.rejects(
      async () => deleteSalesforceConnection({ prisma, shop: bad }),
      (err) => err instanceof Error && err.message === 'A shop is required.',
    );
    assert.equal(prisma.calls.length, 0);
  });
}

test('delete: a rejecting transaction propagates', async () => {
  const boom = new Error('tx failed');
  const prisma = createM5Prisma({ transactionError: boom });
  await assert.rejects(deleteSalesforceConnection({ prisma, shop: SHOP }), (err) => err === boom);
});

// ------------------------------------------------------------------ extra branches

test('save: a whitespace-only shop is rejected like an empty one', async () => {
  const input = validInput({ shop: '   ' });
  const r = await saveSalesforceConnection(input);
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'config');
  assert.equal(input.prisma.calls.length, 0);
});

test('delete: a whitespace-only shop is rejected like an empty one', async () => {
  const prisma = createM5Prisma();
  await assert.rejects(
    async () => deleteSalesforceConnection({ prisma, shop: '  \t' }),
    (err) => err.message === 'A shop is required.',
  );
  assert.equal(prisma.calls.length, 0);
});

test('test: a non-function fetchImpl resolves as a config failure instead of rejecting', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key) });
  const r = await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'config');
});

test('test: only reads the row; it writes nothing', async () => {
  const key = makeKey();
  const prisma = createM5Prisma({ connection: storedConnection(key) });
  await testStoredConnection({ prisma, shop: SHOP, encryptionKey: key, fetchImpl: createFakeFetch(connectionOk()) });
  assert.deepEqual(prisma.calls.map((c) => `${c.model}.${c.method}`), ['salesforceConnection.findUnique']);
});
