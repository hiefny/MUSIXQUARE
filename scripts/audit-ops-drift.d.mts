export const OPS_DRIFT_CONTRACT_PATH: string;
export const DEFAULT_OPS_DRIFT_REPORT_PATH: string;

export interface OpsDriftContract {
  schemaVersion: number;
  r2Cors: Array<{ bucket: string; source: string }>;
  r2Lifecycle: {
    exactPolicies: Array<{ bucket: string; source: string }>;
    forbiddenShortDeletePolicies: Array<{ bucket: string; maxAgeSeconds: number }>;
  };
  workerSecrets: Array<{ worker: string; expectedNames: string[] }>;
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
  r2CorsPolicyCount: number;
  r2ExactLifecyclePolicyCount: number;
  r2ShortLifecycleGuardCount: number;
  workerSecretPolicyCount: number;
  workerSecretNameCount: number;
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
export interface NormalizedLifecycleCondition {
  type: 'Age' | 'Date';
  maxAge?: number;
  date?: string;
}
export interface NormalizedLifecycleRule {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  abortMultipartUploadsTransition: { condition: NormalizedLifecycleCondition } | null;
  deleteObjectsTransition: { condition: NormalizedLifecycleCondition } | null;
  storageClassTransitions: Array<{
    condition: NormalizedLifecycleCondition;
    storageClass: 'InfrequentAccess';
  }>;
}
export function normalizeLifecyclePolicy(
  value: unknown,
  label?: string,
  options?: { exactKeys?: boolean; allowEmptyPrefixOmission?: boolean },
): NormalizedLifecycleRule[];
export function shortDeleteLifecycleRules(
  policy: NormalizedLifecycleRule[],
  maxAgeSeconds: number,
): string[];
export function normalizeWorkerSecretNames(value: unknown, label?: string): string[];
export function runOpsDriftAudit(options?: {
  root?: string;
  contract?: OpsDriftContract;
  fetcher?: OpsDriftFetcher;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<OpsDriftReport>;
export function renderOpsDriftMarkdown(report: OpsDriftReport): string;
