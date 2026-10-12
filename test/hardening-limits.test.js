// Tests for the M6 security-hardening limits in connection.server.js and the stricter instance URL check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSalesforceConnection } from '../app/lib/connection.server.js';
import { isAllowedInstanceUrl } from '../app/lib/pipeline/salesforce-client.server.js';
import { createM6Prisma, makeKey, SHOP } from './fixtures/m6-fixtures.js';

const TOO_LONG = 'One of the values is too long.';
const host = (n) => `https://${'a'.repeat(n - '.my.salesforce.com'.length - 'https://'.length)}.my.salesforce.com`;

function input(over = {}) {
  return { prisma: createM6Prisma(), shop: SHOP, instanceUrl: 'https://acme.my.salesforce.com', clientId: 'FAKE_ID', clientSecret: 'FAKE_SECRET', encryptionKey: makeKey(), ...over };
}

test('instanceUrl of 512 characters is not rejected for length', async () => {
  const url = host(512);
  assert.equal(url.length, 512);
  const r = await saveSalesforceConnection(input({ instanceUrl: url }));
  // Length passes; a 494-char host label is not a valid domain label, so any later failure is NOT the length message.
  assert.notEqual(r.message, TOO_LONG);
});

test('513 characters in any one value -> too long, zero prisma calls', async () => {
  for (const field of ['instanceUrl', 'clientId', 'clientSecret']) {
    const over = { [field]: field === 'instanceUrl' ? host(513) : 'x'.repeat(513) };
    const i = input(over);
    assert.deepEqual(await saveSalesforceConnection(i), { ok: false, errorClass: 'config', message: TOO_LONG }, field);
    assert.equal(i.prisma.calls.length, 0, field);
  }
});

test('clientId and clientSecret of exactly 512 characters are saved', async () => {
  const i = input({ clientId: 'i'.repeat(512), clientSecret: 's'.repeat(512) });
  assert.deepEqual(await saveSalesforceConnection(i), { ok: true });
  assert.equal(i.prisma.calls.length, 1);
});

test('the length check comes before the key check', async () => {
  const i = input({ clientId: 'x'.repeat(513), encryptionKey: 'not-a-key' });
  assert.equal((await saveSalesforceConnection(i)).message, TOO_LONG);
});

test('the non-empty checks still come before the length check', async () => {
  const i = input({ clientId: '', clientSecret: 'x'.repeat(600) });
  const r = await saveSalesforceConnection(i);
  assert.equal(r.ok, false);
  assert.notEqual(r.message, TOO_LONG);
});

// Allowed: https, no userinfo, default port, <name>[.sandbox|.develop|.scratch|.trailblaze].my.salesforce.com
for (const ok of [
  'https://acme.my.salesforce.com',
  'https://acme-dev.my.salesforce.com',
  'https://a.my.salesforce.com',
  'https://acme.sandbox.my.salesforce.com',
  'https://orgfarm-x-dev-ed.develop.my.salesforce.com',
  'https://acme.scratch.my.salesforce.com',
  'https://acme.trailblaze.my.salesforce.com',
  'https://acme.my.salesforce.com/',
  'https://acme.my.salesforce.com:443',
]) {
  test(`isAllowedInstanceUrl accepts ${ok}`, () => assert.equal(isAllowedInstanceUrl(ok), true));
}

for (const bad of [
  'https://acme.force.com',
  'https://acme.sandbox.my.force.com',
  'https://acme.salesforce.com',
  'https://acme.lightning.force.com',
  'https://acme.my.site.com',
  'https://acme.my.salesforce.com:8443',
  'https://acme.my.salesforce.com:80',
  'http://acme.my.salesforce.com',
  'https://user:pw@acme.my.salesforce.com',
  'https://-acme.my.salesforce.com',
  'https://acme-.my.salesforce.com',
  'https://my.salesforce.com',
  'https://acme.my.salesforce.com.evil.example.com',
  'https://evil.example.com/acme.my.salesforce.com',
  'https://acme.other.my.salesforce.com',
  'https://a.b.my.salesforce.com',
  'ftp://acme.my.salesforce.com',
  'acme.my.salesforce.com',
  '',
]) {
  test(`isAllowedInstanceUrl rejects ${JSON.stringify(bad)}`, () => assert.equal(isAllowedInstanceUrl(bad), false));
}

test('isAllowedInstanceUrl rejects non-strings', () => {
  for (const v of [undefined, null, 5, {}, []]) assert.equal(isAllowedInstanceUrl(v), false);
});
