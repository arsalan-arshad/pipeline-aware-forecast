/**
 * Per-shop sync lock, so two syncs never run for the same shop at once.
 *
 * One SyncLock row per shop. A live lock (lockedUntil in the future) blocks
 * other callers; an expired lock can be taken over, so a crashed sync never
 * blocks a shop for longer than the TTL. Prisma is injected.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * @param {object} args
 * @param {object} args.prisma - injected Prisma client
 * @param {string} args.shop
 * @param {Date} args.now
 * @param {number} [args.ttlMs]
 * @returns {Promise<boolean>} true when the lock was taken
 */
export async function acquireSyncLock({ prisma, shop, now, ttlMs = DEFAULT_TTL_MS }) {
  const lockedUntil = new Date(now.getTime() + ttlMs);
  try {
    await prisma.syncLock.create({ data: { shop, lockedUntil } });
    return true;
  } catch (err) {
    if (err?.code !== "P2002") throw err;
  }
  const result = await prisma.syncLock.updateMany({
    where: { shop, lockedUntil: { lte: now } },
    data: { lockedUntil },
  });
  return result.count === 1;
}

/**
 * Releases the shop's lock. Never throws.
 *
 * @param {object} args
 * @param {object} args.prisma
 * @param {string} args.shop
 * @param {Date} [args.lockedUntil] - the value this run set; when given, only that exact lock is removed
 * @returns {Promise<undefined>}
 */
export async function releaseSyncLock({ prisma, shop, lockedUntil }) {
  // With lockedUntil the delete is conditional: only the lock this run took is removed, never a newer
  // lock another run took over after this one's lock expired.
  const where = lockedUntil instanceof Date ? { shop, lockedUntil } : { shop };
  try {
    await prisma.syncLock.deleteMany({ where });
  } catch {
    // Swallowed on purpose: the lock expires on its own.
  }
}
