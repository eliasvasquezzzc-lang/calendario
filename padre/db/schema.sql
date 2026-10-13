-- Ejecutar en el SQL Editor de Neon (opcional: el servidor también la crea y actualiza solo)

CREATE TABLE IF NOT EXISTS reservas (
  id         SERIAL PRIMARY KEY,
  fecha      DATE          NOT NULL UNIQUE,   -- una fiesta por día
  cliente    TEXT          NOT NULL,          -- nombre del cliente
  telefono   TEXT          NOT NULL,          -- formato 0000-0000
  lugar      TEXT          NOT NULL DEFAULT '', -- dónde será la fiesta
  tematica   TEXT,                            -- opcional
  monto      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),  -- cuánto se cobra
  creado_en  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Si ya tenías la tabla creada con la versión anterior, ejecuta esto:
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS lugar TEXT NOT NULL DEFAULT '';
ALTER TABLE reservas ALTER COLUMN tematica DROP NOT NULL;
