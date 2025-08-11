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

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <img src="/finantah-logo.png" alt="FINANTAH" height={32} />
        <h2 style={{ margin: 0 }}>Analizador de Buró – Sección Califica</h2>
      </header>

      <form onSubmit={submit} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;<input value={udi} onChange={(e) => setUdi(e.target.value)} style={{ width: 100 }} /></label>
        <button type="submit">Analizar PDF</button>
      </form>

      {busy && <p>Procesando PDF…</p>}
      {err && <p style={{ color: "crimson" }}>{err}</p>}

      {data && (
        <>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
            <div><strong>Puntaje total:</strong> {data.puntajeTotal}</div>
            <div><strong>PI:</strong> {data.probabilidadIncumplimiento}</div>
            <div><strong>Monto máx. crédito (UDIS):</strong> {data.valores?._udis ?? "-"}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <section>
              <h4>Valores por ID</h4>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>ID</th><th style={th}>Valor</th></tr></thead>
                <tbody>
                  {Object.entries(data.valores || {})
                    .filter(([k]) => !String(k).startsWith("_"))
                    .sort(([a],[b]) => Number(a) - Number(b))
                    .map(([id, val]) => (
                      <tr key={id}><td style={td}>{id}</td><td style={td}>{String(val)}</td></tr>
                    ))}
                </tbody>
              </table>
            </section>

            <section>
              <h4>Puntaje por ID</h4>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>ID</th><th style={th}>Puntos</th></tr></thead>
                <tbody>
                  {Object.entries(data.puntos || {})
                    .sort(([a],[b]) => Number(a) - Number(b))
                    .map(([id, val]) => (
                      <tr key={id}><td style={td}>{id}</td><td style={td}>{val}</td></tr>
                    ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
