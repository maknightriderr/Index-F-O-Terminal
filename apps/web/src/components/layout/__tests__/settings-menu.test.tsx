import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsMenu } from '../settings-menu';
import { useUISettingsStore } from '@/stores';

beforeEach(() => useUISettingsStore.setState({ theme: 'dark', showTicker: false }));
describe('header settings menu', () => {
  it('switches theme (light kept) and toggles the ticker, which is off by default', () => {
    render(<SettingsMenu />);
    expect(useUISettingsStore.getState().showTicker).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Light theme' }));
    expect(useUISettingsStore.getState().theme).toBe('light');
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'System theme' }));
    expect(useUISettingsStore.getState().theme).toBe('system');
    fireEvent.click(screen.getByRole('checkbox', { name: /Index ticker/ }));
    expect(useUISettingsStore.getState().showTicker).toBe(true);
  });
});
