import {describe,it,expect} from 'vitest';
import type {Instrument} from '@fno/shared';
import {resolveFreshMcxLink} from '../fresh-start/mcx-contracts.js';
import {FRESH_MCX_PRODUCTS} from '../fresh-start/markets.js';
import {freshFeePolicyFor} from '../fresh-start/fees.js';
const future=(name:string,o:Partial<Instrument>={}):Instrument=>({token:'fut',symbol:name+'FUT',name,exchange:'MCX',segment:'FO',instrumentType:'FUTCOM',expiry:'2026-11-19',lotSize:10,tickSize:1,isFnO:true,...o});
const option=(name:string,o:Partial<Instrument>={}):Instrument=>future(name,{token:'opt',symbol:name+'CE',instrumentType:'OPTFUT',optionType:'CE',strike:5900,expiry:'2026-11-17',tickSize:.05,...o});
describe('1.5 MCX mini energy options',()=>{
 it('are discoverable products with the non-agri fee policy',()=>{
   expect(FRESH_MCX_PRODUCTS).toEqual(expect.arrayContaining(['CRUDEOILM','NATGASMINI']));
   for(const name of ['CRUDEOILM','NATGASMINI'])expect(freshFeePolicyFor({exchange:'MCX',segment:'FO',instrumentType:'OPTFUT',name},'2026-11-02')).not.toBeNull();
 });
 it('link an option to the exact mini future two MCX business days later',()=>{
   expect(resolveFreshMcxLink(option('CRUDEOILM'),[future('CRUDEOILM')])).toMatchObject({futureToken:'fut',futureExpiry:'2026-11-19',specification:'MCX_CRUDEOILM_OPTIONS',rule:'TWO_MCX_BUSINESS_DAYS_BEFORE_FUTURE_EXPIRY'});
   expect(resolveFreshMcxLink(option('NATGASMINI',{tickSize:.1,lotSize:250}),[future('NATGASMINI',{lotSize:250})])).toMatchObject({specification:'MCX_NATGASMINI_OPTIONS'});
 });
 it('fail closed on a wrong expiry rule, a missing future or an unpublished period',()=>{
   expect(resolveFreshMcxLink(option('CRUDEOILM',{expiry:'2026-11-18'}),[future('CRUDEOILM')])).toBeNull();
   expect(resolveFreshMcxLink(option('CRUDEOILM'),[future('CRUDEOIL')])).toBeNull();
   expect(resolveFreshMcxLink(option('CRUDEOILM',{expiry:'2027-01-14'}),[future('CRUDEOILM',{expiry:'2027-01-18'})])).toBeNull();
 });
});
