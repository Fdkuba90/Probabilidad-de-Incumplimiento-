import { useState } from "react";

const fmtPeso = (n) =>
  (typeof n === "number" && !Number.isNaN(n))
    ? n.toLocaleString("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 })
    : "-";

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

  const th = { textAlign: "left", padding: "10px 12px", background: "#f3f4f6", borderBottom: "1px solid #e5e7eb" };
  const td = { padding: "10px 12px", borderBottom: "1px solid #e5e7eb" };

  const IDS_SHOW = [1, 6, 9, 11, 14, 15, 16, 17];

  // Para ID 15 mostramos también UDIS
  const renderValor = (id, val, valores) => {
    if (id === 15) {
      const udis = valores?._udis ?? null;
      return (typeof udis === "number" && !Number.isNaN(udis))
        ? `${(val || 0).toLocaleString("es-MX")}  →  ${udis.toLocaleString("es-MX")} UDIS`
        : (val || 0).toLocaleString("es-MX");
    }
    return String(val ?? "-");
  };

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      {/* Encabezado con logo más arriba */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
        <img src="/finantah-logo.png" alt="FINANTAH" height={38} style={{ transform: "translateY(-8px)" }} />
      </div>
      <h2 style={{ textAlign: "center", marginTop: 0 }}>Analizador de Buró – Sección Califica</h2>

      <form onSubmit={submit} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;<input value={udi} onChange={(e) => setUdi(e.target.value)} style={{ width: 110 }} /></label>
        <button type="submit">Analizar PDF</button>
      </form>

      {/* Métricas en columna */}
      {busy && <p>Procesando PDF…</p>}
      {err && <p style={{ color: "crimson" }}>{err}</p>}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4, margin: "8px 0 18px" }}>
            <div><strong>Puntaje total:</strong> {data.puntajeTotal}</div>
            <div><strong>PI:</strong> {data.probabilidadIncumplimiento}</div>
            <div><strong>Total de créditos Original:</strong> {fmtPeso(data.summary?.totalOriginalPesos)}</div>
            <div><strong>Total de créditos Saldo Actual:</strong> {fmtPeso(data.summary?.totalSaldoActualPesos)}</div>
            <div><strong>Total de créditos Vigentes:</strong> {fmtPeso(data.summary?.totalVigentePesos)}</div>
            <div><strong>Total de créditos Vencidos:</strong> {fmtPeso(data.summary?.totalVencidoPesos)}</div>
          </div>

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
                {IDS_SHOW.map((id) => {
                  const codigo = data.codigos?.[id] ?? "-";
                  const valor = data.valores?.[id];
                  const puntos = data.puntos?.[id] ?? "-";
                  return (
                    <tr key={id}>
                      <td style={td}>{id}</td>
                      <td style={td}>{codigo}</td>
                      <td style={td}>{renderValor(id, valor, data.valores)}</td>
                      <td style={td}>{puntos}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
