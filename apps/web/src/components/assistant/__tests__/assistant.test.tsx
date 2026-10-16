import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NAV_GROUPS, resolveTab } from '@/lib/nav';

// Plain functions, not vi.fn(): a rejected promise from a reset spy surfaced as an unhandled error (evidence-page test).
let explainImpl: (t: unknown) => Promise<unknown> = async () => ({ subject: 'NIFTY 23100 CE (bullish)', text: '• It was bullish.', via: 'Groq', model: 'm' });
let reviewsImpl: () => Promise<unknown> = async () => ({ reviews: [] });
const explainCalls: unknown[] = [];
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      explainDecision: (t: unknown) => (explainCalls.push(t), explainImpl(t)),
      getDailyReviews: () => reviewsImpl(),
      chatWithAssistant: async () => ({ reply: 'Markets are mixed.', via: 'Gemini' }),
    },
  };
});

const { AssistantLauncher, ExplainButton } = await import('../assistant-launcher');
const { useAssistantStore, reviewText } = await import('../assistant-store');
const { ApiError } = await import('@/lib/api');

beforeEach(() => {
  useAssistantStore.setState({ open: false, loading: false, notConfigured: false, messages: [] });
  explainCalls.length = 0;
  explainImpl = async () => ({ subject: 'NIFTY 23100 CE (bullish)', text: '• It was bullish.', via: 'Groq', model: 'm' });
  reviewsImpl = async () => ({ reviews: [] });
});

describe('floating AI assistant', () => {
  it('opens from the bottom-right button, closes with Escape, and gives focus back to the button', async () => {
    render(<AssistantLauncher />);
    const button = screen.getByRole('button', { name: 'Open AI assistant' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'AI assistant' });
    expect(screen.getByLabelText('Ask the AI assistant')).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open AI assistant' })).toHaveFocus();
  });

  it('answers a question and names the provider', async () => {
    render(<AssistantLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Open AI assistant' }));
    fireEvent.change(screen.getByLabelText('Ask the AI assistant'), { target: { value: 'How is the market?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Markets are mixed.')).toBeInTheDocument();
    expect(screen.getByText('via Gemini')).toBeInTheDocument();
  });

  it('"Why?" opens the panel with the question, the plain-English answer and its provider', async () => {
    render(
      <>
        <ExplainButton target={{ kind: 'trade', id: 'abc' }} question="Why this trade? NIFTY 23100 CE" />
        <AssistantLauncher />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(await screen.findByRole('dialog', { name: 'AI assistant' })).toBeInTheDocument();
    expect(screen.getByText('Why this trade? NIFTY 23100 CE')).toBeInTheDocument();
    expect(await screen.findByText(/It was bullish/)).toBeInTheDocument();
    expect(screen.getByText('via Groq')).toBeInTheDocument();
    expect(explainCalls).toEqual([{ kind: 'trade', id: 'abc' }]);
  });

  it('says how to switch the AI on when no key is set', async () => {
    explainImpl = () => Promise.reject(new ApiError('No AI key', 'AI_NOT_CONFIGURED', 503));
    render(
      <>
        <ExplainButton target={{ kind: 'trade', id: 'abc' }} question="Why this trade?" />
        <AssistantLauncher />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(await screen.findByText(/AI is not configured/)).toBeInTheDocument();
    expect(screen.getByLabelText('Ask the AI assistant')).toBeDisabled();
  });

  it('shows the latest session review with its numbers and the AI note', async () => {
    reviewsImpl = async () => ({
      reviews: [{ group: 'NSE_BSE', date: '2026-10-16', createdAt: 1, lines: ['Minted today: 24 · Closed today: 18 (win 12 · loss 2 · expired 4)'], summary: 'A positive session after costs.', via: 'Gemini' }],
    });
    render(<AssistantLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'Open AI assistant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Latest session review' }));
    expect(await screen.findByText(/NSE\/BSE session review/)).toBeInTheDocument();
    expect(screen.getByText(/A positive session after costs\./)).toBeInTheDocument();
  });

  it('formats a review without an AI note as complete numbers', () => {
    const text = reviewText({ group: 'MCX', date: '2026-10-16', createdAt: 1, lines: ['Still open: 2'], summary: null, via: null });
    expect(text).toContain('MCX session review');
    expect(text).toContain('AI note unavailable');
  });

  it('is no longer a page: the sidebar has no AI Assistant entry and an old link lands on the dashboard', () => {
    expect(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))).not.toContain('ai-assistant');
    expect(resolveTab('ai-assistant')).toEqual({ tab: 'dashboard' });
  });
});
