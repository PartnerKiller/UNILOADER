const CACHE_NAME = 'universal-downloader-v4-https';

// Immediately self-terminate if registered under insecure HTTP
if (self.location.protocol === 'http:') {
  self.registration.unregister();
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Always fetch fresh from network to eliminate stale scripts and duplicate downloads
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
