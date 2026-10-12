import crypto from "node:crypto";

/**
 * AES-256-GCM helpers for encrypting a merchant's Salesforce credentials at rest.
 * Only the encrypted payload is ever stored; the plaintext secret never is.
 *
 * Payload format: `v1:<iv>:<tag>:<ciphertext>`, each part base64url without padding.
 * IV is a fresh random 12 bytes per call; the auth tag is 16 bytes.
 *
 * The key is passed in by the caller as 64 hex characters (32 bytes), e.g. the
 * ENCRYPTION_KEY env var. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * Rotating or losing the key makes stored credentials undecryptable.
 *
 * Error messages are fixed strings and never include the key, plaintext or payload.
 */

const ALGO = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX = /^[0-9a-fA-F]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class CredentialsCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialsCryptoError";
    this.code = code;
  }
}

/** Parses a 64-character hex string into a 32-byte key Buffer. */
export function parseEncryptionKey(keyHex) {
  if (typeof keyHex !== "string" || !KEY_HEX.test(keyHex)) {
    throw new CredentialsCryptoError(
      "bad_key",
      "ENCRYPTION_KEY must be 64 hex characters (32 bytes).",
    );
  }
  return Buffer.from(keyHex, "hex");
}

/** Encrypts a non-empty string, returning `v1:<iv>:<tag>:<ciphertext>`. */
export function encryptSecret(plaintext, keyHex) {
  const key = parseEncryptionKey(keyHex);
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new CredentialsCryptoError("bad_input", "Secret to encrypt must be a non-empty string.");
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function badPayload() {
  return new CredentialsCryptoError("bad_payload", "Stored credential has an unrecognised format.");
}

/** Decrypts a payload produced by encryptSecret(). Throws rather than returning partial plaintext. */
export function decryptSecret(payload, keyHex) {
  const key = parseEncryptionKey(keyHex);
  if (typeof payload !== "string") throw badPayload();
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw badPayload();
  const [, ivPart, tagPart, ctPart] = parts;
  if (![ivPart, tagPart, ctPart].every((p) => BASE64URL.test(p))) throw badPayload();
  // encryptSecret never produces an empty ciphertext (it rejects empty input).
  if (ctPart.length === 0) throw badPayload();
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ctPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw badPayload();

  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialsCryptoError(
      "decrypt_failed",
      "Could not decrypt the stored credential (wrong key or corrupted data).",
    );
  }
}
