/** Catch-all for /auth/*: authenticate.admin starts OAuth or handles the callback. */
import { authenticate } from "../lib/shopify.server.js";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};
