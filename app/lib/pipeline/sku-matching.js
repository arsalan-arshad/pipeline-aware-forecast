/**
 * SKU matching: Salesforce product codes -> Shopify SKUs.
 *
 * Pure and deterministic: no I/O, no clock, no imports. Matching is EXACT
 * after normalisation (trim, collapse internal whitespace, lower-case). There
 * is deliberately no fuzzy matching: a wrong guess here would move a stockout
 * date, so anything that does not match exactly is surfaced through
 * summarizeUnmatched() for the merchant to map by hand.
 *
 * Only aggregates leave this module: product code, distinct-deal count and
 * summed quantity. Opportunity ids are used to count and never returned.
 */

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Canonical form used for comparing codes. Blank/nullish -> ''.
 * @param {*} s
 * @returns {string}
 */
export function normalizeSku(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Build a lookup from normalised code to the Shopify SKU as stored.
 * Blank SKUs are skipped. If two different Shopify SKUs normalise equal the
 * first wins in `index` and the clash is reported in `collisions`.
 * @param {string[]} shopifySkus
 * @returns {{ index: Map<string, string>, collisions: { normalized: string, skus: string[] }[] }}
 */
export function buildSkuIndex(shopifySkus) {
  const index = new Map();
  const clashes = new Map(); // normalized -> distinct skus seen, in order
  const list = Array.isArray(shopifySkus) ? shopifySkus : [];

  for (const sku of list) {
    const normalized = normalizeSku(sku);
    if (normalized === '') continue;
    if (!index.has(normalized)) {
      index.set(normalized, sku);
      continue;
    }
    const seen = clashes.get(normalized) ?? [index.get(normalized)];
    // The very same string listed twice is one SKU, not a collision.
    if (!seen.includes(sku)) seen.push(sku);
    clashes.set(normalized, seen);
  }

  const collisions = [];
  for (const [normalized, skus] of clashes) {
    if (skus.length > 1) collisions.push({ normalized, skus });
  }
  return { index, collisions };
}

/**
 * Exact normalised lookup. Blank codes never match.
 * @param {*} productCode
 * @param {{ index: Map<string, string> } | Map<string, string>} index
 *   the object from buildSkuIndex (a bare Map is also accepted)
 * @returns {string|null}
 */
export function resolveSku(productCode, index) {
  const map = index instanceof Map ? index : index?.index;
  if (!(map instanceof Map)) return null;
  const normalized = normalizeSku(productCode);
  if (normalized === '') return null;
  return map.get(normalized) ?? null;
}

/**
 * Product codes in the open pipeline that do not resolve to a Shopify SKU.
 * One row per distinct normalised code, sorted by normalised code ascending.
 * `productCode` is the first spelling seen. `openDealCount` counts distinct
 * opportunities; `rawQty` sums positive finite quantities (others ignored).
 * @param {{ id?: string, lineItems?: { productCode?: *, quantity?: number }[] }[]} opportunities
 * @param {{ index: Map<string, string> } | Map<string, string>} index
 * @returns {{ productCode: string, openDealCount: number, rawQty: number }[]}
 */
export function summarizeUnmatched(opportunities, index) {
  const rows = new Map(); // normalized -> { productCode, deals: Set<opp>, rawQty }
  const opps = Array.isArray(opportunities) ? opportunities : [];

  for (const opp of opps) {
    const items = Array.isArray(opp?.lineItems) ? opp.lineItems : [];
    for (const item of items) {
      const qty = item?.quantity;
      if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) continue;
      if (resolveSku(item?.productCode, index) !== null) continue;

      const normalized = normalizeSku(item?.productCode);
      let row = rows.get(normalized);
      if (!row) {
        row = {
          productCode: normalized === '' ? '' : String(item.productCode).trim(),
          deals: new Set(),
          rawQty: 0,
        };
        rows.set(normalized, row);
      }
      row.deals.add(opp); // by object identity: ids are opaque and may repeat or be absent
      row.rawQty += qty;
    }
  }

  return [...rows.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => {
      const row = rows.get(key);
      return {
        productCode: row.productCode,
        openDealCount: row.deals.size,
        rawQty: round2(row.rawQty),
      };
    });
}
