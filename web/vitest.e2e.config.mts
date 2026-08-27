import { defineConfig } from "vitest/config";

/**
 * End-to-end suite, kept out of `vitest.config.ts` so `npm test` never picks
 * it up: the unit suite must stay runnable without a server.
 *
 * Run with `npm run test:e2e` against a stack reachable at SHATTERS_E2E_URL.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    // These talk to a real server over a real socket; the default 5s is tight.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time: the suites share a database and a prekey pool.
    fileParallelism: false,
  },
});
