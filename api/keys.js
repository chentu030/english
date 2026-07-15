// Vercel Serverless Function：把環境變數裡的 Gemini/Vertex 金鑰提供給前端
// 在 Vercel 專案設定 → Environment Variables 新增（擇一）：
//   GEMINI_API_KEYS = 金鑰1,金鑰2,金鑰3   （逗號或換行分隔）
//   或多組 GEMINI_API_KEY_1 / GEMINI_API_KEY_2 / GEMINI_API_KEY_3
module.exports = (req, res) => {
  const raw =
    process.env.GEMINI_API_KEYS ||
    process.env.VERTEX_API_KEYS ||
    [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY]
      .filter(Boolean)
      .join(',') ||
    '';
  const keys = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ keys });
};
