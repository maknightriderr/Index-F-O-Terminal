// ============================================================
// ANTHROPIC CLIENT
// ============================================================
// Thin wrapper around the Messages API — no SDK dependency, this
// app already uses axios everywhere else for outbound HTTP calls
// (see telegram.ts).
// ============================================================

import axios from 'axios';
import { config } from './config.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;

export function isAnthropicConfigured(): boolean {
  return !!config.anthropic.apiKey;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export async function askClaude(system: string, messages: ChatTurn[]): Promise<string> {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await axios.post(
    ANTHROPIC_API_URL,
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    },
    {
      headers: {
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const content = response.data?.content;
  const text = Array.isArray(content) ? content.find((c: any) => c.type === 'text')?.text : undefined;
  if (!text) throw new Error('Claude returned no text content');
  return text;
}
