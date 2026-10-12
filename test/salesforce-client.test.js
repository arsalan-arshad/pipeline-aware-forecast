// Independent tests for the M2 Salesforce read client, written from the contract only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SalesforceError,
  ERROR_CLASSES,
  isAllowedInstanceUrl,
  createSalesforceClient,
} from '../app/lib/pipeline/salesforce-client.server.js';
import {
  INSTANCE_URL, API_INSTANCE_URL, CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, API_VERSION,
  response, tokenOk, sfError, tokenError, page, rejection, namedError,
  createFakeFetch, tokenCalls, queryOf, SOQL_CONN, soqlOpen, rawOpp,
} from './fixtures/salesforce-fixtures.js';

const mk = (fetchImpl, over = {}) =>
  createSalesforceClient({ instanceUrl: INSTANCE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl, ...over });

async function rejectsSf(promise, errorClass, status) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, 'expected rejection');
  assert.ok(err instanceof SalesforceError, `not a SalesforceError: ${err?.stack}`);
  assert.equal(err.errorClass, errorClass, `class was ${err.errorClass}: ${err.message}`);
  if (status !== undefined) assert.equal(err.status, status);
  assert.equal(err.userMessage, err.message);
  assertNoSecrets(err);
  return err;
}

function assertNoSecrets(err) {
  const blobs = [err.message, err.userMessage, err.stack ?? '', JSON.stringify(err), String(err)];
  for (const b of blobs) {
    for (const s of [CLIENT_SECRET, CLIENT_ID, ACCESS_TOKEN]) assert.ok(!b.includes(s), `leaked ${s.slice(0, 8)}...`);
  }
}

const OPEN = { horizonDate: '2026-12-31' };

// ---------- shape of exports ----------

test('ERROR_CLASSES is a frozen map of the seven classes', () => {
  assert.ok(Object.isFrozen(ERROR_CLASSES));
  assert.deepEqual(
    { ...ERROR_CLASSES },
    { CONFIG: 'config', AUTH: 'auth', PERMISSION: 'permission', LIMITS: 'limits', NETWORK: 'network', SERVER: 'server', UNEXPECTED_RESPONSE: 'unexpected_response' },
  );
});

test('SalesforceError is an Error with errorClass, status and userMessage', () => {
  const e = new SalesforceError('auth', 'nope', 401);
  assert.ok(e instanceof Error);
  assert.equal(e.errorClass, 'auth');
  assert.equal(e.status, 401);
  assert.equal(e.userMessage, e.message);
});

// ---------- isAllowedInstanceUrl ----------

test('isAllowedInstanceUrl accepts only https My Domain hosts on the default port', () => {
  for (const u of [
    'https://acme.my.salesforce.com',
    'https://acme.my.salesforce.com/',
    'https://acme.my.salesforce.com/path',
    'https://ACME.MY.SALESFORCE.COM',
    'https://acme--dev.sandbox.my.salesforce.com',
    'https://acme--uat.sandbox.my.salesforce.com',
    'https://orgfarm-x-dev-ed.develop.my.salesforce.com',
    'https://x.scratch.my.salesforce.com',
    'https://x.trailblaze.my.salesforce.com',
    'https://a.my.salesforce.com',
  ]) assert.equal(isAllowedInstanceUrl(u), true, u);
});

test('isAllowedInstanceUrl rejects other Salesforce hosts and explicit non-default ports', () => {
  for (const u of [
    'https://acme.my.salesforce.com:8443',
    'https://acme.my.salesforce.com:8443/path',
    'https://acme.my.salesforce.com:444',
    'https://acme.lightning.force.com',
    'https://x.force.com',
    'https://a.salesforce.com',
    'https://acme.my.site.com',
    'https://my.salesforce.com',
    'https://.my.salesforce.com',
    'https://acme.my.salesforce.com.evil.io',
    'https://evil-my.salesforce.com',
    'https://-a.my.salesforce.com',
    'https://a-.my.salesforce.com',
    'https://a.b.my.salesforce.com',
    'https://a.other.my.salesforce.com',
  ]) assert.equal(isAllowedInstanceUrl(u), false, u);
});

test('isAllowedInstanceUrl rejects apex, look-alikes, wrong scheme, userinfo and non-strings', () => {
  for (const u of [
    'https://salesforce.com',
    'https://force.com',
    'https://evil-salesforce.com',
    'https://evilsalesforce.com',
    'https://salesforce.com.evil.io',
    'https://x.salesforce.com.evil.io',
    'https://x.force.com.evil.io',
    'https://acme.my.salesforce.com@evil.io:443',
    'https://acme.salesforce.com@evil.io',
    'https://user:pw@acme.my.salesforce.com',
    'https://user@acme.my.salesforce.com',
    'https://evil.io/acme.my.salesforce.com',
    'https://evil.io?.salesforce.com',
    'https://evil.io#.salesforce.com',
    'https://evil.io\\.salesforce.com',
    'http://acme.my.salesforce.com',
    'ftp://acme.my.salesforce.com',
    '//acme.my.salesforce.com',
    'acme.my.salesforce.com',
    'javascript:alert(1)//.salesforce.com',
    'https://acme.my.salesforce.com.',
    'https://127.0.0.1',
    'https://localhost',
    '',
    '   ',
    'not a url',
  ]) assert.equal(isAllowedInstanceUrl(u), false, JSON.stringify(u));
  for (const v of [null, undefined, 42, {}, [], true, () => 'https://a.my.salesforce.com', new URL('https://a.my.salesforce.com')]) {
    assert.equal(isAllowedInstanceUrl(v), false, String(v));
  }
});

// ---------- config validation ----------

test('createSalesforceClient throws config synchronously for a bad instanceUrl', () => {
  for (const instanceUrl of ['http://a.my.salesforce.com', 'https://salesforce.com', 'https://a.salesforce.com.evil.io', '', undefined, null, 5]) {
    let err;
    try { mk(createFakeFetch(), { instanceUrl }); } catch (e) { err = e; }
    assert.ok(err instanceof SalesforceError, String(instanceUrl));
    assert.equal(err.errorClass, 'config');
    assert.match(err.message, /instance/i);
    assertNoSecrets(err);
  }
});

test('createSalesforceClient throws config naming clientId / clientSecret when missing or blank', () => {
  for (const [field, name] of [['clientId', /client.?id/i], ['clientSecret', /client.?secret/i]]) {
    for (const bad of [undefined, null, '', 123, {}]) {
      let err;
      try { mk(createFakeFetch(), { [field]: bad }); } catch (e) { err = e; }
      assert.ok(err instanceof SalesforceError, `${field}=${String(bad)}`);
      assert.equal(err.errorClass, 'config');
      assert.match(err.message, name);
      assertNoSecrets(err);
    }
  }
});

test('config error for bad clientId never echoes the secret; for bad instanceUrl never echoes secret', () => {
  for (const over of [{ clientId: '' }, { instanceUrl: 'http://x.my.salesforce.com' }]) {
    let err;
    try { mk(createFakeFetch(), over); } catch (e) { err = e; }
    assert.ok(err);
    assertNoSecrets(err);
  }
});

test('a trailing slash on instanceUrl is tolerated and does not double the slash', async () => {
  const f = createFakeFetch([tokenOk(), response(200, { totalSize: 0, done: true, records: [] })]);
  await mk(f, { instanceUrl: `${INSTANCE_URL}/` }).fetchOpenOpportunities(OPEN);
  assert.equal(f.calls[0].url, `${INSTANCE_URL}/services/oauth2/token`);
});

test('client creation makes no network call', () => {
  const f = createFakeFetch();
  mk(f);
  assert.equal(f.calls.length, 0);
});

// ---------- token request ----------

test('token request: URL, method, content type and exact form body', async () => {
  const f = createFakeFetch([tokenOk(), page([])]);
  await mk(f).fetchOpenOpportunities(OPEN);
  const t = f.calls[0];
  assert.equal(t.url, `${INSTANCE_URL}/services/oauth2/token`);
  assert.equal(t.method, 'POST');
  assert.equal(t.headers['content-type'], 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(t.body);
  assert.deepEqual([...params.keys()].sort(), ['client_id', 'client_secret', 'grant_type']);
  assert.equal(params.get('grant_type'), 'client_credentials');
  assert.equal(params.get('client_id'), CLIENT_ID);
  assert.equal(params.get('client_secret'), CLIENT_SECRET);
  assert.ok(!t.url.includes(CLIENT_SECRET), 'secret must not be in the URL');
  assert.ok(!t.headers.authorization, 'no bearer on the token request');
});

test('secret with special characters is form-encoded and round-trips', async () => {
  const secret = 'a b&c=d+e%f/g?h#i';
  const f = createFakeFetch([tokenOk(), page([])]);
  await mk(f, { clientSecret: secret }).fetchOpenOpportunities(OPEN);
  assert.equal(new URLSearchParams(f.calls[0].body).get('client_secret'), secret);
});

test('API calls carry the bearer token and go to the returned instance_url', async () => {
  const other = 'https://other-pod.my.salesforce.com';
  const f = createFakeFetch([tokenOk(other), page([])]);
  await mk(f).fetchOpenOpportunities(OPEN);
  const q = f.calls[1];
  assert.equal(q.method, 'GET');
  assert.ok(q.url.startsWith(`${other}/services/data/${API_VERSION}/query?q=`), q.url);
  assert.equal(q.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
});

test('custom apiVersion is used in the query path', async () => {
  const f = createFakeFetch([tokenOk(), page([])]);
  await mk(f, { apiVersion: 'v60.0' }).fetchOpenOpportunities(OPEN);
  assert.ok(f.calls[1].url.includes('/services/data/v60.0/query?q='));
});

test('token response with instance_url on an evil host is rejected before any bearer is sent', async () => {
  for (const evil of [
    'https://evil.io',
    'http://acme.my.salesforce.com',
    'https://salesforce.com.evil.io',
    'https://acme.my.salesforce.com@evil.io',
    'https://salesforce.com',
    '',
    42,
  ]) {
    const f = createFakeFetch([response(200, { access_token: ACCESS_TOKEN, instance_url: evil, token_type: 'Bearer' }), page([])]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
    assert.equal(f.calls.length, 1, `only the token call for ${String(evil)}`);
    assert.ok(f.calls.every((c) => !c.headers.authorization));
    assert.ok(f.calls.every((c) => !c.url.includes('evil.io')));
  }
});

test('token response with missing or null instance_url never sends the bearer anywhere but the configured Salesforce host', async () => {
  // Contract ambiguity: reject (unexpected_response) or fall back to the configured host are both safe.
  for (const iu of [undefined, null]) {
    const body = { access_token: ACCESS_TOKEN, token_type: 'Bearer' };
    if (iu === null) body.instance_url = null;
    const f = createFakeFetch([response(200, body), page([])]);
    try { await mk(f).fetchOpenOpportunities(OPEN); } catch (e) { assert.ok(e instanceof SalesforceError); }
    for (const c of f.calls.slice(1)) assert.ok(c.url.startsWith(INSTANCE_URL), c.url);
  }
});

test('malformed token bodies are unexpected_response', async () => {
  const bodies = [
    response(200, { instance_url: API_INSTANCE_URL }),
    response(200, { access_token: 123, instance_url: API_INSTANCE_URL }),
    response(200, { access_token: '', instance_url: API_INSTANCE_URL }),
    response(200, { access_token: null, instance_url: API_INSTANCE_URL }),
    response(200, {}),
    response(200, null),
    response(200, []),
    response(200, 'str'),
    response(200, {}, { jsonThrows: true }),
  ];
  for (const b of bodies) {
    const f = createFakeFetch([b]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
    assert.equal(f.calls.length, 1);
  }
});

test('token error mapping by HTTP status', async () => {
  const table = [
    [400, 'auth'], [401, 'auth'], [403, 'auth'],
    [500, 'server'], [502, 'server'], [503, 'server'],
    [404, 'unexpected_response'], [302, 'unexpected_response'], [418, 'unexpected_response'],
  ];
  for (const [status, cls] of table) {
    const f = createFakeFetch([tokenError(status, 'invalid_client')]);
    const err = await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), cls, status);
    assert.equal(f.calls.length, 1, `status ${status} stops after token`);
    void err;
  }
});

test('token error: unsupported_grant_type mentions client credentials flow not enabled', async () => {
  const f = createFakeFetch([tokenError(400, 'unsupported_grant_type', 'DESC-MARKER-1')]);
  const err = await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'auth', 400);
  assert.match(err.userMessage, /client credentials/i);
  assert.match(err.userMessage, /not enabled|enable/i);
});

test('token error: invalid_client and invalid_client_id say client id or secret not recognised', async () => {
  for (const code of ['invalid_client', 'invalid_client_id']) {
    const f = createFakeFetch([tokenError(400, code, 'DESC-MARKER-2')]);
    const err = await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'auth', 400);
    assert.match(err.userMessage, /client id/i, code);
    assert.match(err.userMessage, /secret/i, code);
    assert.match(err.userMessage, /recogni[sz]e/i, code);
  }
});

test('token error: inactive_user mentions the Run As user', async () => {
  const f = createFakeFetch([tokenError(400, 'inactive_user', 'DESC-MARKER-3')]);
  const err = await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'auth', 400);
  assert.match(err.userMessage, /run as/i);
});

test('token error: unknown code gives generic message with the code but not error_description', async () => {
  const f = createFakeFetch([tokenError(400, 'some_new_error', 'DESC-MARKER-4 internal details')]);
  const err = await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'auth', 400);
  assert.ok(err.userMessage.includes('some_new_error'));
  assert.ok(!err.userMessage.includes('DESC-MARKER-4'));
});

test('token error: error_description is never surfaced for any known code', async () => {
  for (const code of ['unsupported_grant_type', 'invalid_client', 'invalid_client_id', 'inactive_user', 'whatever']) {
    const f = createFakeFetch([tokenError(401, code, 'DESC-MARKER-5')]);
    const err = await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'auth', 401);
    assert.ok(!err.userMessage.includes('DESC-MARKER-5'), code);
  }
});

test('token error with a non-JSON or odd body still maps by status without throwing a TypeError', async () => {
  for (const b of [
    response(401, {}, { jsonThrows: true }),
    response(401, null),
    response(401, []),
    response(401, 'plain'),
    response(401, { error: 42 }),
  ]) {
    await rejectsSf(mk(createFakeFetch([b])).fetchOpenOpportunities(OPEN), 'auth', 401);
  }
  await rejectsSf(mk(createFakeFetch([response(503, {}, { jsonThrows: true })])).fetchOpenOpportunities(OPEN), 'server', 503);
});

test('error_description containing the secret or token is never echoed', async () => {
  const f = createFakeFetch([tokenError(400, `bad ${CLIENT_SECRET}`, `desc ${CLIENT_SECRET} ${ACCESS_TOKEN}`)]);
  const err = await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'auth', 400);
  void err; // rejectsSf asserts no secret/id/token anywhere in the error
});

// ---------- API error mapping ----------

test('API error mapping table', async () => {
  const table = [
    [401, 'INVALID_SESSION_ID', 'auth'],
    [403, 'REQUEST_LIMIT_EXCEEDED', 'limits'],
    [403, 'INSUFFICIENT_ACCESS', 'permission'],
    [403, 'API_DISABLED_FOR_ORG', 'permission'],
    [403, 'SOMETHING_ELSE', 'permission'],
    [429, 'ANY', 'limits'],
    [400, 'INVALID_TYPE', 'permission'],
    [400, 'INVALID_FIELD', 'permission'],
    [400, 'MALFORMED_QUERY', 'unexpected_response'],
    [500, 'UNKNOWN_EXCEPTION', 'server'],
    [503, 'SERVER_UNAVAILABLE', 'server'],
    [404, 'NOT_FOUND', 'unexpected_response'],
    [409, 'X', 'unexpected_response'],
  ];
  for (const [status, code, cls] of table) {
    const f = createFakeFetch([tokenOk(), sfError(status, code)]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), cls, status);
  }
});

test('API 403 with an error body that is not an array / not JSON is permission, not a crash', async () => {
  for (const b of [response(403, {}, { jsonThrows: true }), response(403, { errorCode: 'REQUEST_LIMIT_EXCEEDED' }), response(403, null), response(403, [])]) {
    const f = createFakeFetch([tokenOk(), b]);
    let err;
    try { await mk(f).fetchOpenOpportunities(OPEN); } catch (e) { err = e; }
    assert.ok(err instanceof SalesforceError, err?.stack);
    assert.ok(['permission', 'limits'].includes(err.errorClass));
  }
  for (const b of [response(500, {}, { jsonThrows: true }), response(401, null), response(429, 'x')]) {
    const f = createFakeFetch([tokenOk(), b]);
    let err;
    try { await mk(f).fetchOpenOpportunities(OPEN); } catch (e) { err = e; }
    assert.ok(err instanceof SalesforceError, err?.stack);
  }
});

test('API error message text from Salesforce containing the token is not echoed', async () => {
  const f = createFakeFetch([tokenOk(), sfError(403, 'INSUFFICIENT_ACCESS', `leak ${ACCESS_TOKEN} ${CLIENT_SECRET}`)]);
  await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'permission', 403);
});

test('2xx with non-JSON body or without records is unexpected_response', async () => {
  for (const b of [
    response(200, {}, { jsonThrows: true }),
    response(200, {}),
    response(200, { done: true }),
    response(200, { records: 'x', done: true }),
    response(200, { records: null, done: true }),
    response(200, null),
    response(200, []),
    response(200, 'text'),
  ]) {
    const f = createFakeFetch([tokenOk(), b]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
  }
});

// ---------- network and timeout ----------

test('fetch rejection at the token step is network', async () => {
  const f = createFakeFetch([rejection(new TypeError('fetch failed'))]);
  await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'network');
});

test('fetch rejection at the query step is network', async () => {
  const f = createFakeFetch([tokenOk(), rejection(new TypeError('socket hang up'))]);
  await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'network');
});

test('non-Error rejection values are still classified as network', async () => {
  for (const v of ['boom', undefined, null, 5]) {
    const f = createFakeFetch([rejection(v)]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'network');
  }
});

test('timeout / abort rejections are network and the message says it timed out', async () => {
  const makers = [
    () => new DOMException('The operation timed out.', 'TimeoutError'),
    () => new DOMException('This operation was aborted', 'AbortError'),
    () => namedError('TimeoutError'),
    () => namedError('AbortError'),
  ];
  for (const make of makers) {
    for (const at of ['token', 'query']) {
      const script = at === 'token' ? [rejection(make())] : [tokenOk(), rejection(make())];
      const err = await rejectsSf(mk(createFakeFetch(script)).fetchOpenOpportunities(OPEN), 'network');
      assert.match(err.userMessage, /timed out|timeout/i, `${make().name} at ${at}`);
    }
  }
});

test('a non-timeout network error message does not claim a timeout', async () => {
  const err = await rejectsSf(mk(createFakeFetch([rejection(new TypeError('fetch failed'))])).fetchOpenOpportunities(OPEN), 'network');
  assert.doesNotMatch(err.userMessage, /timed out/i);
});

test('every fetch call passes an AbortSignal', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A')], '/services/data/v67.0/query/01gA-2000'), page([])]);
  await mk(f).fetchOpenOpportunities(OPEN);
  assert.equal(f.calls.length, 3);
  for (const c of f.calls) assert.ok(c.signal instanceof AbortSignal, c.url);
  const g = createFakeFetch([tokenOk(), page([]), page([]), page([])]);
  await mk(g).testConnection();
  assert.equal(g.calls.length, 4);
  for (const c of g.calls) assert.ok(c.signal instanceof AbortSignal, c.url);
});

// A fetch that never answers until its signal aborts. AbortSignal.timeout() uses an unref'd timer, so a pending
// promise alone does not keep the event loop alive: on Node 22 the process then exits before the timeout fires
// and node:test cancels the rest of the file. The ref'd interval holds the loop open until the abort arrives
// (a real fetch holds a socket, so production code is not affected).
function hangUntilAborted(call) {
  return new Promise((_, reject) => {
    const keepAlive = setInterval(() => {}, 1000);
    call.signal.addEventListener('abort', () => {
      clearInterval(keepAlive);
      reject(call.signal.reason ?? namedError('AbortError'));
    });
  });
}

test('timeoutMs really aborts a hanging fetch that honours the signal', async () => {
  const hang = hangUntilAborted;
  const f = createFakeFetch(() => hang);
  const started = process.hrtime.bigint();
  const err = await rejectsSf(mk(f, { timeoutMs: 30 }).fetchOpenOpportunities(OPEN), 'network');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `took ${ms}ms`);
  assert.match(err.userMessage, /timed out|timeout/i);
});

test('testConnection returns ok:false (does not reject) on a hanging fetch', async () => {
  const f = createFakeFetch(() => hangUntilAborted);
  const r = await mk(f, { timeoutMs: 30 }).testConnection();
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'network');
});

// ---------- testConnection ----------

const idPage = () => response(200, { totalSize: 1, done: true, records: [{ attributes: { type: 'X' }, Id: '001' }] });

test('testConnection success: token then three SOQL reads in order, ok message mentions all objects', async () => {
  const f = createFakeFetch([tokenOk(), idPage(), idPage(), idPage()]);
  const r = await mk(f).testConnection();
  assert.equal(r.ok, true);
  assert.equal(typeof r.message, 'string');
  for (const n of ['Opportunity', 'OpportunityLineItem', 'Product2']) assert.ok(r.message.includes(n), n);
  assert.equal(f.calls.length, 4);
  assert.equal(tokenCalls(f).length, 1);
  assert.deepEqual(f.calls.slice(1).map(queryOf), SOQL_CONN);
  for (const c of f.calls.slice(1)) {
    assert.equal(c.method, 'GET');
    assert.ok(c.url.startsWith(`${API_INSTANCE_URL}/services/data/${API_VERSION}/query?q=`));
    assert.ok(!/ /.test(c.url), 'query must be URL-encoded');
    assert.equal(c.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  }
});

test('testConnection success also works when the empty orgs return zero records', async () => {
  const empty = () => response(200, { totalSize: 0, done: true, records: [] });
  const r = await mk(createFakeFetch([tokenOk(), empty(), empty(), empty()])).testConnection();
  assert.equal(r.ok, true);
});

test('testConnection failure at the token step', async () => {
  const f = createFakeFetch([tokenError(400, 'invalid_client')]);
  const r = await mk(f).testConnection();
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'auth');
  assert.match(r.message, /client id/i);
  assert.equal(f.calls.length, 1);
});

test('testConnection stops at the first failing query and reports its class and message', async () => {
  const cases = [
    [0, sfError(403, 'INSUFFICIENT_ACCESS'), 'permission'],
    [1, sfError(400, 'INVALID_TYPE'), 'permission'],
    [2, sfError(429, 'REQUEST_LIMIT_EXCEEDED'), 'limits'],
    [1, sfError(500, 'UNKNOWN_EXCEPTION'), 'server'],
    [2, sfError(401, 'INVALID_SESSION_ID'), 'auth'],
    [0, response(200, {}, { jsonThrows: true }), 'unexpected_response'],
  ];
  for (const [failAt, bad, cls] of cases) {
    const script = [tokenOk()];
    for (let i = 0; i < 3; i += 1) script.push(i === failAt ? bad : idPage());
    const f = createFakeFetch(script);
    const r = await mk(f).testConnection();
    assert.equal(r.ok, false, `${failAt}/${cls}`);
    assert.equal(r.errorClass, cls);
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
    assert.equal(f.calls.length, 1 + failAt + 1, `stops after query ${failAt}`);
    assert.deepEqual(f.calls.slice(1).map(queryOf), SOQL_CONN.slice(0, failAt + 1));
  }
});

test('testConnection failure message equals the SalesforceError userMessage', async () => {
  const viaFetch = mk(createFakeFetch([tokenOk(), sfError(403, 'INSUFFICIENT_ACCESS')]));
  const r = await viaFetch.testConnection();
  const err = await rejectsSf(mk(createFakeFetch([tokenOk(), sfError(403, 'INSUFFICIENT_ACCESS')])).fetchOpenOpportunities(OPEN), 'permission', 403);
  assert.equal(r.message, err.userMessage);
});

test('testConnection never rejects and never leaks secrets, whatever happens', async () => {
  const scripts = [
    [rejection(new TypeError('x'))],
    [rejection('weird')],
    [tokenOk(), rejection(namedError('TimeoutError'))],
    [response(200, {}, { jsonThrows: true })],
    [response(200, { access_token: ACCESS_TOKEN, instance_url: 'https://evil.io' })],
    [tokenOk(), response(200, null)],
    [tokenOk(), sfError(403, 'X', `${CLIENT_SECRET} ${ACCESS_TOKEN}`)],
    [],
  ];
  for (const script of scripts) {
    const r = await mk(createFakeFetch(script)).testConnection();
    assert.equal(r.ok, false);
    assert.ok(typeof r.errorClass === 'string');
    for (const s of [CLIENT_SECRET, ACCESS_TOKEN, CLIENT_ID]) assert.ok(!JSON.stringify(r).includes(s));
  }
});

test('testConnection ok result has no errorClass; failure has no stray keys', async () => {
  const ok = await mk(createFakeFetch([tokenOk(), idPage(), idPage(), idPage()])).testConnection();
  assert.deepEqual(Object.keys(ok).sort(), ['message', 'ok']);
  const bad = await mk(createFakeFetch([tokenError(401, 'x')])).testConnection();
  assert.deepEqual(Object.keys(bad).sort(), ['errorClass', 'message', 'ok']);
});

// ---------- fetchOpenOpportunities: input validation ----------

test('invalid horizonDate rejects with config and makes no network call', async () => {
  const invalid = [
    '2026-02-30', '2026-1-5', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29', '2026-01-00',
    '', null, undefined, 20260101, '2026/01/01', '01-01-2026', ' 2026-01-01', '2026-01-01 ', '2026-01-01T00:00:00Z',
    "2026-01-01' OR Name != '", '2026-01-01; DROP', '2026-01-01 OR IsClosed = true', 'LAST_N_DAYS:5', 'TODAY',
    '2026-01-01\n', '２０２６-01-01', {}, [], new Date('2026-01-01'),
  ];
  for (const horizonDate of invalid) {
    const f = createFakeFetch([tokenOk(), page([])]);
    await rejectsSf(mk(f).fetchOpenOpportunities({ horizonDate }), 'config');
    assert.equal(f.calls.length, 0, `network call for ${String(horizonDate)}`);
  }
});

test('missing argument object rejects with config (no TypeError) and no network call', async () => {
  for (const args of [undefined, null, {}]) {
    const f = createFakeFetch([tokenOk(), page([])]);
    let err;
    try { await mk(f).fetchOpenOpportunities(args); } catch (e) { err = e; }
    assert.ok(err instanceof SalesforceError, `${String(args)}: ${err?.stack}`);
    assert.equal(err.errorClass, 'config');
    assert.equal(f.calls.length, 0);
  }
});

test('leap day 2028-02-29 and boundary dates are accepted', async () => {
  for (const horizonDate of ['2028-02-29', '2026-12-31', '2026-01-01', '2000-02-29']) {
    const f = createFakeFetch([tokenOk(), page([])]);
    await mk(f).fetchOpenOpportunities({ horizonDate });
    assert.equal(queryOf(f.calls[1]), soqlOpen(horizonDate));
  }
  const f = createFakeFetch([tokenOk(), page([])]);
  await rejectsSf(mk(f).fetchOpenOpportunities({ horizonDate: '1900-02-29' }), 'config');
});

// ---------- fetchOpenOpportunities: query and pagination ----------

test('fetchOpenOpportunities sends the exact URL-encoded SOQL', async () => {
  const f = createFakeFetch([tokenOk(), page([])]);
  const out = await mk(f).fetchOpenOpportunities({ horizonDate: '2026-06-30' });
  assert.deepEqual(out, []);
  assert.equal(f.calls.length, 2);
  const c = f.calls[1];
  assert.equal(queryOf(c), soqlOpen('2026-06-30'));
  assert.ok(!/[ ,]/.test(c.url), 'spaces and commas must be percent-encoded');
  assert.ok(!c.url.includes('<='), 'comparison operator must be encoded');
  assert.equal(new URL(c.url).searchParams.get('q'), soqlOpen('2026-06-30'));
});

test('pagination across three pages: order preserved, one token, nextRecordsUrl against returned instance', async () => {
  const other = 'https://pod7.my.salesforce.com';
  const f = createFakeFetch([
    tokenOk(other),
    page([rawOpp('006A'), rawOpp('006B')], '/services/data/v67.0/query/01gAAA-2000', 5),
    page([rawOpp('006C')], '/services/data/v67.0/query/01gAAA-4000', 5),
    page([rawOpp('006D'), rawOpp('006E')], undefined, 5),
  ]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.id), ['006A', '006B', '006C', '006D', '006E']);
  assert.equal(tokenCalls(f).length, 1);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[2].url, `${other}/services/data/v67.0/query/01gAAA-2000`);
  assert.equal(f.calls[3].url, `${other}/services/data/v67.0/query/01gAAA-4000`);
  for (const c of f.calls.slice(1)) {
    assert.equal(c.method, 'GET');
    assert.equal(c.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  }
});

test('bad nextRecordsUrl is unexpected_response and is never requested', async () => {
  const bads = [
    'https://evil.io/services/data/v67.0/query/01g-2000',
    '//evil.io/services/data/v67.0/query/01g-2000',
    '/evil/services/data/v67.0/query/01g-2000',
    'services/data/v67.0/query/01g-2000',
    '/services/oauth2/token',
    '/services/dataX/v67.0',
    42,
    { a: 1 },
    true,
  ];
  for (const bad of bads) {
    const f = createFakeFetch([tokenOk(), response(200, { totalSize: 9, done: false, nextRecordsUrl: bad, records: [rawOpp('006A')] }), page([rawOpp('006B')])]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
    assert.equal(f.calls.length, 2, `requested after bad next ${JSON.stringify(bad)}`);
    assert.ok(f.calls.every((c) => !c.url.includes('evil')));
  }
});

test('done:false with no nextRecordsUrl does not loop forever (ends or errors, bounded calls)', async () => {
  const f = createFakeFetch(() => (call) => (call.url.includes('oauth2') ? tokenOk() : response(200, { totalSize: 9, done: false, records: [rawOpp('006A')] })));
  let err;
  try { await mk(f).fetchOpenOpportunities(OPEN); } catch (e) { err = e; }
  assert.ok(f.calls.length <= 3, `calls: ${f.calls.length}`);
  if (err) assert.ok(err instanceof SalesforceError);
});

test('maxPages exceeded is limits; exactly maxPages pages is fine', async () => {
  const infinite = (n) => createFakeFetch((call, i) => {
    if (i === 0) return tokenOk();
    return page([rawOpp(`006P${i}`)], `/services/data/v67.0/query/01g-${i}`, n);
  });
  const f = infinite(100);
  await rejectsSf(mk(f, { maxPages: 3 }).fetchOpenOpportunities(OPEN), 'limits');
  assert.ok(f.calls.length <= 1 + 4, `kept requesting: ${f.calls.length}`);

  const exact = createFakeFetch([
    tokenOk(),
    page([rawOpp('006A')], '/services/data/v67.0/query/01g-1'),
    page([rawOpp('006B')], '/services/data/v67.0/query/01g-2'),
    page([rawOpp('006C')]),
  ]);
  const out = await mk(exact, { maxPages: 3 }).fetchOpenOpportunities(OPEN);
  assert.equal(out.length, 3);
});

test('maxPages default is 200: 200 pages ok, 201 pages limits', async () => {
  const make = (total) => createFakeFetch((call, i) => {
    if (i === 0) return tokenOk();
    return i < total ? page([rawOpp(`006P${i}`)], `/services/data/v67.0/query/01g-${i}`) : page([rawOpp(`006P${i}`)]);
  });
  const ok = await mk(make(200)).fetchOpenOpportunities(OPEN);
  assert.equal(ok.length, 200);
  await rejectsSf(mk(make(201)).fetchOpenOpportunities(OPEN), 'limits');
});

test('an error on page 2 rejects the whole call (no partial results)', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A')], '/services/data/v67.0/query/01g-1'), sfError(500, 'UNKNOWN_EXCEPTION')]);
  await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'server', 500);
});

test('network failure on page 2 is network', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A')], '/services/data/v67.0/query/01g-1'), rejection(new TypeError('reset'))]);
  await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'network');
});

test('separate fetchOpenOpportunities calls each fetch their own token', async () => {
  const f = createFakeFetch([tokenOk(), page([]), tokenOk(), page([])]);
  const c = mk(f);
  await c.fetchOpenOpportunities(OPEN);
  await c.fetchOpenOpportunities(OPEN);
  assert.equal(tokenCalls(f).length, 2);
});

// ---------- normalisation ----------

test('normalisation keeps exactly the contract keys and drops everything else', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A')])]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out, [{
    id: '006A',
    stageName: 'Negotiation',
    probability: 60,
    closeDate: '2026-03-15',
    lineItems: [{ productCode: 'SKU-A', quantity: 10 }],
  }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['closeDate', 'id', 'lineItems', 'probability', 'stageName']);
  assert.deepEqual(Object.keys(out[0].lineItems[0]).sort(), ['productCode', 'quantity']);
  const text = JSON.stringify(out);
  for (const leaked of ['should not be copied', 'OwnerId', 'free text', 'NextStep', 'attributes', 'UnitPrice', '005OWNER']) {
    assert.ok(!text.includes(leaked), leaked);
  }
});

test('OpportunityLineItems null or absent gives lineItems []', async () => {
  const noKey = rawOpp('006B');
  delete noKey.OpportunityLineItems;
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A', { OpportunityLineItems: null }), noKey])]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.lineItems), [[], []]);
  assert.deepEqual(out.map((o) => o.id), ['006A', '006B']);
});

test('OpportunityLineItems with empty records gives []', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A', { OpportunityLineItems: { totalSize: 0, done: true, records: [] } })])]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out[0].lineItems, []);
});

test('null ProductCode becomes empty string; other line fields preserved in order', async () => {
  const items = {
    totalSize: 3, done: true,
    records: [
      { ProductCode: null, Quantity: 4 },
      { ProductCode: 'B', Quantity: 0 },
      { ProductCode: 'C', Quantity: 2.5 },
    ],
  };
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A', { OpportunityLineItems: items })])]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out[0].lineItems, [
    { productCode: '', quantity: 4 },
    { productCode: 'B', quantity: 0 },
    { productCode: 'C', quantity: 2.5 },
  ]);
});

test('records that are not objects or lack a string Id are skipped, order kept', async () => {
  const records = [
    rawOpp('006A'),
    null,
    'str',
    42,
    [],
    { StageName: 'X', Probability: 1, CloseDate: '2026-01-01' },
    rawOpp(undefined),
    rawOpp(null),
    rawOpp(12345),
    rawOpp('006B'),
    undefined,
    rawOpp('006C'),
  ];
  const f = createFakeFetch([tokenOk(), page(records)]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.id), ['006A', '006B', '006C']);
});

test('numeric fields stay numbers (probability 0 and 100, no coercion to string)', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A', { Probability: 0 }), rawOpp('006B', { Probability: 100 }), rawOpp('006C', { Probability: 12.5 })])]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.probability), [0, 100, 12.5]);
  for (const o of out) assert.equal(typeof o.probability, 'number');
});

test('output objects are fresh: mutating them does not touch a re-fetch', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A')]), tokenOk(), page([rawOpp('006A')])]);
  const c = mk(f);
  const a = await c.fetchOpenOpportunities(OPEN);
  a[0].lineItems.push({ productCode: 'Z', quantity: 1 });
  const b = await c.fetchOpenOpportunities(OPEN);
  assert.equal(b[0].lineItems.length, 1);
});

test('deep-frozen options and response payloads are handled without throwing', async () => {
  const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const payload = deepFreeze({ totalSize: 1, done: true, records: [rawOpp('006A')] });
  const f = createFakeFetch([tokenOk(), { ok: true, status: 200, json: async () => payload, text: async () => '' }]);
  const opts = deepFreeze({ horizonDate: '2026-12-31' });
  const out = await mk(f).fetchOpenOpportunities(opts);
  assert.equal(out.length, 1);
  assert.deepEqual(opts, { horizonDate: '2026-12-31' });
  const cfg = deepFreeze({ instanceUrl: INSTANCE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: createFakeFetch([tokenOk(), page([])]) });
  await createSalesforceClient(cfg).fetchOpenOpportunities(OPEN);
});

test('only ok/status/json() of the response are relied upon', async () => {
  const minimal = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const f = createFakeFetch([minimal(200, { access_token: ACCESS_TOKEN, instance_url: API_INSTANCE_URL }), minimal(200, { done: true, records: [rawOpp('006A')] })]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.equal(out.length, 1);
});

test('returned data and thrown errors never contain the token or secret', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A')])]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  const text = JSON.stringify(out);
  for (const s of [CLIENT_SECRET, ACCESS_TOKEN, CLIENT_ID]) assert.ok(!text.includes(s));
});

test('defaults: globalThis.fetch is used when fetchImpl is omitted (stubbed, no real network)', async () => {
  const real = globalThis.fetch;
  const f = createFakeFetch([tokenOk(), page([])]);
  globalThis.fetch = f;
  try {
    const c = createSalesforceClient({ instanceUrl: INSTANCE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await c.fetchOpenOpportunities(OPEN);
    assert.equal(f.calls.length, 2);
  } finally {
    globalThis.fetch = real;
  }
});

// ---------- redirect protection ----------

test('every fetch call (token, testConnection queries, paged queries) uses redirect: error', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A')], '/services/data/v67.0/query/01gA-2000'), page([])]);
  await mk(f).fetchOpenOpportunities(OPEN);
  assert.equal(f.calls.length, 3);
  for (const c of f.calls) assert.equal(c.init.redirect, 'error', c.url);

  const g = createFakeFetch([tokenOk(), page([]), page([]), page([])]);
  await mk(g).testConnection();
  assert.equal(g.calls.length, 4);
  for (const c of g.calls) assert.equal(c.init.redirect, 'error', c.url);
});

test('nextRecordsUrl with dot-dot traversal is unexpected_response and never requested', async () => {
  for (const bad of [
    '/services/data/../../services/oauth2/token',
    '/services/data/v67.0/query/../../../oauth2/token',
    '/services/data/..',
  ]) {
    const f = createFakeFetch([tokenOk(), response(200, { totalSize: 9, done: false, nextRecordsUrl: bad, records: [rawOpp('006A')] }), page([])]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
    assert.equal(f.calls.length, 2, bad);
  }
});

test('a TypeError from a blocked redirect is network and leaks no secret', async () => {
  for (const script of [
    [rejection(new TypeError(`fetch failed: redirect mode is set to error ${CLIENT_SECRET}`))],
    [tokenOk(), rejection(new TypeError(`redirect ${ACCESS_TOKEN}`))],
  ]) {
    const err = await rejectsSf(mk(createFakeFetch(script)).fetchOpenOpportunities(OPEN), 'network');
    assert.doesNotMatch(err.message, /timed out/i);
    const r = await mk(createFakeFetch(script)).testConnection();
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'network');
    for (const s of [CLIENT_SECRET, ACCESS_TOKEN, CLIENT_ID]) assert.ok(!JSON.stringify(r).includes(s));
  }
});
