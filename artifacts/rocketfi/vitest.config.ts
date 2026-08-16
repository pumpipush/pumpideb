import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  // React plugin handles JSX transform for .tsx files (e.g. useTxToast.tsx)
  plugins: [react()],
  resolve: {
    // Mirror the '@' alias from vite.config.ts so test imports resolve correctly
    alias: {
      "@": path.resolve(new URL(".", import.meta.url).pathname, "src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
  },
});
