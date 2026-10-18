# Agenda de fiestas

Agenda de reservaciones para animador de fiestas (hasta 3 fiestas por día: mañana, tarde y noche; con control de abonos y pagos). Node.js + Express + Neon (Postgres). Instalable en el celular (PWA).

## Variables de entorno
Copia `.env.example` como `.env` (local) o agrégalas en Render > Environment:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión de Neon |
| `APP_PIN` | PIN para proteger la agenda (opcional) |
| `APP_TZ` | Zona horaria, por defecto `America/El_Salvador` |

## Correr en local
```
npm install
npm start
```
Abre http://localhost:3000

## Desplegar en Render
- Root Directory: vacío (los archivos están en la raíz del repo)
- Build Command: `npm install`
- Start Command: `npm start`
