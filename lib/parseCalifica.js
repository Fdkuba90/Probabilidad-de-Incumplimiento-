// Parser mínimo: devuelve indicadores si encuentra "ID <n>: <valor>"
export function parseCalificaFromText(text = "") {
  const bloque = (text.match(/Califica(?:ción)?[\s\S]+?(?:INFORMACIÓN|FIN DEL REPORTE|Historia)/i) || [])[0] || "";
  const indicadores = [];
  const re = /\bID\s*(\d{1,2})\s*[:=]\s*([0-9.,-]+)\b/gi;
  let m;
  while ((m = re.exec(bloque))) {
    indicadores.push({ id: Number(m[1]), valor: m[2], codigo: null });
  }
  return { indicadores, calificaRaw: bloque || null };
}
