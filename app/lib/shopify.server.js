/**
 * Shopify app configuration: OAuth/token exchange, session storage, webhook
 * authentication. Expiring offline tokens are refreshed transparently by
 * authenticate.admin / authenticate.webhook / unauthenticated.admin using the
 * refresh token columns on the Session model.
 */
import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { EncryptedPrismaSessionStorage } from "./session-storage.server.js";
import prisma from "./db.server.js";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  // `shopify app dev` injects the tunnel URL as APP_URL, not SHOPIFY_APP_URL.
  appUrl: process.env.SHOPIFY_APP_URL || process.env.APP_URL,
  authPathPrefix: "/auth",
  // Tokens are encrypted at rest with ENCRYPTION_KEY (see session-storage.server.js).
  sessionStorage: new EncryptedPrismaSessionStorage(prisma, {
    encryptionKey: process.env.ENCRYPTION_KEY,
  }),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
});

export default shopify;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
