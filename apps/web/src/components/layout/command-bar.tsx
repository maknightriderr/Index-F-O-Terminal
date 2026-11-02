'use client';

// ============================================================
// COMMAND BAR — "NIFTY OC <Enter>", on every page (top bar)
// ============================================================
// "/" focuses it from anywhere (unless typing in another field), Esc leaves it. A symbol command opens the
// Workspace on that underlying with the named panel in focus; a page code opens the page (lib/commands.ts).
// ============================================================

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMarketStore, useWorkspaceStore } from '@/stores';
import { PAGE_CODES, parseCommand, SYMBOL_FUNCTIONS } from '@/lib/commands';

const EXAMPLES = ['NIFTY OC', 'BANKNIFTY CH', 'SENSEX QT', 'CRUDEOIL CH', 'RADAR NIFTY', 'TRADES', 'HEALTH'];

export function CommandBar() {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  const openWorkspace = useWorkspaceStore((s) => s.open);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Suggestions: page codes and functions whose code or name starts with what was typed.
  const hints = useMemo(() => {
    const q = value.trim().toUpperCase();
    const all = [
      ...Object.entries(SYMBOL_FUNCTIONS).map(([code, f]) => ({ code: `<SYMBOL> ${code}`, label: f.label })),
      ...Object.entries(PAGE_CODES).map(([code, p]) => ({ code, label: p.label })),
    ];
    const last = q.split(/\s+/).at(-1) ?? '';
    return q ? all.filter((h) => h.code.split(' ').at(-1)!.startsWith(last) || h.label.toUpperCase().startsWith(last)).slice(0, 8) : all.slice(0, 8);
  }, [value]);

  const run = (text: string) => {
    const cmd = parseCommand(text);
    if (cmd.kind === 'error') {
      setMessage(cmd.message);
      return;
    }
    setMessage(null);
    setValue('');
    setOpen(false);
    input.current?.blur();
    if (cmd.kind === 'page') setActiveTab(cmd.tab);
    else {
      openWorkspace(cmd.symbol, cmd.exchange, cmd.focus);
      setActiveTab('workspace');
    }
  };

  return (
    <div className="ws-cmd" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <form
        role="search"
        className="ws-cmd-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(value);
        }}
      >
        <span className="ws-cmd-prompt" aria-hidden="true">&gt;</span>
        <label htmlFor={`${listId}-input`} className="sr-only">Command</label>
        <input
          ref={input}
          id={`${listId}-input`}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setMessage(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              input.current?.blur();
            }
          }}
          placeholder="NIFTY OC · BANKNIFTY CH · TRADES"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${listId}-help`}
          aria-controls={open ? `${listId}-list` : undefined}
          className="ws-cmd-input"
        />
        <kbd className="ws-cmd-kbd" aria-hidden="true">/</kbd>
        <button type="submit" className="ws-cmd-go">GO</button>
      </form>
      <p id={`${listId}-help`} className="sr-only">Type a symbol and a function, for example NIFTY OC, or a page code such as TRADES, then press Enter.</p>
      {message && <p role="alert" className="ws-cmd-msg">{message}</p>}
      {open && !message && (
        <div id={`${listId}-list`} className="ws-cmd-pop">
          <div className="ws-cmd-pop-head">Functions and pages</div>
          <ul>
            {hints.map((h) => (
              <li key={h.code}>
                <button
                  type="button"
                  onClick={() => {
                    if (h.code.startsWith('<SYMBOL>')) {
                      const fn = h.code.split(' ')[1];
                      const sym = value.trim().toUpperCase().split(/\s+/)[0];
                      if (sym && !SYMBOL_FUNCTIONS[sym] && !PAGE_CODES[sym]) run(`${sym} ${fn}`);
                      else {
                        setValue(`NIFTY ${fn}`);
                        input.current?.focus();
                      }
                    } else run(h.code);
                  }}
                >
                  <span className="cc-num">{h.code}</span>
                  <span>{h.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="ws-cmd-pop-foot">Examples: {EXAMPLES.join(' · ')}</div>
        </div>
      )}
    </div>
  );
}
