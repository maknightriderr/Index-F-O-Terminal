import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

let askAi: typeof import('../llm.js').askAi;
let configuredAiProviders: typeof import('../llm.js').configuredAiProviders;
let isAiConfigured: typeof import('../llm.js').isAiConfigured;
beforeEach(async () => { vi.resetModules(); ({ askAi, configuredAiProviders, isAiConfigured } = await import('../llm.js')); });
afterEach(() => vi.useRealTimers());

const ok = (text: string) => ({ data: { choices: [{ message: { content: text } }] } });
const httpError = (status: number, message: string) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { message } } } });

describe('AI provider chain (read-only features only)', () => {
  it('orders Gemini, Groq, Claude by default and skips any provider without a key', () => {
    expect(configuredAiProviders({}).map((p) => p.id)).toEqual([]);
    expect(isAiConfigured({})).toBe(false);
    expect(configuredAiProviders({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm' }).map((p) => p.id)).toEqual(['gemini', 'groq']);
    expect(configuredAiProviders({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'm' }).map((p) => p.id)).toEqual(['gemini', 'anthropic']);
    expect(configuredAiProviders({ GEMINI_API_KEY: '  ' })).toEqual([]);
  });

  it('honours AI_PROVIDERS, ignoring unknown names and duplicates', () => {
    const env = { AI_PROVIDERS: 'groq, nonsense, GEMINI, groq', GEMINI_API_KEY: 'm', GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
    expect(configuredAiProviders(env).map((p) => p.id)).toEqual(['groq', 'gemini']);
  });

  it('uses the default models unless overridden', () => {
    const [gem, groq] = configuredAiProviders({ GEMINI_API_KEY: 'm', GROQ_API_KEY: 'g', GROQ_MODEL: 'qwen/qwen3-32b' });
    expect(gem.model).toBe('gemini-flash-latest');
    expect(groq.model).toBe('qwen/qwen3-32b');
  });

  it('tries each listed model of a provider before the next provider', async () => {
    const env = { GEMINI_API_KEY: 'm', GROQ_API_KEY: 'g', GEMINI_MODEL: 'gemini-flash-latest, gemini-2.5-flash,gemini-flash-latest' };
    expect(configuredAiProviders(env).map((p) => `${p.id}:${p.model}`)).toEqual(['gemini:gemini-flash-latest', 'gemini:gemini-2.5-flash', 'groq:openai/gpt-oss-120b']);
    const post = vi
      .fn()
      .mockRejectedValueOnce(httpError(503, 'This model is currently experiencing high demand.'))
      .mockResolvedValueOnce(ok('From the older Flash.'));
    const r = await askAi('S', [{ role: 'user', content: 'q' }], { env, post });
    expect(r).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash', text: 'From the older Flash.' });
    expect(post.mock.calls.map((c) => c[1].model)).toEqual(['gemini-flash-latest', 'gemini-2.5-flash']);
  });

  it('sends an OpenAI-style request to Gemini with the system prompt first and a bearer key', async () => {
    const post = vi.fn().mockResolvedValue(ok('NIFTY is flat.'));
    const r = await askAi('SYSTEM', [{ role: 'user', content: 'How is NIFTY?' }], { env: { GEMINI_API_KEY: 'key-1' }, post });
    expect(r).toEqual({ text: 'NIFTY is flat.', provider: 'gemini', label: 'Gemini', model: 'gemini-flash-latest' });
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'How is NIFTY?' });
    expect(config.headers.Authorization).toBe('Bearer key-1');
  });

  it('falls back to Groq when Gemini is rate-limited, and to Claude when Groq returns nothing', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(httpError(429, 'quota exceeded'))
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '   ' } }] } })
      .mockResolvedValueOnce({ data: { content: [{ type: 'text', text: 'From Claude.' }] } });
    const r = await askAi('S', [{ role: 'user', content: 'q' }], { env: { GEMINI_API_KEY: 'm', GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, post });
    expect(r.provider).toBe('anthropic');
    expect(r.text).toBe('From Claude.');
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      'https://api.groq.com/openai/v1/chat/completions',
      'https://api.anthropic.com/v1/messages',
    ]);
    expect(post.mock.calls[2][2].headers['x-api-key']).toBe('a');
  });

  it('returns a safe timed availability message when all providers fail', async () => {
    const post = vi.fn().mockRejectedValueOnce(httpError(429, 'quota exceeded')).mockRejectedValueOnce(httpError(404, 'model not found'));
    const err = await askAi('S', [{ role: 'user', content: 'q' }], { env: { GEMINI_API_KEY: 'secret-gem', GROQ_API_KEY: 'secret-groq' }, post }).catch((e) => e);
    expect(err.message).toContain('temporarily unavailable or rate-limited');
    expect(err.code).toBe('AI_TEMPORARILY_UNAVAILABLE');
    expect(err.retryAt).toBeGreaterThan(Date.now());
    expect(err.message).not.toContain('secret-');
  });

  it('refuses plainly when no key is set', async () => {
    await expect(askAi('S', [], { env: {} })).rejects.toThrow(/AI not configured: set GEMINI_API_KEY/);
  });
});


describe('shared provider cooldown and recovery', () => {
  const env = { GEMINI_API_KEY: 'm', GROQ_API_KEY: 'g' };
  it('honours Retry-After across callers, uses an available fallback, and automatically probes after expiry', async () => {
    vi.useFakeTimers();
    const limited = httpError(429, 'account-private-data');
    Object.assign(limited.response, { headers: { 'retry-after': '120' } });
    const post = vi.fn().mockRejectedValueOnce(limited).mockResolvedValue(ok('fallback'));
    await askAi('first', [], { env, post });
    await askAi('second', [], { env, post });
    expect(post.mock.calls.map(c => c[1].model)).toEqual(['gemini-flash-latest', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
    await vi.advanceTimersByTimeAsync(120000);
    await askAi('third', [], { env, post });
    expect(post.mock.calls[3][1].model).toBe('gemini-flash-latest');
  });
  it('does not hammer exhausted providers; daily token quota waits longer than a minute', async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockRejectedValue(httpError(429, 'Tokens per day (TPD): Limit 200000; secret account'));
    const only = { GROQ_API_KEY: 'g' };
    const error = await askAi('S', [], { env: only, post }).catch(e => e);
    expect(error.retryAt - Date.now()).toBe(3600000);
    await askAi('S', [], { env: only, post }).catch(() => undefined);
    expect(post).toHaveBeenCalledTimes(1);
    expect(error.message).not.toContain('secret account');
    await vi.advanceTimersByTimeAsync(3600000);
    post.mockResolvedValueOnce(ok('recovered'));
    expect((await askAi('S', [], { env: only, post })).text).toBe('recovered');
  });
  it('serializes probes of a model so concurrent features cannot stampede it', async () => {
    let release!: (value: any) => void;
    const post = vi.fn().mockImplementationOnce(() => new Promise(r => { release = r; }));
    const first = askAi('S', [], { env: { GROQ_API_KEY: 'g' }, post });
    const second = await askAi('S', [], { env: { GROQ_API_KEY: 'g' }, post }).catch(e => e);
    expect(second.code).toBe('AI_TEMPORARILY_UNAVAILABLE');
    expect(post).toHaveBeenCalledTimes(1);
    release(ok('done')); await first;
  });
  it('respects Gemini RetryInfo and HTTP-date Retry-After; key changes do not inherit old cooldown', async () => {
    vi.useFakeTimers();
    const error = httpError(429, 'rate limit');
    Object.assign(error.response.data.error, { details: [{ retryDelay: '42s' }] });
    const post = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(ok('new key'));
    const first = await askAi('S', [], { env: { GEMINI_API_KEY: 'old' }, post }).catch(e => e);
    expect(first.retryAt - Date.now()).toBe(42000);
    await askAi('S', [], { env: { GEMINI_API_KEY: 'new' }, post });
    const dated = httpError(429, 'rate limit');
    Object.assign(dated.response, { headers: { 'retry-after': new Date(Date.now() + 180000).toUTCString() } });
    post.mockRejectedValueOnce(dated);
    const next = await askAi('S', [], { env: { GROQ_API_KEY: 'g' }, post }).catch(e => e);
    expect(next.retryAt - Date.now()).toBeGreaterThan(179000);
  });
});
