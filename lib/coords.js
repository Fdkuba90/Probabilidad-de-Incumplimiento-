// lib/coords.js
// Método por coordenadas usando pdf2json para leer la fila "Totales:" de Créditos Activos
// y mapear exactamente las 8 columnas: Original, Vigente, 1-29, 30-59, 60-89, 90-119, 120-179, 180+

function decodeStr(t) {
  try { return decodeURIComponent(t || ""); } catch { return t || ""; }
}
function toNum(s) {
  if (s == null) return null;
  const clean = String(s)
    .trim()
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "");
  if (clean === "" || clean === "--") return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
const safe = (n) => (Number.isFinite(n) ? n : 0);

export async function extractCreditosActivosByCoords(buffer) {
  // Carga pdf2json dinámicamente para no romper el bundle en Next
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
  for (const page of pages) {
    const texts = (page.Texts || []).map((t) => {
      const str = (t.R && t.R[0] && decodeStr(t.R[0].T)) || "";
      return { x: t.x, y: t.y, str };
    });

    const hasCredAct = texts.some((it) => /Cr[eé]ditos?\s+Activos\s*:?/i.test(it.str));
    if (!hasCredAct) continue;

    // Encabezados: permitir 1-29 / 1–29 / 1 — 29, etc.
    const H = [
      { key: "original",  re: /^original$/i,                   x: null },
      { key: "vigente",   re: /^vigente$/i,                    x: null },
      { key: "d1_29",     re: /^1\s*[-–—]\s*29\b/i,            x: null },
      { key: "d30_59",    re: /^30\s*[-–—]\s*59\b/i,           x: null },
      { key: "d60_89",    re: /^60\s*[-–—]\s*89\b/i,           x: null },
      { key: "d90_119",   re: /^90\s*[-–—]\s*119\b/i,          x: null },
      { key: "d120_179",  re: /^120\s*[-–—]\s*179\b/i,         x: null },
      { key: "d180_plus", re: /^180\+\b/i,                     x: null },
    ];

    for (const h of H) {
      const hit = texts.find((it) => h.re.test(it.str));
      if (hit) h.x = hit.x;
    }

    // Necesitamos al menos Original y Vigente
    if (H[0].x == null || H[1].x == null) continue;

    // "Totales", "Totales:" o "Totales :"
    const tot = texts.find((it) => /^Totales\s*:?\s*$/i.test(it.str));
    if (!tot) continue;

    // Tokens de esa fila (misma Y con pequeña tolerancia)
    const yTol = 0.8;
    const row = texts.filter((it) => Math.abs(it.y - tot.y) <= yTol);

    // Tomar solo tokens numéricos, de izq→der
    const numTokens = row
      .map((it) => ({ ...it, n: toNum(it.str) }))
      .filter((it) => it.n != null)
      .sort((a, b) => a.x - b.x);

    if (!numTokens.length) continue;

    // Dado un x de referencia, seleccionar el número más cercano
    const pickNear = (xRef) => {
      let best = null, bestDx = Infinity;
      for (const it of numTokens) {
        const dx = Math.abs(it.x - xRef);
        if (dx < bestDx) { bestDx = dx; best = it; }
      }
      return best ? best.n : null;
    };

    // Si algún encabezado de bucket no fue localizado, aproximamos su X
    // con offsets respecto a "vigente" (columna 2).
    const xVig = H[1].x;
    const approx = (h, idx) => (h.x != null ? h.x : xVig + idx * 10);

    const vals = {
      original:  pickNear(H[0].x),
      vigente:   pickNear(H[1].x),
      d1_29:     pickNear(approx(H[2], 1)),
      d30_59:    pickNear(approx(H[3], 2)),
      d60_89:    pickNear(approx(H[4], 3)),
      d90_119:   pickNear(approx(H[5], 4)),
      d120_179:  pickNear(approx(H[6], 5)),
      d180_plus: pickNear(approx(H[7], 6)),
    };

    if (vals.original != null && vals.vigente != null) {
      const d1_29     = safe(vals.d1_29);
      const d30_59    = safe(vals.d30_59);
      const d60_89    = safe(vals.d60_89);
      const d90_119   = safe(vals.d90_119);
      const d120_179  = safe(vals.d120_179);
      const d180_plus = safe(vals.d180_plus);

      const original = Math.round(safe(vals.original));
      const vigente  = Math.round(safe(vals.vigente));
      const vencido  = Math.round(d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus);
      const saldo    = Math.round(vigente + vencido);

      return {
        original,
        vigente,
        saldo,
        vencido,
        d1_29,
        d30_59,
        d60_89,
        d90_119,
        d120_179,
        d180_plus,
        _debug_coords: {
          headers: H.map(({ key, x }) => ({ key, x })),
          totY: tot.y,
          rowNums: numTokens.map(t => ({ x: t.x, y: t.y, n: t.n }))
        }
      };
    }
  }

  return null;
}
