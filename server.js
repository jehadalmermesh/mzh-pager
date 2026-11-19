// بيجر مزهرية — سيرفر مستقل بدون أي مكتبات خارجية
const http = require("http");
const fs = require("fs");
const path = require("path");
const push = require("./push");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "orders.json");
const TOKEN_RE = /^[a-z0-9]{10,40}$/;
const LIVE_TTL = 8 * 60 * 60 * 1000;        // بعدها نوقف الإشعارات والبث للطلب
const KEEP = 90 * 24 * 60 * 60 * 1000;      // سجل التحليلات يبقى 90 يوم
const REMIND_AFTER = 10 * 60 * 1000;        // تذكير التقييم بعد 10 دقايق من الاستلام
const STATUSES = ["waiting", "ready", "done"];
const TAGS = ["سريع", "لذيذ", "تعامل راقي", "تأخر", "الطلب غلط"];

/* ---------- الإعدادات (روابط المنيو والخريطة وغيرها) ---------- */
function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(__dirname, "settings.json"), "utf8")); } catch (e) {}
  const env = { brand: "BRAND", menu: "LINK_MENU", maps: "LINK_MAPS", review: "LINK_REVIEW", website: "LINK_WEBSITE",
    instagram: "LINK_INSTAGRAM", tiktok: "LINK_TIKTOK", x: "LINK_X", snapchat: "LINK_SNAPCHAT" };
  for (const [k, v] of Object.entries(env)) if (process.env[v]) s[k] = process.env[v];
  const okURL = v => typeof v === "string" && (/^https:\/\//.test(v) || /^\/promos\/[\w.-]+$/.test(v));
  for (const k of Object.keys(s)) if (!["brand", "promos"].includes(k) && s[k] && !okURL(s[k])) delete s[k];
  if (process.env.BACKGROUND) s.background = process.env.BACKGROUND;
  s.promos = (Array.isArray(s.promos) ? s.promos : []).filter(p => p && typeof p.title === "string").slice(0, 6)
    .map(p => ({ title: p.title.slice(0, 40), sub: typeof p.sub === "string" ? p.sub.slice(0, 60) : "", image: okURL(p.image) ? p.image : "", link: okURL(p.link) ? p.link : "" }));
  return { brand: s.brand || "مزهرية", ...s, tags: TAGS };
}
const SETTINGS = loadSettings();

/* ---------- الطلبات ---------- */
// token -> { num, status, created, scannedAt, readyAt, alerted, comingAt, doneAt, stars, tags, mapsAt, reminded, subs, listeners }
const orders = new Map();

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const r of list) orders.set(r.t, { ...r, t: undefined, listeners: new Set(), subs: r.subs || [] });
    console.log("loaded", orders.size, "orders");
  } catch (e) {}
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const list = [];
    for (const [t, o] of orders) {
      if (o.num == null) continue;
      const { listeners, ...rest } = o;
      list.push({ ...rest, t });
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(list));
      fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
    } catch (e) { console.error("save failed", e.message); }
  }, 2000);
}

function get(token, create) {
  let o = orders.get(token);
  if (!o && create) {
    o = { num: null, status: "waiting", created: Date.now(), at: Date.now(), listeners: new Set(), subs: [] };
    orders.set(token, o);
  }
  return o;
}
// متوسط وقت التحضير آخر 7 أيام (يتحدث كل 5 دقايق) — للتقدير عند العميل
let etaCache = { at: 0, v: null };
function eta() {
  if (Date.now() - etaCache.at < 300000) return etaCache.v;
  const from = Date.now() - 7 * 86400000;
  const a = [...orders.values()].filter(o => o.num != null && o.readyAt && o.created >= from).map(o => o.readyAt - o.created).filter(x => x > 30000 && x < 3600000);
  etaCache = { at: Date.now(), v: a.length >= 3 ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null };
  return etaCache.v;
}
const view = o => ({
  status: o.status, num: o.num, created: o.created, readyAt: o.readyAt || null, eta: eta(),
  comingAt: o.comingAt || null, rated: o.stars != null, now: Date.now(),
});
const brief = (t, o) => ({ t, num: o.num, status: o.status, scanned: !!o.scannedAt, coming: !!o.comingAt, stars: o.stars ?? null });

/* ---------- أدوات ---------- */
function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req, max, cb) {
  let body = "";
  req.on("data", c => { body += c; if (body.length > max) req.destroy(); });
  req.on("end", () => { let d; try { d = JSON.parse(body); } catch { d = null; } cb(d, body); });
}
function sse(req, res, first, set) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  set.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { clearInterval(ping); set.delete(res); });
}
const send = (set, data) => { const m = `data: ${JSON.stringify(data)}\n\n`; for (const l of set) l.write(m); };

// شاشة الكاشير وشاشة العميل (الباركود) يسمعون للتحديثات
const cashiers = new Set();
const displays = new Set();
let display = null; // { t, num, at }

function changed(t, o) {
  send(o.listeners, view(o));
  send(cashiers, brief(t, o));
  save();
}
function setDisplay(d) {
  display = d;
  send(displays, display || { idle: true });
}

async function notify(o, token, payload) {
  if (!o.subs.length) return 0;
  const keep = [];
  let ok = 0;
  await Promise.all(o.subs.map(async s => {
    try {
      const code = await push.send(s, JSON.stringify(payload));
      if (code < 300) ok++;
      if (code !== 404 && code !== 410) keep.push(s);
    } catch (e) { keep.push(s); console.error("push failed", e.message); }
  }));
  o.subs = keep;
  return ok;
}
const readyPush = (o, t) => ({
  title: `${SETTINGS.brand} · طلبك جاهز ✨`,
  body: `طلبك رقم ${o.num ?? ""} جاهز، تفضّل استلمه من الكاشير`,
  tag: "order-" + t, url: `/?o=${o.num ?? ""}&t=${t}`,
});

/* ---------- التحليلات ---------- */
function stats(days) {
  const now = Date.now(), from = now - days * 86400000;
  const list = [...orders.values()].filter(o => o.num != null && o.created >= from);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const ready = list.filter(o => o.readyAt);
  const scannedReady = ready.filter(o => o.scannedAt);
  const picked = list.filter(o => o.readyAt && (o.comingAt || o.doneAt));
  const rated = list.filter(o => o.stars != null);
  const tags = {};
  for (const o of rated) for (const t of o.tags || []) tags[t] = (tags[t] || 0) + 1;

  // الطلبات اليومية بتوقيت الرياض
  const day = ts => new Date(ts + 3 * 3600000).toISOString().slice(0, 10);
  const daily = {};
  for (let i = days - 1; i >= 0; i--) daily[day(now - i * 86400000)] = 0;
  for (const o of list) { const d = day(o.created); if (d in daily) daily[d]++; }
  const hours = Array(24).fill(0);
  for (const o of list) hours[new Date(o.created + 3 * 3600000).getUTCHours()]++;

  return {
    days,
    orders: list.length,
    scanRate: list.length ? list.filter(o => o.scannedAt).length / list.length : null,
    avgPrep: avg(ready.map(o => o.readyAt - o.created)),
    alertRate: scannedReady.length ? scannedReady.filter(o => o.alerted).length / scannedReady.length : null,
    avgPickup: avg(picked.map(o => Math.min(o.comingAt || Infinity, o.doneAt || Infinity) - o.readyAt).filter(x => x >= 0 && x < 3600000)),
    avgStars: avg(rated.map(o => o.stars)),
    ratings: rated.length,
    mapsClicks: list.filter(o => o.mapsAt).length,
    tags,
    daily: Object.entries(daily).map(([d, n]) => ({ d, n })),
    hours,
  };
}

/* ---------- الملفات ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
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
    name: isOrder ? `${SETTINGS.brand} · طلب ${o}` : `${SETTINGS.brand} · البيجر`,
    short_name: isOrder ? `طلب ${o}` : "البيجر",
    start_url: isOrder ? `/?o=${encodeURIComponent(o)}&t=${t}` : "/",
    scope: "/", display: "standalone", background_color: "#F4EDE2", theme_color: "#F4EDE2", dir: "rtl", lang: "ar",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

/* ---------- السيرفر ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/health") return json(res, 200, { ok: true });
  if (p === "/api/vapid") return json(res, 200, { key: push.publicKey });
  if (p === "/api/settings") return json(res, 200, SETTINGS);
  if (p === "/api/stats") return json(res, 200, stats(Math.min(90, Math.max(1, parseInt(url.searchParams.get("days")) || 7))));
  if (p === "/manifest.webmanifest") {
    res.writeHead(200, { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(manifest(url)));
  }

  // الكاشير يسمع: مسح الكود، العميل جاي، التقييم
  if (p === "/api/live" && req.method === "GET") {
    const ts = (url.searchParams.get("t") || "").split(",").filter(t => TOKEN_RE.test(t)).slice(0, 100);
    const first = ts.map(t => orders.get(t) && brief(t, orders.get(t))).filter(Boolean);
    return sse(req, res, { list: first }, cashiers);
  }

  // شاشة الباركود المقابلة للعميل
  if (p === "/api/display") {
    if (req.method === "GET") return sse(req, res, display || { idle: true }, displays);
    if (req.method === "POST") return readBody(req, 300, d => {
      if (d && TOKEN_RE.test(d.t) && Number.isInteger(d.num)) setDisplay({ t: d.t, num: d.num, at: Date.now() });
      else setDisplay(null);
      json(res, 200, { ok: true });
    });
  }

  const m = p.match(/^\/api\/o\/([^/]+)(\/events|\/sub|\/coming|\/rate|\/maps)?$/);
  if (m) {
    const token = m[1];
    if (!TOKEN_RE.test(token)) return json(res, 400, { error: "bad token" });
    const action = m[2];

    // الكاشير يغيّر الحالة: {status, num, created}
    if (!action && req.method === "POST") {
      return readBody(req, 300, (d, raw) => {
        d = d || { status: raw.trim() };
        if (!STATUSES.includes(d.status)) return json(res, 400, { error: "bad status" });
        const o = get(token, true);
        if (Number.isInteger(d.num) && d.num > 0 && d.num < 10000) o.num = d.num;
        if (Number.isFinite(d.created) && Math.abs(Date.now() - d.created) < LIVE_TTL) o.created = d.created;
        const was = o.status;
        o.status = d.status; o.at = Date.now();
        if (d.status === "ready" && was !== "ready") {
          o.readyAt = Date.now();
          const live = o.listeners.size > 0;
          o.alerted = live;
          notify(o, token, readyPush(o, token)).then(n => { if (n && !o.alerted) { o.alerted = true; save(); } });
        }
        if (d.status === "waiting") o.readyAt = null;
        if (d.status === "done" && !o.doneAt) o.doneAt = Date.now();
        if (display && display.t === token && d.status !== "waiting") setDisplay(null);
        changed(token, o);
        json(res, 200, { ok: true });
      });
    }

    // لو السيرفر أعاد التشغيل وانمسح الطلب، صفحة العميل تبقى شغالة وتستنى
    const o = get(token, req.method === "GET");
    if (!o) return json(res, 404, { error: "not found" });

    // بث مباشر للعميل (أول ما يفتح الصفحة = مسح الكود)
    if (action === "/events" && req.method === "GET") {
      if (!o.scannedAt) {
        o.scannedAt = Date.now();
        if (display && display.t === token) setDisplay(null);
        changed(token, o);
      }
      return sse(req, res, view(o), o.listeners);
    }

    if (action === "/sub" && req.method === "POST") {
      return readBody(req, 4000, s => {
        if (!s || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return json(res, 400, { error: "bad subscription" });
        if (!o.subs.some(x => x.endpoint === s.endpoint)) o.subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
        if (o.subs.length > 5) o.subs.shift();
        save();
        json(res, 200, { ok: true });
        if (o.status === "ready") notify(o, token, readyPush(o, token));
      });
    }

    // العميل ضغط «جاي»
    if (action === "/coming" && req.method === "POST") {
      if (!o.comingAt && o.status === "ready") { o.comingAt = Date.now(); o.alerted = true; changed(token, o); }
      return json(res, 200, { ok: true });
    }

    // التقييم: {stars, tags}
    if (action === "/rate" && req.method === "POST") {
      return readBody(req, 500, d => {
        if (o.stars != null) return json(res, 409, { error: "already rated" });
        const stars = d && d.stars;
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json(res, 400, { error: "bad stars" });
        o.stars = stars;
        o.tags = Array.isArray(d.tags) ? d.tags.filter(t => TAGS.includes(t)).slice(0, 5) : [];
        o.ratedAt = Date.now();
        changed(token, o);
        json(res, 200, { ok: true });
      });
    }

    // العميل فتح رابط قوقل ماب
    if (action === "/maps" && req.method === "POST") {
      if (!o.mapsAt) { o.mapsAt = Date.now(); save(); }
      return json(res, 200, { ok: true });
    }

    if (!action && req.method === "GET") return json(res, 200, view(o));
    return json(res, 405, { error: "method" });
  }

  if (req.method === "GET") {
    if (p === "/sw.js") return file(res, "sw.js", "no-cache");
    if (/^\/[a-z0-9-]+\.png$/.test(p) && file(res, p.slice(1))) return;
    if (/^\/promos\/[\w.-]+\.(jpe?g|png|webp)$/i.test(p)) { if (file(res, p.slice(1))) return; return json(res, 404, { error: "not found" }); }
    return file(res, "index.html", "no-cache");
  }
  json(res, 404, { error: "not found" });
});

// كل دقيقة: تذكير التقييم + تنظيف
setInterval(() => {
  const now = Date.now();
  for (const [t, o] of orders) {
    if (o.doneAt && o.stars == null && !o.reminded && o.subs.length && now - o.doneAt > REMIND_AFTER && now - o.doneAt < LIVE_TTL) {
      o.reminded = true; save();
      notify(o, t, {
        title: "لا تنسى تقيّم ⭐",
        body: `وش رأيك بطلبك من ${SETTINGS.brand}؟ تقييمك ياخذ ثانية`,
        tag: "rate-" + t, url: `/?o=${o.num ?? ""}&t=${t}`,
      });
    }
    if (now - o.created > LIVE_TTL && o.subs.length && (o.stars != null || o.reminded || !o.doneAt)) { o.subs = []; save(); }
    if (now - o.created > KEEP || (o.num == null && now - o.created > LIVE_TTL)) orders.delete(t);
  }
}, 60 * 1000);

load();
server.listen(PORT, () => console.log("Mazhariya pager on :" + PORT));
