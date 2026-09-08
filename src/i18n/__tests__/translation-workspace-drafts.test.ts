import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_STORAGE_KEY,
  type Draft,
  type DraftStorage,
  type Entry,
  loadDrafts,
  saveDrafts,
  validateProposal,
} from '../../../.workshop/translate/drafts';
import { createStorageSession } from '../../../.workshop/translate/storage-session';

const entry: Entry = {
  id: 'app:welcome',
  surface: 'app',
  key: 'welcome',
  sourceEn: 'Hello {{name}}, {{name}}!',
  sourceKo: '{{name}}님, 안녕하세요 {{name}}!',
  current: 'Bonjour {{name}}, {{name}}!',
};
const draft: Draft = {
  ...entry,
  locale: 'fr',
  proposed: 'Salut {{name}}, {{name}}!',
  reason: 'More natural',
  updatedAt: '2026-09-08T05:00:00.000Z',
};

function memoryStorage(): DraftStorage & { removeItem(key: string): void; clear(): void } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('translation proposal validation', () => {
  it('preserves repeated placeholders while allowing grammar to change their order', () => {
    expect(validateProposal(entry, draft.proposed)).toEqual([]);
    for (const proposed of [
      'Salut {{name}}!',
      'Salut {{nom}}, {{name}}!',
      'Salut {{name}}, {{name}}, {{name}}!',
    ]) {
      expect(validateProposal(entry, proposed)).toContain('placeholders');
    }
    expect(
      validateProposal(
        { ...entry, sourceEn: '{{a}} then {{b}}', current: '{{a}} puis {{b}}' },
        '{{b}} après {{a}}',
      ),
    ).toEqual([]);
    expect(validateProposal(entry, '')).toContain('empty');
    expect(validateProposal(entry, entry.current)).toContain('unchanged');
    expect(validateProposal(entry, 'a'.repeat(32_769))).toContain('too-long');
  });

  it('permits translated HTML text but rejects changed tags, attributes and URLs', () => {
    const html: Entry = {
      ...entry,
      sourceEn: 'Help',
      current: '<a href="https://example.com/a>b" class="help">Aide</a><br>',
    };
    expect(
      validateProposal(html, '<a href="https://example.com/a>b" class="help">Assistance</a><br>'),
    ).toEqual([]);
    for (const proposed of [
      '<a href="javascript:alert(1)" class="help">Aide</a><br>',
      '<a href="https://example.com/a>b" class="help" onclick="alert(1)">Aide</a><br>',
      '<a href="https://example.com/a>b" class="help">Aide</a><br><img src=x onerror=alert(1)>',
      '<script',
      '<!-- comment -->',
    ]) {
      expect(validateProposal(html, proposed)).toContain('markup');
    }
    expect(
      validateProposal({ ...entry, sourceEn: 'Under 3', current: 'moins de 3' }, 'valeur < 3'),
    ).toEqual([]);
  });
});

describe('translation draft storage', () => {
  it('retains unfinished drafts locally', () => {
    const storage = memoryStorage();
    const unfinished = { ...draft, proposed: '' };
    expect(saveDrafts([unfinished], storage)).toEqual({ ok: true });
    expect(loadDrafts(storage)).toEqual({ drafts: [unfinished] });
  });

  it('reports unavailable storage and quota errors without replacing the last saved work', () => {
    const storage = memoryStorage();
    saveDrafts([draft], storage);
    const deniedWrites: DraftStorage = {
      ...storage,
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    expect(saveDrafts([{ ...draft, reason: 'new' }], deniedWrites)).toEqual({
      ok: false,
      warning: 'write-failed',
    });
    expect(loadDrafts(storage).drafts).toEqual([draft]);
    expect(
      loadDrafts({
        getItem() {
          throw new Error('SecurityError');
        },
        setItem() {},
      }),
    ).toEqual({ drafts: [], warning: 'read-failed' });
    expect(loadDrafts(null)).toEqual({ drafts: [], warning: 'unavailable' });
    expect(saveDrafts([draft], null)).toEqual({ ok: false, warning: 'unavailable' });
  });

  it('rejects corrupted JSON, versions, field types, duplicate identities and timestamps', () => {
    const storage = memoryStorage();
    for (const value of [
      '{broken',
      JSON.stringify({ version: 2, drafts: [draft] }),
      JSON.stringify({ version: 1, drafts: [{ ...draft, current: 1 }] }),
      JSON.stringify({ version: 1, drafts: [draft, draft] }),
      JSON.stringify({ version: 1, drafts: [{ ...draft, updatedAt: '2026-02-31T00:00:00.000Z' }] }),
    ]) {
      storage.setItem(DRAFT_STORAGE_KEY, value);
      expect(loadDrafts(storage)).toEqual({ drafts: [], warning: 'invalid-data' });
    }
    expect(saveDrafts([draft, { ...draft, locale: 'pt-br' }], storage).ok).toBe(true);
    expect(loadDrafts(storage).drafts).toHaveLength(2);
  });

  it('reconstructs known fields without retaining properties from untrusted stored JSON', () => {
    const storage = memoryStorage();
    const contaminated = { ...draft, unexpected: 'extra' };
    Object.defineProperty(contaminated, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts: [contaminated] }));
    expect(loadDrafts(storage)).toEqual({ drafts: [draft] });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('keeps the last snapshot intact when drafts exceed the local storage budget', () => {
    const storage = memoryStorage();
    saveDrafts([draft], storage);
    const previous = storage.getItem(DRAFT_STORAGE_KEY);
    const large = Array.from({ length: 60 }, (_, index) => ({
      ...draft,
      id: `app:${index}`,
      proposed: `${draft.proposed} ${'a'.repeat(10_000)}`,
    }));
    expect(saveDrafts(large, storage)).toEqual({ ok: false, warning: 'too-large' });
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBe(previous);
    storage.setItem(DRAFT_STORAGE_KEY, ' '.repeat(524_289));
    expect(loadDrafts(storage)).toEqual({ drafts: [], warning: 'too-large' });
  });

  it('bounds the number of local drafts', () => {
    const tooMany = Array.from({ length: 1001 }, (_, index) => ({ ...draft, id: `app:${index}` }));
    expect(saveDrafts(tooMany, memoryStorage())).toEqual({ ok: false, warning: 'invalid-data' });
  });
});

describe('translation storage session', () => {
  it('accepts current storage and records a successful own save', () => {
    const storage = memoryStorage();
    saveDrafts([draft], storage);
    const session = createStorageSession(storage);
    expect(session.beforeSave()).toBe(true);
    expect(saveDrafts([{ ...draft, reason: 'Own edit' }], storage).ok).toBe(true);
    session.afterSave();
    expect(session.beforeSave()).toBe(true);
    expect(session.hasConflict).toBe(false);
  });

  it('detects another tab writing before a storage event arrives and freezes permanently', () => {
    const storage = memoryStorage();
    saveDrafts([draft], storage);
    const session = createStorageSession(storage);
    saveDrafts([{ ...draft, reason: 'Remote edit' }], storage);
    expect(session.beforeSave()).toBe(false);
    saveDrafts([draft], storage);
    session.afterSave();
    expect(session.beforeSave()).toBe(false);
    expect(session.hasConflict).toBe(true);
  });

  it('detects a remote write into previously empty storage', () => {
    const storage = memoryStorage();
    const session = createStorageSession(storage);
    saveDrafts([draft], storage);
    expect(session.observe(DRAFT_STORAGE_KEY, storage.getItem(DRAFT_STORAGE_KEY))).toBe(true);
    expect(session.beforeSave()).toBe(false);
  });

  it.each(['remove', 'clear'] as const)('freezes when remote %s deletes saved drafts', (action) => {
    const storage = memoryStorage();
    saveDrafts([draft], storage);
    const session = createStorageSession(storage);
    if (action === 'remove') storage.removeItem(DRAFT_STORAGE_KEY);
    else storage.clear();
    expect(session.observe(action === 'remove' ? DRAFT_STORAGE_KEY : null, null)).toBe(true);
    expect(session.beforeSave()).toBe(false);
  });

  it('ignores unrelated keys and unchanged snapshots', () => {
    const storage = memoryStorage();
    saveDrafts([draft], storage);
    const session = createStorageSession(storage);
    expect(session.observe('musixquare-lang', 'ko')).toBe(false);
    expect(session.observe(DRAFT_STORAGE_KEY, storage.getItem(DRAFT_STORAGE_KEY))).toBe(false);
    expect(session.beforeSave()).toBe(true);
    expect(createStorageSession(memoryStorage()).observe(null, null)).toBe(false);
  });

  it('keeps in-memory edits intact after a remote conflict', () => {
    const storage = memoryStorage();
    saveDrafts([draft], storage);
    const session = createStorageSession(storage);
    const localDrafts = loadDrafts(storage).drafts;
    localDrafts[0]!.reason = 'Unsaved work in this tab';
    saveDrafts([{ ...draft, reason: 'Other tab' }], storage);
    expect(session.beforeSave()).toBe(false);
    expect(localDrafts[0]!.reason).toBe('Unsaved work in this tab');
    expect(loadDrafts(storage).drafts[0]!.reason).toBe('Other tab');
  });

  it('does not throw or report a conflict when storage is unavailable', () => {
    const storage: DraftStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
    };
    for (const session of [createStorageSession(null), createStorageSession(storage)]) {
      expect(session.beforeSave()).toBe(true);
      session.afterSave();
      expect(session.observe(DRAFT_STORAGE_KEY, 'external value')).toBe(false);
      expect(session.hasConflict).toBe(false);
    }
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('SecurityError');
      },
    });
    const restricted = createStorageSession();
    expect(restricted.beforeSave()).toBe(true);
    expect(restricted.hasConflict).toBe(false);
    expect(loadDrafts()).toEqual({ drafts: [], warning: 'read-failed' });
    expect(saveDrafts([draft])).toEqual({ ok: false, warning: 'write-failed' });
  });
});
