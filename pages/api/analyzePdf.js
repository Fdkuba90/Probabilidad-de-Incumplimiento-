import formidable from "formidable";
import pdfParse from "pdf-parse";
import { parseCalificaFromText } from "../../lib/parseCalifica";

export const config = {
  api: {
    bodyParser: false // MUY IMPORTANTE: desactivar para usar formidable
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const { files } = await new Promise((resolve, reject) => {
      const form = formidable({ multiples: false, maxFileSize: 50 * 1024 * 1024 });
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    });

    const file = files?.file;
    if (!file) return res.status(400).send("No se recibió archivo bajo el campo 'file'.");

    const fs = await import("fs");
    const buffer = fs.default.readFileSync(file.filepath);

    const parsed = await pdfParse(buffer);
    const text = parsed?.text || "";

    const { calificaRaw, indicadores } = parseCalificaFromText(text);

    return res.status(200).json({
      meta: { numpages: parsed?.numpages || null, info: parsed?.info || {} },
      calificaRaw,
      indicadores
    });
  } catch (err) {
    console.error("analyzePdf error:", err);
    return res.status(500).send(err?.message || "Error procesando el PDF");
  }
}