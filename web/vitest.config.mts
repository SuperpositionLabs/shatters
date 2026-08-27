import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig sets `jsx: preserve` because Next compiles the app itself, so
  // vitest needs its own transform. The plugin also handles Fast Refresh
  // annotations that rolldown would otherwise choke on.
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
