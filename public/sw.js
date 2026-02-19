// Diskold Service Worker — segundo plano
const CACHE = 'diskold-v3';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      '/',
      '/index.html',
      '/socket.io/socket.io.js',
    ]).catch(()=>{}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

// Responder con cache cuando sea posible (modo offline básico)
self.addEventListener('fetch', e => {
  // No interceptar peticiones de API ni socket.io
  if(e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) return;
  e.respondWith(
    fetch(e.request).catch(() =>
      caches.match(e.request).then(r => r || fetch(e.request))
    )
  );
});

// Mantener el SW activo con mensajes periódicos
self.addEventListener('message', e => {
  if(e.data === 'keepalive') {
    // Responder para mantener el worker vivo
    e.source && e.source.postMessage('alive');
  }
});
