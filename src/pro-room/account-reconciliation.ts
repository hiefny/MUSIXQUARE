import type { AccountSnapshot } from '../account/state.ts';

type ReconciliationKind = 'attach' | 'detach';

interface AuthenticatedTarget {
  kind: 'attach';
  nickname: string;
}

interface AnonymousTarget {
  kind: 'detach';
}

type ReconciliationTarget = AuthenticatedTarget | AnonymousTarget;

interface ProRoomAccountReconciliationViewer {
  isAuthenticated?: boolean;
  displayName: string;
}

interface ProRoomAccountReconciliationAdapter {
  isActive(): boolean;
  viewer(): ProRoomAccountReconciliationViewer | null;
  attach(signal: AbortSignal): Promise<void>;
  detach(signal: AbortSignal): Promise<void>;
  /** Revoke account-only local capabilities synchronously before network I/O. */
  failClosed(): void;
  /** Restore the server-projected capabilities only after account attachment wins. */
  acceptAuthenticated(): void;
  failed(kind: ReconciliationKind, error: unknown): void;
}

function targetFor(snapshot: Readonly<AccountSnapshot>): ReconciliationTarget | null {
  if (
    snapshot.status === 'authenticated' &&
    snapshot.account?.profileComplete &&
    snapshot.account.nickname
  ) {
    return { kind: 'attach', nickname: snapshot.account.nickname };
  }
  if (snapshot.status === 'anonymous') return { kind: 'detach' };
  // Loading and service-unavailable are uncertainty, not proof of logout.
  return null;
}

/**
 * Serializes optional account identity onto one already-authenticated PRO room
 * cookie. Every new definitive account state aborts older I/O and the loop
 * applies the newest target next, so an attach response can never win after a
 * logout (or vice versa).
 */
export class ProRoomAccountReconciler {
  #target: ReconciliationTarget | null = null;
  #generation = 0;
  #forceOperation = false;
  #operationAbort: AbortController | null = null;
  #run: Promise<void> | null = null;

  constructor(private readonly adapter: ProRoomAccountReconciliationAdapter) {}

  update(snapshot: Readonly<AccountSnapshot>): void {
    const viewer = this.adapter.viewer();
    const profileIncompleteAccountSwitch =
      snapshot.status === 'authenticated' &&
      snapshot.account?.profileComplete === false &&
      viewer?.isAuthenticated === true;
    // A Google account replacement may yield an authenticated but incomplete
    // profile. If this physical room session still carries the old account,
    // shed it immediately; initial anonymous onboarding remains a no-op until
    // the nickname is complete.
    const target =
      targetFor(snapshot) ??
      (profileIncompleteAccountSwitch ? ({ kind: 'detach' } as const) : null);
    if (!target) return;
    // The superseded request may already have committed at the server even
    // when abort prevents its response from updating the local viewer.
    this.#forceOperation = this.#operationAbort !== null;
    this.#target = target;
    this.#generation += 1;
    if (target.kind === 'detach') this.adapter.failClosed();
    this.#operationAbort?.abort();
    this.#start();
  }

  stop(): void {
    this.#operationAbort?.abort();
    this.#operationAbort = null;
    this.#target = null;
    this.#forceOperation = false;
    this.#generation += 1;
  }

  /** Test seam: resolves once the currently scheduled reconciliation is idle. */
  async idle(): Promise<void> {
    await this.#run;
  }

  #start(): void {
    if (this.#run || !this.#target || !this.adapter.isActive()) return;
    const run = this.#drain().finally(() => {
      if (this.#run !== run) return;
      this.#run = null;
      if (this.#target && this.adapter.isActive()) this.#start();
    });
    this.#run = run;
  }

  async #drain(): Promise<void> {
    while (this.#target && this.adapter.isActive()) {
      const generation = this.#generation;
      const target = this.#target;
      const forceOperation = this.#forceOperation;
      const viewer = this.adapter.viewer();
      if (!forceOperation && target.kind === 'detach' && viewer?.isAuthenticated !== true) {
        if (generation === this.#generation) {
          this.#target = null;
          this.#forceOperation = false;
          return;
        }
        continue;
      }

      const abort = new AbortController();
      this.#operationAbort = abort;
      try {
        if (target.kind === 'attach') await this.adapter.attach(abort.signal);
        else await this.adapter.detach(abort.signal);
        if (generation === this.#generation && target.kind === 'attach') {
          this.adapter.acceptAuthenticated();
        }
      } catch (error) {
        if (!abort.signal.aborted && generation === this.#generation) {
          this.adapter.failed(target.kind, error);
        }
      } finally {
        if (this.#operationAbort === abort) this.#operationAbort = null;
      }
      if (generation === this.#generation) {
        this.#target = null;
        this.#forceOperation = false;
        return;
      }
    }
  }
}
