// Tests for app/lib/settings.server.js, written from the module contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, loadPipelineSettings, savePipelineSettings } from '../app/lib/settings.server.js';
import { createM6Prisma, SHOP } from './fixtures/m6-fixtures.js';

const OK_FIELDS = { haircut: 0.8, shipOffsetDays: 5, horizonDays: 60, leadTimeDays: 10 };
const M = {
  shop: 'A shop is required.',
  haircut: 'Haircut must be between 0 and 1.',
  offset: 'Ship offset must be a whole number of days from 0 to 90.',
  horizon: 'Horizon must be a whole number of days from 7 to 365.',
  lead: 'Lead time must be a whole number of days from 0 to 180.',
  unique: 'Stage names must be unique.',
  name: 'Each stage needs a name of up to 80 characters.',
  prob: 'Stage probability must be between 0 and 100.',
};

const save = (prisma, over = {}) => savePipelineSettings({ prisma, shop: SHOP, ...OK_FIELDS, stageOverrides: [], ...over });
const config = (message) => ({ ok: false, errorClass: 'config', message });

// ------------------------------------------------------------------ defaults and load

test('DEFAULT_SETTINGS has the documented values and is frozen', () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS }, { haircut: 1, shipOffsetDays: 7, horizonDays: 90, leadTimeDays: 14 });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.throws(() => { 'use strict'; DEFAULT_SETTINGS.haircut = 0.5; }, TypeError);
});

test('loadPipelineSettings: no row and no overrides -> defaults and empty list', async () => {
  const prisma = createM6Prisma();
  const r = await loadPipelineSettings({ prisma, shop: SHOP });
  assert.deepEqual(r, { haircut: 1, shipOffsetDays: 7, horizonDays: 90, leadTimeDays: 14, stageOverrides: [] });
  assert.deepEqual(prisma.callsOf('pipelineSetting', 'findUnique').map((c) => c.args), [{ where: { shop: SHOP } }]);
  assert.deepEqual(
    prisma.callsOf('stageProbabilityOverride', 'findMany').map((c) => c.args),
    [{ where: { shop: SHOP }, orderBy: { stageName: 'asc' } }],
  );
});

test('loadPipelineSettings: stored row values are returned', async () => {
  const prisma = createM6Prisma({ results: { 'pipelineSetting.findUnique': { shop: SHOP, haircut: 0.25, shipOffsetDays: 0, horizonDays: 30, leadTimeDays: 0 } } });
  const r = await loadPipelineSettings({ prisma, shop: SHOP });
  // 0 values must survive: 0 is a real setting, not "missing".
  assert.deepEqual(r, { haircut: 0.25, shipOffsetDays: 0, horizonDays: 30, leadTimeDays: 0, stageOverrides: [] });
});

test('loadPipelineSettings: null columns fall back to the default per column', async () => {
  const prisma = createM6Prisma({ results: { 'pipelineSetting.findUnique': { shop: SHOP, haircut: null, shipOffsetDays: 3, horizonDays: null, leadTimeDays: null } } });
  const r = await loadPipelineSettings({ prisma, shop: SHOP });
  assert.deepEqual(r, { haircut: 1, shipOffsetDays: 3, horizonDays: 90, leadTimeDays: 14, stageOverrides: [] });
});

test('loadPipelineSettings: overrides are mapped to stageName + probability only', async () => {
  const prisma = createM6Prisma({
    results: {
      'stageProbabilityOverride.findMany': [
        { id: 'x1', shop: SHOP, stageName: 'Negotiation', probability: 0 },
        { id: 'x2', shop: SHOP, stageName: 'Won', probability: 100 },
      ],
    },
  });
  const r = await loadPipelineSettings({ prisma, shop: SHOP });
  assert.deepEqual(r.stageOverrides, [{ stageName: 'Negotiation', probability: 0 }, { stageName: 'Won', probability: 100 }]);
});

test('loadPipelineSettings: a rejecting read propagates', async () => {
  const prisma = createM6Prisma({ failOn: { 'pipelineSetting.findUnique': new Error('db down') } });
  await assert.rejects(loadPipelineSettings({ prisma, shop: SHOP }), /db down/);
});

// ------------------------------------------------------------------ save: success shape

test('savePipelineSettings: success is one $transaction array of upsert, deleteMany (no createMany when empty)', async () => {
  const prisma = createM6Prisma();
  const r = await save(prisma);
  assert.deepEqual(r, { ok: true });
  assert.equal(prisma.transactions.length, 1);
  // The ops are built (recorded) first, then handed to one $transaction; nothing is awaited on its own.
  assert.deepEqual(prisma.calls.map((c) => `${c.model}.${c.method}`), [
    'pipelineSetting.upsert', 'stageProbabilityOverride.deleteMany', '$.$transaction',
  ]);
  const [upsert, del, ...rest] = prisma.transactions[0];
  assert.equal(rest.length, 0, 'no createMany for an empty list');
  assert.deepEqual(upsert, {
    model: 'pipelineSetting',
    method: 'upsert',
    args: {
      where: { shop: SHOP },
      create: { shop: SHOP, haircut: 0.8, shipOffsetDays: 5, horizonDays: 60, leadTimeDays: 10 },
      update: { haircut: 0.8, shipOffsetDays: 5, horizonDays: 60, leadTimeDays: 10 },
    },
  });
  assert.deepEqual(del, { model: 'stageProbabilityOverride', method: 'deleteMany', args: { where: { shop: SHOP } } });
});

test('savePipelineSettings: absent stageOverrides behaves like an empty list', async () => {
  const prisma = createM6Prisma();
  const r = await savePipelineSettings({ prisma, shop: SHOP, ...OK_FIELDS });
  assert.deepEqual(r, { ok: true });
  assert.equal(prisma.transactions[0].length, 2);
});

test('savePipelineSettings: overrides add one createMany with trimmed names, after the deleteMany', async () => {
  const prisma = createM6Prisma();
  const r = await save(prisma, { stageOverrides: [{ stageName: '  Proposal  ', probability: 60 }, { stageName: 'Won', probability: '100' }] });
  assert.deepEqual(r, { ok: true });
  const ops = prisma.transactions[0];
  assert.deepEqual(ops.map((o) => `${o.model}.${o.method}`), [
    'pipelineSetting.upsert', 'stageProbabilityOverride.deleteMany', 'stageProbabilityOverride.createMany',
  ]);
  assert.deepEqual(ops[2].args, {
    data: [{ shop: SHOP, stageName: 'Proposal', probability: 60 }, { shop: SHOP, stageName: 'Won', probability: 100 }],
  });
});

test('savePipelineSettings: numeric strings are coerced to numbers in the write', async () => {
  const prisma = createM6Prisma();
  const r = await save(prisma, { haircut: '0.5', shipOffsetDays: '7', horizonDays: '90', leadTimeDays: '14' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(prisma.transactions[0][0].args.create, { shop: SHOP, haircut: 0.5, shipOffsetDays: 7, horizonDays: 90, leadTimeDays: 14 });
});

test('savePipelineSettings: a rejecting transaction propagates (not swallowed)', async () => {
  const prisma = createM6Prisma({ transactionError: new Error('deadlock') });
  await assert.rejects(save(prisma), /deadlock/);
});

// ------------------------------------------------------------------ boundaries

function accepts(label, over) {
  test(`savePipelineSettings: accepts ${label}`, async () => {
    const prisma = createM6Prisma();
    assert.deepEqual(await save(prisma, over), { ok: true });
    assert.equal(prisma.transactions.length, 1);
  });
}
function rejects(label, over, message) {
  test(`savePipelineSettings: rejects ${label} with zero prisma calls`, async () => {
    const prisma = createM6Prisma();
    assert.deepEqual(await save(prisma, over), config(message));
    assert.equal(prisma.calls.length, 0);
  });
}

accepts('haircut 0', { haircut: 0 });
accepts('haircut 1', { haircut: 1 });
accepts("haircut '0.5' (string)", { haircut: '0.5' });
for (const bad of [-0.01, 1.01, 2, NaN, Infinity, '', null, undefined, 'abc']) {
  rejects(`haircut ${String(bad)}`, { haircut: bad }, M.haircut);
}

accepts('shipOffsetDays 0', { shipOffsetDays: 0 });
accepts('shipOffsetDays 90', { shipOffsetDays: 90 });
for (const bad of [-1, 91, 1.5, NaN, '', null, undefined, 'x']) {
  rejects(`shipOffsetDays ${String(bad)}`, { shipOffsetDays: bad }, M.offset);
}

accepts('horizonDays 7', { horizonDays: 7 });
accepts('horizonDays 365', { horizonDays: 365 });
for (const bad of [6, 366, 7.5, 0, NaN, '', null, undefined]) {
  rejects(`horizonDays ${String(bad)}`, { horizonDays: bad }, M.horizon);
}

accepts('leadTimeDays 0', { leadTimeDays: 0 });
accepts('leadTimeDays 180', { leadTimeDays: 180 });
for (const bad of [-1, 181, 1.5, NaN, '', null, undefined]) {
  rejects(`leadTimeDays ${String(bad)}`, { leadTimeDays: bad }, M.lead);
}

for (const bad of ['', '   ', undefined, null, 5]) {
  test(`savePipelineSettings: shop ${JSON.stringify(bad)} -> shop required, zero prisma calls`, async () => {
    const prisma = createM6Prisma();
    assert.deepEqual(await save(prisma, { shop: bad }), config(M.shop));
    assert.equal(prisma.calls.length, 0);
  });
}

// ------------------------------------------------------------------ stage overrides

accepts('probability 0 and 100', { stageOverrides: [{ stageName: 'A', probability: 0 }, { stageName: 'B', probability: 100 }] });
accepts('probability 12.5 (fractional allowed)', { stageOverrides: [{ stageName: 'A', probability: 12.5 }] });
for (const bad of [-1, 100.01, 101, NaN, Infinity, '', null, undefined, 'abc']) {
  rejects(`probability ${String(bad)}`, { stageOverrides: [{ stageName: 'A', probability: bad }] }, M.prob);
}

accepts('stage name of exactly 80 characters', { stageOverrides: [{ stageName: 'x'.repeat(80), probability: 10 }] });
accepts('stage name of 80 characters after trimming', { stageOverrides: [{ stageName: `  ${'x'.repeat(80)}  `, probability: 10 }] });
rejects('stage name of 81 characters', { stageOverrides: [{ stageName: 'x'.repeat(81), probability: 10 }] }, M.name);
rejects('empty stage name', { stageOverrides: [{ stageName: '', probability: 10 }] }, M.name);
rejects('whitespace-only stage name', { stageOverrides: [{ stageName: '   ', probability: 10 }] }, M.name);
rejects('non-string stage name', { stageOverrides: [{ stageName: 7, probability: 10 }] }, M.name);
rejects('null entry in the list', { stageOverrides: [null] }, M.name);
rejects('missing stage name', { stageOverrides: [{ probability: 10 }] }, M.name);

rejects('duplicate stage names differing by case (Won / won)', {
  stageOverrides: [{ stageName: 'Won', probability: 100 }, { stageName: 'won', probability: 90 }],
}, M.unique);
rejects('duplicate stage names differing by surrounding spaces', {
  stageOverrides: [{ stageName: 'Won', probability: 100 }, { stageName: ' Won ', probability: 90 }],
}, M.unique);

test('savePipelineSettings: stageOverrides that is not an array is rejected with zero prisma calls', async () => {
  for (const bad of ['Won', 5, { stageName: 'Won', probability: 1 }, true]) {
    const prisma = createM6Prisma();
    const r = await save(prisma, { stageOverrides: bad });
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.errorClass, 'config', String(bad));
    assert.equal(prisma.calls.length, 0, String(bad));
  }
});

// ------------------------------------------------------------------ validation order

test('savePipelineSettings: the first failing check wins, in the documented order', async () => {
  const allBad = { haircut: 5, shipOffsetDays: 500, horizonDays: 1, leadTimeDays: -3, stageOverrides: [{ stageName: '', probability: 500 }] };
  const prisma = createM6Prisma();
  assert.deepEqual(await save(prisma, { ...allBad, shop: '' }), config(M.shop));
  assert.deepEqual(await save(prisma, allBad), config(M.haircut));
  assert.deepEqual(await save(prisma, { ...allBad, haircut: 1 }), config(M.offset));
  assert.deepEqual(await save(prisma, { ...allBad, haircut: 1, shipOffsetDays: 1 }), config(M.horizon));
  assert.deepEqual(await save(prisma, { ...allBad, haircut: 1, shipOffsetDays: 1, horizonDays: 30 }), config(M.lead));
  assert.deepEqual(await save(prisma, { ...allBad, haircut: 1, shipOffsetDays: 1, horizonDays: 30, leadTimeDays: 0 }), config(M.name));
  assert.equal(prisma.calls.length, 0);
});

test('savePipelineSettings: a valid name with a bad probability reports the probability message', async () => {
  const prisma = createM6Prisma();
  assert.deepEqual(await save(prisma, { stageOverrides: [{ stageName: 'Won', probability: 101 }] }), config(M.prob));
});

test('savePipelineSettings: does not mutate its inputs', async () => {
  const overrides = Object.freeze([Object.freeze({ stageName: ' Won ', probability: '50' })]);
  const prisma = createM6Prisma();
  const r = await save(prisma, { stageOverrides: overrides });
  assert.deepEqual(r, { ok: true });
  assert.equal(overrides[0].stageName, ' Won ');
  assert.equal(overrides[0].probability, '50');
});

// ------------------------------------------------------------------ at most 100 overrides

const many = (n) => Array.from({ length: n }, (_, i) => ({ stageName: `Stage ${i}`, probability: 10 }));
const TOO_MANY = 'You can add up to 100 stage overrides.';

test('savePipelineSettings: exactly 100 overrides are accepted', async () => {
  const prisma = createM6Prisma();
  assert.deepEqual(await save(prisma, { stageOverrides: many(100) }), { ok: true });
  assert.equal(prisma.transactions[0][2].args.data.length, 100);
});

test('savePipelineSettings: 101 overrides are rejected with zero prisma calls', async () => {
  const prisma = createM6Prisma();
  assert.deepEqual(await save(prisma, { stageOverrides: many(101) }), config(TOO_MANY));
  assert.equal(prisma.calls.length, 0);
});

test('savePipelineSettings: the count check comes before per-row validation', async () => {
  // 101 rows that are each invalid (empty names): the count message wins.
  const bad = Array.from({ length: 101 }, () => ({ stageName: '', probability: 999 }));
  const prisma = createM6Prisma();
  assert.deepEqual(await save(prisma, { stageOverrides: bad }), config(TOO_MANY));
  assert.equal(prisma.calls.length, 0);
});
