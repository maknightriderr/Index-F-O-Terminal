# 📊 Index & F&O Derivatives Intelligence Terminal

A production-grade, scalable Indian Market Index & F&O Derivatives Intelligence Terminal built on Angel One SmartAPI.

## Architecture

```
┌──────────────────────────────────────────────┐
│              Frontend (Next.js)               │
│         Vercel / localhost:3000                │
├──────────────────────────────────────────────┤
│          Backend API (Express.js)             │
│          Railway / localhost:4000              │
├──────────────────────────────────────────────┤
│   PostgreSQL + TimescaleDB  │     Redis       │
│      localhost:5432          │  localhost:6379  │
├──────────────────────────────────────────────┤
│           Angel One SmartAPI                  │
│   REST + WebSocket v2 (Binary Protocol)       │
└──────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites
- Node.js ≥ 20
- Docker & Docker Compose
- Angel One SmartAPI credentials

### 1. Clone & Install

```bash
git clone <repo-url>
cd "Index + F&O Terminal"
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env
# Edit .env with your Angel One credentials
```

### 3. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- PostgreSQL 16 + TimescaleDB (port 5432)
- Redis 7 (port 6379)

### 4. Start Development

```bash
# Start everything
npm run dev:all

# Or individually:
npm run dev:server   # Backend on :4000
npm run dev:web      # Frontend on :3000
```

## Project Structure

```
├── apps/
│   ├── web/              # Next.js frontend
│   └── server/           # Express.js backend
├── packages/
│   ├── shared/           # Shared types & constants
│   └── analytics/        # Financial math (Greeks, indicators)
├── database/
│   └── init/             # SQL migrations
├── docker-compose.yml
├── turbo.json
└── package.json
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, TypeScript, Tailwind CSS, shadcn/ui |
| Charts | TradingView Lightweight Charts v4 |
| Backend | Express.js, TypeScript |
| Database | PostgreSQL 16 + TimescaleDB |
| Cache | Redis 7 |
| Data Provider | Angel One SmartAPI |

## Features

- 📈 Real-time market data via WebSocket
- 📊 Professional option chain with Greeks
- 🔍 OI intelligence (buildup classification, walls, shifts)
- 📉 IV intelligence (rank, percentile, skew, heatmap)
- 🎯 Max Pain & Expected Move
- 📋 PCR analysis
- 💡 Market regime detection
- 🧠 Market bias engine with probabilistic signals
- 🏗️ Strategy scanner & payoff analysis
- ⚡ Technical indicators & chart patterns
- 🔔 Real-time alerts
- 📚 Backtesting engine
- 🔄 Market replay

## Deployment

```
Vercel (apps/web — Next.js)
   |
   |  NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL
   v
Railway project
   ├── apps/server  (Express + WebSocket bridge, always-on Node process)
   ├── Postgres plugin
   └── Redis plugin
```

Vercel only runs serverless functions, so it can host `apps/web` but **not**
`apps/server` — the backend holds a persistent WebSocket connection to Angel
One and in-memory subscription state, neither of which survive in a
serverless function. It needs a host that runs a long-lived Node process;
this repo is set up for Railway, but Render/Fly.io work the same way.

### 1. Backend, Postgres, Redis — Railway

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo → select this repo.
2. Add a **Postgres** plugin and a **Redis** plugin to the project (Railway auto-populates their connection env vars).
3. Add a service for the backend, pointed at this repo, **root directory left as the repo root** (not `apps/server` — the build needs the whole workspace):
   - Build command: `npm install && npm run build`
   - Start command: `npm start --workspace=@fno/server`
4. In that service's **Variables**, add (see the table below for what each one is): `ANGEL_ONE_API_KEY`, `ANGEL_ONE_CLIENT_ID`, `ANGEL_ONE_PASSWORD`, `ANGEL_ONE_TOTP_SECRET`, `JWT_SECRET`, `CORS_ORIGINS`, `NODE_ENV=production`. Reference the Postgres/Redis plugins' own `DATABASE_URL`/`REDIS_URL` variables (Railway lets you reference `${{Postgres.DATABASE_URL}}` etc. directly — you don't retype them).
5. Once deployed, run the schema migration once against that database: `DATABASE_URL="<railway postgres url>" npm run db:migrate --workspace=@fno/server` (from your machine, or as a one-off Railway command). Railway's Postgres plugin is plain Postgres — the TimescaleDB-specific parts of the schema (hypertables, retention, compression) apply best-effort and simply no-op there; everything else works normally. See `database/init/` for the migration files themselves.
6. Note the public URL Railway gives the backend service (e.g. `https://your-app.up.railway.app`) — the frontend needs it next.

### 2. Frontend — Vercel

1. [vercel.com](https://vercel.com) → New Project → import this GitHub repo.
2. Set **Root Directory** to `apps/web` (Vercel auto-detects Next.js and the npm workspace from there).
3. Add environment variables (Project Settings → Environment Variables):
   - `NEXT_PUBLIC_API_URL` = the Railway backend URL from step 1.6 (e.g. `https://your-app.up.railway.app`)
   - `NEXT_PUBLIC_WS_URL` = same host, `wss://` scheme (e.g. `wss://your-app.up.railway.app`)
4. Deploy. Then go back to Railway and set that service's `CORS_ORIGINS` to your Vercel URL (e.g. `https://your-app.vercel.app`) so the backend actually accepts requests from it.

### Where credentials go

**Nothing secret is ever committed to the repo or given to an AI assistant to type in for you** — `.env` is gitignored, and every value below gets typed directly into the hosting platform's own dashboard by you.

| Variable | Where | Secret? | Notes |
|---|---|---|---|
| `ANGEL_ONE_API_KEY`, `ANGEL_ONE_CLIENT_ID`, `ANGEL_ONE_PASSWORD`, `ANGEL_ONE_TOTP_SECRET` | Railway (backend service) only | Yes | Your broker credentials. Never put these on Vercel — the frontend never needs them, the backend is the only thing that talks to Angel One. |
| `JWT_SECRET` | Railway (backend service) only | Yes | Generate a random 32+ char string (e.g. `openssl rand -base64 32`), don't reuse the `.env.example` placeholder. |
| `DATABASE_URL`, `REDIS_URL` | Railway (backend service) only | Yes | Reference the Postgres/Redis plugins' own variables — don't hand-type connection strings. |
| `CORS_ORIGINS` | Railway (backend service) only | No | Your Vercel URL. Not secret, but must be correct or the frontend gets CORS errors. |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` | Vercel (frontend project) only | No | `NEXT_PUBLIC_*` vars are bundled into the browser JS — never put a secret behind this prefix, anywhere. |

## Security

- ⚠️ Never commit `.env` files
- ⚠️ All secrets in environment variables
- ⚠️ API keys never exposed to frontend
- ⚠️ Rate limiting enabled
- ⚠️ Helmet security headers
- ⚠️ CORS configured

## License

Private — All rights reserved.
