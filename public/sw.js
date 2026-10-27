// خدمة الإشعارات — بيجر مزهرية
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "مزهرية", body: e.data ? e.data.text() : "طلبك جاهز" }; }
  e.waitUntil(self.registration.showNotification(d.title || "مزهرية", {
    body: d.body,
    tag: d.tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [400, 150, 400, 150, 700],
    icon: "/icon-192.png",
    badge: "/badge.png",
    lang: "ar",
    dir: "rtl",
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.includes(url.split("?")[1] || "§")) return c.focus();
    return self.clients.openWindow(url);
  }));
});
