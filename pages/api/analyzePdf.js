// pages/api/analyzePdf.js
import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";

export const config = { api: { bodyParser: false } };

const PUNTOS_BASE = 285;
const DEFAULT_UDI = 8.1462; // puedes cambiarlo desde el front (campo "udi")

function puntuar(val) {
  const pts = {};

  // ID 1 – # créditos bancarios 12m
  pts[1] = val[1] === 0 ? 62 : val[1] <= 3 ? 50 : val[1] <= 7 ? 41 : 16;

  // ID 6 – % pagos en tiempo no bancarias
  if (val[6] === "--" || val[6] == null) pts[6] = 52;
  else pts[6] = val[6] >= 0.93 ? 71 : val[6] >= 0.81 ? 54 : 17;

  // ID 9 – % mora bancaria ≥60 días (0 ó >0)
  pts[9] = Number(val[9]) === 0 ? 54 : -19;

  // ID 11 – % mora comercial ≥60 días
  if (val[11] === "--" || val[11] == null) pts[11] = 55;
  else pts[11] = Number(val[11]) === 0 ? 57 : 30;

  // ID 14 – Quitas/Castigos/Reestructuras (0/1)
  pts[14] = Number(val[14]) === 0 ? 55 : -29;

  // ID 15 – Monto máx. crédito en UDIS
  const udis = Number(val._udis) || 0;
  pts[15] = udis >= 1_000_000 ? 112 : 52;

  // ID 16 – Antigüedad en SIC (meses)
  const m = Number(val[16]) || 0;
  pts[16] = m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67;

  // ID 17 – Meses desde el último crédito
  const mLast = Number(val[17]) || 0;
  pts[17] = mLast > 0 && mLast <= 6 ? 46 : 58; // (0,6] → 46; ≥6 → 58; "--" → 58

  const puntajeTotal = PUNTOS_BASE + Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, puntajeTotal };
}

function calcularPI(score) {
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const form = formidable();
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const file = files?.file?.[0] || files?.file;
    if (!file?.filepath) return res.status(400).send("No se recibió archivo");

    const buf = await readFile(file.filepath);
    const parsed = await pdfParse(buf);
    const text = parsed?.text || "";

    // Extraer “Califica”
    const { indicadores, calificaRaw } = parseCalificaFromText(text);

    // Normalizar a diccionario {id: valor}
    const valores = {};
    for (const it of indicadores) {
      const raw = String(it.valor).trim();
      valores[Number(it.id)] = raw === "--" ? "--" : Number(raw.replace(/,/g, ""));
    }

    // ID 15: pesos → UDIS
    const udi = Number(fields?.udi) || DEFAULT_UDI;
    const pesosMax = Number(valores[15] || 0);
    const udisMax = pesosMax > 0 ? pesosMax / udi : 0;
    valores._udis = Math.round(udisMax); // redondeo para mostrar

    // Calcular puntajes y PI
    const { pts, puntajeTotal } = puntuar(valores);
    const pi = calcularPI(puntajeTotal);

    res.status(200).json({
      valores,
      puntos: pts,
      puntajeTotal,
      probabilidadIncumplimiento: `${(pi * 100).toFixed(2)}%`,
      calificaRaw
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    res.status(500).json({ error: e.message || "Error procesando el PDF" });
  }
}
