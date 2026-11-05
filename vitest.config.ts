import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      exclude: [
        "node_modules/",
        "build/",
        "**/*.test.ts",
        "scripts/",
        "*.config.*",
        ".eslintrc.cjs",
      ],
      // Coverage thresholds - fail the coverage run if not met
      // Note: src/services/*.ts excluded - requires Mail.app integration, not unit testable
      thresholds: {
        "src/utils/**/*.ts": {
          statements: 90,
          branches: 75,
          functions: 100,
          lines: 90,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "cloudflare:workers": path.resolve(__dirname, "./test/cloudflare-workers-stub.ts"),
    },
  },
});
