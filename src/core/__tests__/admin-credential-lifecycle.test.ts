// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const script = compileClassicRuntimeForBrowserTest('admin.js');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin API credential publication ownership', () => {
  it.each([
    'logout',
    'collapse',
    'pagehide',
    'replace-panel',
    'replace-panel-error',
    'replace-generation',
    'network-retry',
    'timeout-retry',
  ] as const)('preserves credential ownership and recovery for %s', async (action) => {
    document.body.innerHTML = `<main class="admin-shell" data-admin-configured="true">
        <section data-login-panel><form data-login-form><input name="password"><button>Login</button></form><p data-login-status></p></section>
        <section data-dashboard hidden><button data-refresh>Refresh</button><button data-logout>Logout</button><button data-admin-tab="pro-rooms">Rooms</button>
        <section data-admin-view="pro-rooms"><p data-pro-room-status></p><p data-pro-room-list-status></p><div data-pro-room-list></div></section></section></main>`;
    let issued = 0;
    let roomGeneration = 4;
    let resolveIssue: ((response: Response) => void) | undefined;
    let rejectIssue: ((reason: unknown) => void) | undefined;
    const issueBodies: unknown[] = [];
    let resolveLogout: ((response: Response) => void) | undefined;
    const secret = 'mxqr_live_late-audit-fixture';
    const issueResponse = (generation = roomGeneration) =>
      Response.json({
        roomCode: '000001',
        roomGeneration: generation,
        apiKey: secret,
        key: { keyId: 'fixture-key' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input === '/api/admin/session') return Response.json({ authenticated: true });
        if (input === '/api/admin/metrics') return Response.json({ cards: [], summary: {} });
        if (input === '/api/admin/pro-grants/campaigns') return Response.json({ campaigns: [] });
        if (input === '/api/admin/pro-rooms')
          return Response.json({
            rooms: [
              {
                roomCode: '000001',
                roomGeneration,
                label: 'Fixture',
                status: 'registered',
                activationState: 'active',
                ownerAccountLinked: true,
              },
            ],
          });
        if (input === '/api/admin/logout')
          return new Promise<Response>((resolve) => {
            resolveLogout = resolve;
          });
        if (input === '/api/admin/pro-rooms/000001/api-keys') {
          if (init?.method === 'POST') {
            issued++;
            issueBodies.push(init.body);
            if (issued === 1)
              return new Promise<Response>((resolve, reject) => {
                // Deliver even after abort to verify late results are owned by
                // the original operation, independently of browser cancellation.
                resolveIssue = resolve;
                rejectIssue = reject;
                if (action === 'timeout-retry') {
                  init.signal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('aborted', 'AbortError')),
                    { once: true },
                  );
                }
              });
            return issueResponse();
          }
          return Response.json({
            roomCode: '000001',
            roomGeneration,
            keys: [],
            maxActiveKeys: 3,
          });
        }
        return Response.json({ ok: true, revision: 0, announcement: {}, history: [] });
      }),
    );
    window.eval(script);
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(false),
    );
    document.querySelector<HTMLButtonElement>('[data-admin-tab="pro-rooms"]')!.click();
    const room = await vi.waitFor(() => {
      const value = document.querySelector<HTMLDetailsElement>('[data-pro-room-item="000001"]');
      expect(value).not.toBeNull();
      return value!;
    });
    room.open = true;
    room.dispatchEvent(new Event('toggle'));
    const form = await vi.waitFor(() => {
      const value = room.querySelector<HTMLFormElement>('[data-pro-room-api-form]');
      expect(value).not.toBeNull();
      return value!;
    });
    (form.elements.namedItem('label') as HTMLInputElement).value = 'Fixture';
    if (action === 'timeout-retry') vi.useFakeTimers();
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(issued).toBe(1));
    if (action === 'network-retry' || action === 'timeout-retry') {
      if (action === 'network-retry') rejectIssue!(new TypeError('network response lost'));
      else await vi.advanceTimersByTimeAsync(20_000);
      await vi.waitFor(() =>
        expect(
          document.querySelector<HTMLInputElement>('[aria-label="000001 Developer API key"]')
            ?.value,
        ).toBe(secret),
      );
      expect(issued).toBe(2);
      expect(issueBodies[1]).toBe(issueBodies[0]);
      return;
    }
    if (action === 'logout') document.querySelector<HTMLButtonElement>('[data-logout]')!.click();
    else if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
    else if (
      action === 'replace-panel' ||
      action === 'replace-panel-error' ||
      action === 'replace-generation'
    ) {
      if (action === 'replace-generation') roomGeneration = 5;
      document.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    } else {
      room.open = false;
      room.dispatchEvent(new Event('toggle'));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveIssue!(
      action === 'replace-panel-error'
        ? Response.json({ error: 'AUDIT_LATE_FAILURE' }, { status: 500 })
        : issueResponse(4),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(issued).toBe(1);
    expect(document.querySelector('[aria-label="000001 Developer API key"]')).toBeNull();
    expect(document.body.textContent).not.toContain('AUDIT_LATE_FAILURE');
    if (action === 'logout') {
      expect(document.querySelector<HTMLElement>('[data-dashboard]')?.hidden).toBe(true);
      resolveLogout!(Response.json({ ok: true }));
      return;
    }
    if (action === 'pagehide')
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    else if (action === 'collapse') {
      room.open = true;
      room.dispatchEvent(new Event('toggle'));
    }
    const nextForm = await vi.waitFor(() => {
      const value = document.querySelector<HTMLFormElement>('[data-pro-room-api-form]');
      expect(value?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        false,
      );
      return value!;
    });
    (nextForm.elements.namedItem('label') as HTMLInputElement).value = 'Fresh action';
    nextForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('[aria-label="000001 Developer API key"]')?.value,
      ).toBe(secret),
    );
    expect(issued).toBe(2);
  });
});
