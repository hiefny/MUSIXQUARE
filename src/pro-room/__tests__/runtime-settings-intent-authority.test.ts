/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEQ, setReverbParam, setSettingsSyncEnabled } from '../../audio/effects.ts';
import {
  createDefaultRoomEffectsState,
  type ProRoomSettingsSyncSnapshot,
} from '../../core/room-effects.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { joinProRoom } from '../runtime.ts';

const ROOM = '000001';
const ITEM = '56000000-0000-4000-8000-000000000001' as QueueItemId;
const nativeCreateSession = ProRoomApiClient.prototype.createSession;
const nativeGetSettings = ProRoomApiClient.prototype.getSettingsSync;
const nativePutSettings = ProRoomApiClient.prototype.updateSettingsSync;
const nativeHeartbeat = ProRoomApiClient.prototype.heartbeat;
function snapshot(revision = 1, canMutateQueue = true): ProRoomSnapshot {
  const permissions: ProRoomPermissionSet = {
    'media.add': canMutateQueue,
    'playback.control': true,
    'members.kick': false,
    'chat.notice': false,
  };
  const capabilities = [...capabilitiesForProRoomRole('controller', permissions)];
  const member = {
    memberId: 'member_0000000002',
    memberDisplayNumber: 1,
    isAuthenticated: true,
    displayName: 'Controller',
    role: 'controller' as const,
  };
  return {
    schemaVersion: 1,
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      { queueItemId: ITEM, name: 'Track', source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
    ],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 1,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 1,
      revision,
      coordinatorParticipantId: null,
      participants: [
        {
          ...member,
          participantId: 'participant_00002',
          capabilities,
          devicePlatform: 'other',
          joinedAtMs: 1,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      ...member,
      participantId: 'participant_00002',
      presenceIncarnationId: 'presence_0000000002',
      capabilities,
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_0000000001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        onlineDeviceCount: 0,
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
      },
      { ...member, permissions, inheritedPermissions: [], onlineDeviceCount: 1 },
    ],
  };
}

type SocketEvent = { data?: unknown; reason: string };
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();
  constructor(
    readonly url: string,
    readonly protocols: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatch('open'));
  }
  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState !== FakeWebSocket.CLOSED) this.dispatch('close');
  }
  dispatch(type: string, data?: unknown): void {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN;
    if (type === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(type) ?? []) listener({ data, reason: '' });
  }
}

describe('PRO settings field intent across authority and HTTP responses', () => {
  let canonical: ProRoomSnapshot;
  let settings: ProRoomSettingsSyncSnapshot;
  type SettingsPut = Omit<Parameters<ProRoomApiClient['updateSettingsSync']>[0], 'code'>;
  let puts: SettingsPut[];
  let body: ReadableStreamDefaultController<Uint8Array>;
  let response: Response | undefined;
  let cancelled: boolean;
  let holdPut: boolean;
  let firstStatus: number;
  let sequence: number;
  let holdRead: boolean;
  let readStatus: number;
  let readBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  let readCancelled: boolean;
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  };
  beforeEach(async () => {
    localStorage.removeItem('musixquare-settings-sync');
    resetState();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    (
      window as Window & { __MUSIXQUARE_TRANSPORT__?: Record<string, unknown> }
    ).__MUSIXQUARE_TRANSPORT__ = {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
    };
    canonical = snapshot();
    settings = {
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM,
      revision: 0,
      updatedAtMs: 1,
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    };
    puts = [];
    cancelled = false;
    holdPut = true;
    firstStatus = 403;
    sequence = 0;
    holdRead = false;
    readStatus = 200;
    readBody = undefined;
    readCancelled = false;
    const client = new ProRoomApiClient({
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/sessions'))
          return Response.json({
            snapshot: canonical,
            session: { expiresAtMs: Date.now() + 60000 },
          });
        if (path.endsWith('/presence/heartbeat')) return Response.json({ snapshot: canonical });
        expect(path.endsWith('/settings-sync')).toBe(true);
        if (init?.method === 'GET') {
          const payload = readStatus === 200 ? settings : { error: 'CAPABILITY_REQUIRED' };
          if (holdRead) {
            holdRead = false;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  readBody = c;
                  c.enqueue(new TextEncoder().encode(JSON.stringify(payload).slice(0, -1)));
                },
                cancel() {
                  readCancelled = true;
                },
              }),
              { status: readStatus, headers: { 'content-type': 'application/json' } },
            );
          }
          return Response.json(payload, { status: readStatus });
        }
        const request = JSON.parse(String(init?.body)) as SettingsPut;
        puts.push(request);
        if (holdPut) {
          holdPut = false;
          const payload =
            firstStatus === 200
              ? {
                  ...settings,
                  revision: 1,
                  masterVolume: request.masterVolume,
                  effects: request.effects,
                }
              : {
                  error:
                    firstStatus === 403
                      ? 'CAPABILITY_REQUIRED'
                      : firstStatus === 409
                        ? 'SETTINGS_SYNC_REVISION_CONFLICT'
                        : 'TEMPORARILY_UNAVAILABLE',
                };
          if (!('error' in payload)) {
            settings = payload;
            canonical = { ...canonical, revision: canonical.revision + 1, effectsRevision: 1 };
          }
          response = new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                body = c;
                c.enqueue(new TextEncoder().encode(JSON.stringify(payload).slice(0, -1)));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: firstStatus, headers: { 'content-type': 'application/json' } },
          );
          return response;
        }
        expect(canonical.viewer?.capabilities).toContain('effects.control');
        if (request.baseRevision !== settings.revision)
          return Response.json({ error: 'SETTINGS_SYNC_REVISION_CONFLICT' }, { status: 409 });
        settings = {
          ...settings,
          revision: settings.revision + 1,
          masterVolume: request.masterVolume,
          effects: request.effects,
        };
        canonical = {
          ...canonical,
          revision: canonical.revision + 1,
          effectsRevision: settings.revision,
        };
        return Response.json(settings);
      },
    });
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockImplementation((i, s) =>
      nativeCreateSession.call(client, i, s),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation((c, s, k) =>
      nativeHeartbeat.call(client, c, s, k),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockImplementation((c, s) =>
      nativeGetSettings.call(client, c, s),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'updateSettingsSync').mockImplementation((i, s) =>
      nativePutSettings.call(client, i, s),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockImplementation(async () => ({
      ticket: `${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
      expiresAtMs: Date.now() + 60000,
      role: 'member',
      coordinatorEpoch: 1,
      presenceIncarnationId: canonical.viewer!.presenceIncarnationId,
      ticketSequence: ++sequence,
      pendingPlaybackTransition: null,
    }));
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM,
      revision: 0,
      playlistRevision: 1,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined);
    vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined);
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.getSettingsSync).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    setState('setup.sessionStarted', true);
    vi.useFakeTimers();
  });
  afterEach(async () => {
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await settle();
    clearAllManagedTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as Window & { __MUSIXQUARE_TRANSPORT__?: Record<string, unknown> })
      .__MUSIXQUARE_TRANSPORT__;
    resetState();
  });
  function frame(event: unknown) {
    FakeWebSocket.instances.at(-1)!.dispatch(
      'message',
      JSON.stringify({
        type: 'pro-server-event',
        version: 1,
        roomCode: ROOM,
        coordinatorEpoch: 1,
        event,
      }),
    );
  }
  async function authority(allow: boolean) {
    const revision = canonical.revision + 1;
    const role = allow ? 'controller' : 'member';
    const capabilities = allow
      ? [...snapshot().viewer!.capabilities]
      : [...capabilitiesForProRoomRole(role)];
    canonical = {
      ...canonical,
      revision,
      viewer: { ...canonical.viewer!, role, capabilities },
      presence: {
        ...canonical.presence,
        revision,
        participants: canonical.presence.participants.map((p) => ({ ...p, role, capabilities })),
      },
      administrators: allow ? snapshot().administrators : snapshot().administrators!.slice(0, 1),
    };
    frame({ type: 'pro-presence-snapshot', presenceRevision: revision });
    await vi.waitFor(() =>
      expect(getState('room.context').capabilities.includes('effects.control')).toBe(allow),
    );
  }
  function finish() {
    if (!cancelled) {
      body.enqueue(new TextEncoder().encode('}'));
      body.close();
    }
  }
  async function editVolume() {
    setState('audio.masterVolume', 0.4);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(response?.body?.locked).toBe(true);
  }

  it.each([403, 409, 503])(
    'retired denied volume must not publish via fresh reverb after revoke/regrant (%i)',
    async (status) => {
      firstStatus = status;
      await editVolume();
      await authority(false);
      await authority(true);
      finish();
      await vi.advanceTimersByTimeAsync(1300);
      expect(puts).toHaveLength(1);
      expect(settings.masterVolume).toBe(1);
      setState('audio.reverbMix', 0.31);
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(2);
      expect(settings.effects.reverb.mixPercent).toBe(31);
      expect(settings.masterVolume).toBe(1);
    },
  );
  it('healthy pending volume remains part of a fresh reverb edit without revocation', async () => {
    firstStatus = 200;
    await editVolume();
    setState('audio.reverbMix', 0.31);
    finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(settings.masterVolume).toBe(0.4);
    expect(settings.effects.reverb.mixPercent).toBe(31);
  });
  it('revoked controller cannot publish a fresh local state change while still revoked', async () => {
    await editVolume();
    await authority(false);
    finish();
    await vi.advanceTimersByTimeAsync(1300);
    setState('audio.reverbMix', 0.31);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(settings.masterVolume).toBe(1);
    expect(settings.effects.reverb.mixPercent).toBe(0);
  });
  it('explicit settings OFF-to-ON intentionally publishes the retained full local state', async () => {
    await editVolume();
    await authority(false);
    await authority(true);
    finish();
    await vi.advanceTimersByTimeAsync(1300);
    setSettingsSyncEnabled(false);
    setState('audio.reverbMix', 0.31);
    setSettingsSyncEnabled(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(settings.masterVolume).toBe(0.4);
    expect(settings.effects.reverb.mixPercent).toBe(31);
  });

  function remoteSettings(volume = 0.8): void {
    settings = { ...settings, revision: settings.revision + 1, masterVolume: volume };
    canonical = {
      ...canonical,
      revision: canonical.revision + 1,
      effectsRevision: settings.revision,
    };
  }
  function finishRead(): void {
    if (readBody && !readCancelled) {
      readBody.enqueue(new TextEncoder().encode('}'));
      readBody.close();
    }
  }
  function invalidateSettings(): void {
    frame({
      type: 'pro-room-invalidated',
      roomRevision: canonical.revision,
      effectsRevision: settings.revision,
    });
  }

  it.each([403, 409, 503])(
    'preserves a newer owner volume under fresh reverb after revocation while HTTP %i waits',
    async (status) => {
      firstStatus = status;
      await editVolume();
      await authority(false);
      remoteSettings();
      await authority(true);
      setReverbParam('mix', 31);
      finish();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(2);
      expect(puts[1]).toMatchObject({
        baseRevision: 1,
        masterVolume: 0.8,
        effects: { reverb: { mixPercent: 31 } },
      });
      expect(getState('audio.masterVolume')).toBe(0.8);
    },
  );

  it('preserves only new intent when authority changes during the conflict reconciliation GET', async () => {
    firstStatus = 409;
    await editVolume();
    remoteSettings();
    holdRead = true;
    finish();
    await vi.waitFor(() => expect(readBody).toBeDefined());
    await authority(false);
    await authority(true);
    setReverbParam('mix', 31);
    finishRead();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.masterVolume).toBe(0.8);
    expect(settings.effects.reverb.mixPercent).toBe(31);
  });

  it('adopts remote canonical settings without retrying when no post-regrant gesture exists', async () => {
    await editVolume();
    await authority(false);
    remoteSettings();
    await authority(true);
    finish();
    await vi.advanceTimersByTimeAsync(1400);
    expect(puts).toHaveLength(1);
    expect(settings.masterVolume).toBe(0.8);
    expect(getState('audio.masterVolume')).toBe(0.8);
  });

  it('keeps a fresh volume gesture even when it returns to the retired value', async () => {
    await editVolume();
    await authority(false);
    remoteSettings();
    await authority(true);
    setState('audio.masterVolume', 0.6);
    setState('audio.masterVolume', 0.4);
    finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.masterVolume).toBe(0.4);
  });

  it('does not republish a retired volume after a new gesture without an intervening canonical GET', async () => {
    await editVolume();
    await authority(false);
    await authority(true);
    finish();
    await vi.advanceTimersByTimeAsync(1400);
    setEQ(2, 4);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.masterVolume).toBe(1);
    expect(settings.effects.equalizer.bandsDb[2]).toBe(4);
  });

  it('retains a fresh reverb gesture when an older terminal denial retires only its volume field', async () => {
    await editVolume();
    setReverbParam('mix', 31);
    finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.masterVolume).toBe(1);
    expect(settings.effects.reverb.mixPercent).toBe(31);
  });

  it('retires only the earlier volume when its pre-PUT canonical read is denied after a newer reverb gesture', async () => {
    holdPut = false;
    remoteSettings();
    readStatus = 403;
    invalidateSettings();
    await settle();
    expect(ProRoomApiClient.prototype.getSettingsSync).toHaveBeenCalledTimes(2);
    holdRead = true;
    setState('audio.masterVolume', 0.4);
    await vi.advanceTimersByTimeAsync(400);
    expect(readBody).toBeDefined();
    expect(puts).toHaveLength(0);
    setReverbParam('mix', 31);
    readStatus = 200;
    finishRead();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(settings.masterVolume).toBe(0.8);
    expect(settings.effects.reverb.mixPercent).toBe(31);
  });

  it('keeps a current volume intent through a genuine conflict when authority never changes', async () => {
    firstStatus = 409;
    await editVolume();
    remoteSettings();
    settings.effects.reverb.mixPercent = 42;
    finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.masterVolume).toBe(0.4);
    expect(settings.effects.reverb.mixPercent).toBe(42);
  });

  it('keeps unrelated EQ bands independent across cancellation and a remote settings update', async () => {
    setEQ(0, 3);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    await authority(false);
    remoteSettings();
    settings.effects.equalizer.bandsDb[0] = -4;
    await authority(true);
    setEQ(1, 5);
    finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.masterVolume).toBe(0.8);
    expect(settings.effects.equalizer.bandsDb).toEqual([-4, 5, 0, 0, 0]);
  });

  it('keeps different reverb fields independent after revocation', async () => {
    setReverbParam('mix', 30);
    await vi.advanceTimersByTimeAsync(400);
    await authority(false);
    remoteSettings();
    settings.effects.reverb.mixPercent = 50;
    await authority(true);
    setReverbParam('decay', 8);
    finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.effects.reverb).toMatchObject({ mixPercent: 50, decaySeconds: 8 });
  });

  it('retires a debounced volume before its first request without erasing a later reverb gesture', async () => {
    holdPut = false;
    setState('audio.masterVolume', 0.4);
    await authority(false);
    remoteSettings();
    await authority(true);
    setReverbParam('mix', 31);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(settings.masterVolume).toBe(0.8);
    expect(settings.effects.reverb.mixPercent).toBe(31);
  });

  it('does not treat canonical application as another local field gesture', async () => {
    holdPut = false;
    remoteSettings();
    settings.effects.reverb.mixPercent = 50;
    invalidateSettings();
    await vi.waitFor(() => expect(getState('audio.masterVolume')).toBe(0.8));
    remoteSettings(0.7);
    settings.effects.reverb.mixPercent = 60;
    invalidateSettings();
    await vi.waitFor(() => expect(getState('audio.masterVolume')).toBe(0.7));
    expect(puts).toHaveLength(0);
    setEQ(3, 4);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(settings.masterVolume).toBe(0.7);
    expect(settings.effects.reverb.mixPercent).toBe(60);
  });

  it('preserves explicit full-state takeover over an unseen remote revision', async () => {
    await editVolume();
    await authority(false);
    remoteSettings();
    await authority(true);
    setSettingsSyncEnabled(false);
    setReverbParam('mix', 31);
    setSettingsSyncEnabled(true);
    finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.masterVolume).toBe(0.4);
    expect(settings.effects.reverb.mixPercent).toBe(31);
  });

  it('isolates an old denied PUT from fresh edits after leaving and rejoining the same room', async () => {
    await editVolume();
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    canonical = snapshot(10);
    canonical.viewer = { ...canonical.viewer!, presenceIncarnationId: 'presence_0000000003' };
    remoteSettings();
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(getState('audio.masterVolume')).toBe(0.8));
    setState('setup.sessionStarted', true);
    setReverbParam('mix', 31);
    finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(settings.masterVolume).toBe(0.8);
    expect(settings.effects.reverb.mixPercent).toBe(31);
  });
});
