"""EXP-3.0 / 3.1 trigger capture-arm report (A3R, OF1R). Read-only; local; production data stays outside the repo.

  python exp3_report.py --positions positions.csv [--arms arms.csv] [--decisions decisions.csv]
                        [--trades trades.csv] [--of1 of1_candidates.csv]

Inputs are read-only exports:
  positions: SELECT ... state FROM experiment_positions
  arms:      SELECT * FROM experiment_arms
  decisions: SELECT ... FROM experiment_decisions
  trades:    production A3 / OF1 TRADE_SETUP signals (id, time_ist, symbol, inputs)
  of1:       of1_candidates
Each arm VERSION is reported apart (1.0 and 1.1 never pooled). Official and simulated ledgers are kept apart. Open,
pending, NOT_OPENED and UNRESOLVED positions are counted, never given a return. The splits are those pre-registered in
hypotheses_a3_of1.json; nothing here is a rule. Session minimums are review checkpoints, not proof.
"""
import argparse, csv, hashlib, json, os, random, statistics as st, collections, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))


def frozen(name, sha_name):
    want = open(os.path.join(HERE, sha_name)).read().split()[0]
    got = hashlib.sha256(open(os.path.join(HERE, name), 'rb').read()).hexdigest()
    assert got == want, f'{name} changed after freezing'
    return want


SHA = {'EXP-3.0': frozen('definitions_exp3.json', 'definitions_exp3.sha256'), 'EXP-3.1': frozen('definitions_exp3_1.json', 'definitions_exp3_1.sha256')}
HYP = frozen('hypotheses_a3_of1.json', 'hypotheses_a3_of1.sha256')
ap = argparse.ArgumentParser()
ap.add_argument('--positions', required=True)
ap.add_argument('--arms'); ap.add_argument('--decisions'); ap.add_argument('--trades'); ap.add_argument('--of1')
args = ap.parse_args()
csv.field_size_limit(10**9)
random.seed(3)
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
day = lambda ms: dt.datetime.fromtimestamp(ms / 1000, IST).strftime('%Y-%m-%d')
sess = lambda p: ('MCX' if p['candidate']['exchange'] == 'MCX' else 'NSE_BSE', day(p['openedAt']))
rows = [json.loads(r['state']) for r in csv.DictReader(open(args.positions, encoding='utf-8'))]
rows = [p for p in rows if p['arm'] in ('A3R', 'OF1R')]

# Production's own A3 / OF1 trades, by candidate id (= the router's lifecycleId the arm records).
prod = {}
if args.trades:
    for r in csv.DictReader(open(args.trades, encoding='utf-8')):
        i = json.loads(r['inputs'])
        if i.get('source') in ('A3', 'OF1') and i.get('candidateId'):
            prod[i['candidateId']] = {'id': r['id'], 'closeReason': i.get('closeReason'), 'source': i['source']}


def metrics(ps):
    off = [p for p in ps if p['official']['status'] == 'CLOSED' and p['official']['netR'] is not None]
    v = [p['official']['netR'] for p in off]
    cum = peak = dd = 0.0
    for p in sorted(off, key=lambda p: p['official']['exitAt']):
        cum += p['official']['netR']; peak = max(peak, cum); dd = max(dd, peak - cum)
    w = [x for x in v if x > 0]; l = [x for x in v if x <= 0]
    sim = [p['sim']['netR'] for p in ps if p['sim']['status'] == 'CLOSED' and p['sim']['netR'] is not None]
    return {
        'positions': len(ps), 'exchange_sessions': len({sess(p) for p in ps}),
        'official_closed': len(off), 'official_open': sum(1 for p in ps if p['official']['status'] == 'OPEN'),
        'official_net_r': round(sum(v), 3), 'official_expectancy_r': round(st.mean(v), 3) if v else None,
        'avg_win_r': round(st.mean(w), 3) if w else None, 'avg_loss_r': round(st.mean(l), 3) if l else None, 'max_dd_r': round(dd, 2),
        'official_target_hit': sum(1 for p in off if p['official']['reason'] == 'TARGET'),
        'sim_closed': len(sim), 'sim_net_r': round(sum(sim), 3), 'sim_expectancy_r': round(st.mean(sim), 3) if sim else None,
        'sim_not_opened': sum(1 for p in ps if p['sim']['status'] == 'NOT_OPENED'),
        'sim_open_or_pending': sum(1 for p in ps if p['sim']['status'] in ('OPEN', 'EXIT_PENDING')),
        'sim_unresolved': sum(1 for p in ps if p['sim']['status'] == 'UNRESOLVED'),
        'official_close_reasons': dict(collections.Counter(p['official']['reason'] for p in off)),
    }


def diff_ci(a, b, n=4000):
    """Mean official net R of group a minus group b, resampling exchange-sessions."""
    ga = collections.defaultdict(list); gb = collections.defaultdict(list)
    for g, ps in ((ga, a), (gb, b)):
        for p in ps:
            if p['official']['status'] == 'CLOSED' and p['official']['netR'] is not None: g[sess(p)].append(p['official']['netR'])
    keys = sorted(set(ga) | set(gb))
    if len(keys) < 5:
        return 'n/a (fewer than 5 exchange-sessions)'
    m = []
    for _ in range(n):
        ks = [random.choice(keys) for _ in keys]
        xa = [x for k in ks for x in ga[k]]; xb = [x for k in ks for x in gb[k]]
        if xa and xb: m.append(st.mean(xa) - st.mean(xb))
    m.sort()
    return (round(m[int(.05 * len(m))], 4), round(m[int(.95 * len(m))], 4)) if m else None


def split(name, ps, key, note):
    groups = collections.defaultdict(list)
    for p in ps: groups[key(p)].append(p)
    print(f"\n  {name} ({note})")
    for g in sorted(groups, key=str):
        print(f"    {g}: " + json.dumps(metrics(groups[g])))
    ks = sorted(groups, key=str)
    if len(ks) == 2:
        print(f"    {ks[0]} minus {ks[1]} official expectancy, 90% session bootstrap: {diff_ci(groups[ks[0]], groups[ks[1]])}")


print(f"Trigger capture arms; definitions EXP-3.0 {SHA['EXP-3.0'][:12]}, EXP-3.1 {SHA['EXP-3.1'][:12]}; hypotheses {HYP[:12]}; positions {len(rows)}")
print('MEASUREMENT ONLY: no A3 / OF1 trading rule was changed.')
if args.arms:
    for r in csv.DictReader(open(args.arms, encoding='utf-8')):
        if r['arm'] in ('A3R', 'OF1R'): print(f"  {r['arm']}: {r['version']} activated {r['activated_at']} commit {r.get('commit')}")
if args.decisions:
    funnel = collections.Counter()
    cands = collections.defaultdict(set)
    for d in csv.DictReader(open(args.decisions, encoding='utf-8')):
        if d['arm'] in ('A3R', 'OF1R'):
            funnel[(d['arm_version'], d['decision'], d['code'] or '')] += 1
            cands[d['arm_version']].add(d['candidate_id'])
    print('\nCandidate recording (every routed candidate from 1.1; 1.0 recorded built candidates only):')
    for v in sorted(cands):
        print(f"  {v}: {len(cands[v])} distinct candidates; " + ', '.join(f"{dec}{'/' + code if code else ''} {n}" for (vv, dec, code), n in sorted(funnel.items()) if vv == v))

nse = lambda ps: len({sess(p) for p in ps if sess(p)[0] == 'NSE_BSE'})
mcx = lambda ps: len({sess(p) for p in ps if sess(p)[0] == 'MCX'})
by = collections.defaultdict(list)
for p in rows: by[(p['arm'], p['armVersion'])].append(p)
for (arm, ver), ps in sorted(by.items()):
    print(f"\n[{arm} {ver}] NSE/BSE sessions {nse(ps)}, MCX sessions {mcx(ps)}\n  all: " + json.dumps(metrics(ps)))
    if prod:
        split('production traded the same candidate?', ps, lambda p: 'PRODUCTION_TRADED' if p['candidate']['candidateId'] in prod else 'NOT_TRADED_BY_PRODUCTION',
              'positions production never traded = arbitration losses, held production slots, production build failures')
    if arm == 'A3R':
        split('A3-H1 rToT1 >= 1.5 vs < 1.5', [p for p in ps if p['candidate'].get('rToT1') is not None],
              lambda p: 'RT1_GE_1.5' if p['candidate']['rToT1'] >= 1.5 else 'RT1_LT_1.5',
              'checkpoint: 20 NSE/BSE sessions' + (' reached' if nse(ps) >= 20 else ' NOT reached: inconclusive'))
    if arm == 'OF1R':
        enough = nse(ps) >= 10 and mcx(ps) >= 10
        note = 'checkpoint: 10 NSE + 10 MCX sessions' + (' reached' if enough else ' NOT reached: inconclusive')
        split('OF1-H3 exchange', ps, lambda p: sess(p)[0], note)
        if args.of1:
            # of1_candidates is keyed (symbol, exchange, mode, decision_bar_time, direction).
            ev = {}
            for r in csv.DictReader(open(args.of1, encoding='utf-8')):
                t = int(dt.datetime.fromisoformat(r['decision_bar_time'].replace('Z', '+00:00')).timestamp() * 1000)
                ev[(r['symbol'], r['exchange'], r['mode'], t, r['direction'])] = 'DELTA' in (json.loads(r['evidence']).get('found') or [])
            k = lambda p: (p['candidate']['symbol'], p['candidate']['exchange'], p['candidate']['mode'], p['candidate'].get('decisionTime'), p['candidate']['direction'])
            matched = [p for p in ps if k(p) in ev]
            print(f"\n  OF1-H1 join: {len(matched)}/{len(ps)} positions matched to of1_candidates")
            split('OF1-H1 DELTA in flow evidence', matched, lambda p: 'DELTA' if ev[k(p)] else 'NO_DELTA', note)
