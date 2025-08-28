// lib/activosResumen.js
// Extracción robusta de "Resumen/Créditos Activos" con 3 niveles:
// A) Coordenadas (encabezados + cercanía en X, con fallback de orden fijo 8 col.)
// B) "Modo Bridova" (números desordenados o pegados con ceros; toma los últimos 8)
// C) Fallback textual por etiquetas

function dec(t = "") { try { return decodeURIComponent(t); } catch { return t; } }
function normalizeSpaces(s = "") {
  return (s || "").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim();
}
function textOfRow(row) { return row.cells.map(c => c.text).join(" ").replace(/[ \t]+/g, " ").trim(); }

function pageToRows(page, yTol = 0.35) {
  const rows = [];
  for (const t of page.Texts || []) {
    const text = (t.R || []).map(r => dec(r.T)).join("");
    if (!text.trim()) continue;
    const y = t.y;
    let row = null;
    for (const r of rows) if (Math.abs(r.y - y) <= yTol) { row = r; break; }
    if (!row) { row = { y, cells: [] }; rows.push(row); }
    row.cells.push({ x: t.x, y: t.y, text });
  }
  rows.sort((a,b) => a.y - b.y);
  for (const r of rows) r.cells.sort((a,b) => a.x - b.x);
  return rows;
}

function parseNumberMX(str) {
  if (str == null) return null;
  let s = String(str).replace(/\u00A0/g, " ").trim();
  s = s.replace(/\s/g, "").replace(/\$/g, "");
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[(),]/g, "");
  if (!s || isNaN(Number(s))) return null;
  const n = Number(s);
  return neg ? -n : n;
}

function findActivosPage(pdfData) {
  const pages = pdfData.Pages || [];
  for (let p = 0; p < pages.length; p++) {
    const rows = pageToRows(pages[p], 0.35);
    const joined = rows.map(textOfRow).join("\n");
    // Soporta “Créditos Activos” o al menos columnas Original/Vigente
    if (/Cr[ée]ditos Activos/i.test(joined) || (/Original/i.test(joined) && /Vigente/i.test(joined))) {
      return { pageIndex: p, rows };
    }
  }
  return null;
}

/* ===== Coordenadas ===== */
const HEADER_COLS = [
  { key: "original",   re: /\boriginal\b/i },
  { key: "vigente",    re: /\bvigente\b/i },
  { key: "d1_29",      re: /(1\s*[–—-]\s*29|1\s*a\s*29)\s*d[ií]as?/i },
  { key: "d30_59",     re: /(30\s*[–—-]\s*59|30\s*a\s*59)\s*d[ií]as?/i },
  { key: "d60_89",     re: /(60\s*[–—-]\s*89|60\s*a\s*89)\s*d[ií]as?/i },
  { key: "d90_119",    re: /(90\s*[–—-]\s*119|90\s*a\s*119)\s*d[ií]as?/i },
  { key: "d120_179",   re: /(120\s*[–—-]\s*179|120\s*a\s*179)\s*d[ií]as?/i },
  { key: "d180_plus",  re: /(180\+|180\s*\+|180\s*y\s*m[aá]s|180\s*o\s+m[aá]s)/i },
];

function findHeaderConfig(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r0 = rows[i];
    const l0 = textOfRow(r0);
    if (!/original/i.test(l0) || !/vigente/i.test(l0)) continue;

    const merged = { y: r0.y, cells: [...r0.cells] };
    if (rows[i+1] && rows[i+1].y - r0.y < 1.8) merged.cells.push(...rows[i+1].cells);
    if (rows[i+2] && rows[i+2].y - r0.y < 2.6) merged.cells.push(...rows[i+2].cells);
    merged.cells.sort((a,b)=>a.x-b.x);

    const hasDias = merged.cells.some(c => /d[ií]as/i.test(c.text));
    if (!hasDias) continue;

    const centers = {};
    for (const col of HEADER_COLS) {
      const hit = merged.cells.find(c => col.re.test(c.text.replace(/\s+/g, " ")));
      if (hit) centers[col.key] = hit.x;
    }
    if (centers.original == null || centers.vigente == null) continue;

    const xs = Object.values(centers).sort((a,b)=>a-b);
    const gaps = []; for (let k=1;k<xs.length;k++) gaps.push(xs[k]-xs[k-1]);
    const median = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 4.5;

    const want = ["d1_29","d30_59","d60_89","d90_119","d120_179","d180_plus"];
    for (let idx=0; idx<want.length; idx++) {
      const key = want[idx];
      if (centers[key] == null) centers[key] = (centers.vigente ?? xs[0]) + median*(idx+1);
    }

    const xsAll = Object.values(centers).sort((a,b)=>a-b);
    const gapsAll = []; for (let k=1;k<xsAll.length;k++) gapsAll.push(xsAll[k]-xsAll[k-1]);
    const medGap = gapsAll.sort((a,b)=>a-b)[Math.floor(gapsAll.length/2)] || 5;
    const maxDist = Math.max(2.0, medGap * 0.6);

    return { headerRowY: r0.y, centers, maxDist };
  }
  return null;
}

function assignRowToColumns(row, centers, maxDist) {
  const acc = {
    original: [], vigente: [],
    d1_29: [], d30_59: [], d60_89: [], d90_119: [], d120_179: [], d180_plus: [],
    numericByX: [],
    hasTotales: row.cells.some(c => /(Total(?:es)?)\s*:?/i.test(c.text))
  };

  for (const c of row.cells) {
    const n = parseNumberMX(c.text);
    if (n === null) continue;
    acc.numericByX.push({ x: c.x, n });

    let bestKey = null, bestDist = Infinity;
    for (const [key, x] of Object.entries(centers)) {
      const d = Math.abs(c.x - x);
      if (d < bestDist) { bestDist = d; bestKey = key; }
    }
    if (!bestKey || bestDist > maxDist) continue;
    acc[bestKey].push(n);
  }

  const sum    = arr => (arr || []).reduce((a,b)=>a+(Number(b)||0), 0);
  const maxVal = arr => (arr || []).reduce((m,v)=> (m==null || Math.abs(v)>Math.abs(m)) ? v : m, null);

  let original = maxVal(acc.original);
  let vigente  = maxVal(acc.vigente);
  const buckets = {
    d1_29:    sum(acc.d1_29),
    d30_59:   sum(acc.d30_59),
    d60_89:   sum(acc.d60_89),
    d90_119:  sum(acc.d90_119),
    d120_179: sum(acc.d120_179),
    d180_plus:sum(acc.d180_plus),
  };

  // Fallback por orden fijo (8 columnas) izquierda→derecha
  const ordered = acc.numericByX.sort((a,b)=>a.x-b.x).map(o=>o.n);
  if (ordered.length >= 2) {
    if (original == null || original === 0) original = ordered[0];
    if (vigente  == null || vigente  === 0) vigente  = ordered[1];
  }
  const fill = (cur, idx) => (cur && cur !== 0) ? cur : (ordered.length > idx ? ordered[idx] : cur);
  buckets.d1_29     = fill(buckets.d1_29,     2);
  buckets.d30_59    = fill(buckets.d30_59,    3);
  buckets.d60_89    = fill(buckets.d60_89,    4);
  buckets.d90_119   = fill(buckets.d90_119,   5);
  buckets.d120_179  = fill(buckets.d120_179,  6);
  buckets.d180_plus = fill(buckets.d180_plus, 7);

  return { original, vigente, buckets, hasTotales: acc.hasTotales };
}

function extractTotalsByCoords(pdfData) {
  const hit = findActivosPage(pdfData);
  if (!hit) return null;
  const { pageIndex } = hit;
  const rows = pageToRows(pdfData.Pages[pageIndex], 0.35);

  const header = findHeaderConfig(rows);
  if (!header) return null;

  const { headerRowY, centers, maxDist } = header;
  const startIdx = rows.findIndex(r => Math.abs(r.y - headerRowY) < 1e-6);
  const candidates = rows.slice(startIdx + 1);

  for (const row of candidates) {
    const line = textOfRow(row);
    if (/Resumen Cr[ée]ditos Activos|Cr[ée]ditos Liquidados|INFORMACI[ÓO]N COMERCIAL/i.test(line)) break;
    const mapped = assignRowToColumns(row, centers, maxDist);
    if (mapped.hasTotales) {
      return { original: mapped.original, vigente: mapped.vigente, buckets: mapped.buckets };
    }
  }
  return null;
}

/* ===== “Modo Bridova” (texto robusto alrededor de Totales) ===== */
function extractTotalsBridova(allText) {
  const lines = allText.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const idxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (/(Total(?:es)?)\s*:?/i.test(lines[i])) idxs.push(i);
  }
  if (!idxs.length) return null;

  const tryParseLine = (line) => {
    // números con comas/puntos/ceros a la izquierda
    const raw = (line.match(/[-$()0-9.,]+/g) || []).map(t => t.replace(/[^\d()-]/g, ""));
    const cleaned = raw
      .map(t => t.replace(/[(),]/g, ""))
      .map(t => t.replace(/^0+(\d)/, "$1"))
      .map(t => parseInt(t || "0", 10))
      .filter(n => !Number.isNaN(n));
    if (cleaned.length < 2) return null;

    const take = cleaned.slice(-8);
    while (take.length < 8) take.unshift(0);
    const [original, vigente, b1,b2,b3,b4,b5,b6] = take;
    return {
      original, vigente,
      buckets: { d1_29:b1||0, d30_59:b2||0, d60_89:b3||0, d90_119:b4||0, d120_179:b5||0, d180_plus:b6||0 }
    };
  };

  for (const i of idxs) {
    const candidates = [
      lines[i],
      lines[i-1] || "",
      lines[i+1] || "",
      ((lines[i-1]||"") + " " + lines[i]).trim(),
      ((lines[i]||"") + " " + (lines[i+1]||"")).trim(),
    ];
    for (const c of candidates) {
      const res = tryParseLine(c);
      if (res) return res;
    }
  }
  return null;
}

/* ===== Fallbacks por etiquetas ===== */
function extractSingleLabeled(lines, labelRegex) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (labelRegex.test(line)) {
      const nums = line.match(/[-$()0-9.,]+/g);
      if (nums) {
        const candidates = nums.map(parseNumberMX).filter((v) => v !== null);
        if (candidates.length) return candidates[candidates.length - 1];
      }
      for (let k = 1; k <= 3 && i + k < lines.length; k++) {
        const ln = lines[i + k];
        const cand = ln.match(/[-$()0-9.,]+/g);
        if (cand) {
          const vals = cand.map(parseNumberMX).filter((v) => v !== null);
          if (vals.length) return vals[vals.length - 1];
        }
      }
    }
  }
  return null;
}
function extractBucketsByLabels(lines) {
  const defs = [
    { key: "d1_29",     re: /(1\s*[–—-]\s*29|1\s*a\s*29)\s*d[ií]as?/i },
    { key: "d30_59",    re: /(30\s*[–—-]\s*59|30\s*a\s*59)\s*d[ií]as?/i },
    { key: "d60_89",    re: /(60\s*[–—-]\s*89|60\s*a\s*89)\s*d[ií]as?/i },
    { key: "d90_119",   re: /(90\s*[–—-]\s*119|90\s*a\s*119)\s*d[ií]as?/i },
    { key: "d120_179",  re: /(120\s*[–—-]\s*179|120\s*a\s*179)\s*d[ií]as?/i },
    { key: "d180_plus", re: /(180\+|180\s*\+|180\s*y\s*m[aá]s|180\s*o\s+m[aá]s)/i },
  ];
  const out = { d1_29:0, d30_59:0, d60_89:0, d90_119:0, d120_179:0, d180_plus:0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const b of defs) {
      if (b.re.test(line)) {
        const nums = line.match(/[-$()0-9.,]+/g);
        if (nums) {
          const candidates = nums.map(parseNumberMX).filter((v) => v !== null);
          if (candidates.length) out[b.key] += candidates[candidates.length - 1] || 0;
        }
      }
    }
  }
  return out;
}

/* ===== Export principal ===== */
export async function extractActivosResumen(buffer) {
  const mod = await import("pdf2json").catch(()=>null);
  const PDFParser = (mod && (mod.default || mod.PDFParser || mod)) || null;
  if (!PDFParser) return null;

  const parser = new PDFParser();
  const pdfData = await new Promise((resolve, reject) => {
    parser.on("pdfParser_dataError", (e) => reject(e?.parserError || e));
    parser.on("pdfParser_dataReady", (d) => resolve(d));
    parser.parseBuffer(buffer);
  });

  // Texto normalizado para “modo Bridova” y fallbacks
  const allText = normalizeSpaces(
    (pdfData.Pages || []).map(p => pageToRows(p).map(textOfRow).join("\n")).join("\n")
  );

  // 1) Coordenadas
  const t1 = extractTotalsByCoords(pdfData);
  if (t1) {
    const { original, vigente, buckets } = t1;
    const vencido =
      (buckets.d1_29 || 0) + (buckets.d30_59 || 0) + (buckets.d60_89 || 0) +
      (buckets.d90_119 || 0) + (buckets.d120_179 || 0) + (buckets.d180_plus || 0);
    const saldo = Math.round((vigente || 0) + vencido);
    return {
      original: Math.round(original || 0),
      vigente:  Math.round(vigente  || 0),
      saldo,
      vencido,
      d1_29: buckets.d1_29 || 0,
      d30_59: buckets.d30_59 || 0,
      d60_89: buckets.d60_89 || 0,
      d90_119: buckets.d90_119 || 0,
      d120_179: buckets.d120_179 || 0,
      d180_plus: buckets.d180_plus || 0,
      buckets
    };
  }

  // 2) Modo Bridova
  const t2 = extractTotalsBridova(allText);
  if (t2) {
    const { original, vigente, buckets } = t2;
    const vencido =
      (buckets.d1_29 || 0) + (buckets.d30_59 || 0) + (buckets.d60_89 || 0) +
      (buckets.d90_119 || 0) + (buckets.d120_179 || 0) + (buckets.d180_plus || 0);
    const saldo = Math.round((vigente || 0) + vencido);
    return {
      original: Math.round(original || 0),
      vigente:  Math.round(vigente  || 0),
      saldo,
      vencido,
      d1_29: buckets.d1_29 || 0,
      d30_59: buckets.d30_59 || 0,
      d60_89: buckets.d60_89 || 0,
      d90_119: buckets.d90_119 || 0,
      d120_179: buckets.d120_179 || 0,
      d180_plus: buckets.d180_plus || 0,
      buckets
    };
  }

  // 3) Fallback textual por etiquetas
  {
    const lines = allText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const original = extractSingleLabeled(lines, /\boriginal\b/i);
    const vigente  = extractSingleLabeled(lines, /\bvigente\b/i);
    if (original != null && vigente != null) {
      const buckets = extractBucketsByLabels(lines);
      const vencido =
        (buckets.d1_29 || 0) + (buckets.d30_59 || 0) + (buckets.d60_89 || 0) +
        (buckets.d90_119 || 0) + (buckets.d120_179 || 0) + (buckets.d180_plus || 0);
      const saldo = Math.round((vigente || 0) + vencido);
      return {
        original: Math.round(original || 0),
        vigente:  Math.round(vigente  || 0),
        saldo,
        vencido,
        d1_29: buckets.d1_29 || 0,
        d30_59: buckets.d30_59 || 0,
        d60_89: buckets.d60_89 || 0,
        d90_119: buckets.d90_119 || 0,
        d120_179: buckets.d120_179 || 0,
        d180_plus: buckets.d180_plus || 0,
        buckets
      };
    }
  }

  // Nada
  return null;
}
