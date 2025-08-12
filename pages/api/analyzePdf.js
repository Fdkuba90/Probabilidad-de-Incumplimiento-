/* ======================= BLOQUE HISTORIA (anclado a "Historia:") ======================= */
function getHistoriaBlock(fullText) {
  // Empieza exactamente en "Historia:" o "Historia" y termina antes del próximo bloque grande
  return sliceBetween(
    fullText,
    [/^\s*Historia\s*:?\s*$/im, /^\s*Historia\b:?/im],
    [
      /^\s*INFORMACI[ÓO]N\s+COMERCIAL\b/im,
      /^\s*Califica(ción)?\b/im,
      /^\s*DECLARATIVAS\b/im,
      /^\s*INFORMACI[ÓO]N\s+DE\s+PLD\b/im,
      /^\s*FIN DEL REPORTE\b/im
    ]
  );
}

/* ======================= Meses canónicos desde "Historia:" ======================= */
function extractHistoriaMonths(fullText) {
  const bloque = getHistoriaBlock(fullText);
  if (!bloque) return [];
  const lines = bloque.split(/\n/).map(s => s.trim()).filter(Boolean);
  const MES_RE = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i;

  const months = [];
  for (const ln of lines) {
    if (MES_RE.test(ln)) months.push(ln.replace(/\s+/g, " "));
  }
  // orden cronológico y últimos 12
  months.sort(compareMonthTok);
  return months.slice(-12);
}

/* ======================= Lector de tabla/segmento "Historia:" ======================= */
function parseHistoriaTablaPrecisa(fullText) {
  const bloque = getHistoriaBlock(fullText);
  if (!bloque) return [];

  const lines = bloque.split(/\n/).map(s => s.trim()).filter(Boolean);
  const MES_RE = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i;

  // número tolerante a espacios/nbps/comas/puntos
  const NUM_RE = /-?(?:\d[\s\u00A0.,]?){1,14}/g;
  const toNumMiles = (s) => {
    const canon = String(s)
      .replace(/\u00A0/g, " ")
      .replace(/\s+/g, "")
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "")
      .replace(/,/g, ".");
    const n = Number(canon);
    return Number.isFinite(n) ? Math.round(n * 1000) : NaN; // la Historia viene en miles
  };

  // localiza cada mes dentro del bloque
  const monthIdx = [];
  const months = [];
  for (let i = 0; i < lines.length; i++) {
    if (MES_RE.test(lines[i])) { monthIdx.push(i); months.push(lines[i].replace(/\s+/g, " ")); }
  }
  if (!months.length) return [];

  const out = [];
  for (let k = 0; k < months.length; k++) {
    const start = monthIdx[k];
    const end = k + 1 < months.length ? monthIdx[k + 1] : Math.min(lines.length, start + 60);
    const seg = lines.slice(start + 1, end).join(" ");

    // caso ideal: número pegado a la palabra "Vigente"
    const BEFORE_VIG = /(-?(?:\d[\s\u00A0.,]?){1,14})\s*Vigente\b/i;
    const AFTER_VIG  = /\bVigente\b\s*(-?(?:\d[\s\u00A0.,]?){1,14})/i;

    let vigente = 0;
    let m = seg.match(BEFORE_VIG);
    if (m && m[1]) {
      const v = toNumMiles(m[1]); if (Number.isFinite(v) && v > 0) vigente = v;
    }
    if (!vigente) {
      m = seg.match(AFTER_VIG);
      if (m && m[1]) {
        const v = toNumMiles(m[1]); if (Number.isFinite(v) && v > 0) vigente = v;
      }
    }
    // fallback: mayor número razonable en el segmento del mes
    if (!vigente) {
      const nums = (seg.match(NUM_RE) || []).map(toNumMiles).filter(n => Number.isFinite(n) && n >= 100_000 && n <= 100_000_000);
      if (nums.length) vigente = Math.max(...nums);
    }

    out.push({ month: months[k], vigente: vigente || 0, v1_29: 0, v30_59: 0, v60_89: 0, v90p: 0, rating: null });
  }

  // ordena por fecha y quédate con los últimos 12
  out.sort((a, b) => compareMonthTok(a.month, b.month));
  return out.slice(-12);
}

/* ======================= Rejilla/fallback también desde "Historia:" ======================= */
function parseHistoriaMensual(text) {
  const bloqueHistoria = getHistoriaBlock(text) || text;
  const lines = bloqueHistoria.split(/\n/).map(s => s.trim()).filter(Boolean);
  const MONTH_TOKEN = /\b(?:Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}\b/g;

  let headerIdx = -1;
  let months = [];
  for (let i = 0; i < lines.length; i++) {
    const ms = lines[i].match(MONTH_TOKEN);
    if (ms && ms.length >= 4) {
      if (ms.length > months.length) { months = ms.map(m => m.replace(/\s+/g, " ").trim()); headerIdx = i; }
    }
  }
  if (headerIdx === -1 || months.length < 4) return [];

  const NUM_TOKEN = /-?(?:\d[\s\u00A0.,]?){1,14}/g;
  const toNumMiles = (s) => {
    const canon = String(s)
      .replace(/\u00A0/g, " ")
      .replace(/\s+/g, "")
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "")
      .replace(/,/g, ".");
    const v = Number(canon);
    return Number.isFinite(v) ? Math.round(v * 1000) : NaN;
  };

  const ROWS = [
    { key: "vigente",  re: /^Vigente\b/i,                           numeric: true  },
    { key: "v1_29",    re: /^Vencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/i, numeric: true  },
    { key: "v30_59",   re: /^Vencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/i, numeric: true  },
    { key: "v60_89",   re: /^Vencido\s+de\s+60\s*a\s*89\s*d[ií]as\b/i, numeric: true  },
    { key: "v90p",     re: /^(Vencido\s+a\s*m[aá]s\s*de\s*89\s*d[ií]as|90\+|>89)\b/i, numeric: true  },
    { key: "rating",   re: /^Calificaci[oó]n\s+de\s+Cartera\b/i,      numeric: false }
  ];

  function collectRow(rowIndex) {
    const startRe = ROWS[rowIndex].re;
    const nextRes = ROWS.slice(rowIndex + 1).map(r => r.re);

    let start = -1;
    for (let i = headerIdx + 1; i < Math.min(lines.length, headerIdx + 200); i++) {
      if (startRe.test(lines[i])) { start = i; break; }
    }
    if (start === -1) return [];

    const accNums = [];
    const accToks = [];
    for (let i = start; i < Math.min(lines.length, start + 120); i++) {
      const ln = lines[i];
      if (nextRes.some(r => r.test(ln))) break;
      if (ROWS[rowIndex].numeric) {
        const toks = ln.match(NUM_TOKEN) || [];
        accNums.push(...toks.map(toNumMiles).filter(Number.isFinite));
      } else {
        const toks = ln.match(/\b\d[A-Z]\d\b/gi) || [];
        accToks.push(...toks.map(t => t.toUpperCase()));
      }
    }

    if (ROWS[rowIndex].numeric) {
      const slice = accNums.slice(-months.length);
      while (slice.length < months.length) slice.unshift(0);
      return slice;
    } else {
      const slice = accToks.slice(-months.length);
      while (slice.length < months.length) slice.unshift(null);
      return slice;
    }
  }

  const rowsData = {};
  const ROWS_LIST = ["vigente", "v1_29", "v30_59", "v60_89", "v90p", "rating"];
  for (let r = 0; r < ROWS_LIST.length; r++) rowsData[ROWS_LIST[r]] = collectRow(r);

  const out = months.map((m, idx) => ({
    month: m,
    vigente: rowsData.vigente?.[idx] ?? 0,
    v1_29:   rowsData.v1_29?.[idx]   ?? 0,
    v30_59:  rowsData.v30_59?.[idx]  ?? 0,
    v60_89:  rowsData.v60_89?.[idx]  ?? 0,
    v90p:    rowsData.v90p?.[idx]    ?? 0,
    rating:  rowsData.rating?.[idx]  ?? null
  }));

  out.sort((a, b) => compareMonthTok(a.month, b.month));
  return out.slice(-12);
}
