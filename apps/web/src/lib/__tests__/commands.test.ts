import { describe, expect, it } from 'vitest';
import { exchangeFor, parseCommand, PAGE_CODES, WORKSPACE_PRESETS } from '../commands';
import { resolveTab } from '../nav';

describe('command bar parser', () => {
  it('opens the workspace on a symbol, with the named panel in focus', () => {
    expect(parseCommand('nifty')).toEqual({ kind: 'workspace', symbol: 'NIFTY', exchange: 'NSE', focus: 'chart' });
    expect(parseCommand(' BANKNIFTY  OC ')).toEqual({ kind: 'workspace', symbol: 'BANKNIFTY', exchange: 'NSE', focus: 'chain' });
    expect(parseCommand('OC SENSEX')).toEqual({ kind: 'workspace', symbol: 'SENSEX', exchange: 'BSE', focus: 'chain' });
    expect(parseCommand('crudeoil ch')).toMatchObject({ exchange: 'MCX', focus: 'chart' });
    expect(parseCommand('M&M QT')).toMatchObject({ symbol: 'M&M', exchange: 'NSE', focus: 'quote' });
  });
  it('opens pages by code', () => {
    expect(parseCommand('trades')).toEqual({ kind: 'page', tab: 'paper-trades' });
    expect(parseCommand('HEALTH')).toEqual({ kind: 'page', tab: 'system-health' });
    for (const { tab } of Object.values(PAGE_CODES)) expect(resolveTab(tab).tab).toBe(tab);
  });
  it('explains what it cannot run', () => {
    expect(parseCommand('').kind).toBe('error');
    expect(parseCommand('NIFTY XYZ')).toMatchObject({ kind: 'error' });
    expect(parseCommand('NIFTY OC NOW')).toMatchObject({ kind: 'error' });
    expect(parseCommand('12AB')).toMatchObject({ kind: 'error' });
  });
  it('maps exchanges and presets', () => {
    expect(exchangeFor('BANKEX')).toBe('BSE');
    expect(exchangeFor('NATGASMINI')).toBe('MCX');
    expect(exchangeFor('RELIANCE')).toBe('NSE');
    expect(WORKSPACE_PRESETS.map((p) => p.key)).toEqual(['1', '2', '3', '4']);
  });
});
