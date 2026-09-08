// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const script = compileClassicRuntimeForBrowserTest('admin.js');
const suggestion = {
  id: '27c46013-c03b-4b28-9691-aa80b7b85bdf',
  locale: 'fr',
  surface: 'app',
  key: 'common.save',
  sourceEn: 'Save',
  sourceKo: '저장',
  current: 'Sauvegarder',
  proposed: 'Enregistrer',
  reason: '',
  author: 'Translator',
  createdAt: 1788800000000,
  status: 'pending',
  revision: 4,
  votes: 12,
  outdated: false,
  applied: false,
};

function dom(): void {
  document.body.innerHTML = `<main class="admin-shell" data-admin-configured="true">
    <section data-login-panel><form data-login-form><input name="password"></form><p data-login-status></p></section>
    <section data-dashboard hidden><button data-logout>Logout</button>
      <button data-admin-tab="translations">Translations</button>
      <section data-admin-view="translations" hidden>
        <select data-translation-status-filter><option value="pending">Pending</option><option value="approved">Approved</option></select>
        <input data-translation-locale-filter><button data-translation-filter>Filter</button>
        <button data-translation-export>Export approved</button><p data-translation-status></p>
        <div data-translation-list></div><button data-translation-more hidden>More</button>
        <details data-translation-export-copy hidden><textarea data-translation-export-json></textarea></details>
      </section>
    </section></main>`;
}

function defaultResponse(path: string): Response {
  return path === '/api/admin/session'
    ? Response.json({ authenticated: true, configured: true })
    : Response.json({ generatedAt: new Date().toISOString(), cards: [], summary: {} });
}

async function start(): Promise<void> {
  window.eval(script);
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>('[data-dashboard]')!.hidden).toBe(false),
  );
  document.querySelector<HTMLButtonElement>('[data-admin-tab="translations"]')!.click();
}

function action(text: string): HTMLButtonElement {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('.translation-review-actions button'),
  ).find((button) => button.textContent === text)!;
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('admin translation review', () => {
  it('renders contributor text literally and submits the displayed revision with admin CSRF', async () => {
    dom();
    const writes: RequestInit[] = [];
    let approved = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), location.origin);
        if (url.pathname.endsWith('/review')) {
          writes.push(init!);
          approved = true;
          return Response.json({ suggestion: { ...suggestion, status: 'approved', revision: 5 } });
        }
        if (url.pathname === '/api/admin/translations')
          return Response.json({
            suggestions: approved
              ? []
              : [{ ...suggestion, proposed: '<img src=x onerror=alert(1)>' }],
            nextCursor: null,
          });
        return defaultResponse(url.pathname);
      }),
    );
    await start();
    await vi.waitFor(() => expect(action('Approve')).toBeDefined());
    expect(document.querySelector('[data-translation-list]')!.textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
    expect(document.querySelector('[data-translation-list] img')).toBeNull();
    action('Approve').click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-translation-list]')!.childElementCount).toBe(0),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.credentials).toBe('same-origin');
    expect(new Headers(writes[0]!.headers).get('X-MXQR-Admin-CSRF')).toBe('1');
    expect(JSON.parse(String(writes[0]!.body))).toEqual({
      status: 'approved',
      expectedRevision: 4,
    });
  });

  it('allows stale proposals to be rejected while keeping approval disabled after a failed write', async () => {
    dom();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), location.origin).pathname;
        if (path.endsWith('/review'))
          return Response.json({ error: 'TRANSLATION_REVISION_MISMATCH' }, { status: 409 });
        if (path === '/api/admin/translations')
          return Response.json({
            suggestions: [{ ...suggestion, outdated: true }],
            nextCursor: null,
          });
        return defaultResponse(path);
      }),
    );
    await start();
    await vi.waitFor(() => expect(action('Approve')).toBeDefined());
    expect(action('Approve').disabled).toBe(true);
    action('Reject').click();
    await vi.waitFor(() => expect(action('Reject').disabled).toBe(false));
    expect(action('Approve').disabled).toBe(true);
  });

  it('keeps the newest filter when an older list response arrives late', async () => {
    dom();
    let finish!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), location.origin);
        if (url.pathname === '/api/admin/translations') {
          reads++;
          return url.searchParams.get('status') === 'pending'
            ? held
            : Response.json({
                suggestions: [{ ...suggestion, status: 'approved', proposed: 'New filter result' }],
                nextCursor: null,
              });
        }
        return defaultResponse(url.pathname);
      }),
    );
    await start();
    await vi.waitFor(() => expect(reads).toBe(1));
    const filter = document.querySelector<HTMLSelectElement>('[data-translation-status-filter]')!;
    filter.value = 'approved';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-translation-list]')!.textContent).toContain(
        'New filter result',
      ),
    );
    finish(
      Response.json({
        suggestions: [{ ...suggestion, proposed: 'Obsolete result' }],
        nextCursor: 'old-cursor',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('[data-translation-list]')!.textContent).not.toContain(
      'Obsolete result',
    );
    expect(document.querySelector<HTMLButtonElement>('[data-translation-more]')!.hidden).toBe(true);
  });

  it('does not expose a pending approved export after logout', async () => {
    dom();
    let finish!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let exports = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), location.origin).pathname;
        if (path === '/api/admin/translations/export') {
          exports++;
          return held;
        }
        if (path === '/api/admin/translations')
          return Response.json({ suggestions: [], nextCursor: null });
        return defaultResponse(path);
      }),
    );
    await start();
    document.querySelector<HTMLButtonElement>('[data-translation-export]')!.click();
    await vi.waitFor(() => expect(exports).toBe(1));
    document.querySelector<HTMLButtonElement>('[data-logout]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-dashboard]')!.hidden).toBe(true),
    );
    finish(
      Response.json({
        version: 1,
        kind: 'musixquare-approved-translations',
        drafts: [{ proposed: 'Private review data' }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      document.querySelector<HTMLTextAreaElement>('[data-translation-export-json]')!.value,
    ).toBe('');
    expect(
      document.querySelector<HTMLDetailsElement>('[data-translation-export-copy]')!.hidden,
    ).toBe(true);
  });
});
