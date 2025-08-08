import React from 'react';

export default function ResultCard({ fileName, empresa, fecha, puntaje, pi }) {
  return (
    <div style={{
      border: '1px solid #ccc',
      padding: 20,
      borderRadius: 8,
      backgroundColor: 'white',
      marginTop: 20
    }}>
      <p><b>Empresa:</b> {empresa}</p>
      <p><b>Fecha:</b> {fecha}</p>
      <p><b>Archivo cargado:</b> {fileName}</p>
      <p><b>Puntaje total:</b> {puntaje}</p>
      <p><b>Probabilidad de Incumplimiento (PI):</b> {pi}</p>
    </div>
  );
}
