/**
 * Read-only Shopify Admin GraphQL data access for Pipeline-Aware Forecast.
 *
 * Three reads, all taking an injected `admin` (as from `authenticate.admin` in
 * @shopify/shopify-app-remix): `await admin.graphql(query, { variables })` returns a
 * Response-like object whose `await res.json()` gives `{ data, errors, extensions }`.
 *
 *   fetchVariantSkus(admin)        distinct SKUs of ACTIVE products' variants
 *   fetchSkuStock(admin)           SKU -> total `available` units across locations/variants
 *   fetchDailyDemand(admin, opts)  SKU -> average units/day over the last N days (N <= 60)
 *
 * Rules: queries only (no mutations); no customer, address, contact or name fields are
 * selected (aggregates per SKU only; order and inventory-item ids are used only to page);
 * no clock or env reads (`now` is injected). Errors thrown by this module are ShopifyDataError
 * with fixed messages that never echo GraphQL error text, tokens or shop data. If
 * `admin.graphql` itself rejects, that error propagates unchanged.
 *
 * Throttle retry: when a response carries an error with extensions.code 'THROTTLED', the same
 * request is retried after waiting 1000, 2000, 4000 ms via the injected `sleep` (options
 * `sleep`, `maxRetries` default 3). Still throttled -> ShopifyDataError('throttled'). Other
 * errors are not retried. Retries do not consume `maxPages`.
 *
 * Page budget: every GraphQL page request, top-level or nested follow-up, counts toward
 * `maxPages` (default 400 for stock and demand, 100 for SKUs); exceeding it throws
 * 'too_many_pages'.
 *
 * Scopes: read_products, read_inventory, read_orders. Without read_all_orders Shopify only
 * exposes roughly the last 60 days of orders, hence the 60-day clamp.
 * Docs (API 2026-10): https://shopify.dev/docs/api/admin-graphql/2026-10/queries/productVariants
 *   .../queries/orders, .../objects/InventoryLevel, and the Order resource caution at
 *   https://shopify.dev/docs/api/admin-rest/2026-10/resources/order
 *
 * Query cost: Shopify rejects any single query whose estimated cost exceeds 1,000 points, and the
 * estimate multiplies page sizes through nested connections. Page sizes: stock 100 variants x 10
 * locations; orders 50 orders x 25 line items. Measured real cost was small (13/86/5 points of a
 * 1,000 limit). Nested connections are followed: an item with more than 10 inventory levels, or an
 * order with more than 25 line items, is completed through INVENTORY_LEVELS_MORE_QUERY /
 * ORDER_LINE_ITEMS_MORE_QUERY, so large items and orders are not undercounted.
 *
 * Known limits:
 *  - Reading many pages of orders is slow under Shopify's rate limit, so busy stores can hit
 *    'throttled' or 'too_many_pages'. The proper fix for large stores is a Shopify bulk operation
 *    (not implemented).
 */

const MESSAGES = {
  bad_input: 'Invalid input for the Shopify data request.',
  throttled: 'Shopify is rate limiting requests. Try again shortly.',
  graphql_error: 'Shopify rejected the data request.',
  unexpected_response: 'Shopify returned an unexpected response.',
  too_many_pages: 'The Shopify catalog or order history is too large to read in one run.',
};

export class ShopifyDataError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.name = 'ShopifyDataError';
    this.code = code;
    this.userMessage = this.message;
  }
}

export const VARIANT_SKUS_QUERY = `#graphql
  query PafVariantSkus($cursor: String) {
    productVariants(first: 250, after: $cursor, query: "product_status:active") {
      nodes {
        sku
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const SKU_STOCK_QUERY = `#graphql
  query PafSkuStock($cursor: String) {
    productVariants(first: 100, after: $cursor, query: "product_status:active") {
      nodes {
        sku
        inventoryItem {
          id
          inventoryLevels(first: 10) {
            nodes {
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const ORDERS_DEMAND_QUERY = `#graphql
  query PafOrdersDemand($cursor: String, $query: String) {
    orders(first: 50, after: $cursor, query: $query) {
      nodes {
        id
        createdAt
        cancelledAt
        lineItems(first: 25) {
          nodes {
            sku
            currentQuantity
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const INVENTORY_LEVELS_MORE_QUERY = `#graphql
  query PafInventoryLevelsMore($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on InventoryItem {
        inventoryLevels(first: 10, after: $cursor) {
          nodes {
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

export const ORDER_LINE_ITEMS_MORE_QUERY = `#graphql
  query PafOrderLineItemsMore($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on Order {
        lineItems(first: 25, after: $cursor) {
          nodes {
            sku
            currentQuantity
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const DEFAULT_DAYS = 28;
const MIN_DAYS = 1;
const MAX_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const isObject = (v) => v !== null && typeof v === 'object';
const cleanSku = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function fail(code) {
  throw new ShopifyDataError(code);
}

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run one query once and return `data`, mapping every failure shape to a ShopifyDataError. */
async function runOnce(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  let body;
  try {
    body = await res.json();
  } catch {
    return fail('unexpected_response');
  }
  if (!isObject(body)) return fail('unexpected_response');
  if (body.errors !== undefined && body.errors !== null) {
    const list = Array.isArray(body.errors) ? body.errors : [body.errors];
    if (list.length > 0 || !Array.isArray(body.errors)) {
      const throttled = list.some((e) => isObject(e) && isObject(e.extensions) && e.extensions.code === 'THROTTLED');
      return fail(throttled ? 'throttled' : 'graphql_error');
    }
  }
  if (!isObject(body.data)) return fail('unexpected_response');
  return body.data;
}

/**
 * Run one page request: spends one unit of the shared page budget, retries the same request
 * while throttled (retries are free). ctx: { used, maxPages, sleep, maxRetries }.
 */
async function runQuery(ctx, admin, query, variables) {
  if (ctx.used >= ctx.maxPages) return fail('too_many_pages');
  ctx.used += 1;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runOnce(admin, query, variables);
    } catch (err) {
      if (!(err instanceof ShopifyDataError) || err.code !== 'throttled' || attempt >= ctx.maxRetries) throw err;
      await ctx.sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
    }
  }
}

function makeCtx({ maxPages, sleep = defaultSleep, maxRetries = 3 }) {
  if (!Number.isInteger(maxPages) || maxPages < 1) fail('bad_input');
  if (typeof sleep !== 'function' || !Number.isInteger(maxRetries) || maxRetries < 0) fail('bad_input');
  return { used: 0, maxPages, sleep, maxRetries };
}

/** Validate `{ nodes, pageInfo }`; returns the next cursor, or null when there is no next page. */
function nextCursor(conn) {
  if (!isObject(conn) || !Array.isArray(conn.nodes) || !isObject(conn.pageInfo)) return fail('unexpected_response');
  if (conn.pageInfo.hasNextPage !== true) return null;
  if (typeof conn.pageInfo.endCursor !== 'string' || conn.pageInfo.endCursor === '') return fail('unexpected_response');
  return conn.pageInfo.endCursor;
}

/**
 * Follow a nested connection past its first page. `first` is the already-read connection; each
 * further page of `node(id).<field>` is passed to onNodes. Returns nothing.
 */
async function followNested(ctx, admin, query, id, field, first, onNodes) {
  let cursor = nextCursor(first);
  while (cursor !== null) {
    if (typeof id !== 'string' || id === '') return fail('unexpected_response');
    const data = await runQuery(ctx, admin, query, { id, cursor });
    if (!isObject(data.node)) return fail('unexpected_response');
    const conn = data.node[field];
    cursor = nextCursor(conn);
    onNodes(conn.nodes);
  }
}

/**
 * Page through a connection at `data[field]`, awaiting onNode for each node.
 * Throws too_many_pages if a request is needed beyond the shared budget.
 */
async function paginate(ctx, admin, query, field, baseVariables, onNode) {
  let cursor = null;
  for (;;) {
    const data = await runQuery(ctx, admin, query, { ...baseVariables, cursor });
    const conn = data[field];
    cursor = nextCursor(conn);
    for (const node of conn.nodes) {
      if (!isObject(node)) return fail('unexpected_response');
      await onNode(node);
    }
    if (cursor === null) return;
  }
}

/** Distinct trimmed non-empty SKUs of variants of ACTIVE products, plain-string sorted. */
export async function fetchVariantSkus(admin, { maxPages = 100, sleep, maxRetries } = {}) {
  const ctx = makeCtx({ maxPages, sleep, maxRetries });
  const skus = new Set();
  await paginate(ctx, admin, VARIANT_SKUS_QUERY, 'productVariants', {}, (node) => {
    const sku = cleanSku(node.sku);
    if (sku) skus.add(sku);
  });
  return [...skus].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sumAvailable(levels) {
  let total = 0;
  for (const level of levels) {
    const quantities = isObject(level) ? level.quantities : null;
    if (!Array.isArray(quantities)) continue;
    for (const q of quantities) {
      if (!isObject(q) || q.name !== 'available') continue;
      if (typeof q.quantity === 'number' && Number.isFinite(q.quantity) && q.quantity > 0) {
        total += q.quantity;
      }
    }
  }
  return total;
}

/** SKU -> total `available` units across all locations and variants sharing the SKU. */
export async function fetchSkuStock(admin, { maxPages = 400, sleep, maxRetries } = {}) {
  const ctx = makeCtx({ maxPages, sleep, maxRetries });
  const stock = new Map();
  await paginate(ctx, admin, SKU_STOCK_QUERY, 'productVariants', {}, async (node) => {
    const sku = cleanSku(node.sku);
    let total = 0;
    const conn = node.inventoryItem?.inventoryLevels;
    if (conn !== undefined && conn !== null) {
      nextCursor(conn);
      total += sumAvailable(conn.nodes);
      await followNested(ctx, admin, INVENTORY_LEVELS_MORE_QUERY, node.inventoryItem.id, 'inventoryLevels', conn, (nodes) => {
        total += sumAvailable(nodes);
      });
    }
    if (!sku) return;
    stock.set(sku, (stock.get(sku) ?? 0) + total);
  });
  return stock;
}

/**
 * Pure. orders: [{ cancelledAt, lineItems: [{ sku, currentQuantity }] }].
 * Returns SKU -> units per day (sum of currentQuantity / days), rounded to 4 decimals.
 */
export function computeDailyDemand(orders, days) {
  if (!Number.isInteger(days) || days <= 0 || !Array.isArray(orders)) fail('bad_input');
  const totals = new Map();
  for (const order of orders) {
    if (!isObject(order) || (order.cancelledAt !== null && order.cancelledAt !== undefined)) continue;
    if (!Array.isArray(order.lineItems)) continue;
    for (const item of order.lineItems) {
      if (!isObject(item)) continue;
      const sku = cleanSku(item.sku);
      const qty = item.currentQuantity;
      if (!sku || typeof qty !== 'number' || !Number.isFinite(qty) || qty < 0) continue;
      totals.set(sku, (totals.get(sku) ?? 0) + qty);
    }
  }
  const out = new Map();
  for (const [sku, total] of totals) out.set(sku, Math.round((total / days) * 1e4) / 1e4);
  return out;
}

/** SKU -> average units/day over the last `days` (clamped to [1, 60]) ending at `now`. */
export async function fetchDailyDemand(admin, { days = DEFAULT_DAYS, now, maxPages = 400, sleep, maxRetries } = {}) {
  const ctx = makeCtx({ maxPages, sleep, maxRetries });
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('bad_input');
  const n = Number.isFinite(days) ? Math.trunc(days) : DEFAULT_DAYS;
  const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
  const since = new Date(now.getTime() - clamped * DAY_MS).toISOString();
  const orders = [];
  await paginate(ctx, admin, ORDERS_DEMAND_QUERY, 'orders', { query: `created_at:>=${since}` }, async (node) => {
    const conn = node.lineItems;
    const lineItems = [];
    if (conn !== undefined && conn !== null) {
      nextCursor(conn);
      lineItems.push(...conn.nodes);
      await followNested(ctx, admin, ORDER_LINE_ITEMS_MORE_QUERY, node.id, 'lineItems', conn, (nodes) => {
        lineItems.push(...nodes);
      });
    }
    orders.push({ cancelledAt: node.cancelledAt ?? null, lineItems });
  });
  return computeDailyDemand(orders, clamped);
}
