import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [udi, setUdi] = useState("8.1462");
  const [output, setOutput] = useState(null);
  const [error, setError] = useState("");

  async function analizarPDF() {
    setError("");
    setOutput(null);

    try {
      if (!file) throw new Error("Selecciona un PDF.");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("udi", udi);

      const res = await fetch("/api/analyzePdf", {
        method: "POST",
        body: fd,
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      setOutput(data);
    } catch (e) {
      setError(String(e?.message || e));
    }
  }

  async function probarAPI() {
    setError("");
    setOutput(null);

    const res = await fetch("/api/ping", { method: "POST" });
    const body = await res.text();
    setOutput({ status: res.status, body });
  }

  return (
    <div style={{ maxWidth: 900, margin: "40px auto", fontFamily: "Arial" }}>
      <h1>Analizador de Buró – Sección Califica</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "16px 0" }}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <span>{file?.name || "Ningún archivo seleccionado"}</span>

        <label>
          &nbsp;UDI:&nbsp;
          <input value={udi} onChange={(e) => setUdi(e.target.value)} style={{ width: 100 }} />
        </label>

        <button onClick={analizarPDF}>Analizar PDF</button>
        <button onClick={probarAPI}>Probar API</button>
      </div>

      {error && (
        <pre style={{ background: "#ffe6e6", color: "#b00020", padding: 12, borderRadius: 6 }}>{error}</pre>
      )}

      {output && (
        <pre style={{ background: "#f6f8fa", padding: 12, borderRadius: 6, whiteSpace: "pre-wrap" }}>
          {JSON.stringify(output, null, 2)}
        </pre>
      )}
    </div>
  );
}
