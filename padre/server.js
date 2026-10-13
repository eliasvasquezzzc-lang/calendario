require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool, types } = require('pg');

// DATE llega como texto "AAAA-MM-DD" (evita problemas de zona horaria) y NUMERIC como número
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => parseFloat(v));

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL en el archivo .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(express.json());

// ---------- Utilidades de fechas (todo en texto AAAA-MM-DD) ----------
const TZ = process.env.APP_TZ || 'America/El_Salvador';
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const aUTC = (s) => new Date(`${s}T00:00:00Z`);
const esFecha = (s) =>
  typeof s === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !isNaN(aUTC(s)) &&
  aUTC(s).toISOString().slice(0, 10) === s;
const diaSemana = (s) => aUTC(s).getUTCDay(); // 0 = domingo, 6 = sábado
const esFinDeSemana = (s) => [0, 6].includes(diaSemana(s));
const sumarDias = (s, n) => {
  const d = aUTC(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  });

// ---------- Base de datos ----------
async function iniciarBD() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas (
      id         SERIAL PRIMARY KEY,
      fecha      DATE NOT NULL UNIQUE,
      cliente    TEXT NOT NULL,
      telefono   TEXT NOT NULL,
      tematica   TEXT NOT NULL,
      monto      NUMERIC(10,2) NOT NULL DEFAULT 0,
      creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// ---------- PIN opcional ----------
app.use('/api', (req, res, next) => {
  if (!process.env.APP_PIN) return next();
  if (req.get('x-pin') === process.env.APP_PIN) return next();
  res.status(401).json({ error: 'PIN incorrecto' });
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ---------- Reservaciones de un mes: /api/reservas?mes=2026-10 ----------
app.get(
  '/api/reservas',
  wrap(async (req, res) => {
    const mes = req.query.mes || hoy().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) {
      return res.status(400).json({ error: 'Mes inválido (usa AAAA-MM)' });
    }
    const [y, m] = mes.split('-').map(Number);
    const desde = `${mes}-01`;
    const hasta = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const { rows } = await pool.query(
      `SELECT id, fecha, cliente, telefono, tematica, monto
         FROM reservas WHERE fecha >= $1 AND fecha < $2 ORDER BY fecha`,
      [desde, hasta]
    );
    res.json(rows);
  })
);

// ---------- Crear reservación ----------
app.post(
  '/api/reservas',
  wrap(async (req, res) => {
    const { fecha, cliente, telefono, tematica, monto } = req.body || {};

    if (!esFecha(fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    if (fecha < hoy()) return res.status(400).json({ error: 'No puedes reservar una fecha pasada' });
    if (!cliente?.trim()) return res.status(400).json({ error: 'Falta el nombre del cliente' });
    if (!telefono?.trim()) return res.status(400).json({ error: 'Falta el número de teléfono' });
    if (!tematica?.trim()) return res.status(400).json({ error: 'Falta la temática de la fiesta' });
    const total = Number(monto);
    if (!Number.isFinite(total) || total < 0) {
      return res.status(400).json({ error: 'El monto a cobrar no es válido' });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO reservas (fecha, cliente, telefono, tematica, monto)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, fecha, cliente, telefono, tematica, monto`,
        [fecha, cliente.trim(), telefono.trim(), tematica.trim(), total]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Esa fecha ya está reservada' });
      }
      throw err;
    }
  })
);

// ---------- Próxima fiesta (desde hoy) ----------
app.get(
  '/api/proxima',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, fecha, cliente, telefono, tematica, monto
         FROM reservas WHERE fecha >= $1 ORDER BY fecha LIMIT 1`,
      [hoy()]
    );
    res.json(rows[0] || null);
  })
);

// ---------- Eliminar reservación ----------
app.delete(
  '/api/reservas/:id',
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rowCount } = await pool.query('DELETE FROM reservas WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Reservación no encontrada' });
    res.json({ ok: true });
  })
);

// ---------- ¿Está disponible esta fecha? /api/disponibilidad?fecha=2026-10-17 ----------
app.get(
  '/api/disponibilidad',
  wrap(async (req, res) => {
    const { fecha } = req.query;
    if (!esFecha(fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    const { rows } = await pool.query(
      'SELECT cliente, tematica FROM reservas WHERE fecha = $1',
      [fecha]
    );
    res.json({
      fecha,
      pasada: fecha < hoy(),
      finDeSemana: esFinDeSemana(fecha),
      disponible: rows.length === 0,
      reserva: rows[0] || null,
    });
  })
);

// ---------- Próximos fines de semana libres: /api/fines-de-semana?cantidad=10 ----------
app.get(
  '/api/fines-de-semana',
  wrap(async (req, res) => {
    const cantidad = Math.min(Math.max(parseInt(req.query.cantidad, 10) || 10, 1), 60);
    const inicio = hoy();
    const fin = sumarDias(inicio, 7 * 52);
    const { rows } = await pool.query(
      'SELECT fecha FROM reservas WHERE fecha BETWEEN $1 AND $2',
      [inicio, fin]
    );
    const ocupadas = new Set(rows.map((r) => r.fecha));
    const libres = [];
    for (let f = inicio; f <= fin && libres.length < cantidad; f = sumarDias(f, 1)) {
      if (esFinDeSemana(f) && !ocupadas.has(f)) libres.push(f);
    }
    res.json(libres);
  })
);

// ---------- Frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
iniciarBD()
  .then(() => app.listen(PORT, () => console.log(`Agenda lista en http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('No se pudo conectar a Neon:', err.message);
    process.exit(1);
  });
