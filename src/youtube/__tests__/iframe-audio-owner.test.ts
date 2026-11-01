/**
 * The iframe audio owner's own pieces (src/youtube/iframe-audio.ts, RO-12),
 * pinned with Phase 6 6C-2, which moves the App's audio writes and holds into
 * it: the app audio read from the master volume under its two mute rules, the
 * PRO pause gate's token and its bare mute, the holds player.ts registers,
 * and the three app writes with their orders and optional calls.
 * youtube-iframe-audio-order.test.ts pins the same writes through the App's
 * real wiring; iframe-audio.test.ts pins the verified restore.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { YouTubePlayerInstance } from '../_state.ts';

/** The master volume getState answers, and every path read. */
const appState = vi.hoisted(() => ({ masterVolume: 1 as unknown, reads: [] as string[] }));
vi.mock('../../core/state.ts', () => ({
  getState: (path: string) => {
    appState.reads.push(path);
    return path === 'audio.masterVolume' ? appState.masterVolume : undefined;
  },
}));

import {
  applyYouTubeAudio,
  clearYouTubePauseGate,
  enforceYouTubePauseGate,
  holdYouTubePauseGate,
  isYouTubePauseGateHeld,
  readYouTubeAppAudio,
  registerYouTubeAudioHolds,
  releaseYouTubePauseGate,
} from '../iframe-audio.ts';

type AudioMethod = 'setVolume' | 'mute' | 'unMute';

/** An iframe with only the given audio methods, each logging its call into `calls`. */
function recordingPlayer(
  calls: string[],
  methods: readonly AudioMethod[] = ['setVolume', 'mute', 'unMute'],
): YouTubePlayerInstance {
  const player: Partial<Record<AudioMethod, (volume?: number) => void>> = {};
  if (methods.includes('setVolume')) {
    player.setVolume = (volume) => {
      calls.push(`setVolume(${volume})`);
    };
  }
  if (methods.includes('mute')) player.mute = () => calls.push('mute()');
  if (methods.includes('unMute')) player.unMute = () => calls.push('unMute()');
  return player as unknown as YouTubePlayerInstance;
}

/** Registers holds that log each ask into `calls` and answer as given. */
function registerHolds(calls: string[], held: { parked?: boolean; start?: boolean } = {}): void {
  registerYouTubeAudioHolds(
    () => {
      calls.push('parked?');
      return held.parked ?? false;
    },
    () => {
      calls.push('parking proof');
    },
    () => {
      calls.push('start hold?');
      return held.start ?? false;
    },
  );
}

/** The calls one write makes on a recording player under the given holds. */
function written(
  audio: { muted: boolean; volume: number },
  write: 0 | 1 | 2,
  held: { parked?: boolean; start?: boolean; gate?: boolean } = {},
  methods?: readonly AudioMethod[],
): string[] {
  const calls: string[] = [];
  registerHolds(calls, held);
  if (held.gate) holdYouTubePauseGate(1);
  applyYouTubeAudio(recordingPlayer(calls, methods), audio, write);
  return calls;
}

const LOUD = { muted: false, volume: 40 } as const;
const SILENT = { muted: true, volume: 0 } as const;

beforeEach(() => {
  clearYouTubePauseGate();
  appState.masterVolume = 1;
  appState.reads = [];
  registerHolds([]);
});

describe('readYouTubeAppAudio: the app audio read from the master volume (pinned 2026-11-02)', () => {
  it.each([
    [1, { muted: false, volume: 100 }, { muted: false, volume: 100 }],
    [0.734, { muted: false, volume: 73 }, { muted: false, volume: 73 }],
    [0.005, { muted: false, volume: 1 }, { muted: false, volume: 1 }],
    // The two rules disagree only for 0 < masterVolume < 0.005.
    [0.004, { muted: true, volume: 0 }, { muted: false, volume: 0 }],
    [0, { muted: true, volume: 0 }, { muted: true, volume: 0 }],
    [-0.25, { muted: true, volume: 0 }, { muted: true, volume: 0 }],
    [1.5, { muted: false, volume: 100 }, { muted: false, volume: 100 }],
    // An unset master volume reads as 1, as everywhere else in the App.
    [undefined, { muted: false, volume: 100 }, { muted: false, volume: 100 }],
    [Number.NaN, { muted: false, volume: Number.NaN }, { muted: false, volume: Number.NaN }],
  ])('at master volume %s: rounded %o, non-positive %o', (masterVolume, rounded, nonPositive) => {
    appState.masterVolume = masterVolume;
    expect({
      rounded: readYouTubeAppAudio(),
      nonPositive: readYouTubeAppAudio(true),
      reads: appState.reads,
    }).toEqual({ rounded, nonPositive, reads: ['audio.masterVolume', 'audio.masterVolume'] });
  });

  it('reads the master volume at each call into a new object, keeping no answer', () => {
    appState.masterVolume = 0.4;
    const first = readYouTubeAppAudio();
    appState.masterVolume = 0;
    const second = readYouTubeAppAudio();
    expect(first).not.toBe(second);
    expect({ first, second }).toEqual({
      first: { muted: false, volume: 40 },
      second: { muted: true, volume: 0 },
    });
  });
});

describe('the PRO pause gate (pinned 2026-11-02)', () => {
  it('holds one token, which alone releases it, once', () => {
    expect(isYouTubePauseGateHeld()).toBe(false);
    expect(releaseYouTubePauseGate(5)).toBe(false);
    holdYouTubePauseGate(5);
    expect(isYouTubePauseGateHeld()).toBe(true);
    expect(releaseYouTubePauseGate(4)).toBe(false);
    expect(isYouTubePauseGateHeld()).toBe(true);
    expect(releaseYouTubePauseGate(5)).toBe(true);
    expect(isYouTubePauseGateHeld()).toBe(false);
    expect(releaseYouTubePauseGate(5)).toBe(false);
  });

  it('lets a newer pause take the gate from an older one', () => {
    holdYouTubePauseGate(6);
    holdYouTubePauseGate(7);
    expect(releaseYouTubePauseGate(6)).toBe(false);
    expect(isYouTubePauseGateHeld()).toBe(true);
    expect(releaseYouTubePauseGate(7)).toBe(true);
  });

  it('drops the gate, whatever token holds it, so that token releases nothing later', () => {
    holdYouTubePauseGate(8);
    clearYouTubePauseGate();
    expect(isYouTubePauseGateHeld()).toBe(false);
    expect(releaseYouTubePauseGate(8)).toBe(false);
  });

  it('mutes at once with a bare mute(), asking no hold, and skips what the iframe cannot do', () => {
    const calls: string[] = [];
    registerHolds(calls, { parked: true, start: true });
    enforceYouTubePauseGate(recordingPlayer(calls));
    enforceYouTubePauseGate(null);
    enforceYouTubePauseGate(recordingPlayer(calls, ['setVolume', 'unMute']));
    expect(calls).toEqual(['mute()']);
  });
});

describe('applyYouTubeAudio, write 0: a youtube:set-volume write (pinned 2026-11-02)', () => {
  it.each([
    ['nothing holds', LOUD, {}, ['setVolume(40)', 'parked?', 'start hold?', 'unMute()']],
    ['the volume is 0', SILENT, {}, ['setVolume(0)', 'parked?', 'mute()']],
    ['the gate holds', LOUD, { gate: true }, ['setVolume(40)', 'parked?', 'mute()']],
    ['a start owner holds', LOUD, { start: true }, ['setVolume(40)', 'parked?', 'start hold?']],
    ['a start owner holds at 0', SILENT, { start: true }, ['setVolume(0)', 'parked?', 'mute()']],
    [
      'the iframe is parked',
      LOUD,
      { parked: true, start: true, gate: true },
      ['setVolume(40)', 'parked?', 'parking proof'],
    ],
  ] as const)('when %s', (_when, audio, held, calls) => {
    expect(written(audio, 0, held)).toEqual(calls);
  });

  it('writes nothing and asks no hold without an iframe or its setVolume', () => {
    const calls: string[] = [];
    registerHolds(calls);
    applyYouTubeAudio(null, LOUD, 0);
    applyYouTubeAudio(recordingPlayer(calls, ['mute', 'unMute']), LOUD, 0);
    expect(calls).toEqual([]);
  });

  it('skips a mute or unMute the iframe does not have', () => {
    expect({
      loud: written(LOUD, 0, {}, ['setVolume', 'mute']),
      silent: written(SILENT, 0, {}, ['setVolume', 'unMute']),
    }).toEqual({
      loud: ['setVolume(40)', 'parked?', 'start hold?'],
      silent: ['setVolume(0)', 'parked?'],
    });
  });

  it('lets a throwing setVolume end the write before any hold is asked', () => {
    const calls: string[] = [];
    registerHolds(calls);
    const player = {
      setVolume: () => {
        calls.push('setVolume(40)');
        throw new Error('synthetic setVolume fault');
      },
      unMute: () => calls.push('unMute()'),
    } as unknown as YouTubePlayerInstance;
    expect(() => applyYouTubeAudio(player, LOUD, 0)).toThrow('synthetic setVolume fault');
    expect(calls).toEqual(['setVolume(40)']);
  });
});

describe('applyYouTubeAudio, write 1: the PRO pause gate settlement (pinned 2026-11-02)', () => {
  it.each([
    ['nothing holds', LOUD, {}, ['parked?', 'setVolume(40)', 'start hold?', 'unMute()']],
    ['the volume is 0', SILENT, {}, ['parked?', 'setVolume(0)', 'mute()']],
    ['another pause holds the gate', LOUD, { gate: true }, ['parked?', 'setVolume(40)', 'mute()']],
    ['a start owner holds', LOUD, { start: true }, ['parked?', 'setVolume(40)', 'start hold?']],
    [
      'the iframe is parked',
      LOUD,
      { parked: true, start: true, gate: true },
      ['parked?', 'parking proof'],
    ],
  ] as const)('when %s', (_when, audio, held, calls) => {
    expect(written(audio, 1, held)).toEqual(calls);
  });

  it('writes nothing without an iframe, and skips a setVolume it does not have', () => {
    const calls: string[] = [];
    registerHolds(calls);
    applyYouTubeAudio(null, LOUD, 1);
    expect({
      none: calls,
      noSetVolume: written(LOUD, 1, {}, ['mute', 'unMute']),
    }).toEqual({ none: [], noSetVolume: ['parked?', 'start hold?', 'unMute()'] });
  });
});

describe('applyYouTubeAudio, write 2: the PRO direct commit (pinned 2026-11-02)', () => {
  it.each([
    ['nothing holds', LOUD, {}, ['setVolume(40)', 'unMute()']],
    ['the volume is 0', SILENT, {}, ['setVolume(0)', 'mute()']],
    ['the gate holds', LOUD, { gate: true }, ['setVolume(40)', 'mute()']],
    // It asks neither parking nor a start owner.
    [
      'the other holds would hold',
      LOUD,
      { parked: true, start: true },
      ['setVolume(40)', 'unMute()'],
    ],
  ] as const)('when %s', (_when, audio, held, calls) => {
    expect(written(audio, 2, held)).toEqual(calls);
  });

  it('skips what the iframe cannot do', () => {
    expect({
      unMuteOnly: written(LOUD, 2, {}, ['unMute']),
      setVolumeOnly: written(SILENT, 2, {}, ['setVolume']),
    }).toEqual({ unMuteOnly: ['unMute()'], setVolumeOnly: ['setVolume(0)'] });
  });
});

describe('the holds player.ts registers (pinned 2026-11-02)', () => {
  it('reads every hold as not held until they are registered', async () => {
    vi.resetModules();
    const fresh = await import('../iframe-audio.ts');
    const calls: string[] = [];
    fresh.applyYouTubeAudio(recordingPlayer(calls), LOUD, 0);
    fresh.applyYouTubeAudio(recordingPlayer(calls), LOUD, 1);
    expect(calls).toEqual(['setVolume(40)', 'unMute()', 'setVolume(40)', 'unMute()']);
  });

  it('asks nothing when registered, then the last registration at each write, with the written iframe', () => {
    const asked: unknown[] = [];
    const calls: string[] = [];
    registerHolds(calls, { parked: true });
    registerYouTubeAudioHolds(
      (player) => {
        asked.push(player);
        return false;
      },
      () => {
        calls.push('parking proof');
      },
      () => {
        calls.push('start hold?');
        return false;
      },
    );
    expect(calls).toEqual([]);
    const player = recordingPlayer(calls);
    applyYouTubeAudio(player, LOUD, 0);
    expect({ calls, parkedAsked: asked.length, samePlayer: asked[0] === player }).toEqual({
      calls: ['setVolume(40)', 'start hold?', 'unMute()'],
      parkedAsked: 1,
      samePlayer: true,
    });
  });
});
