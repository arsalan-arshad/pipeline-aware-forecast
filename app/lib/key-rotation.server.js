import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from "./pipeline/credentials-crypto.server.js";

/**
 * Re-encrypts every stored Salesforce credential from one ENCRYPTION_KEY to another.
 *
 * All-or-nothing: every row is decrypted with the old key, re-encrypted with the new key
 * and verified by a round-trip decrypt before anything is written. The writes then go in
 * one transaction, so a failure leaves the stored credentials exactly as they were.
 *
 * Prisma is injected. Key and credential problems are returned, never thrown. Results and
 * messages never contain keys, secrets or ciphertext; only shop domains are reported.
 */

const KEYS_INVALID = "Both keys must be 64 hex characters.";
const KEYS_SAME = "The new key must differ from the old key.";
const UNDECRYPTABLE =
  "Some stored credentials could not be decrypted with the old key. Nothing was changed.";
const STORAGE = "The credentials could not be read or saved. Nothing was changed.";

function isValidKey(keyHex) {
  try {
    parseEncryptionKey(keyHex);
    return true;
  } catch {
    return false;
  }
}

/** Returns the re-encrypted pair for one row, or null if it cannot be rotated safely. */
function rotateRow(row, oldKey, newKey) {
  try {
    const clientId = decryptSecret(row.clientIdEnc, oldKey);
    const clientSecret = decryptSecret(row.clientSecretEnc, oldKey);
    const clientIdEnc = encryptSecret(clientId, newKey);
    const clientSecretEnc = encryptSecret(clientSecret, newKey);
    if (
      decryptSecret(clientIdEnc, newKey) !== clientId ||
      decryptSecret(clientSecretEnc, newKey) !== clientSecret
    ) {
      return null;
    }
    return { clientIdEnc, clientSecretEnc };
  } catch {
    return null;
  }
}

/**
 * @param {{ prisma: object, oldKey: string, newKey: string }} args
 * @returns {Promise<{ ok: true, rotated: number } |
 *   { ok: false, errorClass: string, message: string, failedShops?: string[] }>}
 */
export async function reencryptConnections({ prisma, oldKey, newKey }) {
  if (!isValidKey(oldKey) || !isValidKey(newKey)) {
    return { ok: false, errorClass: "config", message: KEYS_INVALID };
  }
  if (oldKey.toLowerCase() === newKey.toLowerCase()) {
    return { ok: false, errorClass: "config", message: KEYS_SAME };
  }

  let rows;
  try {
    rows = await prisma.salesforceConnection.findMany({
      select: { shop: true, clientIdEnc: true, clientSecretEnc: true },
      orderBy: { shop: "asc" },
    });
  } catch {
    return { ok: false, errorClass: "storage", message: STORAGE };
  }

  const updates = [];
  const failedShops = [];
  for (const row of rows) {
    const rotated = rotateRow(row, oldKey, newKey);
    if (rotated) updates.push({ shop: row.shop, ...rotated });
    else failedShops.push(row.shop);
  }
  if (failedShops.length > 0) {
    return {
      ok: false,
      errorClass: "credentials",
      message: UNDECRYPTABLE,
      failedShops: failedShops.sort(),
    };
  }

  if (updates.length > 0) {
    try {
      await prisma.$transaction(
        updates.map(({ shop, clientIdEnc, clientSecretEnc }) =>
          prisma.salesforceConnection.update({
            where: { shop },
            data: { clientIdEnc, clientSecretEnc },
          }),
        ),
      );
    } catch {
      return { ok: false, errorClass: "storage", message: STORAGE };
    }
  }
  return { ok: true, rotated: rows.length };
}
