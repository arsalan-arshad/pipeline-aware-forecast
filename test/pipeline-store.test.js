import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrismaPipelineStore, StoreInputError } from '../app/lib/pipeline-store.server.js';
import { createFakePrisma, deepFreeze, SHOP, SYNCED_AT, snapshotRow, unmatchedRow } from './fixtures/shell-fixtures.js';

const FAILED_AT = '2026-03-03T08:00:00.000Z';

function setup() {
  const prisma = createFakePrisma();
  return { prisma, store: createPrismaPipelineStore(prisma) };
}

function successInput(over = {}) {
  return { shop: SHOP, syncedAt: SYNCED_AT, snapshots: [snapshotRow()], unmatched: [unmatchedRow()], ...over };
}

test('StoreInputError: name and fixed message', () => {
  const e = new StoreInputError();
  assert.equal(e.name, 'StoreInputError');
  assert.ok(e instanceof Error);
  assert.equal(typeof e.message, 'string');
  assert.ok(e.message.length > 0);
});

test('recordSyncSuccess: one transaction with exact ordered ops', async () => {
  const { prisma, store } = setup();
  const result = await store.recordSyncSuccess(deepFreeze(successInput()));
  assert.equal(result, undefined);
  assert.equal(prisma.transactions.length, 1);
  assert.deepEqual(prisma.directCalls, []);
  const syncedAt = new Date(SYNCED_AT);
  assert.deepEqual(prisma.transactions[0], [
    { model: 'pipelineSnapshot', method: 'deleteMany', args: { where: { shop: SHOP } } },
    { model: 'unmatchedProduct', method: 'deleteMany', args: { where: { shop: SHOP } } },
    {
      model: 'pipelineSnapshot', method: 'createMany',
      args: { data: [{ shop: SHOP, sku: 'SKU-A', weekStart: new Date('2026-03-02T00:00:00.000Z'), weightedQty: 7.5, rawQty: 10, openDealCount: 2, syncedAt }] },
    },
    {
      model: 'unmatchedProduct', method: 'createMany',
      args: { data: [{ shop: SHOP, productCode: 'PC-9', openDealCount: 1, rawQty: 4, syncedAt }] },
    },
    {
      model: 'salesforceConnection', method: 'update',
      args: { where: { shop: SHOP }, data: { lastSyncAt: syncedAt, lastErrorClass: null, lastErrorMessage: null, lastErrorAt: null } },
    },
  ]);
});

test('recordSyncSuccess: empty snapshots skips snapshot createMany only', async () => {
  const { prisma, store } = setup();
  await store.recordSyncSuccess(successInput({ snapshots: [] }));
  const ops = prisma.transactions[0].map((o) => `${o.model}.${o.method}`);
  assert.deepEqual(ops, ['pipelineSnapshot.deleteMany', 'unmatchedProduct.deleteMany', 'unmatchedProduct.createMany', 'salesforceConnection.update']);
});

test('recordSyncSuccess: empty unmatched skips unmatched createMany only', async () => {
  const { prisma, store } = setup();
  await store.recordSyncSuccess(successInput({ unmatched: [] }));
  const ops = prisma.transactions[0].map((o) => `${o.model}.${o.method}`);
  assert.deepEqual(ops, ['pipelineSnapshot.deleteMany', 'unmatchedProduct.deleteMany', 'pipelineSnapshot.createMany', 'salesforceConnection.update']);
});

test('recordSyncSuccess: both empty still clears and stamps', async () => {
  const { prisma, store } = setup();
  await store.recordSyncSuccess(successInput({ snapshots: [], unmatched: [] }));
  const ops = prisma.transactions[0].map((o) => `${o.model}.${o.method}`);
  assert.deepEqual(ops, ['pipelineSnapshot.deleteMany', 'unmatchedProduct.deleteMany', 'salesforceConnection.update']);
});

test('recordSyncSuccess: row keys are exact; extra keys dropped; row order preserved', async () => {
  const { prisma, store } = setup();
  const snaps = [
    snapshotRow({ sku: 'S2', weekStart: '2026-03-09', extra: 'x', note: 'y' }),
    snapshotRow({ sku: 'S1', weekStart: '2026-03-02', weightedQty: 0, rawQty: 0, openDealCount: 0 }),
  ];
  const unm = [unmatchedRow({ productCode: 'Z', junk: 1 }), unmatchedRow({ productCode: 'A' })];
  await store.recordSyncSuccess(deepFreeze(successInput({ snapshots: snaps, unmatched: unm })));
  const [, , snapOp, unmOp] = prisma.transactions[0];
  assert.deepEqual(snapOp.args.data.map((r) => Object.keys(r).sort()), [
    ['openDealCount', 'rawQty', 'shop', 'sku', 'syncedAt', 'weekStart', 'weightedQty'],
    ['openDealCount', 'rawQty', 'shop', 'sku', 'syncedAt', 'weekStart', 'weightedQty'],
  ]);
  assert.deepEqual(snapOp.args.data.map((r) => r.sku), ['S2', 'S1']);
  assert.deepEqual(unmOp.args.data.map((r) => Object.keys(r).sort()), [
    ['openDealCount', 'productCode', 'rawQty', 'shop', 'syncedAt'],
    ['openDealCount', 'productCode', 'rawQty', 'shop', 'syncedAt'],
  ]);
  assert.deepEqual(unmOp.args.data.map((r) => r.productCode), ['Z', 'A']);
  assert.ok(snapOp.args.data[0].weekStart instanceof Date);
  assert.equal(snapOp.args.data[0].weekStart.toISOString(), '2026-03-09T00:00:00.000Z');
  assert.ok(snapOp.args.data[0].syncedAt instanceof Date);
});

test('recordSyncSuccess: deterministic and does not mutate input', async () => {
  const a = setup();
  const b = setup();
  const input = deepFreeze(successInput());
  await a.store.recordSyncSuccess(input);
  await b.store.recordSyncSuccess(input);
  assert.deepEqual(a.prisma.transactions, b.prisma.transactions);
});

test('recordSyncSuccess: rejecting transaction propagates unchanged', async () => {
  const boom = new Error('db down');
  const prisma = createFakePrisma({ transactionError: boom });
  const store = createPrismaPipelineStore(prisma);
  await assert.rejects(store.recordSyncSuccess(successInput()), (e) => e === boom);
  assert.equal(prisma.transactions.length, 1);
});

const badSuccess = {
  'shop empty': { shop: '' },
  'shop missing': { shop: undefined },
  'shop number': { shop: 5 },
  'shop null': { shop: null },
  'snapshots not array': { snapshots: 'x' },
  'snapshots null': { snapshots: null },
  'snapshots object': { snapshots: {} },
  'unmatched not array': { unmatched: 'x' },
  'unmatched undefined': { unmatched: undefined },
  'syncedAt missing': { syncedAt: undefined },
  'syncedAt garbage': { syncedAt: 'not a date' },
  'syncedAt date only': { syncedAt: '2026-03-02' },
  'syncedAt number': { syncedAt: 1772446530000 },
  'syncedAt Date object': { syncedAt: new Date(SYNCED_AT) },
  'weekStart missing': { snapshots: [snapshotRow({ weekStart: undefined })] },
  'weekStart not real day': { snapshots: [snapshotRow({ weekStart: '2026-02-30' })] },
  'weekStart month 13': { snapshots: [snapshotRow({ weekStart: '2026-13-01' })] },
  'weekStart wrong format': { snapshots: [snapshotRow({ weekStart: '03/02/2026' })] },
  'weekStart datetime': { snapshots: [snapshotRow({ weekStart: '2026-03-02T00:00:00Z' })] },
  'weekStart second row bad': { snapshots: [snapshotRow(), snapshotRow({ weekStart: 'nope' })] },
};

for (const [name, over] of Object.entries(badSuccess)) {
  test(`recordSyncSuccess invalid (${name}): StoreInputError before any prisma call`, async () => {
    const { prisma, store } = setup();
    await assert.rejects(
      async () => store.recordSyncSuccess(successInput(over)),
      (e) => e instanceof StoreInputError && e.name === 'StoreInputError',
    );
    assert.deepEqual(prisma.calls, []);
  });
}

test('StoreInputError message never echoes input', async () => {
  const { store } = setup();
  const secret = 'SECRET-TOKEN-abc123';
  for (const over of [{ shop: 5, snapshots: [snapshotRow({ sku: secret })] }, { syncedAt: secret }, { snapshots: [snapshotRow({ weekStart: secret })] }]) {
    await assert.rejects(
      async () => store.recordSyncSuccess(successInput(over)),
      (e) => e instanceof StoreInputError && !e.message.includes(secret) && !String(e.stack).includes(secret),
    );
  }
});

test('recordSyncFailure: exactly one direct updateMany, no transaction', async () => {
  const { prisma, store } = setup();
  const result = await store.recordSyncFailure(deepFreeze({ shop: SHOP, failedAt: FAILED_AT, errorClass: 'auth', message: 'Authentication failed.' }));
  assert.equal(result, undefined);
  assert.deepEqual(prisma.transactions, []);
  assert.deepEqual(prisma.directCalls, [{
    model: 'salesforceConnection', method: 'updateMany',
    args: { where: { shop: SHOP }, data: { lastErrorClass: 'auth', lastErrorMessage: 'Authentication failed.', lastErrorAt: new Date(FAILED_AT) } },
  }]);
  assert.equal(prisma.calls.length, 1);
});

test('recordSyncFailure: error from prisma propagates', async () => {
  const boom = new Error('x');
  const prisma = createFakePrisma();
  const store = createPrismaPipelineStore({
    salesforceConnection: { updateMany: () => Promise.reject(boom) },
    $transaction: prisma.$transaction,
  });
  await assert.rejects(store.recordSyncFailure({ shop: SHOP, failedAt: FAILED_AT, errorClass: 'a', message: 'b' }), (e) => e === boom);
});

const okFail = { shop: SHOP, failedAt: FAILED_AT, errorClass: 'network', message: 'Could not reach Salesforce.' };
const badFail = {
  'shop empty': { shop: '' },
  'shop number': { shop: 1 },
  'failedAt garbage': { failedAt: 'yesterday' },
  'failedAt missing': { failedAt: undefined },
  'failedAt date only': { failedAt: '2026-03-03' },
  'errorClass empty': { errorClass: '' },
  'errorClass missing': { errorClass: undefined },
  'errorClass number': { errorClass: 3 },
  'message empty': { message: '' },
  'message missing': { message: undefined },
  'message object': { message: {} },
};
for (const [name, over] of Object.entries(badFail)) {
  test(`recordSyncFailure invalid (${name}): StoreInputError before any prisma call`, async () => {
    const { prisma, store } = setup();
    await assert.rejects(
      async () => store.recordSyncFailure({ ...okFail, ...over }),
      (e) => e instanceof StoreInputError,
    );
    assert.deepEqual(prisma.calls, []);
  });
}

// Behaviour beyond the written contract, found by reading the implementation.
const extraBad = {
  'snapshot sku blank': { snapshots: [snapshotRow({ sku: '  ' })] },
  'snapshot weightedQty NaN': { snapshots: [snapshotRow({ weightedQty: Number.NaN })] },
  'snapshot rawQty string': { snapshots: [snapshotRow({ rawQty: '3' })] },
  'snapshot openDealCount fraction': { snapshots: [snapshotRow({ openDealCount: 1.5 })] },
  'snapshot openDealCount negative': { snapshots: [snapshotRow({ openDealCount: -1 })] },
  'snapshot row null': { snapshots: [null] },
  'unmatched productCode number': { unmatched: [unmatchedRow({ productCode: 4 })] },
  'unmatched rawQty Infinity': { unmatched: [unmatchedRow({ rawQty: Infinity })] },
  'unmatched openDealCount fraction': { unmatched: [unmatchedRow({ openDealCount: 0.5 })] },
};
for (const [name, over] of Object.entries(extraBad)) {
  test(`recordSyncSuccess invalid row (${name}): rejected before any prisma call`, async () => {
    const { prisma, store } = setup();
    await assert.rejects(async () => store.recordSyncSuccess(successInput(over)), (e) => e instanceof StoreInputError);
    assert.deepEqual(prisma.calls, []);
  });
}

test('recordSyncSuccess: no-arg call is a StoreInputError', async () => {
  const { prisma, store } = setup();
  await assert.rejects(async () => store.recordSyncSuccess(), (e) => e instanceof StoreInputError);
  await assert.rejects(async () => store.recordSyncFailure(), (e) => e instanceof StoreInputError);
  assert.deepEqual(prisma.calls, []);
});

test('recordSyncSuccess: large batches are chunked inside the same transaction (impl extension to contract)', async () => {
  // 4001 snapshot rows: chunk size 2000 -> 2000 + 2000 + 1 => three createMany ops; order preserved
  const { prisma, store } = setup();
  const snaps = Array.from({ length: 4001 }, (_, i) => snapshotRow({ sku: `S${i}` }));
  await store.recordSyncSuccess(successInput({ snapshots: snaps, unmatched: [] }));
  assert.equal(prisma.transactions.length, 1);
  const creates = prisma.transactions[0].filter((o) => o.method === 'createMany');
  assert.deepEqual(creates.map((o) => o.args.data.length), [2000, 2000, 1]);
  assert.deepEqual(creates.flatMap((o) => o.args.data.map((r) => r.sku)), snaps.map((r) => r.sku));
  const names = prisma.transactions[0].map((o) => o.method);
  assert.equal(names[0], 'deleteMany');
  assert.equal(names.at(-1), 'update');
});

test('recordSyncSuccess: syncedAt with offset converts to the same instant', async () => {
  const { prisma, store } = setup();
  await store.recordSyncSuccess(successInput({ syncedAt: '2026-03-02T12:15:30+02:00', snapshots: [], unmatched: [] }));
  assert.equal(prisma.transactions[0].at(-1).args.data.lastSyncAt.toISOString(), '2026-03-02T10:15:30.000Z');
});

// ---- Lead contract: createMany chunked at 2000 rows, one transaction ----
const chunkCases = [[1, [1]], [2000, [2000]], [2001, [2000, 1]], [4500, [2000, 2000, 500]]];
for (const [n, sizes] of chunkCases) {
  test(`chunking: ${n} snapshot rows -> chunks ${sizes.join('+')}`, async () => {
    const { prisma, store } = setup();
    const snaps = Array.from({ length: n }, (_, i) => snapshotRow({ sku: `S${i}` }));
    await store.recordSyncSuccess(deepFreeze(successInput({ snapshots: snaps, unmatched: [unmatchedRow()] })));
    assert.equal(prisma.transactions.length, 1);
    assert.deepEqual(prisma.directCalls, []);
    const ops = prisma.transactions[0];
    const labels = ops.map((o) => `${o.model}.${o.method}`);
    assert.deepEqual(labels, [
      'pipelineSnapshot.deleteMany', 'unmatchedProduct.deleteMany',
      ...sizes.map(() => 'pipelineSnapshot.createMany'),
      'unmatchedProduct.createMany', 'salesforceConnection.update',
    ]);
    const chunks = ops.filter((o) => o.model === 'pipelineSnapshot' && o.method === 'createMany');
    assert.deepEqual(chunks.map((o) => o.args.data.length), sizes);
    assert.deepEqual(chunks.flatMap((o) => o.args.data.map((r) => r.sku)), snaps.map((r) => r.sku));
  });

  test(`chunking: ${n} unmatched rows -> chunks ${sizes.join('+')}`, async () => {
    const { prisma, store } = setup();
    const unm = Array.from({ length: n }, (_, i) => unmatchedRow({ productCode: `P${i}` }));
    await store.recordSyncSuccess(deepFreeze(successInput({ snapshots: [snapshotRow()], unmatched: unm })));
    const ops = prisma.transactions[0];
    const labels = ops.map((o) => `${o.model}.${o.method}`);
    assert.deepEqual(labels, [
      'pipelineSnapshot.deleteMany', 'unmatchedProduct.deleteMany', 'pipelineSnapshot.createMany',
      ...sizes.map(() => 'unmatchedProduct.createMany'), 'salesforceConnection.update',
    ]);
    const chunks = ops.filter((o) => o.model === 'unmatchedProduct' && o.method === 'createMany');
    assert.deepEqual(chunks.map((o) => o.args.data.length), sizes);
    assert.deepEqual(chunks.flatMap((o) => o.args.data.map((r) => r.productCode)), unm.map((r) => r.productCode));
  });
}

test('chunking: both sets large stay in one transaction, snapshot chunks before unmatched chunks', async () => {
  const { prisma, store } = setup();
  const snaps = Array.from({ length: 2001 }, (_, i) => snapshotRow({ sku: `S${i}` }));
  const unm = Array.from({ length: 2001 }, (_, i) => unmatchedRow({ productCode: `P${i}` }));
  await store.recordSyncSuccess(successInput({ snapshots: snaps, unmatched: unm }));
  assert.equal(prisma.transactions.length, 1);
  assert.deepEqual(prisma.transactions[0].map((o) => `${o.model}.${o.method}`), [
    'pipelineSnapshot.deleteMany', 'unmatchedProduct.deleteMany',
    'pipelineSnapshot.createMany', 'pipelineSnapshot.createMany',
    'unmatchedProduct.createMany', 'unmatchedProduct.createMany', 'salesforceConnection.update',
  ]);
});

test('unmatched row with empty-string productCode is allowed', async () => {
  const { prisma, store } = setup();
  await store.recordSyncSuccess(successInput({ unmatched: [unmatchedRow({ productCode: '' })] }));
  assert.equal(prisma.transactions[0].find((o) => o.model === 'unmatchedProduct' && o.method === 'createMany').args.data[0].productCode, '');
});

test('recordSyncFailure: whitespace-only fields rejected', async () => {
  for (const over of [{ message: '   ' }, { errorClass: ' \t' }, { shop: '  ' }]) {
    const { prisma, store } = setup();
    await assert.rejects(async () => store.recordSyncFailure({ ...okFail, ...over }), (e) => e instanceof StoreInputError);
    assert.deepEqual(prisma.calls, []);
  }
});
