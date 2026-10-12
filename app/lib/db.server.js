/**
 * Prisma client singleton. In dev, the client is cached on `global` so hot
 * reloads do not open a new connection pool each time.
 */
import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
