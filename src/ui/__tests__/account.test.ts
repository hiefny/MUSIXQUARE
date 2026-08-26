/** @vitest-environment jsdom */

import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import {
  __resetAccountStateForTests,
  applyAccountSession,
  getAccountSnapshot,
} from '../../account/state.ts';
import { showDialog } from '../dialog.ts';
import { showToast } from '../toast.ts';
import {
  __resetAccountUiForTests,
  initAccount,
  openAccountDialog,
  requestAccountNicknameChange,
} from '../account.ts';
import { __resetAccountSessionForTests, requestAccountLoginPopup } from '../../account/session.ts';
import { updateCurrentAccountNickname } from '../../account/nickname.ts';
import { clearIntentionalNav, isIntentionalNav } from '../../core/page-lifecycle.ts';
import {
  __accountLoginReturnForTests,
  rememberAccountLoginReturn,
} from '../../account/login-return.ts';
import { flushAccountActivityStatsForRead } from '../../account/activity-stats.ts';
import { resetState, setState } from '../../core/state.ts';

const STATS_SCOPE = 's'.repeat(43);

vi.mock('../dialog.ts', () => ({ showDialog: vi.fn() }));
vi.mock('../toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../../account/activity-stats.ts', () => ({
  flushAccountActivityStatsForRead: vi.fn().mockResolvedValue({ status: 'idle' }),
}));

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderAccountDialog(): void {
  document.body.innerHTML = `
    <button id="opener">open</button>
    <div id="account-dialog-overlay" aria-hidden="true">
      <div id="account-dialog" aria-busy="false" tabindex="-1">
        <span
          class="dialog-title account-dialog-static-title"
          id="account-dialog-title"
        ></span>
        <button class="account-dialog-title-edit" id="btn-account-title-edit" hidden>
          <span
            class="dialog-title account-dialog-title-edit-label"
            id="account-dialog-title-edit-label"
          ></span>
          <svg id="account-dialog-title-edit-icon"></svg>
        </button>
        <div id="account-dialog-content">
          <p id="account-dialog-message"></p>
          <strong id="account-dialog-nickname" hidden></strong>
        </div>
        <div id="account-dialog-login-actions" hidden>
          <a id="btn-account-google" hidden><span id="account-google-label"></span></a>
          <button
            class="dialog-secondary account-dialog-login-close"
            id="btn-account-login-close"
            hidden
          ></button>
          <nav id="account-legal-links" hidden>
            <a id="account-terms" href="/terms"></a>
            <a id="account-privacy" href="/privacy"></a>
          </nav>
        </div>
        <dl id="account-dialog-stats" aria-live="polite" aria-busy="false" hidden>
          <div class="account-dialog-stat-row">
            <dt id="account-stats-sessions-label"></dt>
            <dd id="account-stats-session-count">-</dd>
          </div>
          <div class="account-dialog-stat-row">
            <dt id="account-stats-listening-label"></dt>
            <dd id="account-stats-listening-time">-</dd>
          </div>
          <div class="account-dialog-stat-row">
            <dt id="account-stats-tracks-label"></dt>
            <dd id="account-stats-track-count">-</dd>
          </div>
        </dl>
        <div id="account-dialog-actions" hidden>
          <button id="btn-account-logout"></button>
          <button id="btn-account-delete"></button>
          <button
            class="dialog-primary account-dialog-account-close"
            id="btn-account-center-close"
          ></button>
        </div>
      </div>
    </div>
  `;
}

beforeEach(() => {
  __resetAccountSessionForTests();
  __resetAccountUiForTests();
  __resetAccountStateForTests();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  vi.mocked(flushAccountActivityStatsForRead).mockResolvedValue({ status: 'idle' });
  renderAccountDialog();
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })),
  );
  document.documentElement.lang = 'en-US';
  sessionStorage.clear();
  localStorage.clear();
  clearIntentionalNav();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  __resetAccountSessionForTests();
  __resetAccountUiForTests();
  resetState();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('optional account UI', () => {
  it('fails closed without same-tab storage when the protected login popup is blocked', async () => {
    applyAccountSession({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    vi.spyOn(window, 'open').mockReturnValue(null);

    await expect(requestAccountLoginPopup()).resolves.toBe('blocked');

    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
    expect(isIntentionalNav()).toBe(false);
  });

  it('resolves protected popup login only after a completed account profile exists', async () => {
    applyAccountSession({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    const popup = {
      closed: false,
      focus: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    const login = requestAccountLoginPopup();
    let settled = false;
    const observedLogin = login.then((outcome) => {
      settled = true;
      return outcome;
    });
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: {
        nickname: '',
        profileComplete: false,
      },
      statsScope: null,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    applyAccountSession({
      configured: true,
      authenticated: true,
      account: {
        nickname: 'Owner',
        profileComplete: true,
      },
      statsScope: null,
    });

    await expect(observedLogin).resolves.toBe('authenticated');
  });

  it('reuses the exact non-force popup reconciliation after completion auto-close', async () => {
    vi.useFakeTimers();
    applyAccountSession({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    let resolveSession!: (response: Response) => void;
    const fetchMock = vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveSession = resolve;
      }),
    );
    let popupClosed = false;
    const replace = vi.fn();
    const popup = {
      get closed() {
        return popupClosed;
      },
      focus: vi.fn(),
      location: { replace },
      opener: window,
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    const login = requestAccountLoginPopup();
    const startUrl = String(replace.mock.calls[0]?.[0] || '');
    const returnTo = new URL(startUrl, window.location.origin).searchParams.get('returnTo') || '';
    const accountClient = new URL(returnTo, window.location.origin).searchParams.get(
      'accountClient',
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'refresh',
          accountAuth: 'success',
          id: 'result:non-force-deferred',
          accountClient,
        },
      }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    popupClosed = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getAccountSnapshot().status).toBe('anonymous');

    resolveSession(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Owner', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );
    await expect(login).resolves.toBe('authenticated');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getAccountSnapshot()).toMatchObject({
      status: 'authenticated',
      account: { nickname: 'Owner', profileComplete: true },
    });
  });

  it('returns an incomplete protected identity without a nickname prompt and can force the Google chooser again', async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, authenticated: false, account: null, statsScope: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Linked owner', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Linked owner', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Linked owner', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));

    let popupClosed = false;
    const replace = vi.fn();
    const firstPopup = {
      get closed() {
        return popupClosed;
      },
      focus: vi.fn(),
      location: { replace },
      opener: window,
    } as unknown as Window;
    // Browsers may reuse a still-open named completion window. The second
    // user gesture must nevertheless call window.open and navigate that shell
    // back through Google's explicit account chooser.
    const open = vi.spyOn(window, 'open').mockReturnValue(firstPopup);

    const firstLogin = requestAccountLoginPopup({ acceptIncompleteProfile: true });
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: '', profileComplete: false },
      statsScope: null,
    });

    await expect(firstLogin).resolves.toBe('profile-incomplete');
    expect(showDialog).not.toHaveBeenCalled();

    // Cancelling the claim after this outcome must not allow a delayed
    // visibility/session notification to surface the generic nickname modal.
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: '', profileComplete: false },
      statsScope: null,
    });
    await Promise.resolve();
    expect(showDialog).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const switchedLogin = requestAccountLoginPopup({
      acceptIncompleteProfile: true,
      forceGoogleAccountChooser: true,
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(firstPopup.location.replace).toHaveBeenCalledTimes(2);
    expect(firstPopup.location.replace).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/auth/google/start?'),
    );

    let switchedSettled = false;
    const observedSwitchedLogin = switchedLogin.then((outcome) => {
      switchedSettled = true;
      return outcome;
    });
    // A duplicate refresh from the first OAuth completion must not be
    // mistaken for the forced chooser's result while that popup is live.
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: '', profileComplete: false },
      statsScope: null,
    });
    await Promise.resolve();
    expect(switchedSettled).toBe(false);

    const switchedStartUrl = String(replace.mock.calls.at(-1)?.[0] || '');
    const switchedReturnTo =
      new URL(switchedStartUrl, window.location.origin).searchParams.get('returnTo') || '';
    const accountClient = new URL(switchedReturnTo, window.location.origin).searchParams.get(
      'accountClient',
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'refresh',
          accountAuth: 'success',
          id: 'result:protected-1234',
          accountClient,
        },
      }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // A success marker only correlates the welcome. It must not settle the
    // protected authorization promise before the popup-close reconciliation.
    expect(switchedSettled).toBe(false);

    popupClosed = true;
    await vi.advanceTimersByTimeAsync(250);
    vi.useRealTimers();

    await expect(observedSwitchedLogin).resolves.toBe('authenticated');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getAccountSnapshot().account).toMatchObject({
      nickname: 'Linked owner',
      profileComplete: true,
    });
  });

  it('treats declining nickname completion as a cancelled protected login', async () => {
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: {
        nickname: '',
        profileComplete: false,
      },
      statsScope: null,
    });
    vi.mocked(showDialog).mockResolvedValueOnce({ action: 'secondary' });
    const open = vi.spyOn(window, 'open');

    await expect(requestAccountLoginPopup()).resolves.toBe('cancelled');

    expect(open).not.toHaveBeenCalled();
  });

  it('renders Google login and legal links for an anonymous configured app', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));

    openAccountDialog();

    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    expect(document.getElementById('btn-account-google')?.hidden).toBe(false);
    expect(document.getElementById('btn-account-google')?.getAttribute('href')).toContain(
      '/api/auth/google/start?returnTo=',
    );
    expect(document.getElementById('account-google-label')?.textContent).not.toBe('');
    expect(document.getElementById('account-legal-links')?.hidden).toBe(false);
    expect(document.getElementById('account-dialog-title')?.hidden).toBe(false);
    expect(document.getElementById('account-dialog-login-actions')?.hidden).toBe(false);
    expect(document.getElementById('account-dialog')?.dataset.accountView).toBe('login');
    expect(document.getElementById('account-dialog')?.getAttribute('aria-labelledby')).toBe(
      'account-dialog-title',
    );
    expect(document.getElementById('btn-account-title-edit')?.hidden).toBe(true);
    const close = document.getElementById('btn-account-login-close');
    expect(close?.hidden).toBe(false);
    expect(close?.textContent).toBe('Close');
    expect(close?.classList.contains('dialog-secondary')).toBe(true);
    expect(close?.classList.contains('dialog-primary')).toBe(false);
    expect(
      document.getElementById('btn-account-google')?.compareDocumentPosition(close as Node),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows a primary close action while account availability is loading', async () => {
    let resolveSession!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveSession = resolve;
      }),
    );
    initAccount();

    openAccountDialog();

    const close = document.getElementById('btn-account-login-close') as HTMLButtonElement;
    expect(getAccountSnapshot().status).toBe('loading');
    expect(document.getElementById('account-dialog-title')?.textContent).toBe('Account');
    expect(document.getElementById('account-dialog-login-actions')?.hidden).toBe(false);
    expect(document.getElementById('btn-account-google')?.hidden).toBe(true);
    expect(close.hidden).toBe(false);
    expect(close.classList.contains('dialog-primary')).toBe(true);
    expect(close.classList.contains('dialog-secondary')).toBe(false);

    close.click();
    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      false,
    );

    resolveSession(jsonResponse({ configured: true, authenticated: false, account: null }));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
  });

  it('uses a completion popup from an installed PWA so an active room stays live', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    setState('setup.sessionStarted', true);
    const focus = vi.fn();
    const replace = vi.fn();
    const popup = {
      closed: false,
      focus,
      location: { replace },
      opener: window,
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();

    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    let preventedByAccountHandler = false;
    google.addEventListener('click', (event) => {
      preventedByAccountHandler = event.defaultPrevented;
      event.preventDefault();
    });
    google.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));

    expect(open).toHaveBeenCalledWith(
      'about:blank',
      expect.stringMatching(/^mxqr-google-login-/),
      expect.stringContaining('popup=yes'),
    );
    expect(replace).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/api\/auth\/google\/start\?returnTo=%2Faccount-complete\.html%3FaccountClient%3D/,
      ),
    );
    expect(popup.opener).toBeNull();
    expect(focus).toHaveBeenCalledOnce();
    expect(preventedByAccountHandler).toBe(true);
  });

  it('falls back to ordinary same-tab navigation when an idle PWA popup is blocked', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();

    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    let preventedByAccountHandler = true;
    google.addEventListener('click', (event) => {
      preventedByAccountHandler = event.defaultPrevented;
      event.preventDefault();
    });
    const click = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    google.dispatchEvent(click);

    expect(open).toHaveBeenCalledOnce();
    expect(preventedByAccountHandler).toBe(false);
    expect(google.getAttribute('href')).toContain('returnTo=%2F');
  });

  it('keeps an active PWA room in place when the login popup is blocked', async () => {
    window.history.replaceState({}, '', '/?panel=connect#account');
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    setState('setup.sessionStarted', true);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();

    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    let preventedByAccountHandler = false;
    google.addEventListener('click', (event) => {
      preventedByAccountHandler = event.defaultPrevented;
    });
    const click = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    google.dispatchEvent(click);

    expect(open).toHaveBeenCalledOnce();
    expect(preventedByAccountHandler).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/?panel=connect#account',
    );
    expect(isIntentionalNav()).toBe(false);
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('mxqr-account-welcome-intent-v1')).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
    expect(showToast).toHaveBeenCalledWith('Could not sign in. Please try again.');
  });

  it('keeps an active room in place when opening the login popup throws', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    setState('setup.sessionStarted', true);
    vi.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('popup unavailable');
    });
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();

    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    const click = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    google.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(isIntentionalNav()).toBe(false);
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
    expect(showToast).toHaveBeenCalledWith('Could not sign in. Please try again.');
  });

  it('closes a failed popup bootstrap without replacing an active room', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    setState('setup.sessionStarted', true);
    const close = vi.fn();
    const popup = {
      closed: false,
      close,
      focus: vi.fn(),
      location: {
        replace: vi.fn(() => {
          throw new Error('navigation unavailable');
        }),
      },
      opener: window,
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();

    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    const click = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    google.dispatchEvent(click);

    expect(close).toHaveBeenCalledOnce();
    expect(click.defaultPrevented).toBe(true);
    expect(isIntentionalNav()).toBe(false);
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
    expect(showToast).toHaveBeenCalledWith('Could not sign in. Please try again.');
  });

  it('preserves the PRO route in a PWA even before room context projection is ready', async () => {
    window.history.replaceState({}, '', '/000001?panel=connect#account');
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    vi.spyOn(window, 'open').mockReturnValue(null);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();

    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    let hrefAtActivation = '';
    google.addEventListener('click', (event) => {
      hrefAtActivation = google.getAttribute('href') || '';
      event.preventDefault();
    });
    google.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));

    const returnTo = new URL(hrefAtActivation, window.location.origin).searchParams.get('returnTo');
    expect(returnTo).toBe('/000001?panel=connect#account');
  });

  it('restores an anonymous PRO route when a closed PWA relaunches at the manifest start URL', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    rememberAccountLoginReturn('/000001?panel=connect#account', '000001');
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );

    initAccount();

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001',
    );
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    expect(getAccountSnapshot().account).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).not.toBeNull();
  });

  it('leaves the room and return storage untouched when only the in-app modal is closed', async () => {
    window.history.replaceState({}, '', '/000001?panel=connect#account');
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();

    document.getElementById('btn-account-login-close')?.click();

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001?panel=connect#account',
    );
    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      false,
    );
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cleans a same-tab fallback marker when the OAuth anchor navigation is cancelled', async () => {
    window.history.replaceState({}, '', '/000001');
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();
    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    google.addEventListener('click', (event) => event.preventDefault());

    google.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(window.location.pathname).toBe('/000001');
    expect(isIntentionalNav()).toBe(false);
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });

  it('keeps a slow same-tab OAuth navigation recoverable beyond two seconds', async () => {
    window.history.replaceState({}, '', '/000001');
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();
    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    // Keep jsdom on this document without cancelling the activation. The app's
    // cancellation microtask must therefore treat it like a slow, still-live
    // navigation rather than deleting its recovery state on elapsed time.
    google.addEventListener('click', () => google.removeAttribute('href'));

    vi.useFakeTimers();
    google.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(2_500);

    expect(isIntentionalNav()).toBe(true);
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).not.toBeNull();
    expect(sessionStorage.getItem('mxqr-account-welcome-intent-v1')).not.toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 2_500);
    expect(isIntentionalNav()).toBe(false);
    // The guard timer owns only the unload exemption. Stored recovery state is
    // independently validated and expired by the login-return parser.
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).not.toBeNull();
    vi.useRealTimers();
  });

  it('focuses one live login popup instead of overwriting its OAuth state', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    const focus = vi.fn();
    const popup = {
      closed: false,
      focus,
      location: { replace: vi.fn() },
      opener: window,
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();
    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;

    google.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
    google.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));

    expect(open).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('forces a session reconciliation when the login popup is manually closed', async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, authenticated: false, account: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, authenticated: false, account: null }),
      );
    let popupClosed = false;
    const popup = {
      get closed() {
        return popupClosed;
      },
      focus: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();

    vi.useFakeTimers();
    document.getElementById('btn-account-google')?.click();
    popupClosed = true;
    await vi.advanceTimersByTimeAsync(250);
    vi.useRealTimers();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(getAccountSnapshot().status).toBe('anonymous');
  });

  it('restores the login dialog after a same-tab PWA cancellation and removes only its marker', async () => {
    window.history.replaceState({}, '', '/000001?panel=chat&accountAuth=cancelled#messages');
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );

    initAccount();

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001?panel=chat#messages',
    );
    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    expect(showToast).toHaveBeenCalledWith('Sign-in was cancelled.');
  });

  it('deduplicates popup auth errors delivered over multiple completion channels', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    const focus = vi.fn();
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      focus,
      location: { replace },
      opener: window,
    } as unknown as Window);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();
    document.getElementById('btn-account-google')?.click();
    const startUrl = String(replace.mock.calls[0]?.[0] || '');
    const returnTo = new URL(startUrl, window.location.origin).searchParams.get('returnTo') || '';
    const accountClient = new URL(returnTo, window.location.origin).searchParams.get(
      'accountClient',
    );
    const data = {
      type: 'refresh',
      accountAuth: 'error',
      id: 'result:dedupe-1234',
      accountClient,
    };

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { ...data, id: 'result:another-tab', accountClient: 'another-tab-client' },
      }),
    );
    expect(showToast).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data }));
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data }));

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Could not sign in. Please try again.');
    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    // The first unrelated same-origin refresh starts immediately. The two
    // matching completion messages arrive while it is in flight and coalesce
    // into one follow-up refresh, which must settle before test teardown.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });

  it('welcomes an existing user once after this tab completes popup OAuth', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, authenticated: false, account: null, statsScope: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Minsu', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Minsu', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      );
    const replace = vi.fn();
    let popupClosed = false;
    vi.spyOn(window, 'open').mockReturnValue({
      get closed() {
        return popupClosed;
      },
      focus: vi.fn(),
      location: { replace },
      opener: window,
    } as unknown as Window);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));

    document.getElementById('btn-account-google')?.click();
    const startUrl = String(replace.mock.calls[0]?.[0] || '');
    const returnTo = new URL(startUrl, window.location.origin).searchParams.get('returnTo') || '';
    const accountClient = new URL(returnTo, window.location.origin).searchParams.get(
      'accountClient',
    );
    const data = {
      type: 'refresh',
      accountAuth: 'success',
      id: 'result:welcome-1234',
      accountClient,
    };

    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data }));
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data }));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'mxqr-account-refresh',
        newValue: JSON.stringify(data),
      }),
    );

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Welcome back\nMinsu'));
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    popupClosed = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not welcome this tab after another tab completes OAuth', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, authenticated: false, account: null, statsScope: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Minsu', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'refresh',
          accountAuth: 'success',
          id: 'result:external-1234',
          accountClient: 'another-tab-client',
        },
      }),
    );

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('consumes a popup welcome intent when the new account profile is incomplete', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, authenticated: false, account: null, statsScope: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: '', profileComplete: false },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: '', profileComplete: false },
          statsScope: STATS_SCOPE,
        }),
      );
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      focus: vi.fn(),
      location: { replace },
      opener: window,
    } as unknown as Window);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    document.getElementById('btn-account-google')?.click();
    const startUrl = String(replace.mock.calls[0]?.[0] || '');
    const returnTo = new URL(startUrl, window.location.origin).searchParams.get('returnTo') || '';
    const accountClient = new URL(returnTo, window.location.origin).searchParams.get(
      'accountClient',
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'refresh',
          accountAuth: 'success',
          id: 'result:new-account-1234',
          accountClient,
        },
      }),
    );

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(getAccountSnapshot().account?.profileComplete).toBe(false);
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'New nickname', profileComplete: true },
      statsScope: STATS_SCOPE,
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not defer a failed post-OAuth classification until a later recovery', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, authenticated: false, account: null, statsScope: null }),
      )
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('offline'));
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      focus: vi.fn(),
      location: { replace },
      opener: window,
    } as unknown as Window);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    document.getElementById('btn-account-google')?.click();
    const startUrl = String(replace.mock.calls[0]?.[0] || '');
    const returnTo = new URL(startUrl, window.location.origin).searchParams.get('returnTo') || '';
    const accountClient = new URL(returnTo, window.location.origin).searchParams.get(
      'accountClient',
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'refresh',
          accountAuth: 'success',
          id: 'result:offline-1234',
          accountClient,
        },
      }),
    );

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('unavailable'));
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
      statsScope: STATS_SCOPE,
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('clears a failed welcome intent even when an older authenticated snapshot stays visible', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Old account', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('offline'));
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      focus: vi.fn(),
      location: { replace },
      opener: window,
    } as unknown as Window);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    let loginError: unknown = null;
    requestAccountLoginPopup({ forceGoogleAccountChooser: true }).then(undefined, (error) => {
      loginError = error;
    });
    const startUrl = String(replace.mock.calls[0]?.[0] || '');
    const returnTo = new URL(startUrl, window.location.origin).searchParams.get('returnTo') || '';
    const accountClient = new URL(returnTo, window.location.origin).searchParams.get(
      'accountClient',
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'refresh',
          accountAuth: 'success',
          id: 'result:authenticated-offline-1234',
          accountClient,
        },
      }),
    );

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(getAccountSnapshot().account?.nickname).toBe('Old account');
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Later recovery', profileComplete: true },
      statsScope: STATS_SCOPE,
    });
    expect(loginError).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('welcomes an existing user after an armed same-tab OAuth success return', async () => {
    sessionStorage.setItem(
      'mxqr-account-welcome-intent-v1',
      JSON.stringify({ createdAt: Date.now() }),
    );
    window.history.replaceState({}, '', '/?panel=connect&accountAuth=success#account');
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );

    initAccount();

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Welcome back\nMinsu'));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/?panel=connect#account',
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('mxqr-account-welcome-intent-v1')).toBeNull();
  });

  it('reconciles but does not welcome from an unarmed same-tab success URL', async () => {
    window.history.replaceState({}, '', '/?accountAuth=success');
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );

    initAccount();

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('consumes an expired same-tab welcome intent without showing a toast', async () => {
    sessionStorage.setItem(
      'mxqr-account-welcome-intent-v1',
      JSON.stringify({ createdAt: Date.now() - 10 * 60 * 1000 - 1 }),
    );
    window.history.replaceState({}, '', '/?accountAuth=success');
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );

    initAccount();

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(showToast).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mxqr-account-welcome-intent-v1')).toBeNull();
  });

  it('does not welcome an existing user during an ordinary session restore', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );

    initAccount();

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('fails open when the account endpoint is unavailable', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    initAccount();

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('unavailable'));
    openAccountDialog();

    expect(document.getElementById('account-dialog-message')?.textContent).toContain(
      'temporarily unavailable',
    );
    expect(document.getElementById('account-dialog-title')?.textContent).toBe('Account');
    expect(document.getElementById('btn-account-google')?.hidden).toBe(true);
    expect(document.getElementById('account-dialog-login-actions')?.hidden).toBe(false);
    const close = document.getElementById('btn-account-login-close');
    expect(close?.hidden).toBe(false);
    expect(close?.classList.contains('dialog-primary')).toBe(true);
    expect(close?.classList.contains('dialog-secondary')).toBe(false);
    expect(close?.textContent).toBe('Retry');
  });

  it('offers an explicit retry and restores sign-in without closing the dialog', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, authenticated: false, account: null, statsScope: null }),
      );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('unavailable'));
    openAccountDialog();

    document.getElementById('btn-account-login-close')?.click();

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    expect(document.getElementById('btn-account-google')?.hidden).toBe(false);
  });

  it('re-enables and refocuses explicit retry when recovery still fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('unavailable'));
    openAccountDialog();
    const retry = document.getElementById('btn-account-login-close') as HTMLButtonElement;

    retry.click();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    expect(retry.textContent).toBe('Retry');
    expect(document.activeElement).toBe(retry);
  });

  it('shows an authenticated nickname and restores focus after close', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();

    openAccountDialog();
    expect(document.getElementById('account-dialog-title')?.textContent).toBe('Minsu');
    expect(document.getElementById('account-dialog-title')?.hidden).toBe(true);
    expect(document.getElementById('account-dialog-title-edit-label')?.textContent).toBe('Minsu');
    expect(document.getElementById('account-dialog')?.getAttribute('aria-labelledby')).toBe(
      'account-dialog-title-edit-label',
    );
    expect(document.getElementById('account-dialog-content')?.hidden).toBe(true);
    expect(document.getElementById('account-dialog-login-actions')?.hidden).toBe(true);
    expect(document.getElementById('account-dialog')?.dataset.accountView).toBe('account');
    expect(document.getElementById('account-dialog-nickname')?.hidden).toBe(true);
    expect(document.getElementById('account-dialog-actions')?.hidden).toBe(false);
    const titleEdit = document.getElementById('btn-account-title-edit') as HTMLButtonElement;
    expect(titleEdit.disabled).toBe(false);
    expect(titleEdit.hidden).toBe(false);
    expect(titleEdit.getAttribute('aria-label')).toBe('Change nickname');
    expect(document.getElementById('account-dialog-title-edit-icon')?.hasAttribute('hidden')).toBe(
      false,
    );
    const centerClose = document.getElementById('btn-account-center-close') as HTMLButtonElement;
    expect(centerClose.textContent).toBe('Close');
    expect(centerClose.classList.contains('dialog-primary')).toBe(true);

    centerClose.click();
    expect(document.activeElement).toBe(opener);
  });

  it('opens nickname editing from the account title and removes the account modal first', async () => {
    vi.mocked(showDialog).mockResolvedValue({ action: 'secondary' });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    openAccountDialog();
    document.getElementById('account-dialog-title-edit-label')?.click();

    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      false,
    );
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledOnce());
    expect(showDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set nickname',
        inputField: expect.objectContaining({ defaultValue: 'Minsu' }),
      }),
    );
  });

  it('loads and formats account statistics only when a completed account opens the dialog', async () => {
    let resolveStats: ((response: Response) => void) | null = null;
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          statsScope: STATS_SCOPE,
          account: { nickname: 'Minsu', profileComplete: true },
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveStats = resolve;
          }),
      );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.getElementById('account-dialog-stats')?.hidden).toBe(false);
    expect(flushAccountActivityStatsForRead).not.toHaveBeenCalled();

    document.documentElement.lang = 'de-DE';
    openAccountDialog();

    expect(document.getElementById('account-dialog-stats')?.hidden).toBe(false);
    expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe('true');
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('-');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe('-');
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('-');
    await vi.waitFor(() => expect(flushAccountActivityStatsForRead).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(resolveStats).not.toBeNull());

    resolveStats!(
      jsonResponse({
        stats: {
          sessionCount: 12_345,
          listeningSeconds: 3_661,
          trackCount: 9_876,
        },
      }),
    );

    await vi.waitFor(() =>
      expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe(
        'false',
      ),
    );
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('12.345');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe('1 hr 1 min');
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('9.876');
    expect(document.getElementById('account-stats-sessions-label')?.textContent).toBe(
      'Sessions joined',
    );
    expect(document.getElementById('account-stats-listening-label')?.textContent).toBe(
      'Listening time',
    );
    expect(document.getElementById('account-stats-tracks-label')?.textContent).toBe('Media played');
    expect(document.getElementById('account-dialog-actions')?.hidden).toBe(false);
  });

  it('counts account statistics up smoothly before settling on the exact values', async () => {
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      const frameId = nextFrameId++;
      pendingFrames.set(frameId, callback);
      return frameId;
    });
    const cancelAnimationFrameMock = vi.fn((frameId: number) => {
      pendingFrames.delete(frameId);
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
    vi.mocked(flushAccountActivityStatsForRead).mockResolvedValueOnce({
      status: 'updated',
      stats: { sessionCount: 14, listeningSeconds: 9_540, trackCount: 53 },
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        configured: true,
        authenticated: true,
        statsScope: STATS_SCOPE,
        account: { nickname: 'Minsu', profileComplete: true },
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    openAccountDialog();

    await vi.waitFor(() => expect(requestAnimationFrameMock).toHaveBeenCalledOnce());
    expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe('true');
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('0');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe('0 hr 0 min');
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('0');

    const runNextFrame = (now: number): void => {
      const nextFrame = pendingFrames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      expect(nextFrame).toBeDefined();
      if (!nextFrame) return;
      pendingFrames.delete(nextFrame[0]);
      nextFrame[1](now);
    };

    runNextFrame(100);
    runNextFrame(220);
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('3');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe(
      '0 hr 30 min',
    );
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('10');

    runNextFrame(500);
    const intermediateSessions = Number(
      document.getElementById('account-stats-session-count')?.textContent,
    );
    const intermediateTracks = Number(
      document.getElementById('account-stats-track-count')?.textContent,
    );
    expect(intermediateSessions).toBeGreaterThan(0);
    expect(intermediateSessions).toBeLessThan(14);
    expect(intermediateTracks).toBeGreaterThan(0);
    expect(intermediateTracks).toBeLessThan(53);
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe(
      '1 hr 28 min',
    );

    runNextFrame(1_180);

    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('14');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe(
      '2 hr 37 min',
    );
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('52');
    expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe('true');

    runNextFrame(1_300);

    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('14');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe(
      '2 hr 39 min',
    );
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('53');
    expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(pendingFrames.size).toBe(0);

    document.getElementById('btn-account-center-close')?.click();
    openAccountDialog();
    await vi.waitFor(() => expect(requestAnimationFrameMock).toHaveBeenCalledTimes(6));
    expect(pendingFrames.size).toBe(1);

    document.getElementById('btn-account-center-close')?.click();

    expect(cancelAnimationFrameMock).toHaveBeenCalledOnce();
    expect(pendingFrames.size).toBe(0);
    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      false,
    );
    expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe(
      'false',
    );
  });

  it('keeps one count-up when refreshed stats and a fresh profile object arrive', async () => {
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      const frameId = nextFrameId++;
      pendingFrames.set(frameId, callback);
      return frameId;
    });
    const cancelAnimationFrameMock = vi.fn((frameId: number) => {
      pendingFrames.delete(frameId);
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );

    const statsScope = 's'.repeat(43);
    type FlushResult = Awaited<ReturnType<typeof flushAccountActivityStatsForRead>>;
    let resolveRefreshedStats!: (result: FlushResult) => void;
    const refreshedStats = new Promise<FlushResult>((resolve) => {
      resolveRefreshedStats = resolve;
    });
    vi.mocked(flushAccountActivityStatsForRead)
      .mockResolvedValueOnce({
        status: 'updated',
        stats: { sessionCount: 8, listeningSeconds: 3_600, trackCount: 20 },
      })
      .mockReturnValueOnce(refreshedStats);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        configured: true,
        authenticated: true,
        statsScope,
        account: { nickname: 'Minsu', profileComplete: true },
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    const runNextFrame = (now: number): void => {
      const nextFrame = pendingFrames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      expect(nextFrame).toBeDefined();
      if (!nextFrame) return;
      pendingFrames.delete(nextFrame[0]);
      nextFrame[1](now);
    };

    openAccountDialog();
    await vi.waitFor(() => expect(requestAnimationFrameMock).toHaveBeenCalledOnce());
    runNextFrame(100);
    runNextFrame(1_300);
    document.getElementById('btn-account-center-close')?.click();

    openAccountDialog();
    await vi.waitFor(() => expect(flushAccountActivityStatsForRead).toHaveBeenCalledTimes(2));
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(3);
    runNextFrame(2_000);
    runNextFrame(2_300);
    const countBeforeRefresh = document.getElementById('account-stats-session-count')?.textContent;
    expect(Number(countBeforeRefresh)).toBeGreaterThan(0);

    resolveRefreshedStats({
      status: 'updated',
      stats: { sessionCount: 12, listeningSeconds: 7_200, trackCount: 30 },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('account-stats-session-count')?.textContent).toBe(
      countBeforeRefresh,
    );
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(5);
    expect(cancelAnimationFrameMock).not.toHaveBeenCalled();

    applyAccountSession({
      configured: true,
      authenticated: true,
      statsScope,
      account: { nickname: 'Minsu', profileComplete: true },
    });

    expect(flushAccountActivityStatsForRead).toHaveBeenCalledTimes(2);
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(5);
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe(
      countBeforeRefresh,
    );

    runNextFrame(3_200);
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('12');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe('2 hr 0 min');
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('30');
    expect(pendingFrames.size).toBe(0);
  });

  it('shows final account statistics immediately when reduced motion is preferred', async () => {
    const requestAnimationFrameMock = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })),
    );
    vi.mocked(flushAccountActivityStatsForRead).mockResolvedValueOnce({
      status: 'updated',
      stats: { sessionCount: 14, listeningSeconds: 9_540, trackCount: 53 },
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        configured: true,
        authenticated: true,
        statsScope: STATS_SCOPE,
        account: { nickname: 'Minsu', profileComplete: true },
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    openAccountDialog();

    await vi.waitFor(() =>
      expect(document.getElementById('account-stats-session-count')?.textContent).toBe('14'),
    );
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe(
      '2 hr 39 min',
    );
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('53');
    expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(requestAnimationFrameMock).not.toHaveBeenCalled();
  });

  it('uses the PATCH aggregate directly without a redundant GET', async () => {
    vi.mocked(flushAccountActivityStatsForRead).mockResolvedValueOnce({
      status: 'updated',
      stats: { sessionCount: 3, listeningSeconds: 42, trackCount: 7 },
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        configured: true,
        authenticated: true,
        statsScope: STATS_SCOPE,
        account: { nickname: 'Minsu', profileComplete: true },
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    openAccountDialog();

    await vi.waitFor(() =>
      expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe(
        'false',
      ),
    );
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('3');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe('42 sec');
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('7');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not stack a second network timeout after an uncertain activity write', async () => {
    vi.mocked(flushAccountActivityStatsForRead).mockResolvedValueOnce({ status: 'uncertain' });
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    openAccountDialog();

    await vi.waitFor(() =>
      expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe(
        'false',
      ),
    );
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('-');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps unavailable statistics isolated as hyphen placeholders', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Minsu', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    openAccountDialog();

    await vi.waitFor(() =>
      expect(document.getElementById('account-dialog-stats')?.getAttribute('aria-busy')).toBe(
        'false',
      ),
    );
    expect(document.getElementById('account-stats-session-count')?.textContent).toBe('-');
    expect(document.getElementById('account-stats-listening-time')?.textContent).toBe('-');
    expect(document.getElementById('account-stats-track-count')?.textContent).toBe('-');
    expect(document.getElementById('account-dialog-actions')?.hidden).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not request statistics for an incomplete authenticated profile', async () => {
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: '', profileComplete: false },
      statsScope: 's'.repeat(43),
    });

    openAccountDialog();
    await Promise.resolve();

    expect(document.getElementById('account-dialog-stats')?.hidden).toBe(true);
    expect(flushAccountActivityStatsForRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('moves focus from the hidden Google action to account actions after popup sign-in', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();
    await Promise.resolve();
    expect(document.activeElement).toBe(document.getElementById('btn-account-google'));

    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
      statsScope: 's'.repeat(43),
    });
    await Promise.resolve();

    expect(document.getElementById('btn-account-google')?.hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('btn-account-title-edit'));
  });

  it('moves focus from Google to the primary close action if login becomes unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();
    await Promise.resolve();
    expect(document.activeElement).toBe(document.getElementById('btn-account-google'));

    applyAccountSession({
      configured: false,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    await Promise.resolve();

    const close = document.getElementById('btn-account-login-close') as HTMLButtonElement;
    expect(document.getElementById('btn-account-google')?.hidden).toBe(true);
    expect(close.classList.contains('dialog-primary')).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('repairs focus when an externally signed-out account hides the active action', async () => {
    vi.mocked(flushAccountActivityStatsForRead).mockResolvedValueOnce({
      status: 'updated',
      stats: { sessionCount: 1, listeningSeconds: 1, trackCount: 1 },
    });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: STATS_SCOPE,
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    openAccountDialog();
    const remove = document.getElementById('btn-account-delete') as HTMLButtonElement;
    remove.focus();

    applyAccountSession({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    await Promise.resolve();

    expect(document.getElementById('account-dialog-actions')?.hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('btn-account-google'));
  });

  it('shows safe in-progress copy when account deletion is accepted with 202', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/session') {
        return jsonResponse({
          configured: true,
          authenticated: true,
          statsScope: STATS_SCOPE,
          account: { nickname: 'Minsu', profileComplete: true },
        });
      }
      if (path === '/api/auth/account') {
        expect(init?.method).toBe('DELETE');
        return jsonResponse({ ok: true, pending: true }, 202);
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(showDialog).mockResolvedValueOnce({ action: 'ok' });
    const deleted = vi.fn();
    const pending = vi.fn();
    bus.on('account:deleted', deleted);
    bus.on('account:deletion-pending', pending);
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    document.getElementById('btn-account-delete')?.click();

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Your account is being deleted. PRO permissions are being safely cleaned up, and deletion will finish automatically.',
      ),
    );
    expect(deleted).not.toHaveBeenCalled();
    expect(pending).toHaveBeenCalledOnce();
    expect(getAccountSnapshot().status).toBe('anonymous');
  });

  it('owns a rejected delete-confirmation promise and restores the dialog pending state', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        statsScope: STATS_SCOPE,
        account: { nickname: 'Minsu', profileComplete: true },
      }),
    );
    vi.mocked(showDialog).mockRejectedValueOnce(new Error('dialog unavailable'));
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    document.getElementById('btn-account-delete')?.click();

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledOnce());
    expect(document.getElementById('account-dialog')?.getAttribute('aria-busy')).toBe('false');
  });

  it('closes with Escape and restores focus to the element that opened it', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    const opener = document.getElementById('opener') as HTMLButtonElement;
    const overlay = document.getElementById('account-dialog-overlay') as HTMLElement;
    opener.focus();

    openAccountDialog();
    await Promise.resolve();
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    overlay.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(overlay.classList.contains('show')).toBe(false);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab and Shift+Tab focus inside the open login dialog', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    const overlay = document.getElementById('account-dialog-overlay') as HTMLElement;
    const dialog = document.getElementById('account-dialog') as HTMLElement;
    const close = document.getElementById('btn-account-login-close') as HTMLButtonElement;
    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    const terms = document.getElementById('account-terms') as HTMLAnchorElement;
    const privacy = document.getElementById('account-privacy') as HTMLAnchorElement;
    // jsdom has no layout and therefore reports a null offsetParent for every
    // element. Model the controls that are visible in the real dialog.
    Object.defineProperty(close, 'offsetParent', { configurable: true, value: dialog });
    Object.defineProperty(google, 'offsetParent', { configurable: true, value: dialog });
    Object.defineProperty(terms, 'offsetParent', { configurable: true, value: dialog });
    Object.defineProperty(privacy, 'offsetParent', { configurable: true, value: dialog });

    openAccountDialog();
    await Promise.resolve();
    expect(document.activeElement).toBe(google);

    privacy.focus();
    const forward = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    overlay.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(google);

    google.focus();
    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    overlay.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(privacy);
  });

  it('keeps focus on the dialog while every account action is pending', async () => {
    let resolveLogout!: (response: Response) => void;
    vi.mocked(flushAccountActivityStatsForRead).mockResolvedValueOnce({
      status: 'updated',
      stats: { sessionCount: 1, listeningSeconds: 1, trackCount: 1 },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Minsu', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveLogout = resolve;
        }),
      );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    const overlay = document.getElementById('account-dialog-overlay') as HTMLElement;
    const dialog = document.getElementById('account-dialog') as HTMLElement;

    openAccountDialog();
    document.getElementById('btn-account-logout')?.click();

    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    overlay.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);

    resolveLogout(jsonResponse({ ok: true }));
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
  });

  it('opens login instead of a nickname editor for an anonymous user', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));

    await requestAccountNicknameChange();

    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    expect(document.getElementById('btn-account-google')?.hidden).toBe(false);
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('persists a nickname through the account profile endpoint', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'Old', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'New', profileComplete: true },
          statsScope: STATS_SCOPE,
        }),
      );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));

    await expect(updateCurrentAccountNickname('New')).resolves.toBe('New');

    expect(getAccountSnapshot().account?.nickname).toBe('New');
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/auth/profile',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('reopens a rename prompt with the attempted value when the nickname is taken', async () => {
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Old', profileComplete: true },
      statsScope: 's'.repeat(43),
    });
    vi.mocked(showDialog)
      .mockResolvedValueOnce({ action: 'ok', inputValue: 'Taken' })
      .mockResolvedValueOnce({ action: 'secondary' });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'NICKNAME_TAKEN' }, 409));

    await requestAccountNicknameChange();

    expect(showToast).toHaveBeenCalledWith('That nickname is already in use.');
    expect(showDialog).toHaveBeenCalledTimes(2);
    expect(vi.mocked(showDialog).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        inputField: expect.objectContaining({
          defaultValue: 'Taken',
          hint: 'That nickname is already in use.',
          preserveWhitespace: true,
        }),
      }),
    );
  });

  it('keeps first-login nickname setup retryable after a uniqueness collision', async () => {
    vi.mocked(showDialog)
      .mockResolvedValueOnce({ action: 'ok', inputValue: 'Taken' })
      .mockResolvedValueOnce({ action: 'secondary' });
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: '', profileComplete: false },
          statsScope: STATS_SCOPE,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'NICKNAME_TAKEN' }, 409));

    initAccount();

    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(2));
    expect(showToast).toHaveBeenCalledWith('That nickname is already in use.');
  });

  it('prompts once for an incomplete first-login profile without blocking the app', async () => {
    vi.mocked(showDialog).mockResolvedValue({ action: 'secondary' });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: '', profileComplete: false },
        statsScope: STATS_SCOPE,
      }),
    );

    initAccount();

    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));
    expect(getAccountSnapshot().status).toBe('authenticated');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('replaces the popup-login dialog with the first nickname prompt instead of stacking modals', async () => {
    vi.mocked(showDialog).mockResolvedValue({ action: 'secondary' });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('anonymous'));
    openAccountDialog();
    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );

    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: '', profileComplete: false },
      statsScope: 's'.repeat(43),
    });

    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));
    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      false,
    );
  });

  it('defers the first-login nickname prompt in a background tab until it becomes visible', async () => {
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    vi.mocked(showDialog).mockResolvedValue({ action: 'secondary' });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: '', profileComplete: false },
        statsScope: STATS_SCOPE,
      }),
    );

    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    expect(showDialog).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));

    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
  });

  it('keeps account actions reachable after first-login nickname setup is deferred', async () => {
    vi.mocked(showDialog).mockResolvedValue({ action: 'secondary' });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: '', profileComplete: false },
        statsScope: STATS_SCOPE,
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));

    openAccountDialog();

    expect(document.getElementById('account-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    expect(document.getElementById('account-dialog-actions')?.hidden).toBe(false);
    expect(document.getElementById('btn-account-logout')?.textContent).not.toBe('');
    expect(document.getElementById('btn-account-delete')?.textContent).not.toBe('');
    expect((document.getElementById('btn-account-title-edit') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(document.getElementById('account-dialog-title-edit-icon')?.hasAttribute('hidden')).toBe(
      false,
    );
    expect(document.getElementById('btn-account-center-close')?.textContent).toBe('Close');
  });

  it('keeps account controls reachable in a short landscape viewport', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const dialogRules = stylesheet.match(/\.dialog\.account-dialog\s*\{([^}]*)\}/)?.[1] ?? '';
    const shownDialogRules =
      stylesheet.match(/\.account-dialog-overlay\.show\s+\.account-dialog\s*\{([^}]*)\}/)?.[1] ??
      '';
    const headerRules =
      stylesheet.match(/\.dialog\.account-dialog\s+\.account-dialog-header\s*\{([^}]*)\}/)?.[1] ??
      '';
    const contentRules = stylesheet.match(/\.account-dialog-content\s*\{([^}]*)\}/)?.[1] ?? '';
    const loginContentRules =
      stylesheet.match(
        /\.dialog\.account-dialog\[data-account-view='login'\]\s+\.account-dialog-content\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const loginActionsRules =
      stylesheet.match(/\.account-dialog-login-actions\s*\{([^}]*)\}/)?.[1] ?? '';
    const statsRules = stylesheet.match(/\.account-dialog-stats\s*\{([^}]*)\}/)?.[1] ?? '';
    const statRowRules = stylesheet.match(/\.account-dialog-stat-row\s*\{([^}]*)\}/)?.[1] ?? '';
    const statValueRules =
      [...stylesheet.matchAll(/\.account-dialog-stat-row dd\s*\{([^}]*)\}/g)].at(-1)?.[1] ?? '';
    const accountActionsRules =
      stylesheet.match(/\.account-dialog-actions\s*\{([^}]*)\}/)?.[1] ?? '';
    const adaptiveActionsRules =
      stylesheet.match(/\.adaptive-action-group\s*\{([^}]*)\}/)?.[1] ?? '';
    const adaptiveButtonRules =
      stylesheet.match(
        /\.adaptive-action-group\s*>\s*:is\(button, a\):not\(\[hidden\]\)\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const adaptiveFullRules =
      stylesheet.match(
        /\.adaptive-action-group\s*>\s*\.adaptive-action-group-full:not\(\[hidden\]\)\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const titleEditRules = stylesheet.match(/\.account-dialog-title-edit\s*\{([^}]*)\}/)?.[1] ?? '';
    const titleEditFocusRules =
      stylesheet.match(/\.account-dialog-title-edit:focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';
    const titleEditLabelRules =
      stylesheet.match(/\.account-dialog-title-edit-label\s*\{([^}]*)\}/)?.[1] ?? '';
    const loginCloseRules =
      stylesheet.match(/\.account-dialog-login-close\s*\{([^}]*)\}/)?.[1] ?? '';
    const googleLabelRules = stylesheet.match(/\.account-google-label\s*\{([^}]*)\}/)?.[1] ?? '';
    const primaryLoginCloseRules =
      stylesheet.match(/\.account-dialog-login-close\.dialog-primary\s*\{([^}]*)\}/)?.[1] ?? '';
    const accountCloseRules =
      stylesheet.match(/\.account-dialog-account-close\s*\{([^}]*)\}/)?.[1] ?? '';
    const deleteRules = stylesheet.match(/^\s{2}\.account-delete-button\s*\{([^}]*)\}/m)?.[1] ?? '';

    expect(dialogRules).toContain('max-height: calc(100dvh - 48px)');
    expect(dialogRules).toContain('transform: translateY(18px)');
    expect(dialogRules).not.toContain('scale(');
    expect(shownDialogRules).toContain('transform: translateY(0)');
    expect(shownDialogRules).not.toContain('scale(');
    expect(headerRules).toContain('padding: 24px 20px 0');
    expect(titleEditRules).toContain('width: auto');
    expect(titleEditRules).toContain('max-width: 100%');
    expect(titleEditRules).toContain('min-height: 44px');
    expect(titleEditRules).toContain('display: inline-flex');
    expect(titleEditRules).toContain('border-radius: 999px');
    expect(titleEditFocusRules).toContain('outline: 2px solid var(--primary)');
    expect(titleEditFocusRules).toContain('outline-offset: 2px');
    expect(titleEditFocusRules).not.toContain('outline-offset: 6px');
    expect(titleEditLabelRules).toContain('min-width: 0');
    expect(titleEditLabelRules).toContain('text-overflow: ellipsis');
    expect(titleEditLabelRules).toContain('white-space: nowrap');
    expect(contentRules).toContain('min-height: 0');
    expect(contentRules).toContain('overflow-y: auto');
    expect(contentRules).toContain('overflow-anchor: none');
    expect(loginContentRules).toContain('padding-bottom: 10px');
    expect(loginActionsRules).toContain('padding: 0 32px 30px');
    expect(loginCloseRules).toContain('width: 100%');
    expect(loginCloseRules).toContain('max-width: 100%');
    expect(loginCloseRules).toContain('white-space: normal');
    expect(loginCloseRules).toContain('overflow-wrap: normal');
    expect(googleLabelRules).toContain('white-space: normal');
    expect(googleLabelRules).toContain('hyphens: auto');
    expect(googleLabelRules).toContain('overflow-wrap: normal');
    expect(googleLabelRules).not.toContain('text-overflow: ellipsis');
    expect(primaryLoginCloseRules).toContain('margin-top: 0');
    expect(statsRules).toContain('flex: 1 1 auto');
    expect(statsRules).toContain('min-height: 0');
    expect(statsRules).toContain('overflow-y: auto');
    expect(statsRules).not.toContain('border-top');
    expect(statsRules).not.toContain('border-bottom');
    expect(statRowRules).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(statRowRules).toContain('border-bottom: 1px solid var(--divider)');
    expect(statValueRules).toContain('font-variant-numeric: tabular-nums');
    expect(statValueRules).toContain('white-space: nowrap');
    expect(accountActionsRules).not.toContain('grid-template-columns');
    expect(adaptiveActionsRules).toContain('flex-wrap: wrap');
    expect(adaptiveActionsRules).toContain('align-items: stretch');
    expect(adaptiveButtonRules).toContain('flex: 1 1 max-content');
    expect(adaptiveButtonRules).toContain('max-width: 100%');
    expect(adaptiveButtonRules).toContain('white-space: normal');
    expect(adaptiveButtonRules).toContain('hyphens: auto');
    expect(adaptiveButtonRules).toContain('overflow-wrap: normal');
    expect(adaptiveButtonRules).toContain('word-break: keep-all');
    expect(adaptiveFullRules).toContain('flex-basis: 100%');
    expect(accountCloseRules).toContain('width: 100%');
    expect(deleteRules).toContain('min-height: 54px');
    expect(deleteRules).toContain('border-radius: 18px');
    expect(deleteRules).not.toContain('grid-column: 1 / -1');
    expect(stylesheet).toContain('@media (max-height: 350px)');
    expect(stylesheet).toContain(
      'html:not(.keyboard-open) .account-dialog-stat-row {\n      min-height: 40px;',
    );
    expect(stylesheet).toContain('.account-dialog-stat-row:last-child {\n    border-bottom: 0;');
    expect(stylesheet).toContain(
      'html:not(.keyboard-open) .account-dialog-actions .account-delete-button {\n      min-height: 44px;',
    );
    expect(stylesheet).toContain(
      'html:not(.keyboard-open) .account-dialog-login-actions {\n      padding: 0 24px 12px;',
    );
  });

  it('uses text actions instead of an X in the account modal markup', async () => {
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const accountDialog = parsed.getElementById('account-dialog');

    expect(accountDialog?.querySelector('.account-dialog-close')).toBeNull();
    expect(accountDialog?.querySelector('#btn-account-rename')).toBeNull();
    expect(
      accountDialog?.querySelector('#btn-account-title-edit > #account-dialog-title-edit-label'),
    ).not.toBeNull();
    expect(accountDialog?.querySelector('#btn-account-title-edit svg path')).not.toBeNull();
    expect(
      accountDialog?.querySelector('#account-dialog-login-actions > #btn-account-login-close'),
    ).not.toBeNull();
    expect(
      accountDialog?.querySelector('#account-dialog-content #btn-account-login-close'),
    ).toBeNull();
    expect(accountDialog?.querySelector('#btn-account-center-close')).not.toBeNull();
    expect(
      accountDialog?.querySelector('#account-dialog-actions.adaptive-action-group'),
    ).not.toBeNull();
    expect(
      accountDialog?.querySelector('#btn-account-center-close.adaptive-action-group-full'),
    ).not.toBeNull();
  });

  it('inverts the borderless Google button against the active app theme', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const markup = await readFile('index.html', 'utf8');
    const baseRules = stylesheet.match(/\.account-google-button\s*\{([^}]*)\}/)?.[1] ?? '';
    const lightThemeRules =
      stylesheet.match(/html\[data-theme='light'\]\s+\.account-google-button\s*\{([^}]*)\}/)?.[1] ??
      '';
    const markRules = stylesheet.match(/\.account-google-mark\s*\{([^}]*)\}/)?.[1] ?? '';
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const googleMark = parsed.querySelector('.account-google-mark');

    expect(baseRules).toContain('border: 0');
    expect(baseRules).toContain('box-shadow: none');
    expect(baseRules).toContain('background: #ffffff');
    expect(baseRules).toContain('color: #1f1f1f');
    expect(lightThemeRules).toContain('background: #131314');
    expect(lightThemeRules).toContain('color: #e3e3e3');
    expect(lightThemeRules).not.toContain('border:');
    expect(markRules).toContain('background: transparent');
    expect(markRules).not.toContain('border-radius');
    expect(googleMark?.querySelectorAll('svg path')).toHaveLength(4);
    expect(googleMark?.querySelector('circle, rect')).toBeNull();
  });
});
