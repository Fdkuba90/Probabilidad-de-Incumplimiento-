// /pages/api/analyzePdf.js
import fs from "fs";
import pdfParse from "pdf-parse";
import formidable from "formidable";

export const config = {
  api: { bodyParser: false },
};

// -------------------- UTILIDADES --------------------
const toNumber = (x) => {
  if (x == null) return null;
  const s = String(x).trim().replace(/,/g, "");
  if (s === "--" || s === "—" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const fmtMoney = (n) =>
  typeof n === "number"
    ? n.toLocaleString("es-MX", { style: "currency", currency: "MXN" })
    : "-";
const toPesosMiles = (n) => (n == null ? null : Math.round(n * 1000));

// -------------------- FORM PARSER --------------------
function parseForm(req) {
  const form = formidable({ multiples: false, keepExtensions: true });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

// -------------------- PARSE CALIFICA --------------------
function extractCalificaBlock(text) {
  // recorta entre "Califica" y la siguiente sección
  const start = text.search(/Califica\s*$/im);
  if (start === -1) return "";
  const rest = text.slice(start);
  const end =
    rest.search(/(DECLARATIVAS|INFORMACI[ÓO]N\s+COMERCIAL|INFORMACI[ÓO]N\s+DE\s+PLD|Historia|Resumen\s+Cr[eé]ditos?\s+Liquidados?)/i);
  return end !== -1 ? rest.slice(0, end) : rest;
}

function extractValoresCalifica(text) {
  const bloque = extractCalificaBlock(text);
  const valores = {};
  // líneas tipo: "15 BK12_MAX_CREDIT_AMT 6473733.11"
  const re = /(?:^|\n)\s*(\d{1,2})\s+[A-Z0-9_]+[^\n]*?\s([-\d.]+)\s*(?:\n|$)/g;
  let m;
  while ((m = re.exec(bloque))) {
    const id = Number(m[1]);
    const val = toNumber(m[2]);
    if (Number.isFinite(id)) valores[id] = val;
  }
  return valores;
}

// -------------------- PARSE RESUMEN CRÉDITOS ACTIVOS (ROBUSTO) --------------------
function splitStuckToken(tok) {
  const s = String(tok);
  // Si es un bloque largo de dígitos (7–12), intenta cortar en los últimos 4
  if (/^\d{7,12}$/.test(s)) {
    const a = s.slice(0, -4), b = s.slice(-4);
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return [a, b];
  }
  return [s];
}
function pickNumbersNormalized(str) {
  const raw = (str.match(/\d{1,12}(?:\.\d+)?/g) || []); // acepta 29874.3
  const flat = [];
  for (const t of raw) {
    // si trae decimales (p.ej. 29874.3) no lo partimos
    if (/^\d+\.\d+$/.test(t)) {
      flat.push(t);
    } else {
      flat.push(...splitStuckToken(t));
    }
  }
  return flat
    .map(x => x.replace(/^0+/, "") || "0")
    .map(x => (x.includes(".") ? parseFloat(x) : parseInt(x, 10)))
    .filter(n => Number.isFinite(n));
}

function parseResumenActivosRobusto(text) {
  // recortamos un bloque razonable alrededor de "Resumen Créditos Activos"
  const fromReList = [
    /Resumen\s*Cr[eé]ditos?\s*Activos?:?/i,
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
  const sliceBetween = (txt, froms, tos) => {
    let fromIdx = -1;
    for (const re of froms) { const i = txt.search(re); if (i !== -1) { fromIdx = i; break; } }
    if (fromIdx === -1) return "";
    const rest = txt.slice(fromIdx);
    for (const re of tos) { const j = rest.search(re); if (j !== -1) return rest.slice(0, j); }
    return rest;
  };
  const bloque = sliceBetween(text, fromReList, toReList);

  // encuentra la línea "Totales:" más cercana
  const lineMatch = (bloque.match(/Totales[^\r\n]*/i) || [])[0]
                 || (text.match(/Totales[^\r\n]*/i) || [])[0];
  if (!lineMatch) {
    return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
  }
  const base = bloque && bloque.includes(lineMatch) ? bloque : text;
  const pos = base.indexOf(lineMatch);
  const window = base.slice(Math.max(0, pos - 200), pos + 800);

  // extrae y normaliza números (parte tokens pegados)
  const numsAll = pickNumbersNormalized(window);
  // quedarnos con números razonables (3–6 dígitos o con decimal como 29874.3)
  const nums = numsAll.filter(n => {
    const s = String(n);
    const len = s.replace(/\D/g, "").length;
    return len >= 3 && len <= 6; // miles a cientos de miles
  });

  if (nums.length < 3) {
    return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
  }

  // buscar el “mejor” trío (a,b,c) donde dos sean iguales o casi-iguales (±5)
  let best = null; // {orig, saldo, vig, score}
  const nearlyEq = (x, y) => Math.abs(x - y) <= 5;

  // también contemplar valores con decimal (p.ej. 29874.3)
  const clean = nums.map(n => (typeof n === "number" ? n : Number(n)));

  for (let i = 0; i <= clean.length - 3; i++) {
    const a = clean[i], b = clean[i + 1], c = clean[i + 2];
    const triples = [
      { equal: a === b || nearlyEq(a, b), orig: c, saldo: a, vig: b },
      { equal: b === c || nearlyEq(b, c), orig: a, saldo: b, vig: c },
      { equal: a === c || nearlyEq(a, c), orig: b, saldo: a, vig: c },
    ];
    for (const t of triples) {
      if (!t.equal) continue;
      const exactPair = (t.saldo === t.vig) ? 1 : 0;
      const score = exactPair * 1e9 + (t.saldo + t.vig + t.orig);
      if (!best || score > best.score) best = { ...t, score };
    }
  }
  // Fallback: últimos 3
  if (!best) {
    const tail = clean.slice(-3);
    best = { orig: tail[0], saldo: tail[1], vig: tail[2], score: 0 };
  }

  // convertir de miles a pesos
  const original = toPesosMiles(best.orig);
  const saldo    = toPesosMiles(best.saldo);
  const vigente  = toPesosMiles(best.vig);
  const vencido  = (typeof saldo === "number" && typeof vigente === "number")
    ? Math.max(0, Math.round(saldo - vigente))
    : null;

  return {
    totalOriginalPesos: original,
    totalSaldoActualPesos: saldo,
    totalVigentePesos: vigente,
    totalVencidoPesos: vencido,
  };
}

// -------------------- PUNTAJE (mantenemos tu lógica) --------------------
const puntosBase = 285;

// Ajusta aquí SOLO si cambian tablas de rangos
function puntajePorId(id, v, udi) {
  switch (id) {
    // 1) BK12_NUM_CRED
    case 1: {
      if (v === 0) return 62;
      if (v <= 1) return 50;
      if (v <= 7) return 41;
      return 16;
    }
    // 6) NBK12_PCT_PROMT
    case 6: {
      // 0–1 donde 1=100% puntual
      if (v == null) return 0;
      if (v >= 0.93) return 71;
      if (v >= 0.81) return 54;
      return 17;
    }
    // 9) BK24_PCT_60PLUS
    case 9: {
      if (v === 0) return 54;
      if (v <= 0.05) return 37;
      return -19;
    }
    // 11) NBK12_COMM_PCT_PLUS  (rangos que nos diste)
    case 11: {
      if (v == null) return 55;               // "Sin Información" → 55
      if (v === 0) return 57;
      if (v > 0 && v < 10) return 42;
      if (v >= 10 && v < 62) return 28;
      return 21; // >=62
    }
    // 14) BK12_IND_QCRA  (0/1/SinInfo)
    case 14: {
      if (v == null) return 53;   // Sin Información
      if (v === 0) return 55;
      return -29;                 // 1
    }
    // 15) BK12_MAX_CREDIT_AMT (valor en pesos → convertir a UDIS antes de evaluar)
    case 15: {
      if (v == null || !udi) return 0;
      const enUDIS = v / Number(udi);
      // puntos: <1,000,000 UDIS → 52 ;  ≥1,000,000 UDIS → 112
      return enUDIS >= 1_000_000 ? 112 : 52;
    }
    // 16) MONTHS_ON_FILE_BANKING
    case 16: {
      if (v < 24) return 41;
      if (v < 36) return 51;
      if (v < 48) return 60;
      if (v < 98) return 60;
      if (v < 120) return 61;
      return 67;
    }
    // 17) MONTHS_SINCE_LAST_OPEN_BANKING
    case 17: {
      if (v == null) return 58; // Sin Información
      if (v > 0 && v < 6) return 46;
      if (v >= 6) return 58;
      return 58;
    }
    default:
      return 0;
  }
}

function calcularPuntajeIndicadores(valores, udi) {
  const ids = [1, 6, 9, 11, 14, 15, 16, 17];
  const puntos = {};
  let total = puntosBase;

  for (const id of ids) {
    const v = valores[id];
    const p = puntajePorId(id, v, udi);
    puntos[id] = p;
    total += p;
  }
  return { puntos, total };
}

// -------------------- PI (logit) --------------------
function calcularPI(puntajeTotal) {
  // PI = 1 / (1 + e^{-(500 - score) * ln(2)/40})
  const expo = -((500 - puntajeTotal) * Math.log(2) / 40);
  const pi = 1 / (1 + Math.exp(expo));
  return pi; // 0–1
}

// -------------------- HANDLER --------------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { fields, files } = await parseForm(req);
    const udi = Number(fields.udi);
    const file = files.file;
    if (!file) return res.status(400).json({ error: "Falta el PDF" });

    const buffer = fs.readFileSync(file.filepath);
    const parsed = await pdfParse(buffer);
    const text = parsed.text || "";

    // Califica
    const valores = extractValoresCalifica(text);

    // Puntaje
    const { puntos, total } = calcularPuntajeIndicadores(valores, udi);
    const pi = calcularPI(total);

    // Resumen Créditos Activos (totales)
    const r = parseResumenActivosRobusto(text);

    res.json({
      valores: {
        ...valores,
        _udis: udi ?? null,
      },
      puntos,
      puntajeTotal: total,
      probabilidadIncumplimiento: (pi * 100).toFixed(2) + "%",
      resumenActivos: {
        totalOriginalPesos: r.totalOriginalPesos,
        totalSaldoActualPesos: r.totalSaldoActualPesos,
        totalVigentePesos: r.totalVigentePesos,
        totalVencidoPesos: r.totalVencidoPesos,
        totalOriginalPesosFmt: fmtMoney(r.totalOriginalPesos),
        totalSaldoActualPesosFmt: fmtMoney(r.totalSaldoActualPesos),
        totalVigentePesosFmt: fmtMoney(r.totalVigentePesos),
        totalVencidoPesosFmt: fmtMoney(r.totalVencidoPesos),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo analizar el PDF" });
  }
}
