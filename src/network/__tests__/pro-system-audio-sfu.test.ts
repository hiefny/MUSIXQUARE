/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithCapability } from '../../core/capability.ts';
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
  sender: {
    track: MediaStreamTrack | null;
    getParameters: () => RTCRtpSendParameters;
    setParameters: ReturnType<typeof vi.fn>;
  };
  receiver: RTCRtpReceiver;
}

const fetchMock = vi.mocked(fetchWithCapability);
let realtimeRequests: RealtimeRequest[];
let peerConnections: MockRTCPeerConnection[];
let nextSessionNumber: number;
let latestRemoteMids: string[];

class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'publisher-offer' }));
  createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: 'subscriber-answer' }));
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
      sender: {
        track,
        getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
        setParameters: vi.fn(async () => {}),
      },
      receiver: { track: null } as unknown as RTCRtpReceiver,
    };
    this.sendTransceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers(): MockTransceiver[] {
    if (this.sendTransceivers.length > 0) return this.sendTransceivers;
    return latestRemoteMids.map((mid, index) => ({
      mid,
      sender: {
        track: null,
        getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
        setParameters: vi.fn(async () => {}),
      },
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
  return { ok, status, json: async () => body } as Response;
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
          ? { type: 'answer', sdp: 'publisher-answer' }
          : { type: 'offer', sdp: 'subscriber-offer' },
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
    version: 1 as const,
    sessionId: `published-session-${generation}`,
    tracks: [
      { trackName: `published-left-${generation}`, channel: 'L' as const },
      { trackName: `published-right-${generation}`, channel: 'R' as const },
    ],
    generation,
    expiresAt: Date.now() + 60_000,
  };
}

beforeEach(() => {
  realtimeRequests = [];
  peerConnections = [];
  nextSessionNumber = 0;
  latestRemoteMids = [];
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
      tracks: source.tracks.map((track) => ({
        ...track,
        sessionOwnerToken: 'also-private',
      })),
    });

    expect(parsed).toEqual(source);
    expect(JSON.stringify(parsed)).not.toContain('owner');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.tracks)).toBe(true);
    expect(Object.isFrozen(parsed?.tracks[0])).toBe(true);
  });

  it('rejects malformed, duplicate-channel, and expired publications before network I/O', () => {
    expect(
      proSfu.parseProSystemAudioSfuPublicationDescriptorForTests({
        ...publication(),
        tracks: [
          { trackName: 'left-a', channel: 'L' },
          { trackName: 'left-b', channel: 'L' },
        ],
      }),
    ).toBeNull();
    expect(() =>
      proSfu.subscribeProSystemAudioSfu({ ...publication(), expiresAt: Date.now() - 1 }),
    ).toThrow(/expired/);
    expect(realtimeRequests).toHaveLength(0);
  });
});

describe('PRO system-audio SFU publisher', () => {
  it('publishes L/R tracks and returns only the controller-safe descriptor', async () => {
    const events: proSfu.ProSystemAudioSfuEventForTests[] = [];
    const unsubscribe = proSfu.onProSystemAudioSfuEvent((event) => events.push(event));
    const expiresAt = Date.now() + 60_000;

    const descriptor = await proSfu.publishProSystemAudioSfu({
      leftTrack: audioTrack('capture-left'),
      rightTrack: audioTrack('capture-right'),
      roomId: '000001',
      generation: 12,
      expiresAt,
    });

    expect(descriptor).toMatchObject({
      version: 1,
      sessionId: 'owned-session-1',
      generation: 12,
      expiresAt,
      tracks: [{ channel: 'L' }, { channel: 'R' }],
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
    expect(publishRequest?.payload?.tracks?.map((track) => track.location)).toEqual([
      'local',
      'local',
    ]);

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
        leftTrack: { ...audioTrack('video'), kind: 'video' } as MediaStreamTrack,
        rightTrack: audioTrack('right'),
        generation: 1,
        expiresAt: Date.now() + 1_000,
      }),
    ).toThrow(/audio track/);
    expect(() =>
      proSfu.publishProSystemAudioSfu({
        leftTrack: audioTrack('left'),
        rightTrack: audioTrack('right'),
        generation: -1,
        expiresAt: Date.now() + 1_000,
      }),
    ).toThrow(/generation/);
    expect(realtimeRequests).toHaveLength(0);
  });

  it('realigns publisher expiry to the authoritative committed lease', async () => {
    vi.useFakeTimers({ now: 1_900_000_000_000 });
    await proSfu.publishProSystemAudioSfu({
      leftTrack: audioTrack('left'),
      rightTrack: audioTrack('right'),
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

describe('PRO system-audio SFU subscriber', () => {
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
        trackName: 'published-left-3',
      },
      {
        location: 'remote',
        sessionId: 'published-session-3',
        trackName: 'published-right-3',
      },
    ]);
    expect(JSON.stringify(realtimeRequests)).not.toContain('publisher-token-must-be-ignored');

    const trackEvents = events.filter(
      (
        event,
      ): event is Extract<proSfu.ProSystemAudioSfuEventForTests, { type: 'subscriber-track' }> =>
        event.type === 'subscriber-track',
    );
    expect(trackEvents.map((event) => event.channel)).toEqual(['L', 'R']);
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
    const current = publication(10);
    await proSfu.subscribeProSystemAudioSfu(current);
    await proSfu.subscribeProSystemAudioSfu(current);
    expect(realtimeRequests.filter((request) => request.action === 'new-session')).toHaveLength(1);

    expect(() => proSfu.subscribeProSystemAudioSfu(publication(9))).toThrow(/Stale/);
    expect(() =>
      proSfu.subscribeProSystemAudioSfu({
        ...publication(10),
        sessionId: 'conflicting-session',
      }),
    ).toThrow(/Conflicting/);
    expect(realtimeRequests.filter((request) => request.action === 'new-session')).toHaveLength(1);
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
});
