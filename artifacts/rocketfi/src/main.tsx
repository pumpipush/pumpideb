import { createRoot } from 'react-dom/client';

import App from './App';
import { isPlatformFeeConfigured } from './lib/platform-fee';

import './index.css';

// ── Startup fee-recipient check ────────────────────────────────────────────────
// Warn immediately at boot so the issue is visible in the console on every
// page load — both in development and production.
if (!isPlatformFeeConfigured()) {
  console.warn(
    "%c[RocketFi] Platform fee recipient not configured — all fees will be skipped.\n" +
    "Set VITE_PLATFORM_FEE_RECIPIENT to a valid Solana wallet address to collect revenue.",
    "color: orange; font-weight: bold;",
  );
}

createRoot(document.getElementById('root')!).render(<App />);
