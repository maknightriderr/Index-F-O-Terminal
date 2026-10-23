"""Baseline-trade filtering study for definitions.json (EXP-1.0). Read-only; local.

  python experiment_report.py <trades.csv> [<paper_execution_observations.csv>] [--descriptive-from YYYY-MM-DD]

<trades.csv> is analyze.py's output on a fresh export. Without --descriptive-from, only trades entered at or after the
frozen activation are used (the real experiment). --descriptive-from runs the same arithmetic on history and labels it
DESCRIPTIVE SUBSET (not a test, not a replay). The definitions file's hash is checked so a silent edit is visible.
"""
import csv, hashlib, json, os, random, statistics as st, sys, collections, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
DEF = os.path.join(HERE, 'definitions.json')
FROZEN = open(os.path.join(HERE, 'definitions.sha256')).read().split()[0]
assert hashlib.sha256(open(DEF, 'rb').read()).hexdigest() == FROZEN, 'definitions.json changed after freezing: re-freeze explicitly with a new version'
D = json.load(open(DEF, encoding='utf-8'))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
desc = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == '--descriptive-from'), None)
f = lambda x: float(x) if x not in ('', None) else None
csv.field_size_limit(10**9)
random.seed(26)

T = [r for r in csv.DictReader(open(args[0], encoding='utf-8'))]
start = desc if desc else D['activation']
start_dt = dt.datetime.fromisoformat(start if 'T' in start else start + 'T00:00:00+05:30')
pop = [r for r in T if r['official'] == 'True' and r['strategy'] == 'INDICATOR' and r['mode'] == 'INTRADAY' and dt.datetime.fromisoformat(r['entry_time']) >= start_dt]

late = lambda r: r['session_group'] == 'NSE_BSE' and f(r['minutes_since_open']) is not None and f(r['minutes_since_open']) >= 240
ARMS = {
    'BASELINE': lambda r: True,
    'A': lambda r: f(r['planned_target_r']) is not None and f(r['planned_target_r']) >= 0.5,
    'B': lambda r: not late(r),
}
ARMS['C'] = lambda r: ARMS['A'](r) and ARMS['B'](r)

ledger = collections.defaultdict(list)
if len(args) > 1 and os.path.exists(args[1]):
    for o in csv.DictReader(open(args[1], encoding='utf-8')):
        ledger[o['signal_id']].append(o)


def sim_r(r):
    """Quote-ledger estimate: ask entry, bid / bid-reached-target exit, fees only (no spread: it is in the prices)."""
    obs = ledger.get(r['trade_id'], [])
    en = next((o for o in obs if o['event'] == 'ENTRY'), None)
    ex = next((o for o in obs if o['event'] == 'EXIT'), None)
    if not en or not ex or not f(en['sim_fill']) or f(ex['sim_fill']) is None:
        return None, (ex or en or {}).get('sim_quality', 'NO_LEDGER_ROW')
    risk = f(r['risk_points'])
    fees = ((f(r['cost_statutory_pct']) or 0) + (f(r['cost_brokerage_pct']) or 0)) / 100 * f(r['entry_premium'])
    return (f(ex['sim_fill']) - f(en['sim_fill']) - fees) / risk, 'OK'


def cluster_ci(rs, n=4000):
    g = collections.defaultdict(list)
    for r, v in rs:
        g[(r['session_group'], r['session_date'])].append(v)
    gl = list(g.values())
    if len(gl) < 5:
        return None
    m = sorted(sum(s) / len(s) for s in ([x for _ in gl for x in random.choice(gl)] for _ in range(n)))
    return round(m[int(.05 * n)], 4), round(m[int(.95 * n)], 4)


def diff_ci(kept, skipped, n=4000):
    if not kept or not skipped:
        return None
    keys = sorted({(r['session_group'], r['session_date']) for r in kept + skipped})
    gk = collections.defaultdict(list); gs = collections.defaultdict(list)
    for r in kept: gk[(r['session_group'], r['session_date'])].append(f(r['net_r']))
    for r in skipped: gs[(r['session_group'], r['session_date'])].append(f(r['net_r']))
    if len(keys) < 5:
        return None
    m = []
    for _ in range(n):
        ks = [random.choice(keys) for _ in keys]
        a = [x for k in ks for x in gk[k]]; b = [x for k in ks for x in gs[k]]
        if a and b:
            m.append(sum(a) / len(a) - sum(b) / len(b))
    m.sort()
    return round(m[int(.05 * len(m))], 4), round(m[int(.95 * len(m))], 4)


def metrics(rs):
    if not rs:
        return {'closed': 0}
    v = [f(r['net_r']) for r in rs]
    cum = peak = dd = 0.0
    for r in sorted(rs, key=lambda r: r['exit_time'] or r['entry_time']):
        cum += f(r['net_r']); peak = max(peak, cum); dd = max(dd, peak - cum)
    gp = sum(x for x in v if x > 0)
    sims = [sim_r(r) for r in rs]
    ok = [(r, s) for r, (s, q) in zip(rs, sims) if s is not None]
    q = collections.Counter(qq for _, qq in sims)
    marks = sum(sum(1 for o in ledger.get(r['trade_id'], []) if o['event'] == 'MARK') for r in rs)
    minutes = sum(f(r['hold_minutes']) or 0 for r in rs)
    return {
        'closed': len(rs), 'exchange_sessions': len({(r['session_group'], r['session_date']) for r in rs}), 'dates': len({r['session_date'] for r in rs}),
        'net_r_total': round(sum(v), 4), 'avg_net_r': round(st.mean(v), 4), 'avg_net_r_ci90': cluster_ci([(r, f(r['net_r'])) for r in rs]),
        'max_drawdown_r': round(dd, 3), 'top_winner_share_of_gross_profit': round(max(v) / gp, 3) if gp and max(v) > 0 else None,
        'net_r_ex_top_winner': round(sum(v) - max(v), 4) if max(v) > 0 else round(sum(v), 4),
        'ledger_sim_trades': len(ok), 'ledger_sim_avg_r': round(st.mean(s for _, s in ok), 4) if ok else None, 'ledger_quality': dict(q),
        'mark_coverage_per_open_minute': round(marks / minutes, 3) if minutes else None,
    }


label = 'DESCRIPTIVE SUBSET OF HISTORY (not a test, not a replay)' if desc else f"FORWARD BASELINE-TRADE FILTERING STUDY from {D['activation']}"
print(f"{label}; definitions {D['version']} sha256 {FROZEN[:12]}; population {len(pop)} trades")
sessions = {(r['session_group'], r['session_date']) for r in pop}
nse_sessions = sum(1 for g_, _ in sessions if g_ == 'NSE_BSE')
if not desc and nse_sessions < 20:
    print(f"INTERIM ONLY: {nse_sessions} NSE_BSE exchange-sessions so far (the definitions require 20 before any reading).")
for arm, rule in ARMS.items():
    kept = [r for r in pop if rule(r)]; skipped = [r for r in pop if not rule(r)]
    m = metrics(kept)
    m['trades_per_exchange_session'] = round(len(kept) / len(sessions), 3) if sessions else None
    if arm != 'BASELINE':
        m['kept_minus_skipped_avg_r_ci90'] = diff_ci(kept, skipped)
        m['skipped'] = metrics(skipped)
    verdict = '' if not m.get('closed') else (' -> avg below zero: LOSS REDUCTION at best' if m['avg_net_r'] < 0 else ' -> avg above zero (check the CI before reading anything into it)')
    print(f"\n[{arm}]{' EXPLORATORY' if arm == 'C' else ''}{verdict}\n" + json.dumps(m, indent=1))
