import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Force the process to exit after all tests complete.
    // The shared pg.Pool in @workspace/db keeps connections open and would
    // otherwise prevent vitest from exiting cleanly.
    forceExit: true,
  },
});
