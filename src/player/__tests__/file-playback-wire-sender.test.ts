import { describe, expect, it } from 'vitest';

import {
  FilePlaybackWireSender,
  type FilePlaybackWirePayload,
  type FilePlaybackWireSenderOptions,
} from '../file-playback-wire-sender.ts';
import type { FilePlaybackWireMediaBinding } from '../file-playback-wire.ts';

const scope: FilePlaybackWireSenderOptions = {
  sessionId: 'app-session-1',
  connectionId: 'connection-1',
  senderParticipantId: 'participant-guest-1',
  recipientParticipantId: 'participant-host',
};

const media: FilePlaybackWireMediaBinding = {
  run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
  sourceIdentity: 'sha256:source-1',
  transferSessionId: 'transfer-session-9',
  rendezvousId: 'rendezvous-7',
};

const payloads = Object.freeze([
  {
    kind: 'source-ready',
    observedAtRoomTimeMs: 10_000,
    readyLeaseUntilRoomTimeMs: 40_000,
    backend: 'streaming-flac',
    durationSeconds: 555.7,
    bufferedAheadSeconds: 9.6,
    outputSampleRateHz: 48_000,
    channelCount: 2,
  },
  {
    kind: 'source-not-ready',
    observedAtRoomTimeMs: 10_001,
    reasonCode: 'source-still-loading',
    retryable: true,
  },
  {
    kind: 'rendezvous-arm',
    rendezvousId: 'rendezvous-7',
    positionSeconds: 12.25,
    playbackRate: 1,
    startAtRoomTimeMs: 12_000,
    finalizeByRoomTimeMs: 11_900,
  },
  {
    kind: 'rendezvous-armed',
    rendezvousId: 'rendezvous-7',
    status: 'armed',
    observedAtRoomTimeMs: 11_850,
    bufferedAheadSeconds: 9.4,
    reasonCode: null,
  },
  {
    kind: 'rendezvous-finalize',
    rendezvousId: 'rendezvous-7',
    startAtRoomTimeMs: 12_000,
    finalizedAtRoomTimeMs: 11_880,
  },
  {
    kind: 'rendezvous-finalized',
    rendezvousId: 'rendezvous-7',
    status: 'accepted',
    observedAtRoomTimeMs: 11_890,
    reasonCode: null,
  },
  { kind: 'file-playback-pause', atRoomTimeMs: 13_000 },
  { kind: 'file-playback-seek', positionSeconds: 99.5, atRoomTimeMs: 13_100 },
  { kind: 'file-playback-cancel', reasonCode: 'superseded-by-newer-revision' },
  {
    kind: 'renderer-health',
    rendezvousId: 'rendezvous-7',
    value: 'healthy',
    observedAtRoomTimeMs: 13_200,
    leaseUntilRoomTimeMs: 18_200,
    renderedFrame: 633_600,
    underrunCount: 0,
    reasonCode: null,
  },
] as const satisfies readonly FilePlaybackWirePayload[]);

function sender(binding: FilePlaybackWireMediaBinding = media): FilePlaybackWireSender {
  const result = new FilePlaybackWireSender(scope);
  result.bindMedia(binding);
  return result;
}

describe('FilePlaybackWireSender', () => {
  it('builds every exact payload kind with one canonical connection and media envelope', () => {
    const outbound = sender();

    payloads.forEach((payload, index) => {
      const message = outbound.create(payload);
      expect(message).toEqual({
        protocolVersion: 2,
        ...scope,
        controlSequence: index + 1,
        queueItemId: 'queue-item-1',
        runId: 'run-7',
        revision: 7,
        sourceIdentity: 'sha256:source-1',
        transferSessionId: 'transfer-session-9',
        ...payload,
      });
      expect(Object.getPrototypeOf(message)).toBeNull();
      expect(Object.isFrozen(message)).toBe(true);
    });

    expect(outbound.lastControlSequence()).toBe(payloads.length);
  });

  it('snapshots connection scope and media binding as exact own data', () => {
    const mutableScope = { ...scope };
    const mutableRun = { ...media.run };
    const mutableMedia = { ...media, run: mutableRun };
    const outbound = new FilePlaybackWireSender(mutableScope);
    outbound.bindMedia(mutableMedia);

    mutableScope.sessionId = 'mutated-session';
    mutableScope.connectionId = 'mutated-connection';
    mutableRun.runId = 'mutated-run';
    mutableMedia.sourceIdentity = 'mutated-source';
    mutableMedia.rendezvousId = 'mutated-rendezvous';

    const message = outbound.create(payloads[0]);
    expect(message.sessionId).toBe('app-session-1');
    expect(message.connectionId).toBe('connection-1');
    expect(message.runId).toBe('run-7');
    expect(message.sourceIdentity).toBe('sha256:source-1');
  });

  it('reads each own data descriptor once and never invokes scope or binding accessors', () => {
    const scopeReads = new Map<PropertyKey, number>();
    const proxiedScope = new Proxy(
      { ...scope },
      {
        getOwnPropertyDescriptor(target, property) {
          scopeReads.set(property, (scopeReads.get(property) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    const outbound = new FilePlaybackWireSender(proxiedScope);
    expect([...scopeReads.values()]).toEqual([1, 1, 1, 1]);

    const mediaReads = new Map<PropertyKey, number>();
    const proxiedMedia = new Proxy(
      { ...media },
      {
        getOwnPropertyDescriptor(target, property) {
          mediaReads.set(property, (mediaReads.get(property) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    outbound.bindMedia(proxiedMedia);
    expect([...mediaReads.values()]).toEqual([1, 1, 1, 1]);

    let getterCalls = 0;
    const accessorScope = { ...scope };
    Object.defineProperty(accessorScope, 'sessionId', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'app-session-1';
      },
    });
    expect(() => new FilePlaybackWireSender(accessorScope)).toThrow(TypeError);

    const accessorMedia = { ...media };
    Object.defineProperty(accessorMedia, 'sourceIdentity', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'sha256:source-1';
      },
    });
    expect(() => outbound.bindMedia(accessorMedia)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it('rejects extra, missing, symbol, non-enumerable, and accessor payload fields atomically', () => {
    const outbound = sender();
    let getterCalls = 0;
    const extra = { ...payloads[0], queueIndex: 0 };
    const missing = { ...payloads[0] } as Record<string, unknown>;
    delete missing.durationSeconds;
    const symbol = { ...payloads[0] };
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: 'x' });
    const nonEnumerable = { ...payloads[0] };
    Object.defineProperty(nonEnumerable, 'hidden', { enumerable: false, value: 'x' });
    const accessor = { ...payloads[0] };
    Object.defineProperty(accessor, 'durationSeconds', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 555.7;
      },
    });

    for (const candidate of [extra, missing, symbol, nonEnumerable, accessor]) {
      expect(() => outbound.create(candidate as (typeof payloads)[0])).toThrow(TypeError);
      expect(outbound.lastControlSequence()).toBe(0);
    }
    expect(getterCalls).toBe(0);
  });

  it('uses the latest sequence and media authority after hostile Proxy re-entry', () => {
    const outbound = sender();
    let nested: ReturnType<typeof outbound.create<'source-not-ready'>> | null = null;
    let reentered = false;
    const outer = new Proxy(
      { ...payloads[0] },
      {
        ownKeys(target) {
          if (!reentered) {
            reentered = true;
            nested = outbound.create(payloads[1]);
            outbound.bindMedia({
              run: { queueItemId: 'queue-item-2', runId: 'run-8', revision: 8 },
              sourceIdentity: 'sha256:source-2',
              transferSessionId: null,
            });
          }
          return Reflect.ownKeys(target);
        },
      },
    );

    const created = outbound.create(outer);
    expect(nested?.controlSequence).toBe(1);
    expect(nested?.queueItemId).toBe('queue-item-1');
    expect(created.controlSequence).toBe(2);
    expect(created.queueItemId).toBe('queue-item-2');
    expect(created.sourceIdentity).toBe('sha256:source-2');
    expect(created.transferSessionId).toBeNull();
    expect(outbound.lastControlSequence()).toBe(2);
  });

  it('does not advance state when detached payload validation or canonicalization fails', () => {
    const outbound = sender();
    expect(() => outbound.create({ ...payloads[0], durationSeconds: 0 })).toThrow(TypeError);
    expect(outbound.lastControlSequence()).toBe(0);

    const first = outbound.create(payloads[0]);
    expect(first.controlSequence).toBe(1);
    expect(() => outbound.create({ ...payloads[8], reasonCode: '' })).toThrow(TypeError);
    expect(outbound.lastControlSequence()).toBe(1);
    expect(outbound.create(payloads[1]).controlSequence).toBe(2);
  });

  it('permanently consumes successful creates so unsent frames become harmless gaps', () => {
    const outbound = sender();
    void outbound.create(payloads[0]);
    const transmitted = outbound.create(payloads[1]);

    expect(transmitted.controlSequence).toBe(2);
    expect(outbound.lastControlSequence()).toBe(2);
  });

  it('binds rendezvous-bearing payloads without blocking run-level control', () => {
    const outbound = sender();
    for (const payload of [payloads[0], payloads[1], payloads[6], payloads[7], payloads[8]]) {
      expect(() => outbound.create(payload)).not.toThrow();
    }

    const beforeMismatch = outbound.lastControlSequence();
    expect(() => outbound.create({ ...payloads[2], rendezvousId: 'stale-rendezvous' })).toThrow(
      TypeError,
    );
    expect(outbound.lastControlSequence()).toBe(beforeMismatch);
    expect(outbound.create(payloads[9]).rendezvousId).toBe('rendezvous-7');
  });

  it('requires a bound rendezvous for renderer health but permits rendezvous setup without one', () => {
    const outbound = sender({
      run: media.run,
      sourceIdentity: media.sourceIdentity,
      transferSessionId: media.transferSessionId,
    });

    expect(outbound.create(payloads[2]).kind).toBe('rendezvous-arm');
    expect(() => outbound.create(payloads[9])).toThrow(TypeError);
    expect(outbound.lastControlSequence()).toBe(1);

    outbound.bindMedia(media);
    expect(outbound.create(payloads[9]).controlSequence).toBe(2);
  });

  it('rejects creates after media is cleared and resumes without reusing a sequence', () => {
    const outbound = sender();
    expect(outbound.create(payloads[0]).controlSequence).toBe(1);
    outbound.clearMedia();

    expect(() => outbound.create(payloads[1])).toThrow(TypeError);
    expect(outbound.lastControlSequence()).toBe(1);

    outbound.bindMedia(media);
    expect(outbound.create(payloads[1]).controlSequence).toBe(2);
  });
});
