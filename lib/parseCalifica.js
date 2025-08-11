// lib/parseCalifica.js
// Extrae la tabla “Califica” del PDF (robusto a saltos de línea y espacios)
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

  // 3) Fallback por códigos esperados (si faltó alguno en la regex de filas)
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
