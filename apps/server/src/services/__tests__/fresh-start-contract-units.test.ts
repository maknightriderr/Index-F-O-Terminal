import {describe,it,expect} from 'vitest';
import type {Instrument} from '@fno/shared';
import {freshRoundTripFees} from '@fno/analytics';
import {freshContractUnits} from '../fresh-start/contract-units.js';
import {freshBookSupportsLot} from '../fresh-start/markets.js';
import {angelMasterUnits} from '../../providers/angel-one/master-units.js';
import {freshExpirySessions} from '../fresh-start/context.js';
import {freshFeePolicyFor} from '../fresh-start/fees.js';
const instrument=(broker=1,premium=100):Instrument=>({token:'gold',name:'GOLD',symbol:'GOLDCE',exchange:'MCX',segment:'FO',instrumentType:'OPTFUT',optionType:'CE',expiry:'2026-11-27',strike:150000,lotSize:premium,tickSize:.5,isFnO:true,contractUnits:{source:'ANGEL_MASTER_PRICE_V1',brokerLotQuantity:broker,premiumUnitsPerLot:premium,quantityVerified:true,tickVerified:true}});
describe('verified broker quantity and premium sizing',()=>{
 it('keeps broker quantity distinct from premium exposure, including fractional multipliers',()=>{expect(freshContractUnits(instrument())).toEqual({lotQuantity:1,multiplier:100,premiumUnitsPerLot:100});expect(freshContractUnits(instrument(100,10))).toEqual({lotQuantity:100,multiplier:.1,premiumUnitsPerLot:10});expect(freshContractUnits(instrument(65,65))).toEqual({lotQuantity:65,multiplier:1,premiumUnitsPerLot:65});});
 it('uses broker units for depth and premium units for money without multiplying brokerage by lot count',()=>{const i=instrument(),u=freshContractUnits(i)!,p=freshFeePolicyFor(i,'2026-10-31')!.policy;expect(freshBookSupportsLot(i,{bidUnits:1,askUnits:1})).toBe(true);expect(freshBookSupportsLot(i,{bidUnits:0,askUnits:100})).toBe(false);expect(freshRoundTripFees(100,110,u.lotQuantity,u.multiplier,p)).toBeCloseTo(63.38282,8);expect(10*(u.lotQuantity*3)*u.multiplier).toBe(3000);});
 it('does not promote raw MCX metadata to verified quantity, even with large books',()=>{const i={...instrument(),...angelMasterUnits('mcx','GOLD','1','50')};expect(freshContractUnits(i)).toBeNull();expect(freshBookSupportsLot(i,{bidUnits:100000,askUnits:100000})).toBe(false);});
 it('rejects mismatched premium metadata, invalid lots, ticks, flags and fractional book quantities',()=>{const rows=[instrument(0),instrument(1.5),instrument(1,0),{...instrument(),lotSize:1},{...instrument(),tickSize:NaN},{...instrument(),exchange:'NSE' as const}];for(const i of rows)expect(freshContractUnits(i)).toBeNull();const i=instrument();i.contractUnits!.tickVerified=false;expect(freshContractUnits(i)).toBeNull();expect(freshBookSupportsLot(instrument(),{bidUnits:1.5,askUnits:2})).toBe(false);});
});
describe('strict exchange expiry calendar qualification',()=>{
 it('rejects normalized invalid dates and nontrading expiry or session dates',()=>{for(const [session,expiry] of [['2026-02-30','2026-03-04'],['2026-02-27','2026-02-30'],['2026-10-30','2026-10-31'],['2026-10-31','2026-11-03']])expect(freshExpirySessions(session,expiry)).toBeNull();});
 it('does not return zero for same-day unknown calendar years',()=>{expect(freshExpirySessions('2027-01-04','2027-01-04')).toBeNull();expect(freshExpirySessions('2026-10-30','2026-10-30')).toBe(0);});
 it('qualifies partial MCX holidays by their own exchange calendar',()=>{expect(freshExpirySessions('2026-10-19','2026-10-20','MCX')).toBe(1);expect(freshExpirySessions('2026-10-19','2026-10-20','NSE')).toBeNull();});
});
