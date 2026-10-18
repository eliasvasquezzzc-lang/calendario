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

// ---------- Turnos (hasta 3 fiestas por día) ----------
const TURNOS = ['manana', 'tarde', 'noche'];
const ORDEN_TURNO = "CASE turno WHEN 'manana' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END";
const COLS = 'id, fecha, turno, cliente, telefono, lugar, tematica, monto, abonado';

// Valida y normaliza los datos de una reservación (sirve para crear y editar)
function validar(body = {}) {
  const { fecha, turno, cliente, telefono, lugar, tematica, monto } = body;
  if (!esFecha(fecha)) return { error: 'Fecha inválida' };
  if (!TURNOS.includes(turno)) return { error: 'Elige el turno: mañana, tarde o noche' };
  if (!cliente?.trim()) return { error: 'Falta el nombre del cliente' };
  const digitos = String(telefono || '').replace(/\D/g, '');
  if (digitos.length !== 8) return { error: 'El teléfono debe tener 8 dígitos (0000-0000)' };
  if (!lugar?.trim()) return { error: 'Falta el lugar de la fiesta' };
  const total = Number(monto);
  if (monto === '' || monto == null || !Number.isFinite(total) || total < 0) {
    return { error: 'El monto a cobrar no es válido' };
  }
  const abono = body.abonado === '' || body.abonado == null ? 0 : Number(body.abonado);
  if (!Number.isFinite(abono) || abono < 0) return { error: 'El abono no es válido' };
  if (abono > total) return { error: 'El abono no puede ser mayor al monto a cobrar' };
  return {
    datos: {
      fecha,
      turno,
      cliente: cliente.trim(),
      telefono: `${digitos.slice(0, 4)}-${digitos.slice(4)}`,
      lugar: lugar.trim(),
      tematica: tematica?.trim() || null,
      monto: total,
      abonado: abono,
    },
  };
}

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
      fecha      DATE NOT NULL,
      turno      TEXT NOT NULL DEFAULT 'tarde',
      cliente    TEXT NOT NULL,
      telefono   TEXT NOT NULL,
      lugar      TEXT NOT NULL DEFAULT '',
      tematica   TEXT,
      monto      NUMERIC(10,2) NOT NULL DEFAULT 0,
      abonado    NUMERIC(10,2) NOT NULL DEFAULT 0,
      creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Migraciones para tablas creadas con versiones anteriores
  await pool.query("ALTER TABLE reservas ADD COLUMN IF NOT EXISTS lugar TEXT NOT NULL DEFAULT ''");
  await pool.query('ALTER TABLE reservas ALTER COLUMN tematica DROP NOT NULL');
  await pool.query("ALTER TABLE reservas ADD COLUMN IF NOT EXISTS turno TEXT NOT NULL DEFAULT 'tarde'");
  await pool.query('ALTER TABLE reservas ADD COLUMN IF NOT EXISTS abonado NUMERIC(10,2) NOT NULL DEFAULT 0');
  // Antes había una sola fiesta por día (UNIQUE en fecha). Ahora es única por fecha + turno.
  await pool.query('ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_fecha_key');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS reservas_fecha_turno_uq ON reservas (fecha, turno)');
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
      `SELECT ${COLS} FROM reservas WHERE fecha >= $1 AND fecha < $2 ORDER BY fecha, ${ORDEN_TURNO}`,
      [desde, hasta]
    );
    res.json(rows);
  })
);

// ---------- Crear reservación ----------
app.post(
  '/api/reservas',
  wrap(async (req, res) => {
    const { error, datos } = validar(req.body);
    if (error) return res.status(400).json({ error });
    if (datos.fecha < hoy()) return res.status(400).json({ error: 'No puedes reservar una fecha pasada' });

    try {
      const { rows } = await pool.query(
        `INSERT INTO reservas (fecha, turno, cliente, telefono, lugar, tematica, monto, abonado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${COLS}`,
        [datos.fecha, datos.turno, datos.cliente, datos.telefono, datos.lugar, datos.tematica, datos.monto, datos.abonado]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Ese turno ya está reservado en esa fecha' });
      }
      throw err;
    }
  })
);

// ---------- Editar reservación ----------
app.put(
  '/api/reservas/:id',
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { error, datos } = validar(req.body);
    if (error) return res.status(400).json({ error });

    const actual = await pool.query('SELECT fecha FROM reservas WHERE id = $1', [id]);
    if (!actual.rowCount) return res.status(404).json({ error: 'Reservación no encontrada' });
    // Solo se bloquea si la están moviendo a una fecha pasada (se puede editar una fiesta que ya ocurrió)
    if (datos.fecha !== actual.rows[0].fecha && datos.fecha < hoy()) {
      return res.status(400).json({ error: 'No puedes mover la reservación a una fecha pasada' });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE reservas
            SET fecha = $1, turno = $2, cliente = $3, telefono = $4, lugar = $5,
                tematica = $6, monto = $7, abonado = $8
          WHERE id = $9
          RETURNING ${COLS}`,
        [datos.fecha, datos.turno, datos.cliente, datos.telefono, datos.lugar, datos.tematica, datos.monto, datos.abonado, id]
      );
      res.json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Ese turno ya está reservado en esa fecha' });
      }
      throw err;
    }
  })
);

// ---------- Registrar pago (abono o pago completo): { abonado: 25 } ----------
app.patch(
  '/api/reservas/:id/pago',
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const abono = Number(req.body?.abonado);
    if (req.body?.abonado === '' || !Number.isFinite(abono) || abono < 0) {
      return res.status(400).json({ error: 'El abono no es válido' });
    }
    const { rows } = await pool.query('SELECT monto FROM reservas WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Reservación no encontrada' });
    if (abono > rows[0].monto) {
      return res.status(400).json({ error: 'El abono no puede ser mayor al monto a cobrar' });
    }
    const upd = await pool.query(`UPDATE reservas SET abonado = $1 WHERE id = $2 RETURNING ${COLS}`, [abono, id]);
    res.json(upd.rows[0]);
  })
);

// ---------- Próxima fiesta (desde hoy) ----------
app.get(
  '/api/proxima',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM reservas WHERE fecha >= $1 ORDER BY fecha, ${ORDEN_TURNO} LIMIT 1`,
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

// ---------- Disponibilidad por turno: /api/disponibilidad?fecha=2026-10-17[&excluir=ID] ----------
// "excluir" sirve al editar: ignora la propia reservación para que no se bloquee a sí misma
app.get(
  '/api/disponibilidad',
  wrap(async (req, res) => {
    const { fecha } = req.query;
    if (!esFecha(fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    const excluir = parseInt(req.query.excluir, 10) || 0;
    const { rows } = await pool.query(
      'SELECT id, turno, cliente, lugar, tematica FROM reservas WHERE fecha = $1 AND id <> $2',
      [fecha, excluir]
    );
    const turnos = Object.fromEntries(TURNOS.map((t) => [t, rows.find((r) => r.turno === t) || null]));
    res.json({
      fecha,
      pasada: fecha < hoy(),
      finDeSemana: esFinDeSemana(fecha),
      turnos,
      libres: TURNOS.filter((t) => !turnos[t]),
      disponible: TURNOS.some((t) => !turnos[t]),
    });
  })
);

// ---------- Próximos fines de semana con algún turno libre: /api/fines-de-semana?cantidad=10 ----------
app.get(
  '/api/fines-de-semana',
  wrap(async (req, res) => {
    const cantidad = Math.min(Math.max(parseInt(req.query.cantidad, 10) || 10, 1), 60);
    const inicio = hoy();
    const fin = sumarDias(inicio, 7 * 52);
    const { rows } = await pool.query(
      'SELECT fecha, turno FROM reservas WHERE fecha BETWEEN $1 AND $2',
      [inicio, fin]
    );
    const ocupados = {};
    for (const r of rows) (ocupados[r.fecha] ||= new Set()).add(r.turno);
    const libres = [];
    for (let f = inicio; f <= fin && libres.length < cantidad; f = sumarDias(f, 1)) {
      if (!esFinDeSemana(f)) continue;
      const turnosLibres = TURNOS.filter((t) => !ocupados[f]?.has(t));
      if (turnosLibres.length) libres.push({ fecha: f, libres: turnosLibres });
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
