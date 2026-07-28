import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@activefs/config", replacement: resolve(root, "packages/config/src/index.ts") },
      { find: "@activefs/testing/conformance", replacement: resolve(root, "packages/testing/src/conformance.ts") },
      { find: "@activefs/core", replacement: resolve(root, "packages/core/src/index.ts") },
      { find: "@activefs/testing", replacement: resolve(root, "packages/testing/src/index.ts") },
      { find: "@activefs/cli", replacement: resolve(root, "packages/cli/src/index.ts") },
      { find: "@activefs/local", replacement: resolve(root, "packages/local/src/index.ts") },
      { find: "@activefs/mount", replacement: resolve(root, "packages/mount/src/index.ts") },
      { find: "@activefs/source-http/fetch", replacement: resolve(root, "packages/source-http/src/fetch.ts") },
      { find: "@activefs/source-http", replacement: resolve(root, "packages/source-http/src/index.ts") },
      { find: "@activefs/mcp", replacement: resolve(root, "packages/mcp/src/index.ts") }
    ]
  },
  test: {
    include: ["packages/**/*.test.ts", "examples/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/testSupport.ts",
        "**/dist/**",
        "examples/**",
        "scripts/**"
      ],
      thresholds: {
        lines: 84,
        branches: 74,
        functions: 86,
        statements: 83
      }
    }
  }
});
