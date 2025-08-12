import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";

export const config = { api: { bodyParser: false } };

const PUNTOS_BASE = 285;
const DEFAULT_UDI = 8.1462;

/* ======================= PUNTUACIÓN & PI ======================= */
function puntuar(val) {
  const pts = {};
  // 1
  pts[1] = val[1] === 0 ? 62 : val[1] <= 3 ? 50 : val[1] <= 7 ? 41 : 16;
  // 6
  if (val[6] === "--" || val[6] == null) pts[6] = 52;
  else pts[6] = val[6] >= 0.93 ? 71 : val[6] >= 0.81 ? 54 : 17;
  // 9
  pts[9] = Number(val[9]) === 0 ? 54 : -19;
  // 11
  if (val[11] === "--" || val[11] == null) pts[11] = 55;
  else pts[11] = Number(val[11]) === 0 ? 57 : 30;
  // 14
  pts[14] = Number(val[14]) === 0 ? 55 : -29;
  // 15 (usa _udis calculado)
  const udis = Number(val._udis) || 0;
  pts[15] = udis >= 1_000_000 ? 112 : 52;
  // 16
  const m = Number(val[16]) || 0;
  pts[16] = m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67;
  // 17
  const mLast = Number(val[17]) || 0;
  pts[17] = mLast > 0 && mLast <= 6 ? 46 : 58;

  const puntajeTotal = PUNTOS_BASE + Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, puntajeTotal };
}

function calcularPI(score) {
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}

/* ======================= HELPERS “TOTALES” ======================= */
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

  const nums = pickNumbersNormalized(window)
    .filter(n => n >= 1 && n <= 999999);

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
      if (/^(Direcci[oó]n|RFC|CURP|Datos Generales|Colonia|Del\.?\/Mun|Ciudad|C[óo]digo Postal|Estado|Pa[ií]s|Tel[eé]fono|Fax)/i.test(cand)) {
        continue;
      }
      return cand;
    }
  }
  return null;
}

/* ======================= HISTORIA MENSUAL (robusta) ======================= */
function parseHistoriaMensual(text) {
  const MONTH_RE = /(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}/gi;
  const toPesosMilesSafe = (n) => (Number.isFinite(n) ? n * 1000 : 0);
  const cleanNum = (s) => {
    if (!s) return 0;
    const m = String(s).replace(/[^\d\-]/g, "");
    return m ? parseInt(m, 10) : 0;
  };
  const takeNums = (line) =>
    (line.match(/-?\d[\d,\.]*/g) || []).map((t) => cleanNum(t));

  // Cortamos la sección Historia si existe un ancla clara
  const bloque = sliceBetween(
    text,
    [/Historia:/i, /Historia\s*:/i],
    [/(INFORMACI[ÓO]N\s+COMERCIAL)/i, /(DECLARATIVAS)/i, /(INFORMACI[ÓO]N\s+DE PLD)/i]
  ) || text;

  const lines = bloque.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  /* ---------- MODO A: REJILLA (fila = categoría; columnas = meses) ---------- */
  // Buscamos encabezado con varios meses en la misma línea
  let headerIdx = -1;
  let months = [];
  for (let i = 0; i < lines.length; i++) {
    const ms = (lines[i].match(MONTH_RE) || []);
    if (ms.length >= 4) {
      headerIdx = i;
      months = ms.map((m) => m.replace(/\s+/g, " ").trim());
      break;
    }
  }

  if (headerIdx !== -1 && months.length >= 4) {
    // Ventana de cuerpo debajo del encabezado
    const body = lines.slice(headerIdx + 1, headerIdx + 100);

    // Regex tolerantes a variantes
    const findRow = (res) => body.find((ln) => res.some((r) => r.test(ln))) || "";

    const rowVig  = findRow([/^Vigente\b/i]);
    const row129  = findRow([/^Vencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/i, /^1-?29\b/i]);
    const row3059 = findRow([/^Vencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/i, /^30-?59\b/i]);
    const row6089 = findRow([/^Vencido\s+de\s+60\s*a\s*89\s*d[ií]as\b/i, /^60-?89\b/i]);
    const row90p  = findRow([/^(Vencido\s+a\s+m[aá]s\s+de\s+89\s*d[ií]as|90\+|>89)\b/i, /^m[aá]s\s+de\s+89/i]);

    const numsV   = takeNums(rowVig);
    const nums12  = takeNums(row129);
    const nums35  = takeNums(row3059);
    const nums68  = takeNums(row6089);
    const nums90  = takeNums(row90p);

    const align = (arr, n) => {
      // Nos quedamos con los últimos n (lo más a la derecha suelen ser los meses del header)
      const a = arr.slice(-n);
      while (a.length < n) a.unshift(0);
      return a;
    };

    const v  = align(numsV,  months.length);
    const n12= align(nums12, months.length);
    const n35= align(nums35, months.length);
    const n68= align(nums68, months.length);
    const n90= align(nums90, months.length);

    // Calificación de cartera (si aparece en rejilla usualmente está por mes en otra tablita; aquí la omitimos)
    const out = months.map((m, i) => ({
      month: m,
      vigente: toPesosMilesSafe(v[i]),
      v1_29:   toPesosMilesSafe(n12[i]),
      v30_59:  toPesosMilesSafe(n35[i]),
      v60_89:  toPesosMilesSafe(n68[i]),
      v90p:    toPesosMilesSafe(n90[i]),
      rating: null
    }));

    return out.slice(-12);
  }

  /* ---------- MODO B: COLUMNA POR MES (fallback) ---------- */
  const isMonth = (s) => new RegExp(`^${MONTH_RE.source}$`, "i").test(s);

  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!isMonth(ln)) continue;

    const month = ln;
    const slice = lines.slice(i + 1, i + 20);

    const pickVal = (reList) => {
      const row = slice.find((s) => reList.some((r) => r.test(s)));
      if (!row) return 0;
      const nums = takeNums(row);
      const last = nums.length ? nums[nums.length - 1] : 0;
      return toPesosMilesSafe(last);
    };

    const vigente  = pickVal([/^Vigente\b/i]);
    const v1_29    = pickVal([/^Vencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/i, /^1-?29\b/i]);
    const v30_59   = pickVal([/^Vencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/i, /^30-?59\b/i]);
    const v60_89   = pickVal([/^Vencido\s+de\s+60\s*a\s*89\s*d[ií]as\b/i, /^60-?89\b/i]);
    const v90p     = pickVal([/^(Vencido\s+a\s+m[aá]s\s+de\s+89\s*d[ií]as|90\+|>89)\b/i, /^m[aá]s\s+de\s+89/i]);

    let rating = null;
    const carLine = slice.find((s) => /^Calificaci[oó]n\s+de\s+Cartera\b/i.test(s));
    if (carLine) {
      const toks = carLine.split(/\s+/).filter(Boolean);
      rating = toks[toks.length - 1] || null;
    }

    result.push({ month, vigente, v1_29, v30_59, v60_89, v90p, rating });
  }

  return result.slice(-12);
}

/* ======================= HANDLER ======================= */
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

    // Califica
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

    // Puntaje y PI
    const { pts, puntajeTotal } = puntuar(valores);
    const pi = calcularPI(puntajeTotal);

    // Totales
    const {
      totalOriginalPesos,
      totalSaldoActualPesos,
      totalVigentePesos,
      totalVencidoPesos,
    } = parseResumenActivosRobusto(text);

    // Historia mensual (ya multiplicada x 1000 adentro)
    const historyMonthly = parseHistoriaMensual(text);

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
      summary: {
        totalOriginalPesos,
        totalSaldoActualPesos,
        totalVigentePesos,
        totalVencidoPesos,
        maxCreditPesos: pesosMax,
      },
      historyMonthly,
    });
  } catch (e) {
    console.error("analyzePdf error:", e);
    return res.status(500).json({ error: e?.message || "Error procesando el PDF" });
  }
}
