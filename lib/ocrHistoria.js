// lib/ocrHistoria.js (compatible con pdfjs-dist v4.x)
// OCR de "Historia por mes (pesos)" con @napi-rs/canvas + pdfjs-dist + tesseract.js

import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist";
import Tesseract from "tesseract.js";

pdfjs.GlobalWorkerOptions.workerSrc = undefined;

class NapiCanvasFactory {
  create(width, height) {
    const w = Math.ceil(width), h = Math.ceil(height);
    const canvas = createCanvas(w, h);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(c, width, height) {
    c.canvas.width = Math.ceil(width);
    c.canvas.height = Math.ceil(height);
  }
  destroy(c) {
    if (!c) return;
    c.canvas.width = 0;
    c.canvas.height = 0;
  }
}

const CANVAS_FACTORY = new NapiCanvasFactory();
const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
const MES_RE = new RegExp(`\\b(?:${MESES.join("|")})\\s+20\\d{2}\\b`, "g");

function toMilesNumber(tok) {
  const s = String(tok)
    .replace(/[^\d.,\s-]/g, "")
    .replace(/\s+/g, "")
    .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "")
    .replace(/,/g, ".");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1000);
}

async function findHistoriaPages(pdfDocument) {
  const pages = [];
  for (let p = 1; p <= pdfDocument.numPages; p++) {
    const page = await pdfDocument.getPage(p);
    const text = await page.getTextContent();
    const joined = text.items.map(it => it.str).join(" ").replace(/\s+/g, " ");
    if (/Historia\s+por\s+mes\s*\(pesos\)/i.test(joined) || /\bHistoria\b/i.test(joined)) {
      pages.push(p);
    }
  }
  return pages.length ? pages : Array.from({ length: pdfDocument.numPages }, (_, i) => i + 1);
}

async function renderPageToPng(page, scale = 2.2) {
  const viewport = page.getViewport({ scale });
  const { canvas, context } = CANVAS_FACTORY.create(viewport.width, viewport.height);
  await page.render({ canvasContext: context, viewport, canvasFactory: CANVAS_FACTORY }).promise;
  const buf = canvas.toBuffer("image/png");
  CANVAS_FACTORY.destroy({ canvas, context });
  return buf;
}

async function ocrText(pngBuffer) {
  const { data: { text } } = await Tesseract.recognize(pngBuffer, "spa", {
    tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz +-/:()"
  });
  return text.replace(/\u00A0/g, " ").replace(/\r/g, "\n");
}

function parseHistoriaFromOcrText(text) {
  const tokens = Array.from(text.matchAll(MES_RE)).map(m => ({ token: m[0], idx: m.index }));
  if (!tokens.length) return { rows: [], historiaRaw: text };

  const blocks = [];
  for (let i = 0; i < tokens.length; i++) {
    const start = tokens[i].idx;
    const end = (i + 1 < tokens.length) ? tokens[i + 1].idx : text.length;
    const month = tokens[i].token.replace(/\s+/g, " ");
    const body = text.slice(start, end);

    const pickNum = (labelRe) => {
      const m = body.match(new RegExp(labelRe.source + "[^\\n\\r]*?([\\d.,\\s]{1,20})", "i"));
      if (m?.[1]) return toMilesNumber(m[1]);
      const lines = body.split(/\n/);
      for (let k = 0; k < Math.min(5, lines.length); k++) {
        const ms = lines[k].match(/[\d.,\s]{3,20}/g);
        if (ms?.length) return toMilesNumber(ms[0]);
      }
      return 0;
    };

    const vigente = pickNum(/^\s*Vigente\b/);
    const v1_29  = pickNum(/^\s*Vencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/);
    const v30_59 = pickNum(/^\s*Vencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/);
    const v60_89 = pickNum(/^\s*Vencido\s+de\s+60\s*a\s*89\s*d[ií]as\b/);
    const v90p   = pickNum(/^\s*Vencido\s+a\s*m[aá]s\s*de\s*89\s*d[ií]as\b|^\s*90\+\b|^>\s*89\b/);

    const ratingTokens = Array.from(body.matchAll(/\b\d(?:NC|[A-Z]\d)\b/gi)).map(x => x[0].toUpperCase());
    const rating = ratingTokens.length ? Array.from(new Set(ratingTokens)).join(" ") : null;

    blocks.push({ month, vigente, v1_29, v30_59, v60_89, v90p, rating });
  }

  blocks.sort((a, b) => {
    const [ma, ya] = a.month.split(/\s+/); const [mb, yb] = b.month.split(/\s+/);
    const ia = MESES.indexOf(ma); const ib = MESES.indexOf(mb);
    return (ya - yb) || (ia - ib);
  });

  return { rows: blocks.slice(-12), historiaRaw: text };
}

export async function extractHistoriaOCR(pdfBuffer) {
  const loadingTask = pdfjs.getDocument({ data: pdfBuffer });
  const pdfDocument = await loadingTask.promise;

  const pages = await findHistoriaPages(pdfDocument);

  const allRows = [];
  let dump = "";

  for (const p of pages) {
    const page = await pdfDocument.getPage(p);
    const png = await renderPageToPng(page, 2.2);
    const text = await ocrText(png);
    dump += `\n\n[PAGE ${p} OCR]\n` + text;
    const parsed = parseHistoriaFromOcrText(text);
    allRows.push(...parsed.rows);
  }

  const byMonth = new Map();
  for (const r of allRows) byMonth.set(r.month, r);

  const rows = Array.from(byMonth.values())
    .sort((a, b) => {
      const [ma, ya] = a.month.split(/\s+/); const [mb, yb] = b.month.split(/\s+/);
      const ia = MESES.indexOf(ma); const ib = MESES.indexOf(mb);
      return (ya - yb) || (ia - ib);
    })
    .slice(-12);

  return { rows, historiaRaw: dump };
}
