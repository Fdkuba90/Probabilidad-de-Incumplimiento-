// lib/coords.js
// Extrae la fila "Totales" del bloque “Créditos Activos” usando pdf2json
// 1) Localiza el bloque (Página que contiene “Créditos Activos”)
// 2) Ubica encabezados (Original, Vigente, 1–29, 30–59, 60–89, 90–119, 120–179, 180+)
// 3) Toma la fila “Totales:” y asigna cada valor por bandas de X (o fallback por orden)

function decodeStr(t) {
  try { return decodeURIComponent(t || ""); } catch { return t || ""; }
}
function toNum(s) {
  if (s == null) return null;
  const clean = String(s)
    .replace(/\u00A0/g, " ")
    .trim()
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .replace(/^--?$/, "");
  if (clean === "" || clean.toLowerCase() === "na" || clean.toLowerCase() === "n/a") return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
const safe = (n) => (Number.isFinite(n) ? n : 0);

// Normaliza dashes: -, – (en), — (em)
const D = String.raw`[-–—]`;

function buildHeaders(texts) {
  // Buscamos los encabezados y guardamos su X si aparecen
  // Aceptamos variantes como: "1-29", "1 – 29", "1 — 29", "180 +", etc.
  const HEADERS = [
    { key: "original",  re: /^\s*original\s*$/i, x: null },
    { key: "vigente",   re: /^\s*vigente\s*$/i,  x: null },
    { key: "d1_29",     re: new RegExp(`^\\s*1\\s*${D}\\s*29\\s*$`, "i"), x: null },
    { key: "d30_59",    re: new RegExp(`^\\s*30\\s*${D}\\s*59\\s*$`, "i"), x: null },
    { key: "d60_89",    re: new RegExp(`^\\s*60\\s*${D}\\s*89\\s*$`, "i"), x: null },
    { key: "d90_119",   re: new RegExp(`^\\s*90\\s*${D}\\s*119\\s*$`, "i"), x: null },
    { key: "d120_179",  re: new RegExp(`^\\s*120\\s*${D}\\s*179\\s*$`, "i"), x: null },
    { key: "d180_plus", re: /^\s*180\s*\+\s*$/i, x: null },
  ];

  for (const h of HEADERS) {
    const hit = texts.find((it) => h.re.test(it.str));
    if (hit) h.x = hit.x;
  }
  return HEADERS;
}

export async function extractCreditosActivosByCoords(buffer) {
  // Carga pdf2json dinámicamente (evita romper el build de Next)
  const mod = await import("pdf2json").catch(() => null);
  const PDFParser = (mod && (mod.default || mod.PDFParser || mod)) || null;
  if (!PDFParser) return null;

  const pdfParser = new PDFParser();
  const data = await new Promise((resolve, reject) => {
    pdfParser.on("pdfParser_dataError", (e) => reject(e.parserError || e));
    pdfParser.on("pdfParser_dataReady", (d) => resolve(d));
    pdfParser.parseBuffer(buffer);
  });

  const pages = data?.Pages || data?.formImage?.Pages || [];
  if (!pages.length) return null;

  // Buscamos la(s) página(s) que contengan “Créditos Activos”
  const ACTIVOS_RE = /Cr[eé]ditos?\s+Activos\b/i;

  for (const page of pages) {
    const texts = (page.Texts || []).map((t) => ({
      x: t.x,
      y: t.y,
      str: (t.R && t.R[0] && decodeStr(t.R[0].T)) || ""
    }));

    const pageHasSection = texts.some((it) => ACTIVOS_RE.test(it.str));
    if (!pageHasSection) continue;

    // 1) Encabezados
    const HEADERS = buildHeaders(texts);

    // Al menos Original y Vigente deberían existir para usar bandas
    const haveMainHeaders = HEADERS[0].x != null && HEADERS[1].x != null;

    // 2) Localizar la fila "Totales" (última coincidencia en la página)
    // Aceptamos: "Totales", "Totales:", "Totales :"
    const totCandidates = texts.filter((it) => /^Totales\s*:?\s*$/i.test(it.str));
    if (!totCandidates.length) continue;

    // Tomamos la "Totales" más abajo (usualmente la última)
    const tot = totCandidates.reduce((a, b) => (a.y >= b.y ? a : b));
    const yTol = 0.8;
    const row = texts.filter((it) => Math.abs(it.y - tot.y) <= yTol);

    // Solo tokens NUMÉRICOS de la fila
    const numTokens = row
      .map((it) => ({ ...it, n: toNum(it.str) }))
      .filter((it) => it.n != null)
      .sort((a, b) => a.x - b.x);

    if (!numTokens.length) continue;

    // 3) Mapeo por bandas (si hay encabezados). Si no, fallback por orden.
    const pickNear = (xRef) => {
      let best = null, bestDx = Infinity;
      for (const it of numTokens) {
        const dx = Math.abs(it.x - xRef);
        if (dx < bestDx) { bestDx = dx; best = it; }
      }
      return best ? best.n : null;
    };

    // Si una columna no tiene encabezado visible, aproximamos desde "Vigente".
    const xVig = HEADERS[1].x ?? (numTokens[1]?.x ?? numTokens[0].x);
    const approx = (h, idxFromVig) => (h.x != null ? h.x : xVig + idxFromVig * 10);

    let vals;
    if (haveMainHeaders) {
      vals = {
        original:  pickNear(HEADERS[0].x),
        vigente:   pickNear(HEADERS[1].x),
        d1_29:     pickNear(approx(HEADERS[2], 1)),
        d30_59:    pickNear(approx(HEADERS[3], 2)),
        d60_89:    pickNear(approx(HEADERS[4], 3)),
        d90_119:   pickNear(approx(HEADERS[5], 4)),
        d120_179:  pickNear(approx(HEADERS[6], 5)),
        d180_plus: pickNear(approx(HEADERS[7], 6)),
      };
    } else {
      // Fallback: tomar los últimos 8 números de la fila (izq→der)
      const last8 = numTokens.slice(-8).map((t) => t.n);
      while (last8.length < 8) last8.unshift(0);
      const [o, v, b1, b30, b60, b90, b120, b180] = last8;
      vals = {
        original: o, vigente: v,
        d1_29: b1, d30_59: b30, d60_89: b60, d90_119: b90, d120_179: b120, d180_plus: b180,
      };
    }

    if (vals.original != null && vals.vigente != null) {
      const d1_29     = Math.round(safe(vals.d1_29));
      const d30_59    = Math.round(safe(vals.d30_59));
      const d60_89    = Math.round(safe(vals.d60_89));
      const d90_119   = Math.round(safe(vals.d90_119));
      const d120_179  = Math.round(safe(vals.d120_179));
      const d180_plus = Math.round(safe(vals.d180_plus));

      const original  = Math.round(safe(vals.original));
      const vigente   = Math.round(safe(vals.vigente));
      const vencido   = Math.round(d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus);
      const saldo     = Math.round(vigente + vencido);

      return {
        original, vigente, saldo, vencido,
        d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus,
        _debug_coords: {
          headers: HEADERS.map(({ key, x }) => ({ key, x })),
          totY: tot.y,
          rowNums: numTokens.map(t => ({ x: t.x, y: t.y, n: t.n })),
        }
      };
    }
  }

  // Si ninguna página funcionó:
  return null;
}
