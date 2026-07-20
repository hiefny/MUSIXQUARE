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
import { updateCurrentAccountNickname } from '../../account/nickname.ts';
import { clearIntentionalNav } from '../../core/page-lifecycle.ts';

vi.mock('../dialog.ts', () => ({ showDialog: vi.fn() }));
vi.mock('../toast.ts', () => ({ showToast: vi.fn() }));

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
      <div id="account-dialog" aria-busy="false">
        <button id="btn-account-close"></button>
        <span id="account-dialog-title"></span>
        <div id="account-dialog-content">
          <p id="account-dialog-message"></p>
          <strong id="account-dialog-nickname" hidden></strong>
          <a id="btn-account-google" hidden><span id="account-google-label"></span></a>
          <nav id="account-legal-links" hidden></nav>
        </div>
        <div id="account-dialog-actions" hidden>
          <button id="btn-account-rename"></button>
          <button id="btn-account-logout"></button>
          <button id="btn-account-delete"></button>
        </div>
      </div>
    </div>
  `;
}

beforeEach(() => {
  __resetAccountUiForTests();
  __resetAccountStateForTests();
  bus.clear();
  vi.clearAllMocks();
  renderAccountDialog();
  vi.stubGlobal('fetch', vi.fn());
  sessionStorage.clear();
  clearIntentionalNav();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  __resetAccountUiForTests();
  vi.unstubAllGlobals();
});

describe('optional account UI', () => {
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
  });

  it('uses a completion popup so an active room is not navigated away', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
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

    document.getElementById('btn-account-google')?.click();

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
  });

  it('falls back to ordinary same-tab navigation when a popup is blocked', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
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

  it('keeps installed PWAs on the same-tab OAuth return path', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const open = vi.spyOn(window, 'open');
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

    expect(open).not.toHaveBeenCalled();
    expect(preventedByAccountHandler).toBe(false);
    expect(google.getAttribute('href')).toContain('returnTo=%2F');
    expect(google.getAttribute('href')).not.toContain('account-complete');
  });

  it('preserves the PRO route in a PWA even before room context projection is ready', async () => {
    window.history.replaceState({}, '', '/000001?panel=connect#account');
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ configured: true, authenticated: false, account: null }),
    );
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
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
    const open = vi.spyOn(window, 'open').mockReturnValue({
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
  });

  it('fails open when the account endpoint is unavailable', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    initAccount();

    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('unavailable'));
    openAccountDialog();

    expect(document.getElementById('account-dialog-message')?.textContent).toContain(
      'temporarily unavailable',
    );
    expect(document.getElementById('btn-account-google')?.hidden).toBe(true);
  });

  it('shows an authenticated nickname and restores focus after close', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
      }),
    );
    initAccount();
    await vi.waitFor(() => expect(getAccountSnapshot().status).toBe('authenticated'));
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();

    openAccountDialog();
    expect(document.getElementById('account-dialog-title')?.textContent).toBe('Minsu');
    expect(document.getElementById('account-dialog-content')?.hidden).toBe(true);
    expect(document.getElementById('account-dialog-nickname')?.hidden).toBe(true);
    expect(document.getElementById('account-dialog-actions')?.hidden).toBe(false);

    document.getElementById('btn-account-close')?.click();
    expect(document.activeElement).toBe(opener);
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
    });
    await Promise.resolve();

    expect(document.getElementById('btn-account-google')?.hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('btn-account-rename'));
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
    const close = document.getElementById('btn-account-close') as HTMLButtonElement;
    const google = document.getElementById('btn-account-google') as HTMLAnchorElement;
    // jsdom has no layout and therefore reports a null offsetParent for every
    // element. Model the two controls that are visible in the real dialog.
    Object.defineProperty(close, 'offsetParent', { configurable: true, value: dialog });
    Object.defineProperty(google, 'offsetParent', { configurable: true, value: dialog });

    openAccountDialog();
    await Promise.resolve();
    expect(document.activeElement).toBe(google);

    const forward = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    overlay.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);

    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    overlay.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(google);
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
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          authenticated: true,
          account: { nickname: 'New', profileComplete: true },
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

  it('prompts once for an incomplete first-login profile without blocking the app', async () => {
    vi.mocked(showDialog).mockResolvedValue({ action: 'secondary' });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        configured: true,
        authenticated: true,
        account: { nickname: '', profileComplete: false },
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
    const authenticatedActionsRules =
      stylesheet.match(
        /\.account-dialog-content\[hidden\]\s*\+\s*\.account-dialog-actions:not\(\[hidden\]\)\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const accountActionsRules =
      stylesheet.match(/\.account-dialog-actions\s*\{([^}]*)\}/)?.[1] ?? '';
    const renameRules = stylesheet.match(/#btn-account-rename\s*\{([^}]*)\}/)?.[1] ?? '';
    const deleteRules = stylesheet.match(/^\s{2}\.account-delete-button\s*\{([^}]*)\}/m)?.[1] ?? '';

    expect(dialogRules).toContain('max-height: calc(100dvh - 48px)');
    expect(dialogRules).toContain('transform: translateY(18px)');
    expect(dialogRules).not.toContain('scale(');
    expect(shownDialogRules).toContain('transform: translateY(0)');
    expect(shownDialogRules).not.toContain('scale(');
    expect(headerRules).toContain('padding: 30px 72px 6px 32px');
    expect(contentRules).toContain('min-height: 0');
    expect(contentRules).toContain('overflow-y: auto');
    expect(contentRules).toContain('overflow-anchor: none');
    expect(authenticatedActionsRules).toContain('padding-top: 18px');
    expect(accountActionsRules).toContain('grid-template-columns: 1fr 1fr');
    expect(renameRules).toContain('grid-column: 1 / -1');
    expect(deleteRules).toContain('min-height: 54px');
    expect(deleteRules).toContain('border-radius: 18px');
    expect(deleteRules).not.toContain('grid-column: 1 / -1');
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
