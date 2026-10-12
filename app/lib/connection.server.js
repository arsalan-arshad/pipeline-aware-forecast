/**
 * Save, test and delete a shop's Salesforce connection.
 *
 * The client id and secret are encrypted before they reach the database and
 * are never returned or logged. The Prisma client, the encryption key and the
 * fetch function are injected, so nothing here reads the environment or the
 * network. Validation and credential problems come back as { ok: false }
 * results with fixed messages; only a rejecting Prisma call propagates.
 */

import {
  createSalesforceClient,
  isAllowedInstanceUrl,
  SalesforceError,
} from "./pipeline/salesforce-client.server.js";
import {
  CredentialsCryptoError,
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from "./pipeline/credentials-crypto.server.js";

const NOT_CONNECTED_MESSAGE = "Salesforce is not connected yet.";
const CREDENTIALS_MESSAGE =
  "The stored Salesforce credentials could not be read. Please reconnect Salesforce.";

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

const configError = (message) => ({ ok: false, errorClass: "config", message });

/**
 * @param {object} args
 * @param {object} args.prisma - injected Prisma client
 * @param {string} args.shop
 * @param {string} args.instanceUrl - Salesforce My Domain address
 * @param {string} args.clientId
 * @param {string} args.clientSecret
 * @param {string} args.encryptionKey - 64 hex characters
 * @returns {Promise<{ ok: true } | { ok: false, errorClass: "config", message: string }>}
 */
export async function saveSalesforceConnection({
  prisma,
  shop,
  instanceUrl,
  clientId,
  clientSecret,
  encryptionKey,
} = {}) {
  if (!nonEmptyString(shop)) return configError("A shop is required.");
  if (!isAllowedInstanceUrl(instanceUrl)) {
    return configError(
      "Enter your Salesforce My Domain address, e.g. https://yourcompany.my.salesforce.com.",
    );
  }
  if (!nonEmptyString(clientId)) return configError("Enter the client ID.");
  if (!nonEmptyString(clientSecret)) return configError("Enter the client secret.");
  if (instanceUrl.length > 512 || clientId.length > 512 || clientSecret.length > 512) {
    return configError("One of the values is too long.");
  }
  try {
    parseEncryptionKey(encryptionKey);
  } catch {
    return configError("The server is missing a valid ENCRYPTION_KEY.");
  }

  const origin = new URL(instanceUrl).origin;
  const clientIdEnc = encryptSecret(clientId.trim(), encryptionKey);
  const clientSecretEnc = encryptSecret(clientSecret.trim(), encryptionKey);

  await prisma.salesforceConnection.upsert({
    where: { shop },
    create: {
      shop,
      instanceUrl: origin,
      authMode: "client_credentials",
      clientIdEnc,
      clientSecretEnc,
    },
    update: {
      instanceUrl: origin,
      authMode: "client_credentials",
      clientIdEnc,
      clientSecretEnc,
      lastErrorClass: null,
      lastErrorMessage: null,
      lastErrorAt: null,
    },
  });
  return { ok: true };
}

/**
 * Decrypt a stored row and build a Salesforce client from it.
 * Returns { client } or { failure } (an errorClass/message pair).
 */
export function clientFromConnectionRow(row, encryptionKey, fetchImpl) {
  let clientId;
  let clientSecret;
  try {
    clientId = decryptSecret(row.clientIdEnc, encryptionKey);
    clientSecret = decryptSecret(row.clientSecretEnc, encryptionKey);
  } catch (err) {
    if (err instanceof CredentialsCryptoError) {
      return { failure: { errorClass: "credentials", message: CREDENTIALS_MESSAGE } };
    }
    throw err;
  }
  try {
    const options = { instanceUrl: row.instanceUrl, clientId, clientSecret };
    if (fetchImpl !== undefined) options.fetchImpl = fetchImpl;
    return { client: createSalesforceClient(options) };
  } catch (err) {
    if (err instanceof SalesforceError) {
      return { failure: { errorClass: err.errorClass, message: err.userMessage } };
    }
    throw err;
  }
}

/**
 * Test the stored connection. Never rejects for Salesforce or credential problems.
 * @returns {Promise<{ ok: true, message: string } | { ok: false, errorClass: string, message: string }>}
 */
export async function testStoredConnection({ prisma, shop, encryptionKey, fetchImpl } = {}) {
  const row = await prisma.salesforceConnection.findUnique({ where: { shop } });
  if (!row) {
    return { ok: false, errorClass: "not_connected", message: NOT_CONNECTED_MESSAGE };
  }
  let built;
  try {
    built = clientFromConnectionRow(row, encryptionKey, fetchImpl);
  } catch {
    // Anything unexpected while decrypting/building: a fixed message, never a raw error.
    return {
      ok: false,
      errorClass: "unexpected_response",
      message: "The connection test failed for an unexpected reason.",
    };
  }
  if (built.failure) return { ok: false, ...built.failure };
  return await built.client.testConnection();
}

/**
 * Remove the connection and the pipeline data derived from it, atomically.
 * @returns {Promise<undefined>}
 */
export async function deleteSalesforceConnection({ prisma, shop } = {}) {
  if (!nonEmptyString(shop)) throw new Error("A shop is required.");
  await prisma.$transaction([
    prisma.salesforceConnection.deleteMany({ where: { shop } }),
    prisma.pipelineSnapshot.deleteMany({ where: { shop } }),
    prisma.unmatchedProduct.deleteMany({ where: { shop } }),
  ]);
}
