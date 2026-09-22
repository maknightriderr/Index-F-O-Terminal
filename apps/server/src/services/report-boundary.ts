// ============================================================
// THE REPORT BOUNDARY
// ============================================================
// One instant per report, created once, at the top, by one function.
//
// Every figure in one report must be evaluated against the SAME instant. An
// earlier report compared a Greek count taken at 16:12 against a leg count
// taken at 16:18 and a capture-run count from 16:03; the six-minute drift
// between the first two looked exactly like a missing 82-leg snapshot. It
// was not a lineage gap — it was three questions asked at three times.
//
// Passing a boundary to the sections that accepted one fixed most of that,
// but the sections that made their own clock reads were still free to drift:
//
//   report_as_of    19:12:26.097Z
//   coverage_as_of  19:12:26.172Z   <- captureTimeline's own new Date()
//   chains.asOf     19:12:26.244Z   <- chainCompleteness's own new Date()
//
// Small drift, but the same defect: the response as a whole did not describe
// a single instant, and nothing in it said so. A reader comparing a figure
// from one section against another had no guarantee they were commensurable.
//
// So the boundary is created exactly once per request, by createReportAsOf(),
// and every bounded section receives it. No section below the entry point
// may call new Date(), Date.now() or a clock to build a query bound.
//
// This module is pure and dependency-free so a test can exercise the
// boundary contract without standing up a database pool.
//
// Nothing here is read by the trading engine.
// ============================================================

export interface ReportBoundary {
  /** Upper bound for every query in this report. */
  asOf: Date;
}

/**
 * Creates THE boundary for one report.
 *
 * This is the only place a diagnostics request is permitted to read the
 * clock. Call it once, at the top of the handler, and pass the result down.
 */
export function createReportAsOf(asOf: Date = new Date()): ReportBoundary {
  return { asOf };
}

/** The original name, kept so existing call sites and tests keep working. */
export function newBoundary(asOf: Date = new Date()): ReportBoundary {
  return createReportAsOf(asOf);
}

/**
 * A section's declared instant, and whether it is a query bound at all.
 *
 * Not every timestamp in the report is a boundary. A milestone records when
 * something happened; it is EVIDENCE time and is legitimately older than the
 * report. Listing those separately is what stops "as_of consistency" from
 * being either meaningless (comparing unlike things) or wrong (forcing an
 * evidence timestamp to equal the reading instant).
 */
export interface SectionBoundary {
  section: string;
  as_of: string | null;
  /** 'query_bound' must equal report_as_of. 'evidence_time' must not be forced to. */
  kind: 'query_bound' | 'evidence_time' | 'unbounded';
  /** Why, for the sections that are not query-bounded. */
  reason?: string;
}

export interface BoundaryContract {
  report_as_of: string;
  as_of_consistent: boolean;
  violations: {
    section: string;
    as_of: string | null;
    issue: string;
  }[];
  sections: SectionBoundary[];
  note: string;
}

/**
 * Checks every section's instant against the one report boundary.
 *
 * A query-bounded section must state exactly the report instant. Anything
 * later is impossible unless the section read its own clock, which is the
 * defect this contract exists to catch; anything earlier means it was
 * bounded at a different instant and its figures are not commensurable with
 * the rest of the report.
 */
export function checkBoundaries(reportAsOf: Date, sections: SectionBoundary[]): BoundaryContract {
  const expected = reportAsOf.toISOString();
  const violations: BoundaryContract['violations'] = [];

  for (const s of sections) {
    if (s.kind !== 'query_bound') continue;
    if (s.as_of == null) {
      violations.push({ section: s.section, as_of: null, issue: 'query-bounded section states no as_of' });
      continue;
    }
    if (s.as_of === expected) continue;
    const drift = Date.parse(s.as_of) - reportAsOf.getTime();
    violations.push({
      section: s.section,
      as_of: s.as_of,
      issue:
        drift > 0
          ? `section as_of is ${drift}ms LATER than report_as_of — it read its own clock instead of using the report boundary`
          : `section as_of is ${-drift}ms EARLIER than report_as_of — it was bounded at a different instant, so its figures are not commensurable with the rest of this report`,
    });
  }

  return {
    report_as_of: expected,
    as_of_consistent: violations.length === 0,
    violations,
    sections,
    note:
      'Every section marked query_bound was evaluated against report_as_of exactly. Sections marked evidence_time carry historical instants describing when something happened and are older than report_as_of by construction; they are not boundary violations. Sections marked unbounded state no instant because they read no time-varying data.',
  };
}
