/**
 * @vitest-environment jsdom
 */
/**
 * Media Session PAUSE then PLAY on a file-room guest while an OS audio
 * interruption is still pending (RO-01, structural plan C1-I5).
 *
 * The real media-session.ts handlers over the real AudioContext owners and
 * FakeNativeAudioContext (no module mocks); observations are the fake's op
 * log, the participant's local pause flag and the bus. Harness and driver:
 * src/audio/__tests__/__helpers__/audio-output-owners.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNativeAudioContext } from '../../audio/__tests__/__helpers__/fake-audio-context.ts';
import {
  bind,
  loadMediaSession,
  loadOwners,
  playbackScope,
  recordBus,
  setVisibility,
  setupOwnerTest,
  stageFile,
  teardownOwnerTest,
  type Owners,
} from '../../audio/__tests__/__helpers__/audio-output-owners.ts';

beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

/** A non-operator guest of a Standard room playing a local file. */
function stageGuest(o: Owners): void {
  stageFile(o);
  o.setState('network.appRole', 'guest');
  o.setState('network.hostConn', { open: true } as never);
  o.setState('network.isOperator', false);
}

async function openGuest() {
  const fake = new FakeNativeAudioContext();
  const o = await loadOwners(fake);
  stageGuest(o);
  const bus = recordBus(o);
  bind(o, fake);
  const mediaSession = await loadMediaSession();
  return { fake, o, bus, mediaSession };
}

describe('Media Session lock-screen PAUSE then PLAY (C1-I5)', () => {
  it.each(['hidden', 'visible'] as const)(
    'with an OS interruption pending (%s): PLAY resumes the context but rejoins nothing',
    async (visibility) => {
      const { fake, o, bus, mediaSession } = await openGuest();
      if (visibility === 'hidden') setVisibility('hidden');
      fake.planResume({ outcome: 'reject' });
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(playbackScope.view(o)).toEqual({ attempt: 'file', gesture: true });

      mediaSession.pause();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(o.getState('playback.activity')).toBe('paused');
      expect(o.playerState.isLocalFilePaused()).toBe(true);

      const before = fake.ops.length;
      mediaSession.play();
      await vi.advanceTimersByTimeAsync(5_000);

      // Known gap (C1-I5, lock-screen pause): PLAY spends its gesture on the
      // pending interruption. The context runs again, but that attempt now
      // waits for its clock proof on a paused identity, so neither the
      // recovery nor the Media Session PLAY rejoins the room and the local
      // pause stays.
      expect(fake.ops.slice(before)).toEqual([
        'resume()',
        'statechange:running',
        'resume:resolved',
      ]);
      expect(fake.state).toBe('running');
      expect(bus.rejoins).toEqual([]);
      expect(bus.needed).toEqual([]);
      expect(o.playerState.isLocalFilePaused()).toBe(true);
      expect(playbackScope.view(o)).toEqual({ attempt: 'file', gesture: true });
      expect(playbackScope.requirement(o)).toBe('not-current');

      if (visibility === 'hidden') {
        // Showing the app retires the stale attempt, still with no rejoin;
        // only a second PLAY rejoins.
        setVisibility('visible');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(playbackScope.view(o)).toEqual({ attempt: 'none', gesture: false });
        expect(bus.rejoins).toEqual([]);

        const again = fake.ops.length;
        mediaSession.play();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fake.ops.slice(again)).toEqual([]);
        expect(bus.rejoins).toEqual(['media-session-play']);
      }
    },
  );

  it('control: with no interruption PAUSE then PLAY rejoins at once', async () => {
    const { fake, bus, mediaSession } = await openGuest();
    setVisibility('hidden');

    mediaSession.pause();
    mediaSession.play();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fake.ops).toEqual([]);
    expect(bus.rejoins).toEqual(['media-session-play']);
    expect(bus.needed).toEqual([]);
  });
});
