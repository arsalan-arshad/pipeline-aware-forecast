/**
 * Independent tests for credentials-crypto.server.js, written from the contract only.
 * The key is generated in memory per run and never written anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  CredentialsCryptoError,
  parseEncryptionKey,
  encryptSecret,
  decryptSecret,
} from '../app/lib/pipeline/credentials-crypto.server.js';

const KEY = randomBytes(32).toString('hex');
const OTHER_KEY = randomBytes(32).toString('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

const MSG_KEY = 'ENCRYPTION_KEY must be 64 hex characters (32 bytes).';
const MSG_INPUT = 'Secret to encrypt must be a non-empty string.';
const MSG_PAYLOAD = 'Stored credential has an unrecognised format.';
const MSG_DECRYPT = 'Could not decrypt the stored credential (wrong key or corrupted data).';

function expectCode(fn, code, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof CredentialsCryptoError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'CredentialsCryptoError');
    assert.equal(err.code, code);
    if (message) assert.equal(err.message, message);
    return true;
  });
}

test('parseEncryptionKey: valid keys, case-insensitive, returns 32-byte Buffer', () => {
  const buf = parseEncryptionKey(KEY);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.length, 32);
  assert.equal(buf.toString('hex'), KEY);
  const upper = parseEncryptionKey(KEY.toUpperCase());
  assert.equal(upper.length, 32);
  assert.deepEqual(upper, buf);
});

test('parseEncryptionKey: every bad key shape -> bad_key with fixed message', () => {
  const bad = [
    undefined, null, 42, {}, [], Buffer.alloc(32), '',
    'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ('a'.repeat(63) + 'z'),
    ' ' + 'a'.repeat(63), 'a'.repeat(64) + '\n', '0x' + 'a'.repeat(62),
  ];
  for (const k of bad) expectCode(() => parseEncryptionKey(k), 'bad_key', MSG_KEY);
});

test('bad_key message never echoes the supplied value', () => {
  const leaky = 'NOTHEX-SUPERSECRETKEYVALUE-' + 'z'.repeat(40);
  assert.throws(() => parseEncryptionKey(leaky), (err) => {
    for (const s of [err.message, JSON.stringify(err), err.stack]) {
      assert.ok(!s.includes('SUPERSECRETKEYVALUE'));
    }
    return true;
  });
});

test('encryptSecret: payload format v1:<iv>:<tag>:<ct>, base64url no padding, part sizes', () => {
  const plain = 'hello world';
  const payload = encryptSecret(plain, KEY);
  assert.match(payload, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  const parts = payload.split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.equal(unb64u(parts[1]).length, 12); // iv
  assert.equal(unb64u(parts[2]).length, 16); // tag
  assert.equal(unb64u(parts[3]).length, Buffer.byteLength(plain)); // GCM ciphertext == plaintext length
  assert.ok(!payload.includes('='));
  assert.ok(!payload.includes(plain));
});

test('round trips: ascii, unicode, 4 KB, salesforce-looking 64 char string', () => {
  const sfLike = randomBytes(32).toString('hex'); // 64 chars
  const cases = [
    'a',
    'plain ascii secret',
    'päss wörd — 密码 🔐 ключ',
    'x'.repeat(4096),
    'Zz9'.repeat(1400).slice(0, 4096),
    sfLike,
    'has:colons:inside:it',
    ' leading and trailing ',
  ];
  for (const p of cases) {
    const enc = encryptSecret(p, KEY);
    assert.equal(decryptSecret(enc, KEY), p);
  }
  assert.equal(sfLike.length, 64);
});

test('fresh IV: same plaintext twice -> different payloads, both decrypt', () => {
  const a = encryptSecret('same', KEY);
  const b = encryptSecret('same', KEY);
  assert.notEqual(a, b);
  assert.notEqual(a.split(':')[1], b.split(':')[1]);
  assert.equal(decryptSecret(a, KEY), 'same');
  assert.equal(decryptSecret(b, KEY), 'same');
});

test('encryptSecret: bad_input for empty, number, null, undefined, object', () => {
  for (const v of ['', 123, null, undefined, {}, ['x'], Buffer.from('x')]) {
    expectCode(() => encryptSecret(v, KEY), 'bad_input', MSG_INPUT);
  }
});

test('encryptSecret: key validated first (bad key + bad input -> bad_key)', () => {
  expectCode(() => encryptSecret('', 'short'), 'bad_key', MSG_KEY);
  expectCode(() => encryptSecret('ok', undefined), 'bad_key', MSG_KEY);
});

test('decryptSecret: key validated first (bad key + bad payload -> bad_key)', () => {
  expectCode(() => decryptSecret('garbage', 'short'), 'bad_key', MSG_KEY);
  expectCode(() => decryptSecret(undefined, undefined), 'bad_key', MSG_KEY);
});

test('wrong key -> decrypt_failed, no partial plaintext', () => {
  const enc = encryptSecret('sensitive-value-123', KEY);
  expectCode(() => decryptSecret(enc, OTHER_KEY), 'decrypt_failed', MSG_DECRYPT);
});

function flipBit(partB64, byteIndex = 0) {
  const buf = Buffer.from(unb64u(partB64));
  buf[byteIndex] ^= 0x01;
  return b64u(buf);
}

test('tampering with iv, tag or ciphertext (any byte) -> decrypt_failed', () => {
  const enc = encryptSecret('tamper me please', KEY);
  const [v, iv, tag, ct] = enc.split(':');
  const variants = [
    [v, flipBit(iv), tag, ct],
    [v, flipBit(iv, 11), tag, ct],
    [v, iv, flipBit(tag), ct],
    [v, iv, flipBit(tag, 15), ct],
    [v, iv, tag, flipBit(ct)],
    [v, iv, tag, flipBit(ct, ct.length > 2 ? unb64u(ct).length - 1 : 0)],
  ];
  for (const parts of variants) {
    expectCode(() => decryptSecret(parts.join(':'), KEY), 'decrypt_failed', MSG_DECRYPT);
  }
});

test('ciphertext extended or truncated by a byte (valid base64url) -> decrypt_failed', () => {
  const enc = encryptSecret('lengthy enough text', KEY);
  const [v, iv, tag, ct] = enc.split(':');
  const raw = unb64u(ct);
  expectCode(() => decryptSecret([v, iv, tag, b64u(Buffer.concat([raw, Buffer.from([0])]))].join(':'), KEY), 'decrypt_failed');
  expectCode(() => decryptSecret([v, iv, tag, b64u(raw.subarray(0, raw.length - 1))].join(':'), KEY), 'decrypt_failed');
});

test('malformed payloads -> bad_payload', () => {
  const enc = encryptSecret('format checks', KEY);
  const [v, iv, tag, ct] = enc.split(':');
  const bad = [
    undefined, null, 42, {}, Buffer.from(enc), '',
    'v1', [v, iv, tag].join(':'), [v, iv].join(':'),          // truncated
    [v, iv, tag, ct, ct].join(':'), enc + ':',               // extra parts
    ['v2', iv, tag, ct].join(':'), ['V1', iv, tag, ct].join(':'), ['', iv, tag, ct].join(':'), // prefix
    [v, iv + '!', tag, ct].join(':'), [v, iv, tag + ' ', ct].join(':'), [v, iv, tag, ct + '+'].join(':'),
    [v, iv, tag, ct + '/'].join(':'), [v, iv, tag, ct + '='].join(':'), // non-base64url chars
    [v, '', tag, ct].join(':'), [v, iv, '', ct].join(':'), // empty iv / tag parts
    [v, b64u(randomBytes(11)), tag, ct].join(':'), [v, b64u(randomBytes(13)), tag, ct].join(':'), // iv size
    [v, iv, b64u(randomBytes(15)), ct].join(':'), [v, iv, b64u(randomBytes(17)), ct].join(':'),   // tag size
  ];
  for (const p of bad) expectCode(() => decryptSecret(p, KEY), 'bad_payload', MSG_PAYLOAD);
});

// Contract: "empty parts" -> bad_payload. Known to FAIL against the current implementation, which
// lets an empty ciphertext part through to the cipher and reports decrypt_failed (see report).
test('empty ciphertext part -> bad_payload (contract: empty parts)', () => {
  const [v, iv, tag] = encryptSecret('format checks', KEY).split(':');
  expectCode(() => decryptSecret([v, iv, tag, ''].join(':'), KEY), 'bad_payload', MSG_PAYLOAD);
});

test('known answer: payload built independently with node:crypto decrypts', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
  const iv = Buffer.from('0102030405060708090a0b0c', 'hex');
  const plain = 'known-answer ✓ value';
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  assert.equal(tag.length, 16);
  const payload = `v1:${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
  assert.equal(decryptSecret(payload, key.toString('hex')), plain);
  assert.equal(decryptSecret(payload, key.toString('hex').toUpperCase()), plain);
  // and the other direction: our own payload parses under independent decipher rules
  const mine = encryptSecret(plain, key.toString('hex')).split(':');
  assert.equal(mine[0], 'v1');
  assert.equal(unb64u(mine[3]).length, Buffer.byteLength(plain));
});

test('error messages never contain key, plaintext, payload or fragments', () => {
  const plain = 'PLAINTEXT-MARKER-abc123XYZ';
  const enc = encryptSecret(plain, KEY);
  const [, iv, tag, ct] = enc.split(':');
  const errors = [];
  const grab = (fn) => { try { fn(); } catch (e) { errors.push(e); } };
  grab(() => parseEncryptionKey(KEY.slice(1)));
  grab(() => encryptSecret(plain, KEY.slice(1)));
  grab(() => encryptSecret('', KEY));
  grab(() => decryptSecret(enc, OTHER_KEY));
  grab(() => decryptSecret(enc, KEY.slice(1)));
  grab(() => decryptSecret(enc + ':extra', KEY));
  grab(() => decryptSecret(['v1', iv, tag, flipBit(ct)].join(':'), KEY));
  grab(() => decryptSecret(['v2', iv, tag, ct].join(':'), KEY));
  assert.equal(errors.length, 8);
  const fragments = [KEY, KEY.slice(0, 16), OTHER_KEY.slice(0, 16), plain, 'MARKER', enc, iv, tag, ct];
  for (const e of errors) {
    for (const s of [e.message, JSON.stringify(e), e.stack, String(e)]) {
      for (const f of fragments) assert.ok(!s.includes(f), `leak of ${f.slice(0, 8)} in ${e.code}`);
    }
  }
});
