// pages/api/analyzePdf.js
import { promises as fs } from "fs";
import formidable from "formidable";
import { parsePdf } from "../../lib/parser";
import { puntuarSinAtrasos, puntuarConAtrasos, calcularPI } from "../../lib/scoring";

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
 * 1) Si encuentra encabezados “Identificador… / Código… / Valor…”, usa sus X
 *    y toma por cada renglón el token más cercano dentro de cada BANDA de columna.
 * 2) Si no hay encabezados, cae al método “derecha→izquierda” como fallback.
 *    (AQUÍ ES DONDE AHORA CAPTURA MÚLTIPLES TRIPLETES POR RENGLÓN)
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

    // Detectar encabezados y sus X
    const idHead   = raw.find(t => /Identificador\s+de\s+la\s+caracter[íi]stica/i.test(t.s));
    const codeHead = raw.find(t => /C[óo]digo\s+de\s+la\s+caracter[íi]stica/i.test(t.s));
    const valHead  = raw.find(t => /Valor\s+de\s+la\s+caracter[íi]stica/i.test(t.s));
    const hasHeads = !!(idHead && codeHead && valHead);

    // Agrupar por línea
    const yTol = hasHeads ? 0.7 : 1.8; // más estricto si hay encabezados
    const lines = [];
    for (const tk of raw) {
      if (/DOCUMENTO\s+SIN\s+VALOR|P[ÁA]GINA\s+\d+/i.test(tk.s)) continue;
      let line = lines.find(l => Math.abs(l.y - tk.y) <= yTol);
      if (!line) { line = { y: tk.y, cells: [] }; lines.push(line); }
      line.cells.push({ x: tk.x, y: tk.y, s: tk.s });
    }

    // Si hay encabezados, construir bandas de columna y limitar a líneas debajo
    const minY = hasHeads ? Math.min(idHead.y, codeHead.y, valHead.y) + 0.5 : -Infinity;
    let midIdCode = null, midCodeVal = null;
    if (hasHeads) {
      midIdCode = (idHead.x + codeHead.x) / 2;
      midCodeVal = (codeHead.x + valHead.x) / 2;
    }

    for (const ln of lines) {
      if (ln.y < minY) continue;
      const cells = ln.cells.sort((a, b) => a.x - b.x);

      if (hasHeads) {
        // 1) método por bandas
        const bandId    = cells.filter(c => c.x <  midIdCode);
        const bandCode  = cells.filter(c => c.x >= midIdCode && c.x < midCodeVal);
        const bandValue = cells.filter(c => c.x >= midCodeVal);

        const idTk   = pickNearest(bandId,   idHead.x,   (s) => isIdToken(s));
        const codeTk = pickNearest(bandCode, codeHead.x, (s) => isCodeToken(s));

        // Valor: dentro de la banda de valor
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
          const rightMost = [...bandValue].reverse().find(c =>
            isNumberLike(c.s) || c.s === "--" || c.s === "-" ||
            /^N\/?A\.?$/i.test(c.s) || /^N\.A\.?$/i.test(c.s)
          );
          value = rightMost?.s ?? null;
        } else {
          const sinIdx = bandValue.findIndex(c => /^(Sin)$/i.test(c.s));
          if (sinIdx >= 0 && bandValue[sinIdx + 1] && /^(Información)$/i.test(bandValue[sinIdx + 1].s)) {
            value = "Sin Información";
          }
        }

        if (value === "--" || value === "-" || /^N\/?A\.?$/i.test(value) || /^N\.A\.?$/i.test(value)) value = "Sin Información";
        if (idTk && value && String(value).trim() === String(idTk.s).trim()) value = null;

        if (idTk && codeTk && value != null) {
          const id = Number(idTk.s);
          const code = codeTk.s;
          if (IDS_WANTED.has(id) && ALL_CODES.has(code)) {
            out.push({ id, codigo: code, valorRaw: value });
            continue;
          }
        }
        // si falló, caer al fallback
      }

      // 2) Fallback: detectar “ID CÓDIGO ... valor(derecha)”
      //    *** MODIFICADO: ahora captura MÚLTIPLES tripletes por renglón ***
      const tokens = cells.flatMap(c => c.s.split(/\s+/)).filter(Boolean);
      if (tokens.length < 3) continue;

      let k = 0;
      while (k < tokens.length - 2) {
        if (isIdToken(tokens[k]) && isCodeToken(tokens[k + 1])) {
          const id = Number(tokens[k]);
          const code = tokens[k + 1];

          if (IDS_WANTED.has(id) && ALL_CODES.has(code)) {
            let value = null;
            let j = k + 2;
            for (; j < tokens.length; j++) {
              const t = tokens[j];
              if (t === "--" || t === "-") { value = "Sin Información"; j++; break; }
              if (/^N\/?A\.?$/i.test(t) || /^N\.A\.?$/i.test(t)) { value = "Sin Información"; j++; break; }
              if (t.toLowerCase() === "información" && j > k + 2 && tokens[j - 1].toLowerCase() === "sin") {
                value = "Sin Información"; j++; break;
              }
              if (isIdToken(t) && j + 1 < tokens.length && isCodeToken(tokens[j + 1])) {
                // llegó otro ID+CODE sin valor claro para el anterior
                break;
              }
              const tClean = t.replace(/[$%]/g, "");
              if (isNumberLike(t) || isNumberLike(tClean)) { value = t; j++; break; }
            }
            if (value && String(value).trim() !== String(id)) {
              out.push({ id, codigo: code, valorRaw: value });
            }
            k = j; // continuar después del valor hallado
            continue;
          }
        }
        k += 1;
      }
    }
  }

  // Deduplicar por ID (preferimos la primera ocurrencia —por columnas suele salir primero—)
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
    const udiInput = Array.isArray(fields.udi) ? fields.udi[0] : fields.udi;
    const metodo = String(Array.isArray(fields.metodo) ? fields.metodo[0] : fields.metodo || "sin").toLowerCase(); // "sin" | "con"
    const udi = toNumberOrNull(udiInput) || 0;

    // 1) Parse general
    const parsed = await parsePdf(pdfBuffer);

    // 2) Indicadores (todas las páginas, por columnas si hay encabezados)
    let calRows = await extractCalificadorRows(pdfBuffer);

    // 3) Fallback: fusionar si quedó corto
    if (!Array.isArray(calRows)) calRows = [];
    const base = parsed.calificaRows || [];
    if (calRows.length < 8 && base.length) {
      const map = new Map();
      for (const r of calRows) map.set(r.id, r);
      for (const r of base) if (!map.has(r.id) && IDS_WANTED.has(r.id) && ALL_CODES.has(r.codigo)) map.set(r.id, r);
      calRows = Array.from(map.values());
    }
    if (calRows.length) parsed.calificaRows = calRows;

    // ---- Califica por metodología ----
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
        val[id] = "Sin Información";
        idsTabla.push({ id, codigo: CODIGO_POR_ID[id] || "", valor: "Sin Información" });
        continue;
      }
      const valorDisplay = normInfo(row.valorRaw);
      const valorNum = toNumberOrNull(valorDisplay);

      if (metodo === "sin" ? (id === 6 || id === 11) : false) {
        val[id] = valorDisplay === "Sin Información" ? "Sin Información" : (valorNum ?? "Sin Información");
      } else {
        val[id] = valorNum ?? (valorDisplay === "Sin Información" ? "Sin Información" : valorDisplay);
      }
      idsTabla.push({ id, codigo: CODIGO_POR_ID[id] || row.codigo || "", valor: valorDisplay });
    }

    // _udis para ID 15 (solo "sin atrasos")
    if (metodo === "sin") {
      const row15 = mapById.get(15);
      const maxCredit = toNumberOrNull(row15?.valorRaw) || 0;
      val._udis = udi > 0 ? maxCredit / udi : 0;
    }

    // Puntaje base y PI
    const scored = metodo === "con" ? puntuarConAtrasos(val) : puntuarSinAtrasos(val);
    let puntajeTotal = scored.puntajeTotal;

    // asignar puntajes calculados
    idsTabla.forEach(r => { r.puntaje = scored?.pts?.[r.id] ?? null; });

    // === OVERRIDES ESPECIALES ===
    if (metodo === "sin") {
      const row9 = idsTabla.find(r => r.id === 9);
      if (row9 && (row9.valor === "Sin Información" || String(row9.valor).trim() === "--")) {
        const prev = scored?.pts?.[9] ?? 0;
        row9.valor = "Sin Información";
        row9.puntaje = -19;
        puntajeTotal = puntajeTotal - prev + (-19);
      }
    }
    {
      const row1 = idsTabla.find(r => r.id === 1);
      if (row1 && (row1.valor === "Sin Información" || String(row1.valor).trim() === "--")) {
        const prev = scored?.pts?.[1] ?? 0;
        row1.valor = "Sin Información";
        row1.puntaje = 53;
        puntajeTotal = puntajeTotal - prev + 53;
      }
    }
    {
      const row14 = idsTabla.find(r => r.id === 14);
      if (row14 && (row14.valor === "Sin Información" || String(row14.valor).trim() === "--")) {
        const prev = scored?.pts?.[14] ?? 0;
        const forced = (metodo === "con") ? 49 : 53;
        row14.valor = "Sin Información";
        row14.puntaje = forced;
        puntajeTotal = puntajeTotal - prev + forced;
      }
    }
    {
      const row17 = idsTabla.find(r => r.id === 17);
      if (row17 && (row17.valor === "Sin Información" || String(row17.valor).trim() === "--")) {
        const prev = scored?.pts?.[17] ?? 0;
        row17.valor = "Sin Información";
        row17.puntaje = 58;
        puntajeTotal = puntajeTotal - prev + 58;
      }
    }
    // ============================

    const pi = calcularPI(puntajeTotal);

    // Totales y buckets
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

    res.status(200).json({
      razonSocial: parsed.razonSocial || "",
      rfc: parsed.rfc || "",
      puntajeTotal,
      pi,
      activosTotales: { original, saldo, vigente, vencido, d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus, unidad },
      califica: {
        UDI: udi,
        ids: idsTabla.sort((a, b) => a.id - b.id)
      },
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
