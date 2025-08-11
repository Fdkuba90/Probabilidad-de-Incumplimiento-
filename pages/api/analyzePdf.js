// /pages/api/analyzePdf.js
import pdfParse from "pdf-parse";
import formidable from "formidable";

export const config = {
  api: { bodyParser: false }, // vamos a leer multipart con formidable
};

/* ============== utilidades de texto ============== */
const clean = (s) =>
  s
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const toFixedPct = (x) =>
  (x == null || !isFinite(x)) ? "-" : `${(x * 100).toFixed(2)}%`;

const money = (n) =>
  (n == null || !isFinite(n)) ? "-" :
  n.toLocaleString("en-US", { style: "currency", currency: "MXN", maximumFractionDigits: 2 });

/* ============== lectura de PDF desde multipart ============== */
async function readPdfFromForm(req) {
  const form = formidable({ multiples: false });
  const { fields, files } = await new Promise((res, rej) =>
    form.parse(req, (err, flds, fls) => (err ? rej(err) : res({ fields: flds, files: fls })))
  );

  const udi = parseFloat(String(fields?.udi ?? "8.1462"));
  const f = files?.file;
  if (!f) throw new Error("No llegó el archivo PDF.");

  const buf = await fsLikeReadFile(f);
  const parsed = await pdfParse(buf);
  return { text: clean(parsed.text || ""), udi };
}

// helper para leer archivo subido por formidable (sea path o buffer)
import fs from "fs";
async function fsLikeReadFile(f) {
  if (Buffer.isBuffer(f)) return f;
  if (f?.filepath && fs.existsSync(f.filepath)) return fs.promises.readFile(f.filepath);
  if (f?._writeStream?._writableState?.buffer?.[0]?.data) {
    return Buffer.from(f._writeStream._writableState.buffer[0].data);
  }
  throw new Error("No se pudo leer el PDF subido.");
}

/* ============== lectura de “Califica” (IDs) ============== */
function parseCalificaBlock(text) {
  // tomamos el bloque donde viene la tabla de Califica
  const start = text.search(/Califica\s*[\r\n]+Identificador/i);
  if (start === -1) return {};
  const sub = text.slice(start, start + 4000);

  // Mapa ID -> valor
  const out = {};

  // IDs que necesitamos
  const targets = {
    1: /BK12_NUM_CRED/i,
    6: /NBK12_PCT_PROMT/i,
    9: /BK24_PCT_60PLUS/i,
    11:/NBK12_COMM_PCT_PLUS/i,
    14:/BK12_IND_QCRA/i,
    15:/BK12_MAX_CREDIT_AMT/i,
    16:/MONTHS_ON_FILE_BANKING/i,
    17:/MONTHS_SINCE_LAST_OPEN_BANKING/i,
  };

  // Por cada código, intenta extraer el número a la derecha
  for (const [id, reCode] of Object.entries(targets)) {
    const m = sub.match(new RegExp(`\\b(${reCode.source})\\b[^\\n]*\\n?[ \\t]*([\\w.-]+)`, "i"));
    if (!m) continue;
    const raw = m[2].trim();
    if (raw === "--") { out[id] = "--"; continue; }

    // números con decimal también
    const num = parseFloat(raw.replace(/,/g, ""));
    out[id] = isFinite(num) ? num : raw;
  }

  return out;
}

/* ============== puntaje por ID ============== */
function puntosPorID(valores, udi) {
  const puntos = {};

  // ID 1 – BK12_NUM_CRED
  // 0 => 62 ; 1-7 => 50 ; >7 => 41
  {
    const v = Number(valores[1] ?? 0);
    puntos[1] = v === 0 ? 62 : (v <= 7 ? 50 : 41);
  }

  // ID 6 – NBK12_PCT_PROMT  (0..1)
  // >0.93 => 71 ; >=0.81 => 54 ; else 17
  {
    const v = Number(valores[6] ?? 0);
    puntos[6] = v > 0.93 ? 71 : (v >= 0.81 ? 54 : 17);
  }

  // ID 9 – BK24_PCT_60PLUS  (0..1)
  // 0 => 54 ; >0 => -19
  {
    const v = Number(valores[9] ?? 0);
    puntos[9] = v === 0 ? 54 : -19;
  }

  // ID 11 – NBK12_COMM_PCT_PLUS
  // “--” => 55 ; 0 => 57 ; >0 => 30
  {
    const raw = valores[11];
    if (raw === "--") puntos[11] = 55;
    else {
      const v = Number(raw ?? 0);
      puntos[11] = v === 0 ? 57 : 30;
    }
  }

  // ID 14 – BK12_IND_QCRA
  // 0 => 55 ; 1 => -29
  {
    const v = Number(valores[14] ?? 0);
    puntos[14] = v === 0 ? 55 : -29;
  }

  // ID 15 – BK12_MAX_CREDIT_AMT  (viene en PESOS, convertir a UDIS)
  // <1,000,000 UDIS => 52 ; >=1,000,000 UDIS => 112
  {
    const pesos = Number(valores[15] ?? 0);
    const vUdis = udi > 0 ? (pesos / udi) : 0;
    puntos[15] = vUdis < 1_000_000 ? 52 : 112;
  }

  // ID 16 – MONTHS_ON_FILE_BANKING
  // <24 =>41 ; [24,36)=>51 ; [36,48)=>60 ; [48,98)=>60 ; [98,120)=>61 ; >=120=>67
  {
    const v = Number(valores[16] ?? 0);
    let pt = 41;
    if (v >= 24 && v < 36) pt = 51;
    else if (v >= 36 && v < 48) pt = 60;
    else if (v >= 48 && v < 98) pt = 60;
    else if (v >= 98 && v < 120) pt = 61;
    else if (v >= 120) pt = 67;
    puntos[16] = pt;
  }

  // ID 17 – MONTHS_SINCE_LAST_OPEN_BANKING
  // “Sin info” => 58 ; (0,6) => 46 ; >=6 => 58
  {
    const v = Number(valores[17] ?? 0);
    puntos[17] = v > 0 && v < 6 ? 46 : 58;
  }

  return puntos;
}

/* ============== PI (logístico) ============== */
function probIncumplimiento(puntajeTotal) {
  // PI_i = 1 / (1 + e^{-(500 - score) * ln(2)/40})
  const expo = - (500 - puntajeTotal) * (Math.log(2) / 40);
  const pi = 1 / (1 + Math.exp(expo));
  return pi;
}

/* ============== Parser robusto de Totales (Resumen Activos) ============== */
// utilidades
function sliceBetween(txt, fromReList, toReList) {
  let fromIdx = -1;
  for (const re of fromReList) {
    const i = txt.search(re);
    if (i !== -1) { fromIdx = i; break; }
  }
  if (fromIdx === -1) return "";
  const rest = txt.slice(fromIdx);
  for (const re of toReList) {
    const j = rest.search(re);
    if (j !== -1) return rest.slice(0, j);
  }
  return rest;
}
function splitStuckToken(tok) {
  const s = String(tok);
  if (/^\d{2,}\.\d{1,}\d{2,}$/.test(s)) {
    const m = s.match(/^(\d+\.\d+)(\d{4,6})$/);
    if (m) return [m[1], m[2]];
  }
  if (/^\d{7,12}$/.test(s)) {
    const b = s.slice(-5);
    const a = s.slice(0, -5);
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return [a, b];
  }
  return [s];
}
function pickNumbersNormalized(str) {
  const raw = (str.match(/\d+(?:\.\d+)?/g) || []);
  const flat = [];
  for (const t of raw) flat.push(...splitStuckToken(t));
  return flat
    .map(x => x.replace(/^0+/, "") || "0")
    .map(x => Number(x))
    .filter(n => Number.isFinite(n));
}
const toPesosMiles = (n) => (n == null ? null : Math.round(n * 1000));

function parseResumenActivosRobusto(text) {
  const fromReList = [
    /Resumen\s*(de)?\s*Cr[eé]ditos?\s+Activos?/i,
    /Cr[eé]ditos?\s+Activos?.*Resumen/i
  ];
  const toReList = [
    /(Cr[eé]ditos?\s+Liquidados?)/i,
    /(Historia)/i,
    /(INFORMACI[ÓO]N\s+COMERCIAL)/i,
    /(DECLARATIVAS)/i
  ];

  const bloque = sliceBetween(text, fromReList, toReList);
  if (!bloque) {
    return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
  }

  const idx = bloque.search(/Totales[:\s]/i);
  const sub = idx >= 0 ? bloque.slice(idx, idx + 900) : bloque.slice(0, 900);

  const nums = pickNumbersNormalized(sub).filter(n => n >= 200 && n <= 100000);
  if (nums.length < 3) {
    return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
  }

  const top = [...nums].sort((a,b)=>b-a).slice(0,6);
  const uniq = [];
  for (const n of top) if (!uniq.some(m => Math.abs(m-n) < 0.5)) uniq.push(n);
  const three = uniq.slice(0,3).sort((a,b)=>a-b);
  if (three.length < 3) {
    return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
  }

  const original = toPesosMiles(three[0]);
  const vigente  = toPesosMiles(three[1]);
  const saldo    = toPesosMiles(three[2]);
  const vencido  = (typeof saldo === "number" && typeof vigente === "number") ? Math.max(0, saldo - vigente) : null;

  return {
    totalOriginalPesos: original,
    totalSaldoActualPesos: saldo,
    totalVigentePesos: vigente,
    totalVencidoPesos: vencido,
  };
}

/* ============== handler ============== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { text, udi } = await readPdfFromForm(req);

    // 1) CALIFICA
    const valores = parseCalificaBlock(text);

    // 2) Puntajes por ID (usa udi para ID 15)
    const puntos = puntosPorID(valores, udi);

    // 3) Puntaje total (suma de los 8 IDs)
    const ids = [1,6,9,11,14,15,16,17];
    const puntajeTotal = ids.reduce((s,id)=> s + (Number(puntos[id] ?? 0)), 0);

    // 4) PI
    const pi = probIncumplimiento(puntajeTotal);

    // 5) Totales de Resumen (en pesos)
    const tot = parseResumenActivosRobusto(text);

    // 6) Regresar tabla con ID/Código/Valor/Puntaje
    const codigos = {
      1: "BK12_NUM_CRED",
      6: "NBK12_PCT_PROMT",
      9: "BK24_PCT_60PLUS",
      11:"NBK12_COMM_PCT_PLUS",
      14:"BK12_IND_QCRA",
      15:"BK12_MAX_CREDIT_AMT",
      16:"MONTHS_ON_FILE_BANKING",
      17:"MONTHS_SINCE_LAST_OPEN_BANKING",
    };

    const rows = ids.map(id => ({
      id,
      codigo: codigos[id],
      valor: valores[id] === undefined ? "-" :
             (id === 15 ? `${(Number(valores[15]||0)/udi).toLocaleString("en-US", {maximumFractionDigits:0})} UDIS`
                         : String(valores[id])),
      puntaje: puntos[id],
    }));

    return res.status(200).json({
      puntajeTotal,
      probabilidadIncumplimiento: toFixedPct(pi),
      totales: {
        original: tot.totalOriginalPesos,
        saldoActual: tot.totalSaldoActualPesos,
        vigente: tot.totalVigentePesos,
        vencido: tot.totalVencidoPesos,
      },
      tabla: rows,
      valores, // por si quieres depurar
      puntos,
      _udis: (Number(valores[15]||0)/udi)||0, // udis de ID15 por si quieres mostrar aparte
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Error procesando PDF" });
  }
}
