import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { MSG } from '../../core/constants.ts';
import { createSystemAudioStartFrame, readSystemAudioStartSurface } from '../system-audio-start.ts';

describe('system audio start metadata', () => {
  beforeEach(() => resetState());

  it('uses the current synthetic metadata as the late-join source of truth', () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio',
      systemAudioMode: 'sharing',
      systemAudioSurface: 'window',
    });

    expect(createSystemAudioStartFrame()).toEqual({
      type: MSG.SYSTEM_AUDIO_START,
      surface: 'window',
    });
  });

  it('normalizes explicit, missing, and future values without forwarding raw text', () => {
    expect(createSystemAudioStartFrame('browser')).toEqual({
      type: MSG.SYSTEM_AUDIO_START,
      surface: 'browser',
    });
    expect(createSystemAudioStartFrame()).toEqual({
      type: MSG.SYSTEM_AUDIO_START,
      surface: 'display',
    });
    expect(readSystemAudioStartSurface({ surface: 'private window title' })).toBe('display');
  });

  it('keeps every production START sender on the shared constructor', () => {
    const producers = [
      new URL('../../audio/system-capture.ts', import.meta.url),
      new URL('../system-audio-host.ts', import.meta.url),
      new URL('../system-audio-sfu.ts', import.meta.url),
      new URL('../../player/playback.ts', import.meta.url),
    ];
    for (const producer of producers) {
      const source = readFileSync(producer, 'utf8');
      expect(source).toContain('createSystemAudioStartFrame');
      expect(source).not.toMatch(/\{\s*type:\s*MSG\.SYSTEM_AUDIO_START\s*\}/u);
    }
  });
});
