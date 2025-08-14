// pages/api/analyzePdf.js — Parser robusto de "Historia:" sin OCR + scoring/PI (con parches anti-pegar-año)
export const runtime = 'nodejs';

import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";
import { parseHistoriaFromText } from "../../lib/parseHistoria";

// Next API config
export const config = {
  api: { bodyParser: false, sizeLimit: "25mb", externalResolver: true },
};

// Constantes
const PUNTOS_BASE = 285;
const DEFAULT_UDI = 8.1462;

// ===== Helpers de texto/números =====
function normalizeText(text = "") {
  return (text || "")
    .replace(/\u00A0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
function sliceBetween(txt, fromReList, toReList) {
  let fromIdx = -1;
  for (const re of fromReList) { const i = txt.search(re); if (i !== -1) { fromIdx = i; break; } }
  if (fromIdx === -1) return "";
  const rest = txt.slice(fromIdx);
  for (const re of toReList) { const j = rest.search(re); if (j !== -1) return rest.slice(0, j); }
  return rest;
}
// usado en Califica
function parseNumLoose(v) {
  if (v == null) return null;
  let s = String(v).trim().replace(/\u00A0/g, " ").replace(/\s+/g, "");
  if (s === "" || s === "--") return null;
  if (s.includes(",") && !s.includes(".")) s = s.replace(/,/g, "."); // coma decimal
  s = s.replace(/(?<=\d)[\s.](?=\d{3}(?:\D|$))/g, ""); // sep de miles
  s = s.replace(/,(?=\d{3}(?:\D|$))/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const clamp01 = (x) => x == null ? null : Math.max(0, Math.min(1, x));
const toPesosMiles = (n) => (n == null ? null : Math.round(n * 1000));
// helper anti “años”
const isYear = (n) => /^\s*20\d{2}\s*$/.test(String(n));

// ===== Orden de meses =====
const MES_IDX = { Ene:0, Feb:1, Mar:2, Abr:3, May:4, Jun:5, Jul:6, Ago:7, Sep:8, Oct:9, Nov:10, Dic:11 };
function parseMonthToken(tok) {
  const m = tok && tok.match(/^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+(\d{4})$/i);
  if (!m) return null;
  const key = m[1].slice(0,3).replace(/^./, c => c.toUpperCase());
  const mm = MES_IDX[key];
  const yy = Number(m[2]);
  if (!Number.isFinite(mm) || !Number.isFinite(yy)) return null;
  return { y: yy, m: mm };
}
function compareMonthTok(a, b) {
  const pa = parseMonthToken(a), pb = parseMonthToken(b);
  if (!pa || !pb) return 0;
  return pa.y === pb.y ? (pa.m - pb.m) : (pa.y - pb.y);
}

// ===== Empresa =====
function extractEmpresa(text) {
  let m = text.match(/Nombre\/Raz[oó]n Social:\s*([^\n\r]+)/i);
  if (m) {
    const cand = m[1].trim();
    if (cand && !/^(Direcci[oó]n|RFC|CURP|Datos Generales)/i.test(cand)) return cand;
  }
  m = text.match(/([^\n\r]+?)\s*Nombre\/Raz[oó]n Social:/i);
  if (m) {
    const cand = m[1].trim();
    if (cand && !/^(Direcci[oó]n|RFC|CURP|Datos Generales)/i.test(cand)) return cand;
  }
  const idx = text.search(/Nombre\/Raz[oó]n Social:/i);
  if (idx >= 0) {
    const tail = text.slice(idx).split(/\r?\n/);
    for (let i = 1; i < Math.min(tail.length, 5); i++) {
      const cand = (tail[i] || "").trim();
      if (!cand) continue;
      if (/^(Direcci[oó]n|RFC|CURP|Datos Generales|Colonia|Del\.?\/Mun|Ciudad|C[óo]digo Postal|Estado|Pa[ií]s|Tel[eé]fono|Fax)/i.test(cand)) continue;
      return cand;
    }
  }
  return null;
}

// ===== Bloque HISTORIA =====
function getHistoriaBlock(fullText) {
  return sliceBetween(
    fullText,
    [/^\s*Historia\s*:?\s*$/im, /^\s*Historia\b:?/im],
    [
      /^\s*INFORMACI[ÓO]N\s+COMERCIAL\b/im,
      /^\s*Califica(ción)?\b/im,
      /^\s*DECLARATIVAS\b/im,
      /^\s*INFORMACI[ÓO]N\s+DE\s+PLD\b/im,
      /^\s*FIN DEL REPORTE\b/im
    ]
  );
}
function extractHistoriaMonths(fullText) {
  const bloque = getHistoriaBlock(fullText);
  if (!bloque) return [];
  const lines = bloque.split(/\n/).map(s => s.trim()).filter(Boolean);
  const MES_RE = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i;
  const months = [];
  for (const ln of lines) if (MES_RE.test(ln)) months.push(ln.replace(/\s+/g, " "));
  months.sort(compareMonthTok);
  return months.slice(-12);
}

// ====== 1) tabla precisa dentro de Historia (PATCH) ======
function parseHistoriaTablaPrecisa(fullText) {
  const bloque = getHistoriaBlock(fullText);
  if (!bloque) return { rows: [], historiaRaw: "" };

  const lines = bloque.split(/\n/).map(s => s.trim()).filter(Boolean);
  const MES_RE = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i;

  // PATCH: tokens numéricos sin espacios intermedios y con miles/decimales típicos
  const NUM_RE = /(?:[-]?\d{1,3}(?:[.,]\d{3})+|[-]?\d+(?:[.,]\d+)?)/g;
  const toNumMiles = (s) => {
    const canon = String(s).replace(/\u00A0/g, " ").trim()
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "") // quita sep. miles
      .replace(/,/g, "."); // coma decimal a punto
    const n = Number(canon);
    return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
  };

  const monthIdx = [];
  const months = [];
  for (let i = 0; i < lines.length; i++) {
    if (MES_RE.test(lines[i])) { monthIdx.push(i); months.push(lines[i].replace(/\s+/g, " ")); }
  }
  if (!months.length) return { rows: [], historiaRaw: bloque };

  const out = [];
  for (let k = 0; k < months.length; k++) {
    const start = monthIdx[k];
    const end = k + 1 < months.length ? monthIdx[k + 1] : Math.min(lines.length, start + 60);
    const seg = lines.slice(start + 1, end).join(" ");

    // PATCH: no permitir espacios dentro del número y evitar años
    const BEFORE_VIG = /([\-]?\d{1,3}(?:[.,]\d{3})+|[\-]?\d+(?:[.,]\d+)?)\s*Vigente\b/i;
    const AFTER_VIG  = /\bVigente\b\s*([\-]?\d{1,3}(?:[.,]\d{3})+|[\-]?\d+(?:[.,]\d+)?)/i;

    let vigente = 0;
    let m = seg.match(BEFORE_VIG);
    if (m?.[1] && !isYear(m[1])) { const v = toNumMiles(m[1]); if (Number.isFinite(v) && v > 0) vigente = v; }
    if (!vigente) {
      m = seg.match(AFTER_VIG);
      if (m?.[1] && !isYear(m[1])) { const v = toNumMiles(m[1]); if (Number.isFinite(v) && v > 0) vigente = v; }
    }
    if (!vigente) {
      const nums = (seg.match(NUM_RE) || [])
        .filter(x => !isYear(x))
        .map(toNumMiles)
        .filter(n => Number.isFinite(n) && n > 0 && n <= 1_000_000); // 1,000,000 miles = $1,000,000,000
      if (nums.length) vigente = Math.max(...nums);
    }

    out.push({ month: months[k], vigente: vigente || 0, v1_29: 0, v30_59: 0, v60_89: 0, v90p: 0, rating: null });
  }

  out.sort((a, b) => compareMonthTok(a.month, b.month));
  return { rows: out.slice(-12), historiaRaw: bloque };
}

// ====== 2) modo rejilla (meses en cabecera) (PATCH suave) ======
function parseHistoriaMensual(text) {
  const bloqueHistoria = getHistoriaBlock(text) || text;
  const lines = (bloqueHistoria).split(/\n/).map(s => s.trim()).filter(Boolean);
  const MONTH_TOKEN = /\b(?:Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}\b/g;

  let headerIdx = -1;
  let months = [];
  for (let i = 0; i < lines.length; i++) {
    const ms = lines[i].match(MONTH_TOKEN);
    if (ms && ms.length >= 4) {
      if (ms.length > months.length) { months = ms.map(m => m.replace(/\s+/g, " ").trim()); headerIdx = i; }
    }
  }
  if (headerIdx === -1 || months.length < 4) return { rows: [], historiaRaw: bloqueHistoria };

  // PATCH: token numérico estricto y filtro de años
  const NUM_TOKEN = /(?:[-]?\d{1,3}(?:[.,]\d{3})+|[-]?\d+(?:[.,]\d+)?)/g;
  const toNumMiles = (s) => {
    const canon = String(s).replace(/\u00A0/g, " ").trim()
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "")
      .replace(/,/g, ".");
    const v = Number(canon);
    return Number.isFinite(v) ? Math.round(v * 1000) : NaN;
  };

  const ROWS = [
    { key: "vigente",  re: /^Vigente\b/i,                            numeric: true  },
    { key: "v1_29",    re: /^Vencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/i, numeric: true  },
    { key: "v30_59",   re: /^Vencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/i, numeric: true  },
    { key: "v60_89",   re: /^Vencido\s+de\s+60\s*a\s*89\s*d[ií]as\b/i, numeric: true  },
    { key: "v90p",     re: /^(Vencido\s+a\s*m[aá]s\s*de\s*89\s*d[ií]as|90\+|>89)\b/i, numeric: true  },
    { key: "rating",   re: /^Calificaci[oó]n\s+de\s+Cartera\b/i,      numeric: false }
  ];

  function collectRow(rowIndex) {
    const startRe = ROWS[rowIndex].re;
    const nextRes = ROWS.slice(rowIndex + 1).map(r => r.re);
    let start = -1;
    for (let i = headerIdx + 1; i < Math.min(lines.length, headerIdx + 200); i++) {
      if (startRe.test(lines[i])) { start = i; break; }
    }
    if (start === -1) return [];

    const accNums = [];
    const accToks = [];
    for (let i = start; i < Math.min(lines.length, start + 120); i++) {
      const ln = lines[i];
      if (nextRes.some(r => r.test(ln))) break;
      if (ROWS[rowIndex].numeric) {
        const toks = (ln.match(NUM_TOKEN) || []).filter(t => !isYear(t));
        accNums.push(...toks.map(toNumMiles).filter(Number.isFinite));
      } else {
        const toks = ln.match(/\b\d[A-Z]\d\b/gi) || [];
        accToks.push(...toks.map(t => t.toUpperCase()));
      }
    }

    if (ROWS[rowIndex].numeric) {
      const slice = accNums.slice(-months.length);
      while (slice.length < months.length) slice.unshift(0);
      return slice;
    } else {
      const slice = accToks.slice(-months.length);
      while (slice.length < months.length) slice.unshift(null);
      return slice;
    }
  }

  const rowsData = {};
  const ROWS_LIST = ["vigente", "v1_29", "v30_59", "v60_89", "v90p", "rating"];
  for (let r = 0; r < ROWS_LIST.length; r++) rowsData[ROWS_LIST[r]] = collectRow(r);

  const out = months.map((m, idx) => ({
    month: m,
    vigente: rowsData.vigente?.[idx] ?? 0,
    v1_29:   rowsData.v1_29?.[idx]   ?? 0,
    v30_59:  rowsData.v30_59?.[idx]  ?? 0,
    v60_89:  rowsData.v60_89?.[idx]  ?? 0,
    v90p:    rowsData.v90p?.[idx]    ?? 0,
    rating:  rowsData.rating?.[idx]  ?? null
  }));

  out.sort((a, b) => compareMonthTok(a.month, b.month));
  return { rows: out.slice(-12), historiaRaw: bloqueHistoria };
}

// ====== 3) modo “greedy” (mes + número de “Vigente” alrededor) (PATCH) ======
function parseHistoriaGreedy(fullText) {
  const bloque = getHistoriaBlock(fullText) || fullText;
  const lines = bloque.split(/\n/);
  const get = (i) => (i >=0 && i < lines.length ? lines[i] : "");

  const MES = /(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+(20\d{2})/i;
  // PATCH: patrón numérico estricto
  const NUM = /(?:[-]?\d{1,3}(?:[.,]\d{3})+|[-]?\d+(?:[.,]\d+)?)/g;
  const toMiles = (s) => {
    const c = String(s).replace(/\u00A0/g," ").trim()
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g,"").replace(/,/g,".");
    const n = Number(c);
    return Number.isFinite(n) ? Math.round(n*1000) : NaN;
  };

  const seen = new Set();
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MES);
    if (!m) continue;
    const mes = `${m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()} ${m[2]}`;
    if (seen.has(mes)) continue;
    seen.add(mes);

    // Ventana alrededor del mes (PATCH: elimina años)
    let window = [get(i-2), get(i-1), get(i), get(i+1), get(i+2), get(i+3)].join(" ");
    window = window.replace(/\b20\d{2}\b/g, "");

    // Prioriza números pegados a “Vigente” (sin espacios en el número)
    let vigente = 0;
    const m1 = window.match(/([\-]?\d{1,3}(?:[.,]\d{3})+|[\-]?\d+(?:[.,]\d+)?)\s*Vigente\b/i);
    const m2 = window.match(/\bVigente\b\s*([\-]?\d{1,3}(?:[.,]\d{3})+|[\-]?\d+(?:[.,]\d+)?)/i);
    if (m1?.[1] && !isYear(m1[1])) { const v = toMiles(m1[1]); if (Number.isFinite(v) && v>0) vigente = v; }
    if (!vigente && m2?.[1] && !isYear(m2[1])) { const v = toMiles(m2[1]); if (Number.isFinite(v) && v>0) vigente = v; }
    if (!vigente) {
      const nums = (window.match(NUM)||[])
        .filter(x => !isYear(x))
        .map(toMiles)
        .filter(n => Number.isFinite(n) && n>0 && n<=1_000_000);
      if (nums.length) vigente = Math.max(...nums);
    }

    rows.push({ month: mes, vigente: vigente||0, v1_29:0, v30_59:0, v60_89:0, v90p:0, rating:null });
  }

  rows.sort((a,b)=> compareMonthTok(a.month, b.month));
  return { rows: rows.slice(-12), historiaRaw: bloque };
}

// ===== Resumen Créditos Activos =====
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

  const bloque = sliceBetween(text, fromReList, toReList);
  const lineMatch = (bloque.match(/Totales[^\n]*/i) || [])[0] || (text.match(/Totales[^\n]*/i) || [])[0];
  if (!lineMatch) {
    return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
  }

  const base = bloque && bloque.includes(lineMatch) ? bloque : text;
  const pos = base.indexOf(lineMatch);
  const window = base.slice(Math.max(0, pos), pos + 800);

  // números sueltos, tolerando tokens pegados
  function splitStuckToken(tok) {
    const s = String(tok);
    if (/^\d{7,10}$/.test(s)) { const a = s.slice(0,-4), b = s.slice(-4); if (/^\d+$/.test(a) && /^\d+$/.test(b)) return [a,b]; }
    return [s];
  }
  const raw = (window.match(/\d{1,12}/g) || []);
  const nums = raw.flatMap(t => splitStuckToken(t))
                  .map(x => x.replace(/^0+/, "") || "0")
                  .map(x => parseInt(x,10))
                  .filter(n => Number.isFinite(n))
                  .filter(n => n>=1 && n<=999999);

  let triple = null;
  for (let i = 0; i <= nums.length-3; i++) {
    const a = nums[i], b = nums[i+1], c = nums[i+2];
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
    else return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
  }

  const original = toPesosMiles(triple.orig);
  const saldo    = toPesosMiles(triple.saldo);
  const vigente  = toPesosMiles(triple.vig);
  const vencido  = (typeof saldo === "number" && typeof vigente === "number") ? Math.max(0, saldo - vigente) : null;

  return { totalOriginalPesos: original, totalSaldoActualPesos: saldo, totalVigentePesos: vigente, totalVencidoPesos: vencido };
}

// ===== map/autoscale =====
function coerceNum(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }
function autoscaleHistory(items) {
  const vals = [];
  for (const r of items) { vals.push(r.vigente, r.v1_29, r.v30_59, r.v60_89, r.v90p); }
  const max = Math.max(0, ...vals.filter(n => Number.isFinite(n)));
  if (max > 0 && max < 100000) {
    return items.map(r => ({ ...r,
      vigente: r.vigente * 1000, v1_29: r.v1_29 * 1000, v30_59: r.v30_59 * 1000,
      v60_89: r.v60_89 * 1000, v90p: r.v90p * 1000
    }));
  }
  return items;
}
function mapHistoriaFromLib(hObj) {
  if (!hObj || !Array.isArray(hObj.filas)) return { rows: [], historiaRaw: "" };
  const arr = hObj.filas.slice(-12).map(r => ({
    month:   r.mes || null,
    vigente: coerceNum(r.vigente),
    v1_29:   coerceNum(r.d1_29),
    v30_59:  coerceNum(r.d30_59),
    v60_89:  coerceNum(r.d60_89),
    v90p:    coerceNum(r.d90_plus),
    rating:  r.calificacion || null,
  }));
  return { rows: autoscaleHistory(arr), historiaRaw: hObj.historiaRaw || "" };
}

// ===== Scoring & PI =====
function puntuar(val, flags) {
  const pts = {};
  const isMissing = (v) => v == null || v === "--" || (typeof v === "number" && !Number.isFinite(v));

  if (!isMissing(val[1]))  pts[1]  = val[1] === 0 ? 62 : val[1] <= 3 ? 50 : val[1] <= 7 ? 41 : 16; else { pts[1]=0; flags.push({id:1,tipo:"sin_info"}); }
  if (val[6] === "--" || val[6] == null) pts[6] = 52; else pts[6] = val[6] >= 0.93 ? 71 : val[6] >= 0.81 ? 54 : 17;
  if (!isMissing(val[9]))  pts[9]  = Number(val[9]) === 0 ? 54 : -19; else { pts[9]=0; flags.push({id:9,tipo:"sin_info"}); }
  if (val[11] === "--" || val[11] == null) pts[11] = 55; else pts[11] = Number(val[11]) === 0 ? 57 : 30;
  if (!isMissing(val[14])) pts[14] = Number(val[14]) === 0 ? 55 : -29; else { pts[14]=0; flags.push({id:14,tipo:"sin_info"}); }
  const udis = Number(val._udis) || 0; pts[15] = udis >= 1_000_000 ? 112 : 52;
  const m = Number(val[16]); pts[16] = Number.isFinite(m) ? (m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67) : (flags.push({id:16,tipo:"sin_info"}), 0);
  const mLast = Number(val[17]); pts[17] = Number.isFinite(mLast) ? (mLast > 0 && mLast <= 6 ? 46 : 58) : (flags.push({id:17,tipo:"sin_info"}), 0);

  const sumaIndicadores = Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, sumaIndicadores };
}
function calcularPI(score) {
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}
function detectaSinHistorial({ valores, historyMonthly, resumen }) {
  const tot0 = [resumen.totalSaldoActualPesos, resumen.totalVigentePesos, resumen.totalOriginalPesos].every(v => !v || v === 0);
  const meses0 = !(Array.isArray(historyMonthly) && historyMonthly.some(r => (r.vigente||0) > 0 || (r.v90p||0) > 0));
  const claves = [1,6,9,11,14,15,16,17];
  const sinInfo = claves.filter(k => valores[k] == null || valores[k] === "--").length >= 5;
  return tot0 && meses0 && sinInfo;
}

// ===== Handler =====
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const form = formidable({ multiples: false, keepExtensions: true });
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const file = files?.file?.[0] || files?.file;
    if (!file?.filepath) return res.status(400).json({ error: "No se recibió archivo" });

    const buffer = await readFile(file.filepath);
    const parsed = await pdfParse(buffer).catch((e) => { throw new Error("No se pudo leer el PDF: " + (e?.message || e)); });
    const text = normalizeText(parsed?.text || "");

    // ---- Califica ----
    const { indicadores = [], calificaRaw = null } = parseCalificaFromText(text) || {};
    const valores = {};
    for (const it of indicadores) {
      const id = Number(it.id);
      const n = parseNumLoose(it.valor);
      valores[id] = (n == null) ? "--" : n;
    }
    const ratioIds = [5,6,7,8,9,10,11,12];
    for (const id of ratioIds) if (valores[id] !== "--") valores[id] = clamp01(valores[id]);
    if (valores[16] === "--") valores[16] = null;
    if (valores[17] === "--") valores[17] = null;

    // UDIS desde ID 15
    const udi = Number(fields?.udi) || DEFAULT_UDI;
    const pesosMax = Number(valores[15] || 0);
    const udisMax  = pesosMax > 0 ? pesosMax / udi : 0;
    valores._udis  = Math.round(udisMax);

    // ---- Totales ----
    const resumen = parseResumenActivosRobusto(text);

    // ---- Historia (cascada de 3 estrategias) ----
    const flags = [];
    const canonicalMonths = extractHistoriaMonths(text);

    // 1) tabla precisa
    let { rows: historyMonthly, historiaRaw } = parseHistoriaTablaPrecisa(text);

    // 2) rejilla
    if ((!historyMonthly.length || historyMonthly.every(r => !r.vigente))) {
      const h1 = parseHistoriaMensual(text);
      if (h1.rows?.length) { historyMonthly = h1.rows; if (!historiaRaw) historiaRaw = h1.historiaRaw; }
    }

    // 3) greedy dentro de Historia
    if ((!historyMonthly.length || historyMonthly.every(r => !r.vigente))) {
      const h2 = parseHistoriaGreedy(text);
      if (h2.rows?.length) { historyMonthly = h2.rows; if (!historiaRaw) historiaRaw = h2.historiaRaw; }
    }

    // Si NO hay bloque “Historia:” legible, último recurso: desde Activos
    if (!canonicalMonths.length && (!historyMonthly.length || historyMonthly.every(r => !r.vigente))) {
      const h3 = parseHistoriaMensual(text.replace(/Historia[\s:]*\n?/i, "")); // intento extra
      if (h3.rows?.length) { historyMonthly = h3.rows; if (!historiaRaw) historiaRaw = h3.historiaRaw; }
      if (!historyMonthly.length) {
        // lib/parseHistoria como apoyo
        const fromLib = mapHistoriaFromLib(parseHistoriaFromText(text));
        if (fromLib.rows?.length) { historyMonthly = fromLib.rows; if (!historiaRaw) historiaRaw = fromLib.historiaRaw; }
      }
      if (!historyMonthly.length) {
        flags.push({ tipo: "historia_desde_activos", detalle: "No se halló bloque 'Historia:' legible; se intenta desde Activos." });
      }
    }

    // Orden y últimos 12
    if (Array.isArray(historyMonthly)) {
      historyMonthly.sort((a, b) => compareMonthTok(a.month, b.month));
      historyMonthly = historyMonthly.slice(-12);
    } else {
      historyMonthly = [];
    }

    // ---- Puntaje y PI ----
    const { pts, sumaIndicadores } = puntuar(valores, flags);
    const sinHistorial = detectaSinHistorial({ valores, historyMonthly, resumen });
    const baseAplicada = sinHistorial ? 0 : PUNTOS_BASE;
    if (sinHistorial) flags.push({ tipo: "sin_historial", detalle: "No se aplican 285 pb" });

    const puntajeTotal = baseAplicada + sumaIndicadores;
    const pi = calcularPI(puntajeTotal);

    // Códigos por ID (para la UI)
    const codigos = {};
    indicadores.forEach((x) => (codigos[Number(x.id)] = x.codigo));

    // Empresa
    const nombreEmpresa = extractEmpresa(text);

    return res.status(200).json({
      meta: { pages: parsed?.numpages || null },
      empresa: nombreEmpresa,
      calificaRaw,
      indicadores,
      codigos,
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
        maxCreditPesos: Number.isFinite(pesosMax) ? pesosMax : 0,
      },
      historyMonthly,
      historiaRaw // <- para ver lo que realmente leyó del PDF
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    return res.status(500).json({ error: e?.message || "Error procesando el PDF" });
  }
}

