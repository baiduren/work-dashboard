import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // 与 tsconfig paths 一致，使 middleware.ts 等模块可直接在单测中导入
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
