# Triangular arbitrage bot

React dashboard and Node server that watch **Phemex** triangle quotes (BTC → ETH → USDT → BTC), stream prices over **Socket.IO**, and optionally record opportunities to **Cloud Firestore**. Trading stays in **simulation** mode by design.

## Prerequisites

- Node.js 20 LTS or newer recommended
- A Firebase project (client config in `src/firebase` / applet config as used by the app)
- For recording hits on a hosted server: `FIREBASE_SERVICE_ACCOUNT_KEY` (service account JSON)

## Environment variables

Copy `.env.example` to `.env` locally and fill in values as needed.

| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Service account JSON (one line). Required on hosts without GCP metadata (e.g. Railway) so the server can write to Firestore. |
| `EXCHANGE_API_KEY` / `EXCHANGE_SECRET` | Optional Phemex API credentials. Without them the bot runs in monitoring-only simulation. |
| `GEMINI_API_KEY` | Optional; used if you enable Gemini-related features. |
| `APP_URL` | Optional; app URL for callbacks or links if configured. |
| `PORT` | Optional; server port (defaults to `3000`). |

## Run locally

```bash
npm install
npm run dev
```

Then open the URL printed in the terminal (typically `http://localhost:3000`).

## Production build

```bash
npm run build
npm start
```

`start` runs the production server (Express + Vite static assets + Socket.IO).

## Configuration notes

- **Min. profit threshold:** opportunities are logged and written to Firestore only when gross triangle profit exceeds **0.40%**. The value is defined as `MIN_PROFIT_THRESHOLD_PERCENT` in `server.ts` and should stay in sync with the figure shown in the UI configuration card.

## Dashboard (UI)

- **Firestore History:** lists recent hits from Firestore with **date and time** (locale-formatted) per row. Use **Simulate** to open the trade calculator for that hit.
- **Live Activity:** server log stream with **date and time** on each line.
- **Trade Simulator modal:** shows the selected hit’s **timestamp** in the header area. The main content (amount, execution steps, net result) **scrolls** inside the modal when it is tall, while the header and close action stay visible.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Vite production build |
| `npm start` | Production server |
| `npm run lint` | Typecheck (`tsc --noEmit`) |
