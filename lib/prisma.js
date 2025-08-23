// lib/prisma.js
import { PrismaClient } from "@prisma/client";

/**
 * Prisma singleton para evitar múltiples instancias en hot-reload (Next.js dev).
 * Además, permite elegir la URL desde DATABASE_URL o PRISMA_DATABASE_URL
 * (esta última suele usarse con Prisma Accelerate).
 */
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ["warn", "error"], // quita/ajusta si no quieres logs
    datasources: {
      db: {
        url: process.env.DATABASE_URL || process.env.PRISMA_DATABASE_URL,
      },
    },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;

