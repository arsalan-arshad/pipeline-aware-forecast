/**
 * Regression test for the CSRF origin allow-list in react-router.config.js.
 *
 * Behind Railway's TLS proxy the server sees http while the browser's Origin is https, so every form
 * post from the embedded app was rejected ("Bad Request") until the app's own host was allowed.
 * The config is read at build time, so each case imports a fresh copy with its own environment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const file = pathToFileURL(resolve(import.meta.dirname, '..', 'react-router.config.js')).href;
let n = 0;
async function loadConfig(env) {
  const saved = { SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL, APP_URL: process.env.APP_URL };
  for (const k of Object.keys(saved)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return (await import(`${file}?case=${n++}`)).default;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('allows exactly the host of SHOPIFY_APP_URL', async () => {
  const c = await loadConfig({ SHOPIFY_APP_URL: 'https://paf.example.up.railway.app' });
  assert.deepEqual(c.allowedActionOrigins, ['paf.example.up.railway.app']);
  assert.equal(c.ssr, true);
});

test('falls back to APP_URL (the tunnel URL used by shopify app dev)', async () => {
  const c = await loadConfig({ APP_URL: 'https://abc.trycloudflare.com' });
  assert.deepEqual(c.allowedActionOrigins, ['abc.trycloudflare.com']);
});

test('SHOPIFY_APP_URL wins over APP_URL', async () => {
  const c = await loadConfig({ SHOPIFY_APP_URL: 'https://a.example.com', APP_URL: 'https://b.example.com' });
  assert.deepEqual(c.allowedActionOrigins, ['a.example.com']);
});

test('no wildcard and no origin when the URL is missing or invalid', async () => {
  for (const env of [{}, { SHOPIFY_APP_URL: 'not a url' }, { SHOPIFY_APP_URL: '' }]) {
    const c = await loadConfig(env);
    assert.deepEqual(c.allowedActionOrigins, []);
  }
});

test('a port in the URL is kept so the origin match stays exact', async () => {
  const c = await loadConfig({ SHOPIFY_APP_URL: 'https://paf.example.com:8443' });
  assert.deepEqual(c.allowedActionOrigins, ['paf.example.com:8443']);
});
