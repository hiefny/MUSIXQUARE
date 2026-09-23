/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { newLoadEpoch, setCurrentAudioBuffer } from '../_state.ts';
import type { LargeAudioTrack } from '../file-playback-resource.ts';
import {
  captureLocalFileOutputIdentity,
  isLocalFileOutputIdentityCurrent,
} from '../local-file-output-identity.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  resetState();
  setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
});

describe('native output recovery identity', () => {
  it('keeps ordinary file recovery behind its resident queue occurrence', () => {
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    expect(captureLocalFileOutputIdentity()).toBeNull();
    setState('files.current', {
      name: 'song.mp3',
      indexHint: 0,
      size: 1,
      mime: 'audio/mpeg',
      queueItemId: QUEUE_ITEM_ID,
      sessionId: 1,
      blob: new Blob(['x']),
    });
    const identity = captureLocalFileOutputIdentity()!;
    expect(identity.kind).toBe('queue-file');
    expect(isLocalFileOutputIdentityCurrent(identity)).toBe(true);
    setState('files.current', { ...getState('files.current')!, sessionId: 2 });
    expect(isLocalFileOutputIdentityCurrent(identity)).toBe(false);
  });

  it('preserves the failed-PLAY boundary before normal resident metadata is published', () => {
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    const identity = captureLocalFileOutputIdentity({ requireResident: false });
    expect(identity?.kind).toBe('queue-file');
    expect(isLocalFileOutputIdentityCurrent(identity!)).toBe(true);
  });

  it('keeps bounded output recovery bound to the exact resource across a return to native playback', () => {
    const dispose = vi.fn();
    const bounded: LargeAudioTrack = {
      kind: 'large-audio',
      duration: 3_600,
      numberOfChannels: 2,
      sampleRate: 48_000,
      length: 172_800_000,
      bufferedPcmBytes: 0,
      prepare: vi.fn(async () => {}),
      createPlayback: vi.fn(() => {
        throw new Error('No playback required for identity checks');
      }),
      dispose,
    };
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setCurrentAudioBuffer(bounded);
    const identity = captureLocalFileOutputIdentity({ requireResident: false })!;
    expect(identity.buffer).toBe(bounded);
    expect(isLocalFileOutputIdentityCurrent(identity)).toBe(true);

    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    expect(isLocalFileOutputIdentityCurrent(identity)).toBe(false);
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
    expect(captureLocalFileOutputIdentity({ requireResident: false })?.buffer).not.toBe(bounded);
  });

  it.each(['exit', 'track', 'buffer', 'epoch', 'room', 'room-epoch'] as const)(
    'retires demo recovery on a changed %s even without a queue occurrence',
    (change) => {
      setState('demo.active', true);
      setState('demo.currentTrackIndex', 0);
      const identity = captureLocalFileOutputIdentity()!;
      expect(identity).toMatchObject({ kind: 'demo', queueItemId: null, trackIndex: 0 });
      expect(isLocalFileOutputIdentityCurrent(identity)).toBe(true);
      if (change === 'exit') setState('demo.active', false);
      if (change === 'track') setState('demo.currentTrackIndex', 1);
      if (change === 'buffer') setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      if (change === 'epoch') newLoadEpoch();
      if (change === 'room')
        setState('room.context', { ...getState('room.context'), roomId: 'new-room' });
      if (change === 'room-epoch')
        setState('room.context', { ...getState('room.context'), epoch: 99 });
      expect(isLocalFileOutputIdentityCurrent(identity)).toBe(false);
    },
  );

  it('does not classify a stale demo flag in a PRO room as demo output', () => {
    setState('demo.active', true);
    setState('demo.currentTrackIndex', 0);
    setState('room.context', { ...getState('room.context'), kind: 'pro' });
    expect(captureLocalFileOutputIdentity()).toBeNull();
  });
});
