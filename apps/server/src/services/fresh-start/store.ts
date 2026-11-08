import { freshRoundTripFees, FRESH_PACK_VERSION, admitFreshPaper, freshAccountBook, advanceFreshPosition, canonicalFreshParent, freshQuoteCode, type FreshCandidate, type FreshContract, type FreshQuote, type FreshPaperPosition } from '@fno/analytics';
import { sql } from '../../lib/db.js';
import { freshEntriesEnabled } from '../../config/fresh-start.js';
import { freshTelegramNotifier, type FreshTradeNotifier } from './notify.js';
export interface FreshDb {
    unsafe(query: string, params?: any[]): Promise<any[]>;
    begin<T>(run: (tx: FreshDb) => Promise<T>): Promise<T>;
}
export interface FreshEntryRequest {
    accountId: string;
    session: string;
    capital: number;
    riskGroup: string;
    candidate: FreshCandidate;
    contract: FreshContract;
    quote: FreshQuote;
    now: number;
    arrivalAt: number;
    currentUnderlying: number;
    cutoff: number;
    calendarVerified: boolean;
    eventClear: boolean;
    legacyPositionOpen: boolean;
    /** Account-wide executable marks from the shared position watches; absence freezes new risk. */
    marks: Readonly<Record<string, FreshQuote>>;
}
type Stored = {
    id: string;
    revision: number;
    state: FreshPaperPosition;
    risk_group: string;
};
/** Abort inside the transaction so invalidated entry work rolls back every staged write. */
class FreshEntryTransactionRejected extends Error {constructor(readonly code='PAPER_DISABLED'){super(code);}}
export class FreshPaperStore {
    constructor(private db: FreshDb = sql as unknown as FreshDb, private entriesEnabled: () => boolean = freshEntriesEnabled, private now:()=>number=Date.now, private notify: FreshTradeNotifier = freshTelegramNotifier) { }
    /** Notices go out only after their transaction commits, and can never fail the paper state. */
    private announce(kind: 'ENTRY' | 'EXIT', position: FreshPaperPosition) { try { this.notify({ kind, position }); } catch { /* best effort */ } }
    /** All account spending, exposure checks, fill and frozen risk are committed under the same account lock. */
    async enter(r: FreshEntryRequest): Promise<{
        ok: boolean;
        code: string;
        id?: string;
    }> {
        if (!this.entriesEnabled())
            return { ok: false, code: 'PAPER_DISABLED' };
        if (r.candidate.version !== FRESH_PACK_VERSION)
            return { ok: false, code: 'UNAPPROVED_VERSION' };
        if (!r.accountId || !r.riskGroup || r.session !== r.candidate.session || !Number.isFinite(r.capital) || r.capital <= 0)
            return { ok: false, code: 'INVALID_ACCOUNT' };
        let filled: FreshPaperPosition | null = null;
        const result = await this.db.begin(async (tx) => {
            await tx.unsafe("SELECT id FROM fresh_paper_portfolio WHERE id='terminal-paper' FOR UPDATE");
            if(!this.entriesEnabled())throw new FreshEntryTransactionRejected();
            await tx.unsafe('INSERT INTO fresh_paper_accounts(id,session,version,capital) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [r.accountId, r.session, r.candidate.version, r.capital]);
            const [a] = await tx.unsafe('SELECT * FROM fresh_paper_accounts WHERE id=$1 FOR UPDATE', [r.accountId]);
            if (a.session !== r.session || a.version !== r.candidate.version || a.capital !== r.capital)
                return { ok: false, code: 'ACCOUNT_COHORT_MISMATCH' };
            const duplicate = await tx.unsafe('SELECT id FROM fresh_paper_positions WHERE id=$1', [r.candidate.id]);
            if (duplicate.length)
                return { ok: true, code: 'ALREADY_FILLED', id: r.candidate.id };
            const previous = await tx.unsafe('SELECT code FROM fresh_candidates WHERE id=$1', [r.candidate.id]);
            if (previous.length)
                return { ok: false, code: previous[0].code ?? 'PREVIOUSLY_REFUSED' };
            const validateTime=()=>{
                const now=this.now();
                if(!Number.isFinite(now)||!Number.isFinite(r.now)||now<r.now)throw new FreshEntryTransactionRejected('ENTRY_CLOCK_UNAVAILABLE');
                const qc=freshQuoteCode(r.quote,r.contract.id,r.contract.source,r.contract.sourceEpoch,now);
                if(qc)throw new FreshEntryTransactionRejected(qc);
                // A premium-defined exit (expiry gamma) enters until its own entryUntil (never inside the last 10 minutes);
                // everything else stops one hour before the cutoff.
                const pe=r.candidate.premiumExit,lastEntry=pe?Math.min(pe.entryUntil,r.cutoff-600000):r.cutoff-3600000;
                if(now>r.candidate.expiresAt||now>=lastEntry)throw new FreshEntryTransactionRejected('ENTRY_EXPIRED_OR_EARLY');
                return now;
            };
            r={...r,now:validateTime()};
            // Each paper book (fresh-start / Dhan engine) reserves, marks and limits its own positions only (owner D4).
            const book = freshAccountBook(r.accountId);
            const open: Stored[] = (await tx.unsafe("SELECT id,account_id,revision,state,risk_group FROM fresh_paper_positions WHERE status<>'CLOSED'", [])).filter((x: { account_id: string }) => freshAccountBook(x.account_id) === book);
            const parents = await tx.unsafe('SELECT id,instrument,direction,session,origin,ended,traded,evidence FROM fresh_parent_moves WHERE account_id=$1 AND instrument=$2', [r.accountId, r.candidate.instrument]);
            for (const parent of parents) {
                const c = parent.evidence as FreshCandidate, d = c.direction === 'BULLISH' ? 1 : -1;
                if (!parent.ended && (parent.session !== r.session || r.now >= r.cutoff || d * (r.currentUnderlying - c.stop) <= 0 || d * (r.currentUnderlying - c.target) >= 0)) {
                    parent.ended = true;
                    await tx.unsafe('UPDATE fresh_parent_moves SET ended=true WHERE account_id=$1 AND id=$2', [r.accountId, parent.id]);
                }
            }
            const c = { ...r.candidate, parentId: canonicalFreshParent(r.candidate, parents) };
            const same = await tx.unsafe('SELECT status,closed_at,strategy FROM fresh_paper_positions WHERE account_id=$1 AND instrument=$2 ORDER BY opened_at DESC', [r.accountId, c.instrument]);
            const lastClose = same.find(x => x.status === 'CLOSED')?.closed_at;
            r={...r,now:validateTime()};
            let unrealized = 0, marksComplete = true, reservedRisk = 0, reservedPremium = 0;
            const validMark=(row:Stored,now:number)=>{
                const k=row.state.contract,q=r.marks[row.id];
                return !!q&&freshQuoteCode(q,k.id,k.source,k.sourceEpoch,now)===null&&q.bidUnits>=row.state.quantity;
            };
            for(const row of open){
                const p=row.state,k=p.contract,q=r.marks[row.id];
                reservedRisk+=p.originalRiskCurrency;reservedPremium+=p.entry*p.quantity*k.multiplier;
                if(!validMark(row,r.now)){marksComplete=false;continue;}
                const exit=Math.max(0,q.bid-q.tick),units=p.quantity*k.multiplier;
                unrealized+=(exit-p.entry)*units-(k.feePolicy?freshRoundTripFees(p.entry,exit,p.quantity,k.multiplier,k.feePolicy):k.explicitRoundTripCostPerUnit*units);
            }
            const cohortRows = await tx.unsafe('SELECT id,realized_net FROM fresh_paper_accounts WHERE version=$1', [c.version]);
            const cohortNet = cohortRows.filter((x: { id: string }) => freshAccountBook(x.id) === book).reduce((n: number, x: { realized_net: unknown }) => n + Number(x.realized_net ?? 0), 0);
            const account = { cohortNet: cohortNet + unrealized, capital: a.capital, equity: a.capital + a.realized_net + unrealized, dailyNet: a.realized_net + unrealized, reservedRisk, reservedPremium, openPositions: open.length, consecutiveNetLosses: a.paused ? 3 : a.consecutive_losses, marksComplete };
            const admission = admitFreshPaper({ ...r, candidate: c, account,
                parentAlreadyTraded: parents.some(p => p.id === c.parentId && p.traded),
                correlatedPositionOpen: open.some(x => x.risk_group === r.riskGroup && x.state.candidate.instrument !== c.instrument),
                instrumentPositionOpen: open.some(x => x.state.candidate.instrument === c.instrument),
                entriesToday: same.length, barsSinceLastClose: lastClose ? Math.floor((r.now - new Date(lastClose).getTime()) / 300000) : null,
            });
            const s4Used = c.strategy === 'NEW_FIRST_OPENING_PULLBACK_V1' && same.some(x => x.strategy === c.strategy);
            const code = s4Used ? 'FIRST_PULLBACK_ATTEMPT_USED' : admission.ok ? 'FILLED' : admission.code;
            await tx.unsafe('INSERT INTO fresh_candidates(id,account_id,at,version,strategy,parent_id,decision,code,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING', [c.id, r.accountId, new Date(r.now), c.version, c.strategy, c.parentId, code === 'FILLED' ? 'FILLED' : 'REFUSED', code, JSON.stringify({ candidate: c, contract: r.contract, quote: r.quote, account, admission })]);
            if (!admission.ok || s4Used)
                return { ok: false, code };
            const p: FreshPaperPosition = { id: c.id, ...(admission.riskFlags.length ? { riskFlags: admission.riskFlags } : {}), sessionCutoff:r.cutoff, contract: {...r.contract,explicitRoundTripCostPerUnit:admission.explicitCostPerUnit}, candidate: c, quantity: admission.quantity, entry: admission.entry, originalRiskCurrency: admission.initialRiskCurrency,
                emergencyStop: admission.emergencyStop, currentStop: admission.emergencyStop, highBid: r.quote.bid, openedAt: r.now, lastEventAt: r.now,
                state: 'OPEN', exitTriggeredAt: null, exitReason: null, exitPrice: null, netPnl: null, maxUnderlyingFavorable: 0 };
            await tx.unsafe('INSERT INTO fresh_parent_moves(account_id,id,instrument,direction,session,origin,traded,evidence) VALUES($1,$2,$3,$4,$5,$6,true,$7::jsonb) ON CONFLICT(account_id,id) DO UPDATE SET traded=true', [r.accountId, c.parentId, c.instrument, c.direction, r.session, c.origin, JSON.stringify(c)]);
            await tx.unsafe("INSERT INTO fresh_paper_positions(id,account_id,version,strategy,instrument,risk_group,parent_id,session,status,reserved_risk,reserved_premium,opened_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,$10,$11,$12::jsonb)", [c.id, r.accountId, c.version, c.strategy, c.instrument, r.riskGroup, c.parentId, r.session, admission.initialRiskCurrency, admission.premiumCurrency, new Date(r.now), JSON.stringify(p)]);
            await tx.unsafe("INSERT INTO fresh_paper_events(id,position_id,revision,at,kind,evidence) VALUES($1,$2,0,$3,'ENTRY_FILL',$4::jsonb)", [`${c.id}:0`, c.id, new Date(r.now), JSON.stringify({ request: r, admission })]);
            if(!this.entriesEnabled())throw new FreshEntryTransactionRejected();
            const checkedAt=validateTime();
            if(open.some(row=>!validMark(row,checkedAt)))throw new FreshEntryTransactionRejected('ACCOUNT_PAUSED');
            filled = p;
            return { ok: true, code: 'FILLED', id: c.id };
        }).catch((error): { ok: boolean; code: string; id?: string } => {
            if(error instanceof FreshEntryTransactionRejected)return {ok:false,code:error.code};
            throw error;
        });
        if (result.ok && result.code === 'FILLED' && filled) this.announce('ENTRY', filled);
        return result;
    }
    async accountView(accountId:string,capital:number,marks:Readonly<Record<string,FreshQuote>>,now:number){
        const [a]=await this.db.unsafe('SELECT * FROM fresh_paper_accounts WHERE id=$1',[accountId]);
        const book=freshAccountBook(accountId),rows=(await this.recover()).filter(x=>freshAccountBook(x.account_id)===book);let unrealized=0,reservedRisk=0,reservedPremium=0,marksComplete=!a||(a.capital===capital&&a.version===FRESH_PACK_VERSION);
        for(const {id,state:p} of rows){const k=p.contract,q=marks[id],units=p.quantity*k.multiplier;reservedRisk+=p.originalRiskCurrency;reservedPremium+=p.entry*units;
            if(!q||freshQuoteCode(q,k.id,k.source,k.sourceEpoch,now)!==null||q.bidUnits<p.quantity){marksComplete=false;continue;}
            const exit=Math.max(0,q.bid-q.tick);unrealized+=(exit-p.entry)*units-(k.feePolicy?freshRoundTripFees(p.entry,exit,p.quantity,k.multiplier,k.feePolicy):k.explicitRoundTripCostPerUnit*units);
        }
        const dailyNet=(a?.realized_net??0)+unrealized;
        const cohortRows=await this.db.unsafe('SELECT id,realized_net FROM fresh_paper_accounts WHERE version=$1',[FRESH_PACK_VERSION]);const cohortNet=cohortRows.filter((x:{id:string})=>freshAccountBook(x.id)===book).reduce((n:number,x:{realized_net:unknown})=>n+Number(x.realized_net??0),0)+unrealized;
        return {cohortNet,capital,equity:capital+dailyNet,dailyNet,reservedRisk,reservedPremium,marksComplete,openPositions:rows.length,consecutiveNetLosses:a?.paused?3:a?.consecutive_losses??0};
    }
    /** Exit monitoring is deliberately independent of the entry/activation switch. */
    async observe(accountId: string, id: string, e: Parameters<typeof advanceFreshPosition>[1]) {
        let closedState: FreshPaperPosition | null = null;
        const changed = await this.db.begin(async (tx) => {
            await tx.unsafe("SELECT id FROM fresh_paper_portfolio WHERE id='terminal-paper' FOR UPDATE");
            const [account] = await tx.unsafe('SELECT id FROM fresh_paper_accounts WHERE id=$1 FOR UPDATE', [accountId]);
            if (!account)
                return false;
            const [row]: Stored[] = await tx.unsafe("SELECT id,revision,state,risk_group FROM fresh_paper_positions WHERE account_id=$1 AND id=$2 AND status<>'CLOSED' FOR UPDATE", [accountId, id]);
            if (!row)
                return false;
            const n = advanceFreshPosition(row.state, e);
            if (n === row.state)
                return false;
            const closed = n.state === 'CLOSED', rev = row.revision + 1;
            await tx.unsafe('UPDATE fresh_paper_positions SET state=$1::jsonb,status=$2,revision=$3,closed_at=$4,net_pnl=$5 WHERE id=$6 AND revision=$7', [JSON.stringify(n), n.state, rev, closed ? new Date(e.at) : null, n.netPnl, id, row.revision]);
            await tx.unsafe('INSERT INTO fresh_paper_events(id,position_id,revision,at,kind,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [`${id}:${rev}`, id, rev, new Date(e.at), closed ? 'EXIT_FILL' : n.state === 'EXIT_PENDING' ? 'EXIT_PENDING' : 'OBSERVATION', JSON.stringify(e)]);
            if (closed)
                await tx.unsafe('UPDATE fresh_paper_accounts SET realized_net=realized_net+$1,consecutive_losses=CASE WHEN $1<0 THEN consecutive_losses+1 ELSE 0 END,paused=paused OR (CASE WHEN $1<0 THEN consecutive_losses+1 ELSE 0 END)>=3 OR realized_net+$1<=-capital*.01 WHERE id=$2', [n.netPnl, accountId]);
            if (closed)
                closedState = n;
            return true;
        });
        if (closedState) this.announce('EXIT', closedState);
        return changed;
    }
    async recover(): Promise<Array<Stored & {
        account_id: string;
    }>> {
        return this.db.unsafe("SELECT id,account_id,revision,state,risk_group FROM fresh_paper_positions WHERE status<>'CLOSED' ORDER BY opened_at");
    }
}
