/**
 * Scheduled sync endpoint. A cron job POSTs here with
 * `Authorization: Bearer <CRON_SECRET>`; every due shop is synced.
 * The response carries counts only.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "@remix-run/node";
import prisma from "../lib/db.server.js";
import { runDueSyncs } from "../lib/run-due-syncs.server.js";
import { unauthenticated } from "../lib/shopify.server.js";

const notAllowed = () => json({ ok: false, message: "Method not allowed." }, { status: 405 });

const sha256 = (value) => createHash("sha256").update(value).digest();

// Hash both sides so the comparison is constant-time AND the secret's length is not revealed.
function secretMatches(header, secret) {
  const given = sha256(typeof header === "string" ? header : "");
  const expected = sha256(`Bearer ${secret}`);
  return timingSafeEqual(given, expected);
}

export const loader = () => notAllowed();

export const action = async ({ request }) => {
  if (request.method !== "POST") return notAllowed();

  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
    return json({ ok: false, message: "Scheduler not configured." }, { status: 503 });
  }
  if (!secretMatches(request.headers.get("Authorization"), secret)) {
    return json({ ok: false, message: "Unauthorized." }, { status: 401 });
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const { checked, due, synced, failed, busy } = await runDueSyncs({
    prisma,
    now,
    today,
    getAdmin: async (shop) => (await unauthenticated.admin(shop)).admin,
    encryptionKey: process.env.ENCRYPTION_KEY,
  });
  return json({ ok: true, checked, due, synced, failed, busy });
};
