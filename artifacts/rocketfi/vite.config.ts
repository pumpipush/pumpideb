import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// Use the async function form so we can:
//  1. Access `command` ('build' | 'serve') and skip PORT/BASE_PATH validation for builds
//  2. Keep top-level await for Replit-specific plugin imports
export default defineConfig(async ({ command }) => {
  const isBuild = command === 'build';

  // PORT is only needed for the dev/preview server, not for static builds.
  const rawPort = process.env.PORT;
  if (!isBuild && !rawPort) {
    throw new Error(
      'PORT environment variable is required but was not provided.',
    );
  }
  const port = Number(rawPort ?? '3000');
  if (!isBuild && (Number.isNaN(port) || port <= 0)) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  // BASE_PATH defaults to '/' for standalone VPS builds.
  const basePath = process.env.BASE_PATH ?? '/';

  const replitPlugins =
    !isBuild && process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : [];

  return {
    base: basePath,
    plugins: [
      react(),
      tailwindcss(),
      runtimeErrorOverlay(),
      nodePolyfills({
        // Polyfill Buffer and process — required by @solana/web3.js in the browser
        globals: { Buffer: true, global: true, process: true },
        protocolImports: true,
      }),
      ...replitPlugins,
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
        '@assets': path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
      },
      dedupe: ['react', 'react-dom'],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, 'dist/public'),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts: true,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: '0.0.0.0',
      allowedHosts: true,
    },
  };
});
