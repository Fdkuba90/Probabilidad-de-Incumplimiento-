// pages/api/login.js
export default function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  const { password } = req.body || {};
  const PASS = process.env.APP_PASSWORD || "";
  const TOKEN = process.env.APP_AUTH_TOKEN || "";

  if (!PASS || !TOKEN) {
    return res.status(500).json({ error: "Auth no configurado en el servidor" });
  }
  if (password !== PASS) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  const isProd = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  const cookie = [
    `auth=${encodeURIComponent(TOKEN)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 7}`, // 7 días
    isProd ? "Secure" : "",
  ].filter(Boolean).join("; ");

  res.setHeader("Set-Cookie", cookie);
  res.status(204).end();
}
