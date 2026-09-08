import {
  loadDrafts,
  saveDrafts,
  validateProposal,
  type Draft,
  type Entry,
  type ProposalIssue,
  type StorageWarning,
} from './drafts';
import { loadTranslationCatalog } from './catalog-client';
import { createStorageSession } from './storage-session';
import { initCommunity } from './community';

interface Language {
  code: string;
  nativeName: string;
  htmlLang: string;
}
interface Catalog {
  locale: Language;
  languages: Language[];
  entries: Entry[];
}

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing translation workspace element: ${id}`);
  return result as T;
}
const language = element<HTMLSelectElement>('language');
const surface = element<HTMLSelectElement>('surface');
const search = element<HTMLInputElement>('search');
const draftsOnly = element<HTMLInputElement>('drafts-only');
const proposal = element<HTMLTextAreaElement>('proposal');
const reason = element<HTMLTextAreaElement>('reason');
const phraseList = element<HTMLUListElement>('phrases');
const clearButton = element<HTMLButtonElement>('clear-draft');
const reviewButton = element<HTMLButtonElement>('review-source');
const storageSession = createStorageSession();
const initial = loadDrafts();
const draftKey = (locale: string, id: string) => `${locale}:${id}`;
const drafts = new Map(initial.drafts.map((draft) => [draftKey(draft.locale, draft.id), draft]));
const pageSize = 20;
let catalog: Catalog | null = null;
let selectedId = 'about:hero.h1';
let page = 0;
let requestedLocale = 'pt-br';
let request: AbortController | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const community = initCommunity({
  currentDraft,
  canSubmit: () => {
    const entry = selectedEntry();
    const draft = currentDraft();
    return (
      !!entry &&
      !!draft &&
      !referencesChanged(draft, entry) &&
      validateProposal(entry, draft.proposed).length === 0
    );
  },
  prepareDraft: prepareSubmission,
  onSubmitted: removeDraft,
});

const issueMessages: Record<ProposalIssue, string> = {
  empty: 'Enter a suggestion.',
  unchanged: 'This matches the current translation.',
  'too-long': 'This suggestion is too long.',
  placeholders: 'Keep every {{variable}}, including repeats.',
  markup: 'Keep the original HTML tags and attributes.',
};
const storageMessages: Record<StorageWarning, string> = {
  unavailable: 'Local storage is unavailable. Copy your changes before leaving.',
  'invalid-data': 'Some saved data could not be read.',
  'too-large': 'Local storage is full. Copy your changes before leaving.',
  'read-failed': 'Saved drafts could not be read.',
  'write-failed': 'Drafts could not be saved. Copy your changes before leaving.',
};

function setStorageWarning(warning?: StorageWarning): void {
  const target = element('storage-warning');
  target.hidden = !warning && !storageSession.hasConflict;
  target.textContent = storageSession.hasConflict
    ? 'Drafts changed in another tab. Copy your changes before reloading.'
    : warning
      ? storageMessages[warning]
      : '';
}

function reportActionFailure(error: unknown): void {
  console.error(error);
  element('load-error').textContent = 'Couldn’t complete this action. Try again.';
  element('load-error').hidden = false;
}

function persist(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!storageSession.beforeSave()) {
    setStorageWarning();
    element('save-status').textContent = 'Saving paused. Copy your changes before reloading.';
    return;
  }
  const result = saveDrafts([...drafts.values()]);
  if (result.ok) storageSession.afterSave();
  setStorageWarning(result.warning);
  element('save-status').textContent = result.ok
    ? 'Saved locally'
    : 'Not saved. Copy your changes.';
}

function selectedEntry(): Entry | undefined {
  return catalog?.entries.find((entry) => entry.id === selectedId);
}

function currentDraft(): Draft | undefined {
  return catalog ? drafts.get(draftKey(catalog.locale.code, selectedId)) : undefined;
}

function referencesChanged(draft: Draft, entry: Entry): boolean {
  return (
    draft.sourceEn !== entry.sourceEn ||
    draft.sourceKo !== entry.sourceKo ||
    draft.current !== entry.current ||
    draft.surface !== entry.surface ||
    draft.key !== entry.key
  );
}

async function prepareSubmission(draft: Draft): Promise<boolean> {
  if (saveTimer !== undefined) persist();
  const next = await fetchCatalog(draft.locale);
  if (catalog?.locale.code === draft.locale) {
    catalog = next;
    const entry = selectedEntry();
    element('editor').hidden = !entry;
    if (entry) {
      renderReferences(entry);
      renderValidation();
    }
  }

  const entry = next.entries.find((candidate) => candidate.id === draft.id);
  return (
    currentDraft() === draft &&
    !!entry &&
    !referencesChanged(draft, entry) &&
    validateProposal(entry, draft.proposed).length === 0
  );
}

function removeDraft(draft: Draft, focusEditor = false): void {
  const key = draftKey(draft.locale, draft.id);
  // A late submission must never erase wording typed while the request was in flight.
  if (drafts.get(key) !== draft) return;
  const selected = currentDraft() === draft;
  drafts.delete(key);
  if (selected) {
    proposal.value = reason.value = '';
    community.clearSubmitStatus();
  }
  persist();
  renderValidation();
  renderResults();
  if (focusEditor) proposal.focus({ preventScroll: true });
}

async function fetchCatalog(locale: string, signal?: AbortSignal): Promise<Catalog> {
  return loadTranslationCatalog(locale, signal);
}

function plainPreview(value: string): string {
  // Even imported HTML stays text. Only line-break notation is shown as a newline.
  return value.replace(/<br\s*\/?\s*>/gi, '\n');
}

function filteredEntries(): Entry[] {
  if (!catalog) return [];
  const query = search.value.trim().toLocaleLowerCase();
  return catalog.entries.filter((entry) => {
    if (surface.value !== 'all' && entry.surface !== surface.value) return false;
    if (draftsOnly.checked && !drafts.has(draftKey(catalog!.locale.code, entry.id))) return false;
    return (
      !query ||
      [entry.key, entry.current, entry.sourceEn, entry.sourceKo].some((value) =>
        value.toLocaleLowerCase().includes(query),
      )
    );
  });
}

function renderResults(): void {
  const entries = filteredEntries();
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  page = Math.min(page, totalPages - 1);
  element('result-count').textContent =
    `${entries.length} ${entries.length === 1 ? 'phrase' : 'phrases'}`;
  phraseList.replaceChildren();
  for (const entry of entries.slice(page * pageSize, (page + 1) * pageSize)) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'translation-phrase';
    button.dataset.entryId = entry.id;
    if (entry.id === selectedId) button.setAttribute('aria-current', 'true');
    const key = document.createElement('span');
    key.className = 'translation-phrase-key';
    const keyText = document.createElement('span');
    keyText.textContent = `${entry.surface === 'about' ? 'About' : 'App'} · ${entry.key}`;
    key.append(keyText);
    const marker = document.createElement('small');
    marker.textContent = 'Draft';
    marker.hidden = !drafts.has(draftKey(catalog!.locale.code, entry.id));
    key.append(marker);
    const text = document.createElement('span');
    text.className = 'translation-phrase-text';
    text.lang = catalog!.locale.htmlLang;
    text.dir = 'auto';
    text.textContent = plainPreview(entry.current);
    button.append(key, text);
    button.addEventListener('click', () => {
      selectEntry(entry.id);
      element('editor').scrollIntoView({ behavior: 'auto', block: 'start' });
      proposal.focus({ preventScroll: true });
    });
    item.append(button);
    phraseList.append(item);
  }
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'translation-empty';
    empty.textContent = draftsOnly.checked ? 'No drafts match these filters.' : 'No phrases found.';
    phraseList.append(empty);
  }
  element('pagination').hidden = totalPages <= 1;
  element('page-number').textContent = `${page + 1} / ${totalPages}`;
  element<HTMLButtonElement>('previous-page').disabled = page === 0;
  element<HTMLButtonElement>('next-page').disabled = page + 1 === totalPages;
}

function renderValidation(): void {
  const entry = selectedEntry();
  if (!entry) return;
  const issues = proposal.value ? validateProposal(entry, proposal.value) : [];
  const draft = currentDraft();
  const needsReview = !!draft && referencesChanged(draft, entry);
  reviewButton.hidden = !needsReview;
  const list = element('proposal-issues');
  list.replaceChildren();
  if (needsReview) {
    const item = document.createElement('li');
    item.textContent = 'References changed. Review them before submitting.';
    list.append(item);
  }
  for (const issue of issues) {
    const item = document.createElement('li');
    item.textContent = issueMessages[issue];
    list.append(item);
  }
  list.hidden = issues.length === 0 && !needsReview;
  proposal.setAttribute('aria-invalid', String(issues.length > 0 || needsReview));
  element('character-count').textContent = `${Array.from(proposal.value).length} characters`;
  clearButton.disabled = !currentDraft();
  community.updateSubmit();
}

function renderReferences(entry: Entry): void {
  if (!catalog) return;
  element('selected-surface').textContent = entry.surface === 'about' ? 'About' : 'App';
  element('selected-key').textContent = entry.key;
  element('source-en').textContent = entry.sourceEn;
  element('current').textContent = entry.current;
  element('current').lang = catalog.locale.htmlLang;
  element('current-label').textContent = `Current · ${catalog.locale.nativeName}`;
}

function selectEntry(id: string): void {
  if (saveTimer !== undefined) persist();
  selectedId = id;
  const entry = selectedEntry();
  element('editor').hidden = !entry;
  community.clearSubmitStatus();
  if (catalog) community.setContext(catalog.locale.code, entry);
  if (!entry || !catalog) return;
  const draft = currentDraft();
  renderReferences(entry);
  proposal.value = draft?.proposed ?? '';
  proposal.lang = catalog.locale.htmlLang;
  proposal.dir = ['ar', 'fa', 'he', 'ur'].includes(catalog.locale.code) ? 'rtl' : 'ltr';
  reason.value = draft?.reason ?? '';
  element('save-status').textContent = draft ? 'Draft restored' : '';
  if (draft && referencesChanged(draft, entry)) {
    element('save-status').textContent = 'References changed.';
  }
  renderValidation();
  renderResults();
}

function updateDraft(): void {
  const entry = selectedEntry();
  if (!entry || !catalog) return;
  const key = draftKey(catalog.locale.code, entry.id);
  const hadDraft = drafts.has(key);
  if (!proposal.value && !reason.value) drafts.delete(key);
  else
    drafts.set(key, {
      ...(drafts.get(key) ?? entry),
      locale: catalog.locale.code,
      proposed: proposal.value,
      reason: reason.value,
      updatedAt: new Date().toISOString(),
    });
  renderValidation();

  community.clearSubmitStatus();
  // Rebuild filtered results only when a phrase enters or leaves the draft list.
  if (draftsOnly.checked && hadDraft !== drafts.has(key)) renderResults();
  for (const button of phraseList.querySelectorAll<HTMLButtonElement>('button[data-entry-id]')) {
    if (button.dataset.entryId === entry.id) {
      const marker = button.querySelector('small');
      if (marker) marker.hidden = !drafts.has(key);
    }
  }
  element('save-status').textContent = storageSession.hasConflict
    ? 'Saving paused. Copy your changes before reloading.'
    : 'Saving…';
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}

async function loadCatalog(locale: string, id = selectedId): Promise<void> {
  if (saveTimer !== undefined) persist();
  request?.abort();
  const active = new AbortController();
  request = active;
  requestedLocale = locale;
  catalog = null;
  community.setContext(locale, undefined);
  surface.disabled = search.disabled = true;
  element('editor').hidden = true;
  phraseList.replaceChildren();
  phraseList.setAttribute('aria-busy', 'true');
  element('result-count').textContent = 'Loading…';
  element('load-error').hidden = element('retry').hidden = element('pagination').hidden = true;
  try {
    const next = await fetchCatalog(locale, active.signal);
    if (active.signal.aborted) return;
    catalog = next;
    if (language.options.length <= 1) {
      language.replaceChildren(
        ...next.languages
          .filter((lang) => !['en', 'ko'].includes(lang.code))
          .map((lang) => new Option(lang.nativeName, lang.code)),
      );
    }
    language.value = next.locale.code;
    language.disabled = surface.disabled = search.disabled = false;
    page = 0;
    const available = filteredEntries();
    selectEntry(
      available.find((entry) => entry.id === id)?.id ??
        available[0]?.id ??
        next.entries[0]?.id ??
        '',
    );
  } catch (error) {
    if (active.signal.aborted) return;
    element('load-error').textContent = 'Couldn’t load translations.';
    element('load-error').hidden = element('retry').hidden = false;
    element('result-count').textContent = 'Translations unavailable';
    console.error(error);
  } finally {
    if (request === active) phraseList.setAttribute('aria-busy', 'false');
  }
}

language.addEventListener('change', () => {
  loadCatalog(language.value).catch(reportActionFailure);
});
surface.addEventListener('change', () => {
  page = 0;
  renderResults();
});
search.addEventListener('input', () => {
  page = 0;
  renderResults();
});
draftsOnly.addEventListener('change', () => {
  page = 0;
  renderResults();
});
element('previous-page').addEventListener('click', () => {
  page--;
  renderResults();
  phraseList.scrollTop = 0;
});
element('next-page').addEventListener('click', () => {
  page++;
  renderResults();
  phraseList.scrollTop = 0;
});
element('retry').addEventListener('click', () => {
  loadCatalog(requestedLocale).catch(reportActionFailure);
});
proposal.addEventListener('input', updateDraft);
reason.addEventListener('input', updateDraft);
window.addEventListener('pagehide', () => {
  if (saveTimer !== undefined) persist();
});
window.addEventListener('storage', (event) => {
  try {
    if (event.storageArea !== window.localStorage) return;
  } catch {
    return;
  }
  if (storageSession.observe(event.key, event.newValue)) {
    setStorageWarning();
    element('save-status').textContent = 'Saving paused. Copy your changes before reloading.';
  }
});
clearButton.addEventListener('click', () => {
  const draft = currentDraft();
  if (draft) removeDraft(draft, true);
});
reviewButton.addEventListener('click', () => {
  const entry = selectedEntry();
  const draft = currentDraft();
  if (!entry || !draft) return;
  drafts.set(draftKey(draft.locale, draft.id), {
    ...draft,
    ...entry,
    updatedAt: new Date().toISOString(),
  });
  persist();
  renderValidation();

  proposal.focus();
});
setStorageWarning(initial.warning);

loadCatalog(requestedLocale).catch(reportActionFailure);
