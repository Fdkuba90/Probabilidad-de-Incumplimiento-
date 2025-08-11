import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const onSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setResult(null);

    if (!file) {
      setError("Selecciona un PDF primero.");
      return;
    }

    const form = new FormData();
    form.append("file", file);

    setLoading(true);
    try {
      const res = await fetch("/api/analyzePdf", {
        method: "POST",
        body: form
      });

      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || "Error del servidor");
      }

      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ maxWidth: 720, margin: "32px auto", fontFamily: "Inter, system-ui, Arial" }}>
      <img src="/finantah-logo.png" alt="FINANTAH" style={{ maxWidth: "200px", marginBottom: "20px" }} />
      <h1>Analizador de Buró – Sección Califica</h1>
      <p>Sube el PDF del Buró Empresarial. Extraeré la sección <b>Califica</b> y te mostraré el texto y una tabla preliminar.</p>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Procesando…" : "Analizar PDF"}
        </button>
      </form>

      {error && (
        <div style={{ marginTop: 16, color: "#b00020" }}>
          <b>Error:</b> {error}
        </div>
      )}

      {result && (
        <section style={{ marginTop: 24 }}>
          <h2>Resultado</h2>
          <div>
            <p><b>Páginas:</b> {result?.meta?.numpages ?? ""}</p>
            <p><b>Producer:</b> {result?.meta?.info?.Producer ?? ""}</p>
          </div>

          <h3>Texto crudo de “Califica”</h3>
          <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 12, borderRadius: 8 }}>
{result?.calificaRaw || "No se localizó la sección Califica."}
          </pre>

          {Array.isArray(result?.indicadores) && result.indicadores.length > 0 && (
            <>
              <h3>Indicadores detectados (preliminar)</h3>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 8 }}>ID</th>
                    <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 8 }}>Indicador</th>
                    <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 8 }}>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {result.indicadores.map((row, idx) => (
                    <tr key={idx}>
                      <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>{row.id ?? ""}</td>
                      <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>{row.nombre ?? ""}</td>
                      <td style={{ borderBottom: "1px solid #eee", padding: 8 }}>{row.valor ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </main>
  );
}