import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  isRendezvousFinalizationOpen,
  readRendezvousArmIntent,
  validateRendezvousArmReceipt,
  validateRendezvousFinalization,
  validateRendezvousFinalizeReceipt,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
} from '../rendezvous-contract.ts';

const QID = '00000000-0000-4000-8000-000000000001' as QueueItemId;

function armIntent(overrides: Partial<RendezvousArmIntent> = {}): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId: QID,
    runId: 'run-7',
    revision: 7,
    rendezvousId: 'rv-7',
    recipientId: 'peer-1',
    positionSeconds: 15,
    playbackRate: 1,
    startAtRoomTimeMs: 2_000,
    finalizeByRoomTimeMs: 1_900,
    ...overrides,
  };
}

function armReceipt(overrides: Partial<RendezvousArmReceipt> = {}): RendezvousArmReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    queueItemId: QID,
    runId: 'run-7',
    revision: 7,
    rendezvousId: 'rv-7',
    participantId: 'peer-1',
    status: 'armed',
    observedAtRoomTimeMs: 1_850,
    bufferedAheadSeconds: 4,
    reasonCode: null,
    ...overrides,
  };
}

function finalizeIntent(
  overrides: Partial<RendezvousFinalizeIntent> = {},
): RendezvousFinalizeIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalize',
    queueItemId: QID,
    runId: 'run-7',
    revision: 7,
    rendezvousId: 'rv-7',
    recipientId: 'peer-1',
    startAtRoomTimeMs: 2_000,
    finalizedAtRoomTimeMs: 1_875,
    ...overrides,
  };
}

function finalizeReceipt(
  overrides: Partial<RendezvousFinalizeReceipt> = {},
): RendezvousFinalizeReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalized',
    queueItemId: QID,
    runId: 'run-7',
    revision: 7,
    rendezvousId: 'rv-7',
    participantId: 'peer-1',
    status: 'accepted',
    observedAtRoomTimeMs: 1_880,
    reasonCode: null,
    ...overrides,
  };
}

describe('rendezvous contract v2', () => {
  it('accepts a finite, ordered arm schedule', () => {
    expect(readRendezvousArmIntent(armIntent())).not.toBeNull();
    expect(readRendezvousArmIntent(armIntent({ playbackRate: Number.NaN }))).toBeNull();
    expect(
      readRendezvousArmIntent(armIntent({ finalizeByRoomTimeMs: 2_001, startAtRoomTimeMs: 2_000 })),
    ).toBeNull();
  });

  it('accepts future data fields and validates hostile envelopes without [[Get]]', () => {
    let accessorCalls = 0;
    const future = armIntent() as RendezvousArmIntent & Record<PropertyKey, unknown>;
    Object.defineProperty(future, 'futureSchemaField', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'ignored';
      },
    });
    expect(readRendezvousArmIntent(future)).not.toBeNull();
    expect(accessorCalls).toBe(0);

    const hostile = armIntent() as RendezvousArmIntent & Record<PropertyKey, unknown>;
    Object.defineProperty(hostile, 'runId', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'run-7';
      },
    });
    expect(readRendezvousArmIntent(hostile)).toBeNull();
    expect(accessorCalls).toBe(0);

    let getCalls = 0;
    let nestedResult = false;
    let reentered = false;
    const proxied = new Proxy(armIntent(), {
      get() {
        getCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
      getOwnPropertyDescriptor(target, property) {
        if (!reentered) {
          reentered = true;
          nestedResult = readRendezvousArmIntent(armIntent({ runId: 'nested-run' })) !== null;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(readRendezvousArmIntent(proxied)).not.toBeNull();
    expect(nestedResult).toBe(true);
    expect(getCalls).toBe(0);
  });

  it('accepts an on-time armed receipt with exact identity and revision', () => {
    expect(validateRendezvousArmReceipt(armIntent(), armReceipt())).toEqual({ ok: true });
  });

  it.each([
    ['identity-mismatch', { runId: 'other-run' }],
    ['revision-mismatch', { revision: 8 }],
    ['rendezvous-mismatch', { rendezvousId: 'other-rv' }],
    ['participant-mismatch', { participantId: 'peer-2' }],
  ] as const)('rejects arm receipt %s', (code, overrides) => {
    expect(validateRendezvousArmReceipt(armIntent(), armReceipt(overrides))).toEqual({
      ok: false,
      code,
    });
  });

  it('rejects an explicit arm failure and a receipt after the finalization deadline', () => {
    expect(
      validateRendezvousArmReceipt(
        armIntent(),
        armReceipt({ status: 'rejected', reasonCode: 'buffer-underrun' }),
      ),
    ).toEqual({ ok: false, code: 'arm-rejected' });
    expect(
      validateRendezvousArmReceipt(armIntent(), armReceipt({ observedAtRoomTimeMs: 1_901 })),
    ).toEqual({ ok: false, code: 'arm-after-deadline' });
  });

  it('validates a final commit only while the original deadline remains open', () => {
    expect(
      validateRendezvousFinalization(armIntent(), armReceipt(), finalizeIntent(), 1_890),
    ).toEqual({ ok: true });
    expect(
      validateRendezvousFinalization(
        armIntent(),
        armReceipt(),
        finalizeIntent({ finalizedAtRoomTimeMs: 1_901 }),
        1_890,
      ),
    ).toEqual({ ok: false, code: 'finalization-after-deadline' });
    expect(
      validateRendezvousFinalization(armIntent(), armReceipt(), finalizeIntent(), 1_901),
    ).toEqual({ ok: false, code: 'finalization-after-deadline' });
  });

  it('rejects a final commit that silently changes the armed start time', () => {
    expect(
      validateRendezvousFinalization(
        armIntent(),
        armReceipt(),
        finalizeIntent({ startAtRoomTimeMs: 2_010 }),
        1_890,
      ),
    ).toEqual({ ok: false, code: 'schedule-mismatch' });
  });

  it('validates the participant final receipt against the committed rendezvous', () => {
    expect(validateRendezvousFinalizeReceipt(finalizeIntent(), finalizeReceipt())).toEqual({
      ok: true,
    });
    expect(
      validateRendezvousFinalizeReceipt(
        finalizeIntent(),
        finalizeReceipt({ status: 'missed-deadline', reasonCode: 'late-message' }),
      ),
    ).toEqual({ ok: false, code: 'finalization-rejected' });
    expect(
      validateRendezvousFinalizeReceipt(
        finalizeIntent(),
        finalizeReceipt({ participantId: 'peer-2' }),
      ),
    ).toEqual({ ok: false, code: 'participant-mismatch' });
    expect(
      validateRendezvousFinalizeReceipt(
        finalizeIntent(),
        finalizeReceipt({ observedAtRoomTimeMs: 2_001 }),
      ),
    ).toEqual({ ok: false, code: 'finalization-after-deadline' });
    expect(
      validateRendezvousFinalizeReceipt(
        finalizeIntent({ finalizedAtRoomTimeMs: 2_001 }),
        finalizeReceipt(),
      ),
    ).toEqual({ ok: false, code: 'invalid-contract' });
  });

  it('treats the finalization deadline as inclusive and rejects invalid clock values', () => {
    expect(isRendezvousFinalizationOpen(armIntent(), 1_900)).toBe(true);
    expect(isRendezvousFinalizationOpen(armIntent(), 1_900.001)).toBe(false);
    expect(isRendezvousFinalizationOpen(armIntent(), Number.NaN)).toBe(false);
  });
});
