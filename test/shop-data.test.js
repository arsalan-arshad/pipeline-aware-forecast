import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteShopData, deleteUninstallData, ShopDataError } from '../app/lib/shop-data.server.js';
import { createFakePrisma, SHOP } from './fixtures/shell-fixtures.js';

const ALL_MODELS = ['salesforceConnection', 'pipelineSnapshot', 'unmatchedProduct', 'stageProbabilityOverride', 'pipelineSetting', 'shopInstall', 'feedback', 'syncLock', 'session'];

test('ShopDataError: name and fixed message', () => {
  const e = new ShopDataError();
  assert.equal(e.name, 'ShopDataError');
  assert.ok(e instanceof Error);
  assert.ok(e.message.length > 0);
});

test('deleteShopData: one transaction deleting every shop-scoped model', async () => {
  const prisma = createFakePrisma();
  const result = await deleteShopData(prisma, SHOP);
  assert.equal(result, undefined);
  assert.equal(prisma.transactions.length, 1);
  assert.deepEqual(prisma.directCalls, []);
  const ops = prisma.transactions[0];
  assert.ok(ops.every((o) => o.method === 'deleteMany'));
  assert.ok(ops.every((o) => JSON.stringify(o.args) === JSON.stringify({ where: { shop: SHOP } })));
  assert.deepEqual(ops.map((o) => o.model).sort(), [...ALL_MODELS].sort());
  assert.equal(new Set(ops.map((o) => o.model)).size, ops.length);
});

test('deleteUninstallData: one transaction, only session, salesforceConnection and syncLock', async () => {
  const prisma = createFakePrisma();
  const result = await deleteUninstallData(prisma, SHOP);
  assert.equal(result, undefined);
  assert.equal(prisma.transactions.length, 1);
  assert.deepEqual(prisma.directCalls, []);
  const ops = prisma.transactions[0];
  assert.deepEqual(ops.map((o) => o.model).sort(), ['salesforceConnection', 'session', 'syncLock']);
  for (const o of ops) {
    assert.equal(o.method, 'deleteMany');
    assert.deepEqual(o.args, { where: { shop: SHOP } });
  }
});

for (const fn of [deleteShopData, deleteUninstallData]) {
  for (const bad of ['', undefined, null, 5, {}, ['a']]) {
    test(`${fn.name}: invalid shop ${JSON.stringify(bad) ?? 'undefined'} throws ShopDataError before prisma`, async () => {
      const prisma = createFakePrisma();
      await assert.rejects(async () => fn(prisma, bad), (e) => e instanceof ShopDataError && e.name === 'ShopDataError');
      assert.deepEqual(prisma.calls, []);
    });
  }

  test(`${fn.name}: transaction rejection propagates unchanged`, async () => {
    const boom = new Error('db down');
    const prisma = createFakePrisma({ transactionError: boom });
    await assert.rejects(async () => fn(prisma, SHOP), (e) => e === boom);
  });

  test(`${fn.name}: only the given shop appears in the ops`, async () => {
    const prisma = createFakePrisma();
    await fn(prisma, 'other.myshopify.com');
    for (const o of prisma.transactions[0]) assert.equal(o.args.where.shop, 'other.myshopify.com');
  });
}
