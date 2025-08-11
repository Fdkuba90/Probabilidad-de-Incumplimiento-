const HEADERS = [
  "Resumen", "Score", "Detalle", "Créditos", "Comportamiento", "Consulta", "Clientes",
  "Historial", "Anexos", "Glosario", "Identificador", "Indicador"
];

export function parseCalificaFromText(text) {
  if (!text) return { calificaRaw: "", indicadores: [] };

  const idx = text.toLowerCase().indexOf("califica");
  if (idx === -1) return { calificaRaw: "", indicadores: [] };

  const slice = text.slice(idx, idx + 3000);

  let end = slice.length;
  for (const h of HEADERS) {
    const i = slice.indexOf("\n" + h + "\n");
    if (i !== -1 && i < end) end = i;
  }
  const calificaRaw = slice.slice(0, end).trim();

  const indicadores = [];
  const lines = calificaRaw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const mA = line.match(/^(\d{1,2})\s+(.+?)\s+(\d+(?:[.,]\d+)?)$/);
    if (mA) {
      indicadores.push({ id: mA[1], nombre: mA[2], valor: mA[3] });
      continue;
    }

    const mB = line.match(/^ID\s*(\d{1,2})/i);
    if (mB) {
      const id = mB[1];
      let nombre = "";
      let valor = "";
      for (let k = 1; k <= 3 && i + k < lines.length; k++) {
        const ln = lines[i + k];
        const v = ln.match(/^(\d+(?:[.,]\d+)?)$/);
        if (v) { valor = v[1]; break; }
        if (ln.length > 2 && !nombre) nombre = ln;
      }
      indicadores.push({ id, nombre, valor });
    }
  }

  return { calificaRaw, indicadores };
}