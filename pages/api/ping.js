export const config = {
  api: { bodyParser: true },
};

export default function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "OPTIONS, POST");
    return res.status(200).json({ ok: true, method: "OPTIONS", route: "/api/ping" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "OPTIONS, POST");
    return res.status(200).json({ ok: true, method: req.method, info: "Usa POST para probar", route: "/api/ping" });
  }
  return res.status(200).json({ ok: true, method: "POST", route: "/api/ping" });
}
