import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";

export const config = {
  api: { bodyParser: false }, // necesario para formidable
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "OPTIONS, POST");
    return res.status(200).json({ ok: true, method: "OPTIONS" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "OPTIONS, POST");
    return res.status(405).json({ error: "Método no permitido", method: req.method });
  }

  try {
    const form = formidable();
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => {
        if (err) reject(err);
        else resolve({ fields: flds, files: fls });
      });
    });

    const file = files?.file?.[0] || files?.file;
    if (!file?.filepath) return res.status(400).json({ error: "No se recibió archivo" });

    const buffer = await readFile(file.filepath);
    const parsed = await pdfParse(buffer);

    // simplificado: solo devuelve texto del PDF y UDI
    return res.status(200).json({
      ok: true,
      udi: fields?.udi,
      pages: parsed.numpages,
      textSample: parsed.text.slice(0, 500), // primeros 500 caracteres
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    return res.status(500).json({ error: e?.message || "Error procesando el PDF" });
  }
}
