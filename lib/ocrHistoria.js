// lib/ocrHistoria.js — OCR del bloque "Historia:" con rutas explícitas de Tesseract (evita error "Invalid workerSrc type")
import { createWorker } from "tesseract.js";
import * as pdfjs from "pdfjs-dist";
import { createCanvas } from "@napi-rs/canvas";

// No usamos pdf.js worker en Node. Estas opciones evitan fetch/eval en Vercel.
pdfjs.GlobalWorkerOptions.workerSrc = undefined;

const TESS_WORKER =
  "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.0/dist/worker.min.js";
const TESS_CORE =
  "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js";
const TESS_LANGS =
  "https://tessdata.projectnaptha.com/4.0.0"; // spa.traineddata

const MONTHS = "Ene Feb Mar Abr May Jun Jul Ago Sep Oct Nov Dic".split(" ");
const MES_IDX = Object.fromEntries(MONTHS.map((m, i) => [m, i]));

function parseMonthToken(tok) {
  const m = tok && tok.match(/^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+(\d{4})$/i);
  if (!m) return null;
  const key = m[1].slice(0, 3).replace(/^./, (c) => c.toUpperCase());
  const mm = MES_IDX[key];
  const yy = Number(m[2]);
  if (!Number.isFinite(mm) || !Number.isFinite(yy)) return null;
  return { y: yy, m: mm };
}
function compareMonthTok(a, b) {
  const pa = parseMonthToken(a), pb = parseMonthToken(b);
  if (!pa || !pb) return 0;
  return pa.y === pb.y ? pa.m - pb.m : pa.y - pb.y;
}

// Recorta sólo el bloque "Historia:"
function getHistoriaOcrBlock(fullText) {
  const reStart = /(^|\n)\s*Historia\s*:?\s*(\n|$)/i;
  const reEnd = /(^|\n)\s*(INFORMACI[ÓO]N\s+COMERCIAL|Califica(?:ción)?|DECLARATIVAS|INFORMACI[ÓO]N\s+DE\s+PLD|FIN DEL REPORTE)\b/i;
  const ms = fullText.search(reStart);
  if (ms === -1) return "";
  const rest = fullText.slice(ms + (fullText.slice(ms).match(reStart)?.[0]?.length || 0));
  const me = rest.search(reEnd);
  return me !== -1 ? rest.slice(0, me) : rest;
}

// Parsea texto OCR → filas mensuales con “vigente”
function parseHistoriaOcrText(txt) {
  const bloque = getHistoriaOcrBlock(txt || "");
  const lines = (bloque || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const MES = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i;
  const NUM = /-?(?:\d[\s., ]?){1,14}/g;

  const toMiles = (s) => {
    const c = String(s)
      .replace(/\s+/g, "")
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "")
      .replace(/,/g, ".");
    const n = Number(c);
    return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
  };

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!MES.test(lines[i])) continue;
    const month = lines[i].replace(/\s+/g, " ");
    const seg = lines.slice(i + 1, i + 8).join(" ");

    // “<número> Vigente” o “Vigente <número>”
    let vigente = 0;
    const m1 = seg.match(/(-?(?:\d[\s., ]?){1,14})\s*Vigente\b/i);
    const m2 = seg.match(/\bVigente\b\s*(-?(?:\d[\s., ]?){1,14})/i);
    if (m1?.[1]) vigente = toMiles(m1[1]) || 0;
    if (!vigente && m2?.[1]) vigente = toMiles(m2[1]) || 0;

    // Si no lo vimos, toma el mayor número “razonable” del segmento
    if (!vigente) {
      const vals = (seg.match(NUM) || [])
        .map(toMiles)
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100_000_000);
      if (vals.length) vigente = Math.max(...vals);
    }

    rows.push({
      month,
      vigente: vigente || 0,
      v1_29: 0,
      v30_59: 0,
      v60_89: 0,
      v90p: 0,
      rating: null,
    });
  }

  rows.sort((a, b) => compareMonthTok(a.month, b.month));
  return rows.slice(-12);
}

export async function ocrHistoriaFromPdf(buffer) {
  // Cargar PDF (sin worker en Node)
  const loadingTask = pdfjs.getDocument({
    data: buffer,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  // Worker Tesseract con rutas explícitas (evita "Invalid workerSrc type")
  const worker = await createWorker({
    workerPath: TESS_WORKER,
    corePath: TESS_CORE,
    langPath: TESS_LANGS,
    cacheMethod: "none",
  });
  await worker.loadLanguage("spa");
  await worker.initialize("spa");

  const pagesToScan = [];
  for (let p = 1; p <= Math.min(6, pdf.numPages); p++) pagesToScan.push(p);

  let ocrText = "";
  const scale = 2.0;

  for (const p of pagesToScan) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const png = canvas.toBuffer("image/png");
    const { data: { text } } = await worker.recognize(png);
    ocrText += `\n\n===PAGE:${p}===\n${text}\n`;
  }

  await worker.terminate();

  const rows = parseHistoriaOcrText(ocrText);
  const sample = (ocrText || "").slice(0, 300);

  return {
    rows: rows && rows.length ? rows : [],
    meta: { pages: pdf.numPages, scanned: pagesToScan.length, scale, lang: "spa" },
    sample,
  };
}
