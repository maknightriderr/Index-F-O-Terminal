import {describe,it,expect} from 'vitest';
import {angelMasterUnits} from '../../providers/angel-one/master-units.js';
describe('Angel master price and quantity provenance',()=>{
 it.each(['NFO','BFO','nse_cm','bse_cm'])('normalizes a 5-paise %s tick to INR .05',segment=>{const r=angelMasterUnits(segment,'NIFTY','65','5.000000');expect(r.tickSize).toBe(.05);expect(r.contractUnits).toMatchObject({brokerLotQuantity:65,premiumUnitsPerLot:65,quantityVerified:true,tickVerified:true});});
 it('keeps MCX Gold broker quantity separate from premium P&L units and blocks unverified book semantics',()=>{const r=angelMasterUnits('MCX','GOLD','1','50.000000');expect(r.tickSize).toBe(.5);expect(r.contractUnits).toMatchObject({brokerLotQuantity:1,premiumUnitsPerLot:100,quantityVerified:false});expect(angelMasterUnits('MCX','GOLDM','100','50').contractUnits).toMatchObject({brokerLotQuantity:100,premiumUnitsPerLot:10,quantityVerified:false});});
 it.each(['','bad','0','-1'])('never supplies an invented tick when the raw tick is %s',tick=>{expect(angelMasterUnits('NFO','NIFTY','65',tick).tickSize).toBe(0);});
 it('marks unsupported segment units and malformed lot quantities unverified',()=>{expect(angelMasterUnits('CDS','USDINR','1','25000').contractUnits.tickVerified).toBe(false);expect(angelMasterUnits('NFO','NIFTY','25abc','5').contractUnits.quantityVerified).toBe(false);});
});
