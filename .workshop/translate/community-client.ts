import { getAccountSession, type AccountSessionResponse } from '../../src/account/api';
import { readBoundedResponseText, withRequestDeadline } from '../../src/core/request-lifetime';
import type { Suggestion } from '../../src/i18n/translation-community';
import type { Draft } from './drafts';

export { getAccountSession, type AccountSessionResponse, type Suggestion };

export const TRANSLATION_SIGN_IN_URL = '/api/auth/google/start?returnTo=%2Ftranslate';
const ENDPOINT = '/api/translations/suggestions';

export interface SuggestionQuery {
  locale: string;
  surface?: 'app' | 'about';
  key?: string;
  sort: 'top' | 'new';
  cursor?: string;
}

export interface SuggestionPage {
  suggestions: Suggestion[];
  nextCursor: string | null;
}

export class CommunityApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'CommunityApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSuggestion(value: unknown): value is Suggestion {
  if (!isRecord(value)) return false;
  return (
    [
      'id',
      'locale',
      'key',
      'sourceEn',
      'sourceKo',
      'current',
      'proposed',
      'reason',
      'author',
    ].every((key) => typeof value[key] === 'string') &&
    (value.surface === 'app' || value.surface === 'about') &&
    ['pending', 'approved', 'rejected', 'withdrawn'].includes(String(value.status)) &&
    ['createdAt', 'revision', 'votes'].every(
      (key) =>
        typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0,
    ) &&
    Number.isFinite(new Date(value.createdAt as number).getTime()) &&
    ['voted', 'owned', 'outdated', 'applied'].every((key) => typeof value[key] === 'boolean')
  );
}

async function requestJson(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<unknown> {
  return withRequestDeadline(
    async (activeSignal) => {
      const response = await fetch(path, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: activeSignal,
      });
      const text = await readBoundedResponseText(response, 8 * 1024 * 1024, activeSignal);
      const value: unknown = JSON.parse(text);
      if (!response.ok) {
        throw new CommunityApiError(
          isRecord(value) && typeof value.error === 'string' ? value.error : 'REQUEST_FAILED',
          response.status,
        );
      }
      return value;
    },
    signal ? { signal } : {},
  );
}

export async function listSuggestions(
  query: SuggestionQuery,
  signal?: AbortSignal,
): Promise<SuggestionPage> {
  const params = new URLSearchParams({ locale: query.locale, sort: query.sort });
  if (query.surface) params.set('surface', query.surface);
  if (query.key) params.set('key', query.key);
  if (query.cursor) params.set('cursor', query.cursor);
  const value = await requestJson(`${ENDPOINT}?${params}`, {}, signal);
  if (
    !isRecord(value) ||
    !Array.isArray(value.suggestions) ||
    !value.suggestions.every(isSuggestion) ||
    !value.suggestions.every(
      (item) =>
        item.locale === query.locale &&
        (!query.surface || item.surface === query.surface) &&
        (!query.key || item.key === query.key),
    ) ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string')
  ) {
    throw new CommunityApiError('INVALID_RESPONSE', 502);
  }
  return { suggestions: value.suggestions, nextCursor: value.nextCursor };
}

async function mutate(
  suffix: string,
  method: 'POST' | 'PUT' | 'DELETE',
  scope: string,
  body?: unknown,
): Promise<Suggestion> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(scope)) throw new CommunityApiError('AUTH_REQUIRED', 401);
  const headers = {
    'Content-Type': 'application/json',
    'X-MXQR-Account-CSRF': '1',
    'X-MXQR-Account-Expected-Scope': scope,
  };
  const value = await requestJson(`${ENDPOINT}${suffix}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!isRecord(value) || !isSuggestion(value.suggestion)) {
    throw new CommunityApiError('INVALID_RESPONSE', 502);
  }
  return value.suggestion;
}

export async function submitSuggestion(
  draft: Draft,
  requestId: string,
  scope: string,
): Promise<Suggestion> {
  const suggestion = await mutate('', 'POST', scope, { requestId, draft });
  if (
    suggestion.locale !== draft.locale ||
    suggestion.surface !== draft.surface ||
    suggestion.key !== draft.key ||
    suggestion.proposed !== draft.proposed ||
    suggestion.reason !== draft.reason ||
    suggestion.sourceEn !== draft.sourceEn ||
    suggestion.sourceKo !== draft.sourceKo ||
    suggestion.current !== draft.current
  ) {
    throw new CommunityApiError('INVALID_RESPONSE', 502);
  }
  return suggestion;
}

export function recommendSuggestion(
  id: string,
  recommended: boolean,
  scope: string,
): Promise<Suggestion> {
  return mutate(`/${encodeURIComponent(id)}/vote`, recommended ? 'PUT' : 'DELETE', scope);
}

export function withdrawSuggestion(id: string, scope: string): Promise<Suggestion> {
  return mutate(`/${encodeURIComponent(id)}`, 'DELETE', scope);
}

export function communityErrorMessage(error: unknown): string {
  if (!(error instanceof CommunityApiError)) return 'Connection failed. Try again.';
  if (error.code === 'AUTH_REQUIRED') return 'Sign in to continue.';
  if (error.code === 'ACCOUNT_SESSION_CHANGED') return 'Your account changed. Try again.';
  if (error.code === 'SOURCE_CHANGED') return 'References changed. Review this draft.';
  if (error.code === 'RATE_LIMITED') return 'Too many requests. Try again shortly.';
  if (error.code === 'SUGGESTION_CLOSED') return 'This suggestion is closed.';
  if (error.code === 'ALREADY_APPLIED') return 'This translation is already in use.';
  if (error.code === 'INVALID_PROPOSAL' || error.code === 'INVALID_DRAFT')
    return 'Review this draft before submitting.';
  if (error.code === 'NOT_FOUND') return 'This suggestion is no longer available.';
  return 'Couldn’t complete this action. Try again.';
}
