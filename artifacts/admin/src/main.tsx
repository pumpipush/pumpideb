import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

// Inject favicons using import.meta.env.BASE_URL so Vite's base-path
// rewriting doesn't double-prepend the prefix (index.html static hrefs
// get the base prepended a second time when base !== '/').
(function injectFavicons() {
  const base = import.meta.env.BASE_URL; // e.g. "/admin/"
  const head = document.head;

  const defs = [
    { rel: 'icon',             type: 'image/x-icon', href: `${base}favicon.ico` },
    { rel: 'icon',             type: 'image/png',    href: `${base}favicon-32x32.png`, sizes: '32x32' },
    { rel: 'icon',             type: 'image/png',    href: `${base}favicon-16x16.png`, sizes: '16x16' },
    { rel: 'apple-touch-icon', type: '',             href: `${base}apple-touch-icon.png`, sizes: '180x180' },
  ];

  for (const def of defs) {
    const link = document.createElement('link');
    link.rel   = def.rel;
    if (def.type)  link.type  = def.type;
    if (def.sizes) link.sizes.value = def.sizes;
    link.href  = def.href;
    head.appendChild(link);
  }
})();

createRoot(document.getElementById('root')!, {
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
