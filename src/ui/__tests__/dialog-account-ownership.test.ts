/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { __resetAccountStateForTests, getAccountSnapshot } from '../../account/state.ts';
import { __resetAccountSessionForTests } from '../../account/session.ts';
import { __resetAccountUiForTests, initAccount, openAccountDialog } from '../account.ts';
import { closeDialog, showDialog } from '../dialog.ts';
import { __resetModalStackForTests, initOverlayObservers } from '../dom.ts';

vi.mock('../toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../user-text-font.ts', () => ({ applyUserTextFontFallback: vi.fn() }));
vi.mock('../../account/activity-stats.ts', () => ({
  flushAccountActivityStatsForRead: vi.fn().mockResolvedValue({ status: 'idle' }),
}));

const indexSource = readFileSync('index.html', 'utf8');
let popupUrl = '';
let pendingDialog: ReturnType<typeof showDialog> | null = null;

function element(id: string): HTMLElement {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing actual UI control: ${id}`);
  return result;
}

beforeEach(async () => {
  __resetAccountSessionForTests();
  __resetAccountUiForTests();
  __resetAccountStateForTests();
  __resetModalStackForTests();
  resetState();
  bus.clear();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  const markup = new DOMParser().parseFromString(indexSource, 'text/html');
  document.body.replaceChildren(
    ...['dialog-overlay', 'account-dialog-overlay'].map((id) =>
      document.importNode(markup.getElementById(id)!, true),
    ),
  );
  // jsdom lacks layout and native inert. Preserve actual hidden ancestors in
  // its visibility seam; the production legacy inert guard handles focus.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.closest('[hidden]') ? null : this.parentElement;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            configured: true,
            authenticated: false,
            account: null,
            statsScope: null,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  popupUrl = '';
  vi.spyOn(window, 'open').mockReturnValue({
    closed: false,
    opener: null,
    location: {
      replace: (url: string) => {
        popupUrl = url;
      },
    },
    focus: vi.fn(),
    close: vi.fn(),
  } as unknown as Window);
  initOverlayObservers();
  initAccount();
  await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
});

afterEach(async () => {
  closeDialog('test-cleanup');
  await pendingDialog;
  pendingDialog = null;
  __resetAccountUiForTests();
  __resetAccountSessionForTests();
  clearAllManagedTimers();
  __resetModalStackForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function coverPendingDialogWithOAuthCancellation(dismissible = false): Promise<void> {
  openAccountDialog();
  element('btn-account-google').click();
  const login = new URL(popupUrl, location.origin);
  const returnTo = new URL(login.searchParams.get('returnTo')!, location.origin);
  const accountClient = returnTo.searchParams.get('accountClient');
  expect(accountClient).toBeTruthy();
  element('btn-account-login-close').click();
  // Ordinary public dialog API, as used by audio/setup/leave confirmations.
  pendingDialog = showDialog({
    message: 'Pending confirmation',
    secondaryText: 'Cancel',
    dismissible,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(element('dialog-overlay').hasAttribute('inert')).toBe(false);
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: location.origin,
      data: { type: 'refresh', accountAuth: 'cancelled', id: 'result:cancelled', accountClient },
    }),
  );
  await Promise.resolve();
  expect(element('account-dialog-overlay').classList.contains('show')).toBe(true);
  expect(element('dialog-overlay').hasAttribute('inert')).toBe(true);
}

describe('common dialog keyboard ownership after an OAuth popup completes', () => {
  it.each([false, true])('lets the top Account dialog own Tab (shift=%s)', async (shiftKey) => {
    await coverPendingDialogWithOAuthCancellation();
    const account = element('account-dialog-overlay');
    const controls = [
      ...account.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]'),
    ].filter((candidate) => !candidate.hidden && candidate.offsetParent !== null);
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    (shiftKey ? first : last).focus();
    (shiftKey ? first : last).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(shiftKey ? last : first);
    expect(element('dialog-overlay').classList.contains('show')).toBe(true);

    // Once Account closes, the still-pending common dialog resumes ownership.
    element('btn-account-login-close').click();
    expect(element('dialog-overlay').hasAttribute('inert')).toBe(false);
    element('btn-dialog-ok').focus();
    element('btn-dialog-ok').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(element('btn-dialog-secondary'));
  });

  it('leaves native Tab navigation inside the top Account dialog unclaimed', async () => {
    await coverPendingDialogWithOAuthCancellation();
    const first = element('btn-account-google');
    first.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    first.dispatchEvent(tab);
    // Account only traps its two edges. Cancelling this native intermediate
    // Tab prevents the browser from advancing to its next Account control.
    expect(tab.defaultPrevented).toBe(false);
  });

  it('does not reuse Account Escape after Account synchronously uncovers the common dialog', async () => {
    await coverPendingDialogWithOAuthCancellation(true);
    element('btn-account-google').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(element('account-dialog-overlay').classList.contains('show')).toBe(false);
    expect(element('dialog-overlay').hasAttribute('inert')).toBe(false);
    expect(element('dialog-overlay').classList.contains('show')).toBe(true);

    // A new Escape belongs to the newly uncovered dismissible dialog.
    element('btn-dialog-secondary').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(element('dialog-overlay').classList.contains('show')).toBe(false);
  });
});
