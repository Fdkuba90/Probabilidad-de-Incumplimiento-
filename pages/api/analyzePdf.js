// pages/api/analyzePdf.js
import { promises as fs } from "fs";
import formidable from "formidable";
import { parsePdf } from "../../lib/parser";
import { puntuarSinAtrasos, puntuarConAtrasos, calcularPI } from "../../lib/scoring";
import { prisma } from "../../lib/prisma"; // 👈 Prisma para guardar en BD

/** Mapeo fijo de Código por ID para mostrar en la tabla */
const CODIGO_POR_ID = {
  // SIN ATRASOS
  1:  "BK12_NUM_CRED",
  6:  "NBK12_PCT_PROMT",
  9:  "BK24_PCT_60PLUS",
  11: "NBK12_COMM_PCT_PLUS",
  14: "BK12_IND_QCRA",
  15: "BK12_MAX_CREDIT_AMT",
  16: "MONTHS_ON_FILE_BANKING",
  17: "MONTHS_SINCE_LAST_OPEN_BANKING",
  // CON ATRASOS
  4:  "BK12_NUM_EXP_PAIDONTIME",
  5:  "BK12_PCT_PROMT",
  7:  "BK12_PCT_SAT",
  12: "BK12_PCT_90PLUS",
  13: "BK12_DPD_PROM",
};

export const config = { api: { bodyParser: false } };

/* ===== Helpers ===== */
function toNumberOrNull(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/\s+/g, "").replace(/,/g, "").replace(/[$%]/g, "");
  if (s === "" || s.toLowerCase() === "sininformación") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function normInfo(v) {
  if (v == null) return "Sin Información";
  const s = String(v).trim();
  if (s === "" || s === "--" || s === "-") return "Sin Información";
  return v;
}
const ALL_CODES = new Set(Object.values(CODIGO_POR_ID));
const IDS_WANTED = new Set(Object.keys(CODIGO_POR_ID).map(Number));
const isIdToken = (t) => /^\d{1,3}$/.test(t);
const isCodeToken = (t) => /^[A-Z0-9_]{2,}$/.test(t);
const isNumberLike = (t) => /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(t);

/** util para escoger el token más cercano a una X dada con un predicado */
function pickNearest(tokens, xRef, pred) {
  let best = null, bestDx = Infinity;
  for (const tk of tokens) {
    if (!pred(tk.s)) continue;
    const dx = Math.abs(tk.x - xRef);
    if (dx < bestDx) { bestDx = dx; best = tk; }
  }
  return best;
}

/**
 * Extrae filas ID–CÓDIGO–VALOR:
 */
async function extractCalificadorRows(pdfBuffer) {
  let PDFParserMod = null;
  try { PDFParserMod = await import("pdf2json"); } catch { return null; }
  const PDFParser = PDFParserMod.default || PDFParserMod.PDFParser || PDFParserMod;
  if (!PDFParser) return null;

  const pdfParser = new PDFParser();
  const data = await new Promise((resolve, reject) => {
    pdfParser.on("pdfParser_dataError", (e) => reject(e.parserError || e));
    pdfParser.on("pdfParser_dataReady", (d) => resolve(d));
    pdfParser.parseBuffer(pdfBuffer);
  });

  const dec = (t) => { try { return decodeURIComponent(t || ""); } catch { return t || ""; } };
  const out = [];

  for (const page of (data.Pages || [])) {
    const raw = (page.Texts || [])
      .map(t => ({ x: t.x, y: t.y, s: (t.R && t.R[0] && dec(t.R[0].T)) || "" }))
      .filter(tk => tk.s && !/^\W+$/.test(tk.s));

    // Detectar encabezados
    const idHead   = raw.find(t => /Identificador/i.test(t.s));
    const codeHead = raw.find(t => /Código/i.test(t.s));
    const valHead  = raw.find(t => /Valor/i.test(t.s));
    const hasHeads = !!(idHead && codeHead && valHead);

    const yTol = hasHeads ? 0.7 : 1.8;
    const lines = [];
    for (const tk of raw) {
      let line = lines.find(l => Math.abs(l.y - tk.y) <= yTol);
      if (!line) { line = { y: tk.y, cells: [] }; lines.push(line); }
      line.cells.push({ x: tk.x, y: tk.y, s: tk.s });
    }

    for (const ln of lines) {
      const cells = ln.cells.sort((a, b) => a.x - b.x);
      const tokens = cells.flatMap(c => c.s.split(/\s+/)).filter(Boolean);
      if (tokens.length < 3) continue;

      const id = Number(tokens[0]);
      const code = tokens[1];
      const value = tokens[tokens.length - 1];
      if (IDS_WANTED.has(id) && ALL_CODES.has(code)) {
        out.push({ id, codigo: code, valorRaw: value });
      }
    }
  }

  const seen = new Set();
  return out.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" }); 
    return; 
  }

  try {
    const form = formidable({ multiples: false, keepExtensions: true, maxFileSize: 40 * 1024 * 1024 });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, fl) => (err ? reject(err) : resolve({ fields: f, files: fl })));
    });

    const uploaded = Array.isArray(files?.file) ? files.file[0] : files?.file;
    if (!uploaded?.filepath) return res.status(400).json({ error: "FILE_UPLOAD_NOT_FOUND" });

    const pdfBuffer = await fs.readFile(uploaded.filepath);
    const metodo = String(fields.metodo || "sin").toLowerCase(); // "sin" | "con"

    // Parse general
    const parsed = await parsePdf(pdfBuffer);

    // Indicadores
    let calRows = await extractCalificadorRows(pdfBuffer);
    if (Array.isArray(calRows)) parsed.calificaRows = calRows;

    const rows = parsed.calificaRows || [];
    const mapById = new Map(rows.map(r => [r.id, r]));

    const idsNecesarios = (metodo === "con")
      ? [4, 5, 7, 12, 13, 14, 16]
      : [1, 6, 9, 11, 14, 15, 16, 17];

    const val = {};
    const idsTabla = [];
    for (const id of idsNecesarios) {
      const row = mapById.get(id);
      const valorDisplay = normInfo(row?.valorRaw);
      val[id] = toNumberOrNull(valorDisplay) ?? valorDisplay;
      idsTabla.push({ id, codigo: CODIGO_POR_ID[id], valor: valorDisplay });
    }

    // Puntaje y PI
    const scored = metodo === "con" ? puntuarConAtrasos(val) : puntuarSinAtrasos(val);
    const puntajeTotal = scored.puntajeTotal;
    idsTabla.forEach(r => { r.puntaje = scored?.pts?.[r.id] ?? null; });
    const pi = calcularPI(puntajeTotal);

    // Guardado automático en la base
    try {
      const nombre = parsed.razonSocial || "";
      const rfc = parsed.rfc || "";
      if (nombre && rfc) {
        await prisma.cliente.upsert({
          where: { rfc: String(rfc) },
          update: { nombre, calificacion: String(puntajeTotal), pi: String(pi) },
          create: { nombre, rfc, calificacion: String(puntajeTotal), pi: String(pi) },
        });
      }
    } catch (e) {
      console.error("Error guardando cliente en BD:", e);
    }

    res.status(200).json({
      razonSocial: parsed.razonSocial || "",
      rfc: parsed.rfc || "",
      puntajeTotal,
      pi,
      califica: { ids: idsTabla.sort((a, b) => a.id - b.id) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}

