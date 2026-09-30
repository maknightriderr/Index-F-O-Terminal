// Read-only GET calls to the live consensus engine's diagnostic endpoints.
// NEVER calls /api/market/bias/* or any non-GET endpoint (mandatory per the
// diagnosis brief). This module makes no trading decision and writes
// nothing back to the backend.

const BASE = 'https://backend-production-59fe.up.railway.app';

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { method: 'GET' });
  if (!res.ok) return { error: `${res.status} ${res.statusText}`, path };
  return res.json();
}

export async function fetchLiveFunnel() {
  const [gates, winRate, setups] = await Promise.all([
    getJson('/api/loss-attribution/gates'),
    getJson('/api/backtesting/win-rate'),
    getJson('/api/backtesting/trade-setups?limit=2000'),
  ]);
  return { gates, winRate, setups };
}
