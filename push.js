// إرسال إشعارات Web Push بدون مكتبات خارجية (RFC 8291 + VAPID RFC 8292)
const crypto = require("crypto");

const b64u = buf => Buffer.from(buf).toString("base64url");
const unb64u = s => Buffer.from(s, "base64url");

// مفاتيح VAPID: من متغيرات البيئة إن وُجدت، وإلا تُنشأ عند التشغيل
function loadKeys() {
  const pub = process.env.VAPID_PUBLIC, priv = process.env.VAPID_PRIVATE;
  if (pub && priv) {
    const raw = unb64u(pub);
    const key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: priv, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: "jwk" });
    return { publicKey: pub, privateKey: key };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: b64u(raw), privateKey };
}
const KEYS = loadKeys();

function vapidJWT(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:pager@mzhria.app" }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign("sha256", Buffer.from(data), { key: KEYS.privateKey, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64u(sig)}`;
}

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function encrypt(sub, plaintext) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);

  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

async function send(sub, payload) {
  const body = encrypt(sub, payload);
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: "high",
      Authorization: `vapid t=${vapidJWT(sub.endpoint)}, k=${KEYS.publicKey}`,
    },
    body,
  });
  if (r.status >= 400) console.error("push status", r.status, await r.text().catch(() => ""));
  return r.status;
}

module.exports = { send, encrypt, publicKey: KEYS.publicKey, _keys: KEYS };
