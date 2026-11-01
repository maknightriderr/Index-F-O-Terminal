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
 * (MCX_DEPTH_CONSERVATIVE_UNITS_V1). GOLD/GOLDM (premium per 10 g, override in lot-size.ts) stay unverified.
 */
export const MCX_PUBLISHED_LOT_UNITS:Readonly<Record<string,number>>=Object.freeze({CRUDEOIL:100,CRUDEOILM:10,NATURALGAS:1250,NATGASMINI:250,SILVER:30});
export function angelMasterUnits(segment:string,name:string,rawLot:string,rawTick:string){
  const s=segment?.toLowerCase(),supported=['nse','nfo','bse','bfo','nse_cm','nse_fo','bse_cm','bse_fo','mcx','mcx_fo'].includes(s),commodity=s==='mcx'||s==='mcx_fo';
  const lot=Number(rawLot),tick=Number(rawTick),validLot=Number.isSafeInteger(lot)&&lot>0,tickSize=supported&&Number.isFinite(tick)&&tick>0?tick/100:0;
  return {tickSize,contractUnits:{source:'ANGEL_MASTER_PRICE_V1' as const,brokerLotQuantity:validLot?lot:0,premiumUnitsPerLot:validLot?unitsPerLot(commodity?'MCX':'NSE',name,lot).lotSize:0,quantityVerified:supported&&validLot&&(!commodity||MCX_PUBLISHED_LOT_UNITS[name]===lot),tickVerified:tickSize>0}};
}
