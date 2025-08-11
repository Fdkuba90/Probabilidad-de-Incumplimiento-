import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [udi, setUdi] = useState("8.1462"); // editable

  const onSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setResult(null);
    if (!file) return setError("Selecciona un PDF primero.");

    try {
      setLoading(true);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("udi", udi);

      const res = await fetch("/api/analyzePdf", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data || "Error al procesar");
      setResult(data);
    } catch (err) {
      setError(err.message || "No se pudo analizar el PDF");
    } finally {
      setLoading(false);
    }
  };

  const cell = { borderBottom: "1px solid #eee", padding: 8 };

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "24px" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <img src="/finantah-logo.png" alt="FINANTAH" height={32} />
        <h2 style={{ margin: 0 }}>Analizador de Buró – Sección Califica</h2>
      </header>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;
          <input value={udi} onChange={(e) => setUdi(e.target.value)} style={{ width: 100 }} />
        </label>
        <button type="submit">Analizar PDF</button>
      </form>

      {loading && <p>Procesando PDF…</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {result && (
        <section>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
            <div><strong>Puntaje total:</strong> {result.puntajeTotal}</div>
            <div><strong>PI:</strong> {result.probabilidadIncumplimiento}</div>
            <div><strong>Monto máx. crédito (UDIS):</strong> {result.valores?._udis ?? "-"}</div>
          </div>

          {/* Tabla: valores por ID */}
          <h4>Valores por ID</h4>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
            <thead>
              <tr>
                <th style={{ ...cell, background: "#f5f5f5", textAlign: "left" }}>ID</th>
                <th style={{ ...cell, background: "#f5f5f5", textAlign: "left" }}>Valor</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result.valores || {})
                .filter(([k]) => !String(k).startsWith("_"))
                .sort(([a],[b]) => Number(a) - Number(b))
                .map(([id, val]) => (
                  <tr key={id}>
                    <td style={cell}>{id}</td>
                    <td style={cell}>{String(val)}</td>
                  </tr>
                ))}
            </tbody>
          </table>

          {/* Tabla: puntaje por ID */}
          <h4>Puntaje por ID</h4>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...cell, background: "#f5f5f5", textAlign: "left" }}>ID</th>
                <th style={{ ...cell, background: "#f5f5f5", textAlign: "left" }}>Puntos</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result.puntos || {})
                .sort(([a],[b]) => Number(a) - Number(b))
                .map(([id, pts]) => (
                  <tr key={id}>
                    <td style={cell}>{id}</td>
                    <td style={cell}>{pts}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
