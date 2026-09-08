import {
  CommunityApiError,
  TRANSLATION_SIGN_IN_URL,
  communityErrorMessage,
  getAccountSession,
  listSuggestions,
  recommendSuggestion,
  submitSuggestion,
  withdrawSuggestion,
  type AccountSessionResponse,
  type Suggestion,
  type SuggestionQuery,
} from './community-client';
import type { Draft, Entry } from './drafts';

interface CommunityOptions {
  currentDraft(): Draft | undefined;
  canSubmit(): boolean;
  prepareDraft(draft: Draft): Promise<boolean>;
  onSubmitted(draft: Draft): void;
}

export function initCommunity(options: CommunityOptions, root: Document = document) {
  function element<T extends HTMLElement>(id: string): T {
    const target = root.getElementById(id);
    if (!target) throw new Error(`Missing community element: ${id}`);
    return target as T;
  }
  const submit = element<HTMLButtonElement>('submit-suggestion');
  const signIn = element<HTMLAnchorElement>('suggest-sign-in');
  const voteSignIn = element<HTMLAnchorElement>('vote-sign-in');
  const submitStatus = element('submit-status');
  const boardStatus = element('suggestions-status');
  const list = element<HTMLUListElement>('community-suggestions');
  const sort = element<HTMLSelectElement>('suggestions-sort');
  const filter = element<HTMLSelectElement>('suggestions-filter');
  const more = element<HTMLButtonElement>('suggestions-more');
  const retry = element<HTMLButtonElement>('suggestions-retry');
  let context: { locale: string; entry: Entry | undefined } | null = null;
  let session: AccountSessionResponse | null = null;
  let sessionLoading = true;
  let sessionRead: Promise<void> | undefined;
  let submitting = false;
  let active: AbortController | undefined;
  let cursor: string | null = null;
  let suggestions: Suggestion[] = [];
  let queryKey = '';
  let disposed = false;
  const busy = new Set<string>();
  const requests = new WeakMap<Draft, { scope: string; requestId: string }>();

  signIn.href = voteSignIn.href = TRANSLATION_SIGN_IN_URL;

  function reportFailure(error: unknown): void {
    if (!disposed) boardStatus.textContent = communityErrorMessage(error);
  }

  function updateSubmit(): void {
    const signedOut = !!session?.configured && !session.authenticated;
    signIn.hidden = !signedOut;
    voteSignIn.hidden = !signedOut;
    submit.hidden = signedOut;
    submit.disabled =
      sessionLoading ||
      submitting ||
      session?.configured === false ||
      (!!session?.authenticated && !options.canSubmit());
    submit.textContent = submitting
      ? 'Submitting…'
      : sessionLoading
        ? 'Checking sign-in…'
        : !session
          ? 'Retry sign-in'
          : !session.configured
            ? 'Sign-in unavailable'
            : 'Submit publicly';
  }

  async function refreshSession(): Promise<void> {
    if (sessionRead) return sessionRead;
    sessionLoading = true;
    updateSubmit();
    const previousScope = session?.statsScope;
    sessionRead = (async () => {
      try {
        const next = await getAccountSession();
        if (disposed) return;
        session = next;
        element('community-account').textContent = next.authenticated
          ? next.account?.nickname || 'Contributor'
          : '';
      } catch {
        if (disposed) return;
        session = null;
        element('community-account').textContent = 'Sign-in unavailable';
      } finally {
        sessionLoading = false;
        sessionRead = undefined;
        if (!disposed) {
          updateSubmit();
          render();
          if (previousScope !== session?.statsScope && context) load().catch(reportFailure);
        }
      }
    })();
    return sessionRead;
  }

  function query(): SuggestionQuery | null {
    if (!context) return null;
    const selected = filter.value === 'phrase' ? context.entry : undefined;
    return {
      locale: context.locale,
      sort: sort.value === 'new' ? 'new' : 'top',
      ...(selected ? { surface: selected.surface, key: selected.key } : {}),
    };
  }

  async function load(append = false): Promise<void> {
    const nextQuery = query();
    if (!nextQuery || disposed) return;
    active?.abort();
    const request = new AbortController();
    active = request;
    queryKey = JSON.stringify(nextQuery);
    if (!append) {
      suggestions = [];
      cursor = null;
      render();
    }
    list.setAttribute('aria-busy', 'true');
    more.disabled = true;
    retry.hidden = true;
    boardStatus.textContent = 'Loading…';
    try {
      const page = await listSuggestions(
        { ...nextQuery, ...(append && cursor ? { cursor } : {}) },
        request.signal,
      );
      if (request.signal.aborted || disposed) return;
      const existing = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
      for (const suggestion of page.suggestions) existing.set(suggestion.id, suggestion);
      suggestions = [...existing.values()];
      cursor = page.nextCursor;
      boardStatus.textContent = suggestions.length ? '' : 'No suggestions yet.';
      render();
    } catch (error) {
      if (request.signal.aborted || disposed) return;
      boardStatus.textContent = communityErrorMessage(error);
      retry.hidden = false;
    } finally {
      if (active === request && !disposed) {
        list.setAttribute('aria-busy', 'false');
        more.hidden = !cursor;
        more.disabled = false;
      }
    }
  }

  function text(tag: string, value: string, className = ''): HTMLElement {
    const node = root.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function render(): void {
    list.replaceChildren();
    for (const suggestion of suggestions) {
      const item = root.createElement('li');
      item.className = 'translation-community-item';
      const heading = text('div', '', 'translation-community-heading');
      const author = text('span', suggestion.author || 'Contributor');
      const status = suggestion.applied
        ? 'Applied'
        : suggestion.outdated
          ? 'Outdated'
          : {
              pending: 'Pending review',
              approved: 'Approved',
              rejected: 'Declined',
              withdrawn: 'Withdrawn',
            }[suggestion.status];
      heading.append(author, text('span', status, 'translation-community-status'));
      item.append(heading);
      item.append(
        text(
          'p',
          `${suggestion.surface === 'app' ? 'App' : 'About'} · ${suggestion.key}`,
          'translation-saved-key',
        ),
      );
      const wording = text('p', suggestion.proposed, 'translation-community-wording');
      wording.dir = 'auto';
      wording.lang = suggestion.locale;
      if (suggestion.proposed.length > 500) {
        const expanded = root.createElement('details');
        expanded.className = 'translation-community-expanded';
        const summary = text('summary', `${suggestion.proposed.slice(0, 180)}…`);
        summary.dir = 'auto';
        expanded.append(summary, wording);
        item.append(expanded);
      } else item.append(wording);
      if (suggestion.reason) item.append(text('p', suggestion.reason, 'translation-note'));
      const comparison = root.createElement('details');
      comparison.className = 'translation-text-preview';
      comparison.append(text('summary', 'Compare'));
      for (const [label, value] of [
        ['Source(English)', suggestion.sourceEn],
        ['Current translation', suggestion.current],
      ]) {
        comparison.append(text('p', label!, 'translation-reference-label'));
        const source = text('p', value!, 'translation-community-wording');
        source.dir = 'auto';
        comparison.append(source);
      }
      item.append(comparison);
      const actions = text('div', '', 'translation-community-actions');
      const vote = root.createElement('button');
      vote.type = 'button';
      vote.className = 'translation-button translation-button--quiet';
      vote.textContent = `${suggestion.voted ? 'Recommended' : 'Recommend'} · ${suggestion.votes}`;
      vote.setAttribute('aria-pressed', String(suggestion.voted));
      const closed = !['pending', 'approved'].includes(suggestion.status);
      vote.disabled =
        !session?.authenticated || sessionLoading || closed || busy.has(suggestion.id);
      vote.addEventListener('click', () => {
        changeSuggestion(suggestion, 'vote').catch(reportFailure);
      });
      actions.append(vote);
      const date = root.createElement('time');
      date.dateTime = new Date(suggestion.createdAt).toISOString();
      date.textContent = new Date(suggestion.createdAt).toLocaleDateString();
      actions.append(date);
      if (
        suggestion.owned &&
        !suggestion.applied &&
        ['pending', 'approved'].includes(suggestion.status)
      ) {
        const withdraw = root.createElement('button');
        withdraw.type = 'button';
        withdraw.className = 'translation-button translation-button--quiet';
        withdraw.textContent = 'Withdraw';
        withdraw.disabled = !session?.authenticated || sessionLoading || busy.has(suggestion.id);
        withdraw.addEventListener('click', () => {
          changeSuggestion(suggestion, 'withdraw').catch(reportFailure);
        });
        actions.append(withdraw);
      }
      item.append(actions);
      list.append(item);
    }
  }

  async function handleAuthError(error: unknown): Promise<void> {
    if (
      error instanceof CommunityApiError &&
      ['AUTH_REQUIRED', 'ACCOUNT_SESSION_CHANGED'].includes(error.code)
    ) {
      await refreshSession();
    }
  }

  async function changeSuggestion(
    suggestion: Suggestion,
    action: 'vote' | 'withdraw',
  ): Promise<void> {
    const scope = session?.statsScope;
    if (!scope || busy.has(suggestion.id)) return;
    const originalQuery = queryKey;
    busy.add(suggestion.id);
    render();
    try {
      const updated =
        action === 'vote'
          ? await recommendSuggestion(suggestion.id, !suggestion.voted, scope)
          : await withdrawSuggestion(suggestion.id, scope);
      if (disposed || session?.statsScope !== scope) return;
      if (queryKey === originalQuery) {
        suggestions = suggestions.map((item) => (item.id === updated.id ? updated : item));
        // Cancel any older list read so it cannot restore the pre-mutation vote state.
        await load();
        if (queryKey === originalQuery && action === 'withdraw')
          boardStatus.textContent = 'Suggestion withdrawn.';
      }
    } catch (error) {
      if (disposed) return;
      if (queryKey === originalQuery) boardStatus.textContent = communityErrorMessage(error);
      await handleAuthError(error);
    } finally {
      busy.delete(suggestion.id);
      if (!disposed) render();
    }
  }

  async function publish(): Promise<void> {
    if (submitting) return;
    if (!session) {
      await refreshSession();
      return;
    }
    const scope = session.statsScope;
    const draft = options.currentDraft();
    if (!scope || !draft || !options.canSubmit()) return;
    submitting = true;
    updateSubmit();
    submitStatus.textContent = 'Checking references…';
    try {
      if (!(await options.prepareDraft(draft))) {
        if (options.currentDraft() === draft)
          submitStatus.textContent = 'Review this draft before submitting.';
        return;
      }
      if (options.currentDraft() !== draft || session?.statsScope !== scope || disposed) return;
      let ticket = requests.get(draft);
      if (!ticket || ticket.scope !== scope) {
        ticket = { scope, requestId: crypto.randomUUID() };
        requests.set(draft, ticket);
      }
      submitStatus.textContent = 'Submitting…';
      await submitSuggestion(draft, ticket.requestId, scope);
      if (disposed || session?.statsScope !== scope) return;
      const selected = options.currentDraft() === draft;
      options.onSubmitted(draft);
      if (selected) submitStatus.textContent = 'Submitted · Pending review';
      else submitStatus.textContent = '';
      if (context?.locale === draft.locale) await load();
    } catch (error) {
      if (disposed) return;
      if (options.currentDraft() === draft) submitStatus.textContent = communityErrorMessage(error);
      if (error instanceof CommunityApiError && error.code === 'SOURCE_CHANGED') {
        await options.prepareDraft(draft).catch(() => undefined);
      }
      await handleAuthError(error);
    } finally {
      submitting = false;
      if (!disposed) updateSubmit();
    }
  }

  submit.addEventListener('click', () => {
    publish().catch(reportFailure);
  });
  sort.addEventListener('change', () => {
    load().catch(reportFailure);
  });
  filter.addEventListener('change', () => {
    load().catch(reportFailure);
  });
  more.addEventListener('click', () => {
    load(true).catch(reportFailure);
  });
  retry.addEventListener('click', () => {
    load().catch(reportFailure);
  });
  const focus = () => {
    refreshSession().catch(reportFailure);
  };
  root.defaultView?.addEventListener('focus', focus);
  refreshSession().catch(reportFailure);

  return {
    updateSubmit,
    clearSubmitStatus() {
      submitStatus.textContent = '';
    },
    setContext(locale: string, entry: Entry | undefined) {
      const previous = JSON.stringify(query());
      context = { locale, entry };
      const phraseOption = filter.querySelector<HTMLOptionElement>('option[value="phrase"]');
      if (phraseOption) phraseOption.disabled = !entry;
      if (!entry && filter.value === 'phrase') filter.value = 'all';
      if (previous !== JSON.stringify(query())) load().catch(reportFailure);
    },
    destroy() {
      disposed = true;
      active?.abort();
      root.defaultView?.removeEventListener('focus', focus);
    },
  };
}
