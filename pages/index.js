// pages/index.js
import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [udi, setUdi] = useState("8.1462");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [showDebug, setShowDebug] = useState(false);

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

      // Mostrar el panel debug automáticamente si la historia viene toda en ceros
      const hm = Array.isArray(json?.historyMonthly) ? json.historyMonthly : [];
      const allZero = hm.length > 0 && hm.every(r =>
        (r.vigente ?? 0) === 0 && (r.v1_29 ?? 0) === 0 &&
        (r.v30_59 ?? 0) === 0 && (r.v60_89 ?? 0) === 0 && (r.v90p ?? 0) === 0
      );
      if (allZero) setShowDebug(true);

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

  const fmtValor = (v, idCampo) => {
    if (v === "--" || v == null) return "--";
    if (typeof v === "number") {
      const str = v.toLocaleString("es-MX");
      return idCampo === 15 ? `${str} UDIS` : str;
    }
    return String(v);
  };

  const fmtMXN = (n) =>
    typeof n === "number"
      ? n.toLocaleString("es-MX", { style: "currency", currency: "MXN" })
      : "-";

  const FlagsPanel = ({ flags }) => {
    const list = Array.isArray(flags) ? flags : [];
    return (
      <section style={{ margin: "16px 0" }}>
        <h4 style={{ margin: "8px 0" }}>⚑ Flags (advertencias y notas)</h4>
        {list.length === 0 ? (
          <div style={{
            padding: 12, borderRadius: 8, background: "#f6ffed",
            border: "1px solid #b7eb8f", color: "#135200"
          }}>
            Sin flags.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {list.map((f, i) => (
              <li key={i} style={{
                padding: 12, borderRadius: 8, background: "#fffbe6",
                border: "1px solid #ffe58f", color: "#614700"
              }}>
                <div><strong>Tipo:</strong> {f.tipo || "-"}</div>
                {f.detalle && <div><strong>Detalle:</strong> {f.detalle}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 16 }}>
        <img src="/finantah-logo.png" alt="FINANTAH" height={40} style={{ marginBottom: 4 }} />
        <h2 style={{ margin: 0, textAlign: "center" }}>Analizador de Buró – Sección Califica</h2>
      </header>

      <form onSubmit={submit} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label>UDI:&nbsp;<input value={udi} onChange={(e) => setUdi(e.target.value)} style={{ width: 100 }} /></label>
        <button type="submit" disabled={busy}>{busy ? "Procesando…" : "Analizar PDF"}</button>
      </form>

      {busy && <p>Procesando PDF…</p>}
      {err && <p style={{ color: "crimson" }}>{err}</p>}

      {/* Botón de debug y panel crudo */}
      {data && (
        <div style={{ margin: "12px 0" }}>
          <button
            type="button"
            onClick={() => setShowDebug(v => !v)}
            style={{ padding: "6px 10px" }}
          >
            {showDebug ? "Ocultar" : "Ver"} respuesta cruda (debug)
          </button>
          {showDebug && (
            <div style={{ marginTop: 8, background: "#0b1020", color: "#e6f3ff", padding: 12, borderRadius: 8, overflow: "auto" }}>
              <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
{JSON.stringify({
  empresa: data?.empresa,
  puntajeTotal: data?.puntajeTotal,
  summary: data?.summary,
  flags: data?.flags || [],
  historyMonthly: data?.historyMonthly
}, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {data && (
        <>
          {/* Panel de flags SIEMPRE visible */}
          <FlagsPanel flags={data?.flags} />

          {/* Panel vertical de resumen */}
          <section style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {data?.empresa && (
                <div style={{ fontSize: "1.2em", fontWeight: "bold" }}>
                  {data.empresa}
                </div>
              )}
              <div><strong>Puntaje total:</strong> {data.puntajeTotal}</div>
              <div><strong>PI:</strong> {data.probabilidadIncumplimiento}</div>

              <div><strong>Total de créditos Original:</strong> {fmtMXN(data?.summary?.totalOriginalPesos)}</div>
              <div><strong>Total de créditos Saldo Actual:</strong> {fmtMXN(data?.summary?.totalSaldoActualPesos)}</div>
              <div><strong>Total de créditos Vigentes:</strong> {fmtMXN(data?.summary?.totalVigentePesos)}</div>
              <div><strong>Total de créditos Vencidos:</strong> {fmtMXN(data?.summary?.totalVencidoPesos)}</div>
            </div>
          </section>

          {/* Tabla por ID (códigos y puntajes) */}
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
              <section style={{ marginBottom: 24 }}>
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

          {/* Historia mensual */}
          {Array.isArray(data.historyMonthly) && data.historyMonthly.length > 0 && (
            <section>
              <h4>Historia por mes (pesos)</h4>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Mes</th>
                    <th style={th}>Vigente</th>
                    <th style={th}>1–29</th>
                    <th style={th}>30–59</th>
                    <th style={th}>60–89</th>
                    <th style={th}>90+</th>
                    <th style={th}>Calif. Cartera</th>
                  </tr>
                </thead>
                <tbody>
                  {data.historyMonthly.map((r, idx) => (
                    <tr key={`${r.month}-${idx}`}>
                      <td style={td}>{r.month}</td>
                      <td style={td}>{fmtMXN(r.vigente)}</td>
                      <td style={td}>{fmtMXN(r.v1_29)}</td>
                      <td style={td}>{fmtMXN(r.v30_59)}</td>
                      <td style={td}>{fmtMXN(r.v60_89)}</td>
                      <td style={td}>{fmtMXN(r.v90p)}</td>
                      <td style={td}>{r.rating || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </main>
  );
}
