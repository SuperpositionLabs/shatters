import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig sets `jsx: preserve` because Next compiles the app itself; vitest
  // has no such step, so the automatic runtime is configured here rather than
  // pulling in a plugin for one setting.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
