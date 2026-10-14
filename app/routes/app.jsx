/**
 * Authenticated layout for all /app/* routes. The ui-nav-menu element is
 * defined by the App Bridge script loaded in root.jsx. The ErrorBoundary and
 * headers exports let Shopify's boundary helpers forward the headers App Bridge
 * needs to retry a request whose session token expired.
 */
import { Outlet, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
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

// Shopify's boundary helpers must handle errors and headers for routes that authenticate.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
