/**
 * @vitest-environment jsdom
 */
/**
 * Media Session PAUSE then PLAY on a file-room guest while an OS audio
 * interruption is still pending (RO-01, structural plan C1-I5).
 *
 * The real media-session.ts handlers over the real AudioContext owners and
 * FakeNativeAudioContext (no module mocks); observations are the fake's op
 * log, the participant's local pause flag and the bus. The real local output
 * rejoin router turns a rejoin into the room realignment request
 * (`sync:force-resync`; the sync itself is not loaded), and the start's clock
 * check is transport's PLAY probe of the pending foreground incident, through
 * the driver. Harness and driver:
 * src/audio/__tests__/__helpers__/audio-output-owners.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNativeAudioContext } from '../../audio/__tests__/__helpers__/fake-audio-context.ts';
import {
  bind,
  foregroundIncident,
  loadMediaSession,
  loadOwners,
  playRequest,
  playbackScope,
  recordBus,
  setVisibility,
  setupOwnerTest,
  stageFile,
  teardownOwnerTest,
  warmMediaSessionGraph,
  type Owners,
} from '../../audio/__tests__/__helpers__/audio-output-owners.ts';

/**
 * Transform the router's module graph once per file too, as
 * warmMediaSessionGraph does for Media Session; the listeners its evaluation
 * adds are removed, and every row still evaluates a fresh graph.
 */
async function warmRouterGraph(): Promise<void> {
  const targets = [document, window] as EventTarget[];
  const spies = targets.map((target) => vi.spyOn(target, 'addEventListener'));
  try {
    await import('../local-output-rejoin.ts');
  } finally {
    targets.forEach((target, index) => {
      const spy = spies[index]!;
      for (const [type, listener, options] of spy.mock.calls) {
        target.removeEventListener(type, listener, options);
      }
      spy.mockRestore();
    });
    vi.resetModules();
  }
}

beforeAll(async () => {
  await warmMediaSessionGraph();
  await warmRouterGraph();
}, 30_000);
beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

/** A non-operator guest of a Standard room playing a local file. */
function stageGuest(o: Owners): void {
  stageFile(o);
  o.setState('network.appRole', 'guest');
  o.setState('network.hostConn', { open: true } as never);
  o.setState('network.isOperator', false);
}

/** The real local output rejoin router; counts the room realignment requests it makes. */
async function loadRouter(o: Owners): Promise<{ resyncs(): number }> {
  const { initLocalOutputRejoin } = await import('../local-output-rejoin.ts');
  initLocalOutputRejoin();
  let resyncs = 0;
  o.bus.on('sync:force-resync', () => {
    resyncs += 1;
  });
  return { resyncs: () => resyncs };
}

async function openGuest() {
  const fake = new FakeNativeAudioContext();
  const o = await loadOwners(fake);
  stageGuest(o);
  const bus = recordBus(o);
  const router = await loadRouter(o);
  bind(o, fake);
  const mediaSession = await loadMediaSession();
  return { fake, o, bus, router, mediaSession };
}

/** The start's clock check: transport's PLAY probe of the pending foreground incident. */
async function startCheck(o: Owners): Promise<string> {
  const check = playRequest.afterProbe(o);
  await vi.advanceTimersByTimeAsync(400); // Its two 180 ms clock samples at most.
  return (await check).probe;
}

describe('Media Session lock-screen PAUSE then PLAY (C1-I5)', () => {
  it.each(['hidden', 'visible'] as const)(
    'with an OS interruption pending (%s): one PLAY resumes the context and rejoins the room (it was Known gap C1-I5, lock-screen pause)',
    async (visibility) => {
      const { fake, o, bus, router, mediaSession } = await openGuest();
      if (visibility === 'hidden') setVisibility('hidden');
      fake.planResume({ outcome: 'reject' });
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(playbackScope.view(o)).toEqual({ attempt: 'file', gesture: true });

      mediaSession.pause();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(o.getState('playback.activity')).toBe('paused');
      expect(o.playerState.isLocalFilePaused()).toBe(true);
      // The hidden boundary armed the start's clock check; a visible
      // interruption arms none.
      const lockedIncident = foregroundIncident(o);
      expect(lockedIncident !== null).toBe(visibility === 'hidden');

      const before = fake.ops.length;
      mediaSession.play();
      await vi.advanceTimersByTimeAsync(5_000);

      // C1-I5 lock-screen pause (Phase 7 7B-6, owner answer Q12; it was a
      // Known gap): PLAY still spends its gesture on the pending
      // interruption. That attempt was for the output the local pause
      // stopped, so it can never prove its clock: the owner retires it and
      // arms the start's clock check in its place (the hidden boundary's
      // stays), and this one PLAY rejoins the room itself, which clears the
      // local pause. No second PLAY, no dialog.
      expect(fake.ops.slice(before)).toEqual([
        'resume()',
        'statechange:running',
        'resume:resolved',
      ]);
      expect(fake.state).toBe('running');
      expect(bus.rejoins).toEqual(['media-session-play']);
      expect(bus.needed).toEqual([]);
      expect(router.resyncs()).toBe(1);
      expect(o.playerState.isLocalFilePaused()).toBe(false);
      expect(playbackScope.view(o)).toEqual({ attempt: 'none', gesture: false });
      expect(playbackScope.requirement(o)).toBe('none');
      const incident = foregroundIncident(o);
      expect(incident).not.toBeNull();
      if (visibility === 'hidden') {
        expect(incident).toBe(lockedIncident);
        // While the screen stays locked the start waits, as it does with no
        // interruption (the locked-start Known gap below, not changed here);
        // opening the app needs no second PLAY.
        expect(await startCheck(o)).toBe('hidden');
        setVisibility('visible');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(foregroundIncident(o)).toBe(lockedIncident);
        expect(bus.rejoins).toEqual(['media-session-play']);
      }
      expect(await startCheck(o)).toBe('healthy');
    },
  );

  it('with an OS interruption pending (visible): when the clock is still frozen after that PLAY, the start finds it instead of playing silently', async () => {
    const { fake, o, bus, mediaSession } = await openGuest();
    fake.planResume({ outcome: 'reject' });
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(1_000);
    mediaSession.pause();
    await vi.advanceTimersByTimeAsync(1_000);

    fake.freezeClock();
    mediaSession.play();
    await vi.advanceTimersByTimeAsync(5_000);

    // Phase 7 7B-6 (owner answer Q12): the clock check armed in place of the
    // retired attempt finds the frozen clock, and the play-request restart
    // parks the context for its dialog's one tap.
    expect(fake.state).toBe('running');
    expect(bus.rejoins).toEqual(['media-session-play']);
    const check = playRequest.afterProbe(o);
    await vi.advanceTimersByTimeAsync(400);
    const { probe, request } = await check;
    expect(probe).toBe('clock-stalled');
    expect(request).not.toBeNull();
    const first = request!.first;
    await vi.advanceTimersByTimeAsync(500);
    await expect(first).resolves.toBe('prepared');
    expect(fake.state).toBe('suspended');
    expect(bus.needed).toEqual([]);
  });

  it('with an OS interruption pending: a PAUSE while that PLAY resumes the context keeps the guest paused', async () => {
    const { fake, o, bus, router, mediaSession } = await openGuest();
    setVisibility('hidden');
    fake.planResume({ outcome: 'reject' }, { latencyMs: 100 });
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(1_000);
    mediaSession.pause();
    await vi.advanceTimersByTimeAsync(1_000);

    mediaSession.play();
    mediaSession.pause();
    await vi.advanceTimersByTimeAsync(5_000);

    // The newer PAUSE wins over the PLAY whose resume was still in flight.
    expect(fake.state).toBe('running');
    expect(bus.rejoins).toEqual([]);
    expect(router.resyncs()).toBe(0);
    expect(o.playerState.isLocalFilePaused()).toBe(true);
    expect(o.getState('playback.activity')).toBe('paused');
  });

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

  it('Known gap (C1-I5, locked start): with no interruption, PAUSE then PLAY while locked rejoins at once, but the track starts only when the app opens', async () => {
    const { fake, o, bus, router, mediaSession } = await openGuest();
    setVisibility('hidden');
    const lockedIncident = foregroundIncident(o);
    expect(lockedIncident).not.toBeNull();

    mediaSession.pause();
    mediaSession.play();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.ops).toEqual([]);
    expect(bus.rejoins).toEqual(['media-session-play']);
    expect(router.resyncs()).toBe(1);
    expect(o.playerState.isLocalFilePaused()).toBe(false);

    // Known gap (C1-I5, locked start; found while preparing Phase 7 7B,
    // recorded only by the owner's decision of 2026-11-04, to be asked again
    // after an iPhone check): the room realignment goes at once, but the
    // start's clock check is the incident the hidden boundary armed, and it
    // cannot sample while the screen stays locked, so transport's PLAY
    // returns without a start until the app opens. A fix flips this row.
    expect(await startCheck(o)).toBe('hidden');
    expect(foregroundIncident(o)).toBe(lockedIncident);

    setVisibility('visible');
    expect(await startCheck(o)).toBe('healthy');
  });
});
