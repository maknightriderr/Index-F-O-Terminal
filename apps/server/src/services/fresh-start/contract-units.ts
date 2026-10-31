import type {Instrument} from '@fno/shared';
/** Quantity is expressed in the broker book's verified units; premium multiplier is separate.
 * Raw master membership or an exchange's physical lot size does not qualify broker depth semantics. */
export function freshContractUnits(instrument:Instrument){
  const u=instrument.contractUnits;
  if(!u||u.quantityVerified!==true||u.tickVerified!==true||!Number.isSafeInteger(u.brokerLotQuantity)||u.brokerLotQuantity<=0||!Number.isSafeInteger(u.premiumUnitsPerLot)||u.premiumUnitsPerLot<=0||u.premiumUnitsPerLot!==instrument.lotSize||!Number.isFinite(instrument.tickSize)||instrument.tickSize<=0)return null;
  if(instrument.exchange!=='MCX'&&u.brokerLotQuantity!==u.premiumUnitsPerLot)return null;
  const multiplier=u.premiumUnitsPerLot/u.brokerLotQuantity;
  if(!Number.isFinite(multiplier)||multiplier<=0)return null;
  return {lotQuantity:u.brokerLotQuantity,multiplier,premiumUnitsPerLot:u.premiumUnitsPerLot};
}
