// lib/coords.js
// Resumen de Crédititos Activos por COORDENADAS con fallback de ORDEN FIJO (8 columnas)

function dec(t = "") { try { return decodeURIComponent(t); } catch { return t; } }

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

function rowText(row) {
  return row.cells.map(c => c.text).join(" ").replace(/[ \t]+/g, " ").trim();
}

function pageToRows(page, yTol = 0.55) {
  const rows = [];
  for (const t of page.Texts || []) {
    const text = (t.R || []).map(r => dec(r.T)).join("");
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

// ————————— localizar página (solo pide “Créditos Activos”; SIN exigir “Capital+Intereses”)
function findActivosPage(pdfData) {
  const pages = pdfData.Pages || [];
  for (let p = 0; p < pages.length; p++) {
    const rows = pageToRows(pages[p], 0.55);
    const joined = rows.map(rowText).join("\n");
    if (/Cr[ée]ditos?\s+Activos?/i.test(joined)) {
      return { pageIndex: p, rows };
    }
  }
  return null;
}

// encabezados que queremos
const HEADER_COLS = [
  { key: "original",   re: /\boriginal\b/i },
  { key: "vigente",    re: /\bvigente\b/i },
  { key: "v1_29",      re: /(1\s*[–—-]\s*29|1\s*a\s*29)\s*d[ií]as?/i },
  { key: "v30_59",     re: /(30\s*[–—-]\s*59|30\s*a\s*59)\s*d[ií]as?/i },
  { key: "v60_89",     re: /(60\s*[–—-]\s*89|60\s*a\s*89)\s*d[ií]as?/i },
  { key: "v90_119",    re: /(90\s*[–—-]\s*119|90\s*a\s*119)\s*d[ií]as?/i },
  { key: "v120_179",   re: /(120\s*[–—-]\s*179|120\s*a\s*179)\s*d[ií]as?/i },
  { key: "v180p",      re: /(180\+|180\s*\+|180\s*y\s*m[aá]s|180\s*o\s+m[aá]s)/i },
];

// detecta header (puede ser multi‑línea) y calcula “centros” X por columna
function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r0 = rows[i];
    const l0 = rowText(r0);
    if (!/original/i.test(l0) || !/vigente/i.test(l0)) continue;

    // une hasta 2 renglones más (encabezados partidos)
    const merged = { y: r0.y, cells: [...r0.cells] };
    if (rows[i+1] && rows[i+1].y - r0.y < 1.8) merged.cells.push(...rows[i+1].cells);
    if (rows[i+2] && rows[i+2].y - r0.y < 2.6) merged.cells.push(...rows[i+2].cells);
    merged.cells.sort((a,b)=>a.x-b.x);

    const colX = {};
    for (const col of HEADER_COLS) {
      const hit = merged.cells.find(c => col.re.test(c.text.replace(/\s+/g," ")));
      if (hit) colX[col.key] = hit.x;
    }
    if (colX.original == null || colX.vigente == null) continue;

    // completa X faltantes por espaciamiento mediano
    const xsKnown = Object.values(colX).sort((a,b)=>a-b);
    const gaps = [];
    for (let k=1;k<xsKnown.length;k++) gaps.push(xsKnown[k]-xsKnown[k-1]);
    const median = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 4.5;
    const seq = ["v1_29","v30_59","v60_89","v90_119","v120_179","v180p"];
    seq.forEach((k,idx)=>{ if (colX[k]==null) colX[k] = (colX.vigente ?? xsKnown[0]) + median*(idx+1); });

    // tolerancia dinámica
    const xsAll = Object.values(colX).sort((a,b)=>a-b);
    const medGap = (() => {
      const g=[]; for(let k=1;k<xsAll.length;k++) g.push(xsAll[k]-xsAll[k-1]);
      return g.sort((a,b)=>a-b)[Math.floor(g.length/2)] || 5;
    })();
    const maxDist = Math.max(2.0, medGap * 0.6);

    return { headerY: r0.y, colX, maxDist };
  }
  return null;
}

// mapea una fila a columnas por proximidad; si faltan, rellena por ORDEN FIJO de 8
function mapRow(row, colX, maxDist) {
  const acc = {
    original: [], vigente: [],
    v1_29: [], v30_59: [], v60_89: [], v90_119: [], v120_179: [], v180p: [],
    nums: [], hasTotales: /Totales\s*:?\s*$/i.test(rowText(row)),
  };

  for (const c of row.cells) {
    const n = parseNumberMX(c.text);
    if (n == null) continue;
    acc.nums.push({ x:c.x, n });

    // asignación por cercanía en X
    let bestKey=null, best=1e9;
    for (const [k,x] of Object.entries(colX)) {
      const d = Math.abs(c.x - x);
      if (d < best) { best=d; bestKey=k; }
    }
    if (bestKey && best <= maxDist) acc[bestKey].push(n);
  }

  // mejor valor por columna
  const maxVal = a => (a||[]).reduce((m,v)=> m==null || Math.abs(v)>Math.abs(m) ? v : m, null);
  let original = maxVal(acc.original);
  let vigente  = maxVal(acc.vigente);
  const buckets = {
    v1_29:   (acc.v1_29||[]).reduce((s,v)=>s+v,0),
    v30_59:  (acc.v30_59||[]).reduce((s,v)=>s+v,0),
    v60_89:  (acc.v60_89||[]).reduce((s,v)=>s+v,0),
    v90_119: (acc.v90_119||[]).reduce((s,v)=>s+v,0),
    v120_179:(acc.v120_179||[]).reduce((s,v)=>s+v,0),
    v180p:   (acc.v180p||[]).reduce((s,v)=>s+v,0),
  };

  // F A L L B A C K — ORDEN FIJO (8 columnas izquierda→derecha)
  const ordered = acc.nums.sort((a,b)=>a.x-b.x).map(o=>o.n);
  const takeIdx = (cur, idx) => (cur!=null && cur!==0) ? cur : (ordered.length>idx ? ordered[idx] : cur);
  if (ordered.length >= 2) {
    original = takeIdx(original, 0);
    vigente  = takeIdx(vigente,  1);
  }
  buckets.v1_29    = takeIdx(buckets.v1_29,    2);
  buckets.v30_59   = takeIdx(buckets.v30_59,   3);
  buckets.v60_89   = takeIdx(buckets.v60_89,   4);
  buckets.v90_119  = takeIdx(buckets.v90_119,  5);
  buckets.v120_179 = takeIdx(buckets.v120_179, 6);
  buckets.v180p    = takeIdx(buckets.v180p,    7);

  return { original, vigente, buckets, hasTotales: acc.hasTotales, _ordered: ordered };
}

function extractTotalsByCoords(pdfData) {
  const hit = findActivosPage(pdfData);
  if (!hit) return null;
  const rows = pageToRows(pdfData.Pages[hit.pageIndex], 0.55);

  const hdr = findHeader(rows);
  if (!hdr) return null;
  const { headerY, colX, maxDist } = hdr;

  // busca la fila que contenga “Totales” **debajo** del header
  const startIdx = rows.findIndex(r => Math.abs(r.y - headerY) < 1e-6);
  const after = rows.slice(startIdx + 1);

  // toma la PRIMERA fila con “Totales”
  const totalRow = after.find(r => /Totales\s*:?\s*$/i.test(rowText(r)));
  if (!totalRow) return null;

  const mapped = mapRow(totalRow, colX, maxDist);
  return {
    original: mapped.original,
    vigente:  mapped.vigente,
    buckets:  mapped.buckets,
    _debug: { header:{colX, maxDist, y:headerY}, ordered:mapped._ordered, rowY: totalRow.y }
  };
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
    _debug_coords: totals._debug || null,
  };
}
