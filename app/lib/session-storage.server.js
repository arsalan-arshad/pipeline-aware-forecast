/**
 * Prisma session storage that encrypts Shopify's access and refresh tokens at rest.
 *
 * Shopify's own PrismaSessionStorage stores the tokens as plain text. They grant read access to
 * the shop's orders, so a database or backup leak would expose every merchant. This subclass
 * encrypts both tokens with the same AES-256-GCM helper (and ENCRYPTION_KEY) used for Salesforce
 * credentials, and decrypts them on load. Rows written before this existed (plain text) are still
 * readable and are encrypted the next time Shopify saves the session (e.g. on token refresh).
 *
 * Without a valid key, storing or loading a session throws: it never falls back to plain text.
 * A stored token that cannot be decrypted (the key was rotated, or the row is corrupted) is treated
 * as "no session": Shopify then simply re-authenticates the merchant with a fresh token exchange.
 */
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import {
  CredentialsCryptoError,
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from "./pipeline/credentials-crypto.server.js";

const ENCRYPTED_PREFIX = "v1:";
const KEY_MESSAGE = "A valid ENCRYPTION_KEY is required to store Shopify sessions.";

export class EncryptedPrismaSessionStorage extends PrismaSessionStorage {
  constructor(prisma, { encryptionKey, ...options } = {}) {
    super(prisma, options);
    this.encryptionKey = encryptionKey;
  }

  requireKey() {
    try {
      parseEncryptionKey(this.encryptionKey);
    } catch {
      throw new Error(KEY_MESSAGE);
    }
    return this.encryptionKey;
  }

  sessionToRow(session) {
    const row = super.sessionToRow(session);
    const key = this.requireKey();
    if (row.accessToken) row.accessToken = encryptSecret(row.accessToken, key);
    if (row.refreshToken) row.refreshToken = encryptSecret(row.refreshToken, key);
    return row;
  }

  rowToSession(row) {
    const decrypted = { ...row };
    const needsDecrypt = (value) => typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
    if (needsDecrypt(row.accessToken) || needsDecrypt(row.refreshToken)) {
      const key = this.requireKey();
      try {
        if (needsDecrypt(row.accessToken)) decrypted.accessToken = decryptSecret(row.accessToken, key);
        if (needsDecrypt(row.refreshToken)) decrypted.refreshToken = decryptSecret(row.refreshToken, key);
      } catch (err) {
        if (err instanceof CredentialsCryptoError) return null; // unreadable row = no session
        throw err;
      }
    }
    return super.rowToSession(decrypted);
  }

  async loadSession(id) {
    return (await super.loadSession(id)) ?? undefined;
  }

  async findSessionsByShop(shop) {
    return (await super.findSessionsByShop(shop)).filter(Boolean);
  }
}
