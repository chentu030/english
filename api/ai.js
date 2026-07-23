/** Proxied Vertex generateContent — keys stay on the server. */
const { parseKeysFromEnv, requireUser, setNoStore } = require("./_auth");

const g = globalThis;
if (typeof g.__beidanziKeyIdx !== "number") g.__beidanziKeyIdx = 0;

module.exports = async (req, res) => {
  setNoStore(res);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireUser(req, res, { rateMax: 90 });
  if (!user) return;

  const keys = parseKeysFromEnv();
  if (!keys.length) {
    return res.status(503).json({ error: "伺服器尚未設定 Vertex API 金鑰" });
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ error: "無效的 JSON" });
    }
  }
  const model = String((payload && payload.model) || "gemini-3-flash-preview").trim();
  const body = payload && payload.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "缺少 body" });
  }
  if (!model || model.length > 120 || /[^\w.\-:]/.test(model)) {
    return res.status(400).json({ error: "無效的 model" });
  }

  let lastErr = "未知錯誤";
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = g.__beidanziKeyIdx % keys.length;
    const key = keys[idx];
    g.__beidanziKeyIdx = (g.__beidanziKeyIdx + 1) % keys.length;
    try {
      const url = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${encodeURIComponent(
        model
      )}:generateContent`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
        },
        body: JSON.stringify(body),
      });
      const data = await upstream.json().catch(() => ({}));
      if (upstream.ok) {
        return res.status(200).json(data);
      }
      lastErr = (data && data.error && data.error.message) || `上游錯誤 (${upstream.status})`;
      if (![429, 500, 502, 503, 504].includes(upstream.status)) {
        return res.status(upstream.status).json({ error: lastErr, upstream: data });
      }
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return res.status(502).json({ error: `所有金鑰皆失敗：${lastErr}` });
};
