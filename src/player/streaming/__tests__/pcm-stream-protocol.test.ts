import { describe, expect, it, vi } from 'vitest';

import {
  PCM_STREAM_MAX_MESSAGE_FRAMES,
  PCM_STREAM_PROTOCOL_VERSION,
  parsePcmDemandMessage,
} from '../pcm-stream-protocol.ts';

function validDemand(): Record<string, unknown> {
  return {
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'need',
    generation: 7,
    maxFrames: PCM_STREAM_MAX_MESSAGE_FRAMES,
  };
}

describe('PCM stream demand protocol', () => {
  it('returns one immutable canonical snapshot', () => {
    const input = validDemand();
    const parsed = parsePcmDemandMessage(input);

    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    input.maxFrames = 1;
    expect(parsed?.maxFrames).toBe(PCM_STREAM_MAX_MESSAGE_FRAMES);
  });

  it('accepts a null-prototype structured-clone-style record', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, validDemand());
    expect(parsePcmDemandMessage(input)).toEqual(validDemand());
  });

  it.each([
    null,
    [],
    new Date(),
    { ...validDemand(), extra: true },
    { ...validDemand(), protocolVersion: 1 },
    { ...validDemand(), type: 'pcm' },
    { ...validDemand(), generation: 0 },
    { ...validDemand(), generation: 1.5 },
    { ...validDemand(), maxFrames: 0 },
    { ...validDemand(), maxFrames: 1.5 },
    { ...validDemand(), maxFrames: PCM_STREAM_MAX_MESSAGE_FRAMES + 1 },
  ])('rejects non-canonical demand %#', (value) => {
    expect(parsePcmDemandMessage(value)).toBeNull();
  });

  it('rejects missing, symbol, and non-enumerable fields', () => {
    const { maxFrames: _missing, ...missing } = validDemand();
    expect(parsePcmDemandMessage(missing)).toBeNull();

    const symbol = Object.assign(validDemand(), { [Symbol('extra')]: true });
    expect(parsePcmDemandMessage(symbol)).toBeNull();

    const hidden = validDemand();
    Object.defineProperty(hidden, 'maxFrames', {
      configurable: true,
      enumerable: false,
      value: 1,
    });
    expect(parsePcmDemandMessage(hidden)).toBeNull();
  });

  it('rejects accessors without invoking them', () => {
    const getter = vi.fn(() => PCM_STREAM_MAX_MESSAGE_FRAMES);
    const input = validDemand();
    Object.defineProperty(input, 'maxFrames', {
      configurable: true,
      enumerable: true,
      get: getter,
    });

    expect(parsePcmDemandMessage(input)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it('fails closed when reflective inspection throws', () => {
    const input = new Proxy(validDemand(), {
      ownKeys() {
        throw new Error('hostile proxy');
      },
    });
    expect(parsePcmDemandMessage(input)).toBeNull();
  });
});
