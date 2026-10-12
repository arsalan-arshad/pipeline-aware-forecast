/**
 * Pipeline sync orchestrator.
 *
 * Pulls open deals from Salesforce (through an injected client), turns them
 * into weekly per-SKU snapshot rows and hands the complete new set to an
 * injected store. On any failure the store is told about the error only, so
 * the shop's last good snapshot is never touched.
 *
 * Nothing here reads the clock, the environment or the network: the caller
 * passes `today` and `now`, and supplies the client, store and SKU source.
 * Output is aggregate only: per-SKU, per-week quantities and deal counts.
 * Error messages are fixed strings or the client's own sanitised
 * `userMessage`; raw error text and stacks are never returned or stored.
 *
 * runPipelineSync never rejects. See docs/M1_CONTRACT.md for engine shapes.
 */

import { pipelineDemandByWeek } from "./pipeline-demand.js";
import { buildSkuIndex, summarizeUnmatched } from "./sku-matching.js";

const MS_PER_DAY = 86400000;
const MS_PER_HOUR = 3600000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const GENERIC_MESSAGE = "The sync failed for an unexpected reason.";
const STORAGE_MESSAGE = "The sync data could not be saved.";

/** Day number (UTC) for a real 'YYYY-MM-DD' date, else null. */
function parseDay(value) {
  if (typeof value !== "string") return null;
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt.getTime() / MS_PER_DAY;
}

/**
 * Add calendar days to a 'YYYY-MM-DD' date (UTC arithmetic).
 * @param {string} isoDate
 * @param {number} days - may be negative; fractions are truncated
 * @returns {string|null} 'YYYY-MM-DD', or null for an invalid date or days
 */
export function addDaysIso(isoDate, days) {
  const day = parseDay(isoDate);
  if (day === null) return null;
  if (typeof days !== "number" || !Number.isFinite(days)) return null;
  const out = new Date(0);
  out.setTime((day + Math.trunc(days)) * MS_PER_DAY);
  if (Number.isNaN(out.getTime())) return null;
  const y = out.getUTCFullYear();
  const yyyy = String(Math.abs(y)).padStart(4, "0");
  const mm = String(out.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(out.getUTCDate()).padStart(2, "0");
  return `${y < 0 ? "-" : ""}${yyyy}-${mm}-${dd}`;
}

/** Milliseconds for Date | ISO string | epoch ms, else null. */
function toMs(value) {
  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "number") ms = value;
  else if (typeof value === "string" && value.trim() !== "") {
    ms = Date.parse(value);
  } else return null;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is a sync due? Never reads the clock; `now` is passed in.
 * True when lastSyncAt is missing/unparseable, `now` is invalid, or at least
 * intervalHours have passed. A lastSyncAt in the future (clock skew) is false.
 * @param {{ lastSyncAt?: Date|string|number|null, now: Date|string|number, intervalHours?: number }} args
 * @returns {boolean}
 */
export function isSyncDue({ lastSyncAt, now, intervalHours = 6 } = {}) {
  const last = toMs(lastSyncAt);
  if (last === null) return true;
  const nowMs = toMs(now);
  if (nowMs === null) return true;
  const hours =
    typeof intervalHours === "number" && Number.isFinite(intervalHours)
      ? intervalHours
      : 6;
  const elapsed = nowMs - last;
  if (elapsed < 0) return false;
  return elapsed >= hours * MS_PER_HOUR;
}

const finiteOr = (value, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

/** Returns an error message for bad input, or null when valid. */
function validate({ shop, client, store, getShopifySkus, today, now }) {
  if (!nonEmptyString(shop)) return "shop must be a non-empty string.";
  if (parseDay(today) === null) return "today must be a real YYYY-MM-DD date.";
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return "now must be a valid Date.";
  }
  if (!client || typeof client.fetchOpenOpportunities !== "function") {
    return "client.fetchOpenOpportunities must be a function.";
  }
  if (
    !store ||
    typeof store.recordSyncSuccess !== "function" ||
    typeof store.recordSyncFailure !== "function"
  ) {
    return "store must provide recordSyncSuccess and recordSyncFailure.";
  }
  if (typeof getShopifySkus !== "function") {
    return "getShopifySkus must be a function.";
  }
  return null;
}

/** Best-effort failure record; never throws. */
async function recordFailure(store, { shop, failedAt, errorClass, message }) {
  try {
    await store.recordSyncFailure({ shop, failedAt, errorClass, message });
  } catch {
    // Swallowed on purpose: the sync result is already a failure.
  }
}

/** Flatten the per-SKU week map into sorted snapshot rows (exact keys only). */
function toSnapshots(weeksBySku) {
  const rows = [];
  for (const [sku, weeks] of weeksBySku) {
    for (const w of weeks) {
      rows.push({
        sku,
        weekStart: w.weekStart,
        weightedQty: w.weightedQty,
        rawQty: w.rawQty,
        openDealCount: w.openDealCount,
      });
    }
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => cmp(a.sku, b.sku) || cmp(a.weekStart, b.weekStart));
  return rows;
}

/**
 * Run one pipeline sync for a shop. Never rejects.
 * @param {object} args
 * @param {string} args.shop
 * @param {{ fetchOpenOpportunities: (o: { horizonDate: string }) => Promise<object[]> }} args.client
 * @param {{ recordSyncSuccess: Function, recordSyncFailure: Function }} args.store
 * @param {() => Promise<string[]>} args.getShopifySkus
 * @param {{ haircut?: number, shipOffsetDays?: number, horizonDays?: number, stageOverrides?: object }} [args.settings]
 * @param {string} args.today - 'YYYY-MM-DD'
 * @param {Date} args.now
 * @returns {Promise<{ ok: true, syncedAt: string, skuCount: number, rowCount: number, unmatchedCount: number } | { ok: false, errorClass: string, message: string }>}
 */
export async function runPipelineSync(args) {
  const input = args && typeof args === "object" ? args : {};
  try {
    const invalid = validate(input);
    if (invalid) return { ok: false, errorClass: "config", message: invalid };

    const { shop, client, store, getShopifySkus, today, now } = input;
    const settings =
      input.settings && typeof input.settings === "object" ? input.settings : {};
    const haircut = finiteOr(settings.haircut, 1);
    const shipOffsetDays = finiteOr(settings.shipOffsetDays, 7);
    const horizonDays = finiteOr(settings.horizonDays, 90);
    const stageOverrides =
      settings.stageOverrides && typeof settings.stageOverrides === "object"
        ? settings.stageOverrides
        : {};

    const horizonDate = addDaysIso(today, horizonDays);
    if (horizonDate === null) {
      return {
        ok: false,
        errorClass: "config",
        message: "The sync horizon could not be computed.",
      };
    }

    let opportunities;
    let skuIndex;
    try {
      const skus = await getShopifySkus();
      skuIndex = buildSkuIndex(skus);
      opportunities = await client.fetchOpenOpportunities({ horizonDate });
    } catch (err) {
      const errorClass = nonEmptyString(err?.errorClass)
        ? err.errorClass
        : "unexpected_response";
      const message = nonEmptyString(err?.userMessage)
        ? err.userMessage
        : GENERIC_MESSAGE;
      await recordFailure(store, {
        shop,
        failedAt: now.toISOString(),
        errorClass,
        message,
      });
      return { ok: false, errorClass, message };
    }

    const weeks = pipelineDemandByWeek({
      opportunities,
      stageOverrides,
      haircut,
      shipOffsetDays,
      today,
      horizonDays,
      skuIndex,
    });
    const unmatched = summarizeUnmatched(opportunities, skuIndex);
    const snapshots = toSnapshots(weeks);
    const syncedAt = now.toISOString();

    try {
      await store.recordSyncSuccess({ shop, syncedAt, snapshots, unmatched });
    } catch {
      await recordFailure(store, {
        shop,
        failedAt: syncedAt,
        errorClass: "storage",
        message: STORAGE_MESSAGE,
      });
      return { ok: false, errorClass: "storage", message: STORAGE_MESSAGE };
    }

    return {
      ok: true,
      syncedAt,
      skuCount: new Set(snapshots.map((r) => r.sku)).size,
      rowCount: snapshots.length,
      unmatchedCount: unmatched.length,
    };
  } catch {
    // Last-resort guard (e.g. malformed opportunities): the contract is no rejection.
    // The failure is still recorded, so the UI shows an error and the age of the last good data.
    if (validate(input) === null) {
      await recordFailure(input.store, {
        shop: input.shop,
        failedAt: input.now.toISOString(),
        errorClass: "unexpected_response",
        message: GENERIC_MESSAGE,
      });
    }
    return { ok: false, errorClass: "unexpected_response", message: GENERIC_MESSAGE };
  }
}
