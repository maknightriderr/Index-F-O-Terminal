import {HOLIDAY_CALENDAR_YEARS} from '@fno/shared';
import {FRESH_FEE_SCHEDULE_UNTIL} from './fees.js';
import {freshMcxCalendarHorizons} from './mcx-contracts.js';

/** Every hard-coded calendar the fresh-start path fails closed beyond, as an exclusive "until" session. */
export function freshCalendarHorizons():Array<{id:string;until:string}>{
  const lastHolidayYear=Math.max(...HOLIDAY_CALENDAR_YEARS);
  return [
    {id:'EXCHANGE_HOLIDAY_CALENDAR',until:`${lastHolidayYear+1}-01-01`},
    {id:'FEE_SCHEDULE',until:FRESH_FEE_SCHEDULE_UNTIL},
    ...freshMcxCalendarHorizons(),
  ];
}
