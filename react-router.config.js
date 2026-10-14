/**
 * Framework-mode config: server-side rendering, routes live in app/routes (see app/routes.js).
 *
 * allowedActionOrigins: React Router rejects form posts whose Origin header does not match the request
 * URL (CSRF protection). Behind a TLS-terminating proxy such as Railway, react-router-serve sees the
 * request as plain http while the browser sends an https Origin, so the app's own posts would be
 * rejected with "Bad Request". The app's own host is therefore allowed explicitly. Any other origin is
 * still rejected. The host comes from the same variables the rest of the app uses; this file runs at
 * build time, so SHOPIFY_APP_URL must be set during the build (it is a normal Railway service variable).
 */
const appUrl = process.env.SHOPIFY_APP_URL || process.env.APP_URL;

export const appHost = (() => {
  try {
    return appUrl ? new URL(appUrl).host : null;
  } catch {
    return null;
  }
})();

if (!appHost && process.env.NODE_ENV === "production") {
  console.warn(
    "[react-router.config] SHOPIFY_APP_URL is not set at build time: form posts from the deployed app will be rejected by the CSRF check.",
  );
}

export default {
  ssr: true,
  allowedActionOrigins: appHost ? [appHost] : [],
};
