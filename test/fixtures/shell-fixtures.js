// Fixtures for the Shopify shell tests: a fake Prisma client and a fake Shopify admin.
// No network, no database. Helpers deep-freeze inputs so mutation shows up as a TypeError.

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Fake Prisma. Any delegate method returns an operation descriptor { model, method, args } and
 * records nothing itself. $transaction(ops) requires an array, records it, resolves to the
 * descriptors. Delegate calls made outside a $transaction array are caught by the caller
 * only when it actually invokes them, so they are logged in `directCalls` at call time and
 * removed from the log when the descriptor is later passed into $transaction.
 */
export function createFakePrisma({ transactionError } = {}) {
  const state = {
    transactions: [],
    directCalls: [],
    transactionError: transactionError ?? null,
    calls: [], // every delegate or $transaction call, in order
  };
  const delegates = new Map();
  const target = {
    $transaction(ops) {
      state.calls.push({ kind: 'transaction' });
      if (!Array.isArray(ops)) throw new TypeError('$transaction expects an array');
      for (const op of ops) {
        const idx = state.directCalls.indexOf(op);
        if (idx !== -1) state.directCalls.splice(idx, 1);
      }
      state.transactions.push(ops);
      if (state.transactionError) return Promise.reject(state.transactionError);
      return Promise.resolve(ops);
    },
  };
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in state) return state[prop];
      if (prop in t) return t[prop];
      if (typeof prop !== 'string') return undefined;
      if (!delegates.has(prop)) {
        delegates.set(prop, new Proxy({}, {
          get(_d, method) {
            if (typeof method !== 'string') return undefined;
            return (args) => {
              const op = { model: prop, method, args };
              state.directCalls.push(op);
              state.calls.push({ kind: 'delegate', model: prop, method });
              return op;
            };
          },
        }));
      }
      return delegates.get(prop);
    },
    set(t, prop, value) {
      if (prop === 'transactionError') { state.transactionError = value; return true; }
      return false;
    },
  });
  return proxy;
}

/** Fake admin: queue of responses; each is a body object, an Error (reject), or { jsonThrows }. */
export function createFakeAdmin(responses) {
  const queue = [...responses];
  const calls = [];
  return {
    calls,
    async graphql(query, options) {
      calls.push({ query, variables: options?.variables });
      if (queue.length === 0) throw new Error('fake admin: no more responses');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return {
        async json() {
          if (next && next.jsonThrows) throw new Error('bad json');
          return next;
        },
      };
    },
  };
}

// ---- Store inputs (aggregates only) ----
export const SHOP = 'demo-shop.myshopify.com';
export const SYNCED_AT = '2026-03-02T10:15:30.000Z';

export function snapshotRow(over = {}) {
  return { sku: 'SKU-A', weekStart: '2026-03-02', weightedQty: 7.5, rawQty: 10, openDealCount: 2, ...over };
}
export function unmatchedRow(over = {}) {
  return { productCode: 'PC-9', openDealCount: 1, rawQty: 4, ...over };
}

// ---- Shopify page builders ----
export function variantsPage(skus, { hasNextPage = false, endCursor = null } = {}) {
  return {
    data: {
      productVariants: {
        nodes: skus.map((sku) => ({ sku })),
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

export function stockPage(variants, { hasNextPage = false, endCursor = null } = {}) {
  // variants: [{ sku, levels: [availableQty, ...], itemId?, more?: { hasNextPage, endCursor } }]
  return {
    data: {
      productVariants: {
        nodes: variants.map((v) => ({
          sku: v.sku,
          inventoryItem: {
            id: v.itemId ?? `gid://shopify/InventoryItem/${v.sku}`,
            inventoryLevels: {
              nodes: v.levels.map((q) => ({ quantities: [{ name: 'available', quantity: q }] })),
              pageInfo: v.more ?? { hasNextPage: false, endCursor: null },
            },
          },
        })),
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

export function ordersPage(orders, { hasNextPage = false, endCursor = null } = {}) {
  // orders: [{ cancelledAt, items: [[sku, qty], ...], id?, more?: { hasNextPage, endCursor } }]
  return {
    data: {
      orders: {
        nodes: orders.map((o, i) => ({
          id: o.id ?? `gid://shopify/Order/${i + 1}`,
          createdAt: '2026-03-01T00:00:00Z',
          cancelledAt: o.cancelledAt ?? null,
          lineItems: {
            nodes: o.items.map(([sku, currentQuantity]) => ({ sku, currentQuantity })),
            pageInfo: o.more ?? { hasNextPage: false, endCursor: null },
          },
        })),
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

// Follow-up page builders for the nested paging queries.
export function levelsMorePage(levels, { hasNextPage = false, endCursor = null } = {}) {
  return {
    data: {
      node: {
        inventoryLevels: {
          nodes: levels.map((q) => ({ quantities: [{ name: 'available', quantity: q }] })),
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

export function lineItemsMorePage(items, { hasNextPage = false, endCursor = null } = {}) {
  return {
    data: {
      node: {
        lineItems: {
          nodes: items.map(([sku, currentQuantity]) => ({ sku, currentQuantity })),
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

export const THROTTLED = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] };
