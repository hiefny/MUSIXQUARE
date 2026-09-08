import {
  createExport,
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
const exportButton = element<HTMLButtonElement>('export');
const clearButton = element<HTMLButtonElement>('clear-draft');
const reviewButton = element<HTMLButtonElement>('review-source');
const storageSession = createStorageSession();
const initial = loadDrafts();
const draftKey = (locale: string, id: string) => `${locale}:${id}`;
const drafts = new Map(initial.drafts.map((draft) => [draftKey(draft.locale, draft.id), draft]));
const currentCatalogs = new Map<string, Catalog>();
const pageSize = 20;
let catalog: Catalog | null = null;
let selectedId = 'about:hero.h1';
let page = 0;
let requestedLocale = 'pt-br';
let request: AbortController | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let exporting = false;
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
  onSubmitted: finishSubmission,
});

const issueMessages: Record<ProposalIssue, string> = {
  empty: 'Enter a suggestion.',
  unchanged: 'This matches the current translation.',
  'too-long': 'This suggestion is too long.',
  placeholders: 'Keep every {{variable}}, including repeats.',
  markup: 'Keep the original HTML tags and attributes.',
};
const storageMessages: Record<StorageWarning, string> = {
  unavailable: 'Local storage is unavailable. Export your drafts before leaving.',
  'invalid-data': 'Some saved data could not be read.',
  'too-large': 'Local storage is full. Export your drafts before leaving.',
  'read-failed': 'Saved drafts could not be read.',
  'write-failed': 'Drafts could not be saved. Export a copy before leaving.',
};

function setStorageWarning(warning?: StorageWarning): void {
  const target = element('storage-warning');
  target.hidden = !warning && !storageSession.hasConflict;
  target.textContent = storageSession.hasConflict
    ? 'Drafts changed in another tab. Export this tab’s work before reloading.'
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
    element('save-status').textContent = 'Saving paused. Export before reloading.';
    return;
  }
  const result = saveDrafts([...drafts.values()]);
  if (result.ok) storageSession.afterSave();
  setStorageWarning(result.warning);
  element('save-status').textContent = result.ok ? 'Saved locally' : 'Not saved. Export a copy.';
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
  currentCatalogs.set(draft.locale, next);
  if (catalog?.locale.code === draft.locale) {
    catalog = next;
    const entry = selectedEntry();
    element('editor').hidden = !entry;
    if (entry) {
      renderReferences(entry);
      renderValidation();
    }
  }
  renderDrafts();
  const entry = next.entries.find((candidate) => candidate.id === draft.id);
  return (
    currentDraft() === draft &&
    !!entry &&
    !referencesChanged(draft, entry) &&
    validateProposal(entry, draft.proposed).length === 0
  );
}

function finishSubmission(draft: Draft): void {
  const key = draftKey(draft.locale, draft.id);
  // A late response must never erase wording typed while submission was in flight.
  if (drafts.get(key) !== draft) return;
  const selected = currentDraft() === draft;
  drafts.delete(key);
  if (selected) proposal.value = reason.value = '';
  persist();
  renderValidation();
  renderDrafts();
  renderResults();
}

function draftStatus(draft: Draft, catalogs = currentCatalogs): string {
  const current = catalogs.get(draft.locale);
  const entry = current?.entries.find((item) => item.id === draft.id);
  if (current && (!entry || referencesChanged(draft, entry))) return 'Needs review';
  return validateProposal(entry ?? draft, draft.proposed).length
    ? 'Needs editing'
    : 'Ready to export';
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
  const preview = element('wording-preview');
  preview.textContent = plainPreview(proposal.value || entry.current);
  preview.lang = catalog!.locale.htmlLang;
  clearButton.disabled = !currentDraft();
  community.updateSubmit();
}

function renderReferences(entry: Entry): void {
  if (!catalog) return;
  element('selected-surface').textContent = entry.surface === 'about' ? 'About' : 'App';
  element('selected-key').textContent = entry.key;
  element('source-en').textContent = entry.sourceEn;
  element('source-ko').textContent = entry.sourceKo;
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

function renderDrafts(): void {
  const all = [...drafts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const ready = all.filter((draft) => draftStatus(draft) === 'Ready to export');
  element('draft-count').textContent = String(all.length);
  element('ready-count').textContent = `${ready.length} ready to export`;
  exportButton.disabled = exporting || !ready.length;
  element('empty-drafts').hidden = all.length > 0;
  const list = element('saved-drafts');
  list.replaceChildren();
  for (const draft of all) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const head = document.createElement('span');
    head.className = 'translation-saved-head';
    const name = document.createElement('span');
    name.textContent =
      catalog?.languages.find((lang) => lang.code === draft.locale)?.nativeName ?? draft.locale;
    const state = document.createElement('span');
    state.className = 'translation-saved-state';
    state.textContent = draftStatus(draft);
    head.append(name, state);
    const key = document.createElement('span');
    key.className = 'translation-saved-key';
    key.textContent = `${draft.surface === 'about' ? 'About' : 'App'} · ${draft.key}`;
    const value = document.createElement('span');
    value.className = 'translation-saved-value';
    value.dir = 'auto';
    value.textContent = draft.proposed || '(Empty suggestion)';
    button.append(head, key, value);
    button.addEventListener('click', () => {
      openSavedDraft(draft).catch(reportActionFailure);
    });
    item.append(button);
    list.append(item);
  }
}

async function openSavedDraft(draft: Draft): Promise<void> {
  surface.value = draft.surface;
  search.value = '';
  draftsOnly.checked = false;
  page = 0;
  if (catalog?.locale.code !== draft.locale) await loadCatalog(draft.locale, draft.id);
  else selectEntry(draft.id);
  if (catalog?.locale.code === draft.locale) {
    element('editor').scrollIntoView({ behavior: 'auto', block: 'start' });
    proposal.focus({ preventScroll: true });
  }
}

function updateDraft(): void {
  const entry = selectedEntry();
  if (!entry || !catalog) return;
  const key = draftKey(catalog.locale.code, entry.id);
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
  renderDrafts();
  community.clearSubmitStatus();
  // Do not rebuild the phrase list here: preserve its focus and scroll position while typing.
  for (const button of phraseList.querySelectorAll<HTMLButtonElement>('button[data-entry-id]')) {
    if (button.dataset.entryId === entry.id) {
      const marker = button.querySelector('small');
      if (marker) marker.hidden = !drafts.has(key);
    }
  }
  element('save-status').textContent = storageSession.hasConflict
    ? 'Saving paused. Export before reloading.'
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
    currentCatalogs.set(locale, next);
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
    renderDrafts();
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
    element('save-status').textContent = 'Saving paused. Export before reloading.';
  }
});
clearButton.addEventListener('click', () => {
  proposal.value = reason.value = '';
  updateDraft();
  persist();
  renderResults();
  proposal.focus();
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
  renderDrafts();
  proposal.focus();
});
async function exportDrafts(): Promise<void> {
  if (exporting) return;
  if (saveTimer !== undefined) persist();
  element('export-copy').hidden = true;
  element<HTMLTextAreaElement>('export-json').value = '';
  const candidates = [...drafts.values()];
  exporting = true;
  let jsonPrepared = false;
  exportButton.disabled = true;
  element('export-status').textContent = 'Checking references…';
  try {
    const locales = [...new Set(candidates.map((draft) => draft.locale))];
    const refreshed = await Promise.all(locales.map((locale) => fetchCatalog(locale)));
    const exportCatalogs = new Map(refreshed.map((next) => [next.locale.code, next]));
    for (const [locale, next] of exportCatalogs) currentCatalogs.set(locale, next);
    if (catalog && exportCatalogs.has(catalog.locale.code)) {
      catalog = exportCatalogs.get(catalog.locale.code)!;
      const entry = selectedEntry();
      element('editor').hidden = !entry;
      if (entry) {
        renderReferences(entry);
        renderValidation();
      }
    }
    // Input stays usable during the reads. A changed or deleted draft belongs to
    // a later export, not the snapshot whose references were just checked.
    const ready = candidates.filter(
      (draft) =>
        drafts.get(draftKey(draft.locale, draft.id)) === draft &&
        draftStatus(draft, exportCatalogs) === 'Ready to export',
    );
    if (!ready.length) {
      element('export-status').textContent = 'No drafts are ready. Review or finish them first.';
      return;
    }
    const json = JSON.stringify(createExport(ready), null, 2);
    element<HTMLTextAreaElement>('export-json').value = json;
    element('export-copy').hidden = false;
    jsonPrepared = true;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `MUSIXQUARE-translation-suggestions-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    const remaining = drafts.size - ready.length;
    element('export-status').textContent =
      `${ready.length} exported.${remaining ? ` ${remaining} remaining.` : ''}`;
  } catch {
    element('export-status').textContent = jsonPrepared
      ? 'Download unavailable. Copy the JSON below.'
      : 'Couldn’t export. Try again.';
  } finally {
    exporting = false;
    renderDrafts();
  }
}

exportButton.addEventListener('click', () => {
  exportDrafts().catch(reportActionFailure);
});

setStorageWarning(initial.warning);
renderDrafts();
loadCatalog(requestedLocale).catch(reportActionFailure);
