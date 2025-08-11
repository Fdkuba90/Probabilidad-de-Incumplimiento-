import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [udi, setUdi] = useState("8.1462");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setData(null);
    if (!file) { setErr("Selecciona un PDF."); return; }

    try {
      setBusy(true);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("udi", udi);

      const res = await fetch("/api/analyzePdf", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Error en análisis");
      setData(json);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const th = { textAlign: "left", padding: "8px 10px", background: "#f3f4f6", borderBottom: "1px solid #e5e7eb" };
  const td = { padding: "8px 10px", borderBottom: "1px solid #e5e7eb" };

  const IMPORTANT_IDS = [1, 6, 9, 11, 14, 15, 16, 17];

  const fallbackCodes = {
    1: "BK12_NUM_CRED",
    6: "NBK12_PCT_PROMT",
    9: "BK24_PCT_60PLUS",
    11: "NBK12_COMM_PCT_PLUS",
    14: "BK12_IND_QCRA",
    15: "BK12_MAX_CREDIT_AMT",
    16: "MONTHS_ON_FILE_BANKING",
    17: "MONTHS_SINCE_LAST_OPEN_BANKING",
  };

  // Valor: para ID 15 mostramos UDIS (calculadas en backend)
  const fmtValor = (v, idCampo) => {
    if (v === "--" || v === null || v === undefined) return "--";
    if (typeof v === "number") {
      const str = v.toLocaleString("es-MX");
      return idCampo === 15 ? `${str} UDIS` : str;
    }
    return String(v);
  };

  // Formato pesos MXN para el panel vertical
  const fmtMXN = (n) =>
    typeof n === "number"
      ? n.toLocaleString("es-MX", { style: "currency", currency: "MXN" })
      : "-";

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      {/* Header (logo sobre el título, centrados) */}
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          marginBottom: 16
        }}
      >
        <img src="/finantah-logo.png" alt="FINANTAH" height={40} style={{ marginBottom: 4 }} />
        <h2 style={{ margin: 0, textAlign: "center" }}>
          Analizador de Buró – Sección Califica
        </h2>
      </header>

      {/* Form */}
      <form onSubmit={submit} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;
          <input value={udi} onChange={(e) => setUdi(e.target.value)} style={{ width: 100 }} />
        </label>
        <button type="submit">Analizar PDF</button>
      </form>

      {busy && <p>Procesando PDF…</p>}
      {err && <p style={{ color: "crimson" }}>{err}</p>}

      {data && (
        <>
          {/* PANEL VERTICAL: puntaje + totales en pesos */}
          <section style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div><strong>Puntaje total:</strong> {data.puntajeTotal}</div>
              <div><strong>PI:</strong> {data.probabilidadIncumplimiento}</div>

              <div>
                <strong>Total de créditos Original (en pesos):</strong>{" "}
                {fmtMXN(data?.summary?.totalOriginalPesos)}
              </div>
              <div>
                <strong>Total de créditos Saldo Actual (en pesos):</strong>{" "}
                {fmtMXN(data?.summary?.totalSaldoActualPesos)}
              </div>
              <div>
                <strong>Total de créditos Vigentes (en pesos):</strong>{" "}
                {fmtMXN(data?.summary?.totalVigentePesos)}
              </div>
              <div>
                <strong>Total de créditos Vencidos (en pesos):</strong>{" "}
                {fmtMXN(data?.summary?.totalVencidoPesos)}
              </div>
            </div>
          </section>

          {/* Tabla única: ID, Código, Valor, Puntaje */}
          {(() => {
            const codeById = {};
            (data.indicadores || []).forEach((it) => { codeById[Number(it.id)] = it.codigo; });

            const rows = IMPORTANT_IDS.map((id) => {
              const valorRaw = id === 15 ? (data.valores?._udis ?? "--") : (data.valores?.[id] ?? "--");
              return {
                id,
                codigo: codeById[id] || fallbackCodes[id] || "-",
                valor: fmtValor(valorRaw, id),
                puntaje: data.puntos?.[id] ?? "-",
              };
            });

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
                    {rows.map((r) => (
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
    </main>
  );
}
