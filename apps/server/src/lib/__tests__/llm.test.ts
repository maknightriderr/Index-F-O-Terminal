import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { askAi, configuredAiProviders, isAiConfigured } = await import('../llm.js');

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

  it('names every failure, and never a key, when all providers fail', async () => {
    const post = vi.fn().mockRejectedValueOnce(httpError(429, 'quota exceeded')).mockRejectedValueOnce(httpError(404, 'model not found'));
    const err = await askAi('S', [{ role: 'user', content: 'q' }], { env: { GEMINI_API_KEY: 'secret-gem', GROQ_API_KEY: 'secret-groq' }, post }).catch((e) => e);
    expect(err.message).toContain('Gemini: HTTP 429: quota exceeded');
    expect(err.message).toContain('Groq: HTTP 404: model not found');
    expect(err.message).not.toContain('secret-');
  });

  it('refuses plainly when no key is set', async () => {
    await expect(askAi('S', [], { env: {} })).rejects.toThrow(/AI not configured: set GEMINI_API_KEY/);
  });
});
