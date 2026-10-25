import { describe, expect, it } from 'vitest';
import { RTC_INTERRUPTION_GRACE_MS } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  heartbeatStaleThreshold,
  honoursRecoveryLease,
  isBulkWritable,
  isRecoverablyInterrupted,
  readTransportHealth,
} from '../transport-health.ts';

// The exhaustive bulk table is pinned through isBulkTransferWritablePeer in
// src/storage/__tests__/chunk-pump.test.ts; these rows pin each predicate.

type Health = ReturnType<typeof readTransportHealth>;

function health(overrides: Partial<Health> = {}): Health {
  return {
    open: true,
    link: undefined,
    pc: 'connected',
    ice: 'connected',
    data: 'open',
    control: 'open',
    recoveryDeadline: undefined,
    ...overrides,
  };
}

/** A copy of `fields` whose getters count each read under `prefix` + key. */
function countingFields(
  prefix: string,
  fields: Record<string, unknown>,
  reads: Map<string, number>,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(target, key, {
      enumerable: true,
      get: () => {
        const name = `${prefix}${key}`;
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return value;
      },
    });
  }
  return target;
}

describe('readTransportHealth', () => {
  it('reads every field of one connection once', () => {
    const reads = new Map<string, number>();
    const conn = Object.assign(
      countingFields('', { open: true, iceRecoveryDeadline: 12_345 }, reads),
      {
        peerConnection: countingFields(
          'peerConnection.',
          { connectionState: 'disconnected', iceConnectionState: 'checking' },
          reads,
        ),
        dataChannel: countingFields('dataChannel.', { readyState: 'open' }, reads),
        controlChannel: countingFields('controlChannel.', { readyState: 'closing' }, reads),
      },
    ) as unknown as DataConnection;

    expect(readTransportHealth(conn)).toEqual({
      open: true,
      pc: 'disconnected',
      ice: 'checking',
      data: 'open',
      control: 'closing',
      recoveryDeadline: 12_345,
    });
    expect(Object.fromEntries(reads)).toEqual({
      open: 1,
      iceRecoveryDeadline: 1,
      'peerConnection.connectionState': 1,
      'peerConnection.iceConnectionState': 1,
      'dataChannel.readyState': 1,
      'controlChannel.readyState': 1,
    });
  });

  it.each([null, undefined])('reads a missing connection (%s) as closed and absent', (conn) => {
    expect(readTransportHealth(conn)).toEqual({
      open: false,
      pc: undefined,
      ice: undefined,
      data: undefined,
      control: undefined,
      recoveryDeadline: undefined,
    });
  });
});

describe('isBulkWritable', () => {
  it.each([
    { name: 'a connected route', overrides: {}, writable: true },
    {
      name: 'a connecting route',
      overrides: { pc: 'connecting', ice: 'checking' },
      writable: true,
    },
    {
      name: 'absent RTC state',
      overrides: { pc: undefined, ice: undefined, data: undefined },
      writable: true,
    },
    { name: 'a closed connection', overrides: { open: false }, writable: false },
    { name: 'a data channel still connecting', overrides: { data: 'connecting' }, writable: false },
    { name: 'a disconnected PC', overrides: { pc: 'disconnected' }, writable: false },
    { name: 'a failed ICE transport', overrides: { ice: 'failed' }, writable: false },
    { name: 'a closed ICE transport', overrides: { ice: 'closed' }, writable: false },
  ] as const)('is $writable for $name', ({ overrides, writable }) => {
    expect(isBulkWritable(health(overrides))).toBe(writable);
  });
});

describe('isRecoverablyInterrupted', () => {
  it.each([
    { name: 'a disconnected PC', overrides: { pc: 'disconnected' }, interrupted: true },
    { name: 'a failed PC', overrides: { pc: 'failed' }, interrupted: true },
    { name: 'a disconnected ICE transport', overrides: { ice: 'disconnected' }, interrupted: true },
    { name: 'a failed ICE transport', overrides: { ice: 'failed' }, interrupted: true },
    {
      name: 'an interruption without a data channel',
      overrides: { pc: 'disconnected', data: undefined },
      interrupted: true,
    },
    { name: 'a connected route', overrides: {}, interrupted: false },
    { name: 'a closed PC', overrides: { pc: 'closed' }, interrupted: false },
    {
      name: 'an interruption on a closed connection',
      overrides: { open: false, pc: 'disconnected' },
      interrupted: false,
    },
    {
      name: 'an interruption whose data channel is closing',
      overrides: { ice: 'failed', data: 'closing' },
      interrupted: false,
    },
  ] as const)('is $interrupted for $name', ({ overrides, interrupted }) => {
    expect(isRecoverablyInterrupted(health(overrides))).toBe(interrupted);
  });
});

describe('heartbeatStaleThreshold', () => {
  it.each([
    { name: 'a closed connection', overrides: { open: false }, threshold: 8_000 },
    { name: 'a failed PC', overrides: { pc: 'failed' }, threshold: 8_000 },
    { name: 'a closed control channel', overrides: { control: 'closed' }, threshold: 8_000 },
    { name: 'a connected PC with open channels', overrides: {}, threshold: 90_000 },
    {
      name: 'a connected PC without channels',
      overrides: { data: undefined, control: undefined },
      threshold: 90_000,
    },
    {
      name: 'a connected PC with a connecting channel',
      overrides: { data: 'connecting' },
      threshold: 8_000,
    },
    { name: 'a disconnected PC', overrides: { pc: 'disconnected' }, threshold: 30_000 },
    { name: 'a new PC', overrides: { pc: 'new' }, threshold: 30_000 },
    { name: 'an absent PC', overrides: { pc: undefined }, threshold: 8_000 },
    {
      name: 'a connected PC whose ICE failed',
      overrides: { ice: 'failed' },
      threshold: 90_000,
    },
  ] as const)('is $threshold ms for $name', ({ overrides, threshold }) => {
    expect(heartbeatStaleThreshold(health(overrides))).toBe(threshold);
  });
});

describe('honoursRecoveryLease', () => {
  const NOW = 1_000_000;

  it.each([
    { name: 'one millisecond left', remaining: 1, honoured: true },
    { name: 'exactly one grace left', remaining: RTC_INTERRUPTION_GRACE_MS, honoured: true },
    { name: 'more than one grace left', remaining: RTC_INTERRUPTION_GRACE_MS + 1, honoured: false },
    { name: 'an expired deadline', remaining: 0, honoured: false },
  ])('is $honoured with $name', ({ remaining, honoured }) => {
    const leased = health({ pc: 'failed', recoveryDeadline: NOW + remaining });
    expect(honoursRecoveryLease(leased, NOW)).toBe(honoured);
  });

  it.each([
    { name: 'no deadline', overrides: { recoveryDeadline: undefined } },
    { name: 'a closed connection', overrides: { open: false } },
    { name: 'a data channel that is not open', overrides: { data: 'closing' } },
    { name: 'an absent control channel', overrides: { control: undefined } },
  ] as const)('is not honoured with $name', ({ overrides }) => {
    const leased = health({ pc: 'failed', recoveryDeadline: NOW + 5_000, ...overrides });
    expect(honoursRecoveryLease(leased, NOW)).toBe(false);
  });
});

/**
 * Phase 4 C5-8 (behaviour-risk): for a connection whose provider exposes a
 * link-liveness owner (a Standard-room Cloudflare connection, RO-15), the
 * owner's phase of the original route replaces the PC connectionState rows of
 * the bulk and preload predicates, and the lease comes from the owner's
 * deadline. The raw iceConnectionState rows, which the owner does not observe,
 * still apply. The heartbeat threshold keeps reading the PC state.
 */
describe('with the link-liveness owner view', () => {
  type Phase = 'opening' | 'live' | 'recovering' | 'closed';

  function viewed(link: Phase, overrides: Partial<Health> = {}): Health {
    return health({ link, ...overrides });
  }

  it('reads the owner phase and its deadline once each, and not the connection deadline', () => {
    const reads = new Map<string, number>();
    const conn = Object.assign(
      countingFields('', { open: true, iceRecoveryDeadline: 99_999 }, reads),
      {
        linkLiveness: countingFields(
          'linkLiveness.',
          { phase: 'recovering', recoveryDeadline: 12_345 },
          reads,
        ),
        peerConnection: countingFields(
          'peerConnection.',
          { connectionState: 'connecting', iceConnectionState: 'checking' },
          reads,
        ),
        dataChannel: countingFields('dataChannel.', { readyState: 'open' }, reads),
        controlChannel: countingFields('controlChannel.', { readyState: 'open' }, reads),
      },
    ) as unknown as DataConnection;

    expect(readTransportHealth(conn)).toEqual({
      open: true,
      link: 'recovering',
      pc: 'connecting',
      ice: 'checking',
      data: 'open',
      control: 'open',
      recoveryDeadline: 12_345,
    });
    expect(Object.fromEntries(reads)).toEqual({
      open: 1,
      'linkLiveness.phase': 1,
      'linkLiveness.recoveryDeadline': 1,
      'peerConnection.connectionState': 1,
      'peerConnection.iceConnectionState': 1,
      'dataChannel.readyState': 1,
      'controlChannel.readyState': 1,
    });
  });

  it.each([
    { name: 'a live route', link: 'live', overrides: {}, writable: true },
    {
      name: 'a live route whose PC reads connecting',
      link: 'live',
      overrides: { pc: 'connecting', ice: 'checking' },
      writable: true,
    },
    {
      name: 'a live route whose PC reads disconnected before its owner hears it',
      link: 'live',
      overrides: { pc: 'disconnected' },
      writable: true,
    },
    {
      name: 'a recovering route whose restart reads connecting',
      link: 'recovering',
      overrides: { pc: 'connecting', ice: 'checking' },
      writable: false,
    },
    { name: 'a recovering route', link: 'recovering', overrides: {}, writable: false },
    { name: 'an opening route', link: 'opening', overrides: {}, writable: false },
    { name: 'a closed route', link: 'closed', overrides: {}, writable: false },
    {
      name: 'a live route whose ICE transport disconnected',
      link: 'live',
      overrides: { ice: 'disconnected' },
      writable: false,
    },
    {
      name: 'a live route whose ICE transport failed',
      link: 'live',
      overrides: { ice: 'failed' },
      writable: false,
    },
    {
      name: 'a live route whose ICE transport closed',
      link: 'live',
      overrides: { ice: 'closed' },
      writable: false,
    },
    {
      name: 'a live route on a closed connection',
      link: 'live',
      overrides: { open: false },
      writable: false,
    },
    {
      name: 'a live route whose data channel is closing',
      link: 'live',
      overrides: { data: 'closing' },
      writable: false,
    },
  ] as const)('bulk is $writable for $name', ({ link, overrides, writable }) => {
    expect(isBulkWritable(viewed(link, overrides))).toBe(writable);
  });

  it.each([
    { name: 'a recovering route', link: 'recovering', overrides: {}, interrupted: true },
    {
      name: 'a recovering route whose restart reads connecting',
      link: 'recovering',
      overrides: { pc: 'connecting', ice: 'checking' },
      interrupted: true,
    },
    {
      name: 'a recovering route without a data channel',
      link: 'recovering',
      overrides: { data: undefined },
      interrupted: true,
    },
    {
      name: 'a live route whose PC reads disconnected before its owner hears it',
      link: 'live',
      overrides: { pc: 'disconnected' },
      interrupted: false,
    },
    {
      name: 'a live route whose PC reads failed before its owner hears it',
      link: 'live',
      overrides: { pc: 'failed' },
      interrupted: false,
    },
    {
      name: 'a live route whose ICE transport disconnected',
      link: 'live',
      overrides: { ice: 'disconnected' },
      interrupted: true,
    },
    {
      name: 'a live route whose ICE transport failed',
      link: 'live',
      overrides: { ice: 'failed' },
      interrupted: true,
    },
    { name: 'a live route', link: 'live', overrides: {}, interrupted: false },
    {
      name: 'a closed route',
      link: 'closed',
      overrides: { pc: 'disconnected' },
      interrupted: false,
    },
    {
      name: 'a recovering route on a closed connection',
      link: 'recovering',
      overrides: { open: false },
      interrupted: false,
    },
    {
      name: 'a recovering route whose data channel is closing',
      link: 'recovering',
      overrides: { data: 'closing' },
      interrupted: false,
    },
  ] as const)('is $interrupted interrupted for $name', ({ link, overrides, interrupted }) => {
    expect(isRecoverablyInterrupted(viewed(link, overrides))).toBe(interrupted);
  });

  it.each([
    {
      name: 'a recovering route whose PC reads connected',
      link: 'recovering',
      pc: 'connected',
      threshold: 90_000,
    },
    {
      name: 'a live route whose PC reads disconnected',
      link: 'live',
      pc: 'disconnected',
      threshold: 30_000,
    },
    {
      name: 'a recovering route whose PC reads failed',
      link: 'recovering',
      pc: 'failed',
      threshold: 8_000,
    },
  ] as const)(
    'keeps the heartbeat threshold on the PC state: $threshold ms for $name',
    ({ link, pc, threshold }) => {
      expect(heartbeatStaleThreshold(viewed(link, { pc }))).toBe(threshold);
    },
  );
});
