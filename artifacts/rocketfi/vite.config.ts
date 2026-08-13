import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// Use the async function form so we can:
//  1. Access `command` ('build' | 'serve') and skip PORT/BASE_PATH validation for builds
//  2. Keep top-level await for Replit-specific plugin imports
export default defineConfig(async ({ command, mode }) => {
  const isBuild = command === 'build';

  // Load .env / .env.[mode] / .env.[mode].local files so the guard below can
  // see values that Vite would bake into the bundle even when they're not in
  // the shell env.  Shell env takes precedence: we check process.env first.
  // loadEnv with prefix '' returns all keys (not just VITE_*).
  const dotenv = loadEnv(mode, path.resolve(import.meta.dirname), '');
  const resolveEnv = (key: string): string =>
    (process.env[key] ?? dotenv[key] ?? '').trim();

  // PORT is only needed for the dev/preview server, not for static builds.
  const rawPort = resolveEnv('PORT') || undefined;
  if (!isBuild && !rawPort) {
    throw new Error(
      'PORT environment variable is required but was not provided.',
    );
  }
  const port = Number(rawPort ?? '3000');
  if (!isBuild && (Number.isNaN(port) || port <= 0)) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  // ── Fee-recipient guard ────────────────────────────────────────────────────
  //
  // VITE_PLATFORM_FEE_RECIPIENT must be set and valid for every production
  // build.  If absent the fee-injection code silently no-ops in the bundle —
  // every trade and launch runs fee-free in production.
  //
  // Two branches:
  //   • Blank/missing value → error unless ALLOW_MISSING_FEE_RECIPIENT=1
  //     (escape hatch for intentional fee-free local builds)
  //   • Non-blank but invalid address → ALWAYS an error; the override only
  //     exempts a missing value, not a malformed one.
  //
  // Note: reads from both shell env AND .env files so users can supply the
  // key in .env.production without it being present in the shell environment.
  if (isBuild) {
    const feeRecipient = resolveEnv('VITE_PLATFORM_FEE_RECIPIENT');
    const allowMissing = resolveEnv('ALLOW_MISSING_FEE_RECIPIENT') === '1';

    if (!feeRecipient) {
      if (!allowMissing) {
        throw new Error(
          '\n' +
          '┌─────────────────────────────────────────────────────────────────┐\n' +
          '│  VITE_PLATFORM_FEE_RECIPIENT is not set.                        │\n' +
          '│                                                                 │\n' +
          '│  Without it, ALL platform fees are silently skipped — every     │\n' +
          '│  trade and token launch runs fee-free in production.            │\n' +
          '│                                                                 │\n' +
          '│  Fix: set VITE_PLATFORM_FEE_RECIPIENT to your Solana wallet     │\n' +
          '│  address before building (shell env or .env.production).        │\n' +
          '│                                                                 │\n' +
          '│  To build without fees intentionally (e.g. local testing):      │\n' +
          '│    ALLOW_MISSING_FEE_RECIPIENT=1 pnpm run build                 │\n' +
          '└─────────────────────────────────────────────────────────────────┘\n',
        );
      }
      // allowMissing=1 and blank: skip further validation — nothing to check.
    } else {
      // Non-blank value: always validate, regardless of ALLOW_MISSING_FEE_RECIPIENT.
      // Uses @solana/web3.js PublicKey — identical to the runtime check —
      // so strings that pass a character regex but decode to the wrong byte
      // length (e.g. 32 × "2") are correctly rejected.
      try {
        const { PublicKey } = await import('@solana/web3.js');
        new PublicKey(feeRecipient); // throws if not a valid 32-byte public key
      } catch {
        throw new Error(
          `\nVITE_PLATFORM_FEE_RECIPIENT is not a valid Solana wallet address.\n` +
          `Value: "${feeRecipient}"\n` +
          `Check the address in your Solana wallet and try again.\n` +
          `(ALLOW_MISSING_FEE_RECIPIENT does not override an invalid address.)\n`,
        );
      }
    }
  }

  // BASE_PATH defaults to '/' for standalone VPS builds.
  const basePath = resolveEnv('BASE_PATH') || '/';

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
    // @privy-io/react-auth uses eventemitter3 (CJS) which needs explicit
    // pre-bundling so Vite can convert it to ESM. Also include wagmi/viem
    // so they share the same React instance as the host app (prevents the
    // "Invalid hook call / multiple React copies" error).
    optimizeDeps: {
      include: [
        "eventemitter3",
      ],
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
        '@assets': path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
        // @stripe/stripe-js is a transitive dep of @privy-io/react-auth (via
        // @stripe/crypto). We don't use Privy embedded wallets so stub it out
        // to avoid a "could not resolve" error during Vite dep-optimisation.
        '@stripe/stripe-js': path.resolve(import.meta.dirname, 'src/lib/stripe-stub.ts'),
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
