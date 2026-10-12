/**
 * Shop data deletion for app/uninstalled and shop/redact.
 *
 * `deleteShopData` removes every row keyed by `shop` (all models in
 * prisma/schema.prisma that have a `shop` field) in one atomic batch.
 * `deleteUninstallData` removes only the stored sessions and the encrypted
 * Salesforce credentials; aggregate snapshots and settings remain until
 * shop/redact so a reinstall restores them.
 *
 * The Prisma client is injected and only the array form of $transaction is
 * used. Errors are not caught: the webhook handler needs failures to surface
 * so Shopify retries. Both functions resolve to undefined.
 */

export class ShopDataError extends Error {
  constructor() {
    super("A non-empty shop is required to delete shop data.");
    this.name = "ShopDataError";
  }
}

function assertShop(shop) {
  if (typeof shop !== "string" || shop.trim() === "") throw new ShopDataError();
}

/** Delete every row for the shop, across all shop-keyed models. */
export async function deleteShopData(prisma, shop) {
  assertShop(shop);
  const where = { shop };
  await prisma.$transaction([
    prisma.salesforceConnection.deleteMany({ where }),
    prisma.pipelineSnapshot.deleteMany({ where }),
    prisma.unmatchedProduct.deleteMany({ where }),
    prisma.stageProbabilityOverride.deleteMany({ where }),
    prisma.pipelineSetting.deleteMany({ where }),
    prisma.shopInstall.deleteMany({ where }),
    prisma.feedback.deleteMany({ where }),
    prisma.syncLock.deleteMany({ where }),
    prisma.session.deleteMany({ where }),
  ]);
}

/** On uninstall: drop sessions and stored Salesforce credentials only. */
export async function deleteUninstallData(prisma, shop) {
  assertShop(shop);
  const where = { shop };
  await prisma.$transaction([
    prisma.session.deleteMany({ where }),
    prisma.salesforceConnection.deleteMany({ where }),
    prisma.syncLock.deleteMany({ where }),
  ]);
}
