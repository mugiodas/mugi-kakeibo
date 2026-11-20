const CACHE_NAME = 'mugi-kakeibo-pwa-v1';
const BASE = '/mugi-kakeibo/';
const CORE_ASSETS = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.json',
  BASE + 'favicon.png',
  BASE + 'icon-192.png',
  BASE + 'icon-512.png',
  BASE + 'apple-touch-icon.png'
];

// Install: Precache core static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS).catch((err) => {
        console.warn('[SW] Precache partial error:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up old caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Smart caching strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignore non-GET requests and browser extensions
  if (event.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Do NOT intercept Firebase Auth / Firestore network calls (they handle their own persistence)
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  // 1. Navigation requests (Opening the PWA HTML page)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      // Try network first with a 1.2s timeout; if cold-start/offline/slow, fall back to cached HTML immediately
      Promise.race([
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Network timeout')), 1200))
      ]).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        const indexCached = await caches.match(BASE + 'index.html');
        if (indexCached) return indexCached;
        return fetch(event.request);
      })
    );
    return;
  }

  // 2. Google Fonts & Static CDN assets: Cache First
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 3. Static assets (JS, CSS, Images, Icons): Stale-While-Revalidate
  const isStaticAsset =
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.includes('/assets/');

  if (isStaticAsset) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
              });
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        // Return cached immediately if available, while updating cache in background
        return cachedResponse || fetchPromise;
      })
    );
  }
});
