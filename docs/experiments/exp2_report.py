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
