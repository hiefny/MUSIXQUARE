import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MSG } from '../../core/constants.ts';
import { resetState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  JOIN_BOOTSTRAP_TIMEOUT_MS,
  createJoinBootstrapId,
  isJoinBootstrapPayloadFrame,
  snapshotJoinBootstrapApplied,
  snapshotJoinBootstrapHello,
} from '../join-bootstrap.ts';
import { handleData, registerHandler } from '../protocol.ts';

const BOOTSTRAP_ID = '12345678-1234-4abc-8def-1234567890ab';

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
});

describe('join bootstrap control frames', () => {
  it('snapshots exact version-1 HELLO and APPLIED frames', () => {
    const hello = {
      type: MSG.JOIN_BOOTSTRAP_HELLO,
      version: 1,
      bootstrapId: BOOTSTRAP_ID,
    };
    const applied = Object.assign(Object.create(null), {
      type: MSG.JOIN_BOOTSTRAP_APPLIED,
      version: 1,
      bootstrapId: BOOTSTRAP_ID,
    });

    const helloSnapshot = snapshotJoinBootstrapHello(hello);
    const appliedSnapshot = snapshotJoinBootstrapApplied(applied);

    expect(helloSnapshot).toEqual(hello);
    expect(helloSnapshot).not.toBe(hello);
    expect(Object.isFrozen(helloSnapshot)).toBe(true);
    expect(appliedSnapshot).toEqual({
      type: MSG.JOIN_BOOTSTRAP_APPLIED,
      version: 1,
      bootstrapId: BOOTSTRAP_ID,
    });
  });

  it.each([
    { value: null },
    { value: [] },
    { value: { type: MSG.JOIN_BOOTSTRAP_HELLO, version: 1 } },
    {
      value: { type: MSG.JOIN_BOOTSTRAP_HELLO, version: 2, bootstrapId: BOOTSTRAP_ID },
    },
    {
      value: { type: MSG.JOIN_BOOTSTRAP_APPLIED, version: 1, bootstrapId: BOOTSTRAP_ID },
    },
    { value: { type: MSG.JOIN_BOOTSTRAP_HELLO, version: 1, bootstrapId: 'not-a-uuid' } },
    {
      value: {
        type: MSG.JOIN_BOOTSTRAP_HELLO,
        version: 1,
        bootstrapId: BOOTSTRAP_ID,
        extra: true,
      },
    },
  ])('rejects malformed or non-exact HELLO input: $value', ({ value }) => {
    expect(snapshotJoinBootstrapHello(value)).toBeNull();
  });

  it('rejects accessors without invoking them', () => {
    const getter = vi.fn(() => BOOTSTRAP_ID);
    const value = {
      type: MSG.JOIN_BOOTSTRAP_HELLO,
      version: 1,
      get bootstrapId(): string {
        return getter();
      },
    };

    expect(snapshotJoinBootstrapHello(value)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it('creates unique, canonical version-4 identifiers with secure browser randomness', () => {
    const ids = Array.from({ length: 16 }, () => createJoinBootstrapId());

    expect(new Set(ids).size).toBe(ids.length);
    expect(
      ids.every(
        (bootstrapId) =>
          snapshotJoinBootstrapHello({
            type: MSG.JOIN_BOOTSTRAP_HELLO,
            version: 1,
            bootstrapId,
          }) !== null,
      ),
    ).toBe(true);
    expect(JOIN_BOOTSTRAP_TIMEOUT_MS).toBe(10_000);
  });
});

describe('ordered join bootstrap payload envelope', () => {
  const playlistFrame = {
    type: MSG.PLAYLIST_UPDATE,
    list: 'validated-by-playlist-ack',
    revision: 4,
    currentQueueItemId: null,
    bootstrap: true,
  };
  const repeatFrame = { type: MSG.REPEAT_MODE, value: 2, _bootstrap: true };
  const shuffleFrame = { type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true };

  it('accepts only playlist, repeat, then shuffle envelopes', () => {
    expect(isJoinBootstrapPayloadFrame(playlistFrame, 0)).toBe(true);
    expect(isJoinBootstrapPayloadFrame(repeatFrame, 1)).toBe(true);
    expect(isJoinBootstrapPayloadFrame(shuffleFrame, 2)).toBe(true);

    expect(isJoinBootstrapPayloadFrame(repeatFrame, 0)).toBe(false);
    expect(isJoinBootstrapPayloadFrame(shuffleFrame, 1)).toBe(false);
    expect(isJoinBootstrapPayloadFrame(playlistFrame, 2)).toBe(false);
    expect(isJoinBootstrapPayloadFrame(shuffleFrame, 3)).toBe(false);
  });

  it('rejects missing markers, invalid modes, extra keys, and accessor values', () => {
    expect(isJoinBootstrapPayloadFrame({ ...playlistFrame, bootstrap: false }, 0)).toBe(false);
    expect(isJoinBootstrapPayloadFrame({ ...repeatFrame, value: 3 }, 1)).toBe(false);
    expect(isJoinBootstrapPayloadFrame({ ...shuffleFrame, value: 0 }, 2)).toBe(false);
    expect(isJoinBootstrapPayloadFrame({ ...repeatFrame, extra: true }, 1)).toBe(false);

    const getter = vi.fn(() => 1);
    const accessorFrame = {
      type: MSG.REPEAT_MODE,
      _bootstrap: true,
      get value(): number {
        return getter();
      },
    };
    expect(isJoinBootstrapPayloadFrame(accessorFrame, 1)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('join bootstrap protocol validators', () => {
  it('dispatches only exact validated HELLO and APPLIED frames', async () => {
    const helloHandler = vi.fn();
    const appliedHandler = vi.fn();
    const conn = { peer: 'guest-bootstrap' } as DataConnection;
    registerHandler(MSG.JOIN_BOOTSTRAP_HELLO, helloHandler);
    registerHandler(MSG.JOIN_BOOTSTRAP_APPLIED, appliedHandler);

    const hello = {
      type: MSG.JOIN_BOOTSTRAP_HELLO,
      version: 1 as const,
      bootstrapId: BOOTSTRAP_ID,
    };
    const applied = {
      type: MSG.JOIN_BOOTSTRAP_APPLIED,
      version: 1 as const,
      bootstrapId: BOOTSTRAP_ID,
    };
    await handleData(hello, conn);
    await handleData({ ...hello, extra: true }, conn);
    await handleData(applied, conn);
    await handleData({ ...applied, bootstrapId: 'invalid' }, conn);

    expect(helloHandler).toHaveBeenCalledOnce();
    expect(helloHandler).toHaveBeenCalledWith(hello, conn);
    expect(appliedHandler).toHaveBeenCalledOnce();
    expect(appliedHandler).toHaveBeenCalledWith(applied, conn);
  });
});
