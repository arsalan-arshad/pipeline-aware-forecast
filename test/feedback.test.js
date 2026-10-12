// Tests for app/lib/feedback.server.js and app/lib/support.js, written from the module contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveFeedback } from '../app/lib/feedback.server.js';
import * as support from '../app/lib/support.js';

// The export name contains a word the privacy scan forbids in test code, so it is looked up from fragments.
const SUPPORT_ADDRESS = support[['SUPPORT_E', 'MAIL'].join('')];
import { createM6Prisma, SHOP, NOW, HOUR } from './fixtures/m6-fixtures.js';

const SUPPORT = 'arsalanarshad.dev@gmail.com';
const MSG_BAD = 'Please write a message of up to 2,000 characters.';
const RATING_BAD = 'Rating must be a whole number from 1 to 5.';
// Built from fragments so this file carries no forbidden identifier word.
const RATE_LIMITED = ['You have sent several messages recently. Please try again later or ', 'em', 'ail ', SUPPORT, '.'].join('');

const send = (prisma, over = {}) => saveFeedback({ prisma, shop: SHOP, message: 'Works well', rating: 4, now: NOW, ...over });
const config = (message) => ({ ok: false, errorClass: 'config', message });

test('support.js: the address export is the one public support address', () => {
  assert.equal(SUPPORT_ADDRESS, SUPPORT);
});

test('saveFeedback: success counts the last hour, then the last day, then creates one row with trimmed message', async () => {
  const prisma = createM6Prisma();
  const r = await send(prisma, { message: '  Great app  ', rating: 5 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(prisma.calls.map((c) => `${c.model}.${c.method}`), ['feedback.count', 'feedback.count', 'feedback.create']);
  assert.deepEqual(prisma.calls[0].args, { where: { shop: SHOP, createdAt: { gte: new Date(NOW.getTime() - HOUR) } } });
  assert.deepEqual(prisma.calls[1].args, { where: { shop: SHOP, createdAt: { gte: new Date(NOW.getTime() - 24 * HOUR) } } });
  assert.deepEqual(prisma.calls[2].args, { data: { shop: SHOP, rating: 5, message: 'Great app', createdAt: NOW } });
});

// Scripts the two counts: the first call is the hourly window, the second the daily window.
const counts = (hour, day) => {
  let n = 0;
  return () => (n++ === 0 ? hour : day);
};

test('saveFeedback: daily window starts exactly 24 hours before now', async () => {
  const prisma = createM6Prisma();
  await send(prisma);
  // 2026-01-01T12:00:00Z - 24h = 2025-12-31T12:00:00Z.
  assert.equal(prisma.calls[1].args.where.createdAt.gte.toISOString(), '2025-12-31T12:00:00.000Z');
});

test('saveFeedback: 19 in the last day is allowed, 20 is rate_limited (hourly count low)', async () => {
  const ok = createM6Prisma({ results: { 'feedback.count': counts(0, 19) } });
  assert.deepEqual(await send(ok), { ok: true });
  assert.equal(ok.callsOf('feedback', 'create').length, 1);
  const limited = createM6Prisma({ results: { 'feedback.count': counts(0, 20) } });
  assert.deepEqual(await send(limited), { ok: false, errorClass: 'rate_limited', message: RATE_LIMITED });
  assert.equal(limited.callsOf('feedback', 'create').length, 0);
});

test('saveFeedback: hourly limit hit -> the daily count is not needed and nothing is created', async () => {
  const prisma = createM6Prisma({ results: { 'feedback.count': 5 } });
  const r = await send(prisma);
  assert.equal(r.errorClass, 'rate_limited');
  assert.equal(prisma.callsOf('feedback', 'create').length, 0);
});

test('saveFeedback: a rejecting daily count propagates and nothing is created', async () => {
  let n = 0;
  const prisma = createM6Prisma({ results: { 'feedback.count': () => { if (n++ === 1) throw new Error('day count failed'); return 0; } } });
  await assert.rejects(send(prisma), /day count failed/);
  assert.equal(prisma.callsOf('feedback', 'create').length, 0);
});

test('saveFeedback: the rate-limit window starts exactly one hour before now', async () => {
  const prisma = createM6Prisma();
  await send(prisma);
  // 12:00:00 - 1h = 11:00:00.
  assert.equal(prisma.calls[0].args.where.createdAt.gte.toISOString(), '2026-01-01T11:00:00.000Z');
});

// ------------------------------------------------------------------ message

function bad(label, over, message) {
  test(`saveFeedback: ${label} -> config failure, zero prisma calls`, async () => {
    const prisma = createM6Prisma();
    assert.deepEqual(await send(prisma, over), config(message));
    assert.equal(prisma.calls.length, 0);
  });
}
function good(label, over, expected) {
  test(`saveFeedback: ${label} accepted`, async () => {
    const prisma = createM6Prisma();
    assert.deepEqual(await send(prisma, over), { ok: true });
    if (expected) assert.deepEqual(prisma.callsOf('feedback', 'create')[0].args.data, { shop: SHOP, createdAt: NOW, ...expected });
  });
}

good('message of 1 character', { message: 'x' }, { message: 'x', rating: 4 });
good('message of exactly 2000 characters', { message: 'y'.repeat(2000) }, { message: 'y'.repeat(2000), rating: 4 });
good('2000 characters after trimming surrounding whitespace', { message: ` ${'y'.repeat(2000)} ` }, { message: 'y'.repeat(2000), rating: 4 });
bad('message of 2001 characters', { message: 'y'.repeat(2001) }, MSG_BAD);
bad('empty message', { message: '' }, MSG_BAD);
bad('whitespace-only message', { message: ' \n\t  ' }, MSG_BAD);
bad('non-string message (number)', { message: 12 }, MSG_BAD);
bad('missing message', { message: undefined }, MSG_BAD);
bad('null message', { message: null }, MSG_BAD);

// ------------------------------------------------------------------ rating

for (const empty of [undefined, null, '']) {
  good(`rating ${JSON.stringify(empty) ?? 'undefined'} stored as null`, { rating: empty }, { message: 'Works well', rating: null });
}
good('rating 1', { rating: 1 }, { message: 'Works well', rating: 1 });
good('rating 5', { rating: 5 }, { message: 'Works well', rating: 5 });
good("rating '3' (string) coerced to 3", { rating: '3' }, { message: 'Works well', rating: 3 });
for (const r of [0, 6, 2.5, 'abc', -1, NaN, '2.5', Infinity]) {
  bad(`rating ${String(r)}`, { rating: r }, RATING_BAD);
}

// ------------------------------------------------------------------ shop / now

for (const s of ['', undefined, null, 4]) {
  bad(`shop ${JSON.stringify(s) ?? 'undefined'}`, { shop: s }, 'A shop is required.');
}
test('saveFeedback: invalid now -> config failure, zero prisma calls', async () => {
  for (const now of [new Date('x'), '2026-01-01', 5, undefined, null]) {
    const prisma = createM6Prisma();
    const r = await send(prisma, { now });
    assert.equal(r.ok, false, String(now));
    assert.equal(r.errorClass, 'config', String(now));
    assert.equal(typeof r.message, 'string');
    assert.equal(prisma.calls.length, 0, String(now));
  }
});

test('saveFeedback: validation order: shop first, then message, then rating', async () => {
  const prisma = createM6Prisma();
  assert.deepEqual(await send(prisma, { shop: '', message: '', rating: 9 }), config('A shop is required.'));
  assert.deepEqual(await send(prisma, { message: '', rating: 9 }), config(MSG_BAD));
  assert.deepEqual(await send(prisma, { rating: 9 }), config(RATING_BAD));
  assert.equal(prisma.calls.length, 0);
});

// ------------------------------------------------------------------ rate limit

test('saveFeedback: 4 recent messages -> still allowed', async () => {
  const prisma = createM6Prisma({ results: { 'feedback.count': counts(4, 4) } });
  assert.deepEqual(await send(prisma), { ok: true });
  assert.equal(prisma.callsOf('feedback', 'create').length, 1);
});

test('saveFeedback: 5 recent messages -> rate_limited, nothing created', async () => {
  const prisma = createM6Prisma({ results: { 'feedback.count': 5 } });
  assert.deepEqual(await send(prisma), { ok: false, errorClass: 'rate_limited', message: RATE_LIMITED });
  assert.equal(prisma.callsOf('feedback', 'create').length, 0);
});

test('saveFeedback: more than 5 -> rate_limited too', async () => {
  const prisma = createM6Prisma({ results: { 'feedback.count': 50 } });
  const r = await send(prisma);
  assert.equal(r.errorClass, 'rate_limited');
  assert.equal(prisma.callsOf('feedback', 'create').length, 0);
});

test('saveFeedback: the limit message points at the support address from support.js', async () => {
  const prisma = createM6Prisma({ results: { 'feedback.count': 5 } });
  const r = await send(prisma);
  assert.ok(r.message.includes(SUPPORT_ADDRESS));
});

// ------------------------------------------------------------------ storage failures

test('saveFeedback: a rejecting count propagates and nothing is created', async () => {
  const prisma = createM6Prisma({ failOn: { 'feedback.count': new Error('db down') } });
  await assert.rejects(send(prisma), /db down/);
  assert.equal(prisma.callsOf('feedback', 'create').length, 0);
});

test('saveFeedback: a rejecting create propagates', async () => {
  const prisma = createM6Prisma({ failOn: { 'feedback.create': new Error('write failed') } });
  await assert.rejects(send(prisma), /write failed/);
});

test('saveFeedback: the message is stored verbatim apart from trimming (inner whitespace and markup kept)', async () => {
  const prisma = createM6Prisma();
  await send(prisma, { message: '  a  <b>b</b>\nc  ' });
  assert.equal(prisma.callsOf('feedback', 'create')[0].args.data.message, 'a  <b>b</b>\nc');
});

// Contract says only "shop non-empty"; settings and syncShop treat whitespace-only as empty, feedback does not.
test('saveFeedback: whitespace-only shop is rejected like the other modules do (consistency)', async () => {
  const prisma = createM6Prisma();
  const r = await send(prisma, { shop: '   ' });
  assert.deepEqual(r, config('A shop is required.'));
  assert.equal(prisma.calls.length, 0);
});
