// lib/ocrHistoria.js — OCR del bloque "Historia:" mejorado (tolerante)
// Node/Vercel: sin worker de pdfjs aparte.
import { createWorker } from "tesseract.js";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"; // funciona en Node

pdfjs.GlobalWorkerOptions.workerSrc = undefined;

const MONTHS = "Ene Feb Mar Abr May Jun Jul Ago Sep Oct Nov Dic".split(" ");
const MES_IDX = Object.fromEntries(MONTHS.map((m, i) => [m, i]));

// ---------- utils de fecha ----------
function parseMonthToken(tok) {
  const m = tok && tok.match(/^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+(\d{4})$/i);
  if (!m) return null;
  const key = m[1].slice(0, 3).replace(/^./, c => c.toUpperCase());
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

// ---------- normalizaciones para texto de OCR ----------
function normOCR(s = "") {
  return String(s)
    .replace(/\u00A0/g, " ")
    .replace(/[°º]/g, "o")
    .replace(/0(?=[a-z])/gi, "O")     // 0ct → Oct
    .replace(/(?<=\b)l(?=[a-z])/g, "I") // lne → Ine (menos frecuente)
    .replace(/í/gi, "i")
    .replace(/á/gi, "a")
    .replace(/é/gi, "e")
    .replace(/ó/gi, "o")
    .replace(/ú/gi, "u")
    .replace(/\s+/g, " ")
    .trim();
}

// encuentra “Historia:” y corta hasta el siguiente bloque. Si no la ve, devuelve todo.
function getHistoriaOcrBlock(fullText) {
  const t = normOCR(fullText);
  const reStart = /(^|\n)\s*historia\s*:?\s*(\n|$)/i;
  const reEnd = /(^|\n)\s*(informacion\s+comercial|califica(?:cion)?|declarativas|informacion\s+de\s+pld|fin del reporte)\b/i;

  const ms = t.search(reStart);
  if (ms === -1) return t; // no la vio → usa todo el texto OCR

  const head = t.slice(ms);
  const m0 = head.match(reStart);
  const rest = head.slice(m0 ? m0[0].length : 0);
  const me = rest.search(reEnd);
  return me !== -1 ? rest.slice(0, me) : rest;
}

function parseHistoriaOcrText(txt) {
  const bloque = getHistoriaOcrBlock(txt || "");
  const lines = (bloque || "").split(/\r?\n/).map(normOCR).filter(Boolean);

  // meses tolerantes: permitimos 0ct, etc. ya normalizado
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

    let vigente = 0;
    // “Vigente” tolerante (a veces sale Vlgente, Vigcnte). Buscamos el número más cercano.
    const m1 = seg.match(/(-?(?:\d[\s., ]?){1,14})\s*vigente\b/i);
    const m2 = seg.match(/\bvigente\b\s*(-?(?:\d[\s., ]?){1,14})/i);
    if (m1?.[1]) vigente = toMiles(m1[1]) || 0;
    if (!vigente && m2?.[1]) vigente = toMiles(m2[1]) || 0;

    if (!vigente) {
      const vals = (seg.match(NUM) || [])
        .map(toMiles)
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100_000_000);
      if (vals.length) vigente = Math.max(...vals);
    }
    rows.push({ month, vigente: vigente || 0, v1_29: 0, v30_59: 0, v60_89: 0, v90p: 0, rating: null });
  }

  rows.sort((a, b) => compareMonthTok(a.month, b.month));
  return rows.slice(-12);
}

/**
 * OCR principal. Devuelve { rows, meta, sample } para depurar si algo falla.
 */
export async function ocrHistoriaFromPdf(buffer) {
  // parámetros más agresivos para mejorar reconocimiento
  const SCALE = 2.75;
  const MAX_PAGES = 8;
  const LANG = "spa+eng";

  const loadingTask = pdfjs.getDocument({
    data: buffer,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true
  });
  const pdf = await loadingTask.promise;

  const pagesToScan = [];
  for (let p = 1; p <= Math.min(MAX_PAGES, pdf.numPages); p++) pagesToScan.push(p);

  const worker = await createWorker(LANG);
  await worker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "6" // Assume a single uniform block of text
  });

  let ocrText = "";
  for (const p of pagesToScan) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const png = canvas.toBuffer("image/png");
    const { data: { text } } = await worker.recognize(png);
    ocrText += `\n\n===PAGE:${p}===\n${text}\n`;
  }

  await worker.terminate();

  const rows = parseHistoriaOcrText(ocrText);
  return {
    rows,
    meta: { pages: pagesToScan.length, scale: SCALE, lang: LANG },
    sample: ocrText.slice(0, 1200) // primer bloque para debug rápido
  };
}
