/**
 * Rotates ENCRYPTION_KEY by re-encrypting every stored Salesforce credential.
 *
 * Usage:
 *   OLD_ENCRYPTION_KEY=... NEW_ENCRYPTION_KEY=... DATABASE_URL=... node scripts/rotate-encryption-key.mjs
 * (or export the variables, or use `node --env-file`).
 *
 * Procedure:
 *   1. Back up the database.
 *   2. Stop the app and the scheduler.
 *   3. Run this script with the old and new keys.
 *   4. Set ENCRYPTION_KEY to the new key.
 *   5. Start the app.
 *   6. Discard the old key.
 *
 * All-or-nothing: if any credential cannot be decrypted with the old key, nothing is
 * written. Prints only the rotated count or an error message (plus affected shop domains);
 * never a key or credential. Exit codes: 0 done, 1 failed, 2 missing variable.
 */
import { PrismaClient } from "@prisma/client";
import { reencryptConnections } from "../app/lib/key-rotation.server.js";

const REQUIRED = ["OLD_ENCRYPTION_KEY", "NEW_ENCRYPTION_KEY", "DATABASE_URL"];

for (const name of REQUIRED) {
  if (!process.env[name]) {
    console.error(`${name} is not set.`);
    process.exit(2);
  }
}

const prisma = new PrismaClient();
let exitCode = 1;
try {
  const result = await reencryptConnections({
    prisma,
    oldKey: process.env.OLD_ENCRYPTION_KEY,
    newKey: process.env.NEW_ENCRYPTION_KEY,
  });
  if (result.ok) {
    console.log(`Rotated ${result.rotated} connection(s).`);
    exitCode = 0;
  } else {
    console.error(result.message);
    if (result.failedShops?.length) {
      console.error(`Affected shops: ${result.failedShops.join(", ")}`);
    }
  }
} catch {
  console.error("The rotation failed unexpectedly. Nothing was changed.");
} finally {
  await prisma.$disconnect().catch(() => {});
}
process.exit(exitCode);
