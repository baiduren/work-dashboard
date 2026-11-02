import { PrismaClient } from "@prisma/client";

// lib/db 是唯一的数据访问入口（docs/01-architecture.md「模块边界」）。
// 开发模式下热重载会重复实例化 PrismaClient，用全局单例避免连接堆积。
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
