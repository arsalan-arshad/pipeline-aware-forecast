/**
 * Runs the scheduled sync for every shop whose last sync is due.
 *
 * Reads only shop, lastSyncAt and lastErrorAt (never credential columns),
 * picks the due shops, and syncs them one after another. Prisma, the admin
 * client factory and fetch are injected. runDueSyncs never rejects.
 */

import { isSyncDue } from "./pipeline/pipeline-sync.server.js";
import { syncShop } from "./sync-shop.server.js";

const MS_PER_HOUR = 3600 * 1000;

const toMs = (v) => {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/**
 * @param {object} args
 * @param {object} args.prisma
 * @param {Date} args.now
 * @param {string} args.today - 'YYYY-MM-DD'
 * @param {(shop: string) => Promise<{ graphql: Function }>} args.getAdmin
 * @param {string} args.encryptionKey
 * @param {number} [args.intervalHours]
 * @param {number} [args.failureBackoffHours]
 * @param {number} [args.maxShops]
 * @param {number} [args.maxDurationMs] - stop starting new shops after this much wall time (default 4 minutes)
 * @param {() => number} [args.clock] - injectable millisecond clock
 * @param {Function} [args.sleep] - injectable delay for Shopify throttling retries
 * @param {Function} [args.fetchImpl]
 * @returns {Promise<{ checked: number, due: number, synced: number, failed: number, busy: number, results: Array<{ shop: string, ok: boolean, errorClass?: string }>, error?: string }>}
 */
export async function runDueSyncs(args) {
  const summary = { checked: 0, due: 0, synced: 0, failed: 0, busy: 0, results: [] };
  try {
    const {
      prisma,
      now,
      today,
      getAdmin,
      encryptionKey,
      intervalHours = 6,
      failureBackoffHours = 1,
      maxShops = 50,
      maxDurationMs = 240000,
      clock = () => Date.now(),
      fetchImpl,
      sleep,
    } = args;
    const startedAt = clock();

    let rows;
    try {
      rows = await prisma.salesforceConnection.findMany({
        select: { shop: true, lastSyncAt: true, lastErrorAt: true },
      });
    } catch {
      return { ...summary, error: "storage" };
    }
    summary.checked = rows.length;

    const nowMs = now.getTime();
    const dueRows = rows.filter((r) => {
      if (!isSyncDue({ lastSyncAt: r.lastSyncAt, now, intervalHours })) return false;
      const errMs = toMs(r.lastErrorAt);
      return errMs === null || nowMs - errMs >= failureBackoffHours * MS_PER_HOUR;
    });
    summary.due = dueRows.length;

    // Oldest LAST ATTEMPT first (success or failure), never-tried first, so a shop that keeps failing
    // cannot sit at the front forever and starve healthy shops.
    const lastAttempt = (r) => Math.max(toMs(r.lastSyncAt) ?? -Infinity, toMs(r.lastErrorAt) ?? -Infinity);
    dueRows.sort((a, b) => lastAttempt(a) - lastAttempt(b));
    const batch = dueRows.slice(0, Math.max(0, maxShops));

    for (let i = 0; i < batch.length; i++) {
      // One cron request must not run for hours: stop starting new shops after maxDurationMs.
      if (clock() - startedAt >= maxDurationMs) {
        summary.deferred = batch.length - i;
        break;
      }
      const { shop } = batch[i];
      let admin;
      try {
        admin = await getAdmin(shop);
      } catch {
        summary.failed++;
        summary.results.push({ shop, ok: false, errorClass: "shopify_auth" });
        // Record it so the failure backoff applies and the merchant sees why data is stale.
        try {
          await prisma.salesforceConnection.updateMany({
            where: { shop },
            data: {
              lastErrorClass: "shopify_auth",
              lastErrorMessage: "Shopify access for this shop is no longer valid. Open the app to reconnect.",
              lastErrorAt: now,
            },
          });
        } catch {
          // Best effort.
        }
        continue;
      }
      const res = await syncShop({ prisma, shop, admin, encryptionKey, today, now, fetchImpl, sleep });
      if (res.ok) summary.synced++;
      else if (res.errorClass === "busy") summary.busy++;
      else summary.failed++;
      summary.results.push({ shop, ok: res.ok, errorClass: res.ok ? undefined : res.errorClass });
    }
    return summary;
  } catch {
    return { ...summary, error: "unexpected" };
  }
}
