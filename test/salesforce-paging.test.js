// Independent tests for nested line-item paging in the Salesforce read client, written from the contract only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SalesforceError, createSalesforceClient } from '../app/lib/pipeline/salesforce-client.server.js';
import {
  INSTANCE_URL, CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, API_INSTANCE_URL,
  response, tokenOk, page, rawOpp, createFakeFetch, tokenCalls,
} from './fixtures/salesforce-fixtures.js';

const mk = (fetchImpl, over = {}) =>
  createSalesforceClient({ instanceUrl: INSTANCE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl, ...over });
const OPEN = { horizonDate: '2026-12-31' };

async function rejectsSf(promise, errorClass) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err instanceof SalesforceError, `not a SalesforceError: ${err?.stack}`);
  assert.equal(err.errorClass, errorClass, `class was ${err.errorClass}: ${err.message}`);
  return err;
}

const nestedUrl = (n) => `/services/data/v67.0/query/01nNEST-${n}`;
const li = (code, qty) => ({ ProductCode: code, Quantity: qty });
// Opportunity whose first line-item page is `records` and which has more pages at `next`.
const oppWith = (id, records, next, over = {}) => rawOpp(id, {
  OpportunityLineItems: next === undefined
    ? { totalSize: records.length, done: true, records }
    : { totalSize: 99, done: false, nextRecordsUrl: next, records },
  ...over,
});
const nestedPage = (records, next, extra = {}) =>
  response(200, next ? { done: false, nextRecordsUrl: next, records, ...extra } : { done: true, records, ...extra });

// Fake fetch that answers by URL path so ordering bugs show up as wrong data or recorded order.
function byUrl(top, nested) {
  return createFakeFetch((call) => {
    if (call.url.includes('/services/oauth2/token')) return tokenOk();
    const path = new URL(call.url).pathname;
    if (Object.hasOwn(nested, path)) return nested[path];
    return top;
  });
}
const paths = (f) => f.calls.slice(1).map((c) => new URL(c.url).pathname);

test('one opportunity with three nested pages: order preserved, totals, one token, bearer on all', async () => {
  const f = byUrl(
    page([oppWith('006A', [li('P1', 1), li('P2', 2)], nestedUrl(1))]),
    {
      [nestedUrl(1)]: nestedPage([li('P3', 3)], nestedUrl(2)),
      [nestedUrl(2)]: nestedPage([li('P4', 4), li('P5', 5)], nestedUrl(3)),
      [nestedUrl(3)]: nestedPage([li('P6', 6)]),
    },
  );
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].lineItems.map((l) => l.productCode), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.deepEqual(out[0].lineItems.map((l) => l.quantity), [1, 2, 3, 4, 5, 6]);
  assert.equal(out[0].lineItems.reduce((s, l) => s + l.quantity, 0), 21);
  assert.equal(f.calls.length, 5);
  assert.equal(tokenCalls(f).length, 1);
  assert.deepEqual(paths(f).slice(1), [nestedUrl(1), nestedUrl(2), nestedUrl(3)]);
  for (const c of f.calls.slice(1)) {
    assert.equal(c.method, 'GET');
    assert.equal(c.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  }
  assert.equal(f.calls[2].url, `${API_INSTANCE_URL}${nestedUrl(1)}`);
});

test('nested pages are normalised like the first page: null/absent ProductCode -> empty, non-objects skipped', async () => {
  const f = byUrl(
    page([oppWith('006A', [li(null, 1)], nestedUrl(1))]),
    { [nestedUrl(1)]: nestedPage([li(null, 2), { Quantity: 3 }, null, 'str', 7, li('Z', 4)]) },
  );
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out[0].lineItems, [
    { productCode: '', quantity: 1 },
    { productCode: '', quantity: 2 },
    { productCode: '', quantity: 3 },
    { productCode: 'Z', quantity: 4 },
  ]);
});

test('extra response fields from nested pages are never copied', async () => {
  const f = byUrl(
    page([oppWith('006A', [li('P1', 1)], nestedUrl(1))]),
    {
      [nestedUrl(1)]: nestedPage(
        [{ attributes: { type: 'OpportunityLineItem' }, ProductCode: 'P2', Quantity: 2, Name: 'leak-name', Description: 'leak-desc' }],
        undefined,
        { totalSize: 1, Name: 'leak-body' },
      ),
    },
  );
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out[0].lineItems, [{ productCode: 'P1', quantity: 1 }, { productCode: 'P2', quantity: 2 }]);
  const text = JSON.stringify(out);
  for (const leaked of ['leak-name', 'leak-desc', 'leak-body', 'attributes']) assert.ok(!text.includes(leaked), leaked);
});

test('two opportunities with nested pages: strictly sequential, each gets only its own items', async () => {
  const log = [];
  const f = createFakeFetch((call) => {
    if (call.url.includes('/services/oauth2/token')) return tokenOk();
    const path = new URL(call.url).pathname;
    log.push(`start ${path}`);
    const answer = {
      [nestedUrl('A1')]: nestedPage([li('A2', 2)], nestedUrl('A2')),
      [nestedUrl('A2')]: nestedPage([li('A3', 3)]),
      [nestedUrl('B1')]: nestedPage([li('B2', 20)]),
    }[path];
    return answer ?? page([
      oppWith('006A', [li('A1', 1)], nestedUrl('A1')),
      oppWith('006B', [li('B1', 10)], nestedUrl('B1')),
      oppWith('006C', [li('C1', 100)]),
    ]);
  });
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.id), ['006A', '006B', '006C']);
  assert.deepEqual(out[0].lineItems.map((l) => l.productCode), ['A1', 'A2', 'A3']);
  assert.deepEqual(out[1].lineItems.map((l) => l.productCode), ['B1', 'B2']);
  assert.deepEqual(out[2].lineItems.map((l) => l.productCode), ['C1']);
  const nestedOrder = paths(f).filter((p) => p.includes('NEST'));
  assert.deepEqual(nestedOrder, [nestedUrl('A1'), nestedUrl('A2'), nestedUrl('B1')]);
  assert.equal(f.calls.length, 5);
  assert.equal(tokenCalls(f).length, 1);
});

test('nested paging combined with top-level paging', async () => {
  const f = createFakeFetch((call) => {
    if (call.url.includes('/services/oauth2/token')) return tokenOk();
    const path = new URL(call.url).pathname;
    if (path === nestedUrl('X1')) return nestedPage([li('X2', 2)]);
    if (path === nestedUrl('Y1')) return nestedPage([li('Y2', 2)]);
    if (path === '/services/data/v67.0/query/01gTOP-2000') {
      return page([oppWith('006C', [li('Y1', 1)], nestedUrl('Y1')), oppWith('006D', [li('D1', 1)])]);
    }
    return page([oppWith('006A', [li('X1', 1)], nestedUrl('X1')), oppWith('006B', [li('B1', 1)])], '/services/data/v67.0/query/01gTOP-2000');
  });
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.id), ['006A', '006B', '006C', '006D']);
  assert.deepEqual(out.map((o) => o.lineItems.length), [2, 1, 2, 1]);
  assert.equal(f.calls.length, 5); // token + 2 top-level + 2 nested
  assert.equal(tokenCalls(f).length, 1);
});

test('opportunities without nested paging make exactly the same requests as before', async () => {
  const f = createFakeFetch([tokenOk(), page([rawOpp('006A'), rawOpp('006B')], '/services/data/v67.0/query/01gTOP-2000'), page([rawOpp('006C')])]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.equal(out.length, 3);
  assert.equal(f.calls.length, 3);
});

test('done:true with a leftover nextRecordsUrl is ignored, as are empty or non-string urls', async () => {
  const f = createFakeFetch([tokenOk(), page([
    rawOpp('006A', { OpportunityLineItems: { done: true, nextRecordsUrl: nestedUrl(1), records: [li('P1', 1)] } }),
    rawOpp('006B', { OpportunityLineItems: { done: false, nextRecordsUrl: '', records: [li('P2', 2)] } }),
    rawOpp('006C', { OpportunityLineItems: { done: false, records: [li('P3', 3)] } }),
  ])]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.lineItems.length), [1, 1, 1]);
  assert.equal(f.calls.length, 2);
});

test('bad nested urls are unexpected_response and are never requested', async () => {
  const bads = [
    '/services/data/v67.0/query/../../oauth2/token',
    '/services/data/v67.0/../query',
    '/other/path',
    '/services/oauth2/token',
    'https://evil.example/',
    'https://evil.example/services/data/v67.0/query/01g-1',
    '//evil.example/services/data/v67.0/query/01g-1',
    'services/data/v67.0/query/01g-1',
    '/services/data/v67.0/query\\01g-1',
    '\\services\\data\\v67.0',
  ];
  for (const bad of bads) {
    const f = createFakeFetch([tokenOk(), page([oppWith('006A', [li('P1', 1)], bad)])]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
    assert.equal(f.calls.length, 2, `requested after bad nested url ${JSON.stringify(bad)}`);
    assert.ok(f.calls.every((c) => !c.url.includes('evil')));
  }
});

test('bad nested url returned by a nested page is rejected without being requested', async () => {
  const f = byUrl(
    page([oppWith('006A', [li('P1', 1)], nestedUrl(1))]),
    { [nestedUrl(1)]: nestedPage([li('P2', 2)], '/services/data/v67.0/query/../x') },
  );
  await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
  assert.equal(f.calls.length, 3);
});

test('malformed nested body is unexpected_response', async () => {
  const bodies = [
    response(200, { done: true }),
    response(200, { done: true, records: 'nope' }),
    response(200, { done: true, records: { 0: li('P', 1) } }),
    response(200, null),
    response(200, []),
    response(200, 'text'),
    response(200, {}, { jsonThrows: true }),
  ];
  for (const body of bodies) {
    const f = byUrl(page([oppWith('006A', [li('P1', 1)], nestedUrl(1))]), { [nestedUrl(1)]: body });
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
  }
});

test('an error on a nested page rejects the whole call (no partial results)', async () => {
  const f = byUrl(
    page([oppWith('006A', [li('P1', 1)], nestedUrl(1))]),
    { [nestedUrl(1)]: response(500, [{ message: 'boom', errorCode: 'UNKNOWN_EXCEPTION' }]) },
  );
  await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'server');
});

test('maxPages counts top-level and nested pages together: exactly maxPages ok, one more is limits', async () => {
  // 1 top-level + 2 nested = 3 page GETs
  const make = () => byUrl(
    page([oppWith('006A', [li('P1', 1)], nestedUrl(1))]),
    { [nestedUrl(1)]: nestedPage([li('P2', 2)], nestedUrl(2)), [nestedUrl(2)]: nestedPage([li('P3', 3)]) },
  );
  const ok = make();
  assert.equal((await mk(ok, { maxPages: 3 }).fetchOpenOpportunities(OPEN))[0].lineItems.length, 3);
  assert.equal(ok.calls.length, 4);
  const bad = make();
  await rejectsSf(mk(bad, { maxPages: 2 }).fetchOpenOpportunities(OPEN), 'limits');
  assert.ok(bad.calls.length <= 3, `kept requesting: ${bad.calls.length}`); // token + at most 2 pages
});

test('budget is shared across top-level paging and nested paging', async () => {
  // top1 (nested n1) , top2 -> 3 page GETs
  const make = () => createFakeFetch((call) => {
    if (call.url.includes('/services/oauth2/token')) return tokenOk();
    const path = new URL(call.url).pathname;
    if (path === nestedUrl(1)) return nestedPage([li('P2', 2)]);
    if (path === '/services/data/v67.0/query/01gTOP-2000') return page([oppWith('006B', [li('Q1', 1)])]);
    return page([oppWith('006A', [li('P1', 1)], nestedUrl(1))], '/services/data/v67.0/query/01gTOP-2000');
  });
  assert.equal((await mk(make(), { maxPages: 3 }).fetchOpenOpportunities(OPEN)).length, 2);
  await rejectsSf(mk(make(), { maxPages: 2 }).fetchOpenOpportunities(OPEN), 'limits');
});

test('budget spans several opportunities that each have nested pages', async () => {
  // 1 top + 3 opportunities x 1 nested = 4 GETs
  const make = () => createFakeFetch((call) => {
    if (call.url.includes('/services/oauth2/token')) return tokenOk();
    const path = new URL(call.url).pathname;
    if (path.includes('NEST')) return nestedPage([li('N', 1)]);
    return page([1, 2, 3].map((n) => oppWith(`006${n}`, [li('F', 1)], nestedUrl(n))));
  });
  const out = await mk(make(), { maxPages: 4 }).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.lineItems.length), [2, 2, 2]);
  await rejectsSf(mk(make(), { maxPages: 3 }).fetchOpenOpportunities(OPEN), 'limits');
});

test('default maxPages is 200 counting nested pages: 200 page GETs ok, 201 limits', async () => {
  // one opportunity; first page is the top-level GET, the rest are nested
  const make = (total) => createFakeFetch((call) => {
    if (call.url.includes('/services/oauth2/token')) return tokenOk();
    const m = /NEST-(\d+)$/.exec(call.url);
    const n = m ? Number(m[1]) : 0; // number of this nested page; top-level counts as page 1
    if (!m) return page([oppWith('006A', [li('P', 1)], nestedUrl(1))]);
    return n + 1 < total ? nestedPage([li('P', 1)], nestedUrl(n + 1)) : nestedPage([li('P', 1)]);
  });
  const ok = make(200);
  const out = await mk(ok).fetchOpenOpportunities(OPEN);
  assert.equal(out[0].lineItems.length, 200);
  assert.equal(ok.calls.length, 201); // token + 200
  await rejectsSf(mk(make(201)).fetchOpenOpportunities(OPEN), 'limits');
});

test('default maxPages is 200 for top-level paging alone', async () => {
  const make = (total) => createFakeFetch((call, i) => {
    if (i === 0) return tokenOk();
    return i < total ? page([rawOpp(`006P${i}`)], `/services/data/v67.0/query/01g-${i}`) : page([rawOpp(`006P${i}`)]);
  });
  assert.equal((await mk(make(200)).fetchOpenOpportunities(OPEN)).length, 200);
  await rejectsSf(mk(make(201)).fetchOpenOpportunities(OPEN), 'limits');
});

test('a nested page with done:true ignores a leftover nextRecordsUrl; done:false without a url ends paging', async () => {
  const f = byUrl(
    page([oppWith('006A', [li('P1', 1)], nestedUrl(1)), oppWith('006B', [li('Q1', 1)], nestedUrl(2))]),
    {
      [nestedUrl(1)]: response(200, { done: true, nextRecordsUrl: nestedUrl(9), records: [li('P2', 2)] }),
      [nestedUrl(2)]: response(200, { done: false, records: [li('Q2', 2)] }),
    },
  );
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.lineItems.length), [2, 2]);
  assert.equal(f.calls.length, 4);
  assert.ok(!paths(f).includes(nestedUrl(9)));
});

// ---- response size cap and strict hosts ----
const MAX = 10 * 1024 * 1024;
const TOO_MUCH = 'Salesforce sent more data than this app accepts, so the request was stopped.';

// Response-like with a streaming body; `cancelled` records whether reader.cancel() ran.
function streamed(status, chunks, { contentLength } = {}) {
  const state = { cancelled: false, reads: 0 };
  let i = 0;
  return {
    state,
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' && contentLength !== undefined ? String(contentLength) : null) },
    json: async () => { throw new Error('json() must not be used when a stream reader exists'); },
    body: {
      getReader: () => ({
        read: async () => {
          state.reads += 1;
          return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined };
        },
        cancel: async () => { state.cancelled = true; },
      }),
    },
  };
}
const bytes = (obj) => new TextEncoder().encode(JSON.stringify(obj));

test('a normal streamed body (split across chunks) parses as JSON for token and API replies', async () => {
  const tok = bytes({ access_token: ACCESS_TOKEN, instance_url: API_INSTANCE_URL });
  const pg = bytes({ totalSize: 1, done: true, records: [rawOpp('006A')] });
  const f = createFakeFetch([
    streamed(200, [tok.slice(0, 7), tok.slice(7)]),
    streamed(200, [pg.slice(0, 30), pg.slice(30, 90), pg.slice(90)]),
  ]);
  const out = await mk(f).fetchOpenOpportunities(OPEN);
  assert.deepEqual(out.map((o) => o.id), ['006A']);
});

test('content-length above 10 MiB is unexpected_response with the fixed message, for token and API replies', async () => {
  const tooBig = streamed(200, [bytes({ a: 1 })], { contentLength: MAX + 1 });
  const e1 = await rejectsSf(mk(createFakeFetch([tooBig])).fetchOpenOpportunities(OPEN), 'unexpected_response');
  assert.equal(e1.message, TOO_MUCH);

  const apiBig = streamed(200, [bytes({ records: [] })], { contentLength: MAX + 1 });
  const e2 = await rejectsSf(mk(createFakeFetch([tokenOk(), apiBig])).fetchOpenOpportunities(OPEN), 'unexpected_response');
  assert.equal(e2.message, TOO_MUCH);

  // a Response-like with only headers + json() is also refused on content-length
  const plain = { ...response(200, { records: [] }), headers: { get: () => String(MAX + 1) } };
  const e3 = await rejectsSf(mk(createFakeFetch([tokenOk(), plain])).fetchOpenOpportunities(OPEN), 'unexpected_response');
  assert.equal(e3.message, TOO_MUCH);
});

test('content-length of exactly 10 MiB is not refused on the header', async () => {
  const body = bytes({ totalSize: 0, done: true, records: [] });
  const f = createFakeFetch([tokenOk(), streamed(200, [body], { contentLength: MAX })]);
  assert.deepEqual(await mk(f).fetchOpenOpportunities(OPEN), []);
});

test('a stream whose running total exceeds 10 MiB is refused and the reader is cancelled', async () => {
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB
  const chunks = Array.from({ length: 11 }, () => chunk);
  const res = streamed(200, chunks); // no content-length header
  const e = await rejectsSf(mk(createFakeFetch([tokenOk(), res])).fetchOpenOpportunities(OPEN), 'unexpected_response');
  assert.equal(e.message, TOO_MUCH);
  assert.equal(res.state.cancelled, true);
  assert.equal(res.state.reads, 11, 'stopped at the chunk that crossed the cap');
});

test('a stream of exactly 10 MiB is not refused for size (fails only as malformed JSON)', async () => {
  const res = streamed(200, Array.from({ length: 10 }, () => new Uint8Array(1024 * 1024)));
  const e = await rejectsSf(mk(createFakeFetch([tokenOk(), res])).fetchOpenOpportunities(OPEN), 'unexpected_response');
  assert.notEqual(e.message, TOO_MUCH);
  assert.equal(res.state.cancelled, false);
});

test('the cap also applies to the token reply and to nested pages', async () => {
  const bigChunks = Array.from({ length: 11 }, () => new Uint8Array(1024 * 1024));
  const tokenRes = streamed(200, bigChunks);
  const e1 = await rejectsSf(mk(createFakeFetch([tokenRes])).fetchOpenOpportunities(OPEN), 'unexpected_response');
  assert.equal(e1.message, TOO_MUCH);
  assert.equal(tokenRes.state.cancelled, true);

  const nestedRes = streamed(200, bigChunks);
  const f = createFakeFetch([tokenOk(), page([oppWith('006A', [li('P1', 1)], nestedUrl(1))]), nestedRes]);
  const e2 = await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
  assert.equal(e2.message, TOO_MUCH);
  assert.equal(nestedRes.state.cancelled, true);
});

test('the oversize error leaks no secret', async () => {
  const e = await rejectsSf(mk(createFakeFetch([tokenOk(), streamed(200, [], { contentLength: MAX + 1 })])).fetchOpenOpportunities(OPEN), 'unexpected_response');
  for (const s of [CLIENT_SECRET, CLIENT_ID, ACCESS_TOKEN]) assert.ok(!JSON.stringify(e).includes(s) && !e.message.includes(s));
});

test('token instance_url must be a My Domain host on the default port', async () => {
  const bads = [
    'https://acme.lightning.force.com',
    'https://acme.force.com',
    'https://acme.salesforce.com',
    'https://acme.my.site.com',
    'https://acme.my.salesforce.com:8443',
    'https://acme.my.salesforce.com.evil.io',
    'http://acme.my.salesforce.com',
  ];
  for (const bad of bads) {
    const f = createFakeFetch([tokenOk(bad), page([])]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
    assert.equal(f.calls.length, 1, `API called after bad instance_url ${bad}`);
  }
  const f = createFakeFetch([tokenOk('https://orgfarm-x-dev-ed.develop.my.salesforce.com'), page([])]);
  await mk(f).fetchOpenOpportunities(OPEN);
  assert.ok(f.calls[1].url.startsWith('https://orgfarm-x-dev-ed.develop.my.salesforce.com/'));
});

test('top-level nextRecordsUrl containing a backslash is rejected and never requested', async () => {
  for (const bad of ['/services/data/v67.0/query\\01g-1', '/services/data/v67.0\\..\\x', '/services\\data/v67.0/query/01g']) {
    const f = createFakeFetch([tokenOk(), page([rawOpp('006A')], bad), page([rawOpp('006B')])]);
    await rejectsSf(mk(f).fetchOpenOpportunities(OPEN), 'unexpected_response');
    assert.equal(f.calls.length, 2, JSON.stringify(bad));
  }
});
