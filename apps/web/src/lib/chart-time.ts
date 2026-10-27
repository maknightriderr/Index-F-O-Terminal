import { TickMarkType, type Time } from 'lightweight-charts';

const options = { timeZone: 'Asia/Kolkata', hourCycle: 'h23' as const };
const clock = new Intl.DateTimeFormat('en-GB', { ...options, hour: '2-digit', minute: '2-digit' });
const seconds = new Intl.DateTimeFormat('en-GB', { ...options, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const date = new Intl.DateTimeFormat('en-GB', { ...options, day: '2-digit', month: 'short', year: 'numeric' });
const day = new Intl.DateTimeFormat('en-GB', { ...options, day: '2-digit', month: 'short' });
const month = new Intl.DateTimeFormat('en-GB', { ...options, month: 'short' });
const year = new Intl.DateTimeFormat('en-GB', { ...options, year: 'numeric' });

// Format labels only: keep real UTC timestamps for candles, overlays and live updates.
function asDate(time: Time): Date {
  if (typeof time === 'number') return new Date(time * 1000);
  if (typeof time === 'string') return new Date(`${time}T00:00:00Z`);
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

export function chartCrosshairIst(time: Time): string {
  const value = asDate(time);
  return typeof time === 'number' ? `${date.format(value)} ${clock.format(value)} IST` : date.format(value);
}

export function chartTickIst(time: Time, type: TickMarkType): string {
  const formatter = type === TickMarkType.Year ? year
    : type === TickMarkType.Month ? month
    : type === TickMarkType.DayOfMonth ? day
    : type === TickMarkType.TimeWithSeconds ? seconds : clock;
  return formatter.format(asDate(time));
}
