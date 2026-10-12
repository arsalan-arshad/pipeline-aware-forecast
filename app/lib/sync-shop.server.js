/**
 * Runs one pipeline sync for a shop.
 *
 * Glue only: loads the shop's stored Salesforce connection and settings,
 * builds the Salesforce client and the Prisma store, and hands everything to
 * runPipelineSync. Prisma, the Shopify admin client and fetch are injected, and
 * `today` / `now` come from the caller, so nothing here reads the clock, the
 * environment or the network. syncShop never rejects.
 */

import { clientFromConnectionRow } from "./connection.server.js";
import { addDaysIso, runPipelineSync } from "./pipeline/pipeline-sync.server.js";
import { createPrismaPipelineStore } from "./pipeline-store.server.js";
import { acquireSyncLock, releaseSyncLock } from "./sync-lock.server.js";
import { fetchVariantSkus, ShopifyDataError } from "./shopify-data.server.js";

// A crashed sync blocks its shop for at most this long; long enough for a very large sync.
const SYNC_LOCK_TTL_MS = 30 * 60 * 1000;

const DEFAULT_SETTINGS = { haircut: 1, shipOffsetDays: 7, horizonDays: 90 };
const STORAGE_MESSAGE = "The sync data could not be read or saved.";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const configError = (message) => ({ ok: false, errorClass: "config", message });

/**
 * @param {object} args
 * @param {object} args.prisma - injected Prisma client
 * @param {string} args.shop
 * @param {{ graphql: Function }} args.admin - Shopify Admin API client
 * @param {string} args.encryptionKey - 64 hex characters
 * @param {string} args.today - 'YYYY-MM-DD'
 * @param {Date} args.now
 * @param {Function} [args.fetchImpl]
 * @returns {Promise<{ ok: true, syncedAt: string, skuCount: number, rowCount: number, unmatchedCount: number } | { ok: false, errorClass: string, message: string }>}
 */
export async function syncShop(args) {
  // Set once inputs are valid, so an unexpected crash can still be recorded.
  let fallback = null;
  let lockedShop = null;
  let lockedUntil = null;
  let lockPrisma = null;
  try {
    const { prisma, shop, admin, encryptionKey, today, now, fetchImpl, minIntervalMs, sleep } =
      args && typeof args === "object" ? args : {};

    if (!nonEmptyString(shop)) return configError("shop must be a non-empty string.");
    if (!admin || typeof admin.graphql !== "function") {
      return configError("admin must provide a graphql function.");
    }
    if (typeof today !== "string" || !DATE_RE.test(today) || addDaysIso(today, 0) === null) {
      return configError("today must be a real YYYY-MM-DD date.");
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return configError("now must be a valid Date.");
    }

    let locked;
    try {
      locked = await acquireSyncLock({ prisma, shop, now, ttlMs: SYNC_LOCK_TTL_MS });
    } catch {
      return { ok: false, errorClass: "storage", message: STORAGE_MESSAGE };
    }
    if (!locked) {
      return {
        ok: false,
        errorClass: "busy",
        message: "A sync is already running for this shop. Try again in a minute.",
      };
    }
    lockedShop = shop;
    lockedUntil = new Date(now.getTime() + SYNC_LOCK_TTL_MS);
    lockPrisma = prisma;

    const store = createPrismaPipelineStore(prisma);
    fallback = { store, shop, now };

    let row;
    let setting;
    let overrides;
    try {
      row = await prisma.salesforceConnection.findUnique({ where: { shop } });
      if (!row) {
        return {
          ok: false,
          errorClass: "not_connected",
          message: "Salesforce is not connected yet.",
        };
      }
      // Manual refreshes pass minIntervalMs: do not hammer Salesforce (and the merchant's own login) with repeats.
      if (Number.isFinite(minIntervalMs) && minIntervalMs > 0) {
        const lastAttempt = Math.max(
          row.lastSyncAt ? new Date(row.lastSyncAt).getTime() : 0,
          row.lastErrorAt ? new Date(row.lastErrorAt).getTime() : 0,
        );
        if (lastAttempt > 0 && now.getTime() - lastAttempt < minIntervalMs) {
          return {
            ok: false,
            errorClass: "too_soon",
            message: "A sync just ran. Please wait a minute and try again.",
          };
        }
      }
      setting = await prisma.pipelineSetting.findUnique({ where: { shop } });
      overrides = await prisma.stageProbabilityOverride.findMany({ where: { shop } });
    } catch {
      return { ok: false, errorClass: "storage", message: STORAGE_MESSAGE };
    }

    const built = clientFromConnectionRow(row, encryptionKey, fetchImpl);
    if (built.failure) {
      try {
        await store.recordSyncFailure({
          shop,
          failedAt: now.toISOString(),
          errorClass: built.failure.errorClass,
          message: built.failure.message,
        });
      } catch {
        // Swallowed on purpose: the sync result is already a failure.
      }
      return { ok: false, ...built.failure };
    }

    const stageOverrides = Object.create(null); // a stage named "__proto__" must stay ordinary data
    for (const o of overrides ?? []) stageOverrides[o.stageName] = o.probability;
    const settings = {
      haircut: setting?.haircut ?? DEFAULT_SETTINGS.haircut,
      shipOffsetDays: setting?.shipOffsetDays ?? DEFAULT_SETTINGS.shipOffsetDays,
      horizonDays: setting?.horizonDays ?? DEFAULT_SETTINGS.horizonDays,
      stageOverrides,
    };

    const getShopifySkus = async () => {
      try {
        return await fetchVariantSkus(admin, typeof sleep === "function" ? { sleep } : undefined);
      } catch (err) {
        if (err instanceof ShopifyDataError) {
          throw { errorClass: "shopify", userMessage: err.userMessage };
        }
        throw err;
      }
    };

    return await runPipelineSync({
      shop,
      client: built.client,
      store,
      getShopifySkus,
      settings,
      today,
      now,
    });
  } catch {
    const message = "The sync failed for an unexpected reason.";
    if (fallback) {
      try {
        await fallback.store.recordSyncFailure({
          shop: fallback.shop,
          failedAt: fallback.now.toISOString(),
          errorClass: "unexpected_response",
          message,
        });
      } catch {
        // Swallowed on purpose: the sync result is already a failure.
      }
    }
    return { ok: false, errorClass: "unexpected_response", message };
  } finally {
    if (lockedShop !== null) await releaseSyncLock({ prisma: lockPrisma, shop: lockedShop, lockedUntil });
  }
}
