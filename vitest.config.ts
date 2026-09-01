import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    exclude: ["**/dist/**", "**/node_modules/**", "output/**", "tmp/**"],
    include: ["tests/**/*.test.ts"],
    pool: "threads",
  },
});
