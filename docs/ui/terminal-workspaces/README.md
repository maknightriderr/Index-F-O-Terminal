# Terminal-wide workspace redesign

Base: `781757863eee652f3c5ddc7b8fa534eab7900eb8` (dashboard and chart-zone correction, PR #64).

The earlier release redesigned the dashboard while other pages retained a different navigation and page layout. This release extends the same graphite/teal and light workspace design throughout the terminal.

## Delivered

| Area | UI change |
| --- | --- |
| All pages | Stable compact navigation rail, related-page navigation, searchable page directory with Ctrl/Command K, Escape close, and open-instrument search. Workspace navigation starts at the top of the new page. |
| Paper Trades | Consistent page header, metric cards, grouped filters and table styling. Existing filter, sorting, pagination and expandable record details remain. |
| Best Setups | Four decision-summary cards based on the existing candidate counts, followed by the existing ranked/filterable candidate table. Counts are not trade totals. |
| Measurement, Evidence, Backtesting, Loss Attribution | Shared Performance navigation and page hierarchy; metric, section and table styles. Existing populations, denominators, warnings and controls remain. |
| Signal Diagnostics | Dedicated research side navigation for its nine views; mobile uses a horizontally scrollable switcher. Filters and diagnostic content remain. |
| System Health | Services/feed content alongside exchange sessions and planned services on wide screens; stacked on smaller screens. Unknown services are still unknown, not assumed healthy. |
| Indices, F&O Explorer, scanners, Corporate Actions, Institutional Flow, Alerts, System Learning | Shared workspace chrome, headers, controls and surfaces. Existing page actions and data remain. |
| Asset workspaces | Matching header/surface styling and separate keyboard-accessible open/close buttons for instrument tabs. |
| Mobile and themes | Narrow icon rail, scrollable related-page navigation, wrapping filters, compact two-column metrics where width permits; Dark/Light/System themes retained. Light-theme action/status/error contrast corrected. |

Every existing navigation page remains available through All pages. Legacy URL aliases still resolve through the existing navigation map. The old sidebar expansion preference is retained in storage but the new rail intentionally has a fixed width. Unbuilt Positions/Settings routes remain labelled NOT IMPLEMENTED; this release does not invent those features.

## Verification

Actual outputs are retained in `evidence/`.

- **134 frontend tests passed in 20 files**, including four new navigation integration cases: directory coverage/search/routing, keyboard close, contextual page selection, and separately reachable instrument open/close controls. Existing read-only-source, theme/URL, paper-trade view, formatting, data-state, chart-zone and accessibility component tests pass.
- Web TypeScript and production build passed. Targeted ESLint passed for the new navigation, rail, topbar, asset tabs, shared cards/controls, Best Setups, System Health and the navigation tests. A clean repository-wide lint result is not claimed; legacy components retain existing lint debt.
- Chromium checks against a local production build cover the dashboard and **all 16 other navigation pages** in both themes at desktop and 390px mobile widths. The six principal non-dashboard views also receive contrast/control-name checks: Paper Trades, Best Setups, F&O Explorer, Measurement, Signal Diagnostics and System Health.
- Browser interactions cover directory search/no-match/Escape, all nine diagnostic view switches, paper-trade filter/reset/details, contextual navigation/browser Back, and resetting scroll on workspace changes. Dashboard regressions cover OB/FVG visibility, failed history, theme persistence/System changes, MCX Spot restriction and mobile overflow. No page errors or API write requests were observed in the passing run.
- Screenshots were inspected locally in dark/light and mobile. Fixture screenshots are labelled and excluded from the PR. Fixtures populate paper trades, candidates and parts of Measurement; other services exercise empty/unavailable states. This is not an authenticated production-data audit or exhaustive coverage of every populated legacy subview.

Checks caught an Escape interaction with a populated search field and three light-theme contrast cases; these were corrected before the final run. A stale local build-cache failure was resolved with a clean build, without changing application dependencies.

## Repeat browser checks

Build/start the web app and run from the repository root:

```sh
DESK_ALL_WORKSPACES=1 node scripts/ui/trading-desk-browser.cjs
```

Set `DESK_WORKSPACES_ONLY=1` to run only the non-dashboard suite. `DESK_QA_URL`, `DESK_QA_OUTPUT`, `DESK_CHROMIUM_EXECUTABLE` and `DESK_CHROMIUM_MODULE` remain optional. Playwright and Chromium must be available in development tooling; they are not new deployed application dependencies.

## Scope and rollout

All changes are frontend presentation/navigation, tests and documentation. No backend, analytics formula, strategy entry/exit, position sizing, API contract, database schema, broker execution or dependency is changed. Existing data and missing-data explanations remain authoritative. No migration is needed. Roll back by reverting the UI commit or redeploying the preceding frontend. Authenticated production smoke verification remains after deployment.
