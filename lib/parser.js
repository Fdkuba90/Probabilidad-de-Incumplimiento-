// lib/parser.js
import pdfParse from "pdf-parse";
import { extractCreditosActivosByCoords } from "./coords";

/* ========= util ========= */
function norm(text = "") {
  return (text || "")
    .replace(/\u00A0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ");
}
function toNumber(s) {
  if (s == null) return null;
  const clean = String(s).trim().replace(/\$/g, "").replace(/,/g, "").replace(/\s+/g, "");
  if (clean === "" || clean === "--") return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
const NUM_RE = /-?\d{1,3}(?:[ ,]\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

/* ========= Razón Social ========= */
function extractRazonSocial(text) {
  const label = /(denominaci[oó]n\s+(?:o\s+)?raz[oó]n\s+social|nombre\s*\/\s*raz[oó]n\s+social|raz[oó]n\s+social)/i;

  { // Valor antes del label
    const re = new RegExp(String.raw`([^\n]{3,120})\s*${label.source}\s*:`, "i");
    const m = text.match(re);
    if (m?.[1] && !/^(rfc|direcci[oó]n|domicilio|folio|fecha|p[aá]gina|documento)/i.test(m[1])) {
      return m[1].trim().replace(/^\W+/, "");
    }
  }
  { // Misma línea
    const re = new RegExp(String.raw`${label.source}\s*:?\s*([^\n]+)`, "i");
    const m = text.match(re);
    if (m?.[2] && !/^(rfc|direcci[oó]n|domicilio|folio|fecha|p[aá]gina|documento)/i.test(m[2])) {
      return m[2].trim();
    }
  }
  // Siguiente línea
  const lines = text.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (label.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const s = lines[j]?.trim();
        if (!s) continue;
        if (/^(rfc|direcci[oó]n|domicilio|folio|fecha|p[aá]gina|documento|informaci[oó]n)/i.test(s)) break;
        if (label.test(s)) continue;
        return s.replace(/^\W+/, "").trim();
      }
    }
  }
  // Fallback por forma jurídica
  const corpRe = /\b(S\.?A\.?(?:\s+DE)?\s+C\.?V\.?|S\.?A\.?P\.?I\.?(?:\s+DE\s+C\.?V\.?)?|S\.?\s+DE\s+R\.?L\.?(?:\s+DE\s+C\.?V\.?)?|SAPI\s+DE\s+CV|S\.A\.|S\s+de\s+RL)\b/i;
  const cand = text.split("\n").map((l)=>l.trim()).find((l) => corpRe.test(l) && l.length <= 120);
  return cand || "";
}

/* ========= RFC ========= */
function extractRFC(text) {
  const lines = text.split("\n").map(l => l.trim());

  const mSame = text.match(/RFC\s*:?\s*([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i);
  if (mSame?.[1]) return mSame[1].toUpperCase();

  for (let i = 0; i < lines.length; i++) {
    if (/^RFC\b/i.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const m = lines[j].match(/([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i);
        if (m?.[1]) return m[1].toUpperCase();
      }
    }
  }

  const mAny = text.match(/(?:^|[^A-Z0-9])([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})(?![A-Z0-9])/i);
  if (mAny?.[1]) return mAny[1].toUpperCase();

  return "";
}

/* ========= Califica/Calificador ========= */
const KNOWN_CODES = new Set([
  // Sin atrasos
  "BK12_NUM_CRED","NBK12_PCT_PROMT","BK24_PCT_60PLUS","NBK12_COMM_PCT_PLUS",
  "BK12_IND_QCRA","BK12_MAX_CREDIT_AMT","MONTHS_ON_FILE_BANKING","MONTHS_SINCE_LAST_OPEN_BANKING",
  // Con atrasos
  "BK12_NUM_EXP_PAIDONTIME","BK12_PCT_PROMT","BK12_PCT_SAT","BK12_PCT_90PLUS","BK12_DPD_PROM",
]);
const ID_WHITELIST = new Set([1,4,5,6,7,9,11,12,13,14,15,16,17]);

function extractCalificaRows(text) {
  let scope = text;
  const m = text.match(/Calific(?:a|ador)\b/i);
  if (m) {
    const idx = text.indexOf(m[0]);
    scope = text.slice(idx, idx + 20000);
  }
  if (!m) scope = text;

  const lineRe = /^\s*([0-9]{1,2})\s+([A-Z0-9_]{2,})\s+([^\n\r]+?)\s*$/gmi;
  const rows = [];
  let k;
  while ((k = lineRe.exec(scope))) {
    const id = Number(k[1]);
    const codigo = k[2].trim();
    const valorRaw = k[3].trim();
    if (!KNOWN_CODES.has(codigo) && !ID_WHITELIST.has(id)) continue;
    if (id < 0 || id > 99) continue;
    rows.push({ id, codigo, valorRaw });
  }
  const seen = new Set();
  return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/* ========= Fallbacks de totales (texto) ========= */
function sumCreditosActivosByRows(text) {
  const start = text.search(/Cr[eé]ditos?\s+Activos?\s*:/i);
  if (start < 0) return null;
  let scope = text.slice(start);
  const lastTot = scope.lastIndexOf("Totales:");
  if (lastTot > 0) scope = scope.slice(0, lastTot);

  scope = scope
    .replace(/MXP\s*@\s*\$\s*1\.?00?/gi, " ")
    .replace(/\b\d{1,2}-\d{4}\b/g, " ")
    .replace(/\b(1-29|30-59|60-89|90-119|120-179|180\+)\b/gi, " ");

  const lines = scope.split("\n").map((l)=>l.trim()).filter(Boolean);

  let original = 0, vigente = 0;
  let d1_29 = 0, d30_59 = 0, d60_89 = 0, d90_119 = 0, d120_179 = 0, d180_plus = 0;
  let rows = 0;

  for (const line of lines) {
    const nums = (line.match(NUM_RE) || []).map(toNumber).filter((n) => Number.isFinite(n) && n >= 0 && n <= 500_000);
    if (nums.length < 9) continue;
    const tail = nums.slice(-9);
    const [o, v, b1=0, b30=0, b60=0, b90=0, b120=0, b180=0] = tail;
    if (![o,v,b1,b30,b60,b90,b120,b180].every((x)=>Number.isFinite(x) && x>=0)) continue;

    original += Math.round(o);
    vigente  += Math.round(v);
    d1_29    += Math.round(b1);
    d30_59   += Math.round(b30);
    d60_89   += Math.round(b60);
    d90_119  += Math.round(b90);
    d120_179 += Math.round(b120);
    d180_plus+= Math.round(b180);
    rows++;
  }

  if (!rows) return null;
  const vencido = d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus;
  return {
    original, vigente,
    saldo: vigente + vencido,
    vencido,
    d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus,
    _debug_rows: rows
  };
}

function extractTotalesRow(text) {
  let scope = text;
  const iBlock = text.search(/Cr[eé]ditos?\s+Activos?\s*:/i);
  if (iBlock >= 0) scope = text.slice(iBlock, iBlock + 25000);

  const lines = scope.split("\n");
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) if (/Totales\s*:/.test(lines[i])) lastIdx = i;
  if (lastIdx === -1) return null;

  let win = lines.slice(Math.max(0, lastIdx - 10), Math.min(lines.length, lastIdx + 6)).join(" ");
  win = win
    .replace(/\b\d{1,2}-\d{4}\b/g, " ")
    .replace(/\b\d{1,3}-\d{1,3}\b/g, " ")
    .replace(/MXP\s*@\s*\$\s*1\.?00?/gi, " ");

  const all = (win.match(NUM_RE) || []).map(toNumber).filter((n) => Number.isFinite(n) && n >= 0 && n <= 500_000);

  let best = null, bestScore = -1;
  for (let size = 10; size >= 8; size--) {
    for (let i = 0; i + size <= all.length; i++) {
      const c = all.slice(i, i + size);
      const o = c[0], v = c[1];
      if (o == null || v == null) continue;
      const score = o * 1_000_000 + v;
      if (score > bestScore) { best = c.slice(0, 8); bestScore = score; }
    }
    if (best) break;
  }
  if (!best || best.length < 8) return null;

  const [o, v, b1=0, b30=0, b60=0, b90=0, b120=0, b180=0] = best;
  const d1_29 = Math.round(b1), d30_59=Math.round(b30), d60_89=Math.round(b60),
        d90_119=Math.round(b90), d120_179=Math.round(b120), d180_plus=Math.round(b180);
  const vencido = d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus;

  return {
    original: Math.round(o||0),
    vigente:  Math.round(v||0),
    saldo:    Math.round((v||0)+vencido),
    vencido,
    d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus,
    _debug_totalesBest: best
  };
}

/* ========= Export principal ========= */
export async function parsePdf(buffer) {
  const parsed = await pdfParse(buffer);
  const text = norm(parsed.text || "");

  const razonSocial  = extractRazonSocial(text);
  const rfc          = extractRFC(text);
  const calificaRows = extractCalificaRows(text);

  // === Créditos Activos: Coordenadas → Fallback por texto ===
  let tot = null;

  // A) Coordenadas (nuevo coords.js robusto)
  try {
    const byCoords = await extractCreditosActivosByCoords(buffer);
    if (byCoords && (byCoords.original != null || byCoords.vigente != null)) {
      const b = byCoords.buckets || {};
      const d1_29     = Math.round(b.v1_29   || 0);
      const d30_59    = Math.round(b.v30_59  || 0);
      const d60_89    = Math.round(b.v60_89  || 0);
      const d90_119   = Math.round(b.v90_119 || 0);
      const d120_179  = Math.round(b.v120_179|| 0);
      const d180_plus = Math.round(b.v180p   || 0);
      const vigente   = Math.round(byCoords.vigente || 0);
      const original  = Math.round(byCoords.original || 0);
      const vencido   = d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus;
      tot = {
        original, vigente,
        saldo: vigente + vencido,
        vencido,
        d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus,
        _debug_coords: byCoords._debug_coords || null,
      };
    }
  } catch {}

  // B) Fallback por texto (sumas por filas)
  if (!tot) tot = sumCreditosActivosByRows(text);

  // C) Último recurso: fila Totales por texto
  if (!tot) tot = extractTotalesRow(text);

  // D) Si aun así no, cero
  if (!tot) tot = { original: 0, vigente: 0, saldo: 0, vencido: 0,
    d1_29:0, d30_59:0, d60_89:0, d90_119:0, d120_179:0, d180_plus:0 };

  const {
    original=0, vigente=0, saldo=0,
    vencido: vCalc,
    d1_29=0, d30_59=0, d60_89=0, d90_119=0, d120_179=0, d180_plus=0,
    _debug_coords, _debug_rows, _debug_totalesBest
  } = tot;

  const vencido = vCalc != null ? Math.round(vCalc)
    : Math.round(d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus);

  const milesDePesos = /todas las cantidades.*miles de pesos/i.test(text);

  const debug = {
    coords: _debug_coords ?? null,
    rows:   _debug_rows ?? null,
    totales_best: _debug_totalesBest ?? null
  };

  const totales = {
    original: Math.round(original),
    vigente:  Math.round(vigente),
    saldo:    Math.round(saldo),
    vencido,
    d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus
  };

  return { razonSocial, rfc, calificaRows, totales, milesDePesos, _debug: debug };
}
