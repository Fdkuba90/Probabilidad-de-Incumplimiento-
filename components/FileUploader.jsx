import { useState } from 'react';

export default function FileUploader() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];

        const res = await fetch('/api/analyzePdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileBase64: base64 }),
        });

        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Error en análisis');

        setResult(data);
      };

      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      setError('No se pudo analizar el archivo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '1rem' }}>
      <h2>Sube el Buró de Crédito (PDF)</h2>
      <input type="file" accept="application/pdf" onChange={handleFileChange} />
      {loading && <p>Procesando PDF...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {result && (
        <div style={{ marginTop: '2rem', border: '1px solid #ccc', padding: '1rem' }}>
          <h3>Resultado del análisis</h3>
          <p><strong>Puntaje total:</strong> {result.puntajeTotal}</p>
          <p><strong>Probabilidad de Incumplimiento:</strong> {result.probabilidadIncumplimiento}</p>

          <h4>Puntos por ID:</h4>
          <ul>
            {Object.entries(result.puntos).map(([id, val]) => (
              <li key={id}>ID {id}: {val} puntos</li>
            ))}
          </ul>

          <h4>Valores extraídos:</h4>
          <ul>
            {Object.entries(result.valores).map(([id, val]) => (
              <li key={id}>ID {id}: {val}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
