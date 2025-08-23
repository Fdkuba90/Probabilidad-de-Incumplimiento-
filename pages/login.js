import { useState } from "react";
import Head from "next/head";

export default function Login() {
  const [pwd, setPwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd }),
      });
      if (!res.ok) {
        const js = await res.json().catch(() => ({}));
        throw new Error(js?.error || "Contraseña incorrecta");
      }
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next") || "/";
      window.location.href = next;
    } catch (e) {
      setErr(e.message || "Contraseña incorrecta");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Head>
        <title>Acceso | FINANTAH</title>
      </Head>
      <main className="container" style={{ maxWidth: 440 }}>
        <header className="header">
          <img src="/finantah-logo.png" alt="FINANTAH" className="logo" />
          <h1 className="title">Acceso</h1>
        </header>

        <form className="panel" onSubmit={onSubmit}>
          <div className="row" style={{ gap: 12, alignItems: "center" }}>
            <input
              type="password"
              placeholder="Contraseña"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              style={{ flex: 1, minWidth: 220, padding: "10px 12px", borderRadius: 8, border: "1px solid #d1d5db" }}
              autoFocus
            />
            <button type="submit" disabled={loading || !pwd}>
              {loading ? "Validando…" : "Entrar"}
            </button>
          </div>
          {err && <p className="error" style={{ marginTop: 10 }}>{err}</p>}
        </form>
      </main>
    </>
  );
}
