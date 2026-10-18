-- Ejecutar en el SQL Editor de Neon (opcional: el servidor también la crea y actualiza solo)

CREATE TABLE IF NOT EXISTS reservas (
  id         SERIAL PRIMARY KEY,
  fecha      DATE          NOT NULL,
  turno      TEXT          NOT NULL DEFAULT 'tarde', -- 'manana' | 'tarde' | 'noche'
  cliente    TEXT          NOT NULL,
  telefono   TEXT          NOT NULL,                 -- formato 0000-0000
  lugar      TEXT          NOT NULL DEFAULT '',
  tematica   TEXT,
  monto      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),    -- total a cobrar
  abonado    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (abonado >= 0),  -- lo ya pagado (0 = sin pago, = monto = pagado completo)
  creado_en  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Si ya tenías la tabla de una versión anterior, ejecuta esto:
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS lugar TEXT NOT NULL DEFAULT '';
ALTER TABLE reservas ALTER COLUMN tematica DROP NOT NULL;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS turno TEXT NOT NULL DEFAULT 'tarde';
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS abonado NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_fecha_key;   -- ya no es una sola fiesta por día
CREATE UNIQUE INDEX IF NOT EXISTS reservas_fecha_turno_uq ON reservas (fecha, turno);
