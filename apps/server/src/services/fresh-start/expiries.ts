import type {Exchange} from '@fno/shared';
import {FRESH_MONTHLY_MAX_EXPIRY_SESSIONS} from '@fno/analytics';
import {freshExpirySessions} from './context.js';
import {FRESH_BSE_PAPER_PROPOSAL} from './bse-policy.js';
import {FRESH_MCX_PAPER_PROPOSAL} from './mcx-policy.js';

/**
 * The expiries an entry may use, nearest first: those inside the market's standard window (NSE index 1-10, stocks
 * 3-15, BSE 1-10, MCX 3-15 sessions), at most two. A monthly-only product has none in the first half of its cycle
 * (5 Nov: BANKNIFTY / FINNIFTY expiries [] - next expiry 12 sessions away), so it then takes its single nearest expiry
 * up to FRESH_MONTHLY_MAX_EXPIRY_SESSIONS. Shared by the adapter and the book subscriptions (6 Nov: books were
 * subscribed for the two nearest listed expiries, which for stocks near expiry were not the ones the adapter priced).
 */
export function freshTradableExpiries(market:string,expiries:Iterable<string>,session:string,exchange:Exchange):string[]{
  const mcx=market==='MCX_VERIFIED_FUTURES_OPTIONS',bse=market==='BSE_VERIFIED_OPTIONS',stock=market==='NSE_STOCK_OPTIONS';
  const minSessions=mcx?FRESH_MCX_PAPER_PROPOSAL.minimumExpirySessions:bse?FRESH_BSE_PAPER_PROPOSAL.minimumExpirySessions:stock?3:1;
  const maxSessions=mcx?FRESH_MCX_PAPER_PROPOSAL.maximumExpirySessions:bse?FRESH_BSE_PAPER_PROPOSAL.maximumExpirySessions:stock?15:10;
  const listed=[...new Set(expiries)].map(d=>({d,n:freshExpirySessions(session,d,exchange)})).filter((x):x is {d:string;n:number}=>x.n!=null&&x.n>=minSessions&&x.n<=FRESH_MONTHLY_MAX_EXPIRY_SESSIONS).sort((a,b)=>a.d.localeCompare(b.d));
  const standard=listed.filter(x=>x.n<=maxSessions);
  return (standard.length?standard.slice(0,2):listed.slice(0,1)).map(x=>x.d);
}
