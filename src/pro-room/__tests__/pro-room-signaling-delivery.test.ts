import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activatedProRoom,
  installBoundaryClock,
  type ProRoomBoundary,
  type SignalingDelivery,
  youtubeItem,
} from './__helpers__/pro-room-owner-boundary.ts';
import {
  cancelRecord51ab2be3,
  commitRecord51ab2be3,
  OUTBOX_ATTEMPT_CAP_51AB2BE3,
  prepareRecord51ab2be3,
  presenceMarker51ab2be3,
} from './__helpers__/pro-room-outbox-records-51ab2be3.ts';

/**
 * C7-0 characterization of the PRO room's signaling delivery lanes (resource
 * RO-07 in docs/design/resource-ownership-registry.md): the presence snapshot
 * retry, the durable playback outbox and the no-retry invalidation lane, and
 * the coordinator-epoch fence that orders them. These tests pin behaviour on
 * unchanged main so the Phase 1 outbox owner (plan steps C7-1, C7-3, C7-4)
 * can prove it is neutral. Known gaps are pinned with a comment naming the
 * registry exception or plan step that may change them; none is asserted as
 * desired behaviour.
 *
 * Observation points: requests the room sends to signaling (FencedSignaling,
 * see the fixture header for what it models), the durable `pro-room:v2:core`
 * record (`pendingPresenceBroadcast`, `pendingPlaybackBroadcasts`, whose
 * shapes are a frozen rollback contract, pinned key by key in "durable record
 * shapes"), the platform alarm slot, and
 * whether an HTTP response waits for a held signaling answer (the awaited
 * versus background execution mode of each no-retry send).
 *
 * The playback outbox is flushed by every default persist, not only by the
 * alarm: the cases below pin the alarm order with nothing else dirty, with a
 * dirty prune (deadline COMMIT) and with an unflushed heartbeat. Swapping the
 * alarm's presence retry and playback flush fails three cases here (mutation
 * check on c08b6c39).
 *
 * Triggers and their execution modes (plan step C7-4 keeps every one):
 * - presence: every presence change goes through scheduleServerEvent, which
 *   hands deliverPresenceBroadcast (three immediate tries, then the durable
 *   marker) to waitUntil, so the request answers first; without a signaling
 *   binding it sends once and leaves no marker. The alarm retries a due
 *   marker and awaits it.
 * - playback: scheduleServerEvent and the playback reducers only enqueue.
 *   Every persist that does not pass flushPlaybackOutbox: false then awaits
 *   the head's dispatch, so the request that persisted waits for it: command
 *   and request persists, prune (also in the alarm), the heartbeat flush, the
 *   presence marker's write and clear, and the alarm's presence retry. The
 *   alarm's own flush runs after its presence retry.
 * - no-retry lane: twelve sites await broadcastServerEvent after persist
 *   (registry RO-07 lists them); scheduleServerEvent sends the rest through
 *   waitUntil. Both modes are pinned below with one site each.
 * - epoch hook: bumpRoomEpoch empties the outbox in the same persist (room
 *   sleep and PIN rotation pinned here).
 * - due time and caps: the alarm takes the earlier of the marker and the
 *   outbox head (never a record behind the head); the outbox holds at most two
 *   records; attempts stop at 16 in both lanes and on load.
 */

const NOW = Date.UTC(2026, 9, 22, 4, 0, 0);
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const fixtures: ProRoomBoundary[] = [];

async function room(options: Parameters<typeof activatedProRoom>[0] = {}) {
  const fixture = await activatedProRoom(options);
  fixtures.push(fixture);
  return fixture;
}

/** One line per signaling request: offset from NOW, event type, epoch, answer. */
function trace(deliveries: readonly SignalingDelivery[]): string[] {
  return deliveries.map(
    (delivery) =>
      `${delivery.at - NOW} ${delivery.type.replace(/^pro-/, '')} e${delivery.coordinatorEpoch} ${delivery.status}`,
  );
}

function outbox(test: ProRoomBoundary) {
  return (test.storedCore().pendingPlaybackBroadcasts as Array<Record<string, any>>).map(
    (record) => ({
      kind: record.kind,
      attempts: record.attempts,
      retryInMs: record.retryAtMs - Date.now(),
    }),
  );
}

function presenceMarker(test: ProRoomBoundary) {
  const marker = test.storedCore().pendingPresenceBroadcast as Record<string, any> | null;
  return marker && { attempts: marker.attempts, retryInMs: marker.retryAtMs - Date.now() };
}

/** Whether `promise` has settled after the pending I/O turns have run. */
async function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return done;
}

/**
 * Copies of every `pro-room:v2:core` record the room writes from now on. The
 * flush also drops an older epoch's record before sending it, so only the
 * writes show whether the epoch hook emptied the outbox in the epoch change's
 * own persist.
 */
function coreWrites(test: ProRoomBoundary): Array<Record<string, any>> {
  const cores: Array<Record<string, any>> = [];
  const put = test.storage.put.bind(test.storage);
  vi.spyOn(test.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'pro-room:v2:core') cores.push(structuredClone((value as any).core));
    return put(key, value);
  });
  return cores;
}

/** Stored playback records of an epoch older than the stored presence. */
function staleOutboxWrites(cores: Array<Record<string, any>>) {
  return cores.flatMap((core) =>
    (core.pendingPlaybackBroadcasts as Array<Record<string, any>>)
      .filter((record) => record.coordinatorEpoch !== core.presence.coordinatorEpoch)
      .map((record) => `${record.kind} e${record.coordinatorEpoch}`),
  );
}

async function pause(test: ProRoomBoundary) {
  const current = await test.snapshot();
  const paused = await test.json('/playback/commands', {
    type: 'pause',
    baseRevision: current.playback.revision,
  });
  expect(paused.status, await paused.clone().text()).toBe(200);
  await test.settle();
}

/** A playing room with an owner and one listener; every delivery so far succeeded. */
async function playingRoom() {
  const test = await room({ presenceTtlSeconds: 300 });
  const member = await test.addMember();
  await test.replacePlaylist([
    youtubeItem(FIRST, 'dQw4w9WgXcQ'),
    youtubeItem(SECOND, '9bZkp7q19f0'),
  ]);
  await test.ready(await test.select(FIRST));
  expect(test.storedCore().playback).toMatchObject({ state: 'playing', queueItemId: FIRST });
  expect(outbox(test)).toEqual([]);
  test.signaling.deliveries.length = 0;
  return { test, member };
}

beforeEach(() => {
  installBoundaryClock(NOW);
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    // Signaling answers 400 to any body whose key set differs from its
    // contract (hasExactKeys); no lane may ever send such a body.
    expect(fixture.signaling.deliveries.filter((delivery) => delivery.status === 400)).toEqual([]);
    fixture.dispose();
  }
  vi.useRealTimers();
});

describe('PRO signaling delivery lanes: acceptance', () => {
  it('counts a partial presence fan-out as delivered but retries a partial playback fan-out', async () => {
    const { test } = await playingRoom();

    // Presence accepts any HTTP 200 JSON answer, even sent < eligible.
    test.signaling.failNext('pro-presence-snapshot', 'partial');
    await test.addMember();
    expect(trace(test.signaling.deliveries)).toEqual(['0 presence-snapshot e1 200']);
    expect(presenceMarker(test)).toBeNull();

    // Playback requires sent === eligible; a partial fan-out keeps the record.
    test.signaling.failNext('pro-playback-prepare', 'partial');
    await test.select(SECOND);
    expect(trace(test.signaling.deliveries).slice(1)).toEqual(['0 playback-prepare e1 200']);
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 1, retryInMs: 1_000 }]);
    await test.alarmAt(NOW + 1_000);
    expect(trace(test.signaling.deliveries).slice(2)).toEqual(['1000 playback-prepare e1 200']);
    expect(outbox(test)).toEqual([]);
  });
});

describe('PRO signaling delivery lanes: triggers and execution modes', () => {
  it('sends a presence snapshot in the background: the request answers while it is in flight', async () => {
    const { test, member } = await playingRoom();
    const held = test.signaling.hold('pro-presence-snapshot');
    const response = test.request('/presence/current', { method: 'DELETE' }, member);
    await held.reached;
    expect(await settled(response)).toBe(true);
    expect((await response).status).toBe(200);
    test.forget(member);
    held.release();
    await test.settle();
    expect(trace(test.signaling.deliveries)).toEqual(['0 presence-snapshot e1 200']);
  });

  it('holds a request until the playback dispatch its persist started has answered', async () => {
    const { test } = await playingRoom();
    const held = test.signaling.hold('pro-playback-prepare');
    const current = await test.snapshot();
    const response = test.json('/playback/commands', {
      type: 'select',
      baseRevision: current.playback.revision,
      queueItemId: SECOND,
      state: 'playing',
      positionSeconds: 0,
    });
    await held.reached;
    // The command's persist awaits the outbox flush before it returns.
    expect(await settled(response)).toBe(false);
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 0, retryInMs: 0 }]);
    held.release();
    expect((await response).status).toBe(202);
    await test.settle();
    expect(trace(test.signaling.deliveries)).toEqual(['0 playback-prepare e1 200']);
    expect(outbox(test)).toEqual([]);
  });

  it('holds a queue-mode change until its one invalidation send has answered', async () => {
    const { test } = await playingRoom();
    const held = test.signaling.hold('pro-room-invalidated');
    const current = await test.snapshot();
    const response = test.json(
      '/queue-mode',
      {
        coordinatorEpoch: current.presence.coordinatorEpoch,
        baseRevision: current.queueModeRevision,
        playlistRevision: current.playlistRevision,
        repeatMode: 1,
        shuffleEnabled: false,
        shuffleOrder: [],
      },
      test.ownerCookie,
      'PUT',
      false,
    );
    await held.reached;
    // handleUpdateQueueMode awaits broadcastServerEvent after its persist.
    expect(await settled(response)).toBe(false);
    held.release();
    expect((await response).status).toBe(200);
    await test.settle();
    expect(trace(test.signaling.deliveries)).toEqual(['0 room-invalidated e1 200']);
  });

  it('sends presence once and keeps no retry marker when the signaling binding is missing', async () => {
    const test = await room({ presenceTtlSeconds: 300 });
    test.detachSignaling();
    test.signaling.deliveries.length = 0;
    await test.addMember();
    // scheduleServerEvent skips the presence retry path without a binding.
    expect(test.signaling.deliveries).toEqual([]);
    expect(presenceMarker(test)).toBeNull();
    await test.alarmAt(NOW + 5_000);
    expect(presenceMarker(test)).toBeNull();
  });
});

describe('PRO signaling delivery lanes: due time and caps', () => {
  it('wakes the alarm at the earlier of the presence marker and the outbox head', async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    await test.addMember();
    expect(presenceMarker(test)).toEqual({ attempts: 0, retryInMs: 1_000 });
    await test.advanceTo(NOW + 400);
    test.signaling.failNext('pro-playback-prepare', 503);
    await test.select(SECOND);
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 1, retryInMs: 1_000 }]);
    // Marker due at 1000, head at 1400, rendezvous deadline at 3400.
    expect(test.storage.alarm).toBe(NOW + 1_000);

    await test.alarmAt(NOW + 1_000);
    expect(presenceMarker(test)).toEqual({ attempts: 1, retryInMs: 2_000 });
    expect(test.storage.alarm).toBe(NOW + 1_400);
    await test.alarmAt(NOW + 1_400);
    expect(trace(test.signaling.deliveries).slice(-1)).toEqual(['1400 playback-prepare e1 200']);
    expect(test.storage.alarm).toBe(NOW + 3_000);
  });

  it('takes the outbox head as its due time, never a due record queued behind it', async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-playback-prepare', 503);
    test.signaling.failAll('pro-playback-cancel', 503);
    await test.select(SECOND);
    // Pausing over the undelivered PREPARE queues CANCEL then COMMIT. The flush
    // stops at the failing CANCEL; the COMMIT behind it is due but waits.
    await pause(test);
    expect(outbox(test)).toEqual([
      { kind: 'cancel', attempts: 1, retryInMs: 1_000 },
      { kind: 'commit', attempts: 0, retryInMs: 0 },
    ]);
    expect(test.storage.alarm).toBe(NOW + 1_000);
    test.signaling.restore();
    await test.alarmAt(NOW + 1_000);
    expect(trace(test.signaling.deliveries).slice(-2)).toEqual([
      '1000 playback-cancel e1 200',
      '1000 playback-commit e1 200',
    ]);
    expect(outbox(test)).toEqual([]);
  });

  it('keeps at most two playback records, each one a base and its successor', async () => {
    const { test } = await playingRoom();
    for (const kind of ['prepare', 'cancel', 'commit'])
      test.signaling.failAll(`pro-playback-${kind}`, 503);
    const kinds = () =>
      (test.storedCore().pendingPlaybackBroadcasts as Array<Record<string, any>>).map(
        (record) => record.kind,
      );
    await test.select(SECOND);
    expect(kinds()).toEqual(['prepare']);
    await pause(test);
    expect(kinds()).toEqual(['cancel', 'commit']);
    // A new PREPARE keeps only the undelivered COMMIT it is based on.
    await test.select(FIRST);
    expect(kinds()).toEqual(['commit', 'prepare']);
    // A newer COMMIT supersedes both, keeping only its own CANCEL ahead of it.
    await pause(test);
    expect(kinds()).toEqual(['cancel', 'commit']);
    expect(outbox(test).map((record) => record.attempts)).toEqual([1, 0]);
  });
});

describe('PRO signaling delivery lanes: backoff tables', () => {
  it('backs presence off 1 s·2^attempts after three immediate tries, capped at 60 s and 16 attempts', async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    await test.addMember();
    // Three immediate tries, then a durable marker due in 1 s.
    expect(trace(test.signaling.deliveries)).toEqual([
      '0 presence-snapshot e1 thrown',
      '0 presence-snapshot e1 thrown',
      '0 presence-snapshot e1 thrown',
    ]);
    // Devices keep heartbeating every 15 s; only the alarm retries presence.
    const table = [presenceMarker(test)];
    for (let retry = 0; retry < 18; retry += 1) {
      await test.runUntil(Date.now() + table.at(-1)!.retryInMs);
      table.push(presenceMarker(test));
    }
    expect(table).toEqual([
      { attempts: 0, retryInMs: 1_000 },
      { attempts: 1, retryInMs: 2_000 },
      { attempts: 2, retryInMs: 4_000 },
      { attempts: 3, retryInMs: 8_000 },
      { attempts: 4, retryInMs: 16_000 },
      { attempts: 5, retryInMs: 32_000 },
      ...Array.from({ length: 10 }, (_, index) => ({ attempts: 6 + index, retryInMs: 60_000 })),
      { attempts: 16, retryInMs: 60_000 },
      { attempts: 16, retryInMs: 60_000 },
      { attempts: 16, retryInMs: 60_000 },
    ]);
    // One request per alarm retry: the marker is the only presence retry path.
    expect(test.signaling.deliveries).toHaveLength(3 + 18);
  });

  it('backs a playback record off 1 s·2^(attempts-1), capped at 60 s and 16 attempts', async () => {
    const { test } = await playingRoom();
    // Pausing commits directly; the COMMIT is the outbox head that retries.
    test.signaling.failAll('pro-playback-commit', 503);
    const current = await test.snapshot();
    const paused = await test.json('/playback/commands', {
      type: 'pause',
      baseRevision: current.playback.revision,
    });
    expect(paused.status, await paused.clone().text()).toBe(200);
    await test.settle();
    // The due head is retried by the alarm, or by any persist that reaches it
    // first (a heartbeat flush); the backoff is the same either way.
    const table = [outbox(test)[0]];
    for (let retry = 0; retry < 18; retry += 1) {
      await test.runUntil(Date.now() + table.at(-1)!.retryInMs);
      table.push(outbox(test)[0]);
    }
    expect(table).toEqual([
      { kind: 'commit', attempts: 1, retryInMs: 1_000 },
      { kind: 'commit', attempts: 2, retryInMs: 2_000 },
      { kind: 'commit', attempts: 3, retryInMs: 4_000 },
      { kind: 'commit', attempts: 4, retryInMs: 8_000 },
      { kind: 'commit', attempts: 5, retryInMs: 16_000 },
      { kind: 'commit', attempts: 6, retryInMs: 32_000 },
      ...Array.from({ length: 10 }, (_, index) => ({
        kind: 'commit',
        attempts: 7 + index,
        retryInMs: 60_000,
      })),
      { kind: 'commit', attempts: 16, retryInMs: 60_000 },
      { kind: 'commit', attempts: 16, retryInMs: 60_000 },
      { kind: 'commit', attempts: 16, retryInMs: 60_000 },
    ]);
    expect(test.signaling.types().filter((type) => type === 'pro-playback-commit')).toHaveLength(
      19,
    );
  });
});

describe('PRO signaling delivery lanes: ordering', () => {
  it('sends a due presence marker before a due playback head when the alarm finds nothing else to persist', async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    await test.addMember();
    test.signaling.restore();
    test.signaling.failNext('pro-playback-prepare', 503);
    await test.select(SECOND);
    expect(presenceMarker(test)).toEqual({ attempts: 0, retryInMs: 1_000 });
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 1, retryInMs: 1_000 }]);
    test.signaling.deliveries.length = 0;

    await test.alarmAt(NOW + 1_000);
    // The presence retry persists with the default outbox flush, so the head
    // is dispatched inside that persist, after the snapshot.
    expect(trace(test.signaling.deliveries)).toEqual([
      '1000 presence-snapshot e1 200',
      '1000 playback-prepare e1 200',
    ]);
    expect(presenceMarker(test)).toBeNull();
    expect(outbox(test)).toEqual([]);
  });

  it('flushes playback before the presence retry when the alarm prune persists first', async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    await test.addMember();
    test.signaling.restore();
    const transition = await test.select(SECOND);
    expect(trace(test.signaling.deliveries).at(-1)).toBe('0 playback-prepare e1 200');
    test.signaling.deliveries.length = 0;

    // Nobody reports READY. At the 3 s rendezvous deadline the alarm's prune
    // commits the transition and persists (default flush) before it retries
    // the overdue presence marker. Plan step C7-4 keeps this order; a single
    // drain owner must list prune as one of its flush triggers.
    await test.alarmAt(NOW + 3_000);
    expect(trace(test.signaling.deliveries)).toEqual([
      '3000 playback-commit e1 200',
      '3000 presence-snapshot e1 200',
    ]);
    expect(test.signaling.deliveries[0]!.transitionId).toBe(transition.transitionId);
    expect(test.storedCore().playback).toMatchObject({ state: 'playing', queueItemId: SECOND });
  });

  it('flushes playback before the presence retry when the alarm finds an unflushed heartbeat', async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    await test.addMember();
    test.signaling.restore();
    test.signaling.failNext('pro-playback-prepare', 503);
    await test.select(SECOND);
    expect(presenceMarker(test)).toEqual({ attempts: 0, retryInMs: 1_000 });
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 1, retryInMs: 1_000 }]);

    // Both devices heartbeat 500 ms before the retries are due. The second
    // heartbeat lands inside the 1 s coalescing window, so its durability
    // flush waits for a timer due 500 ms after the alarm.
    await test.advanceTo(NOW + 500);
    await test.heartbeat();
    test.signaling.deliveries.length = 0;

    // The alarm's heartbeat-durability persist flushes the due head first;
    // only then does the presence retry run. A single drain owner (C7-4)
    // must count this persist as a flush trigger too.
    await test.alarmAt(NOW + 1_000);
    expect(trace(test.signaling.deliveries)).toEqual([
      '1000 playback-prepare e1 200',
      '1000 presence-snapshot e1 200',
    ]);
    expect(presenceMarker(test)).toBeNull();
    expect(outbox(test)).toEqual([]);
  });

  it('does not hold the persist-time flush for an undelivered presence snapshot of a new epoch', async () => {
    const { test, member } = await playingRoom();
    await test.leave(member);
    await test.leave(test.ownerCookie);
    expect(test.storedCore().runtime).toBe('sleeping');
    expect(trace(test.signaling.deliveries).at(-1)).toBe('0 presence-snapshot e2 200');
    test.signaling.deliveries.length = 0;

    // Waking a playing room bumps the epoch to 3 and queues a PREPARE. The
    // snapshot goes out in the background while the persist flush dispatches
    // the PREPARE, which signaling refuses: only a presence snapshot may
    // advance its epoch fence (handleInternalProRealtimeBroadcast).
    await test.advanceTo(NOW + 10_000);
    test.signaling.failNext('pro-presence-snapshot', 'throw', 3);
    await test.enter(test.ownerCookie);
    expect(trace(test.signaling.deliveries)).toEqual([
      '10000 presence-snapshot e3 thrown',
      '10000 playback-prepare e3 409',
      '10000 presence-snapshot e3 thrown',
      '10000 presence-snapshot e3 thrown',
    ]);
    expect(test.signaling.deliveries[1]!.error).toBe('PRO_ROOM_EPOCH_STALE');
    expect(presenceMarker(test)).toEqual({ attempts: 0, retryInMs: 1_000 });
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 1, retryInMs: 1_000 }]);
    expect(test.storage.alarm).toBe(NOW + 11_000);

    // One ordering miss costs the PREPARE its own 1 s backoff: the alarm
    // delivers the snapshot (advancing the fence), and the presence persist
    // then flushes the now-due head.
    await test.alarmAt(NOW + 11_000);
    expect(trace(test.signaling.deliveries).slice(4)).toEqual([
      '11000 presence-snapshot e3 200',
      '11000 playback-prepare e3 200',
    ]);
    expect(outbox(test)).toEqual([]);
  });

  it('keeps a backing-off playback head waiting after another path delivers the new epoch (RO-31)', async () => {
    const { test, member } = await playingRoom();
    await test.leave(member);
    await test.leave(test.ownerCookie);
    await test.advanceTo(NOW + 10_000);
    test.signaling.failNext('pro-presence-snapshot', 'throw', 3);
    await test.enter(test.ownerCookie);
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 1, retryInMs: 1_000 }]);
    test.signaling.deliveries.length = 0;

    // A listener returns 500 ms later. Its join snapshot (epoch 3) is
    // delivered at once and clears the older marker, so signaling now accepts
    // epoch 3, yet the PREPARE stays parked until its own retry time.
    // Known gap kept on purpose: registry exception RO-31 (plan step C7-5
    // dropped); revisit only if production logs show EPOCH_STALE retries.
    await test.advanceTo(NOW + 10_500);
    await test.enter(member);
    expect(trace(test.signaling.deliveries)).toEqual(['10500 presence-snapshot e3 200']);
    expect(presenceMarker(test)).toBeNull();
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 1, retryInMs: 500 }]);
    expect(test.storage.alarm).toBe(NOW + 11_000);

    await test.alarmAt(NOW + 11_000);
    expect(trace(test.signaling.deliveries).slice(1)).toEqual(['11000 playback-prepare e3 200']);
  });

  it('never lets a PREPARE wait out a long backoff: the 3 s deadline replaces it with a due COMMIT', async () => {
    const { test, member } = await playingRoom();
    await test.leave(member);
    await test.leave(test.ownerCookie);
    await test.advanceTo(NOW + 10_000);
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    await test.enter(test.ownerCookie);
    await test.alarmAt(NOW + 11_000);
    expect(outbox(test)).toEqual([{ kind: 'prepare', attempts: 2, retryInMs: 2_000 }]);
    expect(presenceMarker(test)).toEqual({ attempts: 1, retryInMs: 2_000 });
    test.signaling.restore();
    test.signaling.deliveries.length = 0;

    // Rendezvous deadline: prune commits and the COMMIT replaces the PREPARE
    // head with a fresh record due now. Its flush still precedes the presence
    // retry, so it misses once more and waits 1 s.
    await test.alarmAt(NOW + 13_000);
    expect(trace(test.signaling.deliveries)).toEqual([
      '13000 playback-commit e3 409',
      '13000 presence-snapshot e3 200',
    ]);
    expect(outbox(test)).toEqual([{ kind: 'commit', attempts: 1, retryInMs: 1_000 }]);
    await test.alarmAt(NOW + 14_000);
    expect(trace(test.signaling.deliveries).slice(2)).toEqual(['14000 playback-commit e3 200']);
    expect(outbox(test)).toEqual([]);
  });
});

/**
 * Today's durable record shapes. The loaders accept only these exact key sets
 * (hasExactKeys in normalizeLoadedSignalingOutbox, which C7-4 merged from
 * normalizeLoadedPresenceBroadcast, and in normalizeStoredPlaybackBroadcastRecord):
 * a record with any other key set is nulled or dropped on load. A Worker
 * rolled back across a shape change would therefore silently lose the
 * presence retry and the PREPARE/CANCEL/COMMIT records written by the newer
 * one. Plan step C7-4 (and any Phase 1 outbox owner) must keep these lists,
 * or add a versioned shape on purpose.
 */
const PRESENCE_MARKER_KEYS = [
  'attempts',
  'coordinatorEpoch',
  'presenceRevision',
  'retryAtMs',
  'roomRevision',
];
const PLAYBACK_RECORD_KEYS = [
  'attempts',
  'basePlaybackRevision',
  'coordinatorEpoch',
  'createdAtMs',
  'event',
  'kind',
  'playbackRevision',
  'retryAtMs',
  'targets',
  'transitionId',
];
const PLAYBACK_EVENT_KEYS: Record<string, string[]> = {
  prepare: [
    'basePlaybackRevision',
    'deadlineAtMs',
    'serverTimeMs',
    'target',
    'transitionId',
    'type',
  ],
  cancel: ['reason', 'serverTimeMs', 'transitionId', 'type'],
  commit: ['executeAtMs', 'playback', 'serverTimeMs', 'transitionId', 'type'],
};

const sortedKeys = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();

/** A copy of the stored `pro-room:v2:core` envelope, for rewriting records. */
function storedEnvelope(test: ProRoomBoundary) {
  return structuredClone(test.storage.data.get('pro-room:v2:core')) as {
    core: Record<string, any>;
  };
}

describe('PRO signaling delivery lanes: durable record shapes (rollback contract)', () => {
  it("stores the presence marker and every playback record kind with exactly today's keys", async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    test.signaling.failAll('pro-playback-prepare', 503);
    test.signaling.failAll('pro-playback-cancel', 503);
    test.signaling.failAll('pro-playback-commit', 503);
    await test.addMember();
    expect(sortedKeys(test.storedCore().pendingPresenceBroadcast)).toEqual(PRESENCE_MARKER_KEYS);

    await test.select(SECOND);
    const [prepare] = test.storedCore().pendingPlaybackBroadcasts as Array<Record<string, any>>;
    expect(prepare!.kind).toBe('prepare');
    expect(sortedKeys(prepare)).toEqual(PLAYBACK_RECORD_KEYS);
    expect(sortedKeys(prepare!.event)).toEqual(PLAYBACK_EVENT_KEYS.prepare);

    // Pausing over the undelivered PREPARE queues the CANCEL then COMMIT pair.
    const current = await test.snapshot();
    const paused = await test.json('/playback/commands', {
      type: 'pause',
      baseRevision: current.playback.revision,
    });
    expect(paused.status, await paused.clone().text()).toBe(200);
    await test.settle();
    const pair = test.storedCore().pendingPlaybackBroadcasts as Array<Record<string, any>>;
    expect(pair.map((record) => record.kind)).toEqual(['cancel', 'commit']);
    for (const record of pair) {
      expect(sortedKeys(record)).toEqual(PLAYBACK_RECORD_KEYS);
      expect(sortedKeys(record.event)).toEqual(PLAYBACK_EVENT_KEYS[record.kind]);
    }
  });

  it("keeps and delivers a presence marker and PREPARE written in today's literal shape across a cold restart", async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    await test.addMember();
    test.signaling.restore();
    test.signaling.failNext('pro-playback-prepare', 503);
    await test.select(SECOND);

    // The records 51ab2be3 leaves behind, spelled out key by key in the frozen
    // fixture. Byte equality with what the Worker under test stored pins the
    // writer (new to old); loading them through a cold restart pins the
    // loaders (old to new).
    const stored = storedEnvelope(test);
    const marker = stored.core.pendingPresenceBroadcast as Record<string, any>;
    const transition = stored.core.pendingPlaybackTransition as Record<string, any>;
    const literalMarker = presenceMarker51ab2be3({
      coordinatorEpoch: 1,
      presenceRevision: marker.presenceRevision,
      roomRevision: marker.roomRevision,
      retryAtMs: NOW + 1_000,
      attempts: 0,
    });
    const literalPrepare = prepareRecord51ab2be3({
      coordinatorEpoch: 1,
      transitionId: transition.transitionId,
      basePlaybackRevision: transition.basePlaybackRevision,
      targets: transition.cohort,
      serverTimeMs: NOW,
      deadlineAtMs: transition.deadlineAtMs,
      target: transition.target,
      createdAtMs: NOW,
      attempts: 1,
      retryAtMs: NOW + 1_000,
    });
    expect(JSON.stringify(marker)).toBe(JSON.stringify(literalMarker));
    expect(JSON.stringify(stored.core.pendingPlaybackBroadcasts)).toBe(
      JSON.stringify([literalPrepare]),
    );
    stored.core.pendingPresenceBroadcast = literalMarker;
    stored.core.pendingPlaybackBroadcasts = [literalPrepare];
    test.storage.data.set('pro-room:v2:core', stored);
    test.signaling.deliveries.length = 0;

    test.restart();
    await test.alarmAt(NOW + 1_000);
    expect(trace(test.signaling.deliveries)).toEqual([
      '1000 presence-snapshot e1 200',
      '1000 playback-prepare e1 200',
    ]);
    expect(test.signaling.deliveries[1]!.transitionId).toBe(transition.transitionId);
    expect(presenceMarker(test)).toBeNull();
    expect(outbox(test)).toEqual([]);
  });

  it('writes and delivers the CANCEL and COMMIT pair in the frozen 51ab2be3 shape, both ways', async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-playback-prepare', 503);
    await test.select(SECOND);
    const transition = storedEnvelope(test).core.pendingPlaybackTransition as Record<string, any>;
    await test.advanceTo(NOW + 200);
    test.signaling.failAll('pro-playback-cancel', 503);
    test.signaling.failAll('pro-playback-commit', 503);
    await pause(test);

    const stored = storedEnvelope(test);
    const [cancel, commit] = stored.core.pendingPlaybackBroadcasts as Array<Record<string, any>>;
    const base = cancel!.basePlaybackRevision as number;
    const literalPair = [
      cancelRecord51ab2be3({
        coordinatorEpoch: 1,
        transitionId: transition.transitionId,
        basePlaybackRevision: base,
        targets: cancel!.targets,
        serverTimeMs: NOW + 200,
        reason: cancel!.event.reason,
        createdAtMs: NOW + 200,
        attempts: 1,
        retryAtMs: NOW + 1_200,
      }),
      commitRecord51ab2be3({
        coordinatorEpoch: 1,
        transitionId: null,
        basePlaybackRevision: base,
        targets: commit!.targets,
        serverTimeMs: NOW + 200,
        executeAtMs: commit!.event.executeAtMs,
        playback: stored.core.playback,
        createdAtMs: NOW + 200,
        attempts: 0,
        retryAtMs: NOW + 200,
      }),
    ];
    // New to old: the pair is byte-identical to what 51ab2be3 writes.
    expect(cancel!.event.reason).toBe('superseded');
    expect(JSON.stringify(stored.core.pendingPlaybackBroadcasts)).toBe(JSON.stringify(literalPair));

    // Old to new: the literal pair survives a cold restart and drains in order.
    stored.core.pendingPlaybackBroadcasts = literalPair;
    test.storage.data.set('pro-room:v2:core', stored);
    test.signaling.restore();
    test.signaling.deliveries.length = 0;
    test.restart();
    await test.alarmAt(NOW + 1_200);
    expect(trace(test.signaling.deliveries)).toEqual([
      '1200 playback-cancel e1 200',
      '1200 playback-commit e1 200',
    ]);
    expect(outbox(test)).toEqual([]);
  });

  it(`keeps records at the old attempt cap (${OUTBOX_ATTEMPT_CAP_51AB2BE3}) and drops any above it on load`, async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-presence-snapshot', 'throw');
    await test.addMember();
    test.signaling.failAll('pro-playback-commit', 503);
    await pause(test);
    const capped = storedEnvelope(test);
    const marker = capped.core.pendingPresenceBroadcast as Record<string, any>;
    const [commit] = capped.core.pendingPlaybackBroadcasts as Array<Record<string, any>>;
    const write = (attempts: number) => {
      const envelope = storedEnvelope(test);
      envelope.core.pendingPresenceBroadcast = presenceMarker51ab2be3({
        coordinatorEpoch: 1,
        presenceRevision: marker.presenceRevision,
        roomRevision: marker.roomRevision,
        retryAtMs: NOW + 1_000,
        attempts,
      });
      envelope.core.pendingPlaybackBroadcasts = [
        commitRecord51ab2be3({
          coordinatorEpoch: 1,
          transitionId: null,
          basePlaybackRevision: commit!.basePlaybackRevision,
          targets: commit!.targets,
          serverTimeMs: commit!.event.serverTimeMs,
          executeAtMs: commit!.event.executeAtMs,
          playback: commit!.event.playback,
          createdAtMs: commit!.createdAtMs,
          attempts,
          retryAtMs: NOW + 1_000,
        }),
      ];
      test.storage.data.set('pro-room:v2:core', envelope);
      test.restart();
    };

    // At the cap both records load, retry and stay at the cap, 60 s apart.
    write(OUTBOX_ATTEMPT_CAP_51AB2BE3);
    await test.alarmAt(NOW + 1_000);
    expect(presenceMarker(test)).toEqual({ attempts: 16, retryInMs: 60_000 });
    expect(outbox(test)).toEqual([{ kind: 'commit', attempts: 16, retryInMs: 60_000 }]);

    // One above it, the loaders drop both: nothing is retried.
    write(OUTBOX_ATTEMPT_CAP_51AB2BE3 + 1);
    test.signaling.deliveries.length = 0;
    await test.alarmAt(NOW + 2_000);
    expect(test.signaling.deliveries).toEqual([]);
    expect(presenceMarker(test)).toBeNull();
    expect(outbox(test)).toEqual([]);
  });
});

describe('PRO signaling delivery lanes: epoch fence and the no-retry lane', () => {
  it('drops a queued playback record of an older epoch when the room sleeps', async () => {
    const { test, member } = await playingRoom();
    test.signaling.failAll('pro-playback-commit', 503);
    const current = await test.snapshot();
    const paused = await test.json('/playback/commands', {
      type: 'pause',
      baseRevision: current.playback.revision,
    });
    expect(paused.status).toBe(200);
    await test.settle();
    expect(outbox(test)).toEqual([{ kind: 'commit', attempts: 1, retryInMs: 1_000 }]);

    // The last device leaves: bumpRoomEpoch empties the outbox in the same
    // persist, and no later alarm or wake sends the epoch-1 COMMIT.
    const writes = coreWrites(test);
    await test.leave(member);
    await test.leave(test.ownerCookie);
    expect(test.storedCore().presence.coordinatorEpoch).toBe(2);
    expect(outbox(test)).toEqual([]);
    expect(staleOutboxWrites(writes)).toEqual([]);
    test.signaling.restore();
    const commitsBefore = test.signaling.types().filter((type) => type === 'pro-playback-commit');
    await test.alarmAt(NOW + 60_000);
    await test.enter(test.ownerCookie);
    expect(test.signaling.types().filter((type) => type === 'pro-playback-commit')).toEqual(
      commitsBefore,
    );
    expect(test.signaling.deliveries.at(-1)).toMatchObject({
      type: 'pro-presence-snapshot',
      coordinatorEpoch: 3,
      status: 200,
    });
  });

  it('drops a queued playback record when a PIN rotation advances the epoch', async () => {
    const { test } = await playingRoom();
    test.signaling.failAll('pro-playback-commit', 503);
    await pause(test);
    expect(outbox(test)).toEqual([{ kind: 'commit', attempts: 1, retryInMs: 1_000 }]);
    test.signaling.deliveries.length = 0;

    // handleChangePin revokes the other members and calls bumpRoomEpoch,
    // which empties the outbox in the same persist; the new epoch's presence
    // snapshot follows in the background.
    const writes = coreWrites(test);
    const rotated = await test.json('/pin', { pin: '24681357' });
    expect(rotated.status, await rotated.clone().text()).toBe(200);
    await test.settle();
    expect(test.storedCore().presence.coordinatorEpoch).toBe(2);
    expect(outbox(test)).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    expect(staleOutboxWrites(writes)).toEqual([]);
    expect(trace(test.signaling.deliveries)).toEqual(['0 presence-snapshot e2 200']);
    test.signaling.restore();
    await test.alarmAt(NOW + 60_000);
    expect(test.signaling.types()).not.toContain('pro-playback-commit');
  });

  it('sends an invalidation once and drops it on failure or an epoch-stale answer (RO-46)', async () => {
    const { test, member } = await playingRoom();
    // handleUpdateQueueMode awaits its one invalidation send after persist.
    const setRepeat = async (repeatMode: number) => {
      const current = await test.snapshot();
      const response = await test.json(
        '/queue-mode',
        {
          coordinatorEpoch: current.presence.coordinatorEpoch,
          baseRevision: current.queueModeRevision,
          playlistRevision: current.playlistRevision,
          repeatMode,
          shuffleEnabled: false,
          shuffleOrder: [],
        },
        test.ownerCookie,
        'PUT',
        false,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      await test.settle();
    };

    // A failed invalidation leaves no record and is never retried.
    test.signaling.failNext('pro-room-invalidated', 503);
    await setRepeat(1);
    expect(trace(test.signaling.deliveries)).toEqual(['0 room-invalidated e1 503']);
    expect(outbox(test)).toEqual([]);
    expect(presenceMarker(test)).toBeNull();
    await test.alarmAt(NOW + 5_000);
    expect(test.signaling.types()).not.toContain('pro-presence-snapshot');
    expect(trace(test.signaling.deliveries)).toEqual(['0 room-invalidated e1 503']);

    // Before the new epoch's snapshot lands, signaling refuses the
    // invalidation as epoch-stale; nothing replays it after the snapshot.
    await test.leave(member);
    await test.leave(test.ownerCookie);
    await test.advanceTo(NOW + 10_000);
    test.signaling.failNext('pro-presence-snapshot', 'throw', 3);
    await test.enter(test.ownerCookie);
    test.signaling.deliveries.length = 0;
    await setRepeat(0);
    expect(trace(test.signaling.deliveries)).toEqual(['10000 room-invalidated e3 409']);
    // Accepted gap: registry exception RO-46 (owner decision); the 15 s
    // heartbeat reconciles state, but an added-tracks notice riding such an
    // event would be lost, not delayed.
    await test.alarmAt(NOW + 11_000);
    expect(trace(test.signaling.deliveries).slice(1)).toEqual([
      '11000 presence-snapshot e3 200',
      '11000 playback-prepare e3 200',
    ]);
  });

  it('sends a playlist addition as an awaited refresh hint, then a background added-tracks notice', async () => {
    const test = await room({ presenceTtlSeconds: 300 });
    await test.replacePlaylist([youtubeItem(FIRST, 'dQw4w9WgXcQ')]);
    test.signaling.deliveries.length = 0;
    const settled = async (promise: Promise<unknown>) => {
      let done = false;
      void promise.then(
        () => (done = true),
        () => (done = true),
      );
      await new Promise((resolve) => setImmediate(resolve));
      return done;
    };
    const items = [youtubeItem(FIRST, 'dQw4w9WgXcQ'), youtubeItem(SECOND, '9bZkp7q19f0')];

    // The plain hint is awaited inside the request (commitParticipantSnapshot),
    // so a slow signaling answer holds the HTTP response.
    const refresh = test.signaling.hold('pro-room-invalidated', (event) => !event.addition);
    const notice = test.signaling.hold('pro-room-invalidated', (event) => !!event.addition);
    const response = test.sendPlaylist(items, [items[1]!]);
    await refresh.reached;
    expect(await settled(response)).toBe(false);
    refresh.release();
    expect((await response).status).toBe(200);

    // The notice (scheduleDeveloperInvalidationHint) goes through waitUntil:
    // it is still in flight after the response. Execution modes stay per site
    // (registry RO-07); the notice gets no retry (RO-46).
    await notice.reached;
    expect(trace(test.signaling.deliveries)).toEqual(['0 room-invalidated e1 200']);
    notice.release();
    await test.settle();
    expect(test.signaling.deliveries.map((delivery) => delivery.addition ?? false)).toEqual([
      false,
      true,
    ]);
  });
});
