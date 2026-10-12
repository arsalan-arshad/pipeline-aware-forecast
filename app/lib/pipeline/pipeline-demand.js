/**
 * Weighted pipeline demand.
 *
 * Turns open, already-normalised opportunities into per-SKU expected
 * shipments: each deal's line-item quantity is scaled by its effective close
 * probability (Salesforce 0-100 scale, optional per-stage overrides, and a
 * global 0-1 haircut) and placed on the day it is expected to ship
 * (close date + shipOffsetDays). Output is aggregate only: per-SKU, per-day
 * or per-ISO-week quantities and distinct-deal counts. Nothing that
 * identifies an account, contact or deal value is read, kept or returned,
 * and the opportunity id is never emitted.
 *
 * Pure and deterministic: no network, no AI, no clock reads. "Today" is
 * always passed in. All dates are 'YYYY-MM-DD' strings interpreted in UTC and
 * compared as integer day numbers, so there is no timezone drift. Opportunities
 * with a missing or invalid closeDate are skipped, never thrown on.
 *
 * See docs/M1_CONTRACT.md for the exact shapes.
 */

import { resolveSku } from "./sku-matching.js";

const MS_PER_DAY = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const round2 = (n) => Math.round(n * 100) / 100;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Parse 'YYYY-MM-DD' to an integer day number since 1970-01-01 (UTC).
 * Returns null for anything that is not a real calendar date.
 */
function parseDay(value) {
  if (typeof value !== "string") return null;
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  // Reject roll-overs such as 2026-02-30.
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return ms / MS_PER_DAY;
}

/** Format an integer day number (days since 1970-01-01 UTC) as 'YYYY-MM-DD'. */
function formatDay(dayNumber) {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Day number of the ISO Monday on or before the given day number. */
function isoMondayOf(dayNumber) {
  // 1970-01-01 (day 0) was a Thursday, so (day + 3) % 7 counts days since Monday.
  const sinceMonday = (((dayNumber + 3) % 7) + 7) % 7;
  return dayNumber - sinceMonday;
}

/**
 * Probability a deal closes and ships, as a number in [0, 1].
 * @param {number} probability - Salesforce scale, 0-100
 * @param {string} stageName
 * @param {Object<string, number>} [stageOverrides] - stage -> 0-100
 * @param {number} [haircut=1] - global 0-1 multiplier
 */
export function effectiveProbability(
  probability,
  stageName,
  stageOverrides = {},
  haircut = 1,
) {
  const hasOverride =
    stageOverrides !== null &&
    typeof stageOverrides === "object" &&
    Object.prototype.hasOwnProperty.call(stageOverrides, stageName) &&
    stageOverrides[stageName] != null;
  const raw = hasOverride ? stageOverrides[stageName] : probability;
  const p = Number.isFinite(Number(raw)) ? Number(raw) : 0;
  const h = Number.isFinite(Number(haircut)) ? Number(haircut) : 1;
  return clamp(p / 100, 0, 1) * clamp(h, 0, 1);
}

/**
 * Walk the opportunities once and produce unrounded per-SKU, per-day totals.
 * Returns Map<sku, Map<day, { weighted, raw, deals }>>.
 */
function accumulate({
  opportunities,
  stageOverrides = {},
  haircut = 1,
  shipOffsetDays = 7,
  today,
  horizonDays,
  skuIndex,
}) {
  const bySku = new Map();
  const todayDay = parseDay(today);
  if (todayDay === null || !skuIndex || !Array.isArray(opportunities)) {
    return bySku;
  }
  const offset = Number.isFinite(Number(shipOffsetDays))
    ? Math.trunc(Number(shipOffsetDays))
    : 7;
  const horizon = Number.isFinite(Number(horizonDays))
    ? Number(horizonDays)
    : Infinity;

  for (const opp of opportunities) {
    if (!opp || typeof opp !== "object") continue;
    const closeDay = parseDay(opp.closeDate);
    if (closeDay === null) continue;

    const shipDay = closeDay - todayDay + offset;
    if (shipDay > horizon) continue;
    const day = Math.max(0, shipDay); // overdue deals still count, at day 0

    const prob = effectiveProbability(
      opp.probability,
      opp.stageName,
      stageOverrides,
      haircut,
    );

    // Sum line items per SKU within this opportunity so the deal counts once.
    const qtyBySku = new Map();
    const items = Array.isArray(opp.lineItems) ? opp.lineItems : [];
    for (const item of items) {
      if (!item) continue;
      const qty = item.quantity;
      // Numeric strings are ignored, not coerced.
      if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) continue;
      const sku = resolveSku(item.productCode, skuIndex);
      if (sku === null || sku === undefined) continue;
      qtyBySku.set(sku, (qtyBySku.get(sku) ?? 0) + qty);
    }

    for (const [sku, qty] of qtyBySku) {
      let days = bySku.get(sku);
      if (!days) {
        days = new Map();
        bySku.set(sku, days);
      }
      const cell = days.get(day) ?? { weighted: 0, raw: 0, deals: 0 };
      cell.weighted += qty * prob;
      cell.raw += qty;
      cell.deals += 1;
      days.set(day, cell);
    }
  }
  return bySku;
}

/**
 * Per-SKU shipments, one entry per (sku, day), sorted by day ascending.
 * Overdue deals are clamped to day 0; deals shipping after horizonDays are
 * excluded; line items that do not resolve to a Shopify SKU are skipped.
 * @returns {Map<string, Array<{day:number, weightedQty:number, rawQty:number, openDealCount:number}>>}
 */
export function pipelineShipments(options) {
  const out = new Map();
  const bySku = accumulate(options ?? {});
  for (const [sku, days] of bySku) {
    const list = [...days.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, c]) => ({
        day,
        weightedQty: round2(c.weighted),
        rawQty: round2(c.raw),
        openDealCount: c.deals,
      }));
    out.set(sku, list);
  }
  return out;
}

/**
 * Per-SKU weekly demand, bucketed by the ISO Monday (UTC) on or before the
 * ship date. Uses the same clamping and horizon rules as pipelineShipments.
 * @returns {Map<string, Array<{weekStart:string, weightedQty:number, rawQty:number, openDealCount:number}>>}
 */
export function pipelineDemandByWeek(options) {
  const opts = options ?? {};
  const todayDay = parseDay(opts.today);
  const out = new Map();
  if (todayDay === null) return out;

  for (const [sku, days] of accumulate(opts)) {
    const weeks = new Map();
    for (const [day, c] of days) {
      const monday = isoMondayOf(todayDay + day);
      const w = weeks.get(monday) ?? { weighted: 0, raw: 0, deals: 0 };
      w.weighted += c.weighted;
      w.raw += c.raw;
      // A deal has exactly one ship day per SKU, so summing per-day counts
      // yields distinct deals per week.
      w.deals += c.deals;
      weeks.set(monday, w);
    }
    const list = [...weeks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([monday, w]) => ({
        weekStart: formatDay(monday),
        weightedQty: round2(w.weighted),
        rawQty: round2(w.raw),
        openDealCount: w.deals,
      }));
    out.set(sku, list);
  }
  return out;
}

/**
 * Convert stored weekly rows back into day-indexed shipments.
 *
 * Each week is placed at the START of its week (day = max(0, weekStart -
 * today)). That is deliberately conservative: it can only move a stockout
 * earlier. Weekly storage is coarser than deal-level shipments, so results
 * may differ slightly from the worked example built from raw deals.
 * Rows with an invalid weekStart are skipped.
 * @returns {Array<{day:number, weightedQty:number, rawQty:number, openDealCount:number}>}
 */
export function weeksToShipments(weeks, today) {
  const todayDay = parseDay(today);
  if (todayDay === null || !Array.isArray(weeks)) return [];

  const days = new Map();
  for (const w of weeks) {
    if (!w) continue;
    const startDay = parseDay(w.weekStart);
    if (startDay === null) continue;
    const day = Math.max(0, startDay - todayDay);
    const cell = days.get(day) ?? { weighted: 0, raw: 0, deals: 0 };
    const weighted = Number(w.weightedQty);
    const raw = Number(w.rawQty);
    const deals = Number(w.openDealCount);
    cell.weighted += Number.isFinite(weighted) ? weighted : 0;
    cell.raw += Number.isFinite(raw) ? raw : 0;
    cell.deals += Number.isFinite(deals) ? deals : 0;
    days.set(day, cell);
  }
  return [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, c]) => ({
      day,
      weightedQty: round2(c.weighted),
      rawQty: round2(c.raw),
      openDealCount: c.deals,
    }));
}
