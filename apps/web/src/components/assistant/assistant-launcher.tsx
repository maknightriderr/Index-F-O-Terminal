'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useAssistantStore } from './assistant-store';

const STARTER_PROMPTS = ["What's the overall market bias right now?", 'Any unusual OI activity today?', 'What are the recent alerts about?'];

function SparkIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />
      <path d="M12 6.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * The AI assistant, available on every page from the bottom-right button: a side panel on wide screens, a full-screen
 * sheet on phones. "Why this trade?" buttons elsewhere open it with their explanation (assistant-store.ts).
 */
export function AssistantLauncher() {
  const { open, loading, notConfigured, messages, toggle, closePanel, clear, ask, showLatestReview } = useAssistantStore();
  const [input, setInput] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);

  // Focus moves into the panel when it opens and back to the button when it closes.
  useEffect(() => {
    if (open && !wasOpen.current) inputRef.current?.focus();
    if (!open && wasOpen.current) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
  }, [messages, loading, open]);

  const send = (text: string) => {
    if (!text.trim()) return;
    setInput('');
    void ask(text);
  };

  return (
    <>
      {open && (
        <section
          id="ai-assistant-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="ai-assistant-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closePanel();
          }}
          className="fixed inset-0 z-50 flex flex-col bg-[var(--bg-elevated)] text-[var(--text-primary)] pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] sm:inset-auto sm:bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] sm:right-[max(1rem,env(safe-area-inset-right,0px))] sm:h-[min(640px,calc(100dvh-7rem))] sm:w-[400px] sm:rounded-xl sm:border sm:border-[var(--border-primary)] sm:pt-0 sm:pb-0 sm:shadow-2xl"
        >
          <header className="flex items-start gap-3 border-b border-[var(--border-primary)] px-4 py-3">
            <span className="mt-0.5 text-[var(--accent-indigo)]">
              <SparkIcon />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="ai-assistant-title" className="text-sm font-semibold">
                AI assistant
              </h2>
              <p className="text-xs text-[var(--text-secondary)]">Explains and summarises your data. It never places or changes a trade.</p>
            </div>
            {messages.length > 0 && (
              <button type="button" onClick={clear} className="rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-card-alt)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
                Clear
              </button>
            )}
            <button type="button" onClick={closePanel} aria-label="Close AI assistant" className="rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-card-alt)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
              <CloseIcon />
            </button>
          </header>

          {notConfigured && (
            <p role="status" className="mx-4 mt-3 rounded-md border border-[var(--status-warn)]/40 bg-[var(--status-warn)]/10 px-3 py-2 text-xs">
              AI is not configured. Add <code className="font-mono">GEMINI_API_KEY</code> or <code className="font-mono">GROQ_API_KEY</code> (both free) to the backend in Railway.
            </p>
          )}

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
            {messages.length === 0 && !notConfigured && (
              <div className="space-y-3 py-2">
                <p className="text-sm text-[var(--text-secondary)]">Ask about today&apos;s market or your paper trades, or tap “Why?” on any trade for a plain-English reason.</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void showLatestReview()} className="rounded-full border border-[var(--accent-indigo)] bg-[var(--accent-indigo)]/15 px-3 py-1.5 text-xs font-medium hover:bg-[var(--accent-indigo)]/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
                    Latest session review
                  </button>
                  {STARTER_PROMPTS.map((p) => (
                    <button key={p} type="button" onClick={() => send(p)} className="rounded-full border border-[var(--border-primary)] px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-card-alt)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-[var(--accent-indigo)]/20 text-[var(--text-primary)]'
                      : m.error
                        ? 'border border-[var(--status-bad)]/40 bg-[var(--status-bad)]/10 text-[var(--text-primary)]'
                        : 'bg-[var(--surface-card-alt)] text-[var(--text-primary)]'
                  }`}
                >
                  {m.content}
                  {m.via && <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">via {m.via}</div>}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start" role="status" aria-label="The assistant is answering">
                <div className="flex items-center gap-1.5 rounded-2xl bg-[var(--surface-card-alt)] px-3.5 py-2.5 text-[var(--text-secondary)]">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s] motion-reduce:animate-none" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s] motion-reduce:animate-none" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="border-t border-[var(--border-primary)] px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <label htmlFor="ai-assistant-input" className="sr-only">
                Ask the AI assistant
              </label>
              <input
                id="ai-assistant-input"
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={notConfigured ? 'AI is not configured' : 'Ask about the market or your trades…'}
                disabled={notConfigured || loading}
                autoComplete="off"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-sm placeholder:text-[var(--text-muted)] focus:border-[var(--accent-indigo)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-indigo)] disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={notConfigured || loading || !input.trim()}
                className="rounded-lg bg-[var(--accent-indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              >
                Send
              </button>
            </div>
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">Answers come from free AI models and can be wrong. Not investment advice.</p>
          </form>
        </section>
      )}

      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label={open ? 'Close AI assistant' : 'Open AI assistant'}
        aria-expanded={open}
        aria-controls="ai-assistant-panel"
        title={open ? 'Close AI assistant' : 'AI assistant'}
        className={`fixed bottom-[max(1rem,env(safe-area-inset-bottom,0px))] right-[max(1rem,env(safe-area-inset-right,0px))] z-50 h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-indigo)] text-white shadow-lg transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] motion-reduce:transition-none motion-reduce:hover:scale-100 ${open ? 'hidden sm:flex' : 'flex'}`}
      >
        {open ? <CloseIcon /> : <SparkIcon className="h-6 w-6" />}
      </button>
    </>
  );
}

/** A small "Why?" button that opens the assistant with an explanation of one decision. */
export function ExplainButton({ target, question, label = 'Why?', className = '' }: { target: Parameters<ReturnType<typeof useAssistantStore.getState>['explain']>[0]; question: string; label?: string; className?: string }) {
  const explain = useAssistantStore((s) => s.explain);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void explain(target, question);
      }}
      title="Explain this decision in plain English (AI)"
      className={`inline-flex items-center gap-1 rounded-md border border-[var(--border-primary)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:border-[var(--accent-indigo)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] ${className}`}
    >
      <SparkIcon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
