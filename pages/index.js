{data && (
  <>
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
      <div><strong>Puntaje total:</strong> {data.puntajeTotal}</div>
      <div><strong>PI:</strong> {data.probabilidadIncumplimiento}</div>
      <div><strong>Monto máx. crédito (UDIS):</strong> {data.valores?._udis ?? "-"}</div>
    </div>

    {/* --- Tabla única: ID, Código, Valor, Puntaje --- */}
    {(() => {
      const IMPORTANT_IDS = [1, 6, 9, 11, 14, 15, 16, 17];

      // Si el API trae "indicadores" úsalo, si no, mapeo de respaldo:
      const fallbackCodes = {
        1: 'BK12_NUM_CRED',
        6: 'NBK12_PCT_PROMT',
        9: 'BK24_PCT_60PLUS',
        11:'NBK12_COMM_PCT_PLUS',
        14:'BK12_IND_QCRA',
        15:'BK12_MAX_CREDIT_AMT',
        16:'MONTHS_ON_FILE_BANKING',
        17:'MONTHS_SINCE_LAST_OPEN_BANKING'
      };

      const codeById = {};
      (data.indicadores || []).forEach(it => { codeById[Number(it.id)] = it.codigo; });

      const rows = IMPORTANT_IDS.map(id => {
        // Valor a mostrar: para 15 usamos UDIS (más útil que pesos)
const valorRaw = id === 15
  ? (data.valores?._udis ?? "--") // Mostrar directamente UDIS ya calculadas en el backend
  : (data.valores?.[id] ?? "--");


        // Formateo bonito de número
       const fmt = (v, idCampo) => {
  if (v === "--" || v === null || v === undefined) return "--";
  if (typeof v === "number") {
    return idCampo === 15
      ? `${v.toLocaleString("es-MX")} UDIS`
      : v.toLocaleString("es-MX");
  }
  return String(v);
};

        return {
          id,
          codigo: codeById[id] || fallbackCodes[id] || "",
          valor: fmt(valorRaw),
          puntaje: data.puntos?.[id] ?? ""
        };
      });

      const th = { textAlign: "left", padding: "8px 10px", background: "#f3f4f6", borderBottom: "1px solid #e5e7eb" };
      const td = { padding: "8px 10px", borderBottom: "1px solid #e5e7eb" };

      return (
        <section>
          <h4>Detalle de puntuación</h4>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>ID</th>
                <th style={th}>Código</th>
                <th style={th}>Valor</th>
                <th style={th}>Puntaje</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={td}>{r.id}</td>
                  <td style={td}>{r.codigo}</td>
                  <td style={td}>{r.valor}</td>
                  <td style={td}>{r.puntaje}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    })()}
  </>
)}
