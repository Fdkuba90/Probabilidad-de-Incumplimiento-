// lib/scoring.js

/* ======================= helpers ======================= */
// Convierte cualquier entrada a número o null.
// Trata "--", "—" y "Sin Información" como null (sin info) para *todos* los indicadores.
function toNum(v) {
  if (v === null || v === undefined) return null;

  // Normalización de cadenas "sin info"
  if (typeof v === "string") {
    const raw = v.trim();
    if (
      raw === "--" ||
      raw === "—" ||
      /^sin\s+informaci[oó]n$/i.test(raw)
    ) {
      return null;
    }
  }

  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  // Limpieza general y parseo
  const s = String(v).trim()
    .replace(/[%,$\s,]/g, ""); // quita %, $, espacios y comas

  if (!s) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Normaliza un valor porcentual que puede venir en 0–1 o 0–100.
// También respeta "--" / "Sin Información" a través de toNum().
function toPct01(v) {
  const n = toNum(v);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

/* ======================= SIN ATRASOS (base 285) ======================= */
export function puntuarSinAtrasos(val) {
  const pts = {};
  const BASE = 285;

  // 1) BK12_NUM_CRED — Nº de créditos bancarios
  // Sin info => 53; 0 => 62; 1–3.99 => 50; 4–7.99 => 41; >=8 => 16
  {
    const p = toNum(val[1]) ?? 0;
    if (p === null) pts[1] = 53;
    if (p === 0) pts[1] = 62;
    else if (p < 4) pts[1] = 50;
    else if (p < 8) pts[1] = 41;
    else pts[1] = 16;
  }

  // 6) NBK12_PCT_PROMT — % pagos en tiempo NO bancarias
  // Sin info => 52; >=93% => 71; >=81% => 54; else 17
  {
    const p = toPct01(val[6]);
    if (p === null) pts[6] = 52;
    else if (p >= 0.93) pts[6] = 71;
    else if (p >= 0.81) pts[6] = 54;
    else pts[6] = 17;
  }

  // 9) BK24_PCT_60PLUS — % 60+ bancarias
  // Sin info => -19 ;0% => 54; >0% => -19
  {
    const p = toPct01(val[9]) ?? 0;
    if (p === null) pts[9] = -19;
    else if (p >= 0) pts[9] = 54;
    else pts[9] = -19;
  }

  // 11) NBK12_COMM_PCT_PLUS — % exposiciones comerciales 60+ días
  // Sin info 55; 0% => 57; (0,10%) => 42; [10,62%) => 28; >=62% => 21
  {
    const p = toPct01(val[11]);
    if (p === null) pts[11] = 55;
    else if (p === 0) pts[11] = 57;
    else if (p > 0 && p < 0.10) pts[11] = 42;
    else if (p >= 0.10 && p < 0.62) pts[11] = 28;
    else pts[11] = 21;
  }

  // 14) BK12_IND_QCRA — Indicador quitas/castigos/restructuras
  // Sin info 53; 0 => 55; >0 => -29
  {
    const p = toNum(val[14]) ?? 0;
    if (p === null) pts[14] = 53;
    else if (p === 0) pts[14] = 55;
    else pts[14] = -29;
  }

  // 15) BK12_MAX_CREDIT_AMT — umbral por UDIs calculados en val._udis
  // >=1,000,000 UDIs => 112; else 52
  {
    const udis = Number(val._udis) || 0;
    pts[15] = udis >= 1_000_000 ? 112 : 52;
  }

  // 16) MONTHS_ON_FILE_BANKING — antigüedad en Buró (meses)
  // <24 => 41; 24–35.99 => 51; 36–97.99 => 60; 98–119.99 => 61; >=120 => 67
  {
    const p = toNum(val[16]) ?? 0;
    if (p < 24) pts[16] = 41;
    else if (p < 36) pts[16] = 51;
    else if (p < 98) pts[16] = 60;
    else if (p < 120) pts[16] = 61;
    else pts[16] = 67;
  }

  // 17) MONTHS_SINCE_LAST_OPEN_BANKING — meses desde última apertura
  // 1–6.99 => 46; 0 o >=7 => 58
  {
    const p = toNum(val[17]) ?? 0;
    if (p === null) pts[17] = 58;
    else if (p < 6) pts[17] = 46;
    else pts[17] = 58;
  }

  const puntajeTotal = BASE + Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, puntosBase: BASE, puntajeTotal };
}

/* ======================= CON ATRASOS (base 214) ======================= */
export function puntuarConAtrasos(val) {
  const pts = {};
  const BASE = 214;

  // 7) BK12_PCT_SAT — % exp. bancaria con 0–29 días atraso
  // Sin info 49; 0% -58; (0,50%) 15; [50,83%) 17; [83,95%) 33; >=95% 87
  {
    const p = toPct01(val[7]);
    if (p === null) pts[7] = 49;
    else if (p === 0) pts[7] = -58;
    else if (p > 0 && p < 0.50) pts[7] = 15;
    else if (p >= 0.50 && p < 0.83) pts[7] = 17;
    else if (p >= 0.83 && p < 0.95) pts[7] = 33;
    else pts[7] = 87;
  }

  // 12) BK12_PCT_90PLUS — % exp. bancaria con 90+ días atraso
  // Sin info 49; 0% 63; (0,80%) 11; >=80% 4
  {
    const p = toPct01(val[12]);
    if (p === null) pts[12] = 49;
    else if (p === 0) pts[12] = 63;
    else if (p > 0 && p < 0.80) pts[12] = 11;
    else pts[12] = 4;
  }

  // 13) BK12_DPD_PROM — días de mora promedio (bancarias)
  // Sin info 49; [0,2.54] 76; (2.54,10.12] 55; (10.12,36.36] 34; >=36.36 29
  {
    const d = toNum(val[13]);
    if (d === null) pts[13] = 49;
    else if (d >= 0 && d <= 2.54) pts[13] = 76;
    else if (d > 2.54 && d <= 10.12) pts[13] = 55;
    else if (d > 10.12 && d <= 36.36) pts[13] = 34;
    else pts[13] = 29;
  }

  // 14) BK12_IND_QCRA — Indicador quitas/castigos/restructuras
  // Sin info 49; 0 => 51; >0 => 13
  {
    const p = toNum(val[14]) ?? 0;
    if (p === null) pts[14] = 49;
    else if (p === 0) pts[14] = 51;
    else pts[14] = 13;
  }

  // 5) BK12_PCT_PROMT - % pagos en tiempo a instituciones NO bancarias
  // Sin info 49; [0,34) 20; [34,56) 27; [56,75) 32; [75,87) 47; [87,92) 58; >=92 63
  {
    const p = toPct01(val[5]);
    if (p === null) pts[5] = 49;
    else if (p < 0.34) pts[5] = 20;
    else if (p < 0.56) pts[5] = 27;
    else if (p < 0.75) pts[5] = 32;
    else if (p < 0.87) pts[5] = 47;
    else if (p < 0.92) pts[5] = 58;
    else pts[5] = 63;
  }

  // 16) MONTHS_ON_FILE_BANKING - Antigüedad en Buró (meses)
  // Sin info 49; <20 => 35; (20,44) => 45; [44,120) => 53; >=120 => 66
  {
    const m = toNum(val[16]);
    if (m === null) pts[16] = 49;
    else if (m < 20) pts[16] = 35;
    else if (m > 20 && m < 44) pts[16] = 45;
    else if (m >= 44 && m < 120) pts[16] = 53;
    else pts[16] = 66;
  }

  // 4) BK12_NUM_EXP_PAIDONTIME - Nº pagos en tiempo (últimos 12 meses)
  // Sin info 49; 0 => 23; (0,5.99] => 44; (5.99,10) => 47; >=10 => 52
  {
    const n = toNum(val[4]);
    if (n === null) pts[4] = 49;
    else if (n === 0) pts[4] = 23;
    else if (n > 0 && n <= 5.99) pts[4] = 44;
    else if (n > 5.99 && n < 10) pts[4] = 47;
    else pts[4] = 52;
  }

  const puntajeTotal = BASE + Object.values(pts).reduce((a, b) => a + b, 0);
  return { pts, puntosBase: BASE, puntajeTotal };
}

/* ======================= PI ======================= */
export function calcularPI(score) {
  // Logit con odds-doubling cada 40 pts, centrado en 500
  const exp = -((500 - score) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}
