'use client';

import { create } from 'zustand';
import { api, ApiError, type DailyReviewView, type ExplainTarget } from '@/lib/api';

// ============================================================
// AI ASSISTANT — one floating panel for every AI answer (2026-10-16)
// ============================================================
// The assistant used to be its own page. It now lives in a panel opened from
// the bottom-right button on every page, and the "Why this trade?" buttons
// open the same panel with their explanation, so there is one place for
// everything the AI says. The AI only explains and summarises: it never
// places, picks or changes a trade.
// ============================================================

export interface AssistantMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** Which AI provider answered (Gemini, Groq or Claude). */
  via?: string;
  error?: boolean;
  /** Not sent back to the model as chat history (explanations and reviews stand alone). */
  standalone?: boolean;
}

interface AssistantState {
  open: boolean;
  loading: boolean;
  notConfigured: boolean;
  messages: AssistantMessage[];
  openPanel: () => void;
  closePanel: () => void;
  toggle: () => void;
  clear: () => void;
  ask: (text: string) => Promise<void>;
  explain: (target: ExplainTarget, question: string) => Promise<void>;
  showLatestReview: () => Promise<void>;
}

let nextId = 1;
const MAX_HISTORY = 20;

/** An old bookmark to the assistant page (?page=ai-assistant) opens the panel instead. */
const openedFromUrl = () => {
  try {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('page') === 'ai-assistant';
  } catch {
    return false;
  }
};

const GROUP_LABEL: Record<DailyReviewView['group'], string> = { NSE_BSE: 'NSE/BSE', MCX: 'MCX' };

/** Pure: a stored review as one readable message. */
export function reviewText(r: DailyReviewView): string {
  const day = new Date(`${r.date}T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
  return [`${GROUP_LABEL[r.group]} session review · ${day}`, ...r.lines, '', r.summary ?? 'AI note unavailable for this session; the numbers above are complete.'].join('\n');
}

export const useAssistantStore = create<AssistantState>((set, get) => {
  const push = (m: Omit<AssistantMessage, 'id'>) => set((s) => ({ messages: [...s.messages, { ...m, id: nextId++ }] }));
  const fail = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.code === 'AI_NOT_CONFIGURED') {
      set({ notConfigured: true });
      return;
    }
    push({ role: 'assistant', content: err instanceof ApiError ? err.message : fallback, error: true, standalone: true });
  };
  const run = async (work: () => Promise<void>) => {
    set({ loading: true });
    try {
      await work();
    } finally {
      set({ loading: false });
    }
  };

  return {
    open: openedFromUrl(),
    loading: false,
    notConfigured: false,
    messages: [],
    openPanel: () => set({ open: true }),
    closePanel: () => set({ open: false }),
    toggle: () => set((s) => ({ open: !s.open })),
    clear: () => set({ messages: [] }),

    ask: async (text) => {
      const trimmed = text.trim();
      if (!trimmed || get().loading) return;
      const history = get()
        .messages.filter((m) => !m.error && !m.standalone)
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content }));
      push({ role: 'user', content: trimmed });
      await run(async () => {
        try {
          const { reply, via } = await api.chatWithAssistant(trimmed, history);
          push({ role: 'assistant', content: reply, via });
        } catch (err) {
          fail(err, 'Something went wrong reaching the assistant.');
        }
      });
    },

    explain: async (target, question) => {
      if (get().loading) return;
      set({ open: true });
      push({ role: 'user', content: question, standalone: true });
      await run(async () => {
        try {
          const r = await api.explainDecision(target);
          push({ role: 'assistant', content: `${r.subject}\n${r.text}`, via: r.via, standalone: true });
        } catch (err) {
          fail(err, 'Could not explain this decision right now.');
        }
      });
    },

    showLatestReview: async () => {
      if (get().loading) return;
      push({ role: 'user', content: 'Show the latest session review', standalone: true });
      await run(async () => {
        try {
          const { reviews } = await api.getDailyReviews();
          if (reviews.length === 0) {
            push({ role: 'assistant', content: 'No session review yet. One is written about 20 minutes after the NSE close and after the MCX close, and sent to Telegram.', standalone: true });
            return;
          }
          push({ role: 'assistant', content: reviewText(reviews[0]), via: reviews[0].via ?? undefined, standalone: true });
        } catch (err) {
          fail(err, 'Could not load the session review.');
        }
      });
    },
  };
});
