# Shaxmat game-server

WebSocket + Express service that pairs Mini App users into chess games.

## Run

```
npm install
npm start
```

Listens on `process.env.PORT` (default `3001`). WebSocket path is `/ws`,
healthcheck is `/health`.

## Deploy on Render

Connect this repo to a new Render Web Service:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

Or use the included `render.yaml` via Render Blueprints.

## Env vars

- `PORT` — set automatically by Render.
- `CORS_ORIGINS` — optional comma-separated list. Defaults already include
  the Vercel production domain plus localhost.
