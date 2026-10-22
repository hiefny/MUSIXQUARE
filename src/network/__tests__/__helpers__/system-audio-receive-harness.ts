/**
 * Native-seam fakes for the system-audio receive-slot contract suites:
 * - src/network/__tests__/system-audio-receive-slot-contract.test.ts (Standard)
 * - src/pro-room/__tests__/system-audio-receive-slot-pro-contract.test.ts (PRO)
 *
 * Only platform and transport boundaries live here. The receive owners
 * (network/system-audio-guest.ts, network/system-audio-sfu.ts,
 * network/system-audio-delivery.ts, pro-room/system-audio-service.ts with its
 * controller) and their collaborators (core/state, core/events, core/timers,
 * player/ownership, network/protocol, the decoder primer) run for real. Each
 * section says what the fake models, what it is calibrated against, and what it
 * leaves out.
 */
import { vi } from 'vitest';
import { bus, createBusScope } from '../../../core/events.ts';
import type { MediaConnection } from '../../../types/index.ts';
import type { ProSystemAudioSfuPublicationDescriptor } from '../../pro-system-audio-sfu.ts';
import type {
  ProSystemAudioDirectFallbackEvent,
  ProSystemAudioDirectTrackReadyEvent,
} from '../../pro-system-audio-direct.ts';

// ─── Tracks and streams ─────────────────────────────────────────────
// Models a live remote audio MediaStreamTrack (id, kind, muted, unmute
// listeners) and a MediaStream container. Does not model ended tracks, track
// cloning or media flow.

let trackSeq = 0;

export function makeAudioTrack(id = `remote-audio-${++trackSeq}`): MediaStreamTrack {
  const listeners = new Map<string, Set<() => void>>();
  return {
    id,
    kind: 'audio',
    readyState: 'live',
    muted: false,
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  } as unknown as MediaStreamTrack;
}

export class FakeMediaStream {
  readonly tracks: MediaStreamTrack[];
  constructor(tracks: readonly MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }
  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }
}

// ─── Web Audio ──────────────────────────────────────────────────────
// Models the shared AudioContext only as far as the receive slot touches it:
// createMediaStreamSource, the source's connect/disconnect against
// widener.input (kept as a ledger), and initAudio's running gate. initAudio is
// calibrated against audio/context.ts ensureRunning and audio/engine.ts
// _doInitAudio: a context that is not running races resume() against
// AUDIO_RESUME_DEADLINE_MS (500 ms) and then throws AudioContextNotRunningError
// (Mobile WebKit can leave resume() pending after a page suspension). Does not
// model audio flow, statechange events, the rest of the effects graph or
// engine's shared in-flight init promise.

const AUDIO_RESUME_DEADLINE_MS = 500;

export interface FakeSourceNode {
  readonly id: number;
  readonly trackIds: readonly string[];
  connected: boolean;
  connect(destination: unknown): void;
  disconnect(): void;
}

class WebAudioFake {
  readonly widenerInput = { node: 'widener.input' };
  readonly sources: FakeSourceNode[] = [];
  /** Highest number of sources connected to widener.input at the same time. */
  maxConnected = 0;
  private resumeWaiters: Array<() => void> = [];

  readonly context = {
    state: 'running' as 'running' | 'suspended',
    createMediaStreamSource: (stream: MediaStream): FakeSourceNode => this.createSource(stream),
    resume: (): Promise<void> => this.resume(),
  };

  readonly initAudio = async (): Promise<void> => {
    if (this.context.state !== 'running') {
      await Promise.race([
        this.resume(),
        new Promise<void>((resolve) => setTimeout(resolve, AUDIO_RESUME_DEADLINE_MS)),
      ]);
    }
    const state = this.context.state;
    if (state !== 'running') {
      const error = new Error(`AudioContext did not enter running state (state: ${state})`);
      error.name = 'AudioContextNotRunningError';
      throw error;
    }
  };

  readonly getWidener = (): { input: unknown } => ({ input: this.widenerInput });

  connected(): FakeSourceNode[] {
    return this.sources.filter((source) => source.connected);
  }

  connectedTrackIds(): string[] {
    return this.connected().flatMap((source) => source.trackIds);
  }

  /** The context is suspended and resume() stays pending until finishResume(). */
  suspend(): void {
    this.context.state = 'suspended';
  }

  finishResume(): void {
    this.context.state = 'running';
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  reset(): void {
    this.sources.length = 0;
    this.maxConnected = 0;
    this.context.state = 'running';
    this.resumeWaiters = [];
  }

  private resume(): Promise<void> {
    if (this.context.state === 'running') return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private createSource(stream: MediaStream): FakeSourceNode {
    const node: FakeSourceNode = {
      id: this.sources.length + 1,
      trackIds: stream.getAudioTracks().map((track) => track.id),
      connected: false,
      connect: (destination: unknown) => {
        if (destination !== this.widenerInput) return;
        node.connected = true;
        this.maxConnected = Math.max(this.maxConnected, this.connected().length);
      },
      disconnect: () => {
        node.connected = false;
      },
    };
    this.sources.push(node);
    return node;
  }
}

export const webAudio = new WebAudioFake();

/** Muted decoder-primer elements the real webrtc-audio-decoder-primer.ts keeps in the DOM. */
export function primerElements(): HTMLAudioElement[] {
  return [
    ...document.querySelectorAll<HTMLAudioElement>(
      'audio[data-mxqr-system-audio="webrtc-decoder-primer"]',
    ),
  ];
}

// ─── Media teardown ─────────────────────────────────────────────────
// player/transport.ts stopAllMedia is replaced by a spy: the receive start runs
// it once per reception start. With `captureActive` set, the spy emits
// 'system-audio:force-stop' synchronously, as stopAllMediaLegacy does while
// isSystemAudioCaptureActive() is true (transport.ts). It does not model what
// stopAllMedia stops, nor the capture module's own force-stop reaction
// (stopSystemAudioCapture({ restore: false })): that module is replaced too.

export const media = {
  /** Local system-audio capture is running (the transport's capture probe). */
  captureActive: false,
  stopAllMedia: vi.fn(() => {
    if (media.captureActive) bus.emit('system-audio:force-stop');
  }),
};

// ─── Standard P2P media call ────────────────────────────────────────
// Models the Cloudflare transport's CloudflareMediaConnection as the guest sees
// it (network/transport/cloudflare-signaling.ts): answer(), on(stream|close|
// error), and close(), which emits 'close' synchronously exactly once. The
// call's peerConnection exposes its audio receivers so the playout-delay hint
// is observable. Does not model SDP negotiation on the shared data PC (RO-16).

export interface FakeMediaCall {
  readonly mediaConn: MediaConnection;
  readonly receivers: Array<{ track: MediaStreamTrack; playoutDelayHint?: number }>;
  /** Deliver the remote stream, as the transport's ontrack does after answer(). */
  stream(stream: MediaStream): void;
  closeCount(): number;
}

export function makeMediaCall(peer = 'host-peer-0001'): FakeMediaCall {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const receivers: FakeMediaCall['receivers'] = [];
  let closes = 0;
  let closed = false;
  const mediaConn = {
    peer,
    metadata: { type: 'system-audio' },
    peerConnection: {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      signalingState: 'stable',
      getReceivers: () => receivers,
    },
    answer: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    close: () => {
      if (closed) return;
      closed = true;
      closes += 1;
      handlers.get('close')?.();
    },
  };
  return {
    mediaConn: mediaConn as unknown as MediaConnection,
    receivers,
    stream(stream: MediaStream) {
      for (const track of stream.getAudioTracks()) receivers.push({ track });
      handlers.get('stream')?.(stream);
    },
    closeCount: () => closes,
  };
}

// ─── Cloudflare Realtime (Standard SFU) ─────────────────────────────
// fetchWithCapability for /api/cloudflare-realtime, calibrated against the
// response shapes network/system-audio-sfu.ts reads: new-session returns a
// session id and owner token, a remote tracks-new returns a subscriber offer
// with one mid per requested track, renegotiate and tracks-close return {}.
// Each call takes `latencyMs`, honours the request AbortSignal like fetch, and
// can be made to fail (HTTP 502 with errorDescription) or hang. A hung request
// is not open-ended: callRealtime wraps each request in withRequestDeadline
// (SFU_CONTROL_REQUEST_TIMEOUT_MS, 15 s), so it rejects 15 s after it was sent
// and the subscription's own failure path runs then. Does not model
// capability minting, Turnstile, the second fallback endpoint or response size
// limits.

type RealtimeFault = 'fail' | 'hang';

class RealtimeFake {
  latencyMs = 100;
  readonly requests: Array<{ action: string; sessionId?: string }> = [];
  private faults: Array<{ action: string; fault: RealtimeFault }> = [];
  private sessionSeq = 0;

  readonly fetchWithCapability = (
    _url: RequestInfo | URL,
    _capability: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      action: string;
      sessionId?: string;
      payload?: { tracks?: Array<Record<string, unknown>> };
    };
    this.requests.push({ action: body.action, sessionId: body.sessionId });
    const faultIndex = this.faults.findIndex((entry) => entry.action === body.action);
    const fault = faultIndex >= 0 ? this.faults.splice(faultIndex, 1)[0].fault : null;
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (fault === 'hang') return;
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(
          fault === 'fail'
            ? Response.json({ errorDescription: 'REALTIME_TEST_FAILURE' }, { status: 502 })
            : Response.json(this.respond(body.action, body.payload)),
        );
      }, this.latencyMs);
    });
  };

  /** The next request for `action` fails or never answers. */
  injectFault(action: string, fault: RealtimeFault): void {
    this.faults.push({ action, fault });
  }

  count(action: string): number {
    return this.requests.filter((request) => request.action === action).length;
  }

  reset(): void {
    this.latencyMs = 100;
    this.requests.length = 0;
    this.faults = [];
  }

  private respond(
    action: string,
    payload: { tracks?: Array<Record<string, unknown>> } | undefined,
  ): Record<string, unknown> {
    if (action === 'new-session') {
      const id = ++this.sessionSeq;
      return { sessionId: `rt_guest_session_${id}`, sessionOwnerToken: `rt_owner_${id}` };
    }
    if (action === 'tracks-new') {
      return {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'v=0\r\n' },
        tracks: (payload?.tracks ?? []).map((track, index) => ({ ...track, mid: String(index) })),
      };
    }
    return {};
  }
}

export const realtime = new RealtimeFake();

// ─── RTCPeerConnection (Standard SFU subscriber) ────────────────────
// Models the subscriber PC as system-audio-sfu.ts drives it: after
// setRemoteDescription(offer) one recvonly audio transceiver exposes its remote
// track (Chromium exposes receiver.track at that point), createAnswer and
// setLocalDescription succeed, close() closes without a connectionstatechange
// event (as specified), and a test can push a runtime connection state. Does
// not model ICE, DTLS or ontrack (the adapter also reads existing transceivers).

export class FakeRTCPeerConnection {
  static readonly instances: FakeRTCPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  ontrack: ((event: unknown) => void) | null = null;
  closed = false;
  readonly receiver: { track: MediaStreamTrack; playoutDelayHint?: number };
  private transceivers: Array<{ mid: string; receiver: FakeRTCPeerConnection['receiver'] }> = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly configuration?: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
    this.receiver = {
      track: makeAudioTrack(`sfu-remote-audio-${FakeRTCPeerConnection.instances.length}`),
    };
  }

  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'offer') this.transceivers = [{ mid: '0', receiver: this.receiver }];
  }

  getTransceivers() {
    return this.transceivers;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\n' };
  }

  async setLocalDescription(): Promise<void> {}

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    for (const fn of this.listeners.get('connectionstatechange') ?? []) fn();
  }

  static reset(): void {
    FakeRTCPeerConnection.instances.length = 0;
  }
}

// ─── PRO SFU subscriber transport ───────────────────────────────────
// Replaces network/pro-system-audio-sfu.ts. Calibrated against its subscriber
// contract: subscribe throws synchronously for an expired descriptor,
// deduplicates the same live or in-flight publication (keyed like its
// descriptorKey: generation, session and track name, so a changed expiresAt
// alone is the same publication), retires the previous subscriber (its
// tracks' isCurrent() turns false), emits subscriber-track once per
// subscription and then `subscribed`, and on failure emits `failed` before
// stopping and rejecting. A stopped in-flight attempt rejects without a
// `failed` event, as a superseded attempt does. Each attempt takes `latencyMs`
// (TURN plus three Realtime calls); the failing and slower-than-30 s attempts
// are the field symptoms in docs/design/ownership-gap-fixes-2026-10-22.md (G1).
// Runtime states of a live subscription: emitState() pushes `disconnected` or
// `subscribed` (the connectionstatechange handler's ICE drop and recovery), and
// failLive() models that handler's `failed` branch: `failed` for the active
// descriptor, then an internal stop that emits no `stopped` (the delivered
// track's isCurrent() turns false). A stop the listener makes inside `failed`
// still emits `stopped`, as the real stopProSystemAudioSfuSubscriber does.
// Does not model the subscriber's own expiry timer at the descriptor's
// expiresAt (the publication's liveExpiresAt), the stale- or
// conflicting-generation rejections, the publisher side or any HTTP.

type ProSfuOutcome = 'track' | 'fail' | 'hang';
type ProSfuEvent = Record<string, unknown> & { type: string };

class ProSfuFake {
  latencyMs = 1_000;
  /** Outcomes for the next attempts, in order; then `defaultOutcome`. */
  readonly outcomes: ProSfuOutcome[] = [];
  defaultOutcome: ProSfuOutcome = 'track';
  readonly descriptors: ProSystemAudioSfuPublicationDescriptor[] = [];
  private readonly listeners = new Set<(event: ProSfuEvent) => void>();
  private epoch = 0;
  private key: string | null = null;
  private live = false;
  private descriptor: ProSystemAudioSfuPublicationDescriptor | null = null;
  private pending: { promise: Promise<void>; cancel: () => void } | null = null;

  readonly module = {
    beginProSystemAudioSfuPublisherPreflight: vi.fn(),
    cancelProSystemAudioSfuPublisherPreflight: vi.fn(),
    publishProSystemAudioSfu: vi.fn(),
    stopProSystemAudioSfuPublisher: vi.fn(),
    updateProSystemAudioSfuPublisherExpiry: vi.fn(),
    onProSystemAudioSfuEvent: (listener: (event: ProSfuEvent) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    subscribeProSystemAudioSfu: (value: unknown) => this.subscribe(value),
    stopProSystemAudioSfuSubscriber: () => this.stop(true),
  };

  /** A subscription is live (its track was delivered and nothing stopped it since). */
  get isSubscribed(): boolean {
    return this.live;
  }

  /** Push a runtime subscriber state for the current publication. */
  emitState(state: 'disconnected' | 'subscribed'): void {
    if (!this.descriptor) return;
    this.emit({ type: 'subscriber-state', state, descriptor: this.descriptor });
  }

  /** The live subscription's peer connection fails (pro-system-audio-sfu.ts connectionstatechange). */
  failLive(): void {
    if (!this.live || !this.descriptor) return;
    this.emit({ type: 'subscriber-state', state: 'failed', descriptor: this.descriptor });
    this.stop(false);
  }

  emit(event: ProSfuEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  reset(): void {
    this.stop(false);
    this.latencyMs = 1_000;
    this.defaultOutcome = 'track';
    this.outcomes.length = 0;
    this.descriptors.length = 0;
  }

  private subscribe(value: unknown): Promise<void> {
    const descriptor = value as ProSystemAudioSfuPublicationDescriptor;
    if (descriptor.expiresAt <= Date.now()) {
      throw new TypeError('PRO system-audio SFU publication has expired');
    }
    const key = `${descriptor.generation}:${descriptor.sessionId}:${descriptor.track.trackName}`;
    if (this.key === key && this.live) return Promise.resolve();
    if (this.key === key && this.pending) return this.pending.promise;
    this.stop(false);
    this.descriptors.push(descriptor);
    const epoch = this.epoch;
    const outcome = this.outcomes.shift() ?? this.defaultOutcome;
    this.key = key;
    this.descriptor = descriptor;
    this.emit({ type: 'subscriber-state', state: 'subscribing', descriptor });
    let cancel = (): void => {};
    const promise = new Promise<void>((resolve, reject) => {
      const timer =
        outcome === 'hang'
          ? undefined
          : setTimeout(() => {
              this.pending = null;
              if (outcome === 'fail') {
                this.emit({ type: 'subscriber-state', state: 'failed', descriptor });
                if (this.epoch === epoch) this.stop(false);
                reject(new Error('REALTIME_SESSION_FAILED'));
                return;
              }
              this.live = true;
              this.emit({
                type: 'subscriber-track',
                descriptor,
                track: makeAudioTrack(`pro-sfu-audio-${this.descriptors.length}`),
                receiver: {},
                isCurrent: () => this.epoch === epoch,
              });
              this.emit({ type: 'subscriber-state', state: 'subscribed', descriptor });
              resolve();
            }, this.latencyMs);
      cancel = () => {
        clearTimeout(timer);
        reject(new Error('PRO_SYSTEM_AUDIO_SFU_SUPERSEDED'));
      };
    });
    promise.catch(() => undefined);
    this.pending = { promise, cancel };
    return promise;
  }

  private stop(emitStopped: boolean): void {
    const hadState = this.key !== null;
    const descriptor = this.descriptor;
    this.epoch += 1;
    this.key = null;
    this.live = false;
    this.descriptor = null;
    const pending = this.pending;
    this.pending = null;
    pending?.cancel();
    if (emitStopped && hadState)
      this.emit({ type: 'subscriber-state', state: 'stopped', descriptor });
  }
}

export const proSfu = new ProSfuFake();

// ─── PRO LAN-direct transport ───────────────────────────────────────
// Replaces network/pro-system-audio-direct.ts. Captures the service's callbacks
// from configureProSystemAudioDirectTransport. Calibrated against the receiver
// side: activation records the active publication and retires a receiver route
// of another publication; reset retires every route; a track is handed over
// once per route through a microtask with isCurrent() bound to the route and the
// active publication, and a rejected handoff fails the route into a receiver
// fallback (maybeDeliverReceiverTrack); a receiver fallback closes the route and
// calls onLiveRouteFallback. Does not model SDP/ICE signaling, offer
// authorization, the publisher side or the transport's own 5 s receiver
// track-ready timeout.

interface DirectCallbacks {
  onReceiverTrackReady: (event: ProSystemAudioDirectTrackReadyEvent) => void | Promise<void>;
  onLiveRouteFallback: (event: ProSystemAudioDirectFallbackEvent) => void;
}

interface DirectPublication {
  ownerParticipantId: string;
  generation: number;
  publicationId: string;
}

class ProDirectFake {
  callbacks: DirectCallbacks | null = null;
  active: DirectPublication | null = null;
  activations = 0;
  private route: { live: boolean; publication: DirectPublication } | null = null;

  readonly module = {
    configureProSystemAudioDirectTransport: (callbacks: DirectCallbacks) => {
      this.callbacks = callbacks;
    },
    attemptProSystemAudioDirectPublication: vi.fn(async () => null),
    activateProSystemAudioDirectPublication: async (publication: DirectPublication) => {
      this.activations += 1;
      if (this.route && !samePublication(this.route.publication, publication)) this.closeRoute();
      this.active = { ...publication };
      return true;
    },
    reconcileProSystemAudioDirectTargets: vi.fn(async () => true),
    resetProSystemAudioDirectTransport: () => {
      this.closeRoute();
      this.active = null;
    },
  };

  /** The publisher's offer arrived and its track is ready on a live route. */
  deliverTrack(track = makeAudioTrack()): { isCurrent: () => boolean } {
    const publication = this.active;
    if (!publication || !this.callbacks) throw new Error('No active direct publication');
    this.closeRoute();
    const route = { live: true, publication };
    this.route = route;
    const isCurrent = () =>
      this.route === route &&
      route.live &&
      this.active !== null &&
      samePublication(this.active, route.publication);
    const callbacks = this.callbacks;
    void Promise.resolve()
      .then(() =>
        callbacks.onReceiverTrackReady({
          ...publication,
          negotiationId: 'negotiation_0001',
          track,
          isCurrent,
        }),
      )
      .catch(() => {
        if (this.route === route && route.live) this.receiverFallback('track-handoff-failed');
      });
    return { isCurrent };
  }

  receiverFallback(reason = 'receiver-connection-failed'): void {
    const route = this.route;
    if (!route) return;
    this.closeRoute();
    this.callbacks?.onLiveRouteFallback({
      role: 'receiver',
      reason,
      participantId: route.publication.ownerParticipantId,
      generation: route.publication.generation,
      publicationId: route.publication.publicationId,
    });
  }

  reset(): void {
    this.closeRoute();
    this.active = null;
    this.activations = 0;
  }

  private closeRoute(): void {
    if (this.route) this.route.live = false;
    this.route = null;
  }
}

function samePublication(a: DirectPublication, b: DirectPublication): boolean {
  return (
    a.ownerParticipantId === b.ownerParticipantId &&
    a.generation === b.generation &&
    a.publicationId === b.publicationId
  );
}

export const proDirect = new ProDirectFake();

// ─── Globals and observations ───────────────────────────────────────

/** jsdom has no MediaStream or RTCPeerConnection, and its media play() is unimplemented. */
export function installNativeGlobals(): void {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
  // Muted autoplay of the primer element succeeds; pausing it is synchronous.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
}

export function resetNativeFakes(): void {
  webAudio.reset();
  realtime.reset();
  FakeRTCPeerConnection.reset();
  proSfu.reset();
  proDirect.reset();
  media.captureActive = false;
  media.stopAllMedia.mockClear();
}

export interface ReceiveObservations {
  readonly toasts: string[];
  /** Every playback.activity value written, in order (idle flashes included). */
  readonly activities: string[];
  counts: {
    receiveTimeouts: number;
    visualizerStarts: number;
    hostStarted: number;
    deliveryHandoffs: number;
    forceStops: number;
  };
  dispose(): void;
}

/** Bus observations at the receive owner boundary, scoped to one test. */
export function observeReceiveBoundary(): ReceiveObservations {
  const scope = createBusScope();
  const observations: ReceiveObservations = {
    toasts: [],
    activities: [],
    counts: {
      receiveTimeouts: 0,
      visualizerStarts: 0,
      hostStarted: 0,
      deliveryHandoffs: 0,
      forceStops: 0,
    },
    dispose: () => scope.dispose(),
  };
  scope.on('ui:show-toast', (message) => observations.toasts.push(String(message)));
  scope.on('state:playback.activity', (value) => observations.activities.push(String(value)));
  scope.on('system-audio:receive-timeout', () => (observations.counts.receiveTimeouts += 1));
  scope.on('visualizer:start', () => (observations.counts.visualizerStarts += 1));
  scope.on('system-audio:host-started', () => (observations.counts.hostStarted += 1));
  scope.on('system-audio:delivery-handoff', () => (observations.counts.deliveryHandoffs += 1));
  scope.on('system-audio:force-stop', () => (observations.counts.forceStops += 1));
  return observations;
}
