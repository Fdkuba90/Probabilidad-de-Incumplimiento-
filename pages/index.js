import React, { useState } from 'react';
import FileUploader from '../components/FileUploader';
import ResultCard from '../components/ResultCard';

export default function Home() {
  const [fileName, setFileName] = useState(null);
  const [empresa, setEmpresa] = useState("Nombre de la Empresa S.A. de C.V.");
  const [fecha, setFecha] = useState(new Date().toLocaleDateString());
  const [puntaje, setPuntaje] = useState(null);
  const [pi, setPI] = useState(null);

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      setFileName(file.name);
      // Aquí irá la lógica real de lectura de PDF
      setPuntaje(720); // Simulado
      setPI("2.16%");   // Simulado
    }
  };

  return (
    <div style={{ padding: 40, fontFamily: 'Arial', backgroundColor: '#f7f9fa' }}>
      <img src="/finantah-logo.png" alt="FINANTAH Logo" style={{ width: 180, marginBottom: 20 }} />
      <h1 style={{ color: '#1a202c' }}>Probabilidad de Incumplimiento</h1>
      <FileUploader onFileSelect={handleFileSelect} />
      {fileName && (
        <ResultCard
          fileName={fileName}
          empresa={empresa}
          fecha={fecha}
          puntaje={puntaje}
          pi={pi}
        />
      )}
    </div>
  );
}
