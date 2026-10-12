/**
 * Merchant feedback: validates and stores a free-text message with an optional
 * 1-5 rating, and limits each shop to 5 messages per hour. Validation failures
 * make no database call. A failing database call propagates to the caller.
 */
import { SUPPORT_EMAIL } from "./support.js";

const HOUR_MS = 3600000;
const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 20;
const MAX_LENGTH = 2000;

const fail = (errorClass, message) => ({ ok: false, errorClass, message });

export async function saveFeedback({ prisma, shop, message, rating, now }) {
  if (typeof shop !== "string" || shop.trim().length === 0) {
    return fail("config", "A shop is required.");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return fail("config", "A valid time is required.");
  }
  const text = typeof message === "string" ? message.trim() : "";
  if (text.length < 1 || text.length > MAX_LENGTH) {
    return fail("config", "Please write a message of up to 2,000 characters.");
  }
  let score = null;
  if (rating !== undefined && rating !== null && rating !== "") {
    score = Number(rating);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return fail("config", "Rating must be a whole number from 1 to 5.");
    }
  }

  const recent = await prisma.feedback.count({
    where: { shop, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
  });
  if (recent >= MAX_PER_HOUR) {
    return fail(
      "rate_limited",
      "You have sent several messages recently. Please try again later or email " +
        SUPPORT_EMAIL +
        ".",
    );
  }

  // A second, daily cap: the hourly limit alone still allows a few hundred KB a day per shop.
  const today = await prisma.feedback.count({
    where: { shop, createdAt: { gte: new Date(now.getTime() - 24 * HOUR_MS) } },
  });
  if (today >= MAX_PER_DAY) {
    return fail(
      "rate_limited",
      "You have sent several messages recently. Please try again later or email " +
        SUPPORT_EMAIL +
        ".",
    );
  }

  await prisma.feedback.create({
    data: { shop, rating: score, message: text, createdAt: now },
  });
  return { ok: true };
}
