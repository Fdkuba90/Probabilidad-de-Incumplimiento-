// pages/api/analyzePdf.js
export const config = {
  api: { bodyParser: false },
};

export default function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "OPTIONS, POST");
    return res.status(200).json({ ok: true, method: "OPTIONS" });
  }

  if (req.method === "POST") {
    return res.status(200).json({ ok: true, message: "PDF recibido correctamente" });
  }

  res.setHeader("Allow", "OPTIONS, POST");
  return res.status(405).json({ error: "Método no permitido", method: req.method });
}
