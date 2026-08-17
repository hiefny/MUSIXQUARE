import { BOOTSTRAP_REQUIRED_STEPS } from './bootstrap-contract.ts';

type BootstrapStepPhase = 'sync' | 'async' | 'worker' | 'orchestration';
type BootstrapStepStatus = 'success' | 'failure' | 'fallback';
type BootstrapWiringState = 'ready' | 'degraded';

interface BootstrapStepOutcome {
  name: string;
  phase: BootstrapStepPhase;
  status: BootstrapStepStatus;
}

export interface BootstrapReadinessSnapshot {
  state: BootstrapWiringState;
  total: number;
  succeeded: number;
  failures: BootstrapStepOutcome[];
  fallbacks: BootstrapStepOutcome[];
  missingRequired: string[];
}

type BootstrapStepRunResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Observe bootstrap wiring without deciding product behavior. Failed steps are
 * recorded and returned to the caller, which retains the existing log-and-
 * continue policy.
 *
 * A caller may provide the complete required-step contract. Missing required
 * steps then degrade readiness even when every observed initializer succeeded,
 * preventing an accidentally omitted initializer from looking healthy.
 */
export class BootstrapReadinessLedger {
  private readonly outcomes = new Map<string, BootstrapStepOutcome>();
  private readonly requiredSteps: readonly string[];

  constructor(requiredSteps: readonly string[] = BOOTSTRAP_REQUIRED_STEPS) {
    this.requiredSteps = [...requiredSteps];
  }

  runSync<T>(
    name: string,
    fn: () => T,
    phase: BootstrapStepPhase = 'sync',
  ): BootstrapStepRunResult<T> {
    try {
      const value = fn();
      this.recordSuccess(name, phase);
      return { ok: true, value };
    } catch (error) {
      this.recordFailure(name, phase);
      return { ok: false, error };
    }
  }

  recordSuccess(name: string, phase: BootstrapStepPhase): boolean {
    return this.record(name, phase, 'success');
  }

  recordFailure(name: string, phase: BootstrapStepPhase): boolean {
    return this.record(name, phase, 'failure');
  }

  recordFallback(name: string, phase: BootstrapStepPhase): boolean {
    return this.record(name, phase, 'fallback');
  }

  snapshot(): BootstrapReadinessSnapshot {
    const outcomes = Array.from(this.outcomes.values());
    const failures = outcomes.filter((outcome) => outcome.status === 'failure');
    const fallbacks = outcomes.filter((outcome) => outcome.status === 'fallback');
    const succeeded = outcomes.filter((outcome) => outcome.status === 'success').length;
    const missingRequired = this.requiredSteps.filter((name) => !this.outcomes.has(name));

    return {
      state:
        failures.length > 0 || fallbacks.length > 0 || missingRequired.length > 0
          ? 'degraded'
          : 'ready',
      total: outcomes.length,
      succeeded,
      failures,
      fallbacks,
      missingRequired,
    };
  }

  private record(name: string, phase: BootstrapStepPhase, status: BootstrapStepStatus): boolean {
    const previous = this.outcomes.get(name);
    if (previous?.phase === phase && previous.status === status) return false;

    this.outcomes.set(name, { name, phase, status });
    return true;
  }
}

/**
 * Preserve the original async init boundary while recording its outcome. The
 * failure callback remains responsible for the existing log-and-continue
 * policy and may throw exactly as the previous catch body could.
 */
export async function runBootstrapStepAsync(
  ledger: BootstrapReadinessLedger,
  name: string,
  fn: () => void | Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await fn();
    ledger.recordSuccess(name, 'async');
  } catch (error) {
    ledger.recordFailure(name, 'async');
    onFailure(error);
  }
}

function formatOutcomeNames(outcomes: BootstrapStepOutcome[]): string {
  return outcomes.map(({ name, phase }) => `${name}[${phase}]`).join(', ');
}

export function formatBootstrapReadinessSummary(snapshot: BootstrapReadinessSnapshot): string {
  if (snapshot.state === 'ready') {
    return `[App] Bootstrap wiring ready (${snapshot.succeeded}/${snapshot.total})`;
  }

  const details: string[] = [];
  if (snapshot.failures.length > 0) {
    details.push(`failed: ${formatOutcomeNames(snapshot.failures)}`);
  }
  if (snapshot.fallbacks.length > 0) {
    details.push(`fallback: ${formatOutcomeNames(snapshot.fallbacks)}`);
  }
  if (snapshot.missingRequired.length > 0) {
    details.push(`missing: ${snapshot.missingRequired.join(', ')}`);
  }

  return (
    `[App] Bootstrap wiring degraded ` +
    `(${snapshot.succeeded}/${snapshot.total}; ` +
    `${snapshot.failures.length} failed, ${snapshot.fallbacks.length} fallback, ` +
    `${snapshot.missingRequired.length} missing): ` +
    details.join('; ')
  );
}
