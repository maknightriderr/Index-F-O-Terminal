import {unitsPerLot} from './lot-size.js';
/** Angel's equity/commodity JSON master stores price ticks in paise (like strikes).
 * Missing or unsupported units remain unavailable; never substitute a guessed .05 tick.
 * SmartAPI Instruments sample: RELIANCE-EQ tick_size "5.000000" = INR .05.
 * https://smartapi.angelone.in/docs */
/**
 * 1.5: MCX contracts whose master lot equals the exchange's published units per lot (CRUDEOIL 100 bbl, CRUDEOILM 10 bbl,
 * NATURALGAS 1250 mmBtu, NATGASMINI 250 mmBtu, SILVER 30 kg; premium is quoted per one of those units). For these the
 * lot quantity is verified. Book depth is read in the same units: if the broker actually reports depth in lots, that
 * reading UNDER-counts liquidity by the lot factor, so it can only refuse more, never invent depth
 * (MCX_DEPTH_CONSERVATIVE_UNITS_V1).
 * GOLD (2 Nov): the master lot is 1 = one 1 kg lot, matching MCX's published trading unit, and the premium is per 10 g
 * (lot-size.ts override: 100 per lot), so the P&L multiplier is 100 per broker quantity. With a broker lot of 1, depth
 * in lots and depth in broker quantity are the same number, so no depth-unit inference is needed. GOLDM stays unverified.
 */
export const MCX_PUBLISHED_LOT_UNITS:Readonly<Record<string,number>>=Object.freeze({CRUDEOIL:100,CRUDEOILM:10,NATURALGAS:1250,NATGASMINI:250,SILVER:30,GOLD:1});
export function angelMasterUnits(segment:string,name:string,rawLot:string,rawTick:string){
  const s=segment?.toLowerCase(),supported=['nse','nfo','bse','bfo','nse_cm','nse_fo','bse_cm','bse_fo','mcx','mcx_fo'].includes(s),commodity=s==='mcx'||s==='mcx_fo';
  const lot=Number(rawLot),tick=Number(rawTick),validLot=Number.isSafeInteger(lot)&&lot>0,tickSize=supported&&Number.isFinite(tick)&&tick>0?tick/100:0;
  return {tickSize,contractUnits:{source:'ANGEL_MASTER_PRICE_V1' as const,brokerLotQuantity:validLot?lot:0,premiumUnitsPerLot:validLot?unitsPerLot(commodity?'MCX':'NSE',name,lot).lotSize:0,quantityVerified:supported&&validLot&&(!commodity||MCX_PUBLISHED_LOT_UNITS[name]===lot),tickVerified:tickSize>0}};
}
