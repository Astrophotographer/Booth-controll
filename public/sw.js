const CACHE_PREFIX = "bazaar-desk-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v8`;
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];
const APP_SHELL_PATHS = new Set(PRECACHE_URLS);
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data?.json(); } catch { return; }
    if (!data || !CHAT_ID.test(data.boothId || "") || !["booth", "control"].includes(data.targetRole)) return;
    await self.registration.showNotification("새 대화", {
      body: "새 대화 메시지가 도착했습니다.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: `bazaar-chat-${data.targetRole}-${data.boothId}`,
      renotify: true,
      data: { boothId: data.boothId, targetRole: data.targetRole },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const boothId = event.notification.data?.boothId;
  if (!CHAT_ID.test(boothId || "")) return;
  event.waitUntil((async () => {
    const target = new URL("/", self.location.origin);
    target.searchParams.set("chat", boothId);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (app) {
      try {
        if (typeof app.navigate === "function") {
          const navigated = await app.navigate(target.href);
          if (navigated) {
            await navigated.focus();
            return;
          }
        }
      } catch { /* Fall through to a same-origin app message. */ }
      app.postMessage({ type: "OPEN_CHAT", boothId });
      await app.focus();
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    if (url.pathname !== "/" && url.pathname !== "/index.html") return;
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (response.ok && contentType.startsWith("text/html")) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/index.html", response.clone());
        }
        return response;
      } catch {
        return (await caches.match("/index.html")) || Response.error();
      }
    })());
    return;
  }

  if (!APP_SHELL_PATHS.has(url.pathname)) return;

  const cachePromise = caches.open(CACHE_NAME);
  const updatePromise = cachePromise.then((cache) => fetch(request).then((response) => {
    if (!response.ok) return response;
    return cache.put(request, response.clone()).then(() => response);
  }));
  event.waitUntil(updatePromise.then(() => undefined).catch(() => undefined));
  event.respondWith(cachePromise
    .then((cache) => cache.match(request))
    .then((cached) => cached || updatePromise)
    .catch(() => Response.error()));
});
