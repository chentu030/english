/** Shared auth + keys helpers for Vercel serverless routes (背單字). */

const FIREBASE_WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY ||
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
  "AIzaSyD9mwoyTf1cAS7LTnVMy5lnfFEYW5mYBoY";

const g = globalThis;
if (!g.__beidanziRate) g.__beidanziRate = new Map();

function parseKeysFromEnv() {
  const raw =
    process.env.GEMINI_API_KEYS ||
    process.env.VERTEX_API_KEYS ||
    [
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
      process.env.GEMINI_API_KEY,
    ]
      .filter(Boolean)
      .join(",") ||
    "";
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function verifyFirebaseIdToken(idToken) {
  const token = String(idToken || "").trim();
  if (!token) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const u = data.users && data.users[0];
    if (!u || !u.localId) return null;
    return { uid: u.localId, email: u.email || "" };
  } catch {
    return null;
  }
}

function checkRateLimit(uid, maxPerMin = 60) {
  const now = Date.now();
  const m = g.__beidanziRate;
  const arr = (m.get(uid) || []).filter((t) => now - t < 60_000);
  if (arr.length >= maxPerMin) {
    m.set(uid, arr);
    return false;
  }
  arr.push(now);
  m.set(uid, arr);
  return true;
}

/**
 * Require Bearer Firebase ID token. Sends JSON error and returns null on failure.
 */
async function requireUser(req, res, { rateMax = 60 } = {}) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!idToken) {
    res.status(401).json({ error: "請先登入後再使用" });
    return null;
  }
  const user = await verifyFirebaseIdToken(idToken);
  if (!user) {
    res.status(401).json({ error: "登入已過期，請重新登入" });
    return null;
  }
  if (!checkRateLimit(user.uid, rateMax)) {
    res.status(429).json({ error: "請求過於頻繁，請稍候再試" });
    return null;
  }
  return user;
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

module.exports = {
  parseKeysFromEnv,
  verifyFirebaseIdToken,
  requireUser,
  checkRateLimit,
  setNoStore,
};
