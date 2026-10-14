/**
 * Health check for the host. Public: returns only { ok }. Whether the database answers and which
 * required environment variables are missing is logged on the server (names only, never values).
 */

import prisma from "../lib/db.server.js";

const REQUIRED = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SCOPES",
  "DATABASE_URL",
  "CRON_SECRET",
];

export const loader = async () => {
  const env = process.env;
  const missing = REQUIRED.filter((name) => !env[name]);
  if (!env.SHOPIFY_APP_URL && !env.APP_URL) missing.push("SHOPIFY_APP_URL");
  if (!/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY ?? "")) missing.push("ENCRYPTION_KEY");

  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }

  const ok = db && missing.length === 0;
  // Public endpoint: say only whether we are healthy. The names of missing settings go to the
  // server log (names, never values), not to anyone who can reach this URL.
  if (!ok) console.warn("Health check failing:", { db, missing });
  return Response.json({ ok }, { status: ok ? 200 : 503 });
};
