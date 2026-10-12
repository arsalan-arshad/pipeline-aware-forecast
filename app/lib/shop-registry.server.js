/**
 * Install record: which shops have the app installed. Stores only the shop
 * domain and timestamps. Both functions are best effort and never throw, so a
 * registry problem can never break page loads or the uninstall webhook.
 */

const validShop = (shop) => typeof shop === "string" && shop.trim().length > 0;
const validNow = (now) => now instanceof Date && !Number.isNaN(now.getTime());

/**
 * Records that a shop opened the app. Creates the row on first sight, treats a
 * row marked uninstalled as a reinstall, and otherwise refreshes lastSeenAt at
 * most once per minIntervalMs.
 */
export async function recordShopSeen(args) {
  try {
    const { prisma, shop, now, minIntervalMs = 3600000 } = args ?? {};
    if (!validShop(shop) || !validNow(now)) return;
    const row = await prisma.shopInstall.findUnique({ where: { shop } });
    if (!row) {
      await prisma.shopInstall.create({
        data: { shop, installedAt: now, lastSeenAt: now },
      });
    } else if (row.uninstalledAt) {
      await prisma.shopInstall.update({
        where: { shop },
        data: { installedAt: now, uninstalledAt: null, lastSeenAt: now },
      });
    } else if (
      !row.lastSeenAt ||
      now.getTime() - new Date(row.lastSeenAt).getTime() >= minIntervalMs
    ) {
      await prisma.shopInstall.update({
        where: { shop },
        data: { lastSeenAt: now },
      });
    }
  } catch {
    // Best effort: the registry must never break the app.
  }
}

/** Records that a shop uninstalled the app. */
export async function recordShopUninstalled(args) {
  try {
    const { prisma, shop, now } = args ?? {};
    if (!validShop(shop) || !validNow(now)) return;
    await prisma.shopInstall.upsert({
      where: { shop },
      create: { shop, installedAt: now, uninstalledAt: now },
      update: { uninstalledAt: now },
    });
  } catch {
    // Best effort: the uninstall webhook must still succeed.
  }
}
