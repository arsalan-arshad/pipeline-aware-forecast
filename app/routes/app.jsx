/**
 * Authenticated layout for all /app/* routes. The ui-nav-menu element is
 * defined by the App Bridge script loaded in root.jsx.
 */
import { Outlet } from "react-router";
import { authenticate } from "../lib/shopify.server.js";
import prisma from "../lib/db.server.js";
import { recordShopSeen } from "../lib/shop-registry.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await recordShopSeen({ prisma, shop: session.shop, now: new Date() });
  return { shop: session.shop };
};

export default function AppLayout() {
  return (
    <>
      <ui-nav-menu>
        <a href="/app" rel="home">
          Dashboard
        </a>
        <a href="/app/settings">Settings</a>
        <a href="/app/feedback">Feedback</a>
      </ui-nav-menu>
      <Outlet />
    </>
  );
}
