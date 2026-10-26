import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      importSource: "preact",
      runtime: "automatic",
    },
  },
  test: {
    // Persist transformed modules between runs; vitest invalidates entries by
    // source content and clears the whole cache when the lockfile changes.
    fsModuleCache: true,
    fsModuleCachePath: ".vitest-cache",
    coverage: {
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-support.ts", "scripts/**"],
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
  },
});

# Automated fix for issue #222: Fix flaky gateway-mode Studio integration test under parallel runs
