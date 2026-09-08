import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommunity } from '../../../.workshop/translate/community';
import { CommunityApiError, type Suggestion } from '../../../.workshop/translate/community-client';
import type { Draft } from '../../../.workshop/translate/drafts';

const api = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  submit: vi.fn(),
  recommend: vi.fn(),
  withdraw: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('../../../.workshop/translate/catalog-client', () => ({
  loadTranslationCatalog: api.catalog,
}));
vi.mock('../../../.workshop/translate/community-client', async (original) => ({
  ...(await original<typeof import('../../../.workshop/translate/community-client')>()),
  getAccountSession: api.session,
  listSuggestions: api.list,
  submitSuggestion: api.submit,
  recommendSuggestion: api.recommend,
  withdrawSuggestion: api.withdraw,
}));

const scope = 's'.repeat(43);
const signedIn = {
  configured: true,
  authenticated: true,
  statsScope: scope,
  account: { nickname: 'Translator', profileComplete: true },
};
const draft: Draft = {
  id: 'about:hero.h1',
  surface: 'about',
  key: 'hero.h1',
  sourceEn: 'Listen together.',
  sourceKo: '함께 들어요.',
  current: 'Écoutez ensemble.',
  locale: 'fr',
  proposed: 'Écoutons ensemble.',
  reason: '',
  updatedAt: '2026-09-08T12:00:00.000Z',
};
const suggestion: Suggestion = {
  ...draft,
  id: 'c52bff23-52e7-4e84-a791-c55557801902',
  author: 'Translator',
  createdAt: Date.parse(draft.updatedAt),
  status: 'pending',
  revision: 1,
  votes: 2,
  voted: false,
  owned: true,
  outdated: false,
  applied: false,
};
const html = readFileSync('.workshop/translate/translate.html', 'utf8');
let dom: JSDOM;
let community: ReturnType<typeof initCommunity>;
let selected: Draft | undefined;
let prepare: ReturnType<typeof vi.fn<(draft: Draft) => Promise<boolean>>>;
let submitted: ReturnType<typeof vi.fn<(draft: Draft) => void>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function button(id: string): HTMLButtonElement {
  return dom.window.document.getElementById(id) as HTMLButtonElement;
}

async function start() {
  community = initCommunity(
    {
      currentDraft: () => selected,
      canSubmit: () => !!selected,
      prepareDraft: prepare,
      onSubmitted: submitted,
    },
    dom.window.document,
  );
  community.setContext('fr', draft);
  await vi.waitFor(() =>
    expect(button('submit-suggestion').textContent).not.toBe('Checking sign-in…'),
  );
  await vi.waitFor(() =>
    expect(
      dom.window.document.querySelector('#community-suggestions')?.getAttribute('aria-busy'),
    ).toBe('false'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dom = new JSDOM(html, { url: 'https://musixquare.com/translate' });
  selected = { ...draft };
  prepare = vi.fn(async () => true);
  submitted = vi.fn((snapshot: Draft) => {
    if (selected === snapshot) selected = undefined;
  });
  api.session.mockResolvedValue(signedIn);
  api.list.mockResolvedValue({ suggestions: [], nextCursor: null });
  api.submit.mockResolvedValue(suggestion);
  api.recommend.mockResolvedValue({ ...suggestion, votes: 3, voted: true });
  api.withdraw.mockResolvedValue({ ...suggestion, status: 'withdrawn' });
});

afterEach(() => {
  community?.destroy();
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('translation community UI', () => {
  it('shows an explicit sign-in link without making a mutation or starting login', async () => {
    api.session.mockResolvedValue({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    await start();
    const signIn = dom.window.document.querySelector<HTMLAnchorElement>('#suggest-sign-in')!;
    expect(signIn.hidden).toBe(false);
    expect(signIn.getAttribute('href')).toBe('/api/auth/google/start?returnTo=%2Ftranslate');
    expect(button('submit-suggestion').hidden).toBe(true);
    expect(api.submit).not.toHaveBeenCalled();
    expect(api.recommend).not.toHaveBeenCalled();
  });

  it('retries an unavailable account read instead of assuming the visitor is signed out', async () => {
    api.session.mockRejectedValueOnce(new Error('offline'));
    await start();
    expect(button('submit-suggestion').textContent).toBe('Retry sign-in');
    expect(dom.window.document.getElementById('suggest-sign-in')?.hidden).toBe(true);
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(button('submit-suggestion').textContent).toBe('Submit publicly'));
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('does not submit when the draft changes during the fresh-reference check', async () => {
    const check = deferred<boolean>();
    prepare.mockReturnValue(check.promise);
    await start();
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    selected = { ...selected!, proposed: 'Une autre version.' };
    check.resolve(true);
    await vi.waitFor(() => expect(button('submit-suggestion').disabled).toBe(false));
    expect(api.submit).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('reuses an idempotency key after an uncertain response for the unchanged draft and account', async () => {
    api.submit.mockRejectedValueOnce(new Error('connection lost'));
    await start();
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button('submit-suggestion').disabled).toBe(false));
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    expect(api.submit.mock.calls[0]?.[1]).toBe(api.submit.mock.calls[1]?.[1]);
    expect(api.submit.mock.calls[1]?.[2]).toBe(scope);
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledOnce());
  });

  it('preserves newer wording and avoids a success message on a different draft after a late submit', async () => {
    const request = deferred<Suggestion>();
    api.submit.mockReturnValue(request.promise);
    await start();
    const original = selected;
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
    const newer = { ...draft, proposed: 'Nouvelle version.' };
    selected = newer;
    request.resolve(suggestion);
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith(original));
    expect(selected).toBe(newer);
    expect(dom.window.document.getElementById('submit-status')?.textContent).toBe('');
  });

  it('discards old language responses even when a request implementation ignores abort', async () => {
    await start();
    const old = deferred<{ suggestions: Suggestion[]; nextCursor: null }>();
    api.list.mockImplementation((query: { locale: string }) =>
      query.locale === 'ja'
        ? old.promise
        : Promise.resolve({
            suggestions: [{ ...suggestion, locale: 'de', proposed: 'Gemeinsam hören.' }],
            nextCursor: null,
          }),
    );
    community.setContext('ja', draft);
    community.setContext('de', draft);
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('community-suggestions')?.textContent).toContain(
        'Gemeinsam hören.',
      ),
    );
    old.resolve({
      suggestions: [{ ...suggestion, locale: 'ja', proposed: '古い応答' }],
      nextCursor: null,
    });
    await Promise.resolve();
    expect(dom.window.document.getElementById('community-suggestions')?.textContent).not.toContain(
      '古い応答',
    );
  });

  it('renders public author, note, and translation values as text and sends an explicit vote toggle', async () => {
    api.list.mockResolvedValue({
      suggestions: [
        {
          ...suggestion,
          author: '<img src=x onerror=alert(1)>',
          proposed: '<script>alert(1)</script>',
          reason: '<svg onload=alert(1)>',
        },
      ],
      nextCursor: null,
    });
    await start();
    const list = dom.window.document.getElementById('community-suggestions')!;
    expect(list.querySelector('img, script, svg')).toBeNull();
    expect(list.textContent).toContain('<script>alert(1)</script>');
    const vote = list.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    vote.click();
    await vi.waitFor(() => expect(api.recommend).toHaveBeenCalledWith(suggestion.id, true, scope));
  });

  it('refreshes authentication after a scope conflict and keeps the local draft', async () => {
    api.submit.mockRejectedValue(new CommunityApiError('ACCOUNT_SESSION_CHANGED', 409));
    await start();
    api.session.mockResolvedValue({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    button('submit-suggestion').click();
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('suggest-sign-in')?.hidden).toBe(false),
    );
    expect(selected).toBeDefined();
    expect(submitted).not.toHaveBeenCalled();
    expect(dom.window.document.getElementById('submit-status')?.textContent).toContain(
      'account changed',
    );
  });
});

describe('translation editor submission integration', () => {
  const portuguese = { code: 'pt-br', nativeName: 'Português', htmlLang: 'pt-BR' };

  async function startEditor() {
    vi.resetModules();
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('Option', dom.window.Option);
    api.catalog.mockResolvedValue({
      locale: portuguese,
      languages: [
        { code: 'en', nativeName: 'English', htmlLang: 'en' },
        { code: 'ko', nativeName: '한국어', htmlLang: 'ko' },
        portuguese,
      ],
      entries: [{ ...draft, current: 'Ouvir juntos.' }],
    });
    await import('../../../.workshop/translate/main');
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('editor')?.hidden).toBe(false),
    );
    await vi.waitFor(() => expect(button('submit-suggestion').textContent).toBe('Submit publicly'));
  }

  function typeProposal(value: string) {
    const input = dom.window.document.getElementById('proposal') as HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return input;
  }

  it('boots the concise page, preserves edits made during submission, then clears only an acknowledged draft', async () => {
    await startEditor();
    const hero = dom.window.document.querySelector('.policy-hero p')!;
    expect(hero.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
      'Help MUSIXQUARE feel natural in your language.A clearer word can make all the difference.',
    );
    expect(hero.querySelectorAll('br')).toHaveLength(1);
    expect(
      dom.window.document.querySelector('.translation-editor-actions')?.textContent,
    ).not.toContain('Public suggestion');
    expect((dom.window.document.getElementById('saved') as HTMLDetailsElement).open).toBe(false);
    const pending = deferred<Suggestion>();
    api.submit.mockReturnValueOnce(pending.promise);
    const input = typeProposal('Vamos ouvir juntos.');
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
    typeProposal('Vamos escutar juntos.');
    pending.resolve({ ...suggestion, locale: 'pt-br', proposed: 'Vamos ouvir juntos.' });
    await vi.waitFor(() => expect(button('submit-suggestion').disabled).toBe(false));
    expect(input.value).toBe('Vamos escutar juntos.');
    expect(dom.window.document.getElementById('draft-count')?.textContent).toBe('1');
    api.submit.mockResolvedValue({ ...suggestion, locale: 'pt-br', proposed: input.value });
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(dom.window.document.getElementById('draft-count')?.textContent).toBe('0');
    expect(dom.window.document.getElementById('submit-status')?.textContent).toBe(
      'Submitted · Pending review',
    );
  });

  it('requires explicit re-review when the source changed before submission', async () => {
    await startEditor();
    const input = typeProposal('Vamos ouvir juntos.');
    api.catalog.mockResolvedValue({
      locale: portuguese,
      languages: [portuguese],
      entries: [
        { ...draft, sourceEn: 'Listen together, wherever you are.', current: 'Ouvir juntos.' },
      ],
    });
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(button('review-source').hidden).toBe(false));
    expect(api.submit).not.toHaveBeenCalled();
    expect(input.value).toBe('Vamos ouvir juntos.');
    expect(button('submit-suggestion').disabled).toBe(true);
    button('review-source').click();
    await vi.waitFor(() => expect(button('submit-suggestion').disabled).toBe(false));
  });
});
