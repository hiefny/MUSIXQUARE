import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APP_DICTIONARIES, type TranslationDictionary } from '../../i18n/catalogs.ts';
import { PRO_ROOM_MAX_ASSET_BYTES } from '../contracts.ts';
import {
  describeProRoomUploadFailures,
  resolveProRoomUploadFailureDialog,
} from '../upload-failure-dialog.ts';

/** Each failure's reason key, read through the line format. */
function reasonKey(code: string | null, size: number, retryable: boolean): string {
  const [line] = describeProRoomUploadFailures(
    [{ name: 'track.wav', size, code, retryable }],
    (key, params) => (key === 'pro.upload.failed_file' ? `${params?.name}|${params?.reason}` : key),
  );
  const [name, reason] = (line ?? '').split('|');
  expect(name).toBe('track.wav');
  return reason ?? '';
}

const REASONS = [
  ['PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID', PRO_ROOM_MAX_ASSET_BYTES + 1, false, 'file_too_large'],
  ['PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID', 0, false, 'empty_file'],
  ['ROOM_QUOTA_EXCEEDED', 4, true, 'quota_exceeded'],
  ['PRO_ROOM_PLAYLIST_LIMIT_REACHED', 4, true, 'playlist_full'],
  ['PLAYLIST_CAPACITY_EXCEEDED', 4, true, 'playlist_full'],
  ['REQUEST_TOO_LARGE', 4, true, 'playlist_full'],
  ['ROOM_STATE_CAPACITY_EXCEEDED', 4, false, 'room_state_limit'],
  ['ASSET_CAPACITY_EXCEEDED', 4, false, 'room_capacity'],
  ['RESERVATION_CAPACITY_EXCEEDED', 4, true, 'pending_limit'],
  ['PRO_ROOM_PLAYLIST_SWITCHED', 4, false, 'playlist_switched'],
  ['PERMISSION_REQUIRED', 4, true, 'permission_required'],
  ['CAPABILITY_REQUIRED', 4, true, 'permission_required'],
  ['ADMINISTRATOR_REQUIRED', 4, true, 'permission_required'],
  ['RESERVATION_OWNER_REQUIRED', 4, true, 'permission_required'],
  ['ASSET_NOT_FOUND', 4, false, 'retry_unavailable'],
  ['ASSET_NOT_READY', 4, false, 'retry_unavailable'],
  ['UPLOAD_MISMATCH', 4, false, 'retry_unavailable'],
  ['UPLOAD_INCOMPLETE', 4, false, 'retry_unavailable'],
  ['PRO_ROOM_MEDIA_COMPLETE_MISMATCH', 4, false, 'retry_unavailable'],
  ['PRO_ROOM_MEDIA_UPLOAD_NETWORK', 4, true, 'failed_retryable'],
  [null, 4, true, 'failed_retryable'],
] as const;

const REASON_KEYS = [...new Set(REASONS.map(([, , , reason]) => `pro.upload.${reason}`))];

// A dialog sentence ends with its locale's full stop; Thai separates
// sentences with a space and has no final mark.
const SENTENCE_END_RE = /[.。．।۔!?！？]$/u;

describe('PRO upload failure reasons', () => {
  it.each(REASONS)(
    'explains %s (size %s) with its own dialog sentence',
    (code, size, retryable, reason) => {
      expect(reasonKey(code, size, retryable)).toBe(`pro.upload.${reason}`);
    },
  );

  it('names only failure codes that the PRO client or Worker produces', () => {
    const source = readFileSync(resolve('src/pro-room/upload-failure-dialog.ts'), 'utf8');
    const codes = [...source.matchAll(/'([A-Z][A-Z0-9_]+)'/gu)].map((match) => match[1]!);
    // Codes without their own sentence fall back to the retryable/terminal
    // default, so the mapping does not name them.
    const defaulted = new Set<string | null>([
      null,
      'PRO_ROOM_MEDIA_COMPLETE_MISMATCH',
      'PRO_ROOM_MEDIA_UPLOAD_NETWORK',
    ]);
    expect(new Set(codes)).toEqual(
      new Set(REASONS.map(([code]) => code).filter((code) => !defaulted.has(code))),
    );
    const producers = [
      'cloudflare/pro-room-worker.ts',
      'src/pro-room/api.ts',
      'src/pro-room/media-transfer.ts',
      'src/pro-room/playlist-state-manager.ts',
      'src/pro-room/upload-queue.ts',
    ]
      .map((path) => readFileSync(resolve(path), 'utf8'))
      .join('\n');
    const unproduced = codes.filter(
      (code) =>
        !new RegExp(`(?:Error|errorResponse)\\(\\s*'${code}'|\\berror: '${code}'`, 'u').test(
          producers,
        ),
    );
    expect(unproduced).toEqual([]);
  });

  it('lists every reason as one dialog sentence in each locale', () => {
    const violations: string[] = [];
    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const byKey = dictionary as TranslationDictionary;
      // The locale's own existing dialog reason sets its final punctuation.
      const ends = SENTENCE_END_RE.test(byKey['pro.upload.failed_retryable']!);
      for (const key of REASON_KEYS) {
        const text = byKey[key];
        if (typeof text !== 'string') {
          violations.push(`${language}.${key}: missing`);
          continue;
        }
        if (text.includes('\n')) violations.push(`${language}.${key}: line break`);
        if (SENTENCE_END_RE.test(text) !== ends) {
          violations.push(`${language}.${key}: final punctuation`);
        }
      }
      const line = byKey['pro.upload.failed_file'] ?? '';
      if (!line.includes('{{name}}') || !line.includes('{{reason}}')) {
        violations.push(`${language}.pro.upload.failed_file: placeholders`);
      }
      // Chinese and Japanese copy uses the full-width colon.
      if (
        /^(?:ja|zh-hans|zh-hant)$/u.test(language) &&
        !/^\{\{name\}\}：\{\{reason\}\}$/u.test(line)
      ) {
        violations.push(`${language}.pro.upload.failed_file: ${line}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('formats a failure line from the locale dictionary', () => {
    const translate =
      (dictionary: TranslationDictionary) =>
      (key: string, params?: Readonly<Record<string, string>>) =>
        (dictionary[key] ?? key).replace(
          /\{\{(\w+)\}\}/gu,
          (slot, name: string) => params?.[name] ?? slot,
        );
    const failure = {
      name: 'track.wav',
      size: 4,
      code: 'PRO_ROOM_PLAYLIST_SWITCHED',
      retryable: false,
    };
    expect(describeProRoomUploadFailures([failure], translate(APP_DICTIONARIES.en))).toEqual([
      `track.wav: ${APP_DICTIONARIES.en['pro.upload.playlist_switched']}`,
    ]);
    expect(describeProRoomUploadFailures([failure], translate(APP_DICTIONARIES.ja))).toEqual([
      `track.wav：${APP_DICTIONARIES.ja['pro.upload.playlist_switched']}`,
    ]);
  });
});

function createQueue() {
  return {
    retryFailedBatch: vi.fn(() => true),
    dismissFailedBatch: vi.fn(() => true),
  };
}

describe('PRO upload failure dialog ownership', () => {
  it('treats the single close button as dismissal when no failed file is retryable', async () => {
    const queue = createQueue();
    await resolveProRoomUploadFailureDialog({
      queue,
      batchId: 'batch-1',
      canRetry: false,
      show: async () => ({ action: 'ok' }),
      isCurrent: () => true,
      reportPresentationFailure: vi.fn(),
    });
    expect(queue.retryFailedBatch).not.toHaveBeenCalled();
    expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
  });

  it.each(['fallback', 'superseded', 'close'])(
    'releases the hidden failed batch when the dialog resolves programmatically as %s',
    async (action) => {
      const queue = createQueue();

      await resolveProRoomUploadFailureDialog({
        queue,
        batchId: 'batch-1',
        show: async () => ({ action }),
        isCurrent: () => true,
        reportPresentationFailure: vi.fn(),
      });

      expect(queue.retryFailedBatch).not.toHaveBeenCalled();
      expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
    },
  );

  it('reports presentation rejection and releases the hidden failed batch', async () => {
    const queue = createQueue();
    const error = new Error('dialog host unavailable');
    const reportPresentationFailure = vi.fn();

    await resolveProRoomUploadFailureDialog({
      queue,
      batchId: 'batch-1',
      show: async () => Promise.reject(error),
      isCurrent: () => true,
      reportPresentationFailure,
    });

    expect(reportPresentationFailure).toHaveBeenCalledWith(error);
    expect(queue.retryFailedBatch).not.toHaveBeenCalled();
    expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
  });

  it('contains a presentation reporter failure without blocking batch cleanup', async () => {
    const queue = createQueue();

    await expect(
      resolveProRoomUploadFailureDialog({
        queue,
        batchId: 'batch-1',
        show: async () => Promise.reject(new Error('dialog host unavailable')),
        isCurrent: () => true,
        reportPresentationFailure: () => {
          throw new Error('logger unavailable');
        },
      }),
    ).resolves.toBeUndefined();

    expect(queue.retryFailedBatch).not.toHaveBeenCalled();
    expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
  });

  it.each(['secondary', 'escape'])(
    'dismisses the failed batch only after the explicit %s action',
    async (action) => {
      const queue = createQueue();

      await resolveProRoomUploadFailureDialog({
        queue,
        batchId: 'batch-1',
        show: async () => ({ action }),
        isCurrent: () => true,
        reportPresentationFailure: vi.fn(),
      });

      expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
      expect(queue.retryFailedBatch).not.toHaveBeenCalled();
    },
  );

  it('retries only while the originating playlist lease remains current', async () => {
    const currentQueue = createQueue();
    const staleQueue = createQueue();

    await resolveProRoomUploadFailureDialog({
      queue: currentQueue,
      batchId: 'batch-current',
      show: async () => ({ action: 'ok' }),
      isCurrent: () => true,
      reportPresentationFailure: vi.fn(),
    });
    await resolveProRoomUploadFailureDialog({
      queue: staleQueue,
      batchId: 'batch-stale',
      show: async () => ({ action: 'ok' }),
      isCurrent: () => false,
      reportPresentationFailure: vi.fn(),
    });

    expect(currentQueue.retryFailedBatch).toHaveBeenCalledWith('batch-current');
    expect(currentQueue.dismissFailedBatch).not.toHaveBeenCalled();
    expect(staleQueue.retryFailedBatch).not.toHaveBeenCalled();
    expect(staleQueue.dismissFailedBatch).toHaveBeenCalledWith('batch-stale');
  });
});
