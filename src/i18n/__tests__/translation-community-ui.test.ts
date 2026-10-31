import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LANGUAGE_OPTIONS } from '../locales.ts';
import { initCommunity } from '../../../.workshop/translate/community';
import { CommunityApiError, type Suggestion } from '../../../.workshop/translate/community-client';
import { DRAFT_STORAGE_KEY, loadDrafts, type Draft } from '../../../.workshop/translate/drafts';

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

  it('keeps retry identity across sign-in renewal while using the newly observed session fence', async () => {
    api.submit.mockRejectedValueOnce(new Error('response lost'));
    await start();
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button('submit-suggestion').disabled).toBe(false));
    api.session.mockResolvedValue({
      ...signedIn,
      statsScope: 't'.repeat(43),
      account: { ...signedIn.account, nickname: 'Renewed' },
    });
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('community-account')?.textContent).toBe('Renewed'),
    );
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    expect(api.submit.mock.calls[1]![1]).toBe(api.submit.mock.calls[0]![1]);
    expect(api.submit.mock.calls[1]![2]).toBe('t'.repeat(43));
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

  async function reloadEditor() {
    // As on a real reload, pagehide flushes a pending draft save before the
    // next page reads storage, and its timer cannot fire into a later page.
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    const saved = dom.window.localStorage.getItem(DRAFT_STORAGE_KEY);
    dom.window.close();
    dom = new JSDOM(html, { url: 'https://musixquare.com/translate' });
    if (saved !== null) dom.window.localStorage.setItem(DRAFT_STORAGE_KEY, saved);
    await startEditor();
  }

  it('saves, reviews and submits real editor inputs when randomUUID is unavailable', async () => {
    const provider = globalThis.crypto;
    const getRandomValues = vi.fn(provider.getRandomValues.bind(provider));
    vi.stubGlobal('crypto', { getRandomValues, subtle: provider.subtle });
    await startEditor();
    const input = typeProposal('Vamos ouvir juntos.');
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('save-status')?.textContent).toBe('Saved locally'),
    );
    const first = loadDrafts(dom.window.localStorage).drafts[0]!;
    expect(first).toMatchObject({ proposed: input.value, locale: 'pt-br' });
    expect(first.revisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const reason = dom.window.document.getElementById('reason') as HTMLTextAreaElement;
    reason.value = 'More natural wording';
    reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await vi.waitFor(() =>
      expect(loadDrafts(dom.window.localStorage).drafts[0]?.reason).toBe(reason.value),
    );
    const edited = loadDrafts(dom.window.localStorage).drafts[0]!;
    expect(edited.revisionId).not.toBe(first.revisionId);

    api.catalog.mockResolvedValue({
      locale: portuguese,
      languages: [portuguese],
      entries: [
        {
          id: draft.id,
          surface: draft.surface,
          key: draft.key,
          sourceEn: 'Listen together, wherever you are.',
          sourceKo: draft.sourceKo,
          current: 'Ouvir juntos.',
        },
      ],
    });
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(button('review-source').hidden).toBe(false));
    expect(api.submit).not.toHaveBeenCalled();
    button('review-source').click();
    const reviewed = loadDrafts(dom.window.localStorage).drafts[0]!;
    expect(reviewed.sourceEn).toBe('Listen together, wherever you are.');
    expect(reviewed.revisionId).not.toBe(edited.revisionId);
    expect(reviewed.revisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
    expect(api.submit.mock.calls[0]![0]).toEqual(reviewed);
    expect(api.submit.mock.calls[0]![1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.submit.mock.calls[0]![2]).toBe(scope);
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(loadDrafts(dom.window.localStorage).drafts).toEqual([]);
    expect(getRandomValues).toHaveBeenCalled();
    expect(crypto.randomUUID).toBeUndefined();
  });

  it('replays the saved request after a lost response and a full editor reload', async () => {
    await startEditor();
    api.submit.mockRejectedValueOnce(new Error('response lost after server committed'));
    typeProposal('Vamos ouvir juntos.');
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button('submit-suggestion').disabled).toBe(false));
    const firstId = api.submit.mock.calls[0]![1];
    await reloadEditor();
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    expect(api.submit.mock.calls[1]![1]).toBe(firstId);
  });

  it('retains the server request identity if successful submission cleanup cannot be saved', async () => {
    await startEditor();
    const setItem = dom.window.Storage.prototype.setItem;
    api.submit.mockImplementationOnce(async () => {
      dom.window.Storage.prototype.setItem = () => {
        throw new Error('quota');
      };
      return suggestion;
    });
    const input = typeProposal('Vamos ouvir juntos.');
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(dom.window.document.getElementById('storage-warning')?.hidden).toBe(false);
    dom.window.Storage.prototype.setItem = setItem;
    const firstId = api.submit.mock.calls[0]![1];
    await reloadEditor();
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    expect(api.submit.mock.calls[1]![1]).toBe(firstId);
  });

  it('blocks POST on an earlier failed save and retries only after persistence recovers', async () => {
    await startEditor();
    const write = vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const input = typeProposal('Vamos ouvir juntos.');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    button('submit-suggestion').click();
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('submit-status')?.textContent).toBe(
        'Save and review this draft before submitting.',
      ),
    );
    expect(api.submit).not.toHaveBeenCalled();
    expect(input.value).toBe('Vamos ouvir juntos.');
    write.mockRestore();
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  });

  it('blocks submission of an in-memory draft after another tab changes storage', async () => {
    await startEditor();
    typeProposal('Vamos ouvir juntos.');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    const remote = JSON.stringify({ version: 1, drafts: [{ ...draft, reason: 'Other tab' }] });
    dom.window.localStorage.setItem(DRAFT_STORAGE_KEY, remote);
    button('submit-suggestion').click();
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('submit-status')?.textContent).toBe(
        'Save and review this draft before submitting.',
      ),
    );
    expect(api.submit).not.toHaveBeenCalled();
    expect(dom.window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(remote);
  });

  it('assigns a new identity when the user writes another proposal with the same wording', async () => {
    await startEditor();
    const input = typeProposal('Vamos ouvir juntos.');
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(input.value).toBe(''));
    const firstId = api.submit.mock.calls[0]![1];
    typeProposal('Vamos ouvir juntos.');
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    expect(api.submit.mock.calls[1]![1]).not.toBe(firstId);
  });

  it.each([
    { code: 'en', nativeName: 'English', current: draft.sourceEn, proposed: 'Listen as one.' },
    { code: 'ko', nativeName: '한국어', current: draft.sourceKo, proposed: '같이 들어요.' },
  ])('submits $code wording suggestions with the English source intact', async (target) => {
    await startEditor();
    const language = dom.window.document.getElementById('language') as HTMLSelectElement;
    expect(Array.from(language.options, (option) => option.value)).toEqual(['en', 'ko', 'pt-br']);
    const locale = { code: target.code, nativeName: target.nativeName, htmlLang: target.code };
    api.catalog.mockResolvedValue({
      locale,
      languages: [locale, portuguese],
      entries: [{ ...draft, current: target.current }],
    });
    api.submit.mockResolvedValue({
      ...suggestion,
      locale: target.code,
      current: target.current,
      proposed: target.proposed,
    });
    language.value = target.code;
    language.dispatchEvent(new dom.window.Event('change'));
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('current-label')?.textContent).toBe(
        `Current · ${target.nativeName}`,
      ),
    );
    expect(dom.window.document.getElementById('source-en')?.textContent).toBe(draft.sourceEn);
    expect(dom.window.document.getElementById('current')?.textContent).toBe(target.current);
    const input = typeProposal(target.proposed);
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
    expect(api.submit.mock.calls[0]?.[0]).toMatchObject({
      locale: target.code,
      key: draft.key,
      sourceEn: draft.sourceEn,
      sourceKo: draft.sourceKo,
      current: target.current,
      proposed: target.proposed,
    });
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(dom.window.document.getElementById('submit-status')?.textContent).toBe(
      'Submitted · Pending review',
    );
  });

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
    expect(
      dom.window.document.querySelector('#saved, #export, #wording-preview, #source-ko'),
    ).toBeNull();
    expect(
      dom.window.document.querySelector('#source-en')?.previousElementSibling?.textContent,
    ).toBe('Source(English)');
    const pending = deferred<Suggestion>();
    api.submit.mockReturnValueOnce(pending.promise);
    const input = typeProposal('Vamos ouvir juntos.');
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
    typeProposal('Vamos escutar juntos.');
    pending.resolve({ ...suggestion, locale: 'pt-br', proposed: 'Vamos ouvir juntos.' });
    await vi.waitFor(() => expect(button('submit-suggestion').disabled).toBe(false));
    expect(input.value).toBe('Vamos escutar juntos.');
    expect(button('clear-draft').disabled).toBe(false);
    api.submit.mockResolvedValue({ ...suggestion, locale: 'pt-br', proposed: input.value });
    button('submit-suggestion').click();
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(button('clear-draft').disabled).toBe(true);
    expect(dom.window.document.getElementById('submit-status')?.textContent).toBe(
      'Submitted · Pending review',
    );
  });

  it('restores saved drafts, filters them, and clears only the selected language draft', async () => {
    const saved = {
      ...draft,
      locale: 'pt-br',
      current: 'Ouvir juntos.',
      proposed: 'Vamos ouvir juntos.',
    };
    dom.window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ version: 1, drafts: [saved, draft] }),
    );
    await startEditor();
    const input = dom.window.document.getElementById('proposal') as HTMLTextAreaElement;
    expect(input.value).toBe(saved.proposed);
    expect((dom.window.document.getElementById('surface') as HTMLSelectElement).value).toBe('all');
    const filter = dom.window.document.getElementById('drafts-only') as HTMLInputElement;
    filter.checked = true;
    filter.dispatchEvent(new dom.window.Event('change'));
    expect(dom.window.document.querySelectorAll('#phrases button')).toHaveLength(1);
    button('clear-draft').click();
    expect(input.value).toBe('');
    expect(dom.window.document.querySelectorAll('#phrases button')).toHaveLength(0);
    expect(JSON.parse(dom.window.localStorage.getItem(DRAFT_STORAGE_KEY)!).drafts).toEqual([draft]);
    expect(dom.window.document.activeElement).toBe(input);
    typeProposal('Escutemos juntos.');
    expect(dom.window.document.querySelectorAll('#phrases button')).toHaveLength(1);
    typeProposal('');
    expect(dom.window.document.querySelectorAll('#phrases button')).toHaveLength(0);
  });

  it('preserves another tab’s snapshot and keeps local edits available when saving is paused', async () => {
    await startEditor();
    const input = typeProposal('Vamos ouvir juntos.');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    const remote = JSON.stringify({ version: 1, drafts: [{ ...draft, reason: 'Other tab' }] });
    dom.window.localStorage.setItem(DRAFT_STORAGE_KEY, remote);
    dom.window.dispatchEvent(
      new dom.window.StorageEvent('storage', {
        key: DRAFT_STORAGE_KEY,
        newValue: remote,
        storageArea: dom.window.localStorage,
      }),
    );
    typeProposal('Vamos escutar juntos.');
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    expect(input.value).toBe('Vamos escutar juntos.');
    expect(dom.window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(remote);
    expect(dom.window.document.getElementById('storage-warning')?.hidden).toBe(false);
    expect(dom.window.document.getElementById('save-status')?.textContent).toContain(
      'Copy your changes',
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

describe('translation page language and phrase address', () => {
  const languages = LANGUAGE_OPTIONS.map(({ code, nativeName, htmlLang }) => ({
    code,
    nativeName,
    htmlLang,
  }));
  const longKey = `hero.${'x'.repeat(1100)}`;
  const entries = [
    {
      id: 'app:app.search_title',
      surface: 'app' as const,
      key: 'app.search_title',
      sourceEn: 'MUSIXQUARE',
      sourceKo: 'MUSIXQUARE',
    },
    {
      id: draft.id,
      surface: draft.surface,
      key: draft.key,
      sourceEn: draft.sourceEn,
      sourceKo: draft.sourceKo,
    },
    {
      id: 'app:play',
      surface: 'app' as const,
      key: 'play',
      sourceEn: 'Play',
      sourceKo: '재생',
    },
    {
      id: `about:${longKey}`,
      surface: 'about' as const,
      key: longKey,
      sourceEn: 'Long',
      sourceKo: 'Long',
    },
  ];
  const signInHref = (returnTo: string) =>
    `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;

  function catalogFor(code: string) {
    const locale = languages.find((language) => language.code === code);
    if (!locale) throw new Error(`Unexpected catalog request: ${code}`);
    return {
      locale,
      languages,
      entries: entries.map((entry) => ({ ...entry, current: `${entry.sourceEn} (${code})` })),
    };
  }

  /** Start the page script; the catalog is served by `catalog`. */
  async function loadPage(
    url: string,
    browserLanguages: readonly string[],
    catalog: (code: string) => unknown = catalogFor,
  ) {
    // Flush the outgoing page's pending draft save, so its timer cannot write
    // later into another test's page or after the environment is torn down.
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    dom.window.close();
    dom = new JSDOM(html, { url });
    Object.defineProperty(dom.window.navigator, 'languages', {
      configurable: true,
      get: () => browserLanguages,
    });
    Object.defineProperty(dom.window.navigator, 'language', {
      configurable: true,
      get: () => browserLanguages[0] ?? '',
    });
    dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
    vi.resetModules();
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('Option', dom.window.Option);
    api.session.mockResolvedValue({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    api.catalog.mockImplementation(async (code: string) => catalog(code));
    await import('../../../.workshop/translate/main');
  }

  const editorShown = () =>
    vi.waitFor(() => expect(dom.window.document.getElementById('editor')?.hidden).toBe(false));

  async function openPage(
    url: string,
    browserLanguages: readonly string[],
    catalog?: (code: string) => unknown,
  ) {
    await loadPage(url, browserLanguages, catalog);
    await editorShown();
  }

  const requestedLocales = () => api.catalog.mock.calls.map(([code]) => code as string);
  const selectedKey = () => dom.window.document.getElementById('selected-key')?.textContent;
  const languageSelect = () => dom.window.document.getElementById('language') as HTMLSelectElement;
  const signInLinks = () =>
    ['suggest-sign-in', 'vote-sign-in'].map((id) =>
      dom.window.document.getElementById(id)?.getAttribute('href'),
    );

  it.each([
    [['ko-KR', 'en-US'], 'ko'],
    [['ja'], 'ja'],
    [['de-AT', 'de'], 'de'],
    [['zh-TW'], 'zh-hant'],
    [['pt-PT'], 'pt-br'],
    [['sw-KE'], 'en'],
    [['sw-KE', 'fr-CA', 'ko'], 'fr'],
  ])('opens browser languages %j on %s like the App', async (browserLanguages, expected) => {
    await openPage('https://musixquare.com/translate', browserLanguages);
    expect(requestedLocales()).toEqual([expected]);
    expect(languageSelect().value).toBe(expected);
    expect(selectedKey()).toBe(draft.key);
    expect(dom.window.location.search).toBe('');
  });

  it('prefers a supported ?locale over the browser language', async () => {
    await openPage('https://musixquare.com/translate?locale=fr', ['ko-KR']);
    expect(requestedLocales()).toEqual(['fr']);
    expect(languageSelect().value).toBe('fr');
  });

  it.each(['xx', 'pt-PT', 'FR', '<img src=x onerror=alert(1)>', ''])(
    'ignores unsupported ?locale=%s and never renders it',
    async (value) => {
      await openPage(`https://musixquare.com/translate?locale=${encodeURIComponent(value)}`, [
        'ko-KR',
      ]);
      expect(requestedLocales()).toEqual(['ko']);
      expect(dom.window.document.querySelector('img')).toBeNull();
      expect(dom.window.document.body.innerHTML).not.toContain('onerror');
    },
  );

  it('selects an existing ?phrase and keeps the first phrase for an unknown one', async () => {
    await openPage('https://musixquare.com/translate?locale=ja&phrase=app%3Aplay', ['ko']);
    expect(selectedKey()).toBe('play');
    expect(
      dom.window.document.querySelector('[data-entry-id="app:play"]')?.getAttribute('aria-current'),
    ).toBe('true');
    vi.unstubAllGlobals();
    await openPage(
      'https://musixquare.com/translate?locale=ja&phrase=app%3A%3Cb%3Emissing%3C%2Fb%3E',
      ['ko'],
    );
    expect(selectedKey()).toBe(draft.key);
    expect(dom.window.document.querySelector('b')).toBeNull();
  });

  it('selects the address phrase when Retry follows a failed first catalog load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => consoleError.mockRestore());
    let calls = 0;
    await loadPage(
      'https://musixquare.com/translate?locale=ja&phrase=app%3Aplay',
      ['ko'],
      (code: string) => {
        calls += 1;
        if (calls === 1) throw new Error('Catalog request failed: 503');
        return catalogFor(code);
      },
    );
    await vi.waitFor(() => expect(button('retry').hidden).toBe(false));
    expect(dom.window.document.getElementById('editor')?.hidden).toBe(true);

    button('retry').click();
    await editorShown();
    expect(requestedLocales()).toEqual(['ja', 'ja']);
    expect(selectedKey()).toBe('play');
    expect(
      dom.window.document.querySelector('[data-entry-id="app:play"]')?.getAttribute('aria-current'),
    ).toBe('true');
    expect(Object.fromEntries(new URLSearchParams(dom.window.location.search))).toEqual({
      locale: 'ja',
      phrase: 'app:play',
    });
  });

  it('opens the list on the page that holds the address phrase', async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      id: `app:phrase.${index}`,
      surface: 'app' as const,
      key: `phrase.${index}`,
      sourceEn: `Phrase ${index}`,
      sourceKo: `문구 ${index}`,
    }));
    const pagedCatalog = (code: string) => ({
      ...catalogFor(code),
      entries: [...many, entries[1]!].map((entry) => ({ ...entry, current: entry.sourceEn })),
    });
    const pageNumber = () => dom.window.document.getElementById('page-number')?.textContent;
    const current = () =>
      dom.window.document.querySelector('[aria-current="true"]')?.getAttribute('data-entry-id');

    await openPage(
      'https://musixquare.com/translate?locale=ko&phrase=app%3Aphrase.30',
      ['en-US'],
      pagedCatalog,
    );
    expect(selectedKey()).toBe('phrase.30');
    expect(pageNumber()).toBe('2 / 3');
    expect(current()).toBe('app:phrase.30');

    // The last phrase of a page and the first of the next.
    vi.unstubAllGlobals();
    await openPage(
      'https://musixquare.com/translate?locale=ko&phrase=app%3Aphrase.19',
      ['en-US'],
      pagedCatalog,
    );
    expect(pageNumber()).toBe('1 / 3');
    expect(current()).toBe('app:phrase.19');
    vi.unstubAllGlobals();
    await openPage(
      'https://musixquare.com/translate?locale=ko&phrase=app%3Aphrase.20',
      ['en-US'],
      pagedCatalog,
    );
    expect(pageNumber()).toBe('2 / 3');
    expect(current()).toBe('app:phrase.20');
    vi.unstubAllGlobals();
    await openPage(
      `https://musixquare.com/translate?locale=ko&phrase=${encodeURIComponent(draft.id)}`,
      ['en-US'],
      pagedCatalog,
    );
    expect(selectedKey()).toBe(draft.key);
    expect(pageNumber()).toBe('3 / 3');
    expect(current()).toBe(draft.id);
  });

  it('keeps the chosen language and phrase in the address and the sign-in return', async () => {
    await openPage('https://musixquare.com/translate', ['ko-KR']);
    const historyLength = dom.window.history.length;
    // The return is built from the shown language and catalog phrase, never from raw query text.
    const shown = signInHref(
      `/translate?${new URLSearchParams({ locale: 'ko', phrase: draft.id })}`,
    );
    expect(signInLinks()).toEqual([shown, shown]);
    expect(dom.window.location.search).toBe('');

    languageSelect().value = 'fr';
    languageSelect().dispatchEvent(new dom.window.Event('change'));
    await vi.waitFor(() => expect(dom.window.location.search).toContain('locale=fr'));
    expect(new URLSearchParams(dom.window.location.search).get('phrase')).toBe(draft.id);

    dom.window.document.querySelector<HTMLButtonElement>('[data-entry-id="app:play"]')!.click();
    expect(selectedKey()).toBe('play');
    const params = new URLSearchParams(dom.window.location.search);
    expect(Object.fromEntries(params)).toEqual({ locale: 'fr', phrase: 'app:play' });
    expect(dom.window.location.pathname).toBe('/translate');
    expect(dom.window.history.length).toBe(historyLength);
    const returnTo = `/translate${dom.window.location.search}`;
    expect(signInLinks()).toEqual([signInHref(returnTo), signInHref(returnTo)]);
  });

  it('returns from sign-in to the same language and phrase', async () => {
    await openPage(
      'https://musixquare.com/translate?locale=fr&phrase=app%3Aplay&accountAuth=success',
      ['ko-KR'],
    );
    expect(requestedLocales()).toEqual(['fr']);
    expect(selectedKey()).toBe('play');
  });

  it('drops the phrase from an over-long sign-in return so the Worker keeps the page', async () => {
    await openPage(
      `https://musixquare.com/translate?locale=ko&phrase=${encodeURIComponent(`about:${longKey}`)}`,
      ['en-US'],
    );
    expect(selectedKey()).toBe(longKey);
    expect(signInLinks()).toEqual([
      signInHref('/translate?locale=ko'),
      signInHref('/translate?locale=ko'),
    ]);
  });

  it('pins the sign-in return bound to the Worker limit', () => {
    const limit = (path: string) =>
      /RETURN_TO_MAX_UTF8_BYTES = (\d[\d_]*);/u.exec(readFileSync(path, 'utf8'))?.[1];
    expect(limit('.workshop/translate/address.ts')).toBe(limit('cloudflare/account-auth.ts'));
    expect(limit('cloudflare/account-auth.ts')).toBe('1024');
  });

  const submitStatus = () => dom.window.document.getElementById('submit-status')?.textContent;
  const afterSessionRead = () =>
    vi.waitFor(() => expect(button('submit-suggestion').textContent).not.toBe('Checking sign-in…'));

  it.each([
    ['cancelled', 'Sign-in was cancelled.'],
    ['error', 'Couldn’t sign in. Try again.'],
    ['success', ''],
  ])(
    'shows the accountAuth=%s result in the submit status and keeps only locale and phrase',
    async (outcome, message) => {
      await openPage(
        `https://musixquare.com/translate?locale=fr&accountAuth=${outcome}&phrase=app%3Aplay#suggestions`,
        ['ko-KR'],
      );
      await afterSessionRead();
      expect(Object.fromEntries(new URLSearchParams(dom.window.location.search))).toEqual({
        locale: 'fr',
        phrase: 'app:play',
      });
      expect(dom.window.location.pathname).toBe('/translate');
      expect(dom.window.location.hash).toBe('#suggestions');
      expect(requestedLocales()).toEqual(['fr']);
      expect(selectedKey()).toBe('play');
      expect(submitStatus()).toBe(message);
      expect(
        [...dom.window.document.querySelectorAll('[role="alert"]')].every(
          (alert) => (alert as HTMLElement).hidden,
        ),
      ).toBe(true);
    },
  );

  it('clears a sign-in result once the visitor edits, and ignores unknown results', async () => {
    await openPage('https://musixquare.com/translate?accountAuth=cancelled', ['ja']);
    await afterSessionRead();
    expect(dom.window.location.search).toBe('');
    expect(submitStatus()).toBe('Sign-in was cancelled.');
    const proposal = dom.window.document.getElementById('proposal') as HTMLTextAreaElement;
    proposal.value = 'x';
    proposal.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(submitStatus()).toBe('');

    await openPage('https://musixquare.com/translate?locale=ko&accountAuth=%3Cb%3Ebold%3C%2Fb%3E', [
      'ja',
    ]);
    await afterSessionRead();
    expect(dom.window.location.search).toBe('?locale=ko');
    expect(submitStatus()).toBe('');
    expect(dom.window.document.querySelector('b')).toBeNull();
  });
});
