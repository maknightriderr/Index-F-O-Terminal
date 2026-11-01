# Transaction-time entry freshness

Next-phase work after PR94 merge `062006ccb021ef58428306ace88adf69b3c81739`,1 November2026. This fixes elapsed database-wait time being omitted from new paper-entry quote and deadline checks.

## Implementation

The store now owns an injectable current clock, defaulting to `Date.now` in production. Historical synthetic fixtures explicitly supply their simulated decision clock; production never derives elapsed time from the frozen request timestamp.

After portfolio/account locking and duplicate/refusal lookup, the selected exact quote is checked against the current clock. The same checks run again after remaining admission reads and once more after staging the entry event, before returning the transaction callback for commit:

- The clock must be finite and cannot precede the request or latest admission time. A bad/backward clock refuses with `ENTRY_CLOCK_UNAVAILABLE`.
- The existing source/contract/epoch and two-second quote eligibility check must still pass. No larger quote-age allowance is introduced.
- The setup must remain unexpired and the existing last-hour entry cutoff must not have been reached.

Admission uses the current checked time for quote/mark eligibility, position opening time, candidate/entry evidence and cooldown calculation. A copied request carries that admitted timestamp; the caller's original request and quote are unchanged. The original first post-arrival quote is not replaced by a later, more favorable quote.

All locked open positions' liquidation marks are assessed at the new admission time. Their complete source/contract/epoch/age/depth eligibility is checked again before commit. An old held mark cannot preserve permission to add risk merely because the new option's own quote is still fresh. Failed final checks throw the private typed transaction rejection so staged candidate, parent, position and event writes roll back. Existing account/exposure/history remains intact; exit observation is unchanged.

Duplicate delivery is handled before trying to authorize a new fill: an already committed position remains `ALREADY_FILLED` even when its old quote has since expired. This does not reserve/mint again. Prior durable refusal lookup likewise remains intact.

## Evidence

Real PGlite regression cases advance the injected clock after portfolio lock acquisition, final admission reads, or entry-event staging. They independently exercise stale quotes, setup expiry, the exact entry cutoff, backward time and a nonfinite clock, and check rollback across all affected tables plus caller-input immutability. Additional checks cover current-time entry evidence, unchanged selected quote, held-mark expiry while the new quote remains fresh, preserved prior exposure and late idempotent delivery.

The existing real shared-feed/PGlite adapter tests for NSE/BSE/MCX pass with their explicit simulated clocks; their observed-quote, arrival, policy and cost assertions are retained. Injecting historical time makes those test inputs explicit; it is not a production time override or loosening of any freshness limit.

## Boundaries

These checks sample conditions before asking the database to commit. They do not cancel a commit already in progress, certify broker fills or refresh a frozen quote/reference/event snapshot. A rejected stale request needs genuinely new eligible evidence through the normal candidate path; no missing data or old records are synthesized. Actual market-session observations, independent Angel MCX depth-unit qualification and statistical/holdout validation remain outstanding where absent.

No strategy/risk/exit threshold, strategy version, portfolio counter, account-day reset, schema, dependency, timer, subscription or live-order path changes.

Final verification: server1,990 passed with5 existing skips; server production build passed. PR94's Railway deployment `a4df583c-4045-4df2-ad43-844405cccc51` and Vercel web both succeeded. Live readiness returned HTTP200 at `062006c`, database/Redis/schema/broker authentication true. The separate unused Vercel server check remains failed. This freshness fix is prepared in a separate next-phase branch, not that deployed PR94 binary.
