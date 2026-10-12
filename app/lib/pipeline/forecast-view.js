/**
 * Forecast view.
 *
 * Pure function that turns Shopify stock and demand plus the stored weekly
 * pipeline snapshot into per-SKU rows with the three burn-down scenarios
 * (retail only, probability-weighted pipeline, every open deal closes).
 *
 * Pure and deterministic: no network, no database, no clock reads (`today` is
 * passed in), no randomness, and the inputs are never mutated.
 */

import { scenarioSet } from './burn-down.js';
import { weeksToShipments } from './pipeline-demand.js';
import { addDaysIso } from './pipeline-sync.server.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

function isRealDate(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Map or plain object (or absent) -> array of [key, value] entries. */
function entriesOf(source) {
  if (source instanceof Map) return [...source.entries()];
  if (source !== null && typeof source === 'object') return Object.entries(source);
  return [];
}

/** Map<string, number> of sanitised quantities: non-finite/negative -> 0. */
function quantityMap(source) {
  const out = new Map();
  for (const [sku, value] of entriesOf(source)) {
    if (typeof sku !== 'string') continue;
    out.set(sku, Number.isFinite(value) && value > 0 ? value : 0);
  }
  return out;
}

function toDates(today, scenario) {
  const { stockoutDay, orderByDay } = scenario;
  return {
    stockoutDay,
    orderByDay,
    stockoutDate: stockoutDay === null ? null : addDaysIso(today, stockoutDay),
    // A negative orderByDay gives a date in the past: the order is already late.
    orderByDate: orderByDay === null ? null : addDaysIso(today, orderByDay),
  };
}

/**
 * Build the per-SKU forecast rows, sorted by sku (plain string compare).
 *
 * @param {object} args
 * @param {string} args.today - 'YYYY-MM-DD'
 * @param {Map<string, number>|Object<string, number>} [args.stockBySku]
 * @param {Map<string, number>|Object<string, number>} [args.dailyDemandBySku]
 * @param {{sku: string, weekStart: string, weightedQty: number, rawQty: number, openDealCount: number}[]} [args.snapshots]
 * @param {number} [args.leadTimeDays=14]
 * @param {number} [args.horizonDays=90]
 */
export function buildForecastRows({
  today,
  stockBySku,
  dailyDemandBySku,
  snapshots,
  leadTimeDays = 14,
  horizonDays = 90,
} = {}) {
  if (!isRealDate(today)) {
    throw new Error('today must be a real YYYY-MM-DD date.');
  }

  const stocks = quantityMap(stockBySku);
  const demands = quantityMap(dailyDemandBySku);

  // Group snapshot weeks by SKU, skipping rows that cannot be used.
  const weeksBySku = new Map();
  for (const row of Array.isArray(snapshots) ? snapshots : []) {
    if (!row || typeof row.sku !== 'string') continue;
    if (
      !Number.isFinite(row.weightedQty) ||
      !Number.isFinite(row.rawQty) ||
      !Number.isFinite(row.openDealCount)
    ) {
      continue;
    }
    let weeks = weeksBySku.get(row.sku);
    if (!weeks) {
      weeks = [];
      weeksBySku.set(row.sku, weeks);
    }
    weeks.push({
      weekStart: row.weekStart,
      weightedQty: row.weightedQty,
      rawQty: row.rawQty,
      openDealCount: row.openDealCount,
    });
  }

  const skus = new Set([...stocks.keys(), ...demands.keys(), ...weeksBySku.keys()]);

  const rows = [];
  for (const sku of skus) {
    const stock = stocks.get(sku) ?? 0;
    const retailDailyDemand = demands.get(sku) ?? 0;
    const weeks = (weeksBySku.get(sku) ?? []).sort((a, b) =>
      a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0,
    );

    const shipments = weeksToShipments(weeks, today);
    const scenarios = scenarioSet({
      stock,
      retailDailyDemand,
      shipments,
      leadTimeDays,
      horizonDays,
    });

    let openDealCount = 0;
    let weighted = 0;
    let raw = 0;
    for (const w of weeks) {
      // A deal spanning two weeks is counted once per week, so this is a
      // sum of weekly counts, not a distinct-deal count.
      openDealCount += w.openDealCount;
      weighted += w.weightedQty;
      raw += w.rawQty;
    }

    rows.push({
      sku,
      stock,
      retailDailyDemand: round4(retailDailyDemand),
      openDealCount,
      weightedUnits: round2(weighted),
      rawUnits: round2(raw),
      scenarios: {
        retailOnly: toDates(today, scenarios.retailOnly),
        weighted: toDates(today, scenarios.weighted),
        allClose: toDates(today, scenarios.allClose),
      },
    });
  }

  rows.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  return rows;
}
