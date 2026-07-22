export const OPS_DRIFT_CONTRACT_PATH: string;
export const DEFAULT_OPS_DRIFT_REPORT_PATH: string;

export interface OpsDriftContract {
  schemaVersion: number;
  r2Cors: Array<{ bucket: string; source: string }>;
  github: {
    repository: string;
    branch: string;
    requiredEffectiveRuleTypes: string[];
  };
  manualChecks: Array<{ id: string; label: string; runbook: string; reason: string }>;
}
export type OpsDriftCheckStatus = 'pass' | 'drift' | 'error' | 'manual-only';
export interface OpsDriftCheck {
  id: string;
  label: string;
  status: OpsDriftCheckStatus;
  detail: string;
}
export interface OpsDriftReport {
  schemaVersion: number;
  generatedAt: string;
  status: 'attention-required' | 'automated-checks-passed';
  checks: OpsDriftCheck[];
}
export type OpsDriftFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function loadOpsDriftContract(root?: string): OpsDriftContract;
export function assertOpsDriftContract(options?: { root?: string; contract?: OpsDriftContract }): {
  schemaVersion: number;
  r2PolicyCount: number;
  githubRuleCount: number;
  manualCheckCount: number;
};
export function normalizeCorsPolicy(
  value: unknown,
  label?: string,
  options?: { exactKeys?: boolean },
): Array<{
  allowed: { origins: string[]; methods: string[]; headers: string[] };
  exposeHeaders: string[];
  maxAgeSeconds: number;
}>;
export function runOpsDriftAudit(options?: {
  root?: string;
  contract?: OpsDriftContract;
  fetcher?: OpsDriftFetcher;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<OpsDriftReport>;
export function renderOpsDriftMarkdown(report: OpsDriftReport): string;
