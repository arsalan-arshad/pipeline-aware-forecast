/**
 * shop/redact (48h after uninstall): deletes all data held for the shop.
 * Logs only topic and shop, never the payload.
 */
import { authenticate } from "../lib/shopify.server.js";
import prisma from "../lib/db.server.js";
import { deleteShopData } from "../lib/shop-data.server.js";
import { dashboardCache, invalidateShop } from "../lib/shopify-cache.server.js";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  invalidateShop(dashboardCache, shop);
  await deleteShopData(prisma, shop);

  return new Response();
};
