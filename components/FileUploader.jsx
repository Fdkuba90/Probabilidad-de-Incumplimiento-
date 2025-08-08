import React from 'react';

export default function FileUploader({ onFileSelect }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Subir PDF del Buró Empresarial:
      </label>
      <input type="file" accept=".pdf" onChange={onFileSelect} />
    </div>
  );
}
