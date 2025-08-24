// lib/coords.js
// Extracción robusta del "Resumen de Créditos Activos"
// 1) Busca la página de "Créditos Activos"
// 2) Detecta encabezado multi-línea (Original, Vigente, 1–29, 30–59, 60–89, 90–119, 120–179, 180+)
// 3) Asigna números por cercanía en X; Fallback por orden fijo (8 columnas: O, V, 1–29, 30–59, 60–89, 90–119, 120–179, 180+)
// 4) Devuelve original, vigente y buckets; además incluye _debug para inspección

function decodeTxt(t = "") {
  try { return decodeURIComponent(t); } catch { return t; }
}
function textOfRow(row) {
  return row.cells.map(c => c.text).join(" ").replace(/[ \t]+/g, " ").trim();
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
function pageToRows(page, yTol = 0.35) {
  const rows = [];
  for (const t of page.Texts || []) {
    const text = (t.R || []).map(r => decodeTxt(r.T)).join("");
    if (!text.trim()) continue;
    const y = t.y;
    let row = null;
    for (const r of rows) if (Math.abs(r.y - y) <= yTol) { row = r; break; }
    if (!row) { row = { y, cells: [] }; rows.push(row); }
    row.cells.push({ x: t.x, text });
  }
  rows.sort((a,b) => a.y - b.y);
  for (const r of rows) r.cells.sort((a,b) => a.x - b.x);
  return rows;
}
function findActivosPage(pdfData) {
  const pages = pdfData.Pages || [];
  for (let p = 0; p < pages.length; p++) {
    const rows = pageToRows(pages[p], 0.35);
    const joined = rows.map(textOfRow).join("\n");
    if (/Cr[ée]ditos Activos/i.test(joined) && /Capital\s*\+\s*Intereses/i.test(joined)) {
      return { pageIndex: p, rows };
    }
  }
  return null;
}

const HEADER_COLS = [
  { key: "original",   re: /\boriginal\b/i },
  { key: "vigente",    re: /\bvigente\b/i },
  { key: "v1_29",      re: /(1\s*[–-]\s*29|1\s*a\s*29)\s*d[ií]as?/i },
  { key: "v30_59",     re: /(30\s*[–-]\s*59|30\s*a\s*59)\s*d[ií]as?/i },
  { key: "v60_89",     re: /(60\s*[–-]\s*89|60\s*a\s*89)\s*d[ií]as?/i },
  { key: "v90_119",    re: /(90\s*[–-]\s*119|90\s*a\s*119)\s*d[ií]as?/i },
  { key: "v120_179",   re: /(120\s*[–-]\s*179|120\s*a\s*179)\s*d[ií]as?/i },
  { key: "v180p",      re: /(180\+|180\s*\+|180\s*y\s*m[aá]s|180\s*o\s+m[aá]s)/i },
];

// Header multi-línea + estimación de centros faltantes + tolerancia dinámica
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

    const colCenters = {};
    for (const col of HEADER_COLS) {
      let best = null;
      for (const c of merged.cells) {
        const txt = c.text.replace(/\s+/g, " ");
        if (col.re.test(txt)) { best = c; break; }
      }
      if (best) colCenters[col.key] = best.x;
    }
    if (colCenters.original == null || colCenters.vigente == null) continue;

    // Completar centros faltantes
    const known = Object.entries(colCenters).sort((a,b)=>a[1]-b[1]);
    const xs = known.map(([,x])=>x);
    const gaps = []; for (let k=1;k<xs.length;k++) gaps.push(xs[k]-xs[k-1]);
    const median = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 4.5;

    const want = ["v1_29","v30_59","v60_89","v90_119","v120_179","v180p"];
    for (const key of want) {
      if (colCenters[key] == null) {
        colCenters[key] = (colCenters.vigente ?? xs[0]) + median * (want.indexOf(key)+1);
      }
    }

    const xsAll = Object.values(colCenters).sort((a,b)=>a-b);
    const medGap = (() => {
      const g=[]; for(let k=1;k<xsAll.length;k++) g.push(xsAll[k]-xsAll[k-1]);
      return g.sort((a,b)=>a-b)[Math.floor(g.length/2)] || 5;
    })();
    const maxDist = Math.max(2.0, medGap * 0.6);

    return { headerRowY: r0.y, colCenters, maxDist };
  }
  return null;
}

// Asigna por cercanía y aplica fallback por orden fijo (O, V, 1–29, 30–59, 60–89, 90–119, 120–179, 180+)
function assignRowToColumns(row, colCenters, maxDist) {
  const acc = {
    original: [], vigente: [],
    v1_29: [], v30_59: [], v60_89: [], v90_119: [], v120_179: [], v180p: [],
    hasTotales: false, numericByX: []
  };
  if (row.cells.some(c => /Totales\s*:?/i.test(c.text))) acc.hasTotales = true;

  for (const c of row.cells) {
    const n = parseNumberMX(c.text);
    if (n === null) continue;
    acc.numericByX.push({ x: c.x, n });

    let bestKey = null, bestDist = Infinity;
    for (const [key, x] of Object.entries(colCenters)) {
      const d = Math.abs(c.x - x);
      if (d < bestDist) { bestDist = d; bestKey = key; }
    }
    if (!bestKey || bestDist > maxDist) continue;
    acc[bestKey].push(n);
  }

  const sum = arr => (arr || []).reduce((a,b)=>a+(Number(b)||0), 0);
  const maxVal = arr => (arr || []).reduce((m,v)=> (m==null || Math.abs(v)>Math.abs(m)) ? v : m, null);

  let original = maxVal(acc.original);
  let vigente  = maxVal(acc.vigente);
  const buckets = {
    v1_29:   sum(acc.v1_29),
    v30_59:  sum(acc.v30_59),
    v60_89:  sum(acc.v60_89),
    v90_119: sum(acc.v90_119),
    v120_179:sum(acc.v120_179),
    v180p:   sum(acc.v180p),
  };

  // -------- Fallback por ORDEN FIJO --------
  const ordered = acc.numericByX.sort((a,b)=>a.x-b.x).map(o=>o.n); // izq→der
  if (ordered.length >= 2) {
    if (original == null || original === 0) original = ordered[0];
    if (vigente  == null || vigente  === 0) vigente  = ordered[1];
  }
  const fillIfZero = (cur, idx) => (cur && cur !== 0) ? cur : (ordered.length > idx ? ordered[idx] : cur);
  buckets.v1_29   = fillIfZero(buckets.v1_29,   2);
  buckets.v30_59  = fillIfZero(buckets.v30_59,  3);
  buckets.v60_89  = fillIfZero(buckets.v60_89,  4);
  buckets.v90_119 = fillIfZero(buckets.v90_119, 5);
  buckets.v120_179= fillIfZero(buckets.v120_179,6);
  buckets.v180p   = fillIfZero(buckets.v180p,   7);

  return { original, vigente, buckets, hasTotales: acc.hasTotales, _rowDebug: { ordered } };
}

function extractTotalsByCoords(pdfData) {
  const hit = findActivosPage(pdfData);
  if (!hit) return null;
  const { pageIndex } = hit;
  const rows = pageToRows(pdfData.Pages[pageIndex], 0.35);

  const header = findHeaderConfig(rows);
  if (!header) return null;

  const { headerRowY, colCenters, maxDist } = header;
  const startIdx = rows.findIndex(r => Math.abs(r.y - headerRowY) < 1e-6);
  const candidates = rows.slice(startIdx + 1);

  for (const row of candidates) {
    const line = textOfRow(row);
    if (/Resumen Cr[ée]ditos Activos|Cr[ée]ditos Liquidados|INFORMACI[ÓO]N COMERCIAL/i.test(line)) break;
    const mapped = assignRowToColumns(row, colCenters, maxDist);
    if (mapped.hasTotales) {
      return { original: mapped.original, vigente: mapped.vigente, buckets: mapped.buckets, _debug_row: mapped._rowDebug, _debug_header: { colCenters, maxDist, y: headerRowY } };
    }
  }
  return null;
}

export async function extractCreditosActivosByCoords(buffer) {
  const mod = await import("pdf2json").catch(() => null);
  const PDFParser = (mod && (mod.default || mod.PDFParser || mod)) || null;
  if (!PDFParser) return null;

  const pdfParser = new PDFParser();
  const pdfData = await new Promise((resolve, reject) => {
    pdfParser.on("pdfParser_dataError", (e) => reject(e?.parserError || e));
    pdfParser.on("pdfParser_dataReady", (d) => resolve(d));
    pdfParser.parseBuffer(buffer);
  });

  const totals = extractTotalsByCoords(pdfData);
  if (!totals) return null;

  return {
    original: totals.original ?? null,
    vigente:  totals.vigente  ?? null,
    buckets:  totals.buckets  ?? null,
    _debug_coords: {
      header: totals._debug_header || null,
      row: totals._debug_row || null,
    },
  };
}
