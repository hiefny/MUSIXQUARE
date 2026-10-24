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
    pc: 'connected',
    ice: 'connected',
    data: 'open',
    control: 'open',
    recoveryDeadline: undefined,
    ...overrides,
  };
}

describe('readTransportHealth', () => {
  it('reads every field of one connection once', () => {
    const conn = {
      open: true,
      peerConnection: { connectionState: 'disconnected', iceConnectionState: 'checking' },
      dataChannel: { readyState: 'open' },
      controlChannel: { readyState: 'closing' },
      iceRecoveryDeadline: 12_345,
    } as unknown as DataConnection;

    expect(readTransportHealth(conn)).toEqual({
      open: true,
      pc: 'disconnected',
      ice: 'checking',
      data: 'open',
      control: 'closing',
      recoveryDeadline: 12_345,
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
