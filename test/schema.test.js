import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteShopData } from '../app/lib/shop-data.server.js';
import { createFakePrisma } from './fixtures/shell-fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Forbidden fragments are assembled so this file does not trip the privacy scan.
const FORBIDDEN = [
  ['acc', 'ount'], ['con', 'tact'], ['amo', 'unt'], ['e', 'mail'], ['pho', 'ne'], ['reve', 'nue'], ['curr', 'ency'],
].map((p) => p.join(''));
const FORBIDDEN_RE = new RegExp(FORBIDDEN.join('|'), 'i');

/** Parse `model Name { field Type ... }` blocks; attributes (@@...) and comments are skipped. */
function parseModels(src) {
  const models = {};
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(src))) {
    const fields = [];
    for (const raw of m[2].split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 2) fields.push(parts[0]);
    }
    models[m[1]] = fields;
  }
  return models;
}

const models = parseModels(readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8'));
const lowerCamel = (s) => s[0].toLowerCase() + s.slice(1);

test('parser sanity: expected models found', () => {
  assert.deepEqual(Object.keys(models).sort(), [
    'Feedback', 'PipelineSetting', 'PipelineSnapshot', 'Session', 'SalesforceConnection', 'ShopInstall', 'StageProbabilityOverride', 'SyncLock', 'UnmatchedProduct',
  ].sort());
  assert.ok(models.Session.includes('accessToken'));
  assert.ok(!models.PipelineSnapshot.includes('@@unique'));
});

test('(a) deleteShopData covers every model with a shop field', async () => {
  const shopScoped = Object.entries(models).filter(([, f]) => f.includes('shop')).map(([n]) => lowerCamel(n));
  assert.ok(shopScoped.length >= 6);
  const prisma = createFakePrisma();
  await deleteShopData(prisma, 'demo-shop.myshopify.com');
  const covered = prisma.transactions[0].map((o) => o.model);
  for (const delegate of shopScoped) assert.ok(covered.includes(delegate), `deleteShopData misses ${delegate}`);
  assert.deepEqual([...covered].sort(), [...shopScoped].sort());
});

test('(b) only Session may carry personal-data-like field names', () => {
  for (const [name, fields] of Object.entries(models)) {
    if (name === 'Session') continue;
    for (const f of fields) assert.ok(!FORBIDDEN_RE.test(f), `${name}.${f}`);
  }
});

test('(c) credentials are stored only as encrypted columns', () => {
  const f = models.SalesforceConnection;
  assert.ok(f.includes('clientIdEnc'));
  assert.ok(f.includes('clientSecretEnc'));
  for (const name of f) {
    if (/enc$/i.test(name)) continue;
    assert.ok(!/secret|password|token|^clientId$/i.test(name), `plaintext-looking secret column ${name}`);
  }
  assert.ok(!f.includes('clientId'));
  assert.ok(!f.includes('clientSecret'));
});

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('(d) shell modules contain no forbidden identifier fragments', () => {
  const files = [
    join(root, 'app', 'lib', 'pipeline-store.server.js'),
    join(root, 'app', 'lib', 'shop-data.server.js'),
    join(root, 'app', 'lib', 'shopify-data.server.js'),
    join(root, 'app', 'root.jsx'),
    ...walk(join(root, 'app', 'routes')).filter((p) => p.endsWith('.jsx')),
  ].filter(existsSync);
  assert.ok(files.length >= 3);
  const bad = [];
  for (const file of files) {
    for (const token of stripComments(readFileSync(file, 'utf8')).match(/[A-Za-z_$][\w$-]*/g) ?? []) {
      if (FORBIDDEN_RE.test(token)) bad.push(`${file}: ${token}`);
    }
  }
  assert.deepEqual(bad, []);
});
