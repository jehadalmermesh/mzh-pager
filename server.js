// بيجر مزهرية — سيرفر مستقل بدون أي مكتبات خارجية
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PAGE = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const TOKEN_RE = /^[a-z0-9]{10,40}$/;
const TTL = 6 * 60 * 60 * 1000; // الطلب ينحذف تلقائياً بعد 6 ساعات

const orders = new Map(); // token -> { status, at, listeners:Set }

function get(token) {
  let o = orders.get(token);
  if (!o) { o = { status: "waiting", at: Date.now(), listeners: new Set() }; orders.set(token, o); }
  return o;
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/api\/o\/([^/]+)(\/events)?$/);

  if (url.pathname === "/health") return json(res, 200, { ok: true });

  if (m) {
    const token = m[1];
    if (!TOKEN_RE.test(token)) return json(res, 400, { error: "bad token" });
    const o = get(token);

    // بث مباشر للزبون
    if (m[2] && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${o.status}\n\n`);
      o.listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { clearInterval(ping); o.listeners.delete(res); });
      return;
    }

    // الكاشير يغيّر الحالة
    if (req.method === "POST") {
      let body = "";
      req.on("data", c => { body += c; if (body.length > 100) req.destroy(); });
      req.on("end", () => {
        const status = body.trim();
        if (!["waiting", "ready", "done"].includes(status)) return json(res, 400, { error: "bad status" });
        o.status = status; o.at = Date.now();
        for (const l of o.listeners) l.write(`data: ${status}\n\n`);
        json(res, 200, { ok: true });
      });
      return;
    }

    // احتياطي: سؤال عن الحالة
    if (req.method === "GET") return json(res, 200, { status: o.status });
  }

  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(PAGE);
  }
  json(res, 404, { error: "not found" });
});

// تنظيف الطلبات القديمة
setInterval(() => {
  const now = Date.now();
  for (const [t, o] of orders) if (now - o.at > TTL && o.listeners.size === 0) orders.delete(t);
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log("Mazhariya pager on :" + PORT));
