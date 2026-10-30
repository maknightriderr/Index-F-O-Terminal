// ============================================================
// LLM CLIENT — free-first provider chain (2026-10-16)
// ============================================================
// The AI assistant and the institutional-flow commentary (both read-only,
// never in the decision path) send one system prompt plus chat turns and get
// text back. Providers are tried in order; one without a key is skipped; a
// failure (rate limit, outage, retired model, empty answer) moves to the next.
//
//   GEMINI_API_KEY     Google AI Studio, free tier   GEMINI_MODEL    (default gemini-flash-latest)
//   GROQ_API_KEY       Groq, free tier               GROQ_MODEL      (default openai/gpt-oss-120b)
//   ANTHROPIC_API_KEY  Claude, paid                  ANTHROPIC_MODEL (default claude-sonnet-5)
//   AI_PROVIDERS       the order, comma-separated    (default gemini,groq,anthropic)
//
// Gemini and Groq are called through their OpenAI-compatible chat endpoints,
// so one adapter serves both. Keys live in Railway variables only, and are
// never logged (errors are logged by provider, status and message).
// ============================================================

import axios from 'axios';
import { createHash } from 'node:crypto';
import { logger } from './logger.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AiProviderId = 'gemini' | 'groq' | 'anthropic';

export interface AiProviderSpec {
  id: AiProviderId;
  label: string;
  model: string;
  apiKey: string;
  url: string;
  kind: 'openai' | 'anthropic';
}

export interface AiReply {
  text: string;
  provider: AiProviderId;
  label: string;
  model: string;
}

type Env = Readonly<Record<string, string | undefined>>;
type Post = (url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }) => Promise<{ data: any }>;

export const AI_DEFAULT_ORDER: readonly AiProviderId[] = ['gemini', 'groq', 'anthropic'];
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 30_000;

const CATALOG: Record<AiProviderId, (env: Env) => Omit<AiProviderSpec, 'id'>> = {
  gemini: (env) => ({
    label: 'Gemini',
    model: env.GEMINI_MODEL?.trim() || 'gemini-flash-latest',
    apiKey: env.GEMINI_API_KEY?.trim() ?? '',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    kind: 'openai',
  }),
  groq: (env) => ({
    label: 'Groq',
    model: env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b',
    apiKey: env.GROQ_API_KEY?.trim() ?? '',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    kind: 'openai',
  }),
  anthropic: (env) => ({
    label: 'Claude',
    model: env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5',
    apiKey: env.ANTHROPIC_API_KEY?.trim() ?? '',
    url: 'https://api.anthropic.com/v1/messages',
    kind: 'anthropic',
  }),
};

/**
 * Pure: the providers to try, in order — AI_PROVIDERS (unknown names ignored) or the default, keeping only those with
 * a key. A model setting may list several models, comma-separated (GEMINI_MODEL=gemini-flash-latest,gemini-2.5-flash):
 * each is tried in turn before the next provider. On 16 Oct the newest Flash models answered 503 "high demand" on
 * the free tier while gemini-2.5-flash answered.
 */
export function configuredAiProviders(env: Env = process.env): AiProviderSpec[] {
  const asked = (env.AI_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AiProviderId => s in CATALOG);
  const order = asked.length > 0 ? [...new Set(asked)] : AI_DEFAULT_ORDER;
  return order
    .map((id) => ({ id, ...CATALOG[id](env) }))
    .filter((p) => p.apiKey !== '')
    .flatMap((p) => {
      const models = [...new Set(p.model.split(',').map((m) => m.trim()).filter(Boolean))];
      return (models.length > 0 ? models : [p.model]).map((model) => ({ ...p, model }));
    });
}

export function isAiConfigured(env: Env = process.env): boolean {
  return configuredAiProviders(env).length > 0;
}

/** The names of the keys that would switch the AI on, for "not configured" messages. */
export const AI_KEY_NAMES = 'GEMINI_API_KEY (free), GROQ_API_KEY (free) or ANTHROPIC_API_KEY';

async function callProvider(p: AiProviderSpec, system: string, messages: readonly ChatTurn[], post: Post): Promise<string> {
  if (p.kind === 'anthropic') {
    const res = await post(
      p.url,
      { model: p.model, max_tokens: MAX_TOKENS, system, messages },
      { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: TIMEOUT_MS }
    );
    const content = res.data?.content;
    return Array.isArray(content) ? (content.find((c: any) => c?.type === 'text')?.text ?? '') : '';
  }
  const res = await post(
    p.url,
    { model: p.model, max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: system }, ...messages] },
    { headers: { Authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' }, timeout: TIMEOUT_MS }
  );
  const text = res.data?.choices?.[0]?.message?.content;
  return typeof text === 'string' ? text : '';
}

// Shared across chat, commentary and automatic reviews in this server process.
// One probe per model at a time; provider rate limits apply to the account, not to a page.
const cooldowns = new Map<string, { until: number; strikes: number }>();
const busy = new Set<string>();
const providerKey = (p: AiProviderSpec) => `${p.id}:${p.model}:${createHash('sha256').update(p.apiKey).digest('hex').slice(0, 16)}`;

export class AiUnavailableError extends Error {
  readonly code = 'AI_TEMPORARILY_UNAVAILABLE';
  constructor(public readonly retryAt: number) {
    const time = new Date(retryAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    super(`AI providers are temporarily unavailable or rate-limited. Next automatic availability check after ${time} IST. Saved reviews remain available; pending reviews will retry automatically. A provider quota increase or an available configured provider may be needed if limits persist.`);
  }
}

/** Null means at least one configured model can be tried now. Never returns credentials. */
export function aiRetryAt(env: Env = process.env): number | null {
  const providers = configuredAiProviders(env);
  if (!providers.length) return null;
  const now = Date.now();
  const waits = providers.map((p) => {
    const key = providerKey(p);
    return Math.max(cooldowns.get(key)?.until ?? 0, busy.has(key) ? now + 1000 : 0);
  });
  return waits.some((until) => until <= now) ? null : Math.min(...waits);
}

function retryDelay(err: any, strikes: number): number {
  const now = Date.now();
  const header = err?.response?.headers?.['retry-after'];
  const seconds = Number(header);
  if (header != null && String(header).trim() && Number.isFinite(seconds) && seconds > 0) return Math.max(1000, seconds * 1000);
  const date = typeof header === 'string' ? Date.parse(header) : NaN;
  if (Number.isFinite(date) && date > now) return date - now;
  const error = err?.response?.data?.error;
  for (const detail of Array.isArray(error?.details) ? error.details : []) {
    const delay = /^(\d+(?:\.\d+)?)s$/.exec(detail?.retryDelay ?? '');
    if (delay && Number(delay[1]) > 0) return Math.max(1000, Number(delay[1]) * 1000);
  }
  // A daily quota is not a minute limit. Without a reset hint probe hourly; never invent a reset time.
  const quota = `${error?.code ?? ''} ${error?.type ?? ''} ${error?.message ?? ''} ${JSON.stringify(error?.details ?? [])}`;
  if (/tokens per day|requests per day|\bTPD\b|\bRPD\b|perday|quota_exceeded/i.test(quota)) return 60 * 60_000;
  return Math.min(15 * 60_000, 60_000 * 2 ** Math.min(strikes - 1, 4));
}

/** Try available providers in order; skip cooling models, then probe automatically after the provider's delay. */
export async function askAi(system: string, messages: readonly ChatTurn[], opts: { env?: Env; post?: Post } = {}): Promise<AiReply> {
  const providers = configuredAiProviders(opts.env);
  if (providers.length === 0) throw new Error(`AI not configured: set ${AI_KEY_NAMES} on the backend`);
  const post: Post = opts.post ?? ((url, body, config) => axios.post(url, body, config));
  const failures: string[] = [];
  for (const p of providers) {
    const key = providerKey(p);
    if ((cooldowns.get(key)?.until ?? 0) > Date.now() || busy.has(key)) continue;
    busy.add(key);
    try {
      const text = (await callProvider(p, system, messages, post)).trim();
      if (!text) throw new Error('empty answer');
      cooldowns.delete(key);
      if (failures.length > 0) logger.info({ provider: p.id, model: p.model }, 'AI: answered by a fallback provider');
      return { text, provider: p.id, label: p.label, model: p.model };
    } catch (err: any) {
      const status = Number(err?.response?.status) || null;
      const strikes = (cooldowns.get(key)?.strikes ?? 0) + 1;
      const delay = status === 429 ? retryDelay(err, strikes) : status === 401 || status === 403 || status === 404 ? 15 * 60_000 : 30_000;
      cooldowns.set(key, { until: Date.now() + delay, strikes });
      failures.push(`${p.label}: ${status ? `HTTP ${status}` : 'request unavailable'}`);
      // Provider bodies can contain account IDs, echoed prompts or credentials. Log structured status only.
      logger.warn({ provider: p.id, model: p.model, status, retryAt: Date.now() + delay }, 'AI: provider cooling down, trying available fallback');
    } finally {
      busy.delete(key);
    }
  }
  // Bounded state even after a model/key configuration change.
  if (cooldowns.size > 100) for (const [key, value] of cooldowns) if (value.until < Date.now()) cooldowns.delete(key);
  throw new AiUnavailableError(aiRetryAt(opts.env) ?? Date.now() + 1000);
}
