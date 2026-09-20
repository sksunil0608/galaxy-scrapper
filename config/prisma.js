import { PrismaClient } from "@prisma/client";

const prisma = global.prismaClient ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prismaClient = prisma;
}

export default prisma;
