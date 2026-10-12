/**
 * Root document: html shell, Polaris provider and styles. App Bridge is
 * loaded only on /app pages (it throws outside the Shopify admin). The root
 * loader deliberately does NOT call authenticate.admin; auth belongs to
 * app.jsx and wrapping it here would swallow the redirect Responses it throws.
 */
import { json } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useLocation,
  useRouteError,
  isRouteErrorResponse,
} from "@remix-run/react";
import { AppProvider } from "@shopify/polaris";
import "@shopify/polaris/build/esm/styles.css";

export const loader = async () => {
  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" });
};

export default function App() {
  const { apiKey } = useLoaderData();
  const { pathname } = useLocation();
  const isAdminPage = pathname === "/app" || pathname.startsWith("/app/");

  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {isAdminPage && (
          <>
            <meta name="shopify-api-key" content={apiKey} />
            <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
          </>
        )}
        <title>Pipeline-Aware Forecast</title>
        <Meta />
        <Links />
      </head>
      <body>
        <AppProvider i18n={{}}>
          <Outlet />
        </AppProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  return (
    <html>
      <head>
        <title>Error</title>
        <Meta />
        <Links />
      </head>
      <body>
        <div style={{ padding: "1rem" }}>
          {isRouteErrorResponse(error) ? (
            <div>
              <h1>
                {error.status} {error.statusText}
              </h1>
              <p>{error.data?.message}</p>
            </div>
          ) : error instanceof Error ? (
            <div>
              <h1>Error</h1>
              <p>{error.message}</p>
            </div>
          ) : (
            <h1>Unknown Error</h1>
          )}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
