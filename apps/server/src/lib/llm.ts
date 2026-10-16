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

const describeError = (err: any): string => {
  const status = err?.response?.status;
  const detail = err?.response?.data?.error?.message ?? err?.message ?? 'unknown error';
  return status ? `HTTP ${status}: ${String(detail).slice(0, 200)}` : String(detail).slice(0, 200);
};

/**
 * Ask the first provider that answers. Throws only when none is configured or every configured one failed;
 * the error names each provider's failure (never a key).
 */
export async function askAi(system: string, messages: readonly ChatTurn[], opts: { env?: Env; post?: Post } = {}): Promise<AiReply> {
  const providers = configuredAiProviders(opts.env);
  if (providers.length === 0) throw new Error(`AI not configured: set ${AI_KEY_NAMES} on the backend`);
  const post: Post = opts.post ?? ((url, body, config) => axios.post(url, body, config));
  const failures: string[] = [];
  for (const p of providers) {
    try {
      const text = (await callProvider(p, system, messages, post)).trim();
      if (!text) throw new Error('empty answer');
      if (failures.length > 0) logger.info({ provider: p.id, model: p.model, after: failures }, 'AI: answered by a fallback provider');
      return { text, provider: p.id, label: p.label, model: p.model };
    } catch (err: any) {
      const why = describeError(err);
      failures.push(`${p.label}: ${why}`);
      logger.warn({ provider: p.id, model: p.model, error: why }, 'AI: provider failed, trying the next one');
    }
  }
  throw new Error(`Every AI provider failed — ${failures.join('; ')}`);
}
