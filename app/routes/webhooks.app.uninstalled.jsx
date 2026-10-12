/**
 * app/uninstalled: deletes the uninstalled shop's tokens and Salesforce credentials.
 * Logs only topic and shop, never the payload.
 */
import { authenticate } from "../lib/shopify.server.js";
import prisma from "../lib/db.server.js";
import { deleteUninstallData } from "../lib/shop-data.server.js";
import { recordShopUninstalled } from "../lib/shop-registry.server.js";
import { dashboardCache, invalidateShop } from "../lib/shopify-cache.server.js";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhooks can arrive late or be retried. If the shop reinstalled AFTER this event was triggered,
  // deleting now would wipe the new session and credentials, so ignore the stale event.
  const triggeredAt = Date.parse(request.headers.get("X-Shopify-Triggered-At") ?? "");
  if (Number.isFinite(triggeredAt)) {
    const install = await prisma.shopInstall
      .findUnique({ where: { shop }, select: { installedAt: true, uninstalledAt: true } })
      .catch(() => null);
    if (install && !install.uninstalledAt && install.installedAt.getTime() > triggeredAt) {
      console.log(`Ignoring stale ${topic} webhook for ${shop} (reinstalled since).`);
      return new Response();
    }
  }

  invalidateShop(dashboardCache, shop);
  await deleteUninstallData(prisma, shop);
  await recordShopUninstalled({ prisma, shop, now: new Date() });

  return new Response();
};
