import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [udi, setUdi] = useState("8.1462");
  const [out, setOut] = useState(null);
  const [err, setErr] = useState("");

  async function analizar() {
    setErr(""); setOut(null);
    try {
      if (!file) throw new Error("Selecciona un PDF.");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("udi", udi);

      const r = await fetch("/api/analyzePdf", { method: "POST", body: fd });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!r.ok) throw new Error(data?.error || text || `HTTP ${r.status}`);
      setOut(data);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function ping() {
    setErr(""); setOut(null);
    const r = await fetch("/api/ping", { method: "POST" });
    const text = await r.text();
    setOut({ status: r.status, body: text });
  }

  return (
    <div style={{ maxWidth: 1000, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <h2>Analizador de Buró – Sección Califica</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <input type="file" accept="application/pdf" onChange={(e)=>setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;<input value={udi} onChange={e=>setUdi(e.target.value)} style={{ width: 100 }}/></label>
        <button onClick={analizar}>Analizar PDF</button>
        <button onClick={ping}>Probar API</button>
      </div>

      {err && <p style={{ color: "crimson", marginTop: 16, whiteSpace: "pre-wrap" }}>{err}</p>}

      {out && (
        <pre style={{ marginTop: 16, background: "#f6f8fa", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap" }}>
          {JSON.stringify(out, null, 2)}
        </pre>
      )}
    </div>
  );
}
