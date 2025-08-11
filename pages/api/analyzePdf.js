import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";

export const config = { api: { bodyParser: false } };

const PUNTOS_BASE = 285;
const DEFAULT_UDI = 8.1462;

// ---------------- puntuación & PI ----------------
function puntuar(val) {
  const pts = {};

  pts[1]  = val[1] === 0 ? 62 : val[1] <= 3 ? 50 : val[1] <= 7 ? 41 : 16;

  if (val[6] === "--" || val[6] == null) pts[6] = 52;
  else pts[6] = val[6] >= 0.93 ? 71 : val[6] >= 0.81 ? 54 : 17;

  pts[9]  = Number(val[9]) === 0 ? 54 : -19;

  if (val[11] === "--" || val[11] == null) pts[11] = 55;
  else pts[11] = Number(val[11]) === 0 ? 57 : 30;

  pts[14] = Number(val[14]) === 0 ? 55 : -29;

  const udis = Number(val._udis) || 0;
  pts[15] = udis >= 1_000_000 ? 112 : 52;

  const m = Number(val[16]) || 0;
  pts[16] = m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67;

  const mLast = Number(val[17]) || 0;
  pts[17] = mLast > 0 && mLast <= 6 ? 46 : 58;

  const puntajeTotal = PUNTOS_BASE + Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, puntajeTotal };
}

function calcularPI(score) {
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}

// ---------------- helpers bloque “Totales” ----------------
function sliceBetween(txt, fromReList, toReList) {
  let fromIdx = -1;
  for (const re of fromReList) { const i = txt.search(re); if (i !== -1) { fromIdx = i; break; } }
  if (fromIdx === -1) return "";
  const rest = txt.slice(fromIdx);
  for (const re of toReList) { const j = rest.search(re); if (j !== -1) return rest.slice(0, j); }
  return rest;
}
const pickNumbers = (s) => (s.match(/[\d]+(?:[.,][\d]+)*/g) || []);
const toPesosMiles = (v) => {
  if (v == null) return null;
  // Quitamos comas y SI VIENE CON PUNTO COMO SEPARADOR DE MILES, también lo quitamos.
  const clean = String(v).replace(/[.,](?=\d{3}\b)/g, "").replace(/,/g, "");
  const n = parseFloat(clean);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 1000); // miles de pesos → pesos
};

/**
 * Regresa Original, Saldo Actual y Vigente desde “Totales:”
 * 1) Intenta un REGEX estructurado en la línea/ventana local
 * 2) Fallback: mapeo por índices (4,5,6) en ventana
 */
function parseResumenActivosRobusto(text) {
  const fromReList = [
    /Resumen\s*(de)?\s*Cr[eé]ditos?\s+Activos?/i,
    /Cr[eé]ditos?\s+Activos?.*Resumen/i,
    /Cr[eé]ditos?\s+Activos/i
  ];
  const toReList = [
    /(Cr[eé]ditos?\s+Liquidados?)/i,
    /(Resumen\s+Cr[eé]ditos?\s+Liquidados?)/i,
    /(Historia)/i,
    /(INFORMACI[ÓO]N\s+COMERCIAL)/i,
    /(DECLARATIVAS)/i
  ];

  let bloque = sliceBetween(text, fromReList, toReList);

  // Toma la línea con “Totales:” (o una ventana alrededor)
  let linea = (bloque.match(/Totales[^\r\n]*/i) || [])[0];
  let ventana = "";

  if (linea) {
    // amplía un poco por si los números brincan de línea
    const pos = bloque.indexOf(linea);
    ventana = bloque.slice(pos, pos + 600);
  } else {
    // fallback global
    const m = text.match(/Totales[^\r\n]*/i);
    if (m) {
      const pos = text.indexOf(m[0]);
      ventana = text.slice(pos, pos + 600);
      linea = m[0];
    } else {
      return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
    }
  }

  // 1) REGEX estructurado: Totales: <4 enteros> <Original> <Saldo> <Vigente>
  //    (admite múltiples espacios / saltos / separadores)
  const norm = (ventana || linea).replace(/\s+/g, " ");
  const rx = /Totales\s*:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/i;
  let m = rx.exec(norm);

  let original, saldo, vigente;

  if (m) {
    original = toPesosMiles(m[5]);
    saldo    = toPesosMiles(m[6]);
    vigente  = toPesosMiles(m[7]);
  } else {
    // 2) Fallback por índices
    const nums = pickNumbers(ventana || linea);
    original = toPesosMiles(nums[4]);
    saldo    = toPesosMiles(nums[5]);
    vigente  = toPesosMiles(nums[6]);
  }

  let vencido = null;
  if (typeof saldo === "number" && typeof vigente === "number") {
    vencido = Math.max(0, saldo - vigente);
  }

  return {
    totalOriginalPesos: original ?? null,
    totalSaldoActualPesos: saldo ?? null,
    totalVigentePesos: vigente ?? null,
    totalVencidoPesos: vencido
  };
}

// ---------------- handler ----------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const form = formidable();
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const file = files?.file?.[0] || files?.file;
    if (!file?.filepath) return res.status(400).send("No se recibió archivo");

    const buffer = await readFile(file.filepath);
    const parsed = await pdfParse(buffer);
    const text = parsed?.text || "";

    const { indicadores, calificaRaw } = parseCalificaFromText(text);

    const valores = {};
    for (const it of indicadores) {
      const raw = String(it.valor).trim();
      valores[Number(it.id)] = raw === "--" ? "--" : Number(raw.replace(/,/g, ""));
    }

    // ID 15: pesos → UDIS
    const udi = Number(fields?.udi) || DEFAULT_UDI;
    const pesosMax = Number(valores[15] || 0);
    const udisMax  = pesosMax > 0 ? pesosMax / udi : 0;
    valores._udis  = Math.round(udisMax);

    const { pts, puntajeTotal } = puntuar(valores);
    const pi = calcularPI(puntajeTotal);

    const {
      totalOriginalPesos,
      totalSaldoActualPesos,
      totalVigentePesos,
      totalVencidoPesos,
    } = parseResumenActivosRobusto(text);

    const codigos = {};
    indicadores.forEach((x) => (codigos[Number(x.id)] = x.codigo));

    return res.status(200).json({
      meta: { pages: parsed?.numpages || null },
      calificaRaw,
      indicadores,
      codigos,
      valores,
      puntos: pts,
      puntajeTotal,
      probabilidadIncumplimiento: `${(pi * 100).toFixed(2)}%`,
      summary: {
        totalOriginalPesos,
        totalSaldoActualPesos,
        totalVigentePesos,
        totalVencidoPesos,
        maxCreditPesos: pesosMax,
      },
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    return res.status(500).json({ error: e?.message || "Error procesando el PDF" });
  }
}
