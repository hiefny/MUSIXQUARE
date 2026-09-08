import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityApiError,
  listSuggestions,
  recommendSuggestion,
  submitSuggestion,
  withdrawSuggestion,
  type Suggestion,
} from '../../../.workshop/translate/community-client';
import type { Draft } from '../../../.workshop/translate/drafts';

const draft: Draft = {
  id: 'app:play',
  surface: 'app',
  key: 'play',
  sourceEn: 'Play',
  sourceKo: '재생',
  current: 'Jouer',
  proposed: 'Lire',
  locale: 'fr',
  reason: 'Media playback',
  updatedAt: '2026-09-08T12:00:00.000Z',
};
const suggestion: Suggestion = {
  ...draft,
  id: 'adbbf041-3d81-4e3b-a83b-383db25ac0df',
  author: 'Translator',
  createdAt: Date.parse(draft.updatedAt),
  status: 'pending',
  revision: 1,
  votes: 0,
  voted: false,
  owned: true,
  outdated: false,
  applied: false,
};
const scope = 's'.repeat(43);
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('translation community HTTP client', () => {
  it('reads a language and phrase page without caching authenticated ownership flags', async () => {
    fetchMock.mockResolvedValue(Response.json({ suggestions: [suggestion], nextCursor: 'page+2' }));
    const page = await listSuggestions({
      locale: 'fr',
      surface: 'app',
      key: 'play',
      sort: 'new',
      cursor: 'page+1',
    });
    expect(page.nextCursor).toBe('page+2');
    const [path, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(path), 'https://musixquare.com');
    expect(url.pathname).toBe('/api/translations/suggestions');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      locale: 'fr',
      surface: 'app',
      key: 'play',
      sort: 'new',
      cursor: 'page+1',
    });
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(init?.headers).has('X-MXQR-Account-Expected-Scope')).toBe(false);
  });

  it('uses explicit CSRF and account-scope fences for submission, vote changes, and withdrawal', async () => {
    fetchMock.mockImplementation(async () => Response.json({ suggestion }));
    const requestId = '07acde9c-533d-4a6d-a38e-7d98d632e598';
    await submitSuggestion(draft, requestId, scope);
    await recommendSuggestion(suggestion.id, true, scope);
    await recommendSuggestion(suggestion.id, false, scope);
    await withdrawSuggestion(suggestion.id, scope);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      'POST',
      'PUT',
      'DELETE',
      'DELETE',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-MXQR-Account-CSRF')).toBe('1');
      expect(headers.get('X-MXQR-Account-Expected-Scope')).toBe(scope);
      expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    }
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ draft, requestId });
  });

  it('rejects a missing account scope before issuing a mutation', async () => {
    await expect(submitSuggestion(draft, crypto.randomUUID(), '')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves backend conflict and rate-limit codes without exposing them as public copy', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'SOURCE_CHANGED' }, { status: 409 }));
    await expect(submitSuggestion(draft, crypto.randomUUID(), scope)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
      status: 409,
    });
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'RATE_LIMITED' }, { status: 429 }));
    await expect(recommendSuggestion(suggestion.id, true, scope)).rejects.toBeInstanceOf(
      CommunityApiError,
    );
  });

  it('rejects malformed or mixed-locale lists and a mismatched submission response', async () => {
    for (const payload of [
      { suggestions: [{ ...suggestion, locale: 'de' }], nextCursor: null },
      { suggestions: [{ ...suggestion, votes: -1 }], nextCursor: null },
      { suggestions: [{ ...suggestion, createdAt: Number.MAX_SAFE_INTEGER }], nextCursor: null },
      { suggestions: [suggestion], nextCursor: 1 },
    ]) {
      fetchMock.mockResolvedValueOnce(Response.json(payload));
      await expect(listSuggestions({ locale: 'fr', sort: 'top' })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    }
    fetchMock.mockResolvedValueOnce(
      Response.json({ suggestion: { ...suggestion, proposed: 'Different wording' } }),
    );
    await expect(submitSuggestion(draft, crypto.randomUUID(), scope)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('cancels a pending list read when its view is replaced', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = listSuggestions({ locale: 'fr', sort: 'top' }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
