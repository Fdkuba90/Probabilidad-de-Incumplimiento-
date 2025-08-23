// pages/api/clientes/guardar.js
import { prisma } from '../../../lib/prisma';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  try {
    const { nombre, rfc, calificacion, pi } = req.body || {};

    if (!nombre || !rfc) {
      return res.status(400).json({ ok: false, error: 'Falta nombre o RFC' });
    }
    if (calificacion === undefined || pi === undefined) {
      return res.status(400).json({ ok: false, error: 'Falta calificación o PI' });
    }

    const saved = await prisma.cliente.upsert({
      where: { rfc },
      update: {
        nombre,
        calificacion: String(calificacion),
        pi: String(pi),
      },
      create: {
        nombre,
        rfc,
        calificacion: String(calificacion),
        pi: String(pi),
      },
    });

    return res.status(200).json({ ok: true, data: saved });
  } catch (err) {
    console.error('Error guardando cliente:', err);
    return res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
}
