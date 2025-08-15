// UI simple + robusta: siempre lee respuesta como texto y parsea JSON solo si aplica
import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [udi, setUdi] = useState("8.1462");
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");

  function safeParseJSON(text) {
    const t = (text || "").trim();
    if (!t || !/^[{\[]/.test(t)) return null;
    try { return JSON.parse(t); } catch { return null; }
  }

  async function handleSend() {
    setErr(""); setRes(null);
    try {
      if (!file) throw new Error("Selecciona un PDF.");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("udi", udi);

      const r = await fetch("/api/analyzePdf", { method: "POST", body: fd });
      const text = await r.text();
      const data = safeParseJSON(text);

      if (!r.ok) throw new Error(data?.error || text || `HTTP ${r.status}`);
      setRes(data ?? { raw: text });
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  // Botón de prueba rápida del backend
  async function ping() {
    setErr(""); setRes(null);
    const r = await fetch("/api/ping", { method: "POST" });
    const text = await r.text();
    setRes({ status: r.status, body: text });
  }

  return (
    <div style={{ maxWidth: 900, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <h2>Analizador de Buró – Sección Califica</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <input type="file" accept="application/pdf" onChange={(e)=>setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;<input value={udi} onChange={e=>setUdi(e.target.value)} style={{ width: 100 }}/></label>
        <button onClick={handleSend}>Analizar PDF</button>
        <button onClick={ping} title="Probar backend">Probar API</button>
      </div>

      {err && <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{err}</p>}

      {res && (
        <div style={{ marginTop: 24 }}>
          <pre style={{ whiteSpace: "pre-wrap", background: "#f6f8fa", padding: 12, borderRadius: 8 }}>
            {typeof res === "string" ? res : JSON.stringify(res, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
