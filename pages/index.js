// /pages/index.js
import { useState } from "react";

const th = { textAlign: "left", padding: "8px 10px", background: "#f3f4f6", borderBottom: "1px solid #e5e7eb" };
const td = { padding: "8px 10px", borderBottom: "1px solid #e5e7eb" };
const money = (n) =>
  (n == null || !isFinite(n)) ? "-" :
  n.toLocaleString("en-US", { style: "currency", currency: "MXN", maximumFractionDigits: 2 });

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

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      {/* Logo arriba del título */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 8 }}>
        <img src="/finantah-logo.png" alt="FINANTAH" style={{ height: 34, transform: "translateY(4px)" }} />
        <h2 style={{ margin: 0 }}>Analizador de Buró – Sección Califica</h2>
      </div>

      <form onSubmit={submit} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;<input value={udi} onChange={(e) => setUdi(e.target.value)} style={{ width: 100 }} /></label>
        <button type="submit">Analizar PDF</button>
      </form>

      {busy && <p>Procesando PDF…</p>}
      {err && <p style={{ color: "crimson" }}>{err}</p>}

      {data && (
        <>
          {/* Métricas en vertical */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr", rowGap: 6, marginBottom: 18 }}>
            <div><strong>Puntaje total:</strong> {data.puntajeTotal}</div>
            <div><strong>PI:</strong> {data.probabilidadIncumplimiento}</div>
            <div><strong>Total de créditos Original:</strong> {money(data.totales?.original)}</div>
            <div><strong>Total de créditos Saldo Actual:</strong> {money(data.totales?.saldoActual)}</div>
            <div><strong>Total de créditos Vigentes:</strong> {money(data.totales?.vigente)}</div>
            <div><strong>Total de créditos Vencidos:</strong> {money(data.totales?.vencido)}</div>
          </div>

          {/* Tabla única con ID / Código / Valor / Puntaje */}
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
                {(data.tabla || []).map(row => (
                  <tr key={row.id}>
                    <td style={td}>{row.id}</td>
                    <td style={td}>{row.codigo}</td>
                    <td style={td}>{row.valor}</td>
                    <td style={td}>{row.puntaje}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
