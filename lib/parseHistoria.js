// lib/parseHistoria.js
// Extrae la tabla “Historia por mes (pesos)” del PDF en formato horizontal o vertical.
// Robusto a saltos de línea, espacios, acentos y a que los bloques vengan apilados.

const MONTHS = [
  "Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"
];

const MES_RE = new RegExp(
  String.raw`(?:^|\s)(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+(\d{4})(?=\s|$)`,
  "i"
);

// Normaliza NBSP, espacios múltiples y líneas “ruidosas”
function normalize(text = "") {
  return (text || "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .replace(/[^\S\n]+\n/g, "\n")
    .trim();
}

// Localiza el bloque “Historia” y lo recorta hasta el siguiente encabezado
function sliceHistoriaBlock(rawText = "") {
  const text = normalize(rawText);
  const start = text.search(/^\s*Historia\b/i);
  if (start === -1) return { historiaRaw: "", from: -1, to: -1 };

  const endMarkers = [
    /^\s*INFORMACI[ÓO]N COMERCIAL\b/mi,
    /^\s*Califica\b/mi,
    /^\s*DECLARATIVAS\b/mi,
    /^\s*INFORMACI[ÓO]N DE PLD\b/mi,
    /^\s*FIN DEL REPORTE\b/mi
  ];

  let end = -1;
  for (const m of endMarkers) {
    const rel = text.slice(start).search(m);
    if (rel !== -1) { end = start + rel; break; }
  }
  const historiaRaw = text.slice(start, end === -1 ? start + 12000 : end);
  return { historiaRaw, from: start, to: end };
}

// Convierte "Ene 2025" -> { mes:"Ene 2025", idx: 0..11, año: number }
function parseMesToken(s) {
  const m = s.match(MES_RE);
  if (!m) return null;
  const abbr = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(); // capitaliza
  const idx = MONTHS.findIndex(x => x.toLowerCase() === abbr.toLowerCase());
  return { mes: `${abbr} ${m[2]}`, idx, año: Number(m[2]) };
}

// Extrae todos los tokens de mes en orden de aparición (únicos)
function collectMeses(historiaRaw) {
  const meses = [];
  const have = new Set();
  const re = new RegExp(MES_RE, "gi");
  let m;
  while ((m = re.exec(historiaRaw)) !== null) {
    const mes = `${m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()} ${m[2]}`;
    if (!have.has(mes)) {
      have.add(mes);
      meses.push(mes);
    }
  }
  return meses;
}

// Lee un número “PDF-friendly”: 1 234, 1.234, 1,234, "--"
function toNumberOrNull(x) {
  if (!x) return null;
  const s = String(x).trim();
  if (s === "--") return null;
  // tolera miles con . o , y decimales con . o ,
  const canon = s.replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "") // elimina separadores de miles
                  .replace(/,/g, ".");                          // coma decimal -> punto
  const v = Number(canon);
  return Number.isFinite(v) ? v : null;
}

// ---------- MODO A: Tabla horizontal (una fila por mes) ----------
function tryHorizontal(historiaRaw) {
  // Buscamos líneas que contengan: MES AÑO ... 5 números ... y opcional calificación
  // Ejemplo flexible: "Nov 2023  9324  0  91  0  0   1A2 1A1"
  const lineRe = new RegExp(
    String.raw`(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+(\d{4})[^\n]*?` + // mes
    String.raw`([\-–\d.,]+)\s+([\-–\d.,]+)\s+([\-–\d.,]+)\s+([\-–\d.,]+)\s+([\-–\d.,]+)` + // 5 buckets
    String.raw`(?:\s+([0-9A-Z]{2,3}\d?)\s*([0-9A-Z]{2,3}\d?))?`, // 1 o 2 tokens de calificación
    "gi"
  );

  const filas = [];
  let m;
  while ((m = lineRe.exec(historiaRaw)) !== null) {
    const mes = `${m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()} ${m[2]}`;
    const vigente = toNumberOrNull(m[3]);
    const d1_29   = toNumberOrNull(m[4]);
    const d30_59  = toNumberOrNull(m[5]);
    const d60_89  = toNumberOrNull(m[6]);
    const d90_plus= toNumberOrNull(m[7]);
    const calif   = [m[8], m[9]].filter(Boolean).join(" ").trim() || null;
    filas.push({ mes, vigente, d1_29, d30_59, d60_89, d90_plus, calificacion: calif });
  }

  const meses = [...new Set(filas.map(f => f.mes))];
  return filas.length ? { meses, filas } : null;
}

// ---------- MODO B: Vertical/columnar apilado ----------
function tryVertical(historiaRaw) {
  // Identificamos los encabezados de bloque en el orden en que aparezcan
  const blocks = [];
  const markers = [
    { key: "vigente", re: /^\s*Vigente\b/i },
    { key: "d1_29", re: /^\s*Vencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/i },
    { key: "d30_59", re: /^\s*Vencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/i },
    { key: "d60_89", re: /^\s*Vencido\s+de\s+60\s*a\s*89\s*d[ií]as\b/i },
    // Variantes comunes para 90+
    { key: "d90_plus", re: /^\s*Vencido\s+(?:a\s*m[aá]s\s*de\s*89\s*d[ií]as|de\s*90\s*\+?\s*d[ií]as|90\+)\b/i },
    { key: "calificacion", re: /^\s*Calificaci[oó]n\s+de\s+Cartera\b/i },
  ];

  // Partimos el bloque por líneas, pero guardamos índice global para “stitching”
  const lines = historiaRaw.split("\n").map(x => x.trim()).filter(x => x.length);

  // 1) Coleccionamos meses en orden
  const meses = collectMeses(historiaRaw);
  if (!meses.length) return null;

  // 2) Recorremos y detectamos el bloque activo
  let current = "vigente";
  const ordenBloques = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];

    // ¿Cambió de bloque?
    const hit = markers.find(m => m.re.test(L));
    if (hit) {
      current = hit.key;
      if (!ordenBloques.includes(current)) ordenBloques.push(current);
      continue;
    }

    // Si es un mes explícito, asumimos que viene el valor en la(s) línea(s) siguientes
    const mm = L.match(MES_RE);
    if (mm) {
      const mes = `${mm[1][0].toUpperCase() + mm[1].slice(1).toLowerCase()} ${mm[2]}`;
      // mira hacia adelante por el primer número antes del próximo mes o encabezado
      const val = lookaheadForNumber(lines, i + 1);
      blocks.push({ key: current, mes, value: val, i });
      continue;
    }
  }

  // 3) Construimos un mapa por mes con todas las columnas
  const byMes = new Map(meses.map(mes => [mes, {
    mes, vigente: null, d1_29: null, d30_59: null, d60_89: null, d90_plus: null, calificacion: null
  }]));

  // a) Cuando el formato trae "mes → número" para cada bloque,
  //    ya lo tenemos en blocks (cada block tiene mes + value)
  for (const b of blocks) {
    const row = byMes.get(b.mes);
    if (!row) continue;
    if (b.key === "calificacion") {
      // Capturamos posibles 1 o 2 tokens de calificación en la línea de valor
      row.calificacion = coerceCalif(b.value);
    } else {
      row[b.key] = b.value;
    }
  }

  // b) Si el PDF no repite el mes dentro de cada bloque (sólo están listados una vez),
  //    intentamos leer “listas compactas” debajo de cada encabezado con tantos números como meses.
  //    Esto rellena huecos que “a” no haya poblado.
  const positions = findBlockPositions(lines, markers);
  for (const info of positions) {
    const { key, startIdx, endIdx } = info;
    if (!key) continue;
    if (key === "calificacion") {
      const tokens = collectCalifTokens(lines.slice(startIdx, endIdx));
      for (let i = 0; i < meses.length && i < tokens.length; i++) {
        const row = byMes.get(meses[i]);
        if (row && !row.calificacion) row.calificacion = tokens[i] || null;
      }
    } else {
      const nums = collectNumbers(lines.slice(startIdx, endIdx));
      for (let i = 0; i < meses.length && i < nums.length; i++) {
        const row = byMes.get(meses[i]);
        if (row && row[key] == null) row[key] = nums[i];
      }
    }
  }

  const filas = meses.map(m => byMes.get(m));
  // Si al menos una fila tiene algún valor, damos por válido este modo
  const any = filas.some(r =>
    r.vigente != null || r.d1_29 != null || r.d30_59 != null || r.d60_89 != null || r.d90_plus != null || r.calificacion
  );
  return any ? { meses, filas } : null;
}

// Busca hacia adelante el primer número/cifra “PDF-friendly”
function lookaheadForNumber(lines, fromIdx) {
  for (let j = fromIdx; j < lines.length; j++) {
    const L = lines[j];
    // se corta si aparece otro mes o encabezado
    if (MES_RE.test(L) || /^\s*(Vigente|Vencido|Calificaci[óo]n)/i.test(L)) break;
    const num = pickFirstNumber(L);
    if (num != null) return num;
    const cal = pickCalif(L);
    if (cal) return cal; // para bloque de calificación
  }
  return null;
}

// Devuelve el primer número en la línea (o null)
function pickFirstNumber(line) {
  const m = line.match(/(?:--|[-–\d.,]+)/);
  if (!m) return null;
  return toNumberOrNull(m[0]);
}

// Devuelve token(es) de calificación si existen en la línea
function pickCalif(line) {
  // Tokens típicos como 1A2, 1B1, 7A1, 1C2 etc. (2 posibles juntos)
  const m = line.match(/\b([0-9][A-Z]\d)\b(?:\s+([0-9][A-Z]\d))?/i);
  if (!m) return null;
  return [m[1], m[2]].filter(Boolean).join(" ");
}

function coerceCalif(v) {
  if (v == null) return null;
  if (typeof v === "number") return String(v);
  const s = String(v);
  const m = s.match(/\b([0-9][A-Z]\d)\b(?:\s+([0-9][A-Z]\d))?/i);
  return m ? [m[1], m[2]].filter(Boolean).join(" ") : s.trim() || null;
}

// Encuentra rangos (start/end) de cada bloque por encabezados
function findBlockPositions(lines, markers) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const m = markers.find(x => x.re.test(t));
    if (m) hits.push({ key: m.key, idx: i });
  }
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const startIdx = hits[i].idx + 1;
    const endIdx = i + 1 < hits.length ? hits[i + 1].idx : lines.length;
    out.push({ key: hits[i].key, startIdx, endIdx });
  }
  return out;
}

// Recolecta tantos números como pueda en un segmento (en orden)
function collectNumbers(segLines) {
  const out = [];
  for (const L of segLines) {
    // corta si detecta otro encabezado o un mes (esto no debería pasar aquí, pero por si acaso)
    if (MES_RE.test(L) || /^\s*(Vigente|Vencido|Calificaci[óo]n)/i.test(L)) break;
    const matches = L.match(/--|[-–\d.,]+/g) || [];
    for (const tok of matches) {
      const n = toNumberOrNull(tok);
      if (n != null) out.push(n);
    }
  }
  return out;
}

// Recolecta pares/singles de tokens de calificación en un segmento
function collectCalifTokens(segLines) {
  const out = [];
  for (const L of segLines) {
    if (MES_RE.test(L) || /^\s*(Vigente|Vencido|Calificaci[óo]n)/i.test(L)) break;
    const m = L.match(/\b([0-9][A-Z]\d)\b(?:\s+([0-9][A-Z]\d))?/gi);
    if (m && m.length) {
      for (const grp of m) {
        const parts = grp.trim().split(/\s+/).slice(0, 2);
        out.push(parts.join(" "));
      }
    }
  }
  return out;
}

// API principal
export function parseHistoriaFromText(rawText = "") {
  const { historiaRaw } = sliceHistoriaBlock(rawText);
  if (!historiaRaw) {
    return { historiaRaw: "", meses: [], filas: [] };
  }

  // 1) Intento horizontal
  const h = tryHorizontal(historiaRaw);
  if (h) return { historiaRaw, ...h };

  // 2) Intento vertical/apilado
  const v = tryVertical(historiaRaw);
  if (v) return { historiaRaw, ...v };

  // 3) Fallback vacío, pero regresamos el bloque para debug
  return { historiaRaw, meses: [], filas: [] };
}

