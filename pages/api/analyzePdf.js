import pdfParse from 'pdf-parse';

const puntosBase = 285;

function calcularPuntajeIndicadores(valores) {
  const puntos = {
    1: valores[1] === 0 ? 62 : valores[1] <= 3 ? 50 : valores[1] <= 7 ? 41 : 16,
    6: valores[6] >= 0.93 ? 71 : valores[6] >= 0.81 ? 54 : 17,
    9: valores[9] === 0 ? 54 : -19,
    11: valores[11] === '--' ? 55 : valores[11] === 0 ? 57 : 30,
    14: valores[14] === 0 ? 55 : -29,
    15: valores[15] >= 1_000_000 ? 112 : 52,
    16: valores[16] < 24 ? 41 :
        valores[16] < 36 ? 51 :
        valores[16] < 48 ? 60 :
        valores[16] < 98 ? 60 :
        valores[16] < 120 ? 61 : 67,
    17: valores[17] <= 6 ? 46 : 58,
  };

  const total = puntosBase + Object.values(puntos).reduce((a, b) => a + b, 0);
  return { puntos, total };
}

function calcularPI(puntajeTotal) {
  const exp = -((500 - puntajeTotal) * (Math.log(2) / 40));
  return 1 / (1 + Math.exp(exp));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { fileBase64 } = req.body;

  try {
    const buffer = Buffer.from(fileBase64, 'base64');
    const data = await pdfParse(buffer);
    const text = data.text;

    const valores = {
      1: parseInt(/BK12_NUM_CRED\s+(\d+)/.exec(text)?.[1] || '0'),
      6: parseFloat(/NBK12_PCT_PROMT\s+(\d+(\.\d+)?)/.exec(text)?.[1] || '1'),
      9: parseFloat(/BK24_PCT_60PLUS\s+(\d+)/.exec(text)?.[1] || '0'),
      11: /NBK12_COMM_PCT_PLUS\s+(--|\d+(\.\d+)?)/.exec(text)?.[1] || '--',
      14: parseInt(/BK12_IND_QCRA\s+(\d)/.exec(text)?.[1] || '0'),
      15: parseFloat(/BK12_MAX_CREDIT_AMT\s+(\d+(\.\d+)?)/.exec(text)?.[1] || '0') / 8.1462,
      16: parseInt(/MONTHS_ON_FILE_BANKING\s+(\d+)/.exec(text)?.[1] || '0'),
      17: parseInt(/MONTHS_SINCE_LAST_OPEN_BANKING\s+(\d+)/.exec(text)?.[1] || '0'),
    };

    const { puntos, total } = calcularPuntajeIndicadores(valores);
    const pi = calcularPI(total);

    res.status(200).json({
      valores,
      puntos,
      puntajeTotal: total,
      probabilidadIncumplimiento: (pi * 100).toFixed(2) + '%',
    });
  } catch (error) {
    console.error('Error al procesar PDF:', error);
    res.status(500).json({ error: 'No se pudo procesar el archivo PDF' });
  }
}

