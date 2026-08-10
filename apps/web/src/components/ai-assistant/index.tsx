'use client';

import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

const STARTER_PROMPTS = [
  "What's the overall market bias right now?",
  'Any unusual OI activity today?',
  'Which stocks have the richest IV right now?',
  'What are the recent alerts about?',
];

export function AiAssistantPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const nextMessages: Message[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const history = nextMessages
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content }));
      const { reply } = await api.chatWithAssistant(trimmed, history.slice(0, -1));
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AI_NOT_CONFIGURED') {
        setNotConfigured(true);
      } else {
        const msg = err instanceof ApiError ? err.message : 'Something went wrong reaching the assistant.';
        setMessages((prev) => [...prev, { role: 'assistant', content: msg, error: true }]);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 flex flex-col h-full min-h-0">
      <div className="mb-3">
        <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">AI Assistant</h1>
        <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
          Grounded in a live snapshot of indices, the F&O universe scan, and recent alerts — ask about current conditions,
          signals, or strategies. Not investment advice.
        </p>
      </div>

      {notConfigured && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-amber-400 light:text-amber-700 text-xs font-medium mb-3">
          ⚠️ AI Assistant isn't configured yet — the backend needs an <code className="font-mono">ANTHROPIC_API_KEY</code> set.
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] p-4 space-y-3"
      >
        {messages.length === 0 && !notConfigured && (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-center py-8">
            <div className="text-4xl opacity-70">🤖</div>
            <p className="text-sm text-gray-500 light:text-slate-500 max-w-sm">
              Ask about current market conditions, unusual OI/IV activity, or which stocks have a Strategy Scanner setup.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 max-w-lg">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-gray-900/60 light:bg-slate-100 border border-gray-800/60 light:border-slate-200 text-gray-400 light:text-slate-600 hover:bg-gray-800 light:hover:bg-slate-200 hover:text-gray-200 light:hover:text-slate-800 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-emerald-500 text-black font-medium'
                  : m.error
                  ? 'bg-red-500/10 text-red-400 light:text-red-700 border border-red-500/20'
                  : 'bg-gray-800/60 light:bg-slate-100 text-gray-200 light:text-slate-800'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-2.5 bg-gray-800/60 light:bg-slate-100 text-gray-500 light:text-slate-400 text-sm flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-center gap-2 mt-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={notConfigured ? 'AI Assistant not configured' : 'Ask about market conditions, signals, or strategies…'}
          disabled={notConfigured || loading}
          className="flex-1 bg-gray-900/70 light:bg-slate-50 border border-gray-700/60 light:border-slate-200 rounded-lg px-4 py-2.5 text-sm text-gray-200 light:text-slate-800 placeholder-gray-600 light:placeholder-slate-400 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-colors disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={notConfigured || loading || !input.trim()}
          className="px-5 py-2.5 rounded-lg text-sm font-semibold bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </form>
    </div>
  );
}
