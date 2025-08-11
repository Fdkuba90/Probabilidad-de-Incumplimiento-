import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";

export const config = { api: { bodyParser: false } };

// Parámetros
const PUNTOS_BASE = 285;
const DEFAULT_UDI = 8.1462; // puedes sobreescribirlo desde el front (campo "udi")

// -----------------------------
// Helpers de puntuación y PI
// -----------------------------
function puntuar(val) {
  const pts = {};

  // 1 – # créditos bancarios 12m
  pts[1] = val[1] === 0 ? 62 : val[1] <= 3 ? 50 : val[1] <= 7 ? 41 : 16;

  // 6 – % pagos en tiempo no bancarias
  if (val[6] === "--" || val[6] == null) pts[6] = 52;
  else pts[6] = val[6] >= 0.93 ? 71 : val[6] >= 0.81 ? 54 : 17;

  // 9 – % mora bancaria ≥60 días (0 ó >0)
  pts[9] = Number(val[9]) === 0 ? 54 : -19;

  // 11 – % mora comercial ≥60 días
  if (val[11] === "--" || val[11] == null) pts[11] = 55;
  else pts[11] = Number(val[11]) === 0 ? 57 : 30;

  // 14 – Quitas/Castigos/Reestructuras (0/1)
  pts[14] = Number(val[14]) === 0 ? 55 : -29;

  // 15 – Monto máx. crédito en UDIS
  const udis = Number(val._udis) || 0;
  pts[15] = udis >= 1_000_000 ? 112 : 52;

  // 16 – Antigüedad en SIC (meses)
  const m = Number(val[16]) || 0;
  pts[16] = m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67;

  // 17 – Meses desde el último crédito
  const mLast = Number(val[17]) || 0;
  pts[17] = mLast > 0 && mLast <= 6 ? 46 : 58; // (0,6] → 46; ≥6 → 58; "--" → 58

  const puntajeTotal = PUNTOS_BASE + Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, puntajeTotal };
}

function calcularPI(score) {
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}

// -----------------------------
// Helpers para “Resumen Créditos Activos”
// -----------------------------
function sliceBetween(txt, fromRe, toRe) {
  const fromIdx = txt.search(fromRe);
  if (fromIdx === -1) return "";
  const rest = txt.slice(fromIdx);
  const toMatch = rest.search(toRe);
  return toMatch === -1 ? rest : rest.slice(0, toMatch);
}

function parseResumenActivos(text) {
  // recorta desde "Resumen Créditos Activos" hasta el siguiente bloque
  const bloque = sliceBetween(
    text,
    /Resumen\s+Créditos\s+Activos/i,
    /(Créditos\s+Liquidados|Resumen\s+Créditos\s+Liquidados|Historia|INFORMACI[ÓO]N\s+COMERCIAL|DECLARATIVAS)/i
  );

  // línea con "Totales:"
  const matchLine = (bloque.match(/.*Totales:.*$/gmi) || [])[0] || "";
  if (!matchLine) return { totalOriginalPesos: null, totalVigentePesos: null, totalVencidoPesos: null };

  // Montos están en miles de pesos
  const toPesos = (v) => Math.round(parseFloat(String(v).replace(/,/g, "")) * 1000);
  const nums = matchLine.match(/[\d,.]+/g) || [];

  const totalOriginalPesos = nums[0] ? toPesos(nums[0]) : null;
  const totalVigentePesos  = nums[1] ? toPesos(nums[1]) : null;

  // Las 6 columnas siguientes suelen ser los vencidos (1-29, 30-59, 60-89, 90-119, 120-179, 180+)
  let totalVencidoPesos = 0;
  for (let i = 2; i < Math.min(nums.length, 8); i++) totalVencidoPesos += toPesos(nums[i]);

  return { totalOriginalPesos, totalVigentePesos, totalVencidoPesos };
}

// -----------------------------
// Handler principal
// -----------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    // Leer archivo (form-data)
    const form = formidable();
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const file = files?.file?.[0] || files?.file;
    if (!file?.filepath) return res.status(400).send("No se recibió archivo");

    const buffer = await readFile(file.filepath);
    const parsed = await pdfParse(buffer);
    const text = parsed?.text || "";

    // Extraer Califica
    const { indicadores, calificaRaw } = parseCalificaFromText(text);

    // Normalizar a diccionario { id: valor }
    const valores = {};
    for (const it of indicadores) {
      const raw = String(it.valor).trim();
      valores[Number(it.id)] = raw === "--" ? "--" : Number(raw.replace(/,/g, ""));
    }

    // ID 15: pesos → UDIS
    const udi = Number(fields?.udi) || DEFAULT_UDI;
    const pesosMax = Number(valores[15] || 0); // en pesos (del Buró)
    const udisMax = pesosMax > 0 ? pesosMax / udi : 0;
    valores._udis = Math.round(udisMax);

    // Puntos y PI
    const { pts, puntajeTotal } = puntuar(valores);
    const pi = calcularPI(puntajeTotal);

    // Resumen de totales (en pesos)
    const resumen = parseResumenActivos(text);
    const summary = {
      maxCreditPesos: pesosMax,
      totalOriginalPesos: resumen.totalOriginalPesos,
      totalVigentePesos: resumen.totalVigentePesos,
      totalVencidoPesos: resumen.totalVencidoPesos,
    };

    // Mapa de códigos por ID (útil para el front)
    const codigos = {};
    indicadores.forEach((x) => (codigos[Number(x.id)] = x.codigo));

    return res.status(200).json({
      meta: { pages: parsed?.numpages || null },
      calificaRaw,
      indicadores,
      codigos,
      valores,                 // incluye _udis (UDIS de ID 15)
      puntos: pts,
      puntajeTotal,
      probabilidadIncumplimiento: `${(pi * 100).toFixed(2)}%`,
      summary,                 // montos en pesos
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    return res.status(500).json({ error: e?.message || "Error procesando el PDF" });
  }
}
