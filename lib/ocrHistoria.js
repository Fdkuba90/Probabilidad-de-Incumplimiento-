// lib/ocrHistoria.js
// OCR de la sección "Historia por mes (pesos)" usando pdfjs + tesseract.
// Devuelve { rows: [{month, vigente, v1_29, v30_59, v60_89, v90p, rating}], historiaRaw }

import { createCanvas, ImageData } from "canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.js";
import sharp from "sharp";
import Tesseract from "tesseract.js";

// Forzamos worker de pdfjs en modo “single-thread” en Node
pdfjs.GlobalWorkerOptions.workerSrc = null;

// Meses abreviados que usa Buró
const MES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
const MES_RE = new RegExp(`\\b(?:${MES.join("|")})\\s+20\\d{2}\\b`, "g");

// Normaliza números leídos por OCR: “28 487”, “28,487”, “28487”
function toMilesNumber(tok) {
  const s = String(tok)
    .replace(/[^\d.,\s]/g, "")
    .replace(/\s+/g, "")
    .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "") // quita sep miles
    .replace(/,/g, "."); // coma decimal a punto (por si acaso)
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1000); // reporte en miles de pesos
}

// Extrae la página que contiene “Historia por mes (pesos)”
async function findHistoriaPages(pdfDocument) {
  const pages = [];
  const max = pdfDocument.numPages;
  for (let p = 1; p <= max; p++) {
    const page = await pdfDocument.getPage(p);
    const text = await page.getTextContent();
    const joined = text.items.map(it => it.str).join(" ").replace(/\s+/g, " ");
    if (/Historia\s+por\s+mes\s*\(pesos\)/i.test(joined) || /\bHistoria\b/i.test(joined)) {
      pages.push(p);
    }
  }
  return pages.length ? pages : [1]; // fallback: primera página
}

// Renderiza una página a PNG como Buffer
async function renderPageToPng(page, scale = 2) {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext("2d");

  const renderContext = {
    canvasContext: context,
    viewport,
  };
  await page.render(renderContext).promise;

  const buf = canvas.toBuffer("image/png");
  return buf;
}

// Heurística: recorta el bloque debajo del título “Historia por mes (pesos)”
async function cropHistoriaRegion(pngBuf) {
  // Usamos OCR rápido (single line) para localizar el título y cortar por debajo.
  // Para robustez, si no detecta, devolvemos la imagen completa.
  try {
    const { data: { text } } = await Tesseract.recognize(pngBuf, "spa", { tessedit_pageseg_mode: 6 });
    if (!/Historia\s+por\s+mes\s*\(pesos\)/i.test(text)) {
      // intenta con “Historia” a secas
    }
  } catch {
    // ignoramos; seguimos con recorte fijo
  }

  // Recorte fijo conservador: eliminamos cabecera superior ~18% y pie ~8%
  // (Evita encabezados y captura toda la tabla de Historia)
  const meta = await sharp(pngBuf).metadata();
  const top = Math.round(meta.height * 0.18);
  const height = Math.round(meta.height * 0.74);
  const left = Math.round(meta.width * 0.05);
  const width = Math.round(meta.width * 0.90);

  return await sharp(pngBuf).extract({ left, top, width, height }).png().toBuffer();
}

// OCR a texto crudo de la región
async function ocrTextRegion(pngBuf) {
  const { data: { text } } = await Tesseract.recognize(pngBuf, "spa", {
    tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz +-/:()",
  });
  return text.replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "\n");
}

// Parsea el texto OCR en estructura por meses
function parseHistoriaFromOcrText(text) {
  // Partimos por bloques de mes
  const tokens = Array.from(text.matchAll(MES_RE)).map(m => ({ token: m[0], idx: m.index }));
  if (!tokens.length) return { rows: [], historiaRaw: text };

  const blocks = [];
  for (let i = 0; i < tokens.length; i++) {
    const start = tokens[i].idx;
    const end = (i + 1 < tokens.length) ? tokens[i + 1].idx : text.length;
    const month = tokens[i].token.replace(/\s+/g, " ");
    const body = text.slice(start, end);

    // Buscamos filas; aceptamos variantes OCR (acentos y espacios)
    const takeNum = (label) => {
      // toma el primer número que aparezca tras la etiqueta, en la misma línea o siguiente
      const re = new RegExp(label + "[^\\n\\r]*?[\\s:]*([\\d.,\\s]{1,20})", "i");
      const m1 = body.match(re);
      if (m1 && m1[1]) return toMilesNumber(m1[1]);
      // si no, buscar el primer número en las 2 líneas siguientes
      const lines = body.split(/\n/);
      for (let k = 0; k < Math.min(5, lines.length); k++) {
        const ms = lines[k].match(/[\d.,\s]{3,20}/g);
        if (ms && ms.length) return toMilesNumber(ms[0]);
      }
      return 0;
    };

    const vigente = takeNum("(?:^|\\b)Vigente\\b|^\\s*Vigente");
    const v1_29   = takeNum("Vencido\\s+de\\s+1\\s*a\\s*29\\s*d[ií]as");
    const v30_59  = takeNum("Vencido\\s+de\\s+30\\s*a\\s*59\\s*d[ií]as");
    const v60_89  = takeNum("Vencido\\s+de\\s+60\\s*a\\s*89\\s*d[ií]as");
    const v90p    = takeNum("Vencido\\s+a\\s+m[aá]s\\s+de\\s*89\\s*d[ií]as|90\\+|>\\s*89");

    // Calificación: tokens tipo 1NC, 4A1, 1B2, etc.
    const ratingTokens = Array.from(body.matchAll(/\b\d(?:NC|[A-Z]\d)\b/gi)).map(x => x[0].toUpperCase());
    const rating = ratingTokens.length ? Array.from(new Set(ratingTokens)).join(" ") : null;

    blocks.push({
      month, vigente, v1_29, v30_59, v60_89, v90p, rating
    });
  }

  // Ordena y devuelve últimos 12
  blocks.sort((a, b) => {
    const [ma, ya] = a.month.split(/\s+/); const [mb, yb] = b.month.split(/\s+/);
    const ia = MES.indexOf(ma); const ib = MES.indexOf(mb);
    return (ya - yb) || (ia - ib);
  });
  return { rows: blocks.slice(-12), historiaRaw: text };
}

export async function extractHistoriaOCR(pdfBuffer) {
  const loadingTask = pdfjs.getDocument({ data: pdfBuffer });
  const pdfDocument = await loadingTask.promise;

  // 1) identifica páginas
  const pages = await findHistoriaPages(pdfDocument);

  const allRows = [];
  let rawDump = "";

  for (const p of pages) {
    const page = await pdfDocument.getPage(p);
    const png = await renderPageToPng(page, 2); // 2x
    const cropped = await cropHistoriaRegion(png);
    const text = await ocrTextRegion(cropped);
    rawDump += `\n\n[PAGE ${p} OCR]\n` + text;
    const parsed = parseHistoriaFromOcrText(text);
    allRows.push(...parsed.rows);
  }

  // Quita duplicados por mes
  const byMonth = new Map();
  for (const r of allRows) byMonth.set(r.month, r);
  const rows = Array.from(byMonth.values())
    .sort((a, b) => {
      const [ma, ya] = a.month.split(/\s+/); const [mb, yb] = b.month.split(/\s+/);
      const ia = MES.indexOf(ma); const ib = MES.indexOf(mb);
      return (ya - yb) || (ia - ib);
    })
    .slice(-12);

  return { rows, historiaRaw: rawDump };
}
