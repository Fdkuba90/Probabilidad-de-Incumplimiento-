// pages/api/analyzePdf.js — API robusta: solo POST, siempre JSON, OCR + fallback texto
export const runtime = "nodejs";

import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";
import { extractHistoriaOCR } from "../../lib/ocrHistoria";

/** Next API config: desactiva bodyParser para permitir multipart/form-data (formidable) */
export const config = {
  api: { bodyParser: false, sizeLimit: "25mb", externalResolver: true },
};

// ====== utilidades pequeñas ======
const PUNTOS_BASE = 285;
const DEFAULT_UDI = 8.1462;

const clamp01 = (x) => (x == null ? null : Math.max(0, Math.min(1, x)));
const toPesosMiles = (n) => (n == null ? null : Math.round(n * 1000));

function normalizeText(text = "") {
  return (text || "")
    .replace(/\u00A0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
function parseNumLoose(v) {
  if (v == null) return null;
  let s = String(v).trim().replace(/\u00A0/g, " ").replace(/\s+/g, "");
  if (s === "" || s === "--") return null;
  if (s.includes(",") && !s.includes(".")) s = s.replace(/,/g, "."); // coma decimal
  s = s.replace(/(?<=\d)[\s.](?=\d{3}(?:\D|$))/g, ""); // separador miles
  s = s.replace(/,(?=\d{3}(?:\D|$))/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function sliceBetween(txt, fromReList, toReList) {
  let fromIdx = -1;
  for (const re of fromReList) {
    const i = txt.search(re);
    if (i !== -1) {
      fromIdx = i;
      break;
    }
  }
  if (fromIdx === -1) return "";
  const rest = txt.slice(fromIdx);
  for (const re of toReList) {
    const j = rest.search(re);
    if (j !== -1) return rest.slice(0, j);
  }
  return rest;
}

// ====== Resumen Activos (totales) ======
function parseResumenActivosRobusto(text) {
  const fromReList = [
    /Resumen\s*(de)?\s*Cr[eé]ditos?\s+Activos?/i,
    /Cr[eé]ditos?\s+Activos?.*Resumen/i,
    /Cr[eé]ditos?\s+Activos/i,
  ];
  const toReList = [
    /(Cr[eé]ditos?\s+Liquidados?)/i,
    /(Resumen\s+Cr[eé]ditos?\s+Liquidados?)/i,
    /(Historia)/i,
    /(INFORMACI[ÓO]N\s+COMERCIAL)/i,
    /(DECLARATIVAS)/i,
  ];

  const bloque = sliceBetween(text, fromReList, toReList);
  const lineMatch = (bloque.match(/Totales[^\n]*/i) || [])[0] || (text.match(/Totales[^\n]*/i) || [])[0];
  if (!lineMatch) {
    return {
      totalOriginalPesos: null,
      totalSaldoActualPesos: null,
      totalVigentePesos: null,
      totalVencidoPesos: null,
    };
  }

  const base = bloque && bloque.includes(lineMatch) ? bloque : text;
  const pos = base.indexOf(lineMatch);
  const window = base.slice(Math.max(0, pos), pos + 800);

  function splitStuckToken(tok) {
    const s = String(tok);
    if (/^\d{7,10}$/.test(s)) {
      const a = s.slice(0, -4),
        b = s.slice(-4);
      if (/^\d+$/.test(a) && /^\d+$/.test(b)) return [a, b];
    }
    return [s];
  }
  const raw = window.match(/\d{1,12}/g) || [];
  const nums = raw
    .flatMap((t) => splitStuckToken(t))
    .map((x) => x.replace(/^0+/, "") || "0")
    .map((x) => parseInt(x, 10))
    .filter(Number.isFinite)
    .filter((n) => n >= 1 && n <= 999999);

  let triple = null;
  for (let i = 0; i <= nums.length - 3; i++) {
    const a = nums[i],
      b = nums[i + 1],
      c = nums[i + 2];
    const okLen = (x) => String(x).length >= 3 && String(x).length <= 6;
    if (okLen(a) && okLen(b) && okLen(c)) {
      if (a === b && a !== c) triple = { orig: c, saldo: a, vig: b };
      else if (b === c && b !== a) triple = { orig: a, saldo: b, vig: c };
      else if (a === c && a !== b) triple = { orig: b, saldo: a, vig: c };
    }
  }
  if (!triple) {
    const tail = nums.slice(-3);
    if (tail.length === 3) triple = { orig: tail[0], saldo: tail[1], vig: tail[2] };
    else
      return {
        totalOriginalPesos: null,
        totalSaldoActualPesos: null,
        totalVigentePesos: null,
        totalVencidoPesos: null,
      };
  }

  const original = toPesosMiles(triple.orig);
  const saldo = toPesosMiles(triple.saldo);
  const vigente = toPesosMiles(triple.vig);
  const vencido = typeof saldo === "number" && typeof vigente === "number" ? Math.max(0, saldo - vigente) : null;

  return {
    totalOriginalPesos: original,
    totalSaldoActualPesos: saldo,
    totalVigentePesos: vigente,
    totalVencidoPesos: vencido,
  };
}

// ====== Parser de Historia por TEXTO (fallback si falla OCR) ======
function parseHistoriaTexto(fullText) {
  const bloque =
    sliceBetween(
      fullText,
      [/^\s*Historia\s*:?\s*$/im, /^\s*Historia\b:?/im],
      [
        /^\s*INFORMACI[ÓO]N\s+COMERCIAL\b/im,
        /^\s*Califica(ción)?\b/im,
        /^\s*DECLARATIVAS\b/im,
        /^\s*INFORMACI[ÓO]N\s+DE\s+PLD\b/im,
        /^\s*FIN DEL REPORTE\b/im,
      ],
    ) || fullText;

  const lines = bloque.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const MES_RE = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i;
  const NUM_RE = /(?:-?\d{1,3}(?:[.,]\d{3})+|-?\d+(?:[.,]\d+)?)/g;

  const months = [];
  const idxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (MES_RE.test(lines[i])) {
      months.push(lines[i].replace(/\s+/g, " "));
      idxs.push(i);
    }
  }
  if (!months.length) return { rows: [], historiaRaw: bloque };

  const toNum = (s) => {
    const canon = String(s)
      .replace(/\u00A0/g, " ")
      .trim()
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "")
      .replace(/,/g, ".");
    const n = Number(canon);
    return Number.isFinite(n) ? Math.round(n * 1000) : 0;
  };

  const takeNum = (re, start, end) => {
    for (let i = start; i < end; i++) {
      if (re.test(lines[i])) {
        const same = lines[i].match(NUM_RE) || [];
        const next = i + 1 < end ? lines[i + 1].match(NUM_RE) || [] : [];
        const cands = [...same, ...next];
        const n = cands.length ? toNum(cands[0]) : 0;
        return n > 0 ? n : 0;
      }
    }
    return 0;
  };
  const takeRating = (start, end) => {
    const TK = /\b\d(?:NC|[A-Z]\d)\b/gi;
    const set = new Set();
    for (let i = start; i < Math.min(end, start + 6); i++) {
      const a = lines[i].match(TK) || [];
      a.forEach((x) => set.add(x.toUpperCase()));
    }
    return set.size ? Array.from(set).join(" ") : null;
  };

  const rows = [];
  for (let k = 0; k < months.length; k++) {
    const s = idxs[k];
    const e = k + 1 < idxs.length ? idxs[k + 1] : Math.min(lines.length, s + 80);
    rows.push({
      month: months[k],
      vigente: takeNum(/^\s*Vigente\b/i, s, e),
      v1_29: takeNum(/^\s*Vencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/i, s, e),
      v30_59: takeNum(/^\s*Vencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/i, s, e),
      v60_89: takeNum(/^\s*Vencido\s+de\s*60\s*a\s*89\s*d[ií]as\b/i, s, e),
      v90p: takeNum(/^\s*Vencido\s+a\s*m[aá]s\s*de\s*89\s*d[ií]as\b|^\s*90\+\b|^>\s*89\b/i, s, e),
      rating: takeRating(s, e),
    });
  }

  const ORDER = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  rows.sort((a, b) => {
    const [ma, ya] = (a.month || "").split(/\s+/);
    const [mb, yb] = (b.month || "").split(/\s+/);
    return (ya - yb) || (ORDER.indexOf(ma) - ORDER.indexOf(mb));
  });

  return { rows: rows.slice(-12), historiaRaw: bloque };
}

// ====== Scoring & PI ======
function puntuar(val, flags) {
  const pts = {};
  const isMissing = (v) => v == null || v === "--" || (typeof v === "number" && !Number.isFinite(v));

  if (!isMissing(val[1])) pts[1] = val[1] === 0 ? 62 : val[1] <= 3 ? 50 : val[1] <= 7 ? 41 : 16;
  else {
    pts[1] = 0;
    flags.push({ id: 1, tipo: "sin_info" });
  }

  if (val[6] === "--" || val[6] == null) pts[6] = 52;
  else pts[6] = val[6] >= 0.93 ? 71 : val[6] >= 0.81 ? 54 : 17;

  if (!isMissing(val[9])) pts[9] = Number(val[9]) === 0 ? 54 : -19;
  else {
    pts[9] = 0;
    flags.push({ id: 9, tipo: "sin_info" });
  }

  if (val[11] === "--" || val[11] == null) pts[11] = 55;
  else pts[11] = Number(val[11]) === 0 ? 57 : 30;

  if (!isMissing(val[14])) pts[14] = Number(val[14]) === 0 ? 55 : -29;
  else {
    pts[14] = 0;
    flags.push({ id: 14, tipo: "sin_info" });
  }

  const udis = Number(val._udis) || 0;
  pts[15] = udis >= 1_000_000 ? 112 : 52;

  const m = Number(val[16]);
  pts[16] = Number.isFinite(m) ? (m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67) : (flags.push({ id: 16, tipo: "sin_info" }), 0);

  const mLast = Number(val[17]);
  pts[17] = Number.isFinite(mLast) ? (mLast > 0 && mLast <= 6 ? 46 : 58) : (flags.push({ id: 17, tipo: "sin_info" }), 0);

  const sumaIndicadores = Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, sumaIndicadores };
}
function calcularPI(score) {
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}
function detectaSinHistorial({ valores, historyMonthly, resumen }) {
  const tot0 = [resumen.totalSaldoActualPesos, resumen.totalVigentePesos, resumen.totalOriginalPesos].every((v) => !v || v === 0);
  const meses0 = !(Array.isArray(historyMonthly) && historyMonthly.some((r) => (r.vigente || 0) > 0 || (r.v90p || 0) > 0));
  const claves = [1, 6, 9, 11, 14, 15, 16, 17];
  const sinInfo = claves.filter((k) => valores[k] == null || valores[k] === "--").length >= 5;
  return tot0 && meses0 && sinInfo;
}

// ====== Handler ======
export default async function handler(req, res) {
  // Permite preflight CORS si algún navegador lo hace (no debería, pero no molesta)
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", ["POST"]);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: `Método ${req.method} no permitido` });
  }

  try {
    // 1) Parsear multipart/form-data
    const form = formidable({ multiples: false, keepExtensions: true });
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const file = files?.file?.[0] || files?.file;
    if (!file?.filepath) {
      return res.status(400).json({ error: "No se recibió archivo" });
    }

    // 2) Leer PDF y texto básico
    const buffer = await readFile(file.filepath);
    const parsed = await pdfParse(buffer).catch((e) => {
      throw new Error("No se pudo leer el PDF: " + (e?.message || e));
    });
    const text = normalizeText(parsed?.text || "");

    // 3) Califica
    const { indicadores = [], calificaRaw = null } = parseCalificaFromText(text) || {};
    const valores = {};
    for (const it of indicadores) {
      const id = Number(it.id);
      const n = parseNumLoose(it.valor);
      valores[id] = n == null ? "--" : n;
    }
    const ratioIds = [5, 6, 7, 8, 9, 10, 11, 12];
    for (const id of ratioIds) if (valores[id] !== "--") valores[id] = clamp01(valores[id]);
    if (valores[16] === "--") valores[16] = null;
    if (valores[17] === "--") valores[17] = null;

    // UDIS desde ID 15
    const udi = Number(fields?.udi) || DEFAULT_UDI;
    const pesosMax = Number(valores[15] || 0);
    const udisMax = pesosMax > 0 ? pesosMax / udi : 0;
    valores._udis = Math.round(udisMax);

    // 4) Totales Activos
    const resumen = parseResumenActivosRobusto(text);

    // 5) Historia: OCR con fallback a texto
    const flags = [];
    let historyMonthly = [];
    let historiaRaw = "";

    try {
      const { rows, historiaRaw: raw } = await extractHistoriaOCR(buffer);
      historyMonthly = Array.isArray(rows) ? rows : [];
      historiaRaw = raw || "";
      if (!historyMonthly.length) flags.push({ tipo: "historia_ocr_sin_filas", detalle: "OCR no devolvió filas" });
    } catch (e) {
      flags.push({ tipo: "historia_ocr_error", detalle: String(e?.message || e) });
    }

    if (!historyMonthly.length) {
      const { rows, historiaRaw: raw } = parseHistoriaTexto(text);
      historyMonthly = Array.isArray(rows) ? rows : [];
      if (!historiaRaw) historiaRaw = raw || "";
      flags.push({ tipo: "historia_fallback_texto", detalle: `Filas: ${historyMonthly.length}` });
    }

    // 6) Ordenar y limitar 12 meses
    const ORDER = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    historyMonthly.sort((a, b) => {
      const [ma, ya] = (a.month || "").split(/\s+/);
      const [mb, yb] = (b.month || "").split(/\s+/);
      return (ya - yb) || (ORDER.indexOf(ma) - ORDER.indexOf(mb));
    });
    historyMonthly = historyMonthly.slice(-12);

    // 7) Puntaje y PI
    const { pts, sumaIndicadores } = puntuar(valores, flags);
    const sinHistorial = detectaSinHistorial({ valores, historyMonthly, resumen });
    const baseAplicada = sinHistorial ? 0 : PUNTOS_BASE;
    if (sinHistorial) flags.push({ tipo: "sin_historial", detalle: "No se aplican 285 pb" });

    const puntajeTotal = baseAplicada + sumaIndicadores;
    const pi = calcularPI(puntajeTotal);

    // 8) Responder
    return res.status(200).json({
      meta: { pages: parsed?.numpages || null },
      calificaRaw,
      indicadores,
      valores,
      puntos: pts,
      puntajeTotal,
      probabilidadIncumplimiento: `${(pi * 100).toFixed(2)}%`,
      flags,
      summary: {
        totalOriginalPesos: resumen.totalOriginalPesos,
        totalSaldoActualPesos: resumen.totalSaldoActualPesos,
        totalVigentePesos: resumen.totalVigentePesos,
        totalVencidoPesos: resumen.totalVencidoPesos,
        maxCreditPesos: Number.isFinite(Number(valores[15])) ? Number(valores[15]) : 0,
      },
      historyMonthly,
      historiaRaw,
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    return res.status(500).json({ error: e?.message || "Error procesando el PDF" });
  }
}
