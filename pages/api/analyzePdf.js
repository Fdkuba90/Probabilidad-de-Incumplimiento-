import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";

export const config = { api: { bodyParser: false } };

// Parámetros
const PUNTOS_BASE = 285;
const DEFAULT_UDI = 8.1462; // se sobreescribe desde el front

// -----------------------------
// Helpers de puntuación y PI
// -----------------------------
function puntuar(val) {
  const pts = {};

  // 1 – # créditos bancarios 12m
  pts[1] = val[1] === 0 ? 62 : val[1] <= 3 ? 50 : val[1] <= 7 ? 41 : 16;

  // 6 – % pagos en tiempo NO bancarias
  if (val[6] === "--" || val[6] == null) pts[6] = 52;
  else pts[6] = val[6] >= 0.93 ? 71 : val[6] >= 0.81 ? 54 : 17;

  // 9 – % mora bancaria ≥60 días
  pts[9] = Number(val[9]) === 0 ? 54 : -19;

  // 11 – % mora comercial ≥60 días
  if (val[11] === "--" || val[11] == null) pts[11] = 55;
  else pts[11] = Number(val[11]) === 0 ? 57 : 30;

  // 14 – Quitas/Castigos/Reestructuras (0/1)
  pts[14] = Number(val[14]) === 0 ? 55 : -29;

  // 15 – Monto máx. crédito en UDIS (el Buró da pesos → convertimos a UDIS)
  const udis = Number(val._udis) || 0;
  pts[15] = udis >= 1_000_000 ? 112 : 52;

  // 16 – Antigüedad en SIC (meses)
  const m = Number(val[16]) || 0;
  pts[16] = m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67;

  // 17 – Meses desde el último crédito
  const mLast = Number(val[17]) || 0;
  pts[17] = mLast > 0 && mLast <= 6 ? 46 : 58; // (0,6] → 46; ≥6 o "--" → 58

  const puntajeTotal = PUNTOS_BASE + Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, puntajeTotal };
}

function calcularPI(score) {
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}

// -----------------------------
// Helpers robustos para “Resumen Créditos Activos”
// -----------------------------
function sliceBetween(txt, fromReList, toReList) {
  // prueba varios “from” hasta encontrar uno
  let fromIdx = -1;
  for (const re of fromReList) {
    const i = txt.search(re);
    if (i !== -1) { fromIdx = i; break; }
  }
  if (fromIdx === -1) return "";

  const rest = txt.slice(fromIdx);

  // corta en el primer “to” que aparezca
  let endIdx = -1;
  for (const re of toReList) {
    const j = rest.search(re);
    if (j !== -1) { endIdx = j; break; }
  }
  return endIdx === -1 ? rest : rest.slice(0, endIdx);
}

// extrae números (con miles) de una ventana
function pickNumbers(str) {
  return (str.match(/[\d]+(?:[.,][\d]+)*/g) || []);
}

function toPesosMiles(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 1000); // miles de pesos → pesos
}

/**
 * Lee la fila "Totales:" del bloque "Resumen Créditos Activos".
 * Si no la encuentra dentro del bloque, hace un fallback global buscando "Totales:" en todo el texto.
 * Mapea posiciones estándar:
 *   idx 4 → Original
 *   idx 5 → Saldo Actual
 *   idx 6 → Vigente
 */
function parseResumenActivosRobusto(text) {
  const fromReList = [
    /Resumen\s*(de)?\s*Cr[eé]ditos?\s+Activos?/i,
    /Resumen\s+Cr[eé]ditos?\s+Activos?/i,
    /Cr[eé]ditos?\s+Activos?.*Resumen/i
  ];
  const toReList = [
    /(Cr[eé]ditos?\s+Liquidados?)/i,
    /(Resumen\s+Cr[eé]ditos?\s+Liquidados?)/i,
    /(Historia)/i,
    /(INFORMACI[ÓO]N\s+COMERCIAL)/i,
    /(DECLARATIVAS)/i
  ];

  let bloque = sliceBetween(text, fromReList, toReList);
  let windowStr = "";
  let idx = bloque.search(/Totales\s*:/i);

  if (idx !== -1) {
    windowStr = bloque.slice(idx, idx + 800);
  } else {
    // Fallback global: busca un "Totales:" cerca de “Original / Saldo Actual / Vigente”
    const globalIdx = text.search(/Totales\s*:/i);
    if (globalIdx !== -1) {
      windowStr = text.slice(globalIdx, globalIdx + 800);
    } else {
      // último recurso: no se encontró “Totales:”
      return {
        totalOriginalPesos: null,
        totalSaldoActualPesos: null,
        totalVigentePesos: null,
        totalVencidoPesos: null
      };
    }
  }

  const nums = pickNumbers(windowStr);
  // posiciones típicas observadas en los reportes del Buró:
  const orig = nums[4], saldo = nums[5], vig = nums[6];

  const totalOriginalPesos    = toPesosMiles(orig);
  const totalSaldoActualPesos = toPesosMiles(saldo);
  const totalVigentePesos     = toPesosMiles(vig);

  let totalVencidoPesos = null;
  if (typeof totalSaldoActualPesos === "number" && typeof totalVigentePesos === "number") {
    totalVencidoPesos = Math.max(0, totalSaldoActualPesos - totalVigentePesos);
  }

  return { totalOriginalPesos, totalSaldoActualPesos, totalVigentePesos, totalVencidoPesos };
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

    // Extraer Califica (IDs/valores del bloque "Califica")
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
    const udisMax  = pesosMax > 0 ? pesosMax / udi : 0;
    valores._udis  = Math.round(udisMax);

    // Puntos y PI
    const { pts, puntajeTotal } = puntuar(valores);
    const pi = calcularPI(puntajeTotal);

    // Resumen Créditos Activos (robusto)
    const {
      totalOriginalPesos,
      totalSaldoActualPesos,
      totalVigentePesos,
      totalVencidoPesos,
    } = parseResumenActivosRobusto(text);

    // Mapa de códigos por ID (útil para el front)
    const codigos = {};
    indicadores.forEach((x) => (codigos[Number(x.id)] = x.codigo));

    return res.status(200).json({
      meta: { pages: parsed?.numpages || null },
      calificaRaw,
      indicadores,
      codigos,
      valores,                       // incluye _udis (UDIS de ID 15)
      puntos: pts,
      puntajeTotal,
      probabilidadIncumplimiento: `${(pi * 100).toFixed(2)}%`,
      summary: {
        totalOriginalPesos,          // "Original" (miles → pesos)
        totalSaldoActualPesos,       // "Saldo Actual"
        totalVigentePesos,           // "Vigente"
        totalVencidoPesos,           // SaldoActual - Vigente
        maxCreditPesos: pesosMax,    // ID 15 en pesos (por si lo quieres usar)
      },
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    return res.status(500).json({ error: e?.message || "Error procesando el PDF" });
  }
}
