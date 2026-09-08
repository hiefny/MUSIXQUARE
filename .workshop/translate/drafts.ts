import {
  MAX_TRANSLATION_TEXT_LENGTH,
  validateProposal,
  type ProposalDraft,
} from '../../src/i18n/translation-community';

export { validateProposal } from '../../src/i18n/translation-community';
export type { Entry, ProposalIssue } from '../../src/i18n/translation-community';
export type Draft = ProposalDraft;

export interface DraftExport {
  version: 1;
  exportedAt: string;
  drafts: Draft[];
}

export type StorageWarning =
  | 'unavailable'
  | 'invalid-data'
  | 'too-large'
  | 'read-failed'
  | 'write-failed';
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DRAFT_STORAGE_KEY = 'musixquare.translate.drafts.v1';
const MAX_DRAFTS = 1000;
const MAX_STORAGE_BYTES = 1024 * 1024;
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = MAX_TRANSLATION_TEXT_LENGTH;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown, max: number, nonempty = false): value is string {
  return typeof value === 'string' && value.length <= max && (!nonempty || !!value.trim());
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function readDraft(value: unknown): Draft | null {
  if (!isRecord(value)) return null;
  const { id, surface, key, sourceEn, sourceKo, current, locale, proposed, reason, updatedAt } =
    value;
  if (
    !isText(id, 256, true) ||
    (surface !== 'app' && surface !== 'about') ||
    !isText(key, 256, true) ||
    !isText(sourceEn, MAX_TEXT_LENGTH) ||
    !isText(sourceKo, MAX_TEXT_LENGTH) ||
    !isText(current, MAX_TEXT_LENGTH) ||
    !isText(locale, 32) ||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) ||
    !isText(proposed, MAX_TEXT_LENGTH) ||
    !isText(reason, 4000) ||
    !isTimestamp(updatedAt)
  )
    return null;
  // Reconstruct only known fields: stored JSON is untrusted, including extra keys.
  return { id, surface, key, sourceEn, sourceKo, current, locale, proposed, reason, updatedAt };
}

function readDrafts(value: unknown): Draft[] | null {
  if (!Array.isArray(value) || value.length > MAX_DRAFTS) return null;
  const drafts: Draft[] = [];
  const identities = new Set<string>();
  for (const item of value) {
    const draft = readDraft(item);
    if (!draft) return null;
    const identity = JSON.stringify([draft.locale, draft.id]);
    if (identities.has(identity)) return null;
    identities.add(identity);
    drafts.push(draft);
  }
  return drafts;
}

function browserStorage(): DraftStorage | null {
  // Access can itself throw in privacy-restricted browser contexts.
  return typeof window === 'undefined' ? null : window.localStorage;
}

function exceedsTextBudget(drafts: readonly Draft[], limit = MAX_STORAGE_BYTES): boolean {
  let bytes = 0;
  for (const draft of drafts) {
    for (const value of Object.values(draft)) bytes += value.length * 2;
    if (bytes > limit) return true;
  }
  return false;
}

export function loadDrafts(storage?: DraftStorage | null): {
  drafts: Draft[];
  warning?: StorageWarning;
} {
  let raw: string | null;
  try {
    const target = storage === undefined ? browserStorage() : storage;
    if (!target) return { drafts: [], warning: 'unavailable' };
    raw = target.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return { drafts: [], warning: 'read-failed' };
  }
  if (raw === null) return { drafts: [] };
  // localStorage stores UTF-16 strings; bound storage before attempting JSON parse.
  if (raw.length * 2 > MAX_STORAGE_BYTES) return { drafts: [], warning: 'too-large' };
  try {
    const saved: unknown = JSON.parse(raw);
    const drafts = isRecord(saved) && saved.version === 1 ? readDrafts(saved.drafts) : null;
    return drafts ? { drafts } : { drafts: [], warning: 'invalid-data' };
  } catch {
    return { drafts: [], warning: 'invalid-data' };
  }
}

export function saveDrafts(
  drafts: readonly Draft[],
  storage?: DraftStorage | null,
): { ok: boolean; warning?: StorageWarning } {
  const checked = readDrafts(drafts);
  if (!checked) return { ok: false, warning: 'invalid-data' };
  if (exceedsTextBudget(checked)) return { ok: false, warning: 'too-large' };
  const raw = JSON.stringify({ version: 1, drafts: checked });
  if (raw.length * 2 > MAX_STORAGE_BYTES) return { ok: false, warning: 'too-large' };
  try {
    const target = storage === undefined ? browserStorage() : storage;
    if (!target) return { ok: false, warning: 'unavailable' };
    target.setItem(DRAFT_STORAGE_KEY, raw);
    return { ok: true };
  } catch {
    return { ok: false, warning: 'write-failed' };
  }
}

export function createExport(
  drafts: readonly Draft[],
  exportedAt = new Date().toISOString(),
): DraftExport {
  const checked = readDrafts(drafts);
  if (!checked || !isTimestamp(exportedAt)) throw new Error('Invalid draft export data.');
  if (exceedsTextBudget(checked, MAX_EXPORT_BYTES)) {
    throw new Error('Draft export exceeds the 8 MiB limit.');
  }
  for (const draft of checked) {
    const issues = validateProposal(draft, draft.proposed);
    if (issues.length) throw new Error(`Invalid proposal ${draft.id}: ${issues.join(', ')}.`);
  }
  const result: DraftExport = { version: 1, exportedAt, drafts: checked };
  if (JSON.stringify(result).length * 2 > MAX_EXPORT_BYTES) {
    throw new Error('Draft export exceeds the 8 MiB limit.');
  }
  return result;
}
