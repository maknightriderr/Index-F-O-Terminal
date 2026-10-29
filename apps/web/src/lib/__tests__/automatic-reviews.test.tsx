// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
const get=vi.hoisted(()=>vi.fn());
vi.mock('../api',()=>({api:{getAutomaticTradeReviews:get}}));
import { AutomaticTradeReviews } from '../../components/paper-trades/automatic-reviews';
const report=(complete=1)=>({available:true,enabled:true,aiConfigured:true,version:'AUTO-REVIEW-1.0',scope:'Sample scope',counts:{COMPLETE:complete,PENDING:2,RETRY:1},recent:[],repeated:[]});
beforeEach(()=>{vi.useFakeTimers();get.mockReset();get.mockResolvedValue(report());});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('loads and refreshes automatically without a review or retry button',async()=>{
  const {unmount}=render(<AutomaticTradeReviews/>);
  await act(async()=>{});expect(get).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button',{name:/run review|retry/i})).toBeNull();
  get.mockResolvedValue(report(2));await act(async()=>{vi.advanceTimersByTime(60000);});expect(get).toHaveBeenCalledTimes(2);
  unmount();await act(async()=>{vi.advanceTimersByTime(60000);});expect(get).toHaveBeenCalledTimes(2);
});
it('recovers from a failed status request automatically',async()=>{
  get.mockRejectedValueOnce(new Error('unavailable'));
  render(<AutomaticTradeReviews/>);await act(async()=>{});
  expect(screen.getByText('Review status unavailable')).toBeTruthy();
  await act(async()=>{vi.advanceTimersByTime(60000);});
  expect(screen.queryByText('Review status unavailable')).toBeNull();
  expect(screen.getByText(/AI configured/)).toBeTruthy();
});
it('reports missing storage without pretending that reviews succeeded',async()=>{
  get.mockResolvedValue({...report(),available:false});render(<AutomaticTradeReviews/>);await act(async()=>{});
  expect(screen.getByText(/storage is not ready/)).toBeTruthy();expect(screen.queryByText('Reviewed')).toBeNull();
});
