/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithCapability, isCapabilityChallengeCancelled } from '../../core/capability.ts';
import { log } from '../../core/log.ts';
import * as proSfu from '../pro-system-audio-sfu.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/capability.ts', () => ({
  fetchWithCapability: vi.fn(),
  isCapabilityChallengeCancelled: vi.fn(() => false),
}));

interface RealtimeRequest {
  action: string;
  sessionId?: string;
  sessionOwnerToken?: string;
  payload?: {
    sessionDescription?: { type: 'offer' | 'answer'; sdp: string };
    tracks?: Array<{
      location?: 'local' | 'remote';
      sessionId?: string;
      trackName?: string;
      mid?: string;
    }>;
  };
}

interface MockTransceiver {
  mid: string | null;
  sender: MockSender;
  receiver: RTCRtpReceiver;
}

interface MockSender {
  track: MediaStreamTrack | null;
  getParameters: () => RTCRtpSendParameters;
  setParameters: ReturnType<typeof vi.fn>;
  replaceTrack: ReturnType<typeof vi.fn<(track: MediaStreamTrack | null) => Promise<void>>>;
}

function mockSender(track: MediaStreamTrack | null): MockSender {
  const sender: MockSender = {
    track,
    getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
    setParameters: vi.fn(async () => {}),
    replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
      sender.track = next;
    }),
  };
  return sender;
}

const fetchMock = vi.mocked(fetchWithCapability);
let realtimeRequests: RealtimeRequest[];
let peerConnections: MockRTCPeerConnection[];
let nextSessionNumber: number;
let latestRemoteMids: string[];
let publisherAnswerSdp: string;
const OPUS_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  '',
].join('\r\n');
const OPUS_STEREO_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10; stereo=1; sprop-stereo=1',
  '',
].join('\r\n');

class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: OPUS_SDP }));
  createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: OPUS_SDP }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  private listeners = new Map<string, Array<() => void>>();
  private sendTransceivers: MockTransceiver[] = [];

  constructor(_configuration?: RTCConfiguration) {
    peerConnections.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  addTransceiver(track: MediaStreamTrack): MockTransceiver {
    const transceiver: MockTransceiver = {
      mid: String(this.sendTransceivers.length),
      sender: mockSender(track),
      receiver: { track: null } as unknown as RTCRtpReceiver,
    };
    this.sendTransceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers(): MockTransceiver[] {
    if (this.sendTransceivers.length > 0) return this.sendTransceivers;
    return latestRemoteMids.map((mid, index) => ({
      mid,
      sender: mockSender(null),
      receiver: {
        track: {
          id: `remote-audio-${index}`,
          kind: 'audio',
          readyState: 'live',
        } as MediaStreamTrack,
      } as RTCRtpReceiver,
    }));
  }

  emitConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    for (const listener of this.listeners.get('connectionstatechange') || []) listener();
  }
}

class MockMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
}

function response(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return Response.json(body, { status });
}

function installSuccessfulFetchRouting(): void {
  fetchMock.mockImplementation(async (url, _capability, init) => {
    if (String(url).includes('get-turn-config')) return response({}, false, 404);

    const request = JSON.parse(String(init?.body || '{}')) as RealtimeRequest;
    realtimeRequests.push(request);
    if (request.action === 'new-session') {
      nextSessionNumber += 1;
      return response({
        sessionId: `owned-session-${nextSessionNumber}`,
        sessionOwnerToken: `private-owner-token-${nextSessionNumber}`,
      });
    }
    if (request.action === 'tracks-new') {
      const requested = request.payload?.tracks || [];
      const isPublisher = requested.every((track) => track.location === 'local');
      const tracks = requested.map((track, index) => ({
        trackName: track.trackName,
        mid: `${isPublisher ? 'publisher' : 'subscriber'}-mid-${index}`,
      }));
      if (!isPublisher) latestRemoteMids = tracks.map((track) => track.mid);
      return response({
        tracks,
        sessionDescription: isPublisher
          ? { type: 'answer', sdp: publisherAnswerSdp }
          : { type: 'offer', sdp: OPUS_SDP },
      });
    }
    if (request.action === 'renegotiate' || request.action === 'tracks-close') {
      return response({});
    }
    return response({ errorDescription: 'Unexpected action' }, false, 400);
  });
}

function audioTrack(id: string): MediaStreamTrack {
  return {
    id,
    kind: 'audio',
    readyState: 'live',
    applyConstraints: vi.fn(async () => {}),
  } as unknown as MediaStreamTrack;
}

function publication(generation = 1) {
  return {
    version: 2 as const,
    sessionId: `published-session-${generation}`,
    track: { trackName: `published-stereo-${generation}` },
    generation,
    expiresAt: Date.now() + 60_000,
  };
}

beforeEach(() => {
  realtimeRequests = [];
  peerConnections = [];
  nextSessionNumber = 0;
  latestRemoteMids = [];
  publisherAnswerSdp = OPUS_STEREO_SDP;
  fetchMock.mockReset();
  installSuccessfulFetchRouting();
  vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
  vi.stubGlobal('MediaStream', MockMediaStream);
  proSfu.stopProSystemAudioSfu();
});

afterEach(() => {
  proSfu.stopProSystemAudioSfu();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PRO system-audio SFU public descriptor', () => {
  it('sanitizes untrusted room state and never carries an owner capability', () => {
    const source = publication(7);
    const parsed = proSfu.parseProSystemAudioSfuPublicationDescriptorForTests({
      ...source,
      sessionOwnerToken: 'must-not-cross-the-room-boundary',
      track: {
        ...source.track,
        sessionOwnerToken: 'also-private',
      },
    });

    expect(parsed).toEqual(source);
    expect(JSON.stringify(parsed)).not.toContain('owner');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.track)).toBe(true);
  });

  it('rejects malformed and expired publications before network I/O', () => {
    expect(
      proSfu.parseProSystemAudioSfuPublicationDescriptorForTests({
        ...publication(),
        track: { trackName: '' },
      }),
    ).toBeNull();
    expect(() =>
      proSfu.subscribeProSystemAudioSfu({ ...publication(), expiresAt: Date.now() - 1 }),
    ).toThrow(/expired/);
    expect(realtimeRequests).toHaveLength(0);
  });
});

describe('PRO system-audio SFU publisher', () => {
  it('prepares TURN without allocating a Realtime session and reuses it on fallback', async () => {
    let resolveTurn!: (value: Response) => void;
    const turnResponse = new Promise<Response>((resolve) => {
      resolveTurn = resolve;
    });
    installSuccessfulFetchRouting();
    fetchMock.mockImplementationOnce(() => turnResponse);

    const preflight = proSfu.beginProSystemAudioSfuPublisherPreflight();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(realtimeRequests).toHaveLength(0);

    resolveTurn(
      response({
        provider: 'cloudflare',
        iceServers: [{ urls: 'turn:example.test:3478', username: 'user', credential: 'secret' }],
      }),
    );
    await proSfu.publishProSystemAudioSfu(
      {
        track: audioTrack('capture-stereo'),
        generation: 11,
        expiresAt: Date.now() + 60_000,
      },
      preflight,
    );

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('get-turn-config')),
    ).toHaveLength(1);
    expect(realtimeRequests.some((request) => request.action === 'new-session')).toBe(true);
  });

  it('can cancel an unused publisher preflight without creating a Realtime session', async () => {
    const preflight = proSfu.beginProSystemAudioSfuPublisherPreflight();
    proSfu.cancelProSystemAudioSfuPublisherPreflight(preflight);
    await Promise.resolve();

    expect(realtimeRequests).toHaveLength(0);
    expect(peerConnections).toHaveLength(0);
  });

  it('publishes one original stereo track and returns only the controller-safe descriptor', async () => {
    const events: proSfu.ProSystemAudioSfuEventForTests[] = [];
    const unsubscribe = proSfu.onProSystemAudioSfuEvent((event) => events.push(event));
    const expiresAt = Date.now() + 60_000;

    const descriptor = await proSfu.publishProSystemAudioSfu({
      track: audioTrack('capture-stereo'),
      roomId: '000001',
      generation: 12,
      expiresAt,
    });

    expect(descriptor).toMatchObject({
      version: 2,
      sessionId: 'owned-session-1',
      generation: 12,
      expiresAt,
      track: { trackName: expect.stringContaining('-stereo-') },
    });
    expect(JSON.stringify(descriptor)).not.toContain('private-owner-token');
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(events.map((event) => event.type === 'publisher-state' && event.state)).toEqual([
      'publishing',
      'published',
    ]);

    const publishRequest = realtimeRequests.find(
      (request) =>
        request.action === 'tracks-new' && request.payload?.tracks?.[0]?.location === 'local',
    );
    expect(publishRequest?.sessionOwnerToken).toBe('private-owner-token-1');
    expect(publishRequest?.payload?.tracks?.map((track) => track.location)).toEqual(['local']);
    expect(publishRequest?.payload?.sessionDescription?.sdp).toContain('stereo=1');
    expect(JSON.stringify(publishRequest)).toContain('sprop-stereo=1');
    expect(JSON.stringify(publishRequest)).toContain('maxaveragebitrate=256000');
    expect(peerConnections[0].setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: OPUS_STEREO_SDP,
    });
    expect(peerConnections[0].getTransceivers()[0]?.sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 256_000 })] }),
    );

    proSfu.stopProSystemAudioSfuPublisher();
    expect(realtimeRequests.at(-1)).toMatchObject({
      action: 'tracks-close',
      sessionId: 'owned-session-1',
      sessionOwnerToken: 'private-owner-token-1',
    });
    expect(peerConnections[0].close).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: 'publisher-state', state: 'stopped' });
    unsubscribe();
  });

  it('validates captured tracks and controller generation synchronously', () => {
    expect(() =>
      proSfu.publishProSystemAudioSfu({
        track: { ...audioTrack('video'), kind: 'video' } as MediaStreamTrack,
        generation: 1,
        expiresAt: Date.now() + 1_000,
      }),
    ).toThrow(/audio track/);
    expect(() =>
      proSfu.publishProSystemAudioSfu({
        track: audioTrack('stereo'),
        generation: -1,
        expiresAt: Date.now() + 1_000,
      }),
    ).toThrow(/generation/);
    expect(realtimeRequests).toHaveLength(0);
  });

  it('fails closed when Cloudflare does not accept Opus stereo receive', async () => {
    publisherAnswerSdp = OPUS_SDP;

    await expect(
      proSfu.publishProSystemAudioSfu({
        track: audioTrack('capture-stereo'),
        generation: 3,
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow('SFU_STEREO_NOT_NEGOTIATED');

    expect(peerConnections[0].setRemoteDescription).not.toHaveBeenCalled();
    expect(realtimeRequests.at(-1)).toMatchObject({
      action: 'tracks-close',
      sessionId: 'owned-session-1',
      sessionOwnerToken: 'private-owner-token-1',
    });
  });

  it('realigns publisher expiry to the authoritative committed lease', async () => {
    vi.useFakeTimers({ now: 1_900_000_000_000 });
    await proSfu.publishProSystemAudioSfu({
      track: audioTrack('stereo'),
      generation: 2,
      expiresAt: Date.now() + 60_000,
    });

    proSfu.updateProSystemAudioSfuPublisherExpiry(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(peerConnections[0].close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(peerConnections[0].close).toHaveBeenCalledOnce();
  });
});

// 9.0.28 (owner decision 2026-10-31): the share's one SFU attempt starts beside
// its LAN-direct attempt with the sender holding no track. It reports no
// publication until the service releases the hold after a LAN-direct failure,
// and a LAN-direct success stops it unused.
describe('PRO system-audio SFU held fallback', () => {
  const ROOM = '000123';
  // The held fallback's own lines carry the service's prefix, never
  // `[ProSysAudioSFU]`: device criteria read any `[ProSysAudioSFU]` line as
  // "this share used the SFU", and only a committed fallback did.
  const PREPARED = /^\[PRO SystemAudio\] Prepared SFU fallback for generation 12 in \d+ ms$/;
  const RELEASED = /^\[PRO SystemAudio\] Released SFU fallback for generation 12 \(held \d+ ms\)$/;
  const CLOSED_OPEN =
    /^\[PRO SystemAudio\] Closed unused SFU fallback for generation 12 \(open \d+ ms\)$/;
  const CLOSED_BEFORE_PREPARED =
    /^\[PRO SystemAudio\] Closed unused SFU fallback for generation 12 \(before it was prepared, \d+ ms after the start\)$/;
  const CANCELLED =
    /^\[PRO SystemAudio\] Cancelled SFU fallback for generation 12 before any Realtime session was requested \(\d+ ms after the start\)$/;
  const CLOSED_RELEASED =
    /^\[PRO SystemAudio\] Closed released SFU fallback for generation 12 without a reported commit \(open \d+ ms\)$/;
  const failedLine = (cause: string) =>
    new RegExp(
      `^\\[PRO SystemAudio\\] SFU fallback for generation 12 failed after \\d+ ms \\(${cause}\\)$`,
    );
  const PUBLISHED = '[ProSysAudioSFU] Published generation 12';
  const MUSIC_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  function infoLines(prefix: string): string[] {
    return vi
      .mocked(log.info)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith(prefix));
  }
  const sfuLines = () => infoLines('[ProSysAudioSFU]');
  const heldLines = () => infoLines('[PRO SystemAudio]');

  /** No line names a session, an owner token, a track name or the room. */
  function expectPrivateLines(): void {
    for (const line of [...sfuLines(), ...heldLines()]) {
      for (const secret of [
        'owned-session',
        'private-owner-token',
        'mxqr-pro-system-audio',
        '-stereo-',
        ROOM,
      ]) {
        expect(line).not.toContain(secret);
      }
    }
  }

  function publisherEvents(events: proSfu.ProSystemAudioSfuEventForTests[]) {
    return events.filter((event) => event.type === 'publisher-state');
  }

  function heldPublish(track: MediaStreamTrack, generation = 12) {
    return proSfu.publishProSystemAudioSfu({
      track,
      roomId: ROOM,
      generation,
      expiresAt: Date.now() + 60_000,
      holdMedia: true,
    });
  }

  function newestSender(): MockSender {
    return peerConnections.at(-1)!.getTransceivers()[0]!.sender;
  }

  /** Holds the next Realtime request of `action` until the returned function lets it answer. */
  function holdNextRealtime(action: string): { started: () => boolean; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const succeed = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, capability, init) => {
      if (!String(url).includes('get-turn-config')) {
        const request = JSON.parse(String(init?.body || '{}')) as RealtimeRequest;
        if (request.action === action && !started) {
          started = true;
          await gate;
        }
      }
      return succeed(url, capability, init);
    });
    return { started: () => started, release };
  }

  let events: proSfu.ProSystemAudioSfuEventForTests[];
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.mocked(log.info).mockClear();
    events = [];
    unsubscribe = proSfu.onProSystemAudioSfuEvent((event) => events.push(event));
  });

  afterEach(() => {
    unsubscribe();
  });

  it('a held publish negotiates with its sender holding no track and reports no publication yet', async () => {
    const track = audioTrack('capture-stereo');
    const descriptor = await heldPublish(track);

    expect(descriptor).toMatchObject({ version: 2, sessionId: 'owned-session-1', generation: 12 });
    const pc = peerConnections[0];
    const sender = pc.getTransceivers()[0]!.sender;
    expect(sender.replaceTrack.mock.calls).toEqual([[null]]);
    expect(sender.replaceTrack.mock.invocationCallOrder[0]).toBeLessThan(
      pc.createOffer.mock.invocationCallOrder[0]!,
    );
    expect(sender.track).toBeNull();
    expect(sender.setParameters).not.toHaveBeenCalled();
    expect(track.applyConstraints).not.toHaveBeenCalled();
    expect(publisherEvents(events).map((event) => event.state)).toEqual(['publishing']);
    expect(heldLines()).toEqual([expect.stringMatching(PREPARED)]);
    expect(sfuLines()).toEqual([]);
    expectPrivateLines();
  });

  it('releasing the hold attaches the original track and tunes it once; the publication is reported only when its commit is', async () => {
    const track = audioTrack('capture-stereo');
    const descriptor = await heldPublish(track);
    const sender = newestSender();

    await proSfu.releaseProSystemAudioSfuPublisherHold(descriptor);

    expect(sender.replaceTrack.mock.calls).toEqual([[null], [track]]);
    expect(sender.track).toBe(track);
    expect(track.applyConstraints).toHaveBeenCalledOnce();
    expect(track.applyConstraints).toHaveBeenCalledWith(MUSIC_CONSTRAINTS);
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 256_000 })] }),
    );
    expect(heldLines()).toEqual([expect.stringMatching(PREPARED), expect.stringMatching(RELEASED)]);
    // Released is not committed: no published line or event yet.
    expect(sfuLines()).toEqual([]);
    expect(publisherEvents(events).map((event) => event.state)).toEqual(['publishing']);

    proSfu.reportProSystemAudioSfuPublisherCommitted(descriptor);
    proSfu.reportProSystemAudioSfuPublisherCommitted(descriptor);

    expect(sfuLines()).toEqual([PUBLISHED]);
    expect(publisherEvents(events).map((event) => event.state)).toEqual([
      'publishing',
      'published',
    ]);
    expect(publisherEvents(events).at(-1)?.descriptor).toBe(descriptor);
    // From here it is an ordinary publication: its stop names it and logs no held line.
    proSfu.stopProSystemAudioSfuPublisher();
    expect(publisherEvents(events).at(-1)).toMatchObject({
      state: 'stopped',
      descriptor: { sessionId: 'owned-session-1' },
    });
    expect(heldLines()).toEqual([expect.stringMatching(PREPARED), expect.stringMatching(RELEASED)]);
    expectPrivateLines();
  });

  it('a commit report is a no-op for any publisher but the current released fallback', async () => {
    const ordinary = await proSfu.publishProSystemAudioSfu({
      track: audioTrack('capture-a'),
      roomId: ROOM,
      generation: 12,
      expiresAt: Date.now() + 60_000,
    });
    // An ordinary publish reported itself when it was published.
    proSfu.reportProSystemAudioSfuPublisherCommitted(ordinary);
    expect(sfuLines()).toEqual([PUBLISHED]);

    const held = await heldPublish(audioTrack('capture-b'));
    // Held, not released yet.
    proSfu.reportProSystemAudioSfuPublisherCommitted(held);
    await proSfu.releaseProSystemAudioSfuPublisherHold(held);
    // Released, but under another publication's descriptor.
    proSfu.reportProSystemAudioSfuPublisherCommitted(ordinary);
    expect(sfuLines()).toEqual([PUBLISHED]);

    // A released fallback stopped before its commit was reported names its
    // publication, as a publish stopped before its commit always did.
    proSfu.stopProSystemAudioSfuPublisher();
    expect(publisherEvents(events).at(-1)).toMatchObject({
      state: 'stopped',
      descriptor: { sessionId: 'owned-session-2' },
    });
    proSfu.reportProSystemAudioSfuPublisherCommitted(held);

    expect(sfuLines()).toEqual([PUBLISHED]);
    expect(publisherEvents(events).filter((event) => event.state === 'published')).toHaveLength(1);
    expect(heldLines()).toEqual([
      expect.stringMatching(PREPARED),
      expect.stringMatching(RELEASED),
      expect.stringMatching(CLOSED_RELEASED),
    ]);
    expectPrivateLines();
  });

  it('a released fallback whose connection fails before its commit is reported names its session in failed, as a publish did before its commit', async () => {
    const descriptor = await heldPublish(audioTrack('capture-stereo'));
    await proSfu.releaseProSystemAudioSfuPublisherHold(descriptor);
    const pc = peerConnections[0];
    events.length = 0;

    pc.emitConnectionState('failed');

    expect(events).toEqual([
      expect.objectContaining({
        type: 'publisher-state',
        state: 'failed',
        descriptor: expect.objectContaining({ sessionId: 'owned-session-1' }),
      }),
    ]);
    expect(pc.close).toHaveBeenCalledOnce();
    proSfu.reportProSystemAudioSfuPublisherCommitted(descriptor);
    expect(sfuLines()).toEqual([]);
    expect(heldLines()).toEqual([
      expect.stringMatching(PREPARED),
      expect.stringMatching(RELEASED),
      expect.stringMatching(failedLine('connection-failed')),
    ]);
    expectPrivateLines();
  });

  it('stopping a prepared held publisher closes its tracks and connection and logs it closed unused, never published', async () => {
    const track = audioTrack('capture-stereo');
    await heldPublish(track);
    const pc = peerConnections[0];
    const sender = pc.getTransceivers()[0]!.sender;

    proSfu.stopProSystemAudioSfuPublisher();

    expect(realtimeRequests.at(-1)).toMatchObject({
      action: 'tracks-close',
      sessionId: 'owned-session-1',
      sessionOwnerToken: 'private-owner-token-1',
      payload: { force: true },
    });
    expect(pc.close).toHaveBeenCalledOnce();
    expect(publisherEvents(events).at(-1)).toMatchObject({ state: 'stopped', descriptor: null });
    expect(heldLines()).toEqual([
      expect.stringMatching(PREPARED),
      expect.stringMatching(CLOSED_OPEN),
    ]);
    expect(sfuLines()).toEqual([]);
    expect(sender.replaceTrack.mock.calls).toEqual([[null]]);
    expect(track.applyConstraints).not.toHaveBeenCalled();
    expectPrivateLines();
  });

  it('stopping a held publish before its session request cancels it and says no session was requested', async () => {
    let releaseTurn!: () => void;
    const turnHeld = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let turnStarted = false;
    const succeed = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, capability, init) => {
      if (String(url).includes('get-turn-config')) {
        turnStarted = true;
        await turnHeld;
      }
      return succeed(url, capability, init);
    });
    const publishing = heldPublish(audioTrack('capture-stereo'));
    await vi.waitFor(() => expect(turnStarted).toBe(true));

    proSfu.stopProSystemAudioSfuPublisher();
    releaseTurn();

    await expect(publishing).rejects.toMatchObject({ name: 'AbortError' });
    expect(realtimeRequests).toEqual([]);
    expect(peerConnections).toEqual([]);
    expect(publisherEvents(events).map((event) => event.state)).not.toContain('failed');
    expect(heldLines()).toEqual([expect.stringMatching(CANCELLED)]);
    expect(sfuLines()).toEqual([]);
  });

  it('stopping a held publish while its session request is in flight aborts it and logs it closed before prepared', async () => {
    const session = holdNextRealtime('new-session');
    const publishing = heldPublish(audioTrack('capture-stereo'));
    await vi.waitFor(() => expect(session.started()).toBe(true));

    proSfu.stopProSystemAudioSfuPublisher();
    session.release();

    await expect(publishing).rejects.toMatchObject({ name: 'AbortError' });
    expect(publisherEvents(events).map((event) => event.state)).not.toContain('failed');
    expect(realtimeRequests.map((request) => request.action)).toEqual(['new-session']);
    expect(heldLines()).toEqual([expect.stringMatching(CLOSED_BEFORE_PREPARED)]);
    expect(sfuLines()).toEqual([]);
  });

  it('stopping a held publish while its track request is in flight force-closes the requested mid', async () => {
    const tracks = holdNextRealtime('tracks-new');
    const publishing = heldPublish(audioTrack('capture-stereo'));
    await vi.waitFor(() => expect(tracks.started()).toBe(true));

    proSfu.stopProSystemAudioSfuPublisher();

    await expect(publishing).rejects.toMatchObject({ name: 'AbortError' });
    tracks.release();
    // The client closes the mid it asked for at once; whether Realtime saw the
    // aborted track request first is not the client's to know (9.0.28 note).
    expect(realtimeRequests.filter((request) => request.action === 'new-session')).toHaveLength(1);
    expect(realtimeRequests.filter((request) => request.action === 'tracks-close')).toEqual([
      expect.objectContaining({
        sessionId: 'owned-session-1',
        payload: { tracks: [{ mid: '0' }], force: true },
      }),
    ]);
    expect(publisherEvents(events).map((event) => event.state)).not.toContain('failed');
    expect(heldLines()).toEqual([expect.stringMatching(CLOSED_BEFORE_PREPARED)]);
    expect(sfuLines()).toEqual([]);
    expectPrivateLines();
  });

  it('a held publisher whose connection fails reports failed without a descriptor and cannot be released', async () => {
    const track = audioTrack('capture-stereo');
    const descriptor = await heldPublish(track);
    const pc = peerConnections[0];
    const sender = pc.getTransceivers()[0]!.sender;
    events.length = 0;

    pc.emitConnectionState('failed');

    expect(events).toEqual([
      expect.objectContaining({ type: 'publisher-state', state: 'failed', descriptor: null }),
    ]);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(realtimeRequests.at(-1)).toMatchObject({ action: 'tracks-close' });
    expect(heldLines()).toEqual([
      expect.stringMatching(PREPARED),
      expect.stringMatching(failedLine('connection-failed')),
    ]);
    await expect(proSfu.releaseProSystemAudioSfuPublisherHold(descriptor)).rejects.toThrow(
      'PRO_SFU_FALLBACK_UNAVAILABLE',
    );
    expect(sender.replaceTrack.mock.calls).toEqual([[null]]);
    expect(sfuLines()).toEqual([]);
    expectPrivateLines();
  });

  it('a held publish that fails logs one failed line by error name, never its message', async () => {
    publisherAnswerSdp = OPUS_SDP;
    await expect(heldPublish(audioTrack('capture-stereo'))).rejects.toThrow(
      'SFU_STEREO_NOT_NEGOTIATED',
    );

    const timeout = new Error('PRO_SFU_REALTIME_REQUEST_TIMEOUT');
    timeout.name = 'TimeoutError';
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('get-turn-config')) return response({}, false, 404);
      throw timeout;
    });
    await expect(heldPublish(audioTrack('capture-stereo'))).rejects.toBe(timeout);

    const cancelled = new Error('capability challenge cancelled');
    vi.mocked(isCapabilityChallengeCancelled).mockImplementation((error) => error === cancelled);
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('get-turn-config')) return response({}, false, 404);
      throw cancelled;
    });
    try {
      await expect(heldPublish(audioTrack('capture-stereo'))).rejects.toBe(cancelled);
    } finally {
      vi.mocked(isCapabilityChallengeCancelled).mockImplementation(() => false);
    }

    expect(heldLines()).toEqual([
      expect.stringMatching(failedLine('Error')),
      expect.stringMatching(failedLine('TimeoutError')),
      expect.stringMatching(failedLine('capability-cancelled')),
    ]);
    for (const line of heldLines()) {
      expect(line).not.toContain('SFU_STEREO_NOT_NEGOTIATED');
      expect(line).not.toContain('PRO_SFU_REALTIME_REQUEST_TIMEOUT');
      expect(line).not.toContain('challenge');
    }
    expect(sfuLines()).toEqual([]);
    expectPrivateLines();
  });

  it("a held publish refused by the Worker's new-session limit (429) fails with one failed line and holds no session", async () => {
    // The limit is per capability token, which every PRO SFU publish,
    // promotion and subscription of one browser shares (9.0.28 note).
    fetchMock.mockImplementation(async (url, _capability, init) => {
      if (String(url).includes('get-turn-config')) return response({}, false, 404);
      realtimeRequests.push(JSON.parse(String(init?.body || '{}')) as RealtimeRequest);
      return response({ error: 'Too many requests' }, false, 429);
    });

    await expect(heldPublish(audioTrack('capture-stereo'))).rejects.toThrow('Too many requests');

    expect(new Set(realtimeRequests.map((request) => request.action))).toEqual(
      new Set(['new-session']),
    );
    expect(publisherEvents(events).at(-1)).toMatchObject({ state: 'failed', descriptor: null });
    expect(heldLines()).toEqual([expect.stringMatching(failedLine('Error'))]);
    expect(heldLines()[0]).not.toContain('Too many');
    expect(sfuLines()).toEqual([]);
  });

  it('release refuses a stopped or superseded publisher and never touches a successor', async () => {
    const first = await heldPublish(audioTrack('capture-a'));
    proSfu.stopProSystemAudioSfuPublisher();
    await expect(proSfu.releaseProSystemAudioSfuPublisherHold(first)).rejects.toThrow(
      'PRO_SFU_FALLBACK_UNAVAILABLE',
    );

    const second = await heldPublish(audioTrack('capture-b'));
    await proSfu.publishProSystemAudioSfu({
      track: audioTrack('capture-c'),
      roomId: ROOM,
      generation: 13,
      expiresAt: Date.now() + 60_000,
    });
    const successorSender = newestSender();
    await expect(proSfu.releaseProSystemAudioSfuPublisherHold(second)).rejects.toThrow(
      'PRO_SFU_FALLBACK_UNAVAILABLE',
    );
    expect(successorSender.replaceTrack).not.toHaveBeenCalled();
    expect(successorSender.track).toMatchObject({ id: 'capture-c' });
    expect(heldLines().some((line) => RELEASED.test(line))).toBe(false);
  });

  it("a stale descriptor never releases a successor's held fallback", async () => {
    const stale = await heldPublish(audioTrack('capture-a'));
    proSfu.stopProSystemAudioSfuPublisher();
    const successorTrack = audioTrack('capture-b');
    const successor = await heldPublish(successorTrack);
    const successorSender = newestSender();

    await expect(proSfu.releaseProSystemAudioSfuPublisherHold(stale)).rejects.toThrow(
      'PRO_SFU_FALLBACK_UNAVAILABLE',
    );

    expect(successorSender.replaceTrack.mock.calls).toEqual([[null]]);
    expect(successorTrack.applyConstraints).not.toHaveBeenCalled();
    expect(heldLines().some((line) => RELEASED.test(line))).toBe(false);
    // The successor's own release still works.
    await proSfu.releaseProSystemAudioSfuPublisherHold(successor);
    expect(successorSender.replaceTrack.mock.calls).toEqual([[null], [successorTrack]]);
  });

  // 9.0.28 release owner decision (2026-10-31, under the owner's delegation):
  // when LAN-direct fails, the service asks whether the held fallback it was
  // handed is still there before it releases it; one that is not (its
  // connection failed while held) leaves the share to 9.0.27's one ordinary
  // publish. The query is the release's own entry check and touches nothing.
  it('the hold-ready query names only the current prepared, unreleased held fallback, as the release checks it', async () => {
    const isReady = proSfu.isProSystemAudioSfuPublisherHoldReady;
    const first = await heldPublish(audioTrack('capture-a'));
    const firstSender = newestSender();
    expect(isReady(first)).toBe(true);
    expect(isReady({ ...first, sessionId: 'another-session' })).toBe(false);
    expect(isReady({ ...first, generation: 13 })).toBe(false);
    // Asking changes nothing: the sender still holds no track.
    expect(firstSender.replaceTrack.mock.calls).toEqual([[null]]);
    await proSfu.releaseProSystemAudioSfuPublisherHold(first);
    expect(isReady(first)).toBe(false);

    // Its connection fails while held: no longer ready, and the release refuses it.
    const second = await heldPublish(audioTrack('capture-b'));
    expect(isReady(first)).toBe(false);
    expect(isReady(second)).toBe(true);
    peerConnections.at(-1)!.emitConnectionState('failed');
    expect(isReady(second)).toBe(false);
    await expect(proSfu.releaseProSystemAudioSfuPublisherHold(second)).rejects.toThrow(
      'PRO_SFU_FALLBACK_UNAVAILABLE',
    );

    // Stopped while held, and an ordinary publish, which never held.
    const third = await heldPublish(audioTrack('capture-c'));
    expect(isReady(third)).toBe(true);
    proSfu.stopProSystemAudioSfuPublisher();
    expect(isReady(third)).toBe(false);
    const ordinary = await proSfu.publishProSystemAudioSfu({
      track: audioTrack('capture-d'),
      roomId: ROOM,
      generation: 12,
      expiresAt: Date.now() + 60_000,
    });
    expect(isReady(ordinary)).toBe(false);
  });

  it.each(['an explicit stop', 'a superseding held publish'] as const)(
    "%s during the release's track attach: the release rejects as superseded, logs no release and tunes nothing",
    async (teardown) => {
      const track = audioTrack('capture-a');
      const held = await heldPublish(track);
      const sender = newestSender();
      let attach!: () => void;
      const attaching = new Promise<void>((resolve) => {
        attach = resolve;
      });
      sender.replaceTrack.mockImplementationOnce(async (next) => {
        await attaching;
        sender.track = next;
      });
      const releasing = proSfu.releaseProSystemAudioSfuPublisherHold(held).then(
        () => 'released',
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(sender.replaceTrack).toHaveBeenCalledTimes(2));

      const successorTrack = audioTrack('capture-b');
      let successor: proSfu.ProSystemAudioSfuPublicationDescriptor | null = null;
      if (teardown === 'an explicit stop') proSfu.stopProSystemAudioSfuPublisher();
      else successor = await heldPublish(successorTrack, 13);
      attach();

      expect(await releasing).toMatchObject({ name: 'AbortError' });
      expect(heldLines().some((line) => RELEASED.test(line))).toBe(false);
      expect(track.applyConstraints).not.toHaveBeenCalled();
      expect(sender.setParameters).not.toHaveBeenCalled();
      expect(publisherEvents(events).map((event) => event.state)).not.toContain('published');
      if (successor) {
        // The successor's hold is untouched: it still releases, and reports on its commit.
        const successorSender = newestSender();
        await proSfu.releaseProSystemAudioSfuPublisherHold(successor);
        proSfu.reportProSystemAudioSfuPublisherCommitted(successor);
        expect(successorSender.replaceTrack.mock.calls).toEqual([[null], [successorTrack]]);
        expect(sfuLines()).toEqual(['[ProSysAudioSFU] Published generation 13']);
      } else {
        expect(sfuLines()).toEqual([]);
      }
    },
  );

  it('a release whose capture track has ended fails the fallback with its own line, and the stop after it logs nothing more', async () => {
    const ending = audioTrack('capture-d');
    const held = await heldPublish(ending);
    const pc = peerConnections[0];
    const sender = newestSender();
    (ending as { readyState: MediaStreamTrackState }).readyState = 'ended';
    events.length = 0;

    await expect(proSfu.releaseProSystemAudioSfuPublisherHold(held)).rejects.toThrow(
      /already ended/,
    );

    expect(sender.replaceTrack.mock.calls).toEqual([[null]]);
    expect(events).toEqual([
      expect.objectContaining({ type: 'publisher-state', state: 'failed', descriptor: null }),
    ]);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(realtimeRequests.at(-1)).toMatchObject({ action: 'tracks-close' });
    // The service's failed-publish teardown stops the publisher again: no closed line.
    proSfu.stopProSystemAudioSfuPublisher();
    expect(heldLines()).toEqual([
      expect.stringMatching(PREPARED),
      expect.stringMatching(failedLine('track-ended')),
    ]);
    expect(sfuLines()).toEqual([]);
  });

  it('a release whose track attach rejects fails the fallback by error name', async () => {
    const held = await heldPublish(audioTrack('capture-e'));
    const sender = newestSender();
    const refused = new DOMException('sender closed while attaching', 'InvalidStateError');
    sender.replaceTrack.mockImplementationOnce(async () => {
      throw refused;
    });

    await expect(proSfu.releaseProSystemAudioSfuPublisherHold(held)).rejects.toBe(refused);

    expect(publisherEvents(events).at(-1)).toMatchObject({ state: 'failed', descriptor: null });
    expect(heldLines()).toEqual([
      expect.stringMatching(PREPARED),
      expect.stringMatching(failedLine('InvalidStateError')),
    ]);
    expect(heldLines()[1]).not.toContain('sender closed');
  });
});

describe('PRO system-audio SFU subscriber', () => {
  it.each(['failed', 'stopped', 'replaced'] as const)(
    'invalidates emitted track ownership when its native subscriber is %s',
    async (termination) => {
      const events: proSfu.ProSystemAudioSfuEventForTests[] = [];
      const unsubscribe = proSfu.onProSystemAudioSfuEvent((event) => events.push(event));
      await proSfu.subscribeProSystemAudioSfu(publication(1));
      const track = events.find((event) => event.type === 'subscriber-track');
      expect(track).toBeDefined();
      if (!track) throw new Error('Subscriber did not emit its actual track');
      expect(track.isCurrent()).toBe(true);
      peerConnections[0].emitConnectionState('disconnected');
      expect(track.isCurrent()).toBe(true);
      peerConnections[0].emitConnectionState('connected');
      expect(track.isCurrent()).toBe(true);

      if (termination === 'failed') peerConnections[0].emitConnectionState('failed');
      else if (termination === 'stopped') proSfu.stopProSystemAudioSfuSubscriber();
      else await proSfu.subscribeProSystemAudioSfu(publication(2));

      expect(track.isCurrent()).toBe(false);
      await proSfu.subscribeProSystemAudioSfu(publication(2));
      expect(track.isCurrent()).toBe(false);
      const replacement = events.filter((event) => event.type === 'subscriber-track').at(-1);
      expect(replacement?.isCurrent()).toBe(true);
      unsubscribe();
    },
  );

  it('subscribes from any participant using only the public descriptor', async () => {
    const events: proSfu.ProSystemAudioSfuEventForTests[] = [];
    const unsubscribe = proSfu.onProSystemAudioSfuEvent((event) => events.push(event));
    const descriptor = {
      ...publication(3),
      sessionOwnerToken: 'publisher-token-must-be-ignored',
    };

    await proSfu.subscribeProSystemAudioSfu(descriptor);

    const subscribeRequest = realtimeRequests.find(
      (request) =>
        request.action === 'tracks-new' && request.payload?.tracks?.[0]?.location === 'remote',
    );
    expect(subscribeRequest).toMatchObject({
      sessionId: 'owned-session-1',
      sessionOwnerToken: 'private-owner-token-1',
    });
    expect(subscribeRequest?.payload?.tracks).toEqual([
      {
        location: 'remote',
        sessionId: 'published-session-3',
        trackName: 'published-stereo-3',
      },
    ]);
    expect(JSON.stringify(realtimeRequests)).not.toContain('publisher-token-must-be-ignored');
    expect(peerConnections[0].setRemoteDescription).toHaveBeenCalledWith({
      type: 'offer',
      sdp: OPUS_SDP,
    });
    const renegotiateRequest = realtimeRequests.find((request) => request.action === 'renegotiate');
    expect(renegotiateRequest?.payload?.sessionDescription?.sdp).toContain('stereo=1');
    expect(renegotiateRequest?.payload?.sessionDescription?.sdp).toContain('sprop-stereo=1');

    const trackEvents = events.filter(
      (
        event,
      ): event is Extract<proSfu.ProSystemAudioSfuEventForTests, { type: 'subscriber-track' }> =>
        event.type === 'subscriber-track',
    );
    expect(trackEvents).toHaveLength(1);
    expect(trackEvents.every((event) => event.track.kind === 'audio')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'subscriber-state', state: 'subscribed' });

    proSfu.stopProSystemAudioSfuSubscriber();
    expect(realtimeRequests.at(-1)).toMatchObject({
      action: 'tracks-close',
      sessionId: 'owned-session-1',
      sessionOwnerToken: 'private-owner-token-1',
    });
    expect(peerConnections[0].close).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('is idempotent for one generation and rejects stale or conflicting room state', async () => {
    const trackEvents: proSfu.ProSystemAudioSfuEventForTests[] = [];
    const unsubscribe = proSfu.onProSystemAudioSfuEvent((event) => {
      if (event.type === 'subscriber-track') trackEvents.push(event);
    });
    const current = publication(10);
    await proSfu.subscribeProSystemAudioSfu(current);
    await proSfu.subscribeProSystemAudioSfu(current);
    expect(realtimeRequests.filter((request) => request.action === 'new-session')).toHaveLength(1);
    // An authoritative refresh of the same live route must not hand out its
    // track again. A failed consumer therefore needs to retire the route
    // before retrying, rather than expecting this idempotent call to recover it.
    expect(trackEvents).toHaveLength(1);

    expect(() => proSfu.subscribeProSystemAudioSfu(publication(9))).toThrow(/Stale/);
    expect(() =>
      proSfu.subscribeProSystemAudioSfu({
        ...publication(10),
        sessionId: 'conflicting-session',
      }),
    ).toThrow(/Conflicting/);
    expect(realtimeRequests.filter((request) => request.action === 'new-session')).toHaveLength(1);
    proSfu.stopProSystemAudioSfuSubscriber();
    await proSfu.subscribeProSystemAudioSfu(current);
    expect(trackEvents).toHaveLength(2);
    expect(realtimeRequests.filter((request) => request.action === 'new-session')).toHaveLength(2);
    unsubscribe();
  });

  it('replaces an older subscription when the controller advances generation', async () => {
    await proSfu.subscribeProSystemAudioSfu(publication(1));
    const firstPc = peerConnections[0];

    await proSfu.subscribeProSystemAudioSfu(publication(2));

    expect(firstPc.close).toHaveBeenCalledOnce();
    expect(realtimeRequests.filter((request) => request.action === 'new-session')).toHaveLength(2);
    expect(realtimeRequests.some((request) => request.action === 'tracks-close')).toBe(true);
  });

  it('stops a failed subscriber without asking the room coordinator to intervene', async () => {
    const events: proSfu.ProSystemAudioSfuEventForTests[] = [];
    const unsubscribe = proSfu.onProSystemAudioSfuEvent((event) => events.push(event));
    await proSfu.subscribeProSystemAudioSfu(publication());

    peerConnections[0].emitConnectionState('failed');

    expect(peerConnections[0].close).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: 'subscriber-state', state: 'failed' });
    unsubscribe();
  });

  it('reports a transient subscriber disconnect and its in-place recovery', async () => {
    const events: proSfu.ProSystemAudioSfuEventForTests[] = [];
    const unsubscribe = proSfu.onProSystemAudioSfuEvent((event) => events.push(event));
    await proSfu.subscribeProSystemAudioSfu(publication());
    events.length = 0;

    peerConnections[0].emitConnectionState('disconnected');
    peerConnections[0].emitConnectionState('disconnected');
    expect(events).toEqual([
      expect.objectContaining({ type: 'subscriber-state', state: 'disconnected' }),
    ]);
    expect(peerConnections[0].close).not.toHaveBeenCalled();

    peerConnections[0].emitConnectionState('connected');
    expect(events.at(-1)).toMatchObject({ type: 'subscriber-state', state: 'subscribed' });
    expect(peerConnections[0].close).not.toHaveBeenCalled();
    unsubscribe();
  });
});

// The listener's diagnostic for the 9.0.26 field case (about 5.4 s from the
// share notice to the SFU track): one info line per subscription, with the
// stage times read at the steps the subscription already awaits.
describe('PRO system-audio SFU subscription stage line', () => {
  const STAGES =
    /^\[ProSysAudioSFU\] Subscription to generation 3 ready 15\d\d ms after the share notice \(start 15\d\d, config 15\d\d, session 15\d\d, tracks 15\d\d, offer 15\d\d, track 15\d\d, answer 15\d\d, subscribed 15\d\d\)$/;

  function subscriptionLines(): string[] {
    return vi
      .mocked(log.info)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith('[ProSysAudioSFU] Subscription'));
  }

  beforeEach(() => {
    vi.mocked(log.info).mockClear();
  });

  it('logs one ready line after the subscribed line, counting each stage from the share notice', async () => {
    await proSfu.subscribeProSystemAudioSfu(publication(3), { noticeAt: Date.now() - 1_500 });
    const lines = vi.mocked(log.info).mock.calls.map(([line]) => String(line));
    expect(lines.slice(-2)).toEqual([
      '[ProSysAudioSFU] Subscribed to generation 3',
      expect.stringMatching(STAGES),
    ]);
    expect(subscriptionLines()).toHaveLength(1);
    for (const secret of [
      'published-session',
      'published-stereo',
      'owned-session',
      'owner-token',
    ]) {
      expect(subscriptionLines()[0]).not.toContain(secret);
    }
  });

  it('counts from the call itself without a share notice, or with one from the future, and says so', async () => {
    await proSfu.subscribeProSystemAudioSfu(publication(3), { noticeAt: Date.now() + 60_000 });
    proSfu.stopProSystemAudioSfuSubscriber();
    await proSfu.subscribeProSystemAudioSfu(publication(3));
    expect(subscriptionLines()).toEqual([
      expect.stringMatching(
        /^\[ProSysAudioSFU\] Subscription to generation 3 ready \d{1,2} ms after the subscribe call \(start \d{1,2}, /,
      ),
      expect.stringMatching(
        /^\[ProSysAudioSFU\] Subscription to generation 3 ready \d{1,2} ms after the subscribe call \(start \d{1,2}, /,
      ),
    ]);
  });

  it('logs the failed line when the connection fails while the attempt is still in progress', async () => {
    let releaseRenegotiate!: () => void;
    const renegotiateHeld = new Promise<void>((resolve) => {
      releaseRenegotiate = resolve;
    });
    let renegotiateStarted = false;
    const succeed = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, capability, init) => {
      const request = JSON.parse(String(init?.body || '{}')) as RealtimeRequest;
      if (request.action === 'renegotiate') {
        renegotiateStarted = true;
        await renegotiateHeld;
      }
      return succeed(url, capability, init);
    });
    const attempt = proSfu.subscribeProSystemAudioSfu(publication(7), {
      noticeAt: Date.now() - 1_500,
    });
    await vi.waitFor(() => expect(renegotiateStarted).toBe(true));
    peerConnections.at(-1)!.emitConnectionState('failed');
    releaseRenegotiate();
    await expect(attempt).rejects.toThrow();
    expect(subscriptionLines()).toEqual([
      expect.stringMatching(
        /^\[ProSysAudioSFU\] Subscription to generation 7 failed at renegotiate 15\d\d ms after the share notice \(connection-failed; start 15\d\d, config 15\d\d, session 15\d\d, tracks 15\d\d, offer 15\d\d, track 15\d\d, answer 15\d\d\)$/,
      ),
    ]);
  });

  it('logs nothing more when a subscribed connection fails later', async () => {
    await proSfu.subscribeProSystemAudioSfu(publication(8), { noticeAt: Date.now() - 1_500 });
    peerConnections.at(-1)!.emitConnectionState('failed');
    expect(subscriptionLines()).toEqual([
      expect.stringMatching(/^\[ProSysAudioSFU\] Subscription to generation 8 ready /),
    ]);
  });

  it('logs a short line for a subscription refused before it starts', async () => {
    expect(() => proSfu.subscribeProSystemAudioSfu({ version: 2 })).toThrow(/Invalid/);
    expect(() =>
      proSfu.subscribeProSystemAudioSfu({ ...publication(9), expiresAt: Date.now() - 1 }),
    ).toThrow(/expired/);
    await proSfu.subscribeProSystemAudioSfu(publication(10));
    expect(() => proSfu.subscribeProSystemAudioSfu(publication(9))).toThrow(/Stale/);
    expect(() =>
      proSfu.subscribeProSystemAudioSfu({ ...publication(10), sessionId: 'conflicting-session' }),
    ).toThrow(/Conflicting/);
    expect(subscriptionLines()).toEqual([
      '[ProSysAudioSFU] Subscription failed before start (invalid)',
      '[ProSysAudioSFU] Subscription to generation 9 failed before start (expired)',
      expect.stringMatching(/^\[ProSysAudioSFU\] Subscription to generation 10 ready /),
      '[ProSysAudioSFU] Subscription to generation 9 failed before start (stale-generation)',
      '[ProSysAudioSFU] Subscription to generation 10 failed before start (conflicting-generation)',
    ]);
    for (const line of subscriptionLines()) {
      for (const secret of ['published-session', 'conflicting-session', 'owned-session']) {
        expect(line).not.toContain(secret);
      }
    }
  });

  it('logs one failed line naming its stage and the error name, never its message', async () => {
    fetchMock.mockImplementation(async (url, _capability, init) => {
      if (String(url).includes('get-turn-config')) return response({}, false, 404);
      const request = JSON.parse(String(init?.body || '{}')) as RealtimeRequest;
      realtimeRequests.push(request);
      if (request.action === 'new-session') {
        return response({ sessionId: 'owned-session-9', sessionOwnerToken: 'owner-token-9' });
      }
      return response({ errorCode: 'secret-code', errorDescription: 'owned-session-9 is gone' });
    });
    await expect(
      proSfu.subscribeProSystemAudioSfu(publication(4), { noticeAt: Date.now() - 1_500 }),
    ).rejects.toThrow();
    expect(subscriptionLines()).toEqual([
      expect.stringMatching(
        /^\[ProSysAudioSFU\] Subscription to generation 4 failed at tracks 15\d\d ms after the share notice \(Error; start 15\d\d, config 15\d\d, session 15\d\d\)$/,
      ),
    ]);
    for (const secret of ['owned-session', 'owner-token', 'secret-code', 'gone']) {
      expect(subscriptionLines()[0]).not.toContain(secret);
    }
  });

  it('names a timeout and a cancelled capability challenge by their closed names', async () => {
    const timeout = new Error('PRO_SFU_REALTIME_REQUEST_TIMEOUT');
    timeout.name = 'TimeoutError';
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('get-turn-config')) return response({}, false, 404);
      throw timeout;
    });
    await expect(proSfu.subscribeProSystemAudioSfu(publication(5))).rejects.toThrow();
    const cancelled = new Error('capability challenge cancelled');
    vi.mocked(isCapabilityChallengeCancelled).mockImplementation((error) => error === cancelled);
    fetchMock.mockImplementation(async () => {
      throw cancelled;
    });
    try {
      await expect(proSfu.subscribeProSystemAudioSfu(publication(6))).rejects.toBe(cancelled);
    } finally {
      vi.mocked(isCapabilityChallengeCancelled).mockImplementation(() => false);
    }
    expect(subscriptionLines()).toEqual([
      expect.stringMatching(
        / generation 5 failed at session \d+ ms .* \(TimeoutError; start \d+, config \d+\)$/,
      ),
      expect.stringMatching(
        / generation 6 failed at config \d+ ms .* \(capability-cancelled; start \d+\)$/,
      ),
    ]);
  });

  it.each(['superseded', 'stopped'] as const)(
    'logs nothing for an attempt that is %s before it completes',
    async (end) => {
      const first = proSfu.subscribeProSystemAudioSfu(publication(5));
      if (end === 'superseded') {
        await proSfu.subscribeProSystemAudioSfu(publication(6));
      } else {
        proSfu.stopProSystemAudioSfuSubscriber();
      }
      await expect(first).rejects.toThrow();
      expect(subscriptionLines()).toEqual(
        end === 'superseded'
          ? [expect.stringMatching(/^\[ProSysAudioSFU\] Subscription to generation 6 ready /)]
          : [],
      );
    },
  );
});
