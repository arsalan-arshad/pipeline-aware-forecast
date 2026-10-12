/**
 * Salesforce read client (BUILD_PLAN M2).
 *
 * Read-only: one OAuth 2.0 client-credentials token request, then SOQL reads
 * of open Opportunities and their line items (SPEC §2). The fetch function is
 * injected so every code path is testable without a network, and every failure
 * is mapped to a small set of error classes with a message a merchant can act
 * on. Messages never contain the client secret, client id or access token.
 *
 * Only the fields the engine needs are copied out of each record; anything
 * else Salesforce returns is dropped here, so it can never reach storage or
 * an AI prompt (SPEC §5, §8).
 *
 * An Opportunity with more line items than fit in one nested page comes back
 * with a nextRecordsUrl on its OpportunityLineItems. Those pages are followed
 * one at a time, in order, and appended to that Opportunity's line items. The
 * nested link gets the same path checks as the top-level one, and nested and
 * top-level pages share one maxPages budget (exceeding it is a 'limits' error).
 */

export const ERROR_CLASSES = Object.freeze({
  CONFIG: 'config',
  AUTH: 'auth',
  PERMISSION: 'permission',
  LIMITS: 'limits',
  NETWORK: 'network',
  SERVER: 'server',
  UNEXPECTED_RESPONSE: 'unexpected_response',
});

export class SalesforceError extends Error {
  constructor(errorClass, message, status = null) {
    super(message);
    this.name = 'SalesforceError';
    this.errorClass = errorClass;
    this.status = status;
    this.userMessage = message;
  }
}

/**
 * Credentials are only ever sent to a Salesforce-owned https host, so a
 * mistyped or malicious instance URL cannot receive them.
 */
const MY_DOMAIN_HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.(sandbox|develop|scratch|trailblaze))?\.my\.salesforce\.com$/;

export function isAllowedInstanceUrl(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return false;
  }
  // Only a Salesforce "My Domain" API host on the default port. A broader rule (any *.force.com) would
  // let a hostile Salesforce Site receive the client credentials and stream an unbounded reply.
  if (parsed.port !== '') return false;
  const host = parsed.hostname.toLowerCase();
  return MY_DOMAIN_HOST.test(host);
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

async function send(ctx, url, init) {
  try {
    return await ctx.fetchImpl(url, {
      ...init,
      // Never follow redirects: a redirect would re-send the client secret
      // (token request) or bearer token to wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new SalesforceError(
      ERROR_CLASSES.NETWORK,
      timedOut
        ? 'Salesforce did not respond in time (the request timed out).'
        : 'Could not reach Salesforce. Check the instance URL and the network connection.',
    );
  }
}

// A reply larger than this is refused (a hostile or broken endpoint could otherwise exhaust memory).
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function tooMuchData(status) {
  return new SalesforceError(
    ERROR_CLASSES.UNEXPECTED_RESPONSE,
    'Salesforce sent more data than this app accepts, so the request was stopped.',
    status,
  );
}

async function readJson(res) {
  const declared = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooMuchData(res.status);
  const reader = res?.body?.getReader?.();
  if (!reader) {
    // Test doubles and non-streaming responses: no size information to enforce.
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  const chunks = [];
  let total = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        exceeded = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  if (exceeded) throw tooMuchData(res.status);
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return undefined;
  }
}

function tokenError(status, body) {
  if (status >= 500) {
    return new SalesforceError(
      ERROR_CLASSES.SERVER,
      `Salesforce had a temporary problem while logging in (HTTP ${status}). Try again later.`,
      status,
    );
  }
  if (status === 400 || status === 401 || status === 403) {
    const code = body && typeof body.error === 'string' ? body.error : '';
    let message;
    if (code === 'unsupported_grant_type') {
      message =
        'Salesforce rejected the login: the client credentials flow is not enabled for this External Client App.';
    } else if (code === 'invalid_client' || code === 'invalid_client_id') {
      message = 'Salesforce did not recognise the client ID or client secret.';
    } else if (code === 'inactive_user') {
      message =
        'Salesforce rejected the login: the Run As user is inactive or cannot be used for this app.';
    } else {
      const safeCode = /^[A-Za-z_]{1,64}$/.test(code) ? code : 'unknown_error';
      message = `Salesforce rejected the login (${safeCode}).`;
    }
    return new SalesforceError(ERROR_CLASSES.AUTH, message, status);
  }
  return new SalesforceError(
    ERROR_CLASSES.UNEXPECTED_RESPONSE,
    `Unexpected response from Salesforce while logging in (HTTP ${status}).`,
    status,
  );
}

function apiError(status, body) {
  const first = Array.isArray(body) ? body[0] : body;
  const code = first && typeof first.errorCode === 'string' ? first.errorCode : '';
  if (status === 401) {
    return new SalesforceError(
      ERROR_CLASSES.AUTH,
      'Salesforce rejected the access token (invalid or expired session). Run the connection test again.',
      status,
    );
  }
  if (status === 429 || (status === 403 && code === 'REQUEST_LIMIT_EXCEEDED')) {
    return new SalesforceError(
      ERROR_CLASSES.LIMITS,
      'The Salesforce API request limit has been reached. Try again later.',
      status,
    );
  }
  if (status === 403) {
    return new SalesforceError(
      ERROR_CLASSES.PERMISSION,
      'The Run As user is not allowed to read this data through the API. Check that API access is enabled and that the user can read Opportunity, OpportunityLineItem and Product2.',
      status,
    );
  }
  if (status === 400 && (code === 'INVALID_TYPE' || code === 'INVALID_FIELD')) {
    return new SalesforceError(
      ERROR_CLASSES.PERMISSION,
      'Salesforce says an object or field is not visible to the Run As user. Grant read access to Opportunity, OpportunityLineItem and Product2.',
      status,
    );
  }
  if (status >= 500) {
    return new SalesforceError(
      ERROR_CLASSES.SERVER,
      `Salesforce had a temporary problem (HTTP ${status}). Try again later.`,
      status,
    );
  }
  return new SalesforceError(
    ERROR_CLASSES.UNEXPECTED_RESPONSE,
    `Unexpected response from Salesforce (HTTP ${status}).`,
    status,
  );
}

async function getToken(ctx) {
  const res = await send(ctx, `${ctx.baseUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
    }).toString(),
  });
  const body = await readJson(res);
  if (!res.ok) throw tokenError(res.status, body);

  if (!body || !isNonEmptyString(body.access_token)) {
    throw new SalesforceError(
      ERROR_CLASSES.UNEXPECTED_RESPONSE,
      'Salesforce answered the login without an access token.',
      res.status,
    );
  }
  const returned = body.instance_url ?? ctx.baseUrl;
  if (!isAllowedInstanceUrl(returned)) {
    throw new SalesforceError(
      ERROR_CLASSES.UNEXPECTED_RESPONSE,
      'Salesforce returned an instance URL that is not a Salesforce host, so the request was stopped.',
      res.status,
    );
  }
  return { accessToken: body.access_token, apiBase: new URL(returned).origin };
}

async function apiGet(ctx, token, url) {
  const res = await send(ctx, url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  const body = await readJson(res);
  if (!res.ok) throw apiError(res.status, body);
  if (!body || typeof body !== 'object' || !Array.isArray(body.records)) {
    throw new SalesforceError(
      ERROR_CLASSES.UNEXPECTED_RESPONSE,
      'Salesforce returned data in a shape this app does not understand.',
      res.status,
    );
  }
  return body;
}

function queryUrl(ctx, token, soql) {
  return `${token.apiBase}/services/data/${ctx.apiVersion}/query?q=${encodeURIComponent(soql)}`;
}

function normalizeOpportunity(record) {
  if (!record || typeof record !== 'object' || typeof record.Id !== 'string') {
    return null;
  }
  const items = Array.isArray(record.OpportunityLineItems?.records)
    ? record.OpportunityLineItems.records
    : [];
  return {
    id: record.Id,
    stageName: record.StageName,
    probability: record.Probability,
    closeDate: record.CloseDate,
    lineItems: items
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        productCode: typeof item.ProductCode === 'string' ? item.ProductCode : '',
        quantity: item.Quantity,
      })),
  };
}

const ACCESS_CHECKS = [
  'SELECT Id FROM Opportunity LIMIT 1',
  'SELECT Id FROM OpportunityLineItem LIMIT 1',
  'SELECT Id FROM Product2 LIMIT 1',
];

export function createSalesforceClient({
  instanceUrl,
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  apiVersion = 'v67.0',
  timeoutMs = 15000,
  maxPages = 200,
} = {}) {
  if (!isAllowedInstanceUrl(instanceUrl)) {
    throw new SalesforceError(
      ERROR_CLASSES.CONFIG,
      'instanceUrl must be an https Salesforce My Domain address, e.g. https://yourcompany.my.salesforce.com.',
    );
  }
  if (!isNonEmptyString(clientId)) {
    throw new SalesforceError(ERROR_CLASSES.CONFIG, 'clientId is required.');
  }
  if (!isNonEmptyString(clientSecret)) {
    throw new SalesforceError(ERROR_CLASSES.CONFIG, 'clientSecret is required.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new SalesforceError(ERROR_CLASSES.CONFIG, 'No fetch function is available.');
  }

  const ctx = {
    baseUrl: new URL(instanceUrl).origin,
    clientId,
    clientSecret,
    fetchImpl,
    apiVersion,
    timeoutMs,
  };

  /**
   * Resolves (never rejects for Salesforce or network problems) to
   * { ok: true, message } or { ok: false, errorClass, message }.
   */
  async function testConnection() {
    try {
      const token = await getToken(ctx);
      for (const soql of ACCESS_CHECKS) {
        await apiGet(ctx, token, queryUrl(ctx, token, soql));
      }
      return {
        ok: true,
        message:
          'Connected. Read access to Opportunity, OpportunityLineItem and Product2 is confirmed.',
      };
    } catch (err) {
      if (err instanceof SalesforceError) {
        return { ok: false, errorClass: err.errorClass, message: err.userMessage };
      }
      return {
        ok: false,
        errorClass: ERROR_CLASSES.UNEXPECTED_RESPONSE,
        message: 'The connection test failed for an unexpected reason.',
      };
    }
  }

  /**
   * Open Opportunities closing on or before horizonDate, with line items,
   * normalised to the engine's input shape (docs/M1_CONTRACT.md).
   */
  async function fetchOpenOpportunities(args) {
    const horizonDate = args?.horizonDate;
    if (!isRealDate(horizonDate)) {
      throw new SalesforceError(
        ERROR_CLASSES.CONFIG,
        'horizonDate must be a real calendar date in YYYY-MM-DD format.',
      );
    }
    const soql =
      'SELECT Id, StageName, Probability, CloseDate, ' +
      '(SELECT ProductCode, Quantity FROM OpportunityLineItems) ' +
      `FROM Opportunity WHERE IsClosed = false AND CloseDate <= ${horizonDate} ` +
      'ORDER BY CloseDate';

    const token = await getToken(ctx);
    const opportunities = [];
    let url = queryUrl(ctx, token, soql);
    let pages = 0;
    const limitsError = () =>
      new SalesforceError(
        ERROR_CLASSES.LIMITS,
        `Salesforce returned more than ${maxPages} pages of Opportunities; narrow the forecast horizon.`,
      );
    while (url) {
      const page = await apiGet(ctx, token, url);
      pages += 1;
      for (const record of page.records) {
        const opportunity = normalizeOpportunity(record);
        if (!opportunity) continue;
        opportunities.push(opportunity);

        // Follow this Opportunity's remaining line item pages, one at a time.
        const nested = record.OpportunityLineItems;
        let nestedUrl =
          nested && typeof nested === 'object' && nested.done !== true && isNonEmptyString(nested.nextRecordsUrl)
            ? nested.nextRecordsUrl
            : null;
        while (nestedUrl) {
          if (
            typeof nestedUrl !== 'string' ||
            !nestedUrl.startsWith('/services/data/') ||
            nestedUrl.includes('..') ||
            nestedUrl.includes('\\')
          ) {
            throw new SalesforceError(
              ERROR_CLASSES.UNEXPECTED_RESPONSE,
              'Salesforce returned an unexpected link to the next page of line items.',
            );
          }
          if (pages >= maxPages) throw limitsError();
          const nestedPage = await apiGet(ctx, token, `${token.apiBase}${nestedUrl}`);
          pages += 1;
          for (const item of nestedPage.records) {
            if (!item || typeof item !== 'object') continue;
            opportunity.lineItems.push({
              productCode: typeof item.ProductCode === 'string' ? item.ProductCode : '',
              quantity: item.Quantity,
            });
          }
          nestedUrl = nestedPage.done === true ? null : nestedPage.nextRecordsUrl || null;
        }
      }
      const next = page.nextRecordsUrl;
      if (!next) break;
      if (
        typeof next !== 'string' ||
        !next.startsWith('/services/data/') ||
        next.includes('..') ||
        next.includes('\\')
      ) {
        throw new SalesforceError(
          ERROR_CLASSES.UNEXPECTED_RESPONSE,
          'Salesforce returned an unexpected link to the next page of results.',
        );
      }
      if (pages >= maxPages) throw limitsError();
      url = `${token.apiBase}${next}`;
    }
    return opportunities;
  }

  return { testConnection, fetchOpenOpportunities };
}
