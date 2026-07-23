/** Status of server Vertex keys — never returns raw key material. */
const { parseKeysFromEnv, requireUser, setNoStore } = require("./_auth");

module.exports = async (req, res) => {
  setNoStore(res);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireUser(req, res, { rateMax: 30 });
  if (!user) return;

  const keys = parseKeysFromEnv();
  return res.status(200).json({
    configured: keys.length > 0,
    count: keys.length,
    // Back-compat: empty array so old clients cannot harvest keys
    keys: [],
  });
};
