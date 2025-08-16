import formidable from "formidable";
import fs from "fs";
import path from "path";
import { parseCalifica } from "../../lib/parseCalifica.js";

// 🔹 Desactivar el bodyParser de Next.js (importante para uploads)
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: `Método ${req.method} no permitido` });
  }

  try {
    // Procesar el archivo PDF con formidable
    const form = formidable({ multiples: false, keepExtensions: true });
    form.uploadDir = path.join(process.cwd(), "/tmp");

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error("❌ Error en formidable:", err);
        return res.status(500).json({ error: "Error al procesar archivo" });
      }

      const file = files.file;
      const udi = fields.udi || null;

      if (!file) {
        return res.status(400).json({ error: "No se subió ningún archivo" });
      }

      // 📌 Aquí podrías usar parseCalifica para extraer datos del PDF
      const result = await parseCalifica(file.filepath, udi);

      return res.status(200).json({
        ok: true,
        filename: file.originalFilename,
        udi,
        result,
      });
    });
  } catch (e) {
    console.error("❌ Error general:", e);
    res.status(500).json({ error: e.message || "Error interno" });
  }
}
