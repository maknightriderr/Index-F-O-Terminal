export interface AutoReviewEvidence {
  subject: { symbol: string; strategy: string; sourceVersion: string; logicVersion: string; exchange: string; mode: string };
  facts: Array<{ id: string; text: string }>;
  missing: string[];
  issueCodes: string[];
  grossR: number | null;
  netR: number | null;
  measured: boolean;
}
export interface AutoReviewNarrative {
  summary: string;
  hypotheses: Array<{ explanation: string; evidenceIds: string[]; experiment: string }>;
}
export interface AutoReviewResult {
  signal_id: string;
  symbol: string;
  strategy: string;
  source_version: string;
  logic_version: string;
  exchange: string;
  mode: string;
  status: 'PENDING' | 'RUNNING' | 'RETRY' | 'COMPLETE';
  attempts: number;
  next_attempt_at: string;
  completed_at: string | null;
  evidence: AutoReviewEvidence | null;
  review: AutoReviewNarrative | null;
  provider: string | null;
  model: string | null;
  last_error: string | null;
}
export interface AutoReviewReport {
  available: boolean;
  enabled: boolean;
  aiConfigured: boolean;
  version: string;
  activatedAt: string | null;
  scope: string;
  counts: Record<string, number>;
  recent: AutoReviewResult[];
  repeated: Array<{ strategy: string; source_version: string; logic_version: string; exchange: string; mode: string; code: string; trades: number; profitable: number; losing: number; measured: number; net_r: number | null }>;
}
