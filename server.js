// بيجر مزهرية — سيرفر مستقل بدون أي مكتبات خارجية
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const push = require("./push");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const TOKEN_RE = /^[a-z0-9]{10,40}$/;
const TTL = 8 * 60 * 60 * 1000; // الطلب ينحذف تلقائياً بعد 8 ساعات
const STATUSES = ["waiting", "ready", "done"];

const orders = new Map(); // token -> { status, num, created, readyAt, listeners:Set, subs:[] }

function get(token) {
  let o = orders.get(token);
  if (!o) {
    o = { status: "waiting", num: null, created: Date.now(), readyAt: null, at: Date.now(), listeners: new Set(), subs: [] };
    orders.set(token, o);
  }
  return o;
}
const view = o => ({ status: o.status, num: o.num, created: o.created, readyAt: o.readyAt, now: Date.now() });

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req, max, cb) {
  let body = "";
  req.on("data", c => { body += c; if (body.length > max) req.destroy(); });
  req.on("end", () => cb(body));
}
function broadcast(o) {
  const msg = `data: ${JSON.stringify(view(o))}\n\n`;
  for (const l of o.listeners) l.write(msg);
}

async function notify(o, token) {
  if (!o.subs.length) return;
  const payload = JSON.stringify({
    title: "مزهرية · طلبك جاهز ✨",
    body: `طلبك رقم ${o.num ?? ""} جاهز، تفضّل استلمه من الكاشير`,
    tag: "order-" + token,
    url: `/?o=${o.num ?? ""}&t=${token}`,
  });
  const keep = [];
  await Promise.all(o.subs.map(async s => {
    try {
      const code = await push.send(s, payload);
      if (code !== 404 && code !== 410) keep.push(s);
    } catch (e) { keep.push(s); console.error("push failed", e.message); }
  }));
  o.subs = keep;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".js": "text/javascript; charset=utf-8" };
function file(res, name, cache) {
  const p = path.join(PUB, name);
  if (!p.startsWith(PUB) || !fs.existsSync(p)) return false;
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream", "Cache-Control": cache || "public, max-age=86400" });
  fs.createReadStream(p).pipe(res);
  return true;
}

function manifest(url) {
  const o = url.searchParams.get("o"), t = url.searchParams.get("t");
  const isOrder = t && TOKEN_RE.test(t);
  return {
    name: isOrder ? `مزهرية · طلب ${o}` : "مزهرية · البيجر",
    short_name: isOrder ? `طلب ${o}` : "البيجر",
    start_url: isOrder ? `/?o=${encodeURIComponent(o)}&t=${t}` : "/",
    scope: "/",
    display: "standalone",
    background_color: "#F4EDE2",
    theme_color: "#F4EDE2",
    dir: "rtl",
    lang: "ar",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/health") return json(res, 200, { ok: true });
  if (p === "/api/vapid") return json(res, 200, { key: push.publicKey });
  if (p === "/manifest.webmanifest") {
    res.writeHead(200, { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(manifest(url)));
  }

  const m = p.match(/^\/api\/o\/([^/]+)(\/events|\/sub)?$/);
  if (m) {
    const token = m[1];
    if (!TOKEN_RE.test(token)) return json(res, 400, { error: "bad token" });
    const o = get(token);

    // بث مباشر للزبون
    if (m[2] === "/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`data: ${JSON.stringify(view(o))}\n\n`);
      o.listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { clearInterval(ping); o.listeners.delete(res); });
      return;
    }

    // تسجيل جوال الزبون للإشعارات
    if (m[2] === "/sub" && req.method === "POST") {
      return readBody(req, 4000, body => {
        try {
          const s = JSON.parse(body);
          if (!/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw 0;
          if (!o.subs.some(x => x.endpoint === s.endpoint)) o.subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
          if (o.subs.length > 5) o.subs.shift();
          json(res, 200, { ok: true });
          if (o.status === "ready") notify(o, token);
        } catch { json(res, 400, { error: "bad subscription" }); }
      });
    }

    // الكاشير يغيّر الحالة: {status, num, created}
    if (!m[2] && req.method === "POST") {
      return readBody(req, 300, body => {
        let d;
        try { d = JSON.parse(body); } catch { d = { status: body.trim() }; }
        if (!STATUSES.includes(d.status)) return json(res, 400, { error: "bad status" });
        if (Number.isInteger(d.num) && d.num > 0 && d.num < 10000) o.num = d.num;
        if (Number.isFinite(d.created) && Math.abs(Date.now() - d.created) < TTL) o.created = d.created;
        const was = o.status;
        o.status = d.status; o.at = Date.now();
        if (d.status === "ready" && was !== "ready") { o.readyAt = Date.now(); notify(o, token); }
        if (d.status === "waiting") o.readyAt = null;
        broadcast(o);
        json(res, 200, { ok: true });
      });
    }

    if (!m[2] && req.method === "GET") return json(res, 200, view(o));
    return json(res, 405, { error: "method" });
  }

  if (req.method === "GET") {
    if (p === "/sw.js") return file(res, "sw.js", "no-cache");
    if (/^\/[a-z0-9-]+\.png$/.test(p) && file(res, p.slice(1))) return;
    return file(res, "index.html", "no-cache");
  }
  json(res, 404, { error: "not found" });
});

// تنظيف الطلبات القديمة
setInterval(() => {
  const now = Date.now();
  for (const [t, o] of orders) if (now - o.at > TTL && o.listeners.size === 0) orders.delete(t);
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log("Mazhariya pager on :" + PORT));
