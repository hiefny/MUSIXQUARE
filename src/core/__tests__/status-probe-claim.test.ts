import { describe, expect, it, vi } from 'vitest';

import {
  STATUS_PROBE_CLAIM_INTERNAL_PATH,
  type StatusProbeClaimOutcome,
} from '../../../cloudflare/status-contract.ts';
import {
  STATUS_PROBE_CLAIM_REPLY_MAX_BYTES,
  claimStatusProbeRoom,
  classifyStatusProbeClaimReply,
  type StatusProbeClaimReply,
} from '../../../cloudflare/status-probe-claim.ts';
import { serviceMaintenanceResponse } from '../../../cloudflare/service-maintenance.ts';

// A synthetic room code; real room codes never appear in tests.
const ROOM_ID = '482913';

interface FakeId {
  readonly name: string;
}
interface FakeStub {
  readonly id: FakeId;
}

function reply(status: number, value?: unknown, raw?: Uint8Array): StatusProbeClaimReply {
  return {
    response: { status },
    bytes: raw ?? new TextEncoder().encode(value === undefined ? '' : JSON.stringify(value)),
  };
}

async function replyFrom(response: Response): Promise<StatusProbeClaimReply> {
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

function setup(answer: () => Promise<StatusProbeClaimReply | null>) {
  const namespace = {
    idFromName: vi.fn((name: string): FakeId => ({ name })),
    get: vi.fn((id: FakeId): FakeStub => ({ id })),
  };
  const sent: Array<{ stub: FakeStub; request: Request }> = [];
  const fetchBounded = vi.fn(async (stub: FakeStub, request: Request) => {
    sent.push({ stub, request });
    return answer();
  });
  return { namespace, fetchBounded, sent };
}

describe('status probe claim', () => {
  it('posts exactly {v:1, roomId} to the room object of that code', async () => {
    const test = setup(async () => reply(200, { ok: true }));
    await expect(
      claimStatusProbeRoom({
        namespace: test.namespace,
        roomId: ROOM_ID,
        fetchBounded: test.fetchBounded,
      }),
    ).resolves.toBe('claimed');
    expect(test.namespace.idFromName).toHaveBeenCalledExactlyOnceWith(ROOM_ID);
    expect(test.namespace.get).toHaveBeenCalledExactlyOnceWith({ name: ROOM_ID });
    expect(test.sent).toHaveLength(1);
    const { stub, request } = test.sent[0]!;
    expect(stub).toEqual({ id: { name: ROOM_ID } });
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`https://signaling.internal${STATUS_PROBE_CLAIM_INTERNAL_PATH}`);
    expect(request.url).toBe('https://signaling.internal/internal/status-probe/v1/claim');
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(await request.text()).toBe(`{"v":1,"roomId":"${ROOM_ID}"}`);
  });

  it('refuses anything but a Standard room code without calling anything', async () => {
    for (const roomId of ['012345', '12345', '1234567', '12345a', ' 482913', '482913\n', '']) {
      const test = setup(async () => reply(200, { ok: true }));
      await expect(
        claimStatusProbeRoom({
          namespace: test.namespace,
          roomId,
          fetchBounded: test.fetchBounded,
        }),
        JSON.stringify(roomId),
      ).resolves.toBe('failed');
      expect(test.namespace.idFromName).not.toHaveBeenCalled();
      expect(test.namespace.get).not.toHaveBeenCalled();
      expect(test.fetchBounded).not.toHaveBeenCalled();
    }
    const test = setup(async () => reply(200, { ok: true }));
    await expect(
      claimStatusProbeRoom({
        namespace: test.namespace,
        roomId: 482913 as unknown as string,
        fetchBounded: test.fetchBounded,
      }),
    ).resolves.toBe('failed');
    expect(test.fetchBounded).not.toHaveBeenCalled();

    const unbound = vi.fn(async () => reply(200, { ok: true }));
    await expect(
      claimStatusProbeRoom<FakeId, FakeStub>({
        namespace: null,
        roomId: ROOM_ID,
        fetchBounded: unbound,
      }),
    ).resolves.toBe('failed');
    expect(unbound).not.toHaveBeenCalled();
  });

  it('classifies every documented answer and fails everything else', () => {
    const cases: Array<[StatusProbeClaimReply | null, StatusProbeClaimOutcome]> = [
      [reply(200, { ok: true }), 'claimed'],
      [reply(409, { error: 'ROOM_ACTIVE' }), 'room_active'],
      [reply(404, { error: 'NOT_FOUND' }), 'unsupported'],
      [reply(404), 'unsupported'],
      [reply(503, { error: 'SERVICE_MAINTENANCE', maintenance: true }), 'maintenance'],
      [
        reply(503, { error: 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE', maintenance: true }),
        'control_unavailable',
      ],
      [null, 'failed'],
      [reply(200, { ok: false }), 'failed'],
      [reply(200, { ok: 'true' }), 'failed'],
      [reply(200), 'failed'],
      [reply(200, [{ ok: true }]), 'failed'],
      [reply(200, null, new Uint8Array([0x7b, 0xff, 0x7d])), 'failed'],
      [reply(409, { error: 'ROOM_STATE_INVALID' }), 'failed'],
      [reply(400, { error: 'INVALID_REQUEST' }), 'failed'],
      [reply(503, { error: 'STANDARD_HTTP_BRIDGE_UNAVAILABLE' }), 'failed'],
      [reply(503), 'failed'],
      [reply(500, { ok: true }), 'failed'],
      [reply(201, { ok: true }), 'failed'],
    ];
    for (const [answer, outcome] of cases) {
      expect(classifyStatusProbeClaimReply(answer), JSON.stringify(answer?.response)).toBe(outcome);
    }
  });

  it('reads the maintenance answers the room object really sends', async () => {
    const request = new Request(`https://signaling.internal${STATUS_PROBE_CLAIM_INTERNAL_PATH}`, {
      method: 'POST',
    });
    const maintenance = serviceMaintenanceResponse(
      request,
      { enabled: true, revision: 3, activatedAt: 1_700_000_000_000 },
      { format: 'json' },
    );
    const unavailable = serviceMaintenanceResponse(
      request,
      { enabled: true, controlUnavailable: true },
      { format: 'json' },
    );
    expect(maintenance.status).toBe(503);
    const maintenanceReply = await replyFrom(maintenance);
    const unavailableReply = await replyFrom(unavailable);
    expect(classifyStatusProbeClaimReply(maintenanceReply)).toBe('maintenance');
    expect(classifyStatusProbeClaimReply(unavailableReply)).toBe('control_unavailable');
    const notFound = new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    expect(classifyStatusProbeClaimReply(await replyFrom(notFound))).toBe('unsupported');
    // Every documented answer fits the bound the App reads with.
    for (const { bytes } of [maintenanceReply, unavailableReply]) {
      expect(bytes.byteLength).toBeLessThan(STATUS_PROBE_CLAIM_REPLY_MAX_BYTES);
    }
  });

  it('turns a throwing namespace or fetch into failed', async () => {
    const throwingFetch = setup(async () => {
      throw new Error('binding down');
    });
    await expect(
      claimStatusProbeRoom({
        namespace: throwingFetch.namespace,
        roomId: ROOM_ID,
        fetchBounded: throwingFetch.fetchBounded,
      }),
    ).resolves.toBe('failed');

    const noAnswer = setup(async () => null);
    await expect(
      claimStatusProbeRoom({
        namespace: noAnswer.namespace,
        roomId: ROOM_ID,
        fetchBounded: noAnswer.fetchBounded,
      }),
    ).resolves.toBe('failed');

    const throwingNamespace = setup(async () => reply(200, { ok: true }));
    throwingNamespace.namespace.idFromName.mockImplementationOnce(() => {
      throw new Error('bad name');
    });
    await expect(
      claimStatusProbeRoom({
        namespace: throwingNamespace.namespace,
        roomId: ROOM_ID,
        fetchBounded: throwingNamespace.fetchBounded,
      }),
    ).resolves.toBe('failed');
    expect(throwingNamespace.fetchBounded).not.toHaveBeenCalled();

    for (const [answer, outcome] of [
      [reply(409, { error: 'ROOM_ACTIVE' }), 'room_active'],
      [reply(404), 'unsupported'],
      [reply(503, { error: 'SERVICE_MAINTENANCE' }), 'maintenance'],
    ] as const) {
      const test = setup(async () => answer);
      await expect(
        claimStatusProbeRoom({
          namespace: test.namespace,
          roomId: ROOM_ID,
          fetchBounded: test.fetchBounded,
        }),
      ).resolves.toBe(outcome);
    }
  });
});
