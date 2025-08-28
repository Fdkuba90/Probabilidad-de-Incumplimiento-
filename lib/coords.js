// lib/coords.js
// Extrae la fila "Totales" del bloque Créditos Activos usando pdf2json.
// 1) Coordenadas por encabezados con centros de columna (tolerancias amplias)
// 2) Respaldo SOLO para Original y Vigente (no para buckets)
// 3) Fusión de filas cuando "Totales" y los importes vienen en renglones consecutivos
// 4) Filtro horizontal: solo números dentro de la banda [Original .. 180+] cuentan

function dec(t) {
  try { return decodeURIComponent(t || ""); } catch { return t || ""; }
}
function toNum(s) {
  if (s == null) return null;
  const clean = String(s).trim().replace(/\$/g, "").replace(/,/g, "").replace(/\s+/g, "");
  if (!clean || clean === "--") return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
const safe = (n) => (Number.isFinite(n) ? n : 0);

// ---------------- Row helpers ----------------
function pageToRows(page, yTol = 1.2) {
  const rows = [];
  for (const t of (page.Texts || [])) {
    const s = (t.R && t.R[0] && dec(t.R[0].T)) || "";
    if (!s.trim()) continue;
    let row = rows.find(r => Math.abs(r.y - t.y) <= yTol);
    if (!row) { row = { y: t.y, cells: [] }; rows.push(row); }
    row.cells.push({ x: t.x, y: t.y, s });
  }
  rows.sort((a,b)=>a.y-b.y);
  for (const r of rows) r.cells.sort((a,b)=>a.x-b.x);
  return rows;
}
const rowText = (r) => r.cells.map(c=>c.s).join(" ").replace(/[ \t]+/g," ").trim();

function findActivosPage(data) {
  const pages = data.Pages || data.formImage?.Pages || [];
  for (let i=0;i<pages.length;i++) {
    const rows = pageToRows(pages[i], 1.2);
    const joined = rows.map(rowText).join("\n");
    if (/Cr[ée]ditos?\s+Activos/i.test(joined) && /Capital\s*\+\s*Intereses/i.test(joined)) {
      return { pageIndex: i, rows };
    }
  }
  return null;
}

const HEADER_COLS = [
  { key: "original",  re: /\boriginal\b/i },
  { key: "vigente",   re: /\bvigente\b/i },
  { key: "v1_29",     re: /(1\s*[–—-]\s*29|1\s*a\s*29)\s*d[ií]as?/i },
  { key: "v30_59",    re: /(30\s*[–—-]\s*59|30\s*a\s*59)\s*d[ií]as?/i },
  { key: "v60_89",    re: /(60\s*[–—-]\s*89|60\s*a\s*89)\s*d[ií]as?/i },
  { key: "v90_119",   re: /(90\s*[–—-]\s*119|90\s*a\s*119)\s*d[ií]as?/i },
  { key: "v120_179",  re: /(120\s*[–—-]\s*179|120\s*a\s*179)\s*d[ií]as?/i },
  { key: "v180p",     re: /(180\+|180\s*\+|180\s*y\s*m[aá]s|180\s*o\s+m[aá]s)/i },
];

const hasTotales = (row) =>
  !!row && ( /^\s*Totales\s*:?\s*$/i.test(rowText(row)) || row.cells.some(c => /^\s*Totales\s*:?\s*$/i.test(c.s)) );

function findHeaderConfig(rows) {
  for (let i=0;i<rows.length;i++) {
    const r0 = rows[i];
    const l0 = rowText(r0);
    if (!/original/i.test(l0) || !/vigente/i.test(l0)) continue;

    const merged = { y: r0.y, cells: [...r0.cells] };
    if (rows[i+1] && rows[i+1].y - r0.y < 1.8) merged.cells.push(...rows[i+1].cells);
    if (rows[i+2] && rows[i+2].y - r0.y < 2.6) merged.cells.push(...rows[i+2].cells);
    merged.cells.sort((a,b)=>a.x-b.x);
    if (!merged.cells.some(c=>/d[ií]as/i.test(c.s))) continue;

    const centers = {};
    for (const col of HEADER_COLS) {
      const hit = merged.cells.find(c => col.re.test(c.s.replace(/\s+/g," ")));
      if (hit) centers[col.key] = hit.x;
    }
    if (centers.original == null || centers.vigente == null) continue;

    const xs = Object.values(centers).sort((a,b)=>a-b);
    const gaps = []; for (let k=1;k<xs.length;k++) gaps.push(xs[k]-xs[k-1]);
    const medianGap = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 4.5;

    const want = ["v1_29","v30_59","v60_89","v90_119","v120_179","v180p"];
    for (let idx=0; idx<want.length; idx++) {
      const key = want[idx];
      if (centers[key] == null) centers[key] = (centers.vigente ?? xs[0]) + medianGap*(idx+1);
    }

    const xsAll = Object.values(centers).sort((a,b)=>a-b);
    const gapsAll = []; for (let k=1;k<xsAll.length;k++) gapsAll.push(xsAll[k]-xsAll[k-1]);
    const med = gapsAll.sort((a,b)=>a-b)[Math.floor(gapsAll.length/2)] || 5;
    const maxDist = Math.max(2.0, med * 0.6);

    // Banda horizontal de columnas (para filtrar números ajenos)
    const bandMin = Math.min(centers.original, centers.vigente) - med * 0.7;
    const bandMax = Math.max(
      centers.v180p, centers.v120_179, centers.v90_119, centers.v60_89, centers.v30_59, centers.v1_29
    ) + med * 0.7;

    return { headerRowY: r0.y, centers, maxDist, bandMin, bandMax, med };
  }
  return null;
}

function mapRow(row, cfg) {
  const { centers, maxDist, bandMin, bandMax } = cfg;
  const withinBand = (x) => x >= bandMin && x <= bandMax;

  const acc = {
    original: [], vigente: [],
    v1_29: [], v30_59: [], v60_89: [], v90_119: [], v120_179: [], v180p: [],
    numericByX: [],
    isTotales: hasTotales(row)
  };

  for (const c of row.cells) {
    const n = toNum(c.s);
    if (n == null) continue;
    if (!withinBand(c.x)) continue; // <<< filtro horizontal
    acc.numericByX.push({ x:c.x, n });

    let bestKey=null, best=Infinity;
    for (const [key,x] of Object.entries(centers)) {
      const d = Math.abs(c.x - x);
      if (d < best) { best = d; bestKey = key; }
    }
    if (bestKey && best <= maxDist) acc[bestKey].push(n);
  }

  const maxVal = (arr) => (arr || []).reduce((m,v)=> m==null || Math.abs(v)>Math.abs(m) ? v : m, null);
  const sum    = (arr) => (arr || []).reduce((a,b)=>a+(Number(b)||0), 0);

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

  // Respaldo SOLO para Original y Vigente (no tocar buckets)
  const ordered = acc.numericByX.sort((a,b)=>a.x-b.x).map(o=>o.n);
  if (ordered.length >= 2) {
    if (original == null || original === 0) original = ordered[0];
    if (vigente  == null || vigente  === 0) vigente  = ordered[1];
  }

  return {
    original, vigente, buckets,
    isTotales: acc.isTotales,
    numCount: acc.numericByX.length
  };
}

export async function extractCreditosActivosByCoords(buffer) {
  const mod = await import("pdf2json").catch(()=>null);
  const PDFParser = (mod && (mod.default || mod.PDFParser || mod)) || null;
  if (!PDFParser) return null;

  const parser = new PDFParser();
  const data = await new Promise((resolve,reject)=>{
    parser.on("pdfParser_dataError", e => reject(e?.parserError || e));
    parser.on("pdfParser_dataReady", d => resolve(d));
    parser.parseBuffer(buffer);
  });

  const hit = findActivosPage(data);
  if (!hit) return null;

  const allRows = pageToRows((data.Pages || [])[hit.pageIndex], 1.2);
  const header = findHeaderConfig(allRows);
  if (!header) return null;

  const { headerRowY } = header;
  const start = allRows.findIndex(r => Math.abs(r.y - headerRowY) < 1e-6);
  const candidates = allRows.slice(start + 1);

  let bestResult = null;
  const mergeTol = 1.6;

  for (let idx = 0; idx < candidates.length; idx++) {
    const r = candidates[idx];
    const prev = idx > 0 ? candidates[idx-1] : null;
    const next = idx + 1 < candidates.length ? candidates[idx+1] : null;

    const line = rowText(r);
    if (/Resumen Cr[ée]ditos Activos|Cr[ée]ditos Liquidados|INFORMACI[ÓO]N COMERCIAL/i.test(line)) break;

    let m = mapRow(r, header);

    // A) Totales en esta fila sin números → fusionar con la siguiente
    if (m.isTotales && m.numCount <= 2 && next && Math.abs(next.y - r.y) <= mergeTol) {
      const merged = { y: r.y, cells: [...r.cells, ...next.cells] };
      const m2 = mapRow(merged, header);
      if (m2.numCount > m.numCount) m = m2;
    }

    // B) Totales en la fila anterior y números aquí → fusionar hacia atrás
    if (!m.isTotales && hasTotales(prev) && Math.abs(r.y - prev.y) <= mergeTol) {
      const merged = { y: prev.y, cells: [...prev.cells, ...r.cells] };
      const m2 = mapRow(merged, header);
      if (m2.numCount >= m.numCount) m = { ...m2, isTotales: true };
    }

    if (m.isTotales) {
      const d1_29     = safe(m.buckets.v1_29);
      const d30_59    = safe(m.buckets.v30_59);
      const d60_89    = safe(m.buckets.v60_89);
      const d90_119   = safe(m.buckets.v90_119);
      const d120_179  = safe(m.buckets.v120_179);
      const d180_plus = safe(m.buckets.v180p);

      const original = Math.round(safe(m.original));
      const vigente  = Math.round(safe(m.vigente));
      const vencido  = d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus;
      const saldo    = Math.round(vigente + vencido);

      bestResult = {
        original, vigente, saldo, vencido,
        d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus,
        buckets: { v1_29: d1_29, v30_59: d30_59, v60_89: d60_89, v90_119: d90_119, v120_179: d120_179, v180p: d180_plus },
        _debug_coords: {
          centers: header.centers,
          totRowY: r.y,
          ordered: r.cells.map(c=>({x:c.x, s:c.s}))
        }
      };
    }
  }

  return bestResult;
}
