// pages/api/analyzePdf.js
import formidable from "formidable";
import pdfParse from "pdf-parse";
import { readFile } from "fs/promises";
import { parseCalificaFromText } from "../../lib/parseCalifica";
import { parseHistoriaFromText } from "../../lib/parseHistoria.js";

// ❗ Vercel (Node runtimes) — sin bodyParser porque viene multipart
export const config = {
  api: { bodyParser: false, sizeLimit: "25mb", externalResolver: true },
};

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

/* ======================= HELPERS BASE ======================= */
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

/* ======================= TOTALES (Resumen Créditos Activos) ======================= */
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

/* ======================= HISTORIA MENSUAL — modo rejilla ======================= */
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
      if (ms.length > months.length) {
        months = ms.map(m => m.replace(/\s+/g, " ").trim());
        headerIdx = i;
      }
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
      { key: "v90p",     re: /^(Vencido\s+a\s+m[aá]s\s+de\s*89\s*d[ií]as|90\+|>89)\b/i, numeric: true  },
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

  // fallback por columnas mes a mes (cuando no hay rejilla)
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
    const v90p     = pickVal([/^(Vencido\s+a\s+m[aá]s\s+de\s*89\s*d[ií]as|90\+|>89)\b/i, /^m[aá]s\s+de\s+89/i]);

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

/* ======= HISTORIA desde “Créditos Activos” (tercer intento) ======= */
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
    const M = {
      "01":"Ene","02":"Feb","03":"Mar","04":"Abr","05":"May","06":"Jun",
      "07":"Jul","08":"Ago","09":"Sep","10":"Oct","11":"Nov","12":"Dic"
    }[mm] || mm;
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

/* ======================= FIX: Mapear + Autoscale ======================= */
function coerceNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
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
function autoscaleHistory(items) {
  // Si los importes son muy pequeños (p.ej. < 100,000) pero deberían ser MXN,
  // asumimos que vienen en MIL y escalamos ×1000.
  const vals = [];
  for (const r of items) {
    vals.push(r.vigente, r.v1_29, r.v30_59, r.v60_89, r.v90p);
  }
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
    const parsed = await pdfParse(buffer);
    const text = parsed?.text || "";

    // Califica
    const { indicadores, calificaRaw } = parseCalificaFromText(text);
    const valores = {};
    for (const it of indicadores) {
      const raw = String(it.valor).trim();
      valores[Number(it.id)] = raw === "--" ? "--" : Number(raw.replace(/,/g, ""));
    }

    // ID 15: pesos → UDIS (para puntaje)
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

    // Historia mensual — 1) rejilla; 2) parseHistoriaFromText; 3) desde Activos
    let historyMonthly = parseHistoriaMensual(text);
    if (!historyMonthly || historyMonthly.length === 0) {
      const h2 = parseHistoriaFromText(text); // { historiaRaw, meses, filas }
      historyMonthly = mapHistoriaFromLib(h2);
    }
    if (!historyMonthly || historyMonthly.length === 0) {
      historyMonthly = parseHistoriaMensualDesdeActivos(text);
    }

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
