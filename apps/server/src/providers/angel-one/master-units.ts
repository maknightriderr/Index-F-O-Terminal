import {unitsPerLot} from './lot-size.js';
/** Angel's equity/commodity JSON master stores price ticks in paise (like strikes).
 * Missing or unsupported units remain unavailable; never substitute a guessed .05 tick.
 * SmartAPI Instruments sample: RELIANCE-EQ tick_size "5.000000" = INR .05.
 * https://smartapi.angelone.in/docs */
export function angelMasterUnits(segment:string,name:string,rawLot:string,rawTick:string){
  const s=segment?.toLowerCase(),supported=['nse','nfo','bse','bfo','nse_cm','nse_fo','bse_cm','bse_fo','mcx','mcx_fo'].includes(s),commodity=s==='mcx'||s==='mcx_fo';
  const lot=Number(rawLot),tick=Number(rawTick),validLot=Number.isSafeInteger(lot)&&lot>0,tickSize=supported&&Number.isFinite(tick)&&tick>0?tick/100:0;
  return {tickSize,contractUnits:{source:'ANGEL_MASTER_PRICE_V1' as const,brokerLotQuantity:validLot?lot:0,premiumUnitsPerLot:validLot?unitsPerLot(commodity?'MCX':'NSE',name,lot).lotSize:0,quantityVerified:supported&&validLot&&!commodity,tickVerified:tickSize>0}};
}
