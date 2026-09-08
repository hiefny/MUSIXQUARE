import { DRAFT_STORAGE_KEY, type DraftStorage } from './drafts';

type Snapshot = { available: true; raw: string | null } | { available: false };

export interface StorageSession {
  readonly hasConflict: boolean;
  beforeSave(): boolean;
  afterSave(): void;
  observe(key: string | null, newValue: string | null): boolean;
}

/** Keep one editor's snapshot from silently replacing drafts changed in another tab. */
export function createStorageSession(storage?: DraftStorage | null): StorageSession {
  function readSnapshot(): Snapshot {
    try {
      const target =
        storage === undefined
          ? typeof window === 'undefined'
            ? null
            : window.localStorage
          : storage;
      return target
        ? { available: true, raw: target.getItem(DRAFT_STORAGE_KEY) }
        : { available: false };
    } catch {
      // The existing draft persistence reports unavailable storage and quota errors.
      return { available: false };
    }
  }

  let snapshot = readSnapshot();
  let hasConflict = false;

  return {
    get hasConflict() {
      return hasConflict;
    },
    beforeSave() {
      if (hasConflict) return false;
      const current = readSnapshot();
      if (snapshot.available && current.available && current.raw !== snapshot.raw) {
        hasConflict = true;
      }
      return !hasConflict;
    },
    afterSave() {
      if (!hasConflict) snapshot = readSnapshot();
    },
    observe(key, newValue) {
      if (key !== DRAFT_STORAGE_KEY && key !== null) return hasConflict;
      const incoming = key === null ? null : newValue;
      if (snapshot.available && incoming !== snapshot.raw) hasConflict = true;
      return hasConflict;
    },
  };
}
