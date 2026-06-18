// LMP Training Videos — Service Worker
// Caches the app shell so it loads instantly and passes PWA installability checks.
// Also handles Web Push notifications.

const CACHE_NAME = 'lmp-training-v20';

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

  // Always go to network for Supabase, Wasabi, external resources
  if (
    url.hostname.includes('supabase') ||
    url.hostname.includes('wasabi') ||
    url.hostname.includes('googleapis') ||
    url.protocol !== 'https:'
  ) {
    return; // let browser handle normally
  }

  const cacheGet = (req) => fetch(req).then((response) => {
    if (response.ok && req.method === 'GET') {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
    }
    return response;
  });

  // The HTML shell and app code change on every deploy — serve them
  // NETWORK-FIRST so a new version loads immediately, with the cache only as
  // an offline fallback. (Cache-first here is what made old code linger.)
  const isShell =
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('/app.js') ||
    url.pathname.endsWith('/styles.css') ||
    url.pathname.endsWith('/sw.js');

  if (isShell) {
    event.respondWith(cacheGet(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Cache-first for immutable static assets (icons, manifest)
  event.respondWith(
    caches.match(event.request).then((cached) => cached || cacheGet(event.request))
  );
});

// ── Push: show notification when server sends a push message ──────────────────
self.addEventListener('push', (event) => {
  let payload = { title: 'LMP Training', body: '' };
  try { payload = event.data?.json() || payload; } catch (_) {}

  const tasks = [
    self.registration.showNotification(payload.title, {
      body:     payload.body,
      icon:     '/icon-192.png',
      badge:    '/icon-192.png',
      tag:      payload.tag || 'lmp',
      renotify: true,
      vibrate:  [200, 100, 200],
      data:     { url: payload.url || '/' },
    }),
  ];

  // Update the home-screen app icon badge number (iOS 16.4+ / desktop)
  if (typeof payload.badgeCount === 'number' && 'setAppBadge' in navigator) {
    tasks.push(
      payload.badgeCount > 0
        ? navigator.setAppBadge(payload.badgeCount)
        : navigator.clearAppBadge()
    );
  }

  event.waitUntil(Promise.all(tasks));
});

// ── Notification click: focus or open the app ─────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })
  );
});
