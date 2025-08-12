// lib/parseHistoriaPesos.js
// Extrae "Historia por mes (pesos)" de Buró (robusto a saltos / espacios / comas / puntos)
export function parseHistoriaPesosFromText(rawText = "") {
  const text = (rawText || "")
    .replace(/\u00A0/g, " ")      // NBSP → espacio
    .replace(/\r/g, "")
    .replace(/[,\$]/g, "")        // quita comas y $
    .replace(/[ \t]+/g, " ");     // colapsa espacios

  // 1) Delimitar bloque "Historia por mes"
  const start = text.search(/Historia\s+por\s+mes\s*\(pesos\)/i);
  if (start === -1) return { raw: "", meses: [] };

  const tail = text.slice(start);
  const end = (() => {
    const m = tail.search(/^\s*(Califica(?:ción)?|Resumen|Cr[eé]ditos?\s+Liquidados?|DECLARATIVAS|FIN DEL REPORTE)\b/mi);
    return m === -1 ? tail.length : m;
  })();
  const raw = tail.slice(0, end);

  // 2) Localizar encabezados de mes
  const mesHdrRE = /\b(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+(\d{4})\b/g;
  const headers = [];
  let m;
  while ((m = mesHdrRE.exec(raw)) !== null) {
    headers.push({ label: `${m[1]} ${m[2]}`, idx: m.index });
  }
  if (!headers.length) return { raw, meses: [] };

  // 3) Helpers de captura
  const lab = {
    vigente: /\bVigente\b/i,
    v1_29: /\bVencido\s+de\s+1\s*a\s*29\s*d[ií]as\b/i,
    v30_59: /\bVencido\s+de\s+30\s*a\s*59\s*d[ií]as\b/i,
    v60_89: /\bVencido\s+de\s+60\s*a\s*89\s*d[ií]as\b/i,
    v90plus: /\b(Vencido\s+a\s+mas\s+de\s+89\s*d[ií]as|90\+)\b/i,
    calif: /\bCalificaci[oó]n\s+de\s+Cartera\b/i,
  };
  const nextNumber = s => {
    const hit = /(--|[-+]?\d+(?:\.\d+)?)/.exec(s);
    if (!hit) return 0;
    return hit[1] === "--" ? 0 : Number(hit[1]);
  };

  // 4) Rebanar por mes y capturar el primer valor que sigue a cada etiqueta
  const meses = [];
  for (let i = 0; i < headers.length; i++) {
    const from = headers[i].idx;
    const to = i + 1 < headers.length ? headers[i + 1].idx : raw.length;
    const chunk = raw.slice(from, to);

    const capt = (re, asText = false) => {
      const t = re.exec(chunk);
      if (!t) return asText ? "" : 0;
      const rest = chunk.slice(t.index + t[0].length);
      if (asText) {
        const line = rest.split("\n")[0].trim();
        return line.replace(/\s+/g, " ");
      }
      return nextNumber(rest);
    };

    meses.push({
      mes: headers[i].label,
      vigente: capt(lab.vigente),
      v1_29: capt(lab.v1_29),
      v30_59: capt(lab.v30_59),
      v60_89: capt(lab.v60_89),
      v90plus: capt(lab.v90plus),
      calif: capt(lab.calif, true),
    });
  }

  return { raw, meses };
}

