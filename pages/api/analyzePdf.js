// pages/api/analyzePdf.js
import formidable from "formidable";
import pdfParse from "pdf-parse";
import { parseCalificaFromText } from "../../lib/parseCalifica";

export const config = { api: { bodyParser: false } };

// ⚙️ valor UDI por defecto (ajústalo cuando quieras)
const DEFAULT_UDI = 8.1462;
const PUNTOS_BASE = 285;

// tablas de puntuación según rangos que acordamos
function puntuar(valores) {
  // valores: { 1,6,9,11,14,15,16,17 } ya normalizados
  const puntos = {};

  // ID 1 – # créditos bancarios 12m
  puntos[1] = valores[1] === 0 ? 62 : valores[1] <= 3 ? 50 : valores[1] <= 7 ? 41 : 16;

  // ID 6 – % pagos en tiempo no bancarias
  // usar -- como “sin info” → 52
  if (valores[6] === "--" || valores[6] === null) puntos[6] = 52;
  else puntos[6] = valores[6] >= 0.93 ? 71 : valores[6] >= 0.81 ? 54 : 17;

  // ID 9 – % mora bancaria >=60 días (0 ó >0)
  puntos[9] = Number(valores[9]) === 0 ? 54 : -19;

  // ID 11 – % mora comercial >=60 días (-- es “sin info” → 55; 0% → 57)
  if (valores[11] === "--" || valores[11] === null) puntos[11] = 55;
  else puntos[11] = Number(valores[11]) === 0 ? 57 : 30; // (si más adelante necesitas los tramos amplios, los agregamos)

  // ID 14 – Indicador de quitas, castigos, reestructuras
  puntos[14] = Number(valores[14]) === 0 ? 55 : -29;

  // ID 15 – Monto máximo de crédito en UDIS
  const udis = Number(valores._udis) || 0;
  puntos[15] = udis >= 1_000_000 ? 112 : 52;

  // ID 16 – Antigüedad en SIC (meses)
  const m = Number(valores[16]) || 0;
  puntos[16] = m < 24 ? 41 : m < 36 ? 51 : m < 48 ? 60 : m < 98 ? 60 : m < 120 ? 61 : 67;

  // ID 17 – Meses desde el último crédito
  const mLast = Number(valores[17]) || 0;
  puntos[17] = mLast > 0 && mLast <= 6 ? 46 : 58; // (0,6] → 46; ≥6 → 58; “--” tratamos como ≥6

  const puntajeTotal = PUNTOS_BASE + Object.values(puntos).reduce((a, b) => a + b, 0);
  return { puntos, puntajeTotal };
}

// fórmula de PI
function calcularPI(puntaje) {
  const exp = -((500 - puntaje) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    // ── leer archivo con formidable ─────────────────────────────────────────────
    const form = formidable();
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const file = files?.file;
    if (!file) return res.status(400).send("No se recibió archivo");

    const buffer = await fsReadFile(file[0]?.filepath || file.filepath);
    const parsed = await pdfParse(buffer);
    const text = parsed?.text || "";

    // ── extraer tabla Califica ─────────────────────────────────────────────────
    const { calificaRaw, indicadores } = parseCalificaFromText(text);

    // normalizar a diccionario por id → valor
    const dict = {};
    for (const it of indicadores) {
      // números puros, '--' literal si no hay valor
      const clean = (it.valor === "--") ? "--" : String(it.valor).replace(/,/g, "");
      dict[Number(it.id)] = clean === "--" ? "--" : Number(clean);
    }

    // ID 15 en UDIS
    const udi = Number(fields?.udi) || DEFAULT_UDI;
    const montoPesos = Number(dict[15] || 0);
    const montoUdis = montoPesos > 0 ? (montoPesos / udi) : 0;
    dict._udis = montoUdis;

    // calcular puntos y PI
    const { puntos, puntajeTotal } = puntuar(dict);
    const pi = calcularPI(puntajeTotal);

    return res.status(200).json({
      meta: { pages: parsed?.numpages || null },
      calificaRaw,
      indicadores,              // tabla cruda
      valores: { ...dict, _udis: Number(montoUdis.toFixed(0)) },
      puntos,
      puntajeTotal,
      probabilidadIncumplimiento: `${(pi * 100).toFixed(2)}%`
    });
  } catch (err) {
    console.error("analyzePdf error:", err);
    return res.status(500).send(err?.message || "Error procesando el PDF");
  }
}

// util para leer el archivo desde formidable
import { readFile } from "fs/promises";
async function fsReadFile(p) { return await readFile(p); }
