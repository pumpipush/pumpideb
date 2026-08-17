import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Force the process to exit after all tests complete.
    // The shared pg.Pool in @workspace/db keeps connections open and would
    // otherwise prevent vitest from exiting cleanly.
    forceExit: true,
    // Global timeout for every test and hook.
    // The default 5 000 ms is too tight when the full suite runs concurrently:
    // nacl crypto ops in profiles.test.ts and up-to-2 000 keypair-scan loops in
    // wallet.login.test.ts can exceed 5 s under CPU contention.  20 000 ms
    // matches what the auth test files already set via vi.setConfig().
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
