import { useState } from "react";
import Head from "next/head";

export default function Home() {
  const [file, setFile] = useState(null);
  const [udi, setUdi] = useState("");
  const [metodo, setMetodo] = useState("sin"); // "sin" | "con"
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const nfMx = new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2
  });
  const nfPlain = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });
  const pf = new Intl.NumberFormat("es-MX", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  // IDs mostrados como porcentaje
  const idsPercent = new Set([6, 9, 11, 5, 7, 12]);
  // IDs mostrados como moneda
  const idsCurrency = new Set([15]);

  function formatIndicadorValor(row) {
    const raw = row?.valor;
    if (raw == null) return "—";
    if (typeof raw === "string") {
      const s = raw.trim();
      if (s === "--" || /^sin información$/i.test(s)) return "Sin Información";
    }
    const n = Number(String(raw).replace(/[, ]/g, ""));
    if (!Number.isFinite(n)) return String(raw);

    if (idsPercent.has(row.id)) {
      const v = n <= 1 ? n : n / 100;
      return pf.format(v);
    }
    if (idsCurrency.has(row.id)) return nfMx.format(n);
    return nfPlain.format(n);
  }

  async function onAnalyze(e) {
    e.preventDefault();
    setErr("");
    setData(null);
    if (!file) {
      setErr("Selecciona un PDF del Buró.");
      return;
    }
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("metodo", metodo);
      if (udi) fd.append("udi", udi);
      const res = await fetch("/api/analyzePdf", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch {
      setErr("No se pudo analizar el PDF. Revisa el archivo y vuelve a intentar.");
    } finally {
      setLoading(false);
    }
  }

  function onDownloadPdf() { if (data) window.print(); }

  const A = data?.activosTotales || {};

  return (
    <>
      <Head>
        <title>Analizador de Buró – Califica | FINANTAH</title>
      </Head>

      <main className="container print-fit">
        <header className="header">
          <img src="/finantah-logo.png" alt="FINANTAH" className="logo" />
          <h1 className="title">Análisis de Buró de Crédito</h1>
        </header>

        <form className="panel no-print" onSubmit={onAnalyze}>
          <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <input
              type="number"
              step="0.0001"
              min="0"
              placeholder="UDI (MXN por UDI) — opcional"
              value={udi}
              onChange={(e) => setUdi(e.target.value)}
              className="udi"
            />
            <button type="submit" disabled={loading}>
              {loading ? "Analizando…" : "Analizar PDF"}
            </button>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <select
                value={metodo}
                onChange={(e) => setMetodo(e.target.value)}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", minWidth: 180 }}
                aria-label="Seleccionar metodología"
              >
                <option value="sin">Sin Atraso</option>
                <option value="con">Con Atraso</option>
              </select>
            </label>
          </div>
          {err && <p className="error">{err}</p>}
        </form>

        {data && (
          <section className="results">
            <div className="card">
              <h3>Razón Social</h3>
              <p className="big">{data.razonSocial || "—"}</p>

              <h3>RFC</h3>
              <p className="big">{data.rfc || "—"}</p>
            </div>

            <div className="grid">
              <div className="card">
                <h3>Calificación (Puntaje total)</h3>
                <p className="badge">{data.puntajeTotal ?? "—"}</p>
                <p className="note" style={{ marginTop: 6 }}>
                  Metodología: <b>{data?.meta?.metodologia === "con" ? "Con Atraso" : "Sin Atraso"}</b> · Base:{" "}
                  <b>{data?.meta?.puntosBase ?? "—"}</b>
                </p>
              </div>

              <div className="card">
                <h3>Probabilidad de Incumplimiento (PI)</h3>
                <p className="badge">
                  {data.pi != null ? pf.format(data.pi) : "—"}
                </p>
              </div>
            </div>

            <div className="card">
              <h3>Resumen de Créditos Activos</h3>
              <div className="summary">
                <div>
                  <span>Total Original</span>
                  <strong>{nfMx.format((A.original ?? 0) * 1000)}</strong>
                </div>
                <div>
                  <span>Saldo Actual</span>
                  <strong>{nfMx.format((A.saldo ?? 0) * 1000)}</strong>
                </div>
                <div>
                  <span>Vigente</span>
                  <strong>{nfMx.format((A.vigente ?? 0) * 1000)}</strong>
                </div>
                <div>
                  <span>Vencido</span>
                  <strong>{nfMx.format((A.vencido ?? 0) * 1000)}</strong>
                </div>

                {/* Buckets */}
                <div>
                  <span>1–29 días</span>
                  <strong>{nfMx.format((A.d1_29 ?? 0) * 1000)}</strong>
                </div>
                <div>
                  <span>30–59 días</span>
                  <strong>{nfMx.format((A.d30_59 ?? 0) * 1000)}</strong>
                </div>
                <div>
                  <span>60–89 días</span>
                  <strong>{nfMx.format((A.d60_89 ?? 0) * 1000)}</strong>
                </div>
                <div>
                  <span>90–119 días</span>
                  <strong>{nfMx.format((A.d90_119 ?? 0) * 1000)}</strong>
                </div>
                <div>
                  <span>120–179 días</span>
                  <strong>{nfMx.format((A.d120_179 ?? 0) * 1000)}</strong>
                </div>
                <div>
                  <span>180+ días</span>
                  <strong>{nfMx.format((A.d180_plus ?? 0) * 1000)}</strong>
                </div>
              </div>
            </div>

            <div className="card card-table">
              <h3>Indicadores de Califica</h3>
              <div className="table">
                <div className="thead">
                  <div>ID</div>
                  <div>Código</div>
                  <div className="center">Valor</div>
                  <div className="center">Puntaje</div>
                </div>
                <div className="tbody">
                  {data.califica?.ids?.map((r) => (
                    <div className="tr" key={r.id}>
                      <div>{r.id}</div>
                      <div className="code">{r.codigo}</div>
                      <div className="center">{formatIndicadorValor(r)}</div>
                      <div className="center">{r.puntaje}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="card no-print" style={{ textAlign: "right" }}>
              <button type="button" onClick={onDownloadPdf}>Descargar PDF</button>
            </div>
          </section>
        )}
      </main>
    </>
  );
}
