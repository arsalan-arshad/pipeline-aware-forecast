/**
 * customers/redact: this app stores no customer data (only per-SKU
 * aggregates), so there is nothing to delete. Logs topic and shop, returns 200.
 */
import { authenticate } from "../lib/shopify.server.js";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
