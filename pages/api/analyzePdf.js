// Reemplaza COMPLETO este bloque en pages/api/analyzePdf.js
function parseHistoriaVerticalMiles(fullText) {
  const historia = sliceBetween(
    fullText,
    [/^\s*Historia\b/im],
    [/^\s*INFORMACI[ÓO]N\s+COMERCIAL\b/im, /^\s*Califica\b/im, /^\s*DECLARATIVAS\b/im, /^\s*INFORMACI[ÓO]N\s+DE\s+PLD\b/im, /^\s*FIN DEL REPORTE\b/im]
  );
  if (!historia) return [];

  const lines = historia.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const MES_RE = /^(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+20\d{2}$/i;

  // normaliza núm: quita separadores de miles (.,) y convierte coma decimal a punto
  const toNum = (s) => {
    if (!s) return 0;
    const canon = String(s)
      .replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, "") // quita miles
      .replace(/,/g, ".");                           // coma decimal → punto
    const v = Number(canon);
    return Number.isFinite(v) ? Math.round(v * 1000) : 0; // miles → MXN
  };

  // encuentra todos los índices donde hay "Mes Año"
  const months = [];
  const monthIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (MES_RE.test(lines[i])) {
      months.push(lines[i]);
      monthIdx.push(i);
    }
  }
  if (!months.length) return [];

  const vigente = new Array(months.length).fill(0);

  // para cada mes, toma el segmento hasta el siguiente y elige el número más grande
  for (let k = 0; k < months.length; k++) {
    const start = monthIdx[k];
    const end = k + 1 < months.length ? monthIdx[k + 1] : Math.min(lines.length, start + 120);

    const seg = lines.slice(start + 1, end).join(" ");
    // números estilo "10075", "8,732", "8.732", "0"
    const nums = seg.match(/-?\d[\d.,]*/g) || [];
    if (nums.length) {
      const values = nums.map(toNum).filter(n => Number.isFinite(n));
      // usa el mayor valor del segmento (evita que un "0" tape al 8732)
      const max = values.length ? Math.max(...values) : 0;
      vigente[k] = max;
    } else {
      vigente[k] = 0;
    }
  }

  // Calificación de Cartera (opcional, si te interesa conservarla)
  let ratings = new Array(months.length).fill(null);
  const calStart = lines.findIndex(l => /^Calificaci[oó]n\s+de\s+Cartera\b/i.test(l));
  if (calStart !== -1) {
    const raw = lines.slice(calStart + 1).join(" ");
    const toks = raw.match(/\b[0-9][A-Z]\d\b/gi) || [];
    const slice = toks.slice(-months.length).map(t => t.toUpperCase());
    for (let i = 0; i < slice.length; i++) ratings[i + (months.length - slice.length)] = slice[i];
  }

  // últimos 12 meses
  return months.slice(-12).map((month, i) => ({
    month,
    vigente: vigente[i] || 0,
    v1_29: 0,
    v30_59: 0,
    v60_89: 0,
    v90p: 0,
    rating: ratings[i] || null
  }));
}
