/**
 * Standard-room route outages on the real Cloudflare transport (C5-0).
 *
 * Ports the 2026-10-19/20 native labs (docs/design/side-ice-restart-native-lab-2026-10-19.md,
 * side-ice-restart-independent-verification-2026-10-20.md,
 * preload-resume-after-ice-recovery-2026-10-20.md) into Playwright: host and
 * guest pages on one machine, real negotiation through a local signaling
 * Worker, real file input and player buttons, and a CDP outage of the guest
 * page's P2P path while its signaling socket stays up. Each scenario pins what
 * today's main does, so the LinkLiveness lanes (C5-6..C5-9, C5-12) can rerun it.
 */
import { expect, test, type Page } from '@playwright/test';
import { CHUNK_SIZE } from '../../src/core/constants.ts';
import { clickPlayButton, waitForPlaybackProjection } from '../helpers/wait.ts';
import type { FrameRow, ProbeExport, WsRow } from './lab-probe.ts';
import { LabRoom, writeWavFixture, type ConnectionSnapshot, type WavFixture } from './lab-room.ts';

/** I10 of the independent verification: past libwebrtc's disconnected report, short of failed. */
const SHORT_OUTAGE_MS = 10_000;
/**
 * The original route's 15 s grace runs from its own disconnected report (5-7 s
 * into a cut), so an outage held until the side PC fails must end by about 20 s.
 */
const SIDE_FAILED_CAP_MS = 19_000;
const RECOVERY_TIMEOUT_MS = 20_000;
const PRELOAD_COMPLETION_AFTER_RESTORE_MS = 100_000;
/**
 * F4 needs the guest's 15 s preload progress watchdog to fire before the
 * restore (I17 of the independent verification); the original route's grace
 * still ends after it. Before C5-12 two full copies at 1 MB/s took about 80 s;
 * the bound keeps that margin so a regression to two streams still finishes.
 */
const F4_OUTAGE_MS = 17_000;
const F4_COMPLETION_AFTER_RESTORE_MS = 150_000;

const sleep = (page: Page, ms: number) => page.waitForTimeout(Math.max(0, ms));

async function fixtures(outputPath: (name: string) => string) {
  // A: 240 s mono 10 kHz (4,800,044 B); L: 240 s stereo 24 kHz (23,040,044 B), as in the 10-19 labs.
  const a = await writeWavFixture(outputPath('track-a.wav'), 240, 10_000, 1, 440);
  const l = await writeWavFixture(outputPath('track-l.wav'), 240, 24_000, 2, 330);
  return { a, l };
}

/** Host plays a directly transferred track A; the side (isolated control) route is then active. */
async function playDirectTrack(room: LabRoom, a: WavFixture): Promise<string> {
  const qid = await room.addTrack(a);
  await room.guest.page.waitForFunction(
    ({ qid, bytes }) => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      const current = get('files.current');
      return (
        current?.queueItemId === qid &&
        current.blob instanceof Blob &&
        current.blob.size === bytes &&
        get('transfer.state') === 'READY'
      );
    },
    { qid, bytes: a.bytes },
    { timeout: 120_000 },
  );
  room.mark('trackAReady');
  await clickPlayButton(room.host.page);
  await waitForPlaybackProjection(room.host.page, 'PLAYING_AUDIO', 30_000);
  await waitForPlaybackProjection(room.guest.page, 'PLAYING_AUDIO', 30_000);
  room.mark('playing');
  return qid;
}

/** Host adds L as the next track; resolves once the guest holds 30-75 % of it in preload chunks. */
async function preloadUntilTrigger(room: LabRoom, l: WavFixture): Promise<string> {
  const demand = room.mark('preloadDemand');
  const qid = await room.addTrack(l);
  let fraction = 0;
  while (Date.now() < demand + 120_000) {
    fraction = (await room.guestChunkBytes('preload-chunk', qid, demand)) / l.bytes;
    if (fraction >= 0.3) break;
    await sleep(room.host.page, 100);
  }
  room.notes.preloadFractionAtCut = fraction;
  expect(fraction, 'preload progress at the cut').toBeGreaterThanOrEqual(0.3);
  expect(fraction, 'preload progress at the cut').toBeLessThan(0.75);
  return qid;
}

async function both(room: LabRoom) {
  return { host: await room.only(room.host.page), guest: await room.only(room.guest.page) };
}

function expectSideActive(snapshot: ConnectionSnapshot, label: string) {
  expect(
    [snapshot.isolationPhase, snapshot.sidePcState, snapshot.sideChannel],
    `${label} side route`,
  ).toEqual(['active', 'connected', 'open']);
}

function expectOriginalUp(snapshot: ConnectionSnapshot, label: string) {
  expect(
    [snapshot.open, snapshot.pcState, snapshot.bulk, snapshot.control],
    `${label} original route`,
  ).toEqual([true, 'connected', 'open', 'open']);
}

/** Original (and, when present, side) routes back up on both pages. */
async function waitRecovered(room: LabRoom, withSide: boolean): Promise<void> {
  await expect
    .poll(
      async () => {
        const now = await both(room);
        return [now.host, now.guest].every(
          (c) =>
            c.open &&
            c.pcState === 'connected' &&
            c.control === 'open' &&
            (!withSide || (c.isolationPhase === 'active' && c.sidePcState === 'connected')),
        );
      },
      { timeout: RECOVERY_TIMEOUT_MS, intervals: [200] },
    )
    .toBe(true);
  room.mark('recovered');
}

/** No logical close anywhere: same connection objects, no close events or disconnect dialogs. */
function expectSessionKept(
  room: LabRoom,
  probes: { host: ProbeExport; guest: ProbeExport },
  before: { host: ConnectionSnapshot; guest: ConnectionSnapshot },
  after: { host: ConnectionSnapshot; guest: ConnectionSnapshot },
  from: number,
  trackChanged = false,
) {
  const since = <T extends { at: number }>(rows: T[]) => rows.filter((row) => row.at >= from);
  expect(
    since(probes.guest.bus).filter((r) => r.name === 'network:error'),
    'guest network:error',
  ).toEqual([]);
  expect(
    since(probes.host.bus).filter((r) => r.name === 'network:peer-disconnected'),
    'host peer-disconnected',
  ).toEqual([]);
  for (const label of ['host', 'guest'] as const) {
    // A track change stops the old track's media; without one, a stop means a close.
    if (!trackChanged) {
      expect(
        since(probes[label].bus).filter((r) => r.name === 'player:stop-all-media'),
        `${label} stop-all-media`,
      ).toEqual([]);
    }
    expect(
      since(probes[label].dom).filter((r) =>
        r.dialogs.some((text) => /disconnect|reconnect/i.test(text)),
      ),
      `${label} disconnect dialog`,
    ).toEqual([]);
    expect(after[label].connection, `${label} kept its logical connection`).toBe(
      before[label].connection,
    );
    expect(after[label].originalPc, `${label} kept its original PC`).toBe(before[label].originalPc);
    expect(room[label].pageErrors, `${label} page errors`).toEqual([]);
    expect(probes[label].errors, `${label} probe errors`).toEqual([]);
    expect(probes[label].dropped, `${label} probe drops`).toBe(0);
  }
}

/**
 * Signaling stayed up during the cut: a relayed message sent by one page reached
 * the other within 1 s (the M0b check that caught the port-less exemptions).
 */
function relayedDuringCut(
  probes: { host: ProbeExport; guest: ProbeExport },
  cut: number,
  restore: number,
) {
  const matched: { type: string; from: string; delayMs: number }[] = [];
  for (const [from, to] of [
    ['host', 'guest'],
    ['guest', 'host'],
  ] as const) {
    const received = probes[to].ws.filter((r) => r.dir === 'recv' && r.type);
    for (const sent of probes[from].ws) {
      if (sent.dir !== 'send' || !sent.type || sent.at < cut || sent.at > restore - 1_000) continue;
      const hit = received.find(
        (r: WsRow) => r.type === sent.type && r.at >= sent.at && r.at <= sent.at + 1_000,
      );
      if (hit) matched.push({ type: sent.type, from, delayMs: hit.at - sent.at });
    }
  }
  return matched;
}

/**
 * The run is valid evidence: the guest's original PC saw the outage, no P2P
 * frame reached the guest during it (P5 of the 10-19 procedure), and signaling
 * stayed up (the M0b check).
 */
function expectValidOutage(
  room: LabRoom,
  probes: { host: ProbeExport; guest: ProbeExport },
  before: { guest: ConnectionSnapshot },
  cut: number,
  restore: number,
) {
  expect(
    probes.guest.pcEvents.some(
      (e) =>
        e.pc === before.guest.originalPc &&
        e.at > cut &&
        e.at <= restore &&
        e.connectionState !== 'connected',
    ),
    'guest original PC left connected during the cut',
  ).toBe(true);
  const during = probes.guest.frames.filter(
    (f) => f.dir === 'recv' && f.at > cut + 1_000 && f.at <= restore,
  );
  expect(during, 'guest P2P frames received during the cut').toEqual([]);
  const relayed = relayedDuringCut(probes, cut, restore);
  room.notes.relayedDuringCut = relayed;
  expect(relayed.length, 'signaling relayed during the cut').toBeGreaterThan(0);
}

function lines(room: LabRoom, label: 'host' | 'guest', from: number, needle: string) {
  return room[label].console.filter((row) => row.at >= from && row.text.includes(needle));
}

function appFramesAfter(probe: ProbeExport, from: number): FrameRow[] {
  return probe.frames.filter(
    (f) => f.dir === 'recv' && f.at > from && f.type !== null && !f.type.startsWith('mxqr-'),
  );
}

test.describe('Standard room route outage on the Cloudflare transport', () => {
  test('a short original-route outage recovers without closing the session', async ({
    browser,
  }, testInfo) => {
    const room = await LabRoom.open(browser);
    try {
      await sleep(room.host.page, 3_000);
      const before = await both(room);
      for (const label of ['host', 'guest'] as const) {
        expectOriginalUp(before[label], label);
        // No bulk demand yet, so no side PC: the outage hits the original route alone.
        expect(before[label].sidePc, `${label} side PC`).toBeNull();
      }

      const cut = await room.cut();
      await sleep(room.host.page, cut + SHORT_OUTAGE_MS - Date.now());
      const restore = await room.restore();
      await waitRecovered(room, false);
      await sleep(room.host.page, 5_000);
      const after = await both(room);
      const probes = await room.probes();

      expectValidOutage(room, probes, before, cut, restore);
      expectSessionKept(room, probes, before, after, cut);
      expectOriginalUp(after.host, 'host');
      expectOriginalUp(after.guest, 'guest');
      expect(
        appFramesAfter(probes.guest, room.marks.recovered!).length,
        'host to guest after recovery',
      ).toBeGreaterThan(0);
      expect(
        appFramesAfter(probes.host, room.marks.recovered!).length,
        'guest to host after recovery',
      ).toBeGreaterThan(0);
    } finally {
      await room.close(testInfo);
    }
  });

  test('the isolated control route recovers through its ICE restart after its PC fails', async ({
    browser,
  }, testInfo) => {
    const { a } = await fixtures((name) => testInfo.outputPath(name));
    const room = await LabRoom.open(browser);
    try {
      await playDirectTrack(room, a);
      await sleep(room.host.page, 3_000);
      const before = await both(room);
      for (const label of ['host', 'guest'] as const) {
        expectOriginalUp(before[label], label);
        expectSideActive(before[label], label);
      }

      // Hold the outage until either side PC reports failed: only an ICE restart recovers that.
      const cut = await room.cut();
      const sidePcs = [before.host.sidePc, before.guest.sidePc];
      const failedSide = async () => {
        for (const [label, pc] of [
          ['host', before.host.sidePc],
          ['guest', before.guest.sidePc],
        ] as const) {
          const state = await room[label].page.evaluate(
            (pc) =>
              (window as any).__labProbe.pcEvents.some(
                (e: any) => e.pc === pc && e.connectionState === 'failed',
              ),
            pc,
          );
          if (state) return label;
        }
        return null;
      };
      let failedOn: string | null = null;
      while (!failedOn && Date.now() < cut + SIDE_FAILED_CAP_MS) {
        failedOn = await failedSide();
        if (!failedOn) await sleep(room.host.page, 100);
      }
      room.mark('sideFailedSeen');
      const restore = await room.restore();
      room.notes.sideFailedOn = failedOn;
      room.notes.sideFailedAfterMs = room.marks.sideFailedSeen! - cut;
      expect(
        failedOn,
        `a side PC (${sidePcs.join('/')}) reached failed within ${SIDE_FAILED_CAP_MS} ms`,
      ).not.toBeNull();

      await waitRecovered(room, true);
      // Controls over the recovered routes.
      await clickPlayButton(room.host.page);
      await waitForPlaybackProjection(room.guest.page, 'PAUSED', 3_000);
      await clickPlayButton(room.host.page);
      await waitForPlaybackProjection(room.guest.page, 'PLAYING_AUDIO', 3_000);
      await sleep(room.host.page, 3_000);
      const after = await both(room);
      const probes = await room.probes();

      expectValidOutage(room, probes, before, cut, restore);
      expectSessionKept(room, probes, before, after, cut);
      for (const label of ['host', 'guest'] as const) {
        expectOriginalUp(after[label], label);
        expectSideActive(after[label], label);
        expect(after[label].sidePc, `${label} kept its side PC`).toBe(before[label].sidePc);
        expect(
          lines(room, label, cut, 'Isolated control ICE did not recover'),
          `${label} gave up`,
        ).toEqual([]);
      }

      // Release-record #18 evidence: the offerer logs the restart, then a recovery
      // follows (counted over host and guest consoles, as decided for N1).
      const restarting = [
        ...lines(room, 'host', cut, '[Transport] Restarting isolated control ICE ('),
        ...lines(room, 'guest', cut, '[Transport] Restarting isolated control ICE ('),
      ];
      const recovered = [
        ...lines(room, 'host', cut, '[Transport] Isolated control ICE recovered'),
        ...lines(room, 'guest', cut, '[Transport] Isolated control ICE recovered'),
      ];
      room.notes.restartLines = restarting;
      room.notes.recoveredLines = recovered;
      expect(restarting.length, 'restart lines').toBeGreaterThan(0);
      expect(
        restarting.every((row) => /\(\d+\/\d+\)$/.test(row.text)),
        'restart line shape',
      ).toBe(true);
      const firstRestart = Math.min(...restarting.map((row) => row.at));
      expect(
        recovered.some((row) => row.at > firstRestart),
        'recovered after the restart',
      ).toBe(true);

      // Side-restart signaling travels on the original control channel only.
      const offers = [...probes.host.frames, ...probes.guest.frames].filter(
        (f) =>
          f.dir === 'send' && f.type === 'mxqr-control-isolation' && f.kind === 'restart-offer',
      );
      expect(offers.length, 'restart offers').toBeGreaterThan(0);
      expect(new Set(offers.map((f) => f.channel)), 'restart offer channel').toEqual(
        new Set(['musixquare-control']),
      );
    } finally {
      await room.close(testInfo);
    }
  });

  test('an interrupted preload pauses during the outage and resumes after ICE recovery', async ({
    browser,
  }, testInfo) => {
    const { a, l } = await fixtures((name) => testInfo.outputPath(name));
    const room = await LabRoom.open(browser);
    try {
      await playDirectTrack(room, a);
      const qidL = await preloadUntilTrigger(room, l);
      const before = await both(room);
      for (const label of ['host', 'guest'] as const) expectSideActive(before[label], label);

      const cut = await room.cut();
      await sleep(room.host.page, cut + SHORT_OUTAGE_MS - Date.now());
      const restore = await room.restore();
      await waitRecovered(room, true);

      await room.guest.page.waitForFunction(
        ({ qid, bytes }) => {
          const ready = (window as any).__MUSIXQUARE_GET_STATE__('preload.ready');
          return (
            ready?.queueItemId === qid && ready.blob instanceof Blob && ready.blob.size === bytes
          );
        },
        { qid: qidL, bytes: l.bytes },
        { timeout: restore + PRELOAD_COMPLETION_AFTER_RESTORE_MS - Date.now() },
      );
      room.mark('preloadComplete');
      const blob = await room.guestBlob('preload');
      await clickPlayButton(room.host.page);
      await waitForPlaybackProjection(room.guest.page, 'PAUSED', 3_000);
      await clickPlayButton(room.host.page);
      await waitForPlaybackProjection(room.guest.page, 'PLAYING_AUDIO', 3_000);
      const after = await both(room);
      const probes = await room.probes();

      expectValidOutage(room, probes, before, cut, restore);
      expectSessionKept(room, probes, before, after, cut);
      expect(blob, 'guest preload Blob').toEqual({
        queueItemId: qidL,
        bytes: l.bytes,
        sha256: l.sha256,
      });

      // Release-record preload evidence, host console, with the guest's PeerID.
      const guestPeer = before.host.peerId;
      const paused = lines(
        room,
        'host',
        cut,
        `[Preload] Paused preload for ${guestPeer} while its connection is interrupted`,
      );
      const resuming = lines(
        room,
        'host',
        cut,
        `[Preload] Resuming preload for ${guestPeer} after its connection recovered`,
      );
      room.notes.preloadLines = { paused, resuming };
      expect(paused.length, 'Paused line').toBe(1);
      expect(paused[0]!.at, 'Paused during the cut').toBeLessThan(restore);
      expect(resuming.length, 'Resuming line').toBe(1);
      expect(resuming[0]!.at, 'Resuming after restore').toBeGreaterThan(restore);

      // Wire: no abort for L, and the resend starts over with restart:true.
      const forL = (f: FrameRow) => f.queueItemId === qidL;
      expect(
        probes.guest.frames.filter(
          (f) => f.dir === 'recv' && f.type === 'preload-abort' && forL(f),
        ),
      ).toEqual([]);
      const restarts = probes.host.frames.filter(
        (f) => f.dir === 'send' && f.type === 'preload-start' && forL(f) && f.at > restore,
      );
      room.notes.preloadRestarts = restarts;
      expect(restarts.map((f) => f.restart)).toEqual([true]);
    } finally {
      await room.close(testInfo);
    }
  });

  test('host traffic for a track advanced during the outage, observed at the wire (F4)', async ({
    browser,
  }, testInfo) => {
    const { a, l } = await fixtures((name) => testInfo.outputPath(name));
    const room = await LabRoom.open(browser);
    try {
      await playDirectTrack(room, a);
      const qidL = await preloadUntilTrigger(room, l);
      const before = await both(room);

      // The host advances to L while the guest is cut off, so L is promoted to
      // the host's current file before the guest's preload of it completes.
      const cut = await room.cut();
      await sleep(room.host.page, 2_000);
      await room.host.page.locator('#btn-next').click();
      await room.host.page.waitForFunction(
        (qid) => (window as any).__MUSIXQUARE_GET_STATE__('files.current')?.queueItemId === qid,
        qidL,
        { timeout: 5_000 },
      );
      room.mark('hostAdvanced');
      await sleep(room.host.page, cut + F4_OUTAGE_MS - Date.now());
      const restore = await room.restore();
      await waitRecovered(room, true);

      await room.guest.page.waitForFunction(
        ({ qid, bytes }) => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          const current = get('files.current');
          return (
            current?.queueItemId === qid &&
            current.blob instanceof Blob &&
            current.blob.size === bytes
          );
        },
        { qid: qidL, bytes: l.bytes },
        { timeout: restore + F4_COMPLETION_AFTER_RESTORE_MS - Date.now() },
      );
      room.mark('guestHasL');
      await waitForPlaybackProjection(room.guest.page, 'PLAYING_AUDIO', 15_000);
      // Let any second stream for the same tuple finish before reading the wire.
      await sleep(room.host.page, 15_000);
      const blob = await room.guestBlob('current');
      const after = await both(room);
      const probes = await room.probes();

      expectValidOutage(room, probes, before, cut, restore);
      expectSessionKept(room, probes, before, after, cut, true);
      expect(blob, 'guest current Blob').toEqual({
        queueItemId: qidL,
        bytes: l.bytes,
        sha256: l.sha256,
      });

      // What the host sent for L after the restore, per lane (C5-12); also kept
      // as an annotation and in the evidence file.
      const sentForL = probes.host.frames.filter(
        (f) => f.dir === 'send' && f.queueItemId === qidL && f.at > restore,
      );
      const lane = (type: string) => sentForL.filter((f) => f.type === type);
      const guestPeer = before.host.peerId;
      const hostLine = (text: string) =>
        lines(room, 'host', cut, `[Preload] ${text} preload for ${guestPeer} `).map(
          (row) => row.at - restore,
        );
      const mainStartAt = lane('file-start')[0]?.at ?? Number.POSITIVE_INFINITY;
      const wire = {
        preloadStarts: lane('preload-start').map((f) => ({
          restart: f.restart ?? null,
          at: f.at - restore,
        })),
        fileStarts: lane('file-start').map((f) => ({
          startChunk: f.startChunk ?? null,
          at: f.at - restore,
        })),
        preloadChunkBytes: lane('preload-chunk').reduce((sum, f) => sum + f.payloadBytes, 0),
        preloadChunkBytesFromMainStart: lane('preload-chunk')
          .filter((f) => f.at >= mainStartAt)
          .reduce((sum, f) => sum + f.payloadBytes, 0),
        fileChunkBytes: lane('file-chunk').reduce((sum, f) => sum + f.payloadBytes, 0),
        preloadEnds: lane('preload-end').map((f) => f.at - restore),
        preloadAborts: lane('preload-abort').map((f) => ({
          channel: f.channel,
          at: f.at - restore,
        })),
        guestRecoveryRequests: probes.guest.frames
          .filter(
            (f) => f.dir === 'send' && f.type === 'request-data-recovery' && f.queueItemId === qidL,
          )
          .map((f) => f.at - restore),
        hostLines: {
          paused: hostLine('Paused'),
          resuming: hostLine('Resuming'),
          yielding: hostLine('Yielding'),
        },
        trackBytes: l.bytes,
      };
      room.notes.f4Wire = wire;
      room.notes.guestWatchdog = lines(room, 'guest', cut, '[Preload] progress watchdog');
      testInfo.annotations.push({
        type: 'F4 wire after restore',
        description: JSON.stringify(wire),
      });

      // One stream per tuple (C5-12, owner decision P4-D10 A; before it, both
      // bulk lanes carried the whole track). The guest's progress watchdog
      // released the stalled partial preload during the outage, so after
      // recovery it asks for L on the main lane. The paused preload restarts at
      // recovery; the host re-detects the guest as local and tells it so long
      // before that request arrives, so the main lane, started after that,
      // carries the whole track once, and the restart stops once the main lane
      // takes the tuple and sends one PRELOAD_ABORT on the control channel
      // instead of reaching its END.
      expect(wire.guestRecoveryRequests, 'guest recovery requests').toHaveLength(1);
      expect(
        wire.fileStarts.map((x) => x.startChunk),
        'main-lane starts',
      ).toEqual([0]);
      expect(wire.fileChunkBytes, 'main lane bytes').toBe(l.bytes);
      expect(wire.preloadEnds, 'preload ends').toEqual([]);
      expect(wire.preloadChunkBytes, 'preload lane bytes').toBeLessThan(l.bytes);
      // The main lane is preparing before its FILE_START leaves, and the restart
      // checks it synchronously before every chunk, so no preload chunk should
      // follow that header; one chunk of slack covers a same-millisecond stamp.
      expect(
        wire.preloadChunkBytesFromMainStart,
        'preload lane bytes from the main FILE_START on',
      ).toBeLessThanOrEqual(CHUNK_SIZE);
      expect(wire.preloadAborts.length, 'preload aborts').toBe(1);
      // A control route (original or isolated), never the bulk channel.
      expect(wire.preloadAborts[0]!.channel, 'preload abort channel').toMatch(
        /^musixquare-control(?:-isolated)?$/u,
      );
      expect(wire.preloadAborts[0]!.at, 'abort after the main FILE_START').toBeGreaterThanOrEqual(
        wire.fileStarts[0]!.at,
      );
      expect(wire.hostLines.paused.length, 'Paused line').toBe(1);
      expect(wire.hostLines.paused[0]!, 'Paused during the cut').toBeLessThan(0);
      expect(wire.hostLines.yielding.length, 'Yielding line').toBe(1);
      expect(wire.hostLines.yielding[0]!, 'Yielding after restore').toBeGreaterThan(0);
      // One restart at recovery, with its Resuming line, before the yield.
      expect(
        wire.preloadStarts.map((x) => x.restart),
        'preload restarts',
      ).toEqual([true]);
      expect(wire.hostLines.resuming.length, 'Resuming line').toBe(1);
      expect(wire.hostLines.resuming[0]!, 'Resuming before Yielding').toBeLessThan(
        wire.hostLines.yielding[0]!,
      );
    } finally {
      await room.close(testInfo);
    }
  });
});
