// lib/ocrHistoria.js — OCR del bloque "Historia:" con detección de página y recorte por coordenadas
import { createWorker } from "tesseract.js";
import * as pdfjs from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.js";
import { createCanvas } from "@napi-rs/canvas";

const MONTHS = "Ene Feb Mar Abr May Jun Jul Ago Sep Oct Nov Dic".split(" ");
const MES_IDX = Object.fromEntries(MONTHS.map((m, i) => [m, i]));

function parseMonthToken(tok) {
  const m = tok && tok.match(/^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+(\d{4})$/i);
  if (!m) return null;
  const key = m[1].slice(0,3).replace(/^./, c => c.toUpperCase());
  const mm = MES_IDX[key];
  const yy = Number(m[2]);
  if (!Number.isFinite(mm) || !Number.isFinite(yy)) return null;
  return { y: yy, m: mm };
}
function compareMonthTok(a, b) {
  const pa = parseMonthToken(a), pb = parseMonthToken(b);
  if (!pa || !pb) return 0;
  return pa.y === pb.y ? (pa.m - pb.m) : (pa.y - pb.y);
}

function getHistoriaOcrBlock(fullText) {
  const reStart = /(^|\n)\s*Historia\s*:?\s*(\n|$)/i;
  const reEnd   = /(^|\n)\s*(INFORMACIÓN\s+COMERCIAL|INFORMACION\s+COMERCIAL|Califica(?:ción)?|DECLARATIVAS|INFORMACIÓN\s+DE\s+PLD|FIN DEL REPORTE)\b/i;
  const ms = fullText.search(reStart);
  if (ms === -1) return "";
  const rest = fullText.slice(ms + (fullText.slice(ms).match(reStart)?.[0]?.length || 0));
  const me = rest.search(reEnd);
  return me !== -1 ? rest.slice(0, me) : rest;
}

function parseHistoriaOcrText(txt) {
  const bloque = getHistoriaOcrBlock(txt || "");
  const lines = (bloque || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const MES = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i;
  const NUM = /-?(?:\d[\s., ]?){1,14}/g;

  const toMiles = (s) => {
    const c = String(s)
      .replace(/\s+/g,'')
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g,'')
      .replace(/,/g,'.');
    const n = Number(c);
    return Number.isFinite(n) ? Math.round(n*1000) : NaN;
  };

  const rows = [];
  for (let i=0;i<lines.length;i++) {
    if (!MES.test(lines[i])) continue;
    const month = lines[i].replace(/\s+/g,' ');
    const seg = lines.slice(i+1, i+8).join(' ');

    let vigente = 0;
    const m1 = seg.match(/(-?(?:\d[\s., ]?){1,14})\s*Vigente\b/i);
    const m2 = seg.match(/\bVigente\b\s*(-?(?:\d[\s., ]?){1,14})/i);
    if (m1?.[1]) vigente = toMiles(m1[1]) || 0;
    if (!vigente && m2?.[1]) vigente = toMiles(m2[1]) || 0;

    if (!vigente) {
      const vals = (seg.match(NUM)||[]).map(toMiles).filter(n => Number.isFinite(n) && n>0 && n<=100_000_000);
      if (vals.length) vigente = Math.max(...vals);
    }
    rows.push({ month, vigente: vigente||0, v1_29:0, v30_59:0, v60_89:0, v90p:0, rating:null });
  }
  rows.sort((a,b)=> compareMonthTok(a.month, b.month));
  return rows.slice(-12);
}

/**
 * Encuentra páginas candidatas y bounding box aproximado del bloque "Historia:"
 * usando pdfjs.getTextContent() (más confiable que OCR para localizar la sección).
 */
async function findHistoriaRegions(pdf) {
  const hits = []; // { page, bbox: {x,y,w,h}, viewport }
  const MAX_PAGES = Math.min(pdf.numPages, 12);

  for (let p = 1; p <= MAX_PAGES; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    const tc = await page.getTextContent();

    // Busca el token "Historia" y un siguiente encabezado para delimitar
    let historiaItems = [];
    let endItems = [];
    const END_RE = /(INFORMACIÓN\s+COMERCIAL|INFORMACION\s+COMERCIAL|Califica(?:ción)?|DECLARATIVAS|INFORMACIÓN\s+DE\s+PLD|FIN DEL REPORTE)/i;

    for (const item of tc.items) {
      const s = String(item.str || "").replace(/\s+/g, " ").trim();
      if (/^Historia:?$/i.test(s) || /^Historia\b:?/i.test(s)) {
        historiaItems.push(item);
      } else if (END_RE.test(s)) {
        endItems.push(item);
      }
    }

    if (historiaItems.length) {
      // Tomamos el primer "Historia" y el primer end posterior (si existe)
      const first = historiaItems[0];
      const firstY = first.transform[5]; // y
      let endY = null;

      for (const e of endItems) {
        const y = e.transform[5];
        if (y < firstY) { // en PDF coords, y decrece hacia abajo
          endY = y;
          break;
        }
      }

      // Bounding heurístico: ancho completo, desde y_top (un poco arriba) hasta endY (o 60% de la página)
      const x = 0;
      const width = viewport.width;
      const yTop = Math.max(0, firstY - 40);
      const yBottom = endY != null ? endY : viewport.height * 0.4;

      // Normaliza (asegura h>0)
      const y1 = Math.min(yTop, yBottom);
      const y2 = Math.max(yTop, yBottom);
      const height = Math.max(20, y2 - y1);

      hits.push({ pageIndex: p, bbox: { x, y: y1, w: width, h: height }, viewport });
    }
  }
  return hits;
}

export async function ocrHistoriaFromPdf(buffer) {
  const loadingTask = pdfjs.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;

  // Encuentra páginas y área aproximada de "Historia:"
  const regions = await findHistoriaRegions(pdf);
  if (!regions.length) {
    // fallback: intenta primeras 6 páginas enteras (último recurso)
    for (let p = 1; p <= Math.min(pdf.numPages, 6); p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 3.0 });
      regions.push({
        pageIndex: p,
        bbox: { x: 0, y: 0, w: viewport.width, h: viewport.height },
        viewport
      });
    }
  }

  const worker = await createWorker({
    // logger: m => console.log(m), // <-- descomenta para ver progreso
  });
  await worker.loadLanguage("spa+eng");
  await worker.initialize("spa+eng");
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789$.,-+ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÉÍÓÚÑáéíóú",
    tessedit_pageseg_mode: "6" // Assume a single uniform block of text
  });

  let ocrText = "";

  for (const reg of regions) {
    const page = await pdf.getPage(reg.pageIndex);

    // Render de página a alta resolución
    const SCALE = 3.0;
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Recorte del bbox escalado
    const sx = Math.max(0, Math.floor(reg.bbox.x * (SCALE / (reg.viewport?.scale || 1))));
    const sy = Math.max(0, Math.floor(reg.bbox.y * (SCALE / (reg.viewport?.scale || 1))));
    const sw = Math.min(canvas.width - sx, Math.floor(reg.bbox.w * (SCALE / (reg.viewport?.scale || 1))));
    const sh = Math.min(canvas.height - sy, Math.floor(reg.bbox.h * (SCALE / (reg.viewport?.scale || 1))));

    const crop = createCanvas(sw, sh);
    const cctx = crop.getContext("2d");
    cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const png = crop.toBuffer("image/png");
    const { data: { text } } = await worker.recognize(png);
    ocrText += `\n\n===PAGE:${reg.pageIndex}===\n${text}\n`;
  }

  await worker.terminate();

  // (Opcional) Log del OCR para depurar
  // console.log("OCR Historia preview:\n", ocrText.slice(0, 1200));

  const rows = parseHistoriaOcrText(ocrText);
  if (!rows?.length) return [];
  const somePos = rows.some(r => (r.vigente||0) > 0);
  return somePos ? rows : [];
}
