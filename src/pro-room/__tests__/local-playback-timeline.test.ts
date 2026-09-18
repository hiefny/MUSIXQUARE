import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import type { ProRoomSnapshot } from '../contracts.ts';
import {
  captureProRoomLocalPlaybackTimeline,
  registerProRoomLocalPlaybackTimeline,
} from '../local-playback-timeline.ts';

let unregister: (() => void) | null = null;
let snapshot: ProRoomSnapshot;
let current: boolean;
let calibrated: boolean;
let serverNow: number;
function register(): () => void {
  return registerProRoomLocalPlaybackTimeline({
    getSnapshot: () => snapshot,
    getServerNow: () => serverNow,
    isClockCalibrated: () => calibrated,
    captureLiveness: () => () => current,
  });
}

beforeEach(() => {
  resetState();
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 7,
    snapshotRevision: 1,
    capabilities: [],
  });
  snapshot = {
    roomCode: '000001',
    presence: { coordinatorEpoch: 7 },
    playback: {
      coordinatorEpoch: 7,
      revision: 4,
      state: 'playing',
      queueItemId: 'video-occurrence',
      youtubeVideoId: 'same-video',
      youtubeSubIndex: 0,
      positionSeconds: 40,
      updatedAtMs: 10_000,
    },
  } as ProRoomSnapshot;
  current = true;
  calibrated = true;
  serverNow = 12_500;
  unregister = register();
});

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('PRO participant-local authoritative timeline', () => {
  it('advances the applied server checkpoint without observing local iframe time', () => {
    const timeline = captureProRoomLocalPlaybackTimeline();
    expect(timeline).toMatchObject({ positionSeconds: 42.5, playing: true, videoId: 'same-video' });
    expect(timeline?.isCurrent()).toBe(true);
    expect(snapshot.playback.revision).toBe(4);
    expect(snapshot.playback.positionSeconds).toBe(40);
  });

  it('retains the exact paused checkpoint', () => {
    snapshot.playback.state = 'paused';
    expect(captureProRoomLocalPlaybackTimeline()).toMatchObject({
      positionSeconds: 40,
      playing: false,
    });
  });

  it.each(['clock', 'invalid-time', 'revision', 'room', 'epoch', 'lifecycle'] as const)(
    'fails closed when the %s source is unavailable',
    (source) => {
      if (source === 'clock') calibrated = false;
      if (source === 'invalid-time') serverNow = NaN;
      if (source === 'revision') current = false;
      if (source === 'room') snapshot.roomCode = '000002';
      if (source === 'epoch') snapshot.presence.coordinatorEpoch = 8;
      if (source === 'lifecycle') unregister?.();
      expect(captureProRoomLocalPlaybackTimeline()).toBeNull();
    },
  );

  it.each(['revision', 'lease', 'room', 'epoch', 'same-room-reopen'] as const)(
    'invalidates the captured timeline after %s replacement',
    (change) => {
      const timeline = captureProRoomLocalPlaybackTimeline();
      expect(timeline?.isCurrent()).toBe(true);
      if (change === 'revision')
        snapshot = { ...snapshot, playback: { ...snapshot.playback, revision: 5 } };
      if (change === 'lease') current = false;
      if (change === 'room')
        setState('room.context', { ...getState('room.context'), roomId: '000002' });
      if (change === 'epoch') setState('room.context', { ...getState('room.context'), epoch: 8 });
      if (change === 'same-room-reopen') {
        const oldUnregister = unregister;
        unregister = register();
        oldUnregister?.();
        expect(captureProRoomLocalPlaybackTimeline()?.isCurrent()).toBe(true);
      }
      expect(timeline?.isCurrent()).toBe(false);
    },
  );
});
