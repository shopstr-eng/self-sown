// Self-destruct service worker for legacy /sw.js registrations.
//
// next-pwa's default worker path used to be /sw.js. The registration later
// moved to /service-worker.js and this path began 404ing. Browsers holding
// the OLD worker (the one that cache-firsted every request, including HTML
// navigations) can never update — a 404 update check keeps the stale worker
// active forever, and hard refresh does not bypass a service worker. Those
// tabs serve months-old HTML whose chunks no longer exist, so hydration
// never runs and every deferred-load image stays invisible.
//
// When a browser next update-checks /sw.js it gets THIS file, which:
//   1. Activates immediately (skipWaiting).
//   2. Deletes every Cache Storage entry the old worker created.
//   3. Unregisters itself.
//   4. Force-navigates open tabs once so they load fresh HTML.
//
// While active it installs no fetch handler, so all requests go straight to
// the network even before unregistration completes.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      await self.registration.unregister();
      const clientList = await self.clients.matchAll({ type: "window" });
      // Await every navigation so activation can't settle with reloads
      // pending; isolate rejections so one closed/racing tab can't block
      // the others. (Synchronous try/catch would miss async rejections.)
      await Promise.all(
        clientList.map((client) =>
          client.navigate(client.url).catch(() => {
            /* navigate may be unavailable or rejected; ignore */
          })
        )
      );
    })()
  );
});
