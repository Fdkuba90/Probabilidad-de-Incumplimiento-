// pages/api/analyzePdf.js — versión completa con extractor de Historia robusto (tolerante a dígitos con espacios)
// - Normaliza el texto del PDF
// - Historia mensual (vertical) usando NUM_TOKEN que re-arma números tipo "8 7 3 2" -> 8732
// - Fija Calificación de Cartera con tokens tipo 1A2, 1C2
// - Aplica/no aplica 285 pb según "sin historial" (heurística)
// - Devuelve flags de trazabilidad

import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";
import { parseHistoriaFromText } from "../../lib/parseHistoria.js";

export const config = {
  api: { bodyParser: false, sizeLimit: "25mb", externalResolver: true },
};

const PUNTOS_BASE = 285;
const DEFAULT_UDI = 8.1462;

/* ======================= UTILS ======================= */
function normalizeText(text = "") {
  return (text || "")
    .replace(/\u00A0/g, " ")            // NBSP -> space
    .replace(/[\t\r]+/g, " ")           // tabs/CR -> space
    .replace(/[ ]{2,}/g, " ")            // multi-spaces
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n");
}

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
  if (/^\d{7,10}$/.test(s)) {
    const a = s.slice(0, -4), b = s.slice(-4);
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return [a, b];
  }
  return [s];
}
function pickNumbersNormalized(str) {
  const raw = (str.match(/\d{1,12}/g) || []);
  const flat = [];
  for (const t of raw) flat.push(...splitStuckToken(t));
  return flat
    .map(x => x.replace(/^0+/, "") || "0")
    .map(x => parseInt(x, 10))
    .filter(n => Number.isFinite(n));
}
const toPesosMiles = (n) => (n == null ? null : Math.round(n * 1000));

/* ======================= RESUMEN CRÉDITOS ACTIVOS ======================= */
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
  const lineMatch = (bloque.match(/Totales[^\r\n]*/i) || [])[0]
                 || (text.match(/Totales[^\r\n]*/i) || [])[0];
  if (!lineMatch) {
    return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
  }

  const base = bloque && bloque.includes(lineMatch) ? bloque : text;
  const pos = base.indexOf(lineMatch);
  const window = base.slice(Math.max(0, pos), pos + 800);

  const nums = pickNumbersNormalized(window).filter(n => n >= 1 && n <= 999999);

  let triple = null;
  for (let i = 0; i <= nums.length - 3; i++) {
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
    if (tail.length === 3) {
      if (tail[1] === tail[2]) triple = { orig: tail[0], saldo: tail[1], vig: tail[2] };
      else triple = { orig: tail[0], saldo: tail[1], vig: tail[2] };
    } else {
      return { totalOriginalPesos: null, totalSaldoActualPesos: null, totalVigentePesos: null, totalVencidoPesos: null };
    }
  }

  const original = toPesosMiles(triple.orig);
  const saldo    = toPesosMiles(triple.saldo);
  const vigente  = toPesosMiles(triple.vig);
  const vencido  = (typeof saldo === "number" && typeof vigente === "number") ? Math.max(0, saldo - vigente) : null;

  return {
    totalOriginalPesos: original,
    totalSaldoActualPesos: saldo,
    totalVigentePesos: vigente,
    totalVencidoPesos: vencido,
  };
}

/* ======================= EMPRESA ======================= */
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

/* ======================= HISTORIA — Estrategia 0: vertical (miles, robusto) ======================= */
function parseHistoriaVerticalMiles(fullText) {
  const historia = sliceBetween(
    fullText,
    [/^\s*Historia\b:?/im],
    [/^\s*INFORMACI[ÓO]N\s+COMERCIAL\b/im, /^\s*Califica\b/im, /^\s*DECLARATIVAS\b/im, /^\s*INFORMACI[ÓO]N\s+DE\s+PLD\b/im, /^\s*FIN DEL REPORTE\b/im]
  );
  if (!historia) return [];

  const lines = historia.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const MES_RE = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}\b/i;

  // Acepta números con dígitos separados por espacios/NBSP y/o separadores de miles
  const NUM_TOKEN = /-?(?:\d[\s\u00A0.,]?){1,12}/g;
  const toNumRobusto = (s) => {
    if (!s) return NaN;
    const canon = String(s)
      .replace(/\u00A0/g, " ")
      .replace(/\s+/g, "")       // "8 7 3 2" -> "8732"
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "") // separadores de miles
      .replace(/,/g, ".");       // coma decimal a punto
    const n = Number(canon);
    if (!Number.isFinite(n)) return NaN;
    if (n < 0) return NaN;
    if (String(Math.trunc(n)).length < 3) return NaN; // evita tokens sueltos (1–2 dígitos)
    return Math.round(n * 1000); // PDF viene en miles de pesos
  };

  // localizar meses
  const months = [];
  const monthIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (MES_RE.test(lines[i])) { months.push(lines[i]); monthIdx.push(i); }
  }
  if (!months.length) return [];

  const vigente = new Array(months.length).fill(0);

  // por cada mes: escanear hasta el inicio del siguiente mes
  for (let k = 0; k < months.length; k++) {
    const start = monthIdx[k];
    const end = k + 1 < months.length ? monthIdx[k + 1] : Math.min(lines.length, start + 120);

    // buscamos en el bloque completo entre meses
    const seg = lines.slice(start + 1, end).join(" ");
    const tokens = seg.match(NUM_TOKEN) || [];
    let values = tokens.map(toNumRobusto).filter(Number.isFinite);

    // si no hay valores grandes, intenta también las primeras líneas del bloque
    if (!values.length) {
      const head = lines.slice(start + 1, Math.min(end, start + 8)).join(" ");
      const headTokens = head.match(NUM_TOKEN) || [];
      values = headTokens.map(toNumRobusto).filter(Number.isFinite);
    }

    // acota a valores razonables (0–50,000,000 MXN)
    const filtered = values.filter(v => v >= 0 && v <= 50_000_000);
    vigente[k] = (filtered.length ? Math.max(...filtered) : (values.length ? Math.max(...values) : 0));
  }

  // Calificación de Cartera (tokens tipo 1A2, 1C2, etc.)
  let ratings = new Array(months.length).fill(null);
  const calStart = lines.findIndex(l => /^Calificaci[oó]n\s+de\s+Cartera\b/i.test(l));
  if (calStart !== -1) {
    const raw = lines.slice(calStart, calStart + 60).join(" ");
    const toks = raw.match(/\b\d[A-Z]\d\b/gi) || [];
    const slice = toks.slice(-months.length).map(t => t.toUpperCase());
    for (let i = 0; i < slice.length; i++) ratings[i + (months.length - slice.length)] = slice[i];
  }

  return months.slice(-12).map((month, i) => ({
    month,
    vigente: vigente[i] || 0,
    v1_29: 0,
    v30_59: 0,
    v60_89: 0,
    v90p: 0,
    rating: ratings[i] || null
  }));
}

/* ======================= HISTORIA — Estrategia 1: rejilla ======================= */
function parseHistoriaMensual(text) {
  const bloqueHistoria = sliceBetween(
    text,
    [/Historia:/i, /Historia\s*:/i, /Hist[oó]rico/i],
    [/(INFORMACI[ÓO]N\s+COMERCIAL)/i, /(DECLARATIVAS)/i, /(INFORMACI[ÓO]N\s+DE PLD)/i]
  ) || text;

  const lines = bloqueHistoria.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const MONTH_TOKEN = /\b(?:Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}\b/g;

  let headerIdx = -1;
  let months = [];
  for (let i = 0; i < lines.length; i++) {
    const ms = lines[i].match(MONTH_TOKEN);
    if (ms && ms.length >= 4) {
      if (ms.length > months.length) { months = ms.map(m => m.replace(/\s+/g, " ").trim()); headerIdx = i; }
    }
  }

  const toPesosMilesSafe = (n) => (Number.isFinite(n) ? n * 1000 : 0);
  const numsFrom = (s) => (s.match(/-?\d{1,7}/g) || []).map(x => parseInt(x, 10)).filter(Number.isFinite);
  const toksFrom = (s) => (s.match(/[A-Z0-9ÁÉÍÓÚÑ\+\-]{2,10}/gi) || []);

  if (headerIdx !== -1 && months.length >= 4) {
    const ROWS = [
      { key: "vigente",  re: /^Vigente\b/i,                           numeric: true  },
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
      for (let i = start; i < Math.min(lines.length, start + 80); i++) {
        const ln = lines[i];
        if (nextRes.some(r => r.test(ln))) break;
        if (ROWS[rowIndex].numeric) accNums.push(...numsFrom(ln));
        else accToks.push(...toksFrom(ln));
      }

      if (ROWS[rowIndex].numeric) {
        const slice = accNums.slice(-months.length);
        while (slice.length < months.length) slice.unshift(0);
        return slice.map(toPesosMilesSafe);
      } else {
        const onlyAlpha = accToks.filter(t => !/^\d+$/.test(t));
        const slice = onlyAlpha.slice(-months.length);
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

    return out.slice(-12);
  }

  // fallback columnas por mes
  const isMonth = (s) => new RegExp(`^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\\s+20\\d{2}$`, "i").test(s);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!isMonth(ln)) continue;

    const month = ln;
    const slice = lines.slice(i + 1, i + 20);

    const numsFrom = (s) => (s.match(/-?\d{1,7}/g) || []).map(x => parseInt(x, 10)).filter(Number.isFinite);
    const toPesosMilesSafe = (n) => (Number.isFinite(n) ? n * 1000 : 0);

    const pickVal = (reList) => {
      const row = slice.find((s) => reList.some((r) => r.test(s)));
      if (!row) return 0;
      const nums = numsFrom(row);
      const last = nums.length ? nums[nums.length - 1] : 0;
      return toPesosMilesSafe(last);
    };

    const vigente  = pickVal([/^Vigente\b/i]);
    const v1_29    = pickVal([/^Vencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/i, /^1-?29\b/i]);
    const v30_59   = pickVal([/^Vencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/i, /^30-?59\b/i]);
    const v60_89   = pickVal([/^Vencido\s+de\s+60\s*a\s*89\s*d[ií]as\b/i, /^60-?89\b/i]);
    const v90p     = pickVal([/^(Vencido\s+a\s*m[aá]s\s*de\s*89\s*d[ií]as|90\+|>89)\b/i, /^m[aá]s\s+de\s+89/i]);

    let rating = null;
    const carLine = slice.find((s) => /^Calificaci[oó]n\s+de\s+Cartera\b/i.test(s));
    if (carLine) {
      const m = carLine.match(/\b\d[A-Z]\d\b/gi);
      rating = m ? m[m.length - 1].toUpperCase() : null;
    }

    result.push({ month, vigente, v1_29, v30_59, v60_89, v90p, rating });
  }

  return result.slice(-12);
}

/* ======= HISTORIA — Estrategia 2: desde “Créditos Activos” ======= */
function parseHistoriaMensualDesdeActivos(text) {
  const bloque = sliceBetween(
    text,
    [/Cr[eé]ditos?\s+Activos?:/i, /INFORMACI[ÓO]N\s+CREDITICIA/i],
    [/Resumen\s+Cr[eé]ditos?\s+Activos?/i, /Cr[eé]ditos?\s+Liquidados?/i]
  );
  if (!bloque) return [];

  const re = /([01]\d-\d{4})\s+(\d{1,6})\s+(\d{1,9})\s+(\d{1,9})\s+(\d{1,9})\s+(\d{1,9})\s+(\d{1,9})\s+(\d{1,9})\s+(\d{1,9})\s+(\d{1,9})/g;
  const agg = new Map();
  const toMonthToken = (mmYYYY) => {
    const [mm, yyyy] = mmYYYY.split("-");
    const M = { "01":"Ene","02":"Feb","03":"Mar","04":"Abr","05":"May","06":"Jun","07":"Jul","08":"Ago","09":"Sep","10":"Oct","11":"Nov","12":"Dic" }[mm] || mm;
    return `${M} ${yyyy}`;
  };

  let m;
  while ((m = re.exec(bloque)) !== null) {
    const monthTok = toMonthToken(m[1]);

    const vigente  = Number(m[4]) || 0;
    const v1_29    = Number(m[5]) || 0;
    const v30_59   = Number(m[6]) || 0;
    const v60_89   = Number(m[7]) || 0;
    const v90p     = (Number(m[8]) || 0) + (Number(m[9]) || 0) + (Number(m[10]) || 0);

    const cur = agg.get(monthTok) || { month: monthTok, vigente:0, v1_29:0, v30_59:0, v60_89:0, v90p:0, rating: null };
    cur.vigente += vigente * 1000;
    cur.v1_29   += v1_29   * 1000;
    cur.v30_59  += v30_59  * 1000;
    cur.v60_89  += v60_89  * 1000;
    cur.v90p    += v90p    * 1000;
    agg.set(monthTok, cur);
  }

  const order = Array.from(agg.values()).sort((a, b) => {
    const [ma, ya] = a.month.split(" "); const [mb, yb] = b.month.split(" ");
    const ix = (m) => "Ene Feb Mar Abr May Jun Jul Ago Sep Oct Nov Dic".split(" ").indexOf(m);
    return ya === yb ? ix(ma) - ix(mb) : Number(ya) - Number(yb);
  });

  return order.slice(-12);
}

/* ======================= MAP/AUTOSCALE para parseHistoriaFromText ======================= */
function coerceNum(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }
function autoscaleHistory(items) {
  const vals = [];
  for (const r of items) { vals.push(r.vigente, r.v1_29, r.v30_59, r.v60_89, r.v90p); }
  const max = Math.max(0, ...vals.filter(n => Number.isFinite(n)));
  if (max > 0 && max < 100000) {
    return items.map(r => ({
      ...r,
      vigente: r.vigente * 1000,
      v1_29:   r.v1_29   * 1000,
      v30_59:  r.v30_59  * 1000,
      v60_89:  r.v60_89  * 1000,
      v90p:    r.v90p    * 1000,
    }));
  }
  return items;
}
function mapHistoriaFromLib(hObj) {
  if (!hObj || !Array.isArray(hObj.filas)) return [];
  const arr = hObj.filas.slice(-12).map(r => ({
    month:   r.mes || null,
    vigente: coerceNum(r.vigente),
    v1_29:   coerceNum(r.d1_29),
    v30_59:  coerceNum(r.d30_59),
    v60_89:  coerceNum(r.d60_89),
    v90p:    coerceNum(r.d90_plus),
    rating:  r.calificacion || null,
  }));
  return autoscaleHistory(arr);
}

/* ======================= PUNTUACIÓN & PI ======================= */
function puntuar(val, flags) {
  const pts = {};

  const isMissing = (v) => v == null || v === "--" || (typeof v === "number" && !Number.isFinite(v));

  // 1 — Antigüedad sin atrasos (ejemplo)
  if (!isMissing(val[1])) {
    pts[1] = val[1] === 0 ? 62 : val[1] <= 3 ? 50 : val[1] <= 7 ? 41 : 16;
  } else {
    pts[1] = 0; flags.push({ id: 1, tipo: "sin_info" });
  }

  // 6 — Ratio pago/carga financiera
  if (val[6] === "--" || val[6] == null) pts[6] = 52; // sin información
  else pts[6] = val[6] >= 0.93 ? 71 : val[6] >= 0.81 ? 54 : 17;

  // 9 — Demandas / juicios (0/1). Si no hay info, no penalizar
  if (!isMissing(val[9])) {
    pts[9] = Number(val[9]) === 0 ? 54 : -19;
  } else {
    pts[9] = 0; flags.push({ id: 9, tipo: "sin_info" });
  }

  // 11 — Consultas recientes; "--" -> sin información (regla explícita)
  if (val[11] === "--" || val[11] == null) pts[11] = 55;
  else pts[11] = Number(val[11]) === 0 ? 57 : 30;

  // 14 — Cheques devueltos (0/1). Si no hay info, no penalizar
  if (!isMissing(val[14])) {
    pts[14] = Number(val[14]) === 0 ? 55 : -29;
  } else {
    pts[14] = 0; flags.push({ id: 14, tipo: "sin_info" });
  }

  // 15 — Monto máximo en UDIS (usa _udis)
  const udis = Number(val._udis) || 0;
  pts[15] = udis >= 1_000_000 ? 112 : 52;

  // 16 — Antigüedad empresa (meses)
  const m = Number(val[16]);
  if (Number.isFinite(m)) {
    pts[16] = m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67;
  } else {
    pts[16] = 0; flags.push({ id: 16, tipo: "sin_info" });
  }

  // 17 — Antigüedad último crédito (meses)
  const mLast = Number(val[17]);
  if (Number.isFinite(mLast)) {
    pts[17] = mLast > 0 && mLast <= 6 ? 46 : 58;
  } else {
    pts[17] = 0; flags.push({ id: 17, tipo: "sin_info" });
  }

  // La suma SIN base, la base se añadirá según tenga/no tenga historial
  const sumaIndicadores = Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, sumaIndicadores };
}

function calcularPI(score) {
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}

/* ======================= DETECCIÓN DE HISTORIAL ======================= */
function detectaSinHistorial({ valores, historyMonthly, resumen }) {
  const tot0 = [resumen.totalSaldoActualPesos, resumen.totalVigentePesos, resumen.totalOriginalPesos]
    .every(v => !v || v === 0);
  const meses0 = !(Array.isArray(historyMonthly) && historyMonthly.some(r => (r.vigente||0) > 0 || (r.v90p||0) > 0));
  const claves = [1,6,9,11,14,15,16,17];
  const sinInfo = claves.filter(k => valores[k] == null || valores[k] === "--").length >= 5; // mayoría
  return tot0 && meses0 && sinInfo;
}

/* ======================= HANDLER ======================= */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const form = formidable({ multiples: false, keepExtensions: true });
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const file = files?.file?.[0] || files?.file;
    if (!file?.filepath) return res.status(400).send("No se recibió archivo");

    const buffer = await readFile(file.filepath);

    const parsed = await pdfParse(buffer).catch((e) => {
      throw new Error("No se pudo leer el PDF: " + (e?.message || e));
    });

    const rawText = parsed?.text || "";
    const text = normalizeText(rawText);

    // Califica (IDs/valores/códigos)
    const { indicadores = [], calificaRaw = null } = parseCalificaFromText(text) || {};

    const valores = {};
    for (const it of indicadores) {
      const raw = String(it.valor ?? "").trim();
      if (raw === "--" || raw === "") valores[Number(it.id)] = "--"; else valores[Number(it.id)] = Number(String(raw).replace(/,/g, ""));
    }

    // ID 15: pesos → UDIS (para puntaje)
    const udi = Number(fields?.udi) || DEFAULT_UDI;
    const pesosMax = Number(valores[15] || 0);
    const udisMax  = pesosMax > 0 ? pesosMax / udi : 0;
    valores._udis  = Math.round(udisMax);

    // Totales (antes de puntuar, porque influyen en "sin historial")
    const resumen = parseResumenActivosRobusto(text);

    // Historia mensual — 0) vertical; 1) rejilla; 2) lib; 3) desde Activos
    let historyMonthly = parseHistoriaVerticalMiles(text);
    if (!historyMonthly || historyMonthly.length === 0) historyMonthly = parseHistoriaMensual(text);
    if (!historyMonthly || historyMonthly.length === 0) {
      const h2 = parseHistoriaFromText(text);
      historyMonthly = mapHistoriaFromLib(h2);
    }
    if (!historyMonthly || historyMonthly.length === 0) historyMonthly = parseHistoriaMensualDesdeActivos(text);

    // Flags de trazabilidad para "sin información", etc.
    const flags = [];

    // Puntaje por indicadores (sin base)
    const { pts, sumaIndicadores } = puntuar(valores, flags);

    // ¿Sin historial? => NO aplicar PUNTOS_BASE
    const sinHistorial = detectaSinHistorial({ valores, historyMonthly, resumen });
    const baseAplicada = sinHistorial ? 0 : PUNTOS_BASE;
    if (sinHistorial) flags.push({ tipo: "sin_historial", detalle: "No se aplican 285 pb" });

    const puntajeTotal = baseAplicada + sumaIndicadores;
    const pi = calcularPI(puntajeTotal);

    // Códigos por ID
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
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    return res.status(500).json({ error: e?.message || "Error procesando el PDF" });
  }
}
