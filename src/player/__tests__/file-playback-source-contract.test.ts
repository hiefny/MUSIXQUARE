import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackSourceSnapshot,
  isFilePlaybackSourceSnapshot,
  sourceOwnsRevisionedRun,
  type FilePlaybackSource,
  type FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';
import type { RevisionedPlaybackRun } from '../rendezvous-contract.ts';

const QID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const OTHER_QID = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const RUN: RevisionedPlaybackRun = { queueItemId: QID, runId: 'run-3', revision: 3 };

function snapshot(overrides: Partial<FilePlaybackSourceSnapshot> = {}): FilePlaybackSourceSnapshot {
  return {
    schemaVersion: 1,
    queueItemId: QID,
    backend: 'streaming-flac',
    phase: 'playing',
    revision: 3,
    run: RUN,
    durationSeconds: 554.893,
    positionSeconds: 12.25,
    bufferedAheadSeconds: 9.5,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
    ...overrides,
  };
}

describe('file playback source contract', () => {
  it.each(['audio-buffer', 'streaming-flac'] as const)(
    'accepts a JSON-safe %s backend snapshot',
    (backend) => {
      const value = snapshot({ backend });
      expect(isFilePlaybackSourceSnapshot(value)).toBe(true);
      expect(isFilePlaybackSourceSnapshot(JSON.parse(JSON.stringify(value)))).toBe(true);
    },
  );

  it('copies and deeply freezes state before publication', () => {
    const input = snapshot();
    const published = createFilePlaybackSourceSnapshot(input);

    expect(published).not.toBe(input);
    expect(published.run).not.toBe(input.run);
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.run)).toBe(true);
    expect(published).toEqual(input);
  });

  it('rejects unexpected native/runtime fields instead of publishing them globally', () => {
    const withNativeObject = {
      ...snapshot(),
      audioNode: { connect: vi.fn() },
    };
    expect(isFilePlaybackSourceSnapshot(withNativeObject)).toBe(false);
    expect(() =>
      createFilePlaybackSourceSnapshot(withNativeObject as FilePlaybackSourceSnapshot),
    ).toThrow(TypeError);
  });

  it('enforces the immutable queue occurrence and revision association', () => {
    expect(
      isFilePlaybackSourceSnapshot(snapshot({ run: { ...RUN, queueItemId: OTHER_QID } })),
    ).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ revision: 4 }))).toBe(false);
  });

  it('requires a run for armed, playing, and paused phases', () => {
    for (const phase of ['armed', 'playing', 'paused'] as const) {
      expect(isFilePlaybackSourceSnapshot(snapshot({ phase, run: null }))).toBe(false);
    }
    expect(
      isFilePlaybackSourceSnapshot(
        snapshot({ phase: 'ready', revision: 0, run: null, positionSeconds: 0 }),
      ),
    ).toBe(true);
  });

  it('rejects unsafe counters, dimensions, and non-finite diagnostics', () => {
    expect(isFilePlaybackSourceSnapshot(snapshot({ positionSeconds: Number.NaN }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ bufferedAheadSeconds: -1 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ channelCount: 0 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ channelCount: 9 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ durationSeconds: 0 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ underrunCount: 0.5 }))).toBe(false);
    expect(isFilePlaybackSourceSnapshot(snapshot({ errorCode: '' }))).toBe(false);
  });

  it('checks a runtime source against the run queue identity', () => {
    const source = {
      queueItemId: QID,
      backend: 'streaming-flac',
    } as Pick<FilePlaybackSource, 'queueItemId' | 'backend'>;

    expect(sourceOwnsRevisionedRun(source, RUN)).toBe(true);
    expect(sourceOwnsRevisionedRun(source, { ...RUN, queueItemId: OTHER_QID })).toBe(false);
  });
});
