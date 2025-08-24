// pages/api/analyzePdf.js
import { promises as fs } from "fs";
import formidable from "formidable";
import { parsePdf } from "../../lib/parser";
import { puntuarSinAtrasos, puntuarConAtrasos, calcularPI } from "../../lib/scoring";
import { prisma } from "../../lib/prisma"; // Prisma para guardar en BD

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

/**
 * Extrae filas ID–CÓDIGO–VALOR desde pdf2json (método ligero).
 * Si algún renglón no trae bien separadas las columnas, toma el último token como valor.
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

    // Agrupar por línea con tolerancia en Y
    const yTol = 1.2;
    const lines = [];
    for (const tk of raw) {
      let line = lines.find(l => Math.abs(l.y - tk.y) <= yTol);
      if (!line) { line = { y: tk.y, cells: [] }; lines.push(line); }
      line.cells.push({ x: tk.x, y: tk.y, s: tk.s });
    }

    for (const ln of lines) {
      const tokens = ln.cells
        .sort((a, b) => a.x - b.x)
        .flatMap(c => c.s.split(/\s+/).filter(Boolean));

      if (tokens.length < 3) continue;

      // Caso típico: [ID][CODIGO]...[VALOR]
      const id = Number(tokens[0]);
      const code = tokens[1];
      let value = tokens[tokens.length - 1];

      // Normalizar "Sin Información"
      if (value === "--" || value === "-") value = "Sin Información";

      if (IDS_WANTED.has(id) && ALL_CODES.has(code)) {
        // Evitar confundir ID con valor
        if (String(value).trim() === String(id)) continue;
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
    // 1) leer el PDF subido
    const form = formidable({ multiples: false, keepExtensions: true, maxFileSize: 40 * 1024 * 1024 });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, fl) => (err ? reject(err) : resolve({ fields: f, files: fl })));
    });

    const uploaded = Array.isArray(files?.file) ? files.file[0] : files?.file;
    if (!uploaded?.filepath) return res.status(400).json({ error: "FILE_UPLOAD_NOT_FOUND" });

    const pdfBuffer = await fs.readFile(uploaded.filepath);
    const metodo = String(Array.isArray(fields.metodo) ? fields.metodo[0] : fields.metodo || "sin").toLowerCase(); // "sin" | "con"

    // 2) parseo general -> incluye totales (por coordenadas + fallbacks)
    const parsed = await parsePdf(pdfBuffer);

    // 3) Indicadores (IDs) por pdf2json
    let calRows = await extractCalificadorRows(pdfBuffer);
    if (Array.isArray(calRows) && calRows.length) parsed.calificaRows = calRows;

    // ---- Mapeo para la tabla de indicadores ----
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

    // ---- Puntaje y PI ----
    const scored = metodo === "con" ? puntuarConAtrasos(val) : puntuarSinAtrasos(val);
    const puntajeTotal = scored.puntajeTotal ?? 0;
    idsTabla.forEach(r => { r.puntaje = scored?.pts?.[r.id] ?? null; });
    const pi = calcularPI(puntajeTotal);

    // ---- Resumen de Créditos Activos (de parser) ----
    const unidad = parsed.milesDePesos ? "miles_de_pesos" : "pesos";
    const t = parsed.totales || {};
    const original   = t.original   ?? 0;
    const vigente    = t.vigente    ?? 0;
    const d1_29      = t.d1_29      ?? 0;
    const d30_59     = t.d30_59     ?? 0;
    const d60_89     = t.d60_89     ?? 0;
    const d90_119    = t.d90_119    ?? 0;
    const d120_179   = t.d120_179   ?? 0;
    const d180_plus  = t.d180_plus  ?? 0;
    const vencido    = Math.round(d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus);
    const saldo      = Math.round(vigente + vencido);

    // ---- Guardado automático en la base (upsert por RFC) ----
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
      // seguimos respondiendo
    }

    // 5) responder (incluye ahora activosTotales)
    res.status(200).json({
      razonSocial: parsed.razonSocial || "",
      rfc: parsed.rfc || "",
      puntajeTotal,
      pi,
      activosTotales: {
        original, saldo, vigente, vencido,
        d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus,
        unidad,
      },
      califica: { ids: idsTabla.sort((a, b) => a.id - b.id) },
      meta: {
        metodologia: metodo,
        debug: parsed._debug || null,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}
