import formidable from "formidable";
import pdfParse from "pdf-parse";
import { parseCalificaFromText } from "../../lib/parseCalifica";
import os from "os";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "50mb",
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const { files } = await new Promise((resolve, reject) => {
      const form = formidable({
        multiples: false,
        maxFileSize: 50 * 1024 * 1024,
        uploadDir: os.tmpdir(),         // <= Vercel: guardar en /tmp
        keepExtensions: true,
        filter: ({ mimetype }) =>
          mimetype === "application/pdf" || mimetype === "application/x-pdf",
      });
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    });

    // `files.file` puede venir como arreglo en Vercel
    const f = Array.isArray(files?.file) ? files.file[0] : files?.file;
    const filepath = f?.filepath || f?.filepath?.[0];

    if (!filepath) {
      return res.status(400).send("No se pudo recibir/guardar el PDF en el servidor.");
    }

    const buffer = fs.readFileSync(filepath);
    const parsed = await pdfParse(buffer);
    const text = parsed?.text || "";

    const { calificaRaw, indicadores } = parseCalificaFromText(text);

    return res.status(200).json({
      meta: { numpages: parsed?.numpages || null, info: parsed?.info || {} },
      calificaRaw,
      indicadores,
    });
  } catch (err) {
    console.error("analyzePdf error:", err);
    return res.status(500).send(err?.message || "Error procesando el PDF");
  }
}
