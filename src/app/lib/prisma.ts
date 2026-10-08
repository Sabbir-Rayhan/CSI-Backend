import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { envVars } from "../../config/env";


const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: envVars.DATABASE_URL! }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;