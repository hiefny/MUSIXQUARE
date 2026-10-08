/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  disposeAccountActivityStats,
  flushAccountActivityStatsForRead,
  initAccountActivityStats,
} from '../../account/activity-stats.ts';
import { __resetAccountSessionForTests } from '../../account/session.ts';
import { __resetAccountStateForTests, applyAccountSession } from '../../account/state.ts';
import { bus } from '../../core/events.ts';
import { batchSetState, resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { __resetAccountUiForTests, initAccount, openAccountDialog } from '../account.ts';

const accountA = {
  configured: true,
  authenticated: true,
  account: { nickname: 'Alpha', profileComplete: true },
  statsScope: 'a'.repeat(43),
};
const accountB = {
  ...accountA,
  account: { nickname: 'Beta', profileComplete: true },
  statsScope: 'b'.repeat(43),
};
const html = readFileSync('index.html', 'utf8');

beforeEach(() => {
  vi.useFakeTimers();
  __resetAccountSessionForTests();
  __resetAccountUiForTests();
  __resetAccountStateForTests();
  resetState();
  bus.clear();
  sessionStorage.clear();
  localStorage.clear();
  const template = document.createElement('template');
  template.innerHTML = html;
  document.body.replaceChildren(template.content.querySelector('#account-dialog-overlay')!);
  document.documentElement.lang = 'en-US';
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
});

afterEach(async () => {
  __resetAccountUiForTests();
  __resetAccountSessionForTests();
  await disposeAccountActivityStats(false);
  __resetAccountStateForTests();
  clearAllManagedTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

it.each([false, true])(
  'renders the successor account without reopening (old activity flushed=%s)',
  async (flushOldActivity) => {
    let currentAccount = accountA;
    let resolveOldRead!: (response: Response) => void;
    const requests: Array<{ method: string; scope: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/auth/session') return Response.json(currentAccount);
        if (String(input) !== '/api/auth/stats')
          throw new Error(`Unexpected request: ${String(input)}`);
        const method = init?.method ?? 'GET';
        const scope = new Headers(init?.headers).get('X-MXQR-Account-Stats-Scope');
        requests.push({ method, scope });
        if (method === 'GET' && scope === accountA.statsScope) {
          return new Promise<Response>((resolve) => {
            resolveOldRead = resolve;
          });
        }
        if (scope !== currentAccount.statsScope) {
          return Response.json({ error: 'ACCOUNT_STATS_SCOPE_MISMATCH' }, { status: 409 });
        }
        return Response.json({ stats: { sessionCount: 84, listeningSeconds: 60, trackCount: 7 } });
      }),
    );
    // Match app bootstrap: the account UI subscribes before the collector.
    initAccount();
    initAccountActivityStats();
    await vi.advanceTimersByTimeAsync(0);
    batchSetState({
      'setup.sessionStarted': true,
      'network.myId': 'device-own',
      'network.myMemberId': 'member-a',
      'network.myMemberAuthenticated': true,
    });
    openAccountDialog();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveOldRead).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(1_500);
    if (flushOldActivity) await flushAccountActivityStatsForRead();
    currentAccount = accountB;
    applyAccountSession(accountB);
    await vi.advanceTimersByTimeAsync(0);
    resolveOldRead(
      Response.json({ stats: { sessionCount: 37, listeningSeconds: 0, trackCount: 0 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('account-dialog-title-edit-label')?.textContent).toBe('Beta');
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('84');
    expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(requests).toContainEqual({ method: 'GET', scope: accountB.statsScope });
  },
);
