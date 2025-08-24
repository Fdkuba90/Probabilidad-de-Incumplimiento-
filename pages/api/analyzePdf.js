// pages/api/analyzePdf.js
import { promises as fs } from "fs";
import formidable from "formidable";
import { parsePdf } from "../../lib/parser";
import { puntuarSinAtrasos, puntuarConAtrasos, calcularPI } from "../../lib/scoring";
import { prisma } from "../../lib/prisma";

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
  if (s === "" || /^sininformaci[oó]n$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function normInfo(v) {
  if (v == null) return "Sin Información";
  const s = String(v).trim();
  if (s === "" || s === "--" || s === "-") return "Sin Información";
  if (/^N\/?A\.?$/i.test(s) || /^N\.A\.?$/i.test(s)) return "Sin Información";
  return v;
}
const ALL_CODES = new Set(Object.values(CODIGO_POR_ID));
const IDS_WANTED = new Set(Object.keys(CODIGO_POR_ID).map(Number));

/** Lee tabla por coordenadas con pdf2json (opcional, complementa lo que venga por texto) */
async function extractCalificadorRows(pdfBuffer) {
  let PDFParserMod = null;
  try { PDFParserMod = await import("pdf2json"); } catch { return []; }
  const PDFParser = PDFParserMod.default || PDFParserMod.PDFParser || PDFParserMod;
  if (!PDFParser) return [];

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

    // Buscar encabezados (flexible)
    const idHead   = raw.find(t => /Identificador/i.test(t.s));
    const codeHead = raw.find(t => /C[oó]digo/i.test(t.s));
    const valHead  = raw.find(t => /Valor/i.test(t.s));
    const hasHeads = !!(idHead && codeHead && valHead);

    // Agrupar por línea
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
      // última celda “parecida a valor”
      let value = tokens.slice(2).join(" ").trim();
      // si es muy larga, quédate con el último token
      if (value.length > 24) value = tokens[tokens.length - 1];

      if (IDS_WANTED.has(id) && ALL_CODES.has(code)) {
        if (/^(--|-|N\/?A|N\.A\.)$/i.test(value)) value = "Sin Información";
        out.push({ id, codigo: code, valorRaw: value });
      }
    }
  }

  // Unicidad por ID
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
    const udi = Number(String(fields.udi ?? "0").replace(",", ".")) || 0;

    // 1) Parse principal (texto)
    const parsed = await parsePdf(pdfBuffer);

    // 2) Complemento por coordenadas (fusiona, NO sustituye)
    const calRowsByCoords = await extractCalificadorRows(pdfBuffer).catch(() => []);
    const base = Array.isArray(parsed.calificaRows) ? parsed.calificaRows : [];
    const mergedById = new Map(base.map(r => [r.id, r]));
    for (const r of calRowsByCoords) if (!mergedById.has(r.id)) mergedById.set(r.id, r);
    const rows = Array.from(mergedById.values());

    // 3) Selección de IDs según metodología
    const idsNecesarios = (metodo === "con")
      ? [4, 5, 7, 12, 13, 14, 16]
      : [1, 6, 9, 11, 14, 15, 16, 17];

    const mapById = new Map(rows.map(r => [r.id, r]));
    const val = {};
    const idsTabla = [];

    for (const id of idsNecesarios) {
      const row = mapById.get(id);
      const valorDisplay = normInfo(row?.valorRaw);
      const valorNum = toNumberOrNull(valorDisplay);

      // Para columnas porcentuales que podrían venir como “Sin Información”
      val[id] = (valorNum != null) ? valorNum : (valorDisplay === "Sin Información" ? "Sin Información" : valorDisplay);
      idsTabla.push({ id, codigo: CODIGO_POR_ID[id], valor: valorDisplay });
    }

    // _udis para ID 15 (solo "sin atrasos")
    if (metodo === "sin") {
      const row15 = mapById.get(15);
      const maxCredit = toNumberOrNull(row15?.valorRaw) || 0;
      val._udis = udi > 0 ? maxCredit / udi : 0;
    }

    // 4) Puntaje y PI
    const scored = metodo === "con" ? puntuarConAtrasos(val) : puntuarSinAtrasos(val);
    const puntajeTotal = scored.puntajeTotal;
    idsTabla.forEach(r => { r.puntaje = scored?.pts?.[r.id] ?? null; });
    const pi = calcularPI(puntajeTotal);

    // 5) Guardado automático en la base (best-effort)
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
      activosTotales: {
        ...parsed.totales,
        unidad: parsed.milesDePesos ? "miles_de_pesos" : "pesos"
      },
      califica: { ids: idsTabla.sort((a, b) => a.id - b.id) },
      meta: {
        metodologia: metodo,
        puntosBase: scored.puntosBase,
        debug: parsed._debug || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}
