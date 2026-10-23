"""EXP-2.0 isolated-arm report. Read-only; local.

  python exp2_report.py <experiment_positions.csv> [<experiment_arms.csv>]

Inputs are the exports of queries/14_experiment_positions.sql and 13_experiment_arms.sql. Every arm is compared with R0
(same engine, same candidate stream) per exchange-session. Official and simulated ledgers are reported apart; simulated
positions that never filled (NOT_OPENED), are still open, or ended UNRESOLVED are counted, never given a return.
"""
import csv, hashlib, json, os, random, statistics as st, sys, collections, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
DEF = os.path.join(HERE, 'definitions_exp2.json')
FROZEN = open(os.path.join(HERE, 'definitions_exp2.sha256')).read().split()[0]
assert hashlib.sha256(open(DEF, 'rb').read()).hexdigest() == FROZEN, 'definitions_exp2.json changed after freezing'
csv.field_size_limit(10**9)
random.seed(2)
rows = [json.loads(r['state']) for r in csv.DictReader(open(sys.argv[1], encoding='utf-8'))]
arms = {r['arm']: r for r in csv.DictReader(open(sys.argv[2], encoding='utf-8'))} if len(sys.argv) > 2 else {}
day = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone(dt.timedelta(hours=5, minutes=30))).strftime('%Y-%m-%d')
sess = lambda p: ('MCX' if p['candidate']['exchange'] == 'MCX' else 'NSE_BSE', day(p['openedAt']))


def metrics(ps):
    off = [p for p in ps if p['official']['status'] == 'CLOSED' and p['official']['netR'] is not None]
    v = [p['official']['netR'] for p in off]
    cum = peak = dd = 0.0
    for p in sorted(off, key=lambda p: p['official']['exitAt']):
        cum += p['official']['netR']; peak = max(peak, cum); dd = max(dd, peak - cum)
    gp = sum(x for x in v if x > 0)
    sim_closed = [p for p in ps if p['sim']['status'] == 'CLOSED' and p['sim']['netR'] is not None]
    sv = [p['sim']['netR'] for p in sim_closed]
    marks = sum(p.get('observations', 0) for p in ps)
    return {
        'positions': len(ps), 'exchange_sessions': len({sess(p) for p in ps}),
        'official_closed': len(off), 'official_open': sum(1 for p in ps if p['official']['status'] == 'OPEN'),
        'official_net_r': round(sum(v), 4), 'official_avg_r': round(st.mean(v), 4) if v else None, 'official_max_dd_r': round(dd, 3),
        'top_winner_share': round(max(v) / gp, 3) if gp and v and max(v) > 0 else None, 'official_net_ex_top': round(sum(v) - max(v), 4) if v and max(v) > 0 else round(sum(v), 4),
        'sim_closed': len(sim_closed), 'sim_net_r': round(sum(sv), 4), 'sim_avg_r': round(st.mean(sv), 4) if sv else None,
        'sim_not_opened': sum(1 for p in ps if p['sim']['status'] == 'NOT_OPENED'),
        'sim_open_or_pending': sum(1 for p in ps if p['sim']['status'] in ('OPEN', 'EXIT_PENDING')),
        'sim_unresolved': sum(1 for p in ps if p['sim']['status'] == 'UNRESOLVED'),
        'sim_exit_basis': dict(collections.Counter(p['sim']['exitBasis'] for p in sim_closed)),
        'sim_entry_quality': dict(collections.Counter(p['sim']['entryQuality'] for p in ps)),
        'observations_total': marks,
        'official_close_reasons': dict(collections.Counter(p['official']['reason'] for p in off)),
    }


def diff_ci(a, b, key, n=4000):
    """Arm minus R0: per exchange-session mean of official net R, resampling sessions."""
    ga = collections.defaultdict(list); gb = collections.defaultdict(list)
    for p in a:
        if p['official']['netR'] is not None: ga[sess(p)].append(p['official']['netR'])
    for p in b:
        if p['official']['netR'] is not None: gb[sess(p)].append(p['official']['netR'])
    keys = sorted(set(ga) | set(gb))
    if len(keys) < 5:
        return None
    m = []
    for _ in range(n):
        ks = [random.choice(keys) for _ in keys]
        x = sum(sum(ga[k]) for k in ks); y = sum(sum(gb[k]) for k in ks)
        m.append((x - y) / len(ks))
    m.sort()
    return round(m[int(.05 * n)], 4), round(m[int(.95 * n)], 4)


by = collections.defaultdict(list)
for p in rows:
    by[p['arm']].append(p)
nse_sessions = len({sess(p) for p in rows if sess(p)[0] == 'NSE_BSE'})
print(f"EXP-2.0 isolated arms; definitions sha256 {FROZEN[:12]}; positions {len(rows)}; NSE/BSE exchange-sessions {nse_sessions}")
print("R0 is an EXPERIMENTAL CONTROL, not production: it omits production's TRIGGER_REVERSAL exit (an opposite claimed S1 fill or")
print("momentum trigger closes a held Old Indicator trade). Arm-vs-R0 results are like-for-like inside the engine, not a production comparison.")
if nse_sessions < 20:
    print('INTERIM ONLY: fewer than 20 NSE/BSE exchange-sessions since activation.')
for a, r in sorted(arms.items()):
    print(f"  {a}: {r['version']} activated {r['activated_at']} commit {r.get('commit')}")
for arm in ['R0', 'A', 'B', 'C', 'V2']:
    m = metrics(by.get(arm, []))
    if arm != 'R0':
        m['arm_minus_R0_net_r_per_session_ci90'] = diff_ci(by.get(arm, []), by.get('R0', []), arm)
    label = {'C': ' EXPLORATORY', 'V2': ' HYPOTHESIS'}.get(arm, '')
    note = '' if m.get('official_avg_r') is None else (' -> avg below zero: loss reduction at best' if m['official_avg_r'] < 0 else ' -> avg above zero: check the interval before reading anything into it')
    print(f"\n[{arm}]{label}{note}\n" + json.dumps(m, indent=1))


# ---- V2 vs R0: shared entries vs the additional trades V2's earlier exits made possible (2026-10-23 extension) ----
def v2_decomposition(r0, v2):
    key = lambda p: (p['candidate']['candidateId'], p['openedAt'])
    a = {key(p): p for p in r0}; b = {key(p): p for p in v2}
    closed = lambda p: p['official']['status'] == 'CLOSED' and p['official']['netR'] is not None
    gross = lambda p: (p['official']['exitPrice'] - p['candidate']['entry']) / (p['candidate']['entry'] - p['initialStop'])
    shared = [k for k in set(a) & set(b)]
    both = [k for k in shared if closed(a[k]) and closed(b[k])]
    print(f"\n[V2 vs R0 decomposition] shared entries {len(shared)} (both closed {len(both)}, not both closed {len(shared) - len(both)})")
    if both:
        for name, src in (('R0', a), ('V2', b)):
            print(f"  shared, {name}: gross {sum(gross(src[k]) for k in both):+.2f}R net {sum(src[k]['official']['netR'] for k in both):+.2f}R cost {sum(gross(src[k]) - src[k]['official']['netR'] for k in both):.2f}R")
        diff = [k for k in both if a[k]['official']['reason'] != b[k]['official']['reason']]
        print(f"  shared exits differing: {len(diff)} (V2 better {sum(1 for k in diff if b[k]['official']['netR'] > a[k]['official']['netR'])}, worse {sum(1 for k in diff if b[k]['official']['netR'] < a[k]['official']['netR'])})")
    for name, extra, base in (('V2-only', [b[k] for k in set(b) - set(a)], v2), ('R0-only', [a[k] for k in set(a) - set(b)], r0)):
        done = [p for p in extra if closed(p)]
        rows = []
        for p in sorted(extra, key=lambda p: p['openedAt']):
            prev = [q for q in base if q is not p and q['candidate']['symbol'] == p['candidate']['symbol'] and q['candidate']['exchange'] == p['candidate']['exchange']
                    and q['official'].get('exitAt') and q['official']['exitAt'] <= p['openedAt'] and day(q['openedAt']) == day(p['openedAt'])]
            last = max(prev, key=lambda q: q['official']['exitAt']) if prev else None
            same_move = bool(last and last['candidate']['candidateId'] == p['candidate']['candidateId'])  # same symbol, direction and day
            gap = round((p['openedAt'] - last['official']['exitAt']) / 60000, 1) if last else None
            rows.append((p, last, same_move, gap))
        print(f"  {name}: {len(extra)} positions ({len(done)} closed, {len(extra) - len(done)} open); gross {sum(gross(p) for p in done):+.2f}R net {sum(p['official']['netR'] for p in done):+.2f}R cost {sum(gross(p) - p['official']['netR'] for p in done):.2f}R")
        if rows:
            sm = [r for r in rows if r[2]]
            print(f"    re-entering the same move (same symbol+direction+day as the arm's previous exit): {len(sm)}; net {sum(r[0]['official']['netR'] for r in sm if closed(r[0])):+.2f}R")
            gaps = sorted(r[3] for r in rows if r[3] is not None)
            if gaps: print(f"    minutes since the arm's previous exit on the symbol: median {gaps[len(gaps) // 2]}, min {gaps[0]}, max {gaps[-1]}")
            for p, last, sm_, gap in rows:
                print(f"    {p['id'][:8]} {p['candidate']['symbol']:<11} {p['candidate']['direction']:<8} {'SAME_MOVE' if sm_ else 'NEW_MOVE ':<9} gap {gap!s:>6}m  prev {last['official']['reason'] if last else '-':<22} {p['official'].get('reason')!s:<22} net {p['official']['netR'] if closed(p) else 'open'}")
    sessions = lambda ps: max(1, len({sess(p) for p in ps}))
    print(f"  frequency: R0 {len(r0)} positions / {sessions(r0)} exchange-sessions; V2 {len(v2)} / {sessions(v2)}")


v2_decomposition(by.get('R0', []), by.get('V2', []))
