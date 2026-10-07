import { describe, expect, it } from 'vitest';
import { loadDrafts, saveDrafts, type Draft } from '../../../.workshop/translate/drafts';
import { submissionRequestId } from '../../../.workshop/translate/submission-request';

const draft: Draft = {
  id: 'app:close',
  surface: 'app',
  key: 'close',
  sourceEn: 'Close',
  sourceKo: '닫기',
  current: 'Fechar',
  locale: 'pt-br',
  proposed: 'Encerrar',
  reason: '',
  updatedAt: '2026-10-07T00:00:00.000Z',
};

describe('durable translation submission identity', () => {
  it.each([undefined, '01234567-1234-4567-8123-0123456789ab'])(
    'reuses the request from the same saved revision in concurrent tabs: %s',
    async (revisionId) => {
      const saved = { ...draft, ...(revisionId ? { revisionId } : {}) };
      let raw: string | null = null;
      const storage = {
        getItem: () => raw,
        setItem: (_key: string, value: string) => {
          raw = value;
        },
      };
      expect(saveDrafts([saved], storage).ok).toBe(true);
      const [left, right] = await Promise.all([
        submissionRequestId(loadDrafts(storage).drafts[0]!),
        submissionRequestId(loadDrafts(storage).drafts[0]!),
      ]);
      expect(left).toBe(right);
      expect(left).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    },
  );

  it('separates independently created identical proposals, even in the same millisecond', async () => {
    const first = { ...draft, revisionId: crypto.randomUUID() };
    const second = { ...first, revisionId: crypto.randomUUID() };
    const ids = await Promise.all([submissionRequestId(first), submissionRequestId(second)]);
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    'proposed',
    'reason',
    'sourceEn',
    'sourceKo',
    'current',
    'locale',
    'key',
    'id',
  ] as const)('does not replay an earlier payload after %s changes', async (field) => {
    const original = { ...draft, revisionId: crypto.randomUUID() };
    expect(
      await submissionRequestId({ ...original, [field]: `${original[field]} changed` }),
    ).not.toBe(await submissionRequestId(original));
  });
});
