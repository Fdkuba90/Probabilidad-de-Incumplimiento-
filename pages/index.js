// pages/index.js — UI robusta: maneja respuestas no-JSON sin romper
import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [udi, setUdi] = useState("8.1462");
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");

  function safeParseJSON(text) {
    if (!text) return null;
    // intenta detectar JSON rápido (empieza con { o [)
    const t = text.trim();
    if (!t || !/^[{\[]/.test(t)) return null;
    try { return JSON.parse(t); } catch { return null; }
  }

  async function handleSend() {
    setErr("");
    setRes(null);
    try {
      const fd = new FormData();
      if (file) fd.append("file", file);
      fd.append("udi", udi);

      const r = await fetch("/api/analyzePdf", { method: "POST", body: fd });

      // lee SIEMPRE como texto primero
      const text = await r.text();
      const maybeJson = safeParseJSON(text);

      if (!r.ok) {
        // si vino JSON con {error: ...}, úsalo; si no, muestra el texto crudo
        const msg = maybeJson?.error || text || `HTTP ${r.status}`;
        throw new Error(msg);
      }

      if (maybeJson) {
        setRes(maybeJson);
      } else {
        // éxito sin JSON (no debería pasar, pero no truena la UI)
        setRes({ raw: text });
      }
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <h2>Analizador de Buró – Sección Califica</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
        <input type="file" accept="application/pdf" onChange={(e)=>setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;
          <input value={udi} onChange={e=>setUdi(e.target.value)} style={{ width: 100 }}/>
        </label>
        <button onClick={handleSend}>Analizar PDF</button>
      </div>

      {err && <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{err}</p>}

      {res && (
        <div style={{ marginTop: 24 }}>
          <pre style={{ whiteSpace: "pre-wrap", background: "#f6f8fa", padding: 12, borderRadius: 8 }}>
            {JSON.stringify(res, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
