-- Ejecutar en el SQL Editor de Neon (opcional: el servidor también la crea solo)

CREATE TABLE IF NOT EXISTS reservas (
  id         SERIAL PRIMARY KEY,
  fecha      DATE          NOT NULL UNIQUE,   -- una fiesta por día
  cliente    TEXT          NOT NULL,          -- nombre del cliente
  telefono   TEXT          NOT NULL,          -- número de teléfono
  tematica   TEXT          NOT NULL,          -- temática de la fiesta
  monto      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),  -- cuánto se cobra
  creado_en  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Índice para consultar rápido por rango de fechas (el UNIQUE ya crea uno,
-- este queda como referencia si algún día quitas la restricción)
-- CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas (fecha);
