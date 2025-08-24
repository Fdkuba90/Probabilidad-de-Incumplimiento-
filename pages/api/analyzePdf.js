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
  if (!s || /^sininformaci[oó]n$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function normInfo(v) {
  if (v == null) return "Sin Información";
  const s = String(v).trim();
  if (!s || s === "--" || s === "-") return "Sin Información";
  return v;
}
const ALL_CODES = new Set(Object.values(CODIGO_POR_ID));
const IDS_WANTED = new Set(Object.keys(CODIGO_POR_ID).map(Number));

/** util para escoger el token más cercano a una X dada con un predicado */
const isIdToken = (t) => /^\d{1,3}$/.test(t);
const isCodeToken = (t) => /^[A-Z0-9_]{2,}$/.test(t);
const isNumberLike = (t) => /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(t);
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
 * Extrae filas ID–CÓDIGO–VALOR por coordenadas (pdf2json)
 * – Restringe a la página/área debajo de “Califica / Calificador”
 * – Usa bandas por encabezados “Identificador / Código / Valor”
 * – Fallback derecha→izquierda si no hay encabezados claros
 */
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

    const title = raw.find(t => /Calific(?:a|ador)\b/i.test(t.s));
    if (!title) continue; // no es la página de califica/calificador

    const idHead   = raw.find(t => /Identificador\s+de\s+la\s+caracter[íi]stica/i.test(t.s));
    const codeHead = raw.find(t => /C[óo]digo\s+de\s+la\s+caracter[íi]stica/i.test(t.s));
    const valHead  = raw.find(t => /Valor\s+de\s+la\s+caracter[íi]stica/i.test(t.s));
    const hasHeads = !!(idHead && codeHead && valHead);

    // agrupar por línea y quedarnos con líneas DEBAJO del título
    const yTol = hasHeads ? 0.7 : 1.8;
    const minY = title.y + 0.2; // todo lo que esté debajo del título
    const lines = [];
    for (const tk of raw) {
      if (tk.y < minY) continue;
      let line = lines.find(l => Math.abs(l.y - tk.y) <= yTol);
      if (!line) { line = { y: tk.y, cells: [] }; lines.push(line); }
      line.cells.push({ x: tk.x, y: tk.y, s: tk.s });
    }

    let midIdCode = null, midCodeVal = null;
    if (hasHeads) {
      midIdCode = (idHead.x + codeHead.x) / 2;
      midCodeVal = (codeHead.x + valHead.x) / 2;
    }

    for (const ln of lines) {
      const cells = ln.cells.sort((a, b) => a.x - b.x);

      // Método con bandas cuando hay encabezados
      if (hasHeads) {
        const bandId    = cells.filter(c => c.x <  midIdCode);
        const bandCode  = cells.filter(c => c.x >= midIdCode && c.x < midCodeVal);
        const bandValue = cells.filter(c => c.x >= midCodeVal);

        const idTk   = pickNearest(bandId,   idHead.x,   (s) => isIdToken(s));
        const codeTk = pickNearest(bandCode, codeHead.x, (s) => isCodeToken(s));

        // Valor: num o "Sin Información" (que a veces viene en dos tokens)
        let valTk = pickNearest(
          bandValue,
          valHead.x,
          (s) =>
            isNumberLike(s) || s === "--" || s === "-" ||
            /^N\/?A\.?$/i.test(s) || /^N\.A\.?$/i.test(s) ||
            /^(Sin|Información)$/i.test(s)
        );

        let value = valTk?.s ?? null;
        if (!value) {
          // tomar el más a la derecha que parezca número
          const rightMost = [...bandValue].reverse().find(c =>
            isNumberLike(c.s) || c.s === "--" || c.s === "-" ||
            /^N\/?A\.?$/i.test(c.s) || /^N\.A\.?$/i.test(c.s)
          );
          value = rightMost?.s ?? null;
        } else {
          // unir "Sin Información"
          const sinIdx = bandValue.findIndex(c => /^(Sin)$/i.test(c.s));
          if (sinIdx >= 0 && bandValue[sinIdx + 1] && /^(Información)$/i.test(bandValue[sinIdx + 1].s)) {
            value = "Sin Información";
          }
        }
        if (value === "--" || value === "-" || /^N\/?A\.?$/i.test(value) || /^N\.A\.?$/i.test(value)) value = "Sin Información";

        if (idTk && codeTk && value != null) {
          const id = Number(idTk.s);
          const codigo = codeTk.s;
          if (IDS_WANTED.has(id) && ALL_CODES.has(codigo)) {
            out.push({ id, codigo, valorRaw: value });
            continue;
          }
        }
      }

      // Fallback: derecha→izquierda en una línea
      const tokens = cells.flatMap(c => c.s.split(/\s+/)).filter(Boolean);
      if (tokens.length < 3) continue;
      // buscar patrón ID CODE ... VALUE
      let iId = -1, iCode = -1;
      for (let i = 0; i < Math.min(tokens.length - 2, 8); i++) {
        if (isIdToken(tokens[i]) && isCodeToken(tokens[i + 1])) { iId = i; iCode = i + 1; break; }
      }
      if (iId === -1) continue;

      const id = Number(tokens[iId]);
      const codigo = tokens[iCode];
      if (!IDS_WANTED.has(id) || !ALL_CODES.has(codigo)) continue;

      let value = null;
      for (let j = tokens.length - 1; j > iCode; j--) {
        const t = tokens[j];
        if (t === "--" || t === "-") { value = "Sin Información"; break; }
        if (/^N\/?A\.?$/i.test(t) || /^N\.A\.?$/i.test(t)) { value = "Sin Información"; break; }
        if (t.toLowerCase() === "información" && j > iCode + 1 && tokens[j - 1].toLowerCase() === "sin") {
          value = "Sin Información"; break;
        }
        if (isNumberLike(t) || isNumberLike(t.replace(/[$%]/g, ""))) { value = t; break; }
      }
      if (!value) continue;

      out.push({ id, codigo, valorRaw: value });
    }
  }

  // quedarnos con el primero por ID
  const seen = new Set();
  return out.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Método no permitido" }); return; }

  try {
    const form = formidable({ multiples: false, keepExtensions: true, maxFileSize: 40 * 1024 * 1024 });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, fl) => (err ? reject(err) : resolve({ fields: f, files: fl })));
    });

    const uploaded = Array.isArray(files?.file) ? files.file[0] : files?.file;
    if (!uploaded?.filepath) return res.status(400).json({ error: "FILE_UPLOAD_NOT_FOUND" });

    const pdfBuffer = await fs.readFile(uploaded.filepath);
    const metodo = String(Array.isArray(fields.metodo) ? fields.metodo[0] : fields.metodo || "sin").toLowerCase(); // "sin" | "con"

    // 1) Parse general (texto: ya maneja Califica/Calificador)
    const parsed = await parsePdf(pdfBuffer);

    // 2) Extraer por coordenadas (pdf2json) y FUSIONAR con lo que ya trajo `parser`
    const byCoords = await extractCalificadorRows(pdfBuffer).catch(() => []);
    const baseRows = Array.isArray(parsed.calificaRows) ? parsed.calificaRows : [];
    const map = new Map(baseRows.map(r => [r.id, r])); // lo del parser primero
    for (const r of byCoords) {
      const prev = map.get(r.id);
      const prevVal = normInfo(prev?.valorRaw);
      const newVal  = normInfo(r.valorRaw);
      // si el parser tenía "Sin Información" y coords trae un valor, usar coords
      if (!prev || /^Sin Información$/i.test(prevVal)) map.set(r.id, r);
      // si ambos tienen valor, dejamos el del parser (suele ser más estable para “Califica”)
    }
    const calRows = Array.from(map.values());
    parsed.calificaRows = calRows;

    // 3) Armar valores para scoring según metodología
    const rows = parsed.calificaRows || [];
    const mapById = new Map(rows.map(r => [r.id, r]));
    const idsNecesarios = (metodo === "con")
      ? [4, 5, 7, 12, 13, 14, 16]
      : [1, 6, 9, 11, 14, 15, 16, 17];

    const val = {};
    const idsTabla = [];
    for (const id of idsNecesarios) {
      const row = mapById.get(id);
      if (!row) {
        idsTabla.push({ id, codigo: CODIGO_POR_ID[id], valor: "Sin Información" });
        val[id] = "Sin Información";
        continue;
      }
      const valorDisplay = normInfo(row.valorRaw);
      const valorNum = toNumberOrNull(valorDisplay);
      val[id] = valorNum ?? valorDisplay;
      idsTabla.push({ id, codigo: CODIGO_POR_ID[id], valor: valorDisplay });
    }

    // 4) Puntaje y PI
    const scored = metodo === "con" ? puntuarConAtrasos(val) : puntuarSinAtrasos(val);
    const puntajeTotal = scored.puntajeTotal;
    idsTabla.forEach(r => { r.puntaje = scored?.pts?.[r.id] ?? null; });
    const pi = calcularPI(puntajeTotal);

    // 5) Guardar en BD (si hay RFC y nombre)
    try {
      const nombre = parsed.razonSocial || "";
      const rfc = parsed.rfc || "";
      if (nombre && rfc) {
        await prisma.cliente.upsert({
          where: { rfc: String(rfc) },
          update: { nombre: String(nombre), calificacion: String(puntajeTotal), pi: String(pi) },
          create: { nombre: String(nombre), rfc: String(rfc), calificacion: String(puntajeTotal), pi: String(pi) },
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

