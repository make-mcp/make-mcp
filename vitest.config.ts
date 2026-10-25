import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    include: ["packages/*/src/**/*.test.ts", "e2e/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
