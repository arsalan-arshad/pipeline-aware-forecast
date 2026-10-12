/**
 * Stockout burn-down simulation.
 *
 * Day-by-day inventory simulation: starting stock is drawn down by steady
 * retail demand plus (optionally) expected pipeline shipments, and we report
 * the first day the level reaches zero or below. The order-by day is that
 * stockout day minus the supplier lead time, so a negative value means the
 * reorder window has already been missed.
 *
 * Pure and deterministic: no network, no AI, no clock, no imports. Day 0 is
 * "today"; all days are integers. Runs in O(horizon + shipments).
 */

/** Coerce to a finite non-negative number, else 0. */
function nonNegative(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Simulate stock burn-down.
 *
 * Day t = 0..horizonDays: from day 1 onward retail demand is consumed, then
 * shipments landing on day t (day < 0 counts as day 0) are consumed. A level
 * <= 0 (including exactly 0) is a stockout.
 *
 * @param {object} args
 * @param {number} args.stock - units on hand today
 * @param {number} args.retailDailyDemand - units sold per day (bad values -> 0)
 * @param {{day: number, qty: number}[]} [args.shipments] - pipeline draws
 * @param {number} args.leadTimeDays - supplier lead time
 * @param {number} args.horizonDays - last simulated day (bad values -> 0)
 * @returns {{stockoutDay: number|null, orderByDay: number|null}}
 */
export function simulateBurnDown({
  stock,
  retailDailyDemand,
  shipments = [],
  leadTimeDays,
  horizonDays,
} = {}) {
  const retail = nonNegative(retailDailyDemand);
  const horizon = Number.isFinite(horizonDays) && horizonDays > 0 ? Math.floor(horizonDays) : 0;

  // Group shipment quantities by day (negative days -> day 0).
  const byDay = new Map();
  for (const s of Array.isArray(shipments) ? shipments : []) {
    if (!s || !Number.isFinite(s.day) || !Number.isFinite(s.qty)) continue;
    const day = Math.max(0, Math.floor(s.day));
    if (day > horizon) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + s.qty);
  }

  let level = Number.isFinite(stock) ? stock : 0;
  let stockoutDay = null;
  for (let t = 0; t <= horizon; t++) {
    if (t > 0) level -= retail;
    level -= byDay.get(t) ?? 0;
    if (level <= 0) {
      stockoutDay = t;
      break;
    }
  }

  const lead = Number.isFinite(leadTimeDays) ? leadTimeDays : 0;
  return {
    stockoutDay,
    orderByDay: stockoutDay === null ? null : stockoutDay - lead,
  };
}

/**
 * Run the three scenarios: retail only, probability-weighted pipeline, and
 * every open deal closing at full quantity.
 *
 * @param {object} args - as simulateBurnDown, but shipments are
 *   `{day, weightedQty, rawQty}` entries from the pipeline-demand module
 * @returns {{retailOnly: object, weighted: object, allClose: object}}
 */
export function scenarioSet({
  stock,
  retailDailyDemand,
  shipments,
  leadTimeDays,
  horizonDays,
} = {}) {
  const list = Array.isArray(shipments) ? shipments : [];
  const base = { stock, retailDailyDemand, leadTimeDays, horizonDays };
  return {
    retailOnly: simulateBurnDown({ ...base, shipments: [] }),
    weighted: simulateBurnDown({
      ...base,
      shipments: list.map((s) => ({ day: s?.day, qty: s?.weightedQty })),
    }),
    allClose: simulateBurnDown({
      ...base,
      shipments: list.map((s) => ({ day: s?.day, qty: s?.rawQty })),
    }),
  };
}
