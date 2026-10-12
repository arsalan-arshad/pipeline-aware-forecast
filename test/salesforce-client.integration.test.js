/**
 * Live integration test against a Salesforce org (BUILD_PLAN M2).
 *
 * Skipped unless SF_INSTANCE_URL, SF_CLIENT_ID and SF_CLIENT_SECRET are set,
 * so `npm test` stays offline by default. Run it with `npm run test:integration`
 * (reads the git-ignored .env). It is read-only and does not depend on any
 * particular records: it checks the connection, the output shape and that a
 * wrong secret is reported as an auth problem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSalesforceClient } from '../app/lib/pipeline/salesforce-client.server.js';

const { SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET } = process.env;
const skip =
  !SF_INSTANCE_URL || !SF_CLIENT_ID || !SF_CLIENT_SECRET
    ? 'set SF_INSTANCE_URL, SF_CLIENT_ID and SF_CLIENT_SECRET to run'
    : false;

const realClient = () =>
  createSalesforceClient({
    instanceUrl: SF_INSTANCE_URL,
    clientId: SF_CLIENT_ID,
    clientSecret: SF_CLIENT_SECRET,
  });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPPORTUNITY_KEYS = ['closeDate', 'id', 'lineItems', 'probability', 'stageName'];

test('live: testConnection confirms read access', { skip }, async () => {
  const result = await realClient().testConnection();
  assert.equal(result.ok, true, result.message);
});

test('live: fetchOpenOpportunities returns only the engine fields', { skip }, async () => {
  const horizon = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const opportunities = await realClient().fetchOpenOpportunities({ horizonDate: horizon });
  assert.ok(Array.isArray(opportunities));
  for (const o of opportunities) {
    assert.deepEqual(Object.keys(o).sort(), OPPORTUNITY_KEYS);
    assert.equal(typeof o.id, 'string');
    assert.match(o.closeDate, DATE);
    assert.ok(Array.isArray(o.lineItems));
    for (const item of o.lineItems) {
      assert.deepEqual(Object.keys(item).sort(), ['productCode', 'quantity']);
      assert.equal(typeof item.productCode, 'string');
      assert.equal(typeof item.quantity, 'number');
    }
  }
});

test('live: a wrong secret is reported as an auth problem without leaking it', { skip }, async () => {
  const wrongSecret = 'not-the-real-secret-0000';
  const client = createSalesforceClient({
    instanceUrl: SF_INSTANCE_URL,
    clientId: SF_CLIENT_ID,
    clientSecret: wrongSecret,
  });
  const result = await client.testConnection();
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'auth');
  assert.ok(!result.message.includes(wrongSecret));
});
