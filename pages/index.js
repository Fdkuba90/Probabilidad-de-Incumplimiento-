import React, { useState } from 'react';

export default function Home() {
  const [fileName, setFileName] = useState(null);
  const [empresa, setEmpresa] = useState("Nombre de la Empresa S.A. de C.V.");
  const [fecha, setFecha] = useState(new Date().toLocaleDateString());
  const [puntaje, setPuntaje] = useState(null);
  const [pi, setPI] = useState(null);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setFileName(file.name);
      // Lógica real para extraer valores irá aquí
      setPuntaje(720);
      setPI("2.16%");
    }
  };

  return (
    <div style={{ padding: 40, fontFamily: 'Arial', backgroundColor: '#f7f9fa' }}>
      <img src="/finantah-logo.png" alt="FINANTAH Logo" style={{ width: 180, marginBottom: 20 }} />
      <h1 style={{ color: '#1a202c' }}>Probabilidad de Incumplimiento</h1>
      <p>Sube el PDF del Buró de Crédito Empresarial:</p>
      <input type="file" accept=".pdf" onChange={handleFileChange} />
      <br /><br />
      {fileName && (
        <div style={{ border: '1px solid #ccc', padding: 20, borderRadius: 8, backgroundColor: 'white' }}>
          <p><b>Empresa:</b> {empresa}</p>
          <p><b>Fecha:</b> {fecha}</p>
          <p><b>Archivo cargado:</b> {fileName}</p>
          <p><b>Puntaje total:</b> {puntaje}</p>
          <p><b>Probabilidad de Incumplimiento (PI):</b> {pi}</p>
        </div>
      )}
    </div>
  );
}
