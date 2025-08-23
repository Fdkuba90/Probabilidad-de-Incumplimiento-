// pages/api/clientes/por-rfc.js
import { prisma } from '../../../lib/prisma';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  try {
    const { rfc } = req.query;
    if (!rfc) return res.status(400).json({ ok: false, error: 'RFC requerido' });

    const cliente = await prisma.cliente.findUnique({ where: { rfc } });
    if (!cliente) return res.status(404).json({ ok: false, error: 'No encontrado' });

    return res.status(200).json({ ok: true, data: cliente });
  } catch (err) {
    console.error('Error consultando cliente:', err);
    return res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
}
