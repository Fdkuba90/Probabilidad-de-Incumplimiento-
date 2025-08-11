// /pages/api/analyzePdf.js
import pdfParse from "pdf-parse";

/**
 * Utilidades
 */
const norm = (s = "") =>
  s
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();

const toNumber = (raw) => {
  if (raw == null) return 0;
  let s = String(raw).trim();
  // quita separadores de miles (coma o espacios), mantiene punto decimal
  s = s.replace(/(?<=\d)[ ,](?=\d{3}(\D|$))/g, "");
  // caso extraño tipo "0.3" o "29,874.3"
  s = s.replace(/,/g, ""); // ya quitamos todo
  const n = Number(s);
  return isNaN(n) ? 0 : n;
};

const money = (n) =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
  }).format(n);

/**
 * Extrae bloque "Califica" → mapa { id -> valor }
 */
function getCalificaValues(txt) {
  const out = {};
  try {
    const i = txt.indexOf("Califica");
    if (i < 0) return out;

    const endHints = [
      "DECLARATIVAS DEL CONSUMIDOR",
      "INFORMACIÓN DE PLD",
      "INFORMACION DE PLD",
      "DOCUMENTO SIN VALOR",
    ];
    let j = txt.length;
    for (const h of endHints) {
      const k = txt.indexOf(h, i + 8);
      if (k > -1 && k < j) j = k;
    }
    const block = txt.slice(i, j);

    // filas tipo: "15 BK12_MAX_CREDIT_AMT 6473733.11"
    const re = /(?:^|\n)\s*(\d{1,2})\s+[A-Z0-9_]+?\s+([^\n]+)/g;
    let m;
    while ((m = re.exec(block))) {
      const id = Number(m[1]);
      // valor puede ser --, 0, 107, 6473733.11, etc.
      const raw = m[2].trim().split(/\s+/)[0];
      if (raw === "--") {
        out[id] = "--";
      } else {
        out[id] = toNumber(raw);
      }
    }
  } catch (_) {}

  return out;
}

/**
 * Saca Original / SaldoActual / Vigente del "Resumen Créditos Activos"
 * Estrategia:
 *   1) Buscar el bloque "Resumen Créditos Activos".
 *   2) Dentro de ese bloque, localizar la línea "Totales:" y extraer TODOS los números
 *   3) Tomar los 3 de mayor magnitud; suelen ser [Original, Saldo, Vigente] (en miles de pesos)
 *   4) Fallback: si no se logra, devolver 0s
 */
function getActiveTotalsKMiles(txt) {
  const ZERO = { originalKm: 0, saldoKm: 0, vigenteKm: 0 };

  try {
    const startHints = [
      "Resumen Créditos Activos:",
      "Resumen Créditos Activos",
      "RESUMEN CRÉDITOS ACTIVOS",
    ];
    let i = -1;
    for (const h of startHints) {
      i = txt.indexOf(h);
      if (i >= 0) break;
    }
    if (i < 0) return ZERO;

    const endHints = [
      "Créditos Liquidados",
      "Resumen Créditos Liquidados",
      "Historia:",
      "Califica",
    ];
    let j = txt.length;
    for (const h of endHints) {
      const k = txt.indexOf(h, i + 20);
      if (k > -1 && k < j) j = k;
    }
    const block = txt.slice(i, j);

    // Buscar la línea donde aparezca "Totales"
    // Tomamos 240 caracteres para cubrir PDFs donde la tabla se "pega"
    const idxT = block.lastIndexOf("Totales");
    if (idxT < 0) return ZERO;

    const tail = block.slice(idxT, idxT + 240);
    const nums = (tail.match(/\d+(?:[.,]\d+)?/g) || []).map(toNumber);

    if (nums.length === 0) return ZERO;

    // Elegimos los 3 más grandes (suelen ser los 3 totales)
    const top3 = [...nums].sort((a, b) => b - a).slice(0, 3).sort((a, b) => a - b);

    // En la mayoría de casos: [Original, Saldo Actual, Vigente]
    // (los tres están en miles de pesos, según el reporte)
    return {
      originalKm: top3[0] || 0,
      saldoKm: top3[1] || 0,
      vigenteKm: top3[2] || 0,
    };
  } catch (_) {
    return ZERO;
  }
}

/**
 * Puntos por ID (ya con tus reglas actualizadas)
 */
function puntosPorID(val) {
  const P = {};

  // ID 1  (BK12_NUM_CRED) -> rangos típicos que usabas
  if (val[1] === 0) P[1] = 62;
  else if (val[1] <= 7) P[1] = 50;
  else if (val[1] <= 8) P[1] = 41;
  else P[1] = 16;

  // ID 6 (NBK12_PCT_PROMT)
  if (val[6] >= 0.93) P[6] = 71;
  else if (val[6] >= 0.81) P[6] = 54;
  else P[6] = 17;

  // ID 9 (BK24_PCT_60PLUS)
  if (val[9] === 0) P[9] = 54; else P[9] = -19;

  // ID 11 (NBK12_COMM_PCT_PLUS)
  if (val[11] === "--") P[11] = 55;
  else P[11] = val[11] === 0 ? 57 : 30;

  // ID 14 (BK12_IND_QCRA) 0 → 55, 1 → -29
  if (val[14] === 0) P[14] = 55;
  else if (val[14] === 1) P[14] = -29;
  else P[14] = 53; // sin info

  // ID 15 (BK12_MAX_CREDIT_AMT) → en pesos; puntaje en UDIS
  // (la conversión a UDI la hacemos afuera con el valor de UDI que envías)
  // Aquí solo dejamos el score por umbral UDIS
  // => el ID 15 real se calcula ya con val15Udis en el handler

  // ID 16 (MONTHS_ON_FILE_BANKING)
  // [<24]=41, [24,36)=51, [36,48)=60, [48,98)=60, [98,120)=61, >=120=67
  const m = val[16] || 0;
  if (m < 24) P[16] = 41;
  else if (m < 36) P[16] = 51;
  else if (m < 48) P[16] = 60;
  else if (m < 98) P[16] = 60;
  else if (m < 120) P[16] = 61;
  else P[16] = 67;

  // ID 17 (MONTHS_SINCE_LAST_OPEN_BANKING)
  // Sin info → 58 ; (0,6) → 46 ; ≥6 → 58
  const m17 = val[17];
  if (m17 == null) P[17] = 58;
  else if (m17 > 0 && m17 < 6) P[17] = 46;
  else P[17] = 58;

  return P;
}

/**
 * Fórmula de PI
 */
const PIfromScore = (score) => {
  const k = Math.log(2) / 40;
  const x = -(500 - score) * k;
  const pi = 1 / (1 + Math.exp(x));
  return pi; // 0..1
};

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    // Lee el PDF de FormData
    const buffers = [];
    await new Promise((resolve, reject) => {
      req.on("data", (c) => buffers.push(c));
      req.on("end", resolve);
      req.on("error", reject);
    });

    // Usa boundary para extraer el archivo y el udi
    const raw = Buffer.concat(buffers);
    const contentType = req.headers["content-type"] || "";
    const m = contentType.match(/boundary=(.*)$/);
    if (!m) return res.status(400).json({ error: "Solicitud inválida" });
    const boundary = `--${m[1]}`;

    const parts = String(raw).split(boundary).filter((p) => p.trim() && p.trim() !== "--");
    let pdfBuffer = null;
    let udi = 8.1462;

    for (const part of parts) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;
      const header = part.slice(0, headerEnd);
      const body = part.slice(headerEnd + 4);

      if (/name="udi"/i.test(header)) {
        const s = body.toString().trim();
        const n = Number(s.replace(",", "."));
        if (!isNaN(n) && n > 0) udi = n;
      } else if (/name="file"/i.test(header)) {
        // el cuerpo termina con \r\n
        const end = body.lastIndexOf("\r\n");
        pdfBuffer = Buffer.from(body.slice(0, end >= 0 ? end : undefined), "binary");
      }
    }

    if (!pdfBuffer) return res.status(400).json({ error: "PDF no recibido" });

    const data = await pdfParse(pdfBuffer);
    const text = norm(data.text || "");

    // ---------- 1) Califica
    const cal = getCalificaValues(text);

    // ---------- 2) Totales (en miles de pesos)
    const { originalKm, saldoKm, vigenteKm } = getActiveTotalsKMiles(text);

    // a pesos
    const original = originalKm * 1000;
    const saldoActual = saldoKm * 1000;
    const vigente = vigenteKm * 1000;
    const vencido = Math.max(0, saldoActual - vigente);

    // ---------- 3) Puntos por ID
    const base = 285; // base cuando hay historial (tu regla)
    const puntajes = puntosPorID(cal);

    // ID 15 con UDI: si el valor viene en pesos, convertir a UDIS para score
    // *Buró entrega BK12_MAX_CREDIT_AMT en pesos*
    const val15Udis = cal[15] ? cal[15] / udi : 0;
    // Rangos ID 15 (que me diste): <1,000,000 UDIS → 52; ≥1,000,000 UDIS → 112
    puntajes[15] = val15Udis >= 1_000_000 ? 112 : 52;

    // Suma de puntajes relevantes
    const ids = [1, 6, 9, 11, 14, 15, 16, 17];
    const suma = ids.reduce((acc, id) => acc + (puntajes[id] ?? 0), base);

    // ---------- 4) PI
    const pi = PIfromScore(suma);

    // ---------- 5) Respuesta
    return res.json({
      puntajeTotal: Math.round(suma),
      probabilidadIncumplimiento: `${(pi * 100).toFixed(2)}%`,

      // Totales monetarios
      totales: {
        original,
        saldoActual,
        vigente,
        vencido,
        originalFmt: money(original),
        saldoActualFmt: money(saldoActual),
        vigenteFmt: money(vigente),
        vencidoFmt: money(vencido),
      },

      // Valores crudos que usa la tabla (IDs solicitados)
      valores: {
        1: cal[1] ?? null,
        6: cal[6] ?? null,
        9: cal[9] ?? null,
        11: cal[11] ?? null,
        14: cal[14] ?? null,
        15: cal[15] ?? null, // pesos
        16: cal[16] ?? null,
        17: cal[17] ?? null,
        _udis: Math.round(val15Udis),
      },

      puntos: puntajes,
    });
  } catch (err) {
    console.error("analyzePdf error:", err);
    return res.status(200).json({
      puntajeTotal: 0,
      probabilidadIncumplimiento: "0.00%",
      totales: {
        original: 0,
        saldoActual: 0,
        vigente: 0,
        vencido: 0,
        originalFmt: money(0),
        saldoActualFmt: money(0),
        vigenteFmt: money(0),
        vencidoFmt: money(0),
      },
      valores: {},
      puntos: {},
      warning: "No se pudo leer correctamente el PDF; se devolvieron ceros.",
    });
  }
}
