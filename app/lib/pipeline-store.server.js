/**
 * Prisma-backed store for the pipeline sync (SPEC section 5).
 *
 * `createPrismaPipelineStore(prisma)` returns the `{ recordSyncSuccess,
 * recordSyncFailure }` pair that runPipelineSync calls. The Prisma client is
 * injected, so nothing here opens a connection.
 *
 * Success replaces the shop's snapshot and unmatched rows and clears the
 * error fields in ONE atomic batch transaction (array form only). The final
 * strict `update` makes a missing connection abort the whole batch.
 * Failure writes the error fields only and never touches snapshots,
 * unmatched rows or lastSyncAt, so the last good data stays.
 *
 * Only whitelisted aggregate fields are copied from input rows. Input is
 * validated before any Prisma call; StoreInputError carries a fixed message
 * and never echoes the data.
 */

const ISO_DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const WEEK_START_RE = /^\d{4}-\d{2}-\d{2}$/;

export class StoreInputError extends Error {
  constructor() {
    super("The pipeline store received invalid input.");
    this.name = "StoreInputError";
  }
}

// Rows per createMany. Postgres limits bound parameters per statement; a large shop
// (e.g. 1,000 SKUs x 13 weeks) would exceed it in one statement, so rows are chunked
// into several createMany operations inside the SAME atomic transaction.
const CREATE_CHUNK_SIZE = 2000;

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const finiteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const count = (v) => Number.isInteger(v) && v >= 0;

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function isIsoDateTime(v) {
  return (
    typeof v === "string" &&
    ISO_DATE_TIME_RE.test(v) &&
    !Number.isNaN(Date.parse(v))
  );
}

function isRealWeekStart(v) {
  if (typeof v !== "string" || !WEEK_START_RE.test(v)) return false;
  const date = new Date(`${v}T00:00:00.000Z`);
  // Round-trip: V8 rolls an impossible date such as 2026-02-30 over to 2026-03-02.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v;
}

function assertValid(ok) {
  if (!ok) throw new StoreInputError();
}

/**
 * @param {object} prisma - injected Prisma client
 * @returns {{ recordSyncSuccess: Function, recordSyncFailure: Function }}
 */
export function createPrismaPipelineStore(prisma) {
  return {
    /**
     * @param {{ shop: string, syncedAt: string, snapshots: object[], unmatched: object[] }} args
     */
    async recordSyncSuccess(args) {
      const { shop, syncedAt, snapshots, unmatched } = args ?? {};
      assertValid(nonEmptyString(shop));
      assertValid(isIsoDateTime(syncedAt));
      assertValid(Array.isArray(snapshots) && Array.isArray(unmatched));
      assertValid(
        snapshots.every(
          (r) =>
            r &&
            nonEmptyString(r.sku) &&
            isRealWeekStart(r.weekStart) &&
            finiteNumber(r.weightedQty) &&
            finiteNumber(r.rawQty) &&
            count(r.openDealCount),
        ),
      );
      assertValid(
        unmatched.every(
          (r) =>
            r &&
            typeof r.productCode === "string" &&
            finiteNumber(r.rawQty) &&
            count(r.openDealCount),
        ),
      );

      const syncedAtDate = new Date(syncedAt);
      const ops = [
        prisma.pipelineSnapshot.deleteMany({ where: { shop } }),
        prisma.unmatchedProduct.deleteMany({ where: { shop } }),
      ];
      const snapshotRows = snapshots.map((r) => ({
        shop,
        sku: r.sku,
        weekStart: new Date(`${r.weekStart}T00:00:00.000Z`),
        weightedQty: r.weightedQty,
        rawQty: r.rawQty,
        openDealCount: r.openDealCount,
        syncedAt: syncedAtDate,
      }));
      for (const data of chunk(snapshotRows, CREATE_CHUNK_SIZE)) {
        ops.push(prisma.pipelineSnapshot.createMany({ data }));
      }
      const unmatchedRows = unmatched.map((r) => ({
        shop,
        productCode: r.productCode,
        openDealCount: r.openDealCount,
        rawQty: r.rawQty,
        syncedAt: syncedAtDate,
      }));
      for (const data of chunk(unmatchedRows, CREATE_CHUNK_SIZE)) {
        ops.push(prisma.unmatchedProduct.createMany({ data }));
      }
      ops.push(
        prisma.salesforceConnection.update({
          where: { shop },
          data: {
            lastSyncAt: syncedAtDate,
            lastErrorClass: null,
            lastErrorMessage: null,
            lastErrorAt: null,
          },
        }),
      );
      await prisma.$transaction(ops);
    },

    /**
     * @param {{ shop: string, failedAt: string, errorClass: string, message: string }} args
     */
    async recordSyncFailure(args) {
      const { shop, failedAt, errorClass, message } = args ?? {};
      assertValid(nonEmptyString(shop));
      assertValid(isIsoDateTime(failedAt));
      assertValid(nonEmptyString(errorClass));
      assertValid(nonEmptyString(message));
      await prisma.salesforceConnection.updateMany({
        where: { shop },
        data: {
          lastErrorClass: errorClass,
          lastErrorMessage: message,
          lastErrorAt: new Date(failedAt),
        },
      });
    },
  };
}
