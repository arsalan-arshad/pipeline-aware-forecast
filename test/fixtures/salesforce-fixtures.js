// Fake-fetch helper and canned payloads for the Salesforce client tests.
// No network: every response is scripted, every call is recorded.

export const INSTANCE_URL = 'https://acme-dev.my.salesforce.com';
export const API_INSTANCE_URL = 'https://acme-dev.my.salesforce.com';
export const CLIENT_ID = 'FAKE_CLIENT_ID_k39vq';
export const CLIENT_SECRET = 'FAKE_SECRET_zx81qvPLM';
export const ACCESS_TOKEN = 'FAKE_TOKEN_00Dabc123xyz';
export const API_VERSION = 'v67.0';

// Response-like object: the client may only rely on ok, status and json().
export function response(status, body, { jsonThrows = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonThrows) throw new SyntaxError('Unexpected token < in JSON');
      return structuredClone(body);
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

export const tokenOk = (instanceUrl = API_INSTANCE_URL, extra = {}) =>
  response(200, { access_token: ACCESS_TOKEN, instance_url: instanceUrl, token_type: 'Bearer', ...extra });

export const sfError = (status, errorCode, message = 'sf says no') =>
  response(status, [{ message, errorCode }]);

export const tokenError = (status, error, description = 'secret-ish description text') =>
  response(status, { error, error_description: description });

export const page = (records, nextRecordsUrl, totalSize = records.length) =>
  response(200, nextRecordsUrl
    ? { totalSize, done: false, nextRecordsUrl, records }
    : { totalSize, done: true, records });

export const rejection = (error) => ({ reject: error });

export function namedError(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

function normaliseHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) {
    h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

// script: array of steps consumed in order, or a function (call, index) => step.
// step: a response(), { reject: Error }, or a function (call) => response/{reject}.
// An exhausted script yields a rejection so over-calling shows up as a failure.
export function createFakeFetch(script = []) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: normaliseHeaders(init.headers),
      body: init.body === undefined ? undefined : String(init.body),
      signal: init.signal,
      init,
    };
    const index = calls.length;
    calls.push(call);
    let step = typeof script === 'function' ? script(call, index) : script[index];
    if (typeof step === 'function') step = step(call, index);
    if (step === undefined) throw new Error(`fake fetch: no scripted response for call #${index} ${call.url}`);
    if (step && Object.hasOwn(step, 'reject')) throw step.reject;
    return step;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

export const tokenCalls = (fetchImpl) => fetchImpl.calls.filter((c) => c.url.includes('/services/oauth2/token'));
export const queryOf = (call) => new URL(call.url).searchParams.get('q');

export const SOQL_CONN = [
  'SELECT Id FROM Opportunity LIMIT 1',
  'SELECT Id FROM OpportunityLineItem LIMIT 1',
  'SELECT Id FROM Product2 LIMIT 1',
];

export const soqlOpen = (horizonDate) =>
  'SELECT Id, StageName, Probability, CloseDate, (SELECT ProductCode, Quantity FROM OpportunityLineItems) ' +
  `FROM Opportunity WHERE IsClosed = false AND CloseDate <= ${horizonDate} ORDER BY CloseDate`;

// Raw Salesforce-shaped opportunity with extra fields the client must drop.
export function rawOpp(id, over = {}) {
  return {
    attributes: { type: 'Opportunity', url: `/services/data/${API_VERSION}/sobjects/Opportunity/${id}` },
    Id: id,
    Name: 'should not be copied',
    OwnerId: '005OWNER',
    Description: 'free text',
    NextStep: 'call',
    StageName: 'Negotiation',
    Probability: 60,
    CloseDate: '2026-03-15',
    OpportunityLineItems: {
      totalSize: 1,
      done: true,
      records: [{ attributes: { type: 'OpportunityLineItem' }, ProductCode: 'SKU-A', Quantity: 10, UnitPrice: 5, Description: 'x' }],
    },
    ...over,
  };
}
