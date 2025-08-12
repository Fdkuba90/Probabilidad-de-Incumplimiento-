// lib/parseCalifica.js

// ========== OCR helper (tesseract.js) ==========
async function ocrImageToText(buffer) {
  // Carga perezosa para no penalizar cuando no se usa
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("spa"); // idioma español
  try {
    const { data: { text } } = await worker.recognize(buffer);
    await worker.terminate();
    return (text || "").replace(/\u00A0/g, " ");
  } catch (e) {
    try { await worker.terminate(); } catch {}
    throw e;
  }
}

// ========== Califica ==========
export function parseCalificaFromText(rawText = "") {
  const text = (rawText || "").replace(/\u00A0/g, " "); // quita no‑break space

  // 1) Delimitar bloque “Califica”
  const start = text.search(/^\s*Califica\b/mi);
  const from = start === -1 ? 0 : start;
  const endMarkers = [
    /^\s*DECLARATIVAS/mi,
    /^\s*INFORMACI[ÓO]N DE PLD/mi,
    /^\s*Historia/mi,
    /^\s*FIN DEL REPORTE/mi,
  ];
  let end = -1;
  for (const m of endMarkers) {
    const rel = text.slice(from).search(m);
    if (rel !== -1) { end = from + rel; break; }
  }
  const calificaRaw = text.slice(from, end === -1 ? from + 5000 : end);

  // 2) Parseo de filas: “<id> <CODIGO> <valor>”
  const rowRe = /(^|\n)\s*(\d{1,2})\s+([A-Z0-9_]+)\s+(--|[\d.,]+)\s*(?=\n|$)/gm;
  const indicadores = [];
  let m;
  while ((m = rowRe.exec(calificaRaw)) !== null) {
    const id = Number(m[2]);
    const codigo = m[3].trim();
    const valor = m[4].trim();         // "--" o número con , .
    indicadores.push({ id, codigo, valor });
  }

  // 3) Fallback por códigos esperados (si faltó alguno)
  const expected = {
    0:'BK12_CLEAN',1:'BK12_NUM_CRED',2:'BK12_NUM_TC_ACT',3:'NBK12_NUM_CRED',
    4:'BK12_NUM_EXP_PAIDONTIME',5:'BK12_PCT_PROMT',6:'NBK12_PCT_PROMT',
    7:'BK12_PCT_SAT',8:'NBK12_PCT_SAT',9:'BK24_PCT_60PLUS',10:'NBK24_PCT_60PLUS',
    11:'NBK12_COMM_PCT_PLUS',12:'BK12_PCT_90PLUS',13:'BK12_DPD_PROM',
    14:'BK12_IND_QCRA',15:'BK12_MAX_CREDIT_AMT',16:'MONTHS_ON_FILE_BANKING',
    17:'MONTHS_SINCE_LAST_OPEN_BANKING'
  };
  const have = new Set(indicadores.map(x => x.id));
  for (const [idStr, code] of Object.entries(expected)) {
    const id = Number(idStr);
    if (have.has(id)) continue;
    const esc = code.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const r = new RegExp(`${esc}\\s+(--|[\\d.,]+)`);
    const hit = r.exec(calificaRaw) || r.exec(text);
    if (hit) indicadores.push({ id, codigo: code, valor: hit[1] });
  }

  indicadores.sort((a,b) => a.id - b.id);
  return { calificaRaw, indicadores };
}

// ========== Historia mensual desde texto del PDF ==========
export function parseHistoriaMensual(textRaw = "") {
  const text = (textRaw || "").replace(/\u00A0/g, " ");
  const bloqueHistoria = sliceBetween(
    text,
    [/Historia:/i, /Historia\s*:/i, /Hist[oó]rico/i],
    [/(INFORMACI[ÓO]N\s+COMERCIAL)/i, /(DECLARATIVAS)/i, /(INFORMACI[ÓO]N\s+DE PLD)/i, /(FIN DEL REPORTE)/i]
  ) || "";

  const lines = bloqueHistoria.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const MONTH_TOKEN = /\b(?:Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}\b/g;

  // MODO A: encabezado con muchos meses (rejilla)
  let headerIdx = -1;
  let months = [];
  for (let i = 0; i < lines.length; i++) {
    const ms = lines[i].match(MONTH_TOKEN);
    if (ms && ms.length >= 4) {
      if (ms.length > months.length) {
        months = ms.map(m => m.replace(/\s+/g, " ").trim());
        headerIdx = i;
      }
    }
  }

  const toPesosMilesSafe = (n) => (Number.isFinite(n) ? n * 1000 : 0);
  const numsFrom = (s) => (s.match(/-?\d{1,7}(?:[.,]\d{1,2})?/g) || [])
    .map(x => x.replace(/[.,](\d{1,2})$/, ""))     // quitamos decimales
    .map(x => parseInt(x.replace(/\D/g, ""), 10))
    .filter(Number.isFinite);
  const toksFrom = (s) => (s.match(/[A-Z0-9ÁÉÍÓÚÑ\+\-]{2,10}/gi) || []);

  if (headerIdx !== -1 && months.length >= 4) {
    const ROWS = [
      { key: "vigente",  re: /^Vigente\b/i,                           numeric: true  },
      { key: "v1_29",    re: /^1-?29\b|Vencido\s+de\s+1\s*a\s*29/i,   numeric: true  },
      { key: "v30_59",   re: /^30-?59\b|Vencido\s+de\s+30\s*a\s*59/i, numeric: true  },
      { key: "v60_89",   re: /^60-?89\b|Vencido\s+de\s+60\s*a\s*89/i, numeric: true  },
      { key: "v90p",     re: /^(90\+|>89|Vencido\s+a\s+m[aá]s\s+de\s+89)/i, numeric: true  },
      { key: "rating",   re: /^Calificaci[oó]n\s+de\s+Cartera\b/i,    numeric: false }
    ];

    function collectRow(rowRe, nextRes, numeric) {
      let start = -1;
      for (let i = headerIdx + 1; i < Math.min(lines.length, headerIdx + 200); i++) {
        if (rowRe.test(lines[i])) { start = i; break; }
      }
      if (start === -1) return [];
      const accNums = [];
      const accToks = [];
      for (let i = start; i < Math.min(lines.length, start + 80); i++) {
        const ln = lines[i];
        if (nextRes.some(r => r.test(ln))) break;
        if (numeric) accNums.push(...numsFrom(ln)); else accToks.push(...toksFrom(ln));
      }
      if (numeric) {
        const slice = accNums.slice(-months.length);
        while (slice.length < months.length) slice.unshift(0);
        return slice.map(toPesosMilesSafe);
      } else {
        const onlyAlpha = accToks.filter(t => !/^\d+$/.test(t));
        const slice = onlyAlpha.slice(-months.length);
        while (slice.length < months.length) slice.unshift(null);
        return slice;
      }
    }

    const nexts = (idx) => ROWS.slice(idx + 1).map(r => r.re);
    const rowsData = {};
    for (let i = 0; i < ROWS.length; i++) {
      rowsData[ROWS[i].key] = collectRow(ROWS[i].re, nexts(i), ROWS[i].numeric);
    }

    const out = months.map((m, idx) => ({
      month: m,
      vigente: rowsData.vigente?.[idx] ?? 0,
      v1_29:   rowsData.v1_29?.[idx]   ?? 0,
      v30_59:  rowsData.v30_59?.[idx]  ?? 0,
      v60_89:  rowsData.v60_89?.[idx]  ?? 0,
      v90p:    rowsData.v90p?.[idx]    ?? 0,
      rating:  rowsData.rating?.[idx]  ?? null
    }));
    return out.slice(-12);
  }

  // MODO B: columna por mes
  const isMonth = (s) => /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i.test(s);
  const result = [];
  const linesArr = lines;
  for (let i = 0; i < linesArr.length; i++) {
    const ln = linesArr[i];
    if (!isMonth(ln)) continue;
    const month = ln;
    const slice = linesArr.slice(i + 1, i + 20);
    const toPesos = (row) => {
      const nums = numsFrom(row);
      const last = nums.length ? nums[nums.length - 1] : 0;
      return toPesosMilesSafe(last);
    };
    const pick = (res) => {
      const row = slice.find(s => res.some(r => r.test(s)));
      return row ? toPesos(row) : 0;
    };
    const vigente  = pick([/^Vigente\b/i]);
    const v1_29    = pick([/^1-?29\b/i, /Vencido\s+de\s+1\s*a\s*29/i]);
    const v30_59   = pick([/^30-?59\b/i, /Vencido\s+de\s+30\s*a\s*59/i]);
    const v60_89   = pick([/^60-?89\b/i, /Vencido\s+de\s+60\s*a\s*89/i]);
    const v90p     = pick([/^(90\+|>89|Vencido\s+a\s+m[aá]s\s+de\s+89)/i]);

    let rating = null;
    const carLine = slice.find(s => /^Calificaci[oó]n\s+de\s+Cartera\b/i.test(s));
    if (carLine) {
      const toks = (carLine.match(/[A-Z0-9ÁÉÍÓÚÑ]+/gi) || []);
      rating = toks[toks.length - 1] || null;
    }
    result.push({ month, vigente, v1_29, v30_59, v60_89, v90p, rating });
  }

  return result.slice(-12);
}

// ========== Historia mensual desde OCR de imagen (fallback) ==========
export async function parseHistoriaFromOCR(imageBuffer) {
  const ocrText = await ocrImageToText(imageBuffer);
  return normalizeHistoriaTable(ocrText);
}

/* ====== Utils compartidos ====== */
function sliceBetween(txt, fromReList, toReList) {
  let fromIdx = -1;
  for (const re of fromReList) {
    const i = txt.search(re);
    if (i !== -1) { fromIdx = i; break; }
  }
  if (fromIdx === -1) return "";
  const rest = txt.slice(fromIdx);
  for (const re of toReList) {
    const j = rest.search(re);
    if (j !== -1) return rest.slice(0, j);
  }
  return rest;
}

function normalizeHistoriaTable(textRaw = "") {
  // Este parser tolera OCR “sucio” de una tabla con columnas:
  // Mes | Vigente | 1–29 | 30–59 | 60–89 | 90+ | Calif. Cartera
  const text = (textRaw || "").replace(/\u00A0/g, " ");
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const monthRe = /(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s*20(\d{2})/i;
  const moneyRe = /\$?\s*([0-9]{1,3}(?:[,.\s][0-9]{3})*|\d+)(?:[.,]\d{1,2})?/g;

  const last12 = [];
  for (const ln of lines) {
    const m = ln.match(monthRe);
    if (!m) continue;

    const month = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} 20${m[2]}`;
    // Toma los últimos 5 importes numéricos de la línea
    const nums = [];
    let mm;
    while ((mm = moneyRe.exec(ln)) !== null) {
      const clean = mm[1].replace(/[^\d]/g, "");
      if (!clean) continue;
      nums.push(parseInt(clean, 10));
    }
    // Si OCR separó por espacios, intenta leer en la siguiente línea también
    if (nums.length < 5) {
      const idx = lines.indexOf(ln);
      const nxt = lines[idx + 1] || "";
      let nn;
      while ((nn = moneyRe.exec(nxt)) !== null) {
        const clean = nn[1].replace(/[^\d]/g, "");
        if (!clean) continue;
        nums.push(parseInt(clean, 10));
      }
    }
    const five = nums.slice(-5); // vigente, 1-29, 30-59, 60-89, 90+
    while (five.length < 5) five.unshift(0);

    // rating: busca un token tipo "Cartera", "A1", etc.
    let rating = null;
    const ratingTok = (ln.match(/(Cartera|A[0-9]+[A-Z]*|[0-9]{1,2}[A-Z][0-9]?)/i) || [])[1];
    if (ratingTok) rating = ratingTok;

    last12.push({
      month,
      vigente: five[0] * 1000,
      v1_29:   five[1] * 1000,
      v30_59:  five[2] * 1000,
      v60_89:  five[3] * 1000,
      v90p:    five[4] * 1000,
      rating
    });
  }

  // Devuelve máximo 12 meses más recientes (si OCR halló más)
  return last12.slice(-12);
}
