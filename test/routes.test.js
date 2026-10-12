/**
 * Smoke tests for the two public machine routes: internal.sync (scheduler) and healthz.
 *
 * Route files are .jsx and import server modules, so each is bundled with esbuild (packages left
 * external) into node_modules/.cache and imported from there, AFTER dummy environment variables
 * are set. The unreachable DATABASE_URL means nothing here touches a database. The authorised 200
 * path of internal.sync is deliberately not exercised (it would query the database).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { makeKey, makeCronSecret } from './fixtures/m7-fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'node_modules', '.cache', `paf-routes-test-${process.pid}`);

const CRON = makeCronSecret();
const BASE_ENV = {
  SHOPIFY_API_KEY: 'dummy-api-key',
  SHOPIFY_API_SECRET: 'dummy-api-secret',
  SHOPIFY_APP_URL: 'https://example.com',
  SCOPES: 'read_products',
  DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
  ENCRYPTION_KEY: makeKey(),
  CRON_SECRET: CRON,
};
const saved = {};
const setEnv = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

let sync;
let health;

// The real session storage polls the (unreachable) database for ~10 s after import and then raises an
// unhandled rejection that fails the whole file. Neither route uses sessions, so it is replaced by an
// in-memory stand-in with the same method names.
const sessionStorageStub = {
  name: 'session-storage-stub',
  setup(b) {
    b.onResolve({ filter: /^@shopify\/shopify-app-session-storage-prisma$/ }, () => ({ path: 'stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js',
      contents: `export class PrismaSessionStorage {
        async storeSession() { return true; }
        async loadSession() { return undefined; }
        async deleteSession() { return true; }
        async deleteSessions() { return true; }
        async findSessionsByShop() { return []; }
      }`,
    }));
  },
};

async function load(name) {
  const outfile = join(outDir, `${name}.mjs`);
  await build({
    entryPoints: [join(root, 'app', 'routes', `${name}.jsx`)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
    plugins: [sessionStorageStub],
  });
  return import(pathToFileURL(outfile).href);
}

before(async () => {
  for (const name of Object.keys(BASE_ENV)) saved[name] = process.env[name];
  saved.APP_URL = process.env.APP_URL;
  for (const [name, value] of Object.entries(BASE_ENV)) process.env[name] = value;
  delete process.env.APP_URL;
  mkdirSync(outDir, { recursive: true });
  sync = await load('internal.sync');
  health = await load('healthz');
});

after(async () => {
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  rmSync(outDir, { recursive: true, force: true });
  // The Prisma client built by the route modules keeps a handle open; disconnect it so the run can end.
  try { await globalThis.prismaGlobal?.$disconnect(); } catch { /* nothing to close */ }
});

const call = (fn, method, headers) => fn({ request: new Request('https://example.com/internal/sync', { method, headers }) });
const post = (headers) => call(sync.action, 'POST', headers);

async function assertRejected(response, status, message) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['message', 'ok']);
  assert.equal(body.ok, false);
  assert.equal(typeof body.message, 'string');
  if (message) assert.equal(body.message, message);
  return body;
}

const noSecretEcho = (body, ...secrets) => {
  const text = JSON.stringify(body);
  for (const s of secrets.filter((x) => x.length >= 8)) assert.ok(!text.includes(s), 'response must not echo a secret');
};

// ---- internal.sync ----

test('internal.sync exports a loader and an action', () => {
  assert.equal(typeof sync.loader, 'function');
  assert.equal(typeof sync.action, 'function');
});

test('internal.sync: the loader answers 405', async () => {
  await assertRejected(sync.loader({ request: new Request('https://example.com/internal/sync') }), 405);
});

test('internal.sync: the action rejects every method but POST with 405', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
    const headers = { Authorization: `Bearer ${CRON}` };
    const response = await call(sync.action, method, headers);
    assert.equal(response.status, 405, method);
  }
});

test('internal.sync: POST without an Authorization header gives 401', async () => {
  const body = await assertRejected(await post({}), 401);
  noSecretEcho(body, CRON);
});

test('internal.sync: POST with the wrong secret of the same length gives 401', async () => {
  const wrong = CRON.split('').reverse().join('') === CRON ? `${CRON.slice(1)}z` : CRON.split('').reverse().join('');
  assert.equal(wrong.length, CRON.length);
  assert.notEqual(wrong, CRON);
  const body = await assertRejected(await post({ Authorization: `Bearer ${wrong}` }), 401);
  noSecretEcho(body, CRON, wrong);
});

test('internal.sync: shorter and longer secrets give 401', async () => {
  for (const given of [CRON.slice(0, -1), `${CRON}x`, '', 'x']) {
    const body = await assertRejected(await post({ Authorization: `Bearer ${given}` }), 401);
    noSecretEcho(body, CRON);
  }
});

test('internal.sync: the secret without the Bearer prefix, or with another scheme, gives 401', async () => {
  for (const header of [CRON, `Basic ${CRON}`, `bearer ${CRON}`, `Bearer  ${CRON}`, `Bearer\t${CRON}`]) {
    await assertRejected(await post({ Authorization: header }), 401);
  }
});

test('internal.sync: with CRON_SECRET unset the answer is 503 for any caller', async () => {
  const before = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    const body = await assertRejected(await post({ Authorization: 'Bearer ' }), 503);
    noSecretEcho(body, CRON);
    await assertRejected(await post({}), 503);
    await assertRejected(await post({ Authorization: `Bearer ${CRON}` }), 503);
  } finally {
    process.env.CRON_SECRET = before;
  }
});

test('internal.sync: with a CRON_SECRET shorter than 16 characters the answer is 503, even for a matching header', async () => {
  const before = process.env.CRON_SECRET;
  try {
    for (const short of ['', 'a', 'x'.repeat(15)]) {
      process.env.CRON_SECRET = short;
      const body = await assertRejected(await post({ Authorization: `Bearer ${short}` }), 503);
      noSecretEcho(body, short || '\u0000');
    }
  } finally {
    process.env.CRON_SECRET = before;
  }
});

test('internal.sync: a 32 character CRON_SECRET counts as configured (a wrong header is 401, not 503)', async () => {
  const before = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = 'y'.repeat(32);
    await assertRejected(await post({ Authorization: `Bearer ${'z'.repeat(32)}` }), 401);
  } finally {
    process.env.CRON_SECRET = before;
  }
});

test('internal.sync: a CRON_SECRET of 16 to 31 characters is not configured (503)', async () => {
  const before = process.env.CRON_SECRET;
  try {
    for (const n of [16, 31]) {
      process.env.CRON_SECRET = 'y'.repeat(n);
      await assertRejected(await post({ Authorization: `Bearer ${'y'.repeat(n)}` }), 503, 'Scheduler not configured.');
    }
  } finally {
    process.env.CRON_SECRET = before;
  }
});

test('internal.sync: any wrong header is 401 whatever its length, with the same body', async () => {
  const bodies = new Set();
  for (const given of ['', 'x', `Bearer ${'q'.repeat(10)}`, `Bearer ${'q'.repeat(CRON.length)}`, `Bearer ${'q'.repeat(500)}`]) {
    const body = await assertRejected(await post({ Authorization: given }), 401);
    bodies.add(JSON.stringify(body));
  }
  assert.equal(bodies.size, 1);
});

// ---- webhook handlers (source text only: they need Shopify authentication) ----

test('the uninstall and redact webhook handlers invalidate the shop cache', () => {
  for (const name of ['webhooks.app.uninstalled.jsx', 'webhooks.shop.redact.jsx']) {
    const src = readFileSync(join(root, 'app', 'routes', name), 'utf8');
    assert.match(src, /import\s*\{[^}]*\binvalidateShop\b[^}]*\}\s*from/, name);
    assert.ok(/invalidateShop\s*\(\s*dashboardCache\s*,/.test(src), name);
  }
});

// ---- healthz ----

test('healthz: with an unreachable database the loader answers 503 and exactly { ok: false }', async () => {
  const response = await health.loader({ request: new Request('https://example.com/healthz') });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
});

test('healthz: a missing variable also gives exactly { ok: false } and names nothing', async () => {
  const before = process.env.SCOPES;
  try {
    delete process.env.SCOPES;
    const response = await health.loader({ request: new Request('https://example.com/healthz') });
    assert.equal(response.status, 503);
    const text = JSON.stringify(await response.json());
    assert.equal(text, '{"ok":false}');
    assert.ok(!text.includes('SCOPES'));
  } finally {
    process.env.SCOPES = before;
  }
});
