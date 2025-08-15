// lib/parseCalifica.js
export function parseCalificaFromText(text = "") {
  // Busca una sección "Califica" y números con posibles códigos
  const bloque = (text.match(/Califica(?:ción)?[\s\S]+?(?:INFORMACIÓN|FIN DEL REPORTE|Historia)/i) || [])[0] || "";
  const indicadores = [];

  // Patrón simple: "ID 1: 3", "ID 6: 0.92", etc.
  const re = /\bID\s*(\d{1,2})\s*[:=]\s*([0-9.,-]+)\b/gi;
  let m;
  while ((m = re.exec(bloque))) {
    indicadores.push({
      id: Number(m[1]),
      valor: m[2],
      codigo: null
    });
  }

  return { indicadores, calificaRaw: bloque || null };
}
