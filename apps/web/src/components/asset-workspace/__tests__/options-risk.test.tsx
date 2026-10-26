import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { OptionChain } from '@fno/shared';
import { OptionsRisk } from '../options-risk';
const leg={ltp:100,iv:25,vega:3,bid:99,ask:101,delta:.5,gamma:.01,theta:-2,oi:1000,volume:500,timestamp:1800000000000,greeksSource:'CALCULATED'};
const chain={symbol:'ABC',expiry:'2026-10-29',dte:3,atmStrike:100,strikes:[{strike:100,call:leg,put:{...leg,vega:4}},{strike:110,call:null,put:null}]} as unknown as OptionChain;
describe('contract-specific IV sensitivity',()=>{
 it('recalculates the selected side and scenario using per-point vega',()=>{
 render(<OptionsRisk chain={chain}/>);expect(screen.getByText('−₹6.00')).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Risk option side'),{target:{value:'put'}});expect(screen.getByText('−₹8.00')).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('IV drop scenario'),{target:{value:'5'}});expect(screen.getByText('−₹20.00')).toBeInTheDocument();
 });
 it('does not substitute another contract for a missing strike leg',()=>{
 render(<OptionsRisk chain={chain}/>);fireEvent.change(screen.getByLabelText('Risk strike'),{target:{value:'110'}});expect(screen.getByText('Selected contract unavailable in the current chain.')).toBeInTheDocument();
 });
 it('does not calculate a scenario from missing IV or Greeks',()=>{
 render(<OptionsRisk chain={{...chain,strikes:[{...chain.strikes[0],call:{...chain.strikes[0].call!,iv:0}}]}}/>);expect(screen.getByText('Unavailable')).toBeInTheDocument();
 });
});
