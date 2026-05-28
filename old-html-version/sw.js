// LMP Training Videos — Service Worker
// Caches the app shell so it loads instantly and passes PWA installability checks.

const CACHE_NAME = 'lmp-training-v1';

// App shell files to cache on install
const SHELL = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Install: pre-cache the app shell ──────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API/auth, cache-first for static shell ───────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go to network for Supabase, Wasabi, Twilio, external resources
  if (
    url.hostname.includes('supabase') ||
    url.hostname.includes('wasabi') ||
    url.hostname.includes('twilio') ||
    url.hostname.includes('googleapis') ||
    url.protocol !== 'https:'
  ) {
    return; // let browser handle normally
  }

  // Cache-first for static app shell assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful GET responses for app shell files
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
