// Caches the app shell only. GitHub API responses (personal data) are never
// cached here: requests to other origins pass straight through.

const VERSION = "pa-app-v11";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "js/app.js",
  "js/gh.js",
  "js/logfmt.js",
  "js/stats.js",
  "js/push.js",
  "js/weather.js",
  "icons/badge-96.png",
  "vendor/marked.min.js",
  "vendor/purify.min.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first so updates show up right away; the cache covers offline starts.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
  );
});

// Alerts sent by the scheduled brief and review (scripts/web_push.mjs).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "個人助理", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "個人助理", {
      body: data.body || "",
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      tag: data.tag || "pa-alert",
      renotify: true,
      data: { url: data.url || "./#/today" },
    })
  );
});

// Open the linked page, reusing an open window of the app when there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "./#/today", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) {
          return client.navigate(url).then((c) => (c || client).focus());
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
