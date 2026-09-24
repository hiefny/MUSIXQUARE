import { describe, expect, it } from 'vitest';
import {
  AudioDecoderStartupError,
  isAudioDecoderStartupError,
  withAudioDecoderStartup,
} from '../startup-error.ts';

describe('decoder startup failure classification', () => {
  it('preserves an acquisition failure as the cause and permits the next attempt', async () => {
    const interrupted = new TypeError('download interrupted');
    const first = await withAudioDecoderStartup(async () => {
      throw interrupted;
    }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(AudioDecoderStartupError);
    expect((first as Error).cause).toBe(interrupted);
    expect(isAudioDecoderStartupError(new Error('media failed', { cause: first }))).toBe(true);
    await expect(withAudioDecoderStartup(async () => 42)).resolves.toBe(42);
  });

  it('does not classify decode failures, text lookalikes or cyclic causes as startup', () => {
    expect(isAudioDecoderStartupError(new Error('unsupported codec'))).toBe(false);
    expect(isAudioDecoderStartupError(new Error('Audio decoder startup failed'))).toBe(false);
    expect(isAudioDecoderStartupError({ name: 'AudioDecoderStartupError' })).toBe(false);
    const cyclic = new Error('corrupt frame');
    cyclic.cause = cyclic;
    expect(isAudioDecoderStartupError(cyclic)).toBe(false);
  });
});
