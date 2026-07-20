/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';
import { setPlaybackIdle, setPlaybackSystemAudioPlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import { broadcastYouTubeSync, guestRendezvousSync } from '../../youtube/sync.ts';
import { showToast } from '../toast.ts';
import { __resetAccountStateForTests, applyAccountSession } from '../../account/state.ts';
import {
  getRoleLabelByChannelMode,
  getStandardRolePreset,
  getInviteCode,
  initPlayerControls,
  updateRoleBadge,
} from '../player-controls.ts';

const PLAY_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const PAUSE_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002';

const zeroStartFacade = vi.hoisted(() => ({ active: false }));

const proPlaybackRuntime = vi.hoisted(() => ({
  reconcile: vi.fn<() => Promise<boolean>>(),
}));

const proSystemAudio = vi.hoisted(() => ({
  view: {
    roomCode: '000001',
    initialized: true,
    phase: 'idle' as 'idle' | 'preparing' | 'live',
    generation: 0 as number | null,
    ownerParticipantId: null as string | null,
    isLocalOwner: false,
    localRequestPending: false,
    canStart: true,
    canStop: false,
    claimExpiresAt: null as number | null,
    liveExpiresAt: null as number | null,
    publication: null,
  },
  ownerName: null as string | null,
  coordinatorCompatible: true,
}));

vi.mock('../../youtube/sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
  guestRendezvousSync: vi.fn(),
}));

vi.mock('../../youtube/zero-start.ts', () => ({
  isYouTubeZeroStartProtocolActive: vi.fn(() => zeroStartFacade.active),
}));

vi.mock('../../pro-room/runtime.ts', () => ({
  requestActiveProRoomPlaybackReconciliation: proPlaybackRuntime.reconcile,
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../../pro-room/system-audio-bridge.ts', () => ({
  canPublishProSystemAudioWithCurrentCoordinator: vi.fn(() => proSystemAudio.coordinatorCompatible),
  getProSystemAudioOwnerDisplayName: vi.fn(() => proSystemAudio.ownerName),
  getProSystemAudioViewState: vi.fn(() => ({ ...proSystemAudio.view })),
  isLocalProSystemAudioOwner: vi.fn(() => proSystemAudio.view.isLocalOwner),
}));

beforeEach(() => {
  __resetAccountStateForTests();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  vi.clearAllMocks();
  Object.assign(proSystemAudio.view, {
    roomCode: '000001',
    initialized: true,
    phase: 'idle',
    generation: 0,
    ownerParticipantId: null,
    isLocalOwner: false,
    localRequestPending: false,
    canStart: true,
    canStop: false,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  });
  proSystemAudio.ownerName = null;
  proSystemAudio.coordinatorCompatible = true;
  zeroStartFacade.active = false;
  proPlaybackRuntime.reconcile.mockResolvedValue(true);
  document.body.innerHTML = '';
});

afterEach(() => {
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  bus.clear();
});

function makeConnection(peer: string): DataConnection {
  return { peer, open: true } as DataConnection;
}

describe('getRoleLabelByChannelMode', () => {
  it('returns Original for mode 0', () => {
    expect(getRoleLabelByChannelMode(0)).toBe('Original');
  });

  it('returns Left for mode -1', () => {
    expect(getRoleLabelByChannelMode(-1)).toBe('Left');
  });

  it('returns Right for mode 1', () => {
    expect(getRoleLabelByChannelMode(1)).toBe('Right');
  });

  it('returns Woofer for mode 2', () => {
    expect(getRoleLabelByChannelMode(2)).toBe('Woofer');
  });

  it('falls back to Original for unknown mode', () => {
    expect(getRoleLabelByChannelMode(99)).toBe('Original');
  });
});

describe('getStandardRolePreset', () => {
  it('returns center preset for mode 0', () => {
    const preset = getStandardRolePreset(0);
    expect(preset.labelKey).toBe('common.original');
    expect(preset.placementToastKey).toBe('role.center_placement');
  });

  it('returns left preset for mode -1', () => {
    const preset = getStandardRolePreset(-1);
    expect(preset.labelKey).toBe('common.left');
    expect(preset.placementToastKey).toBe('role.left_placement');
  });

  it('returns right preset for mode 1', () => {
    const preset = getStandardRolePreset(1);
    expect(preset.labelKey).toBe('common.right');
    expect(preset.placementToastKey).toBe('role.right_placement');
  });

  it('falls back to Original preset for unknown mode', () => {
    const preset = getStandardRolePreset(99);
    expect(preset.labelKey).toBe('common.original');
    expect(preset.placementToastKey).toBe('role.center_placement');
  });
});

describe('getInviteCode', () => {
  it('returns sessionCode when valid 6-digit', () => {
    setState('network.sessionCode', '123456');
    expect(getInviteCode()).toBe('123456');
  });

  it('returns lastJoinCode when sessionCode is empty', () => {
    setState('network.sessionCode', '');
    setState('network.lastJoinCode', '654321');
    expect(getInviteCode()).toBe('654321');
  });

  it('returns ------ when both are empty', () => {
    setState('network.sessionCode', '');
    setState('network.lastJoinCode', '');
    expect(getInviteCode()).toBe('------');
  });

  it('returns ------ when sessionCode is invalid format', () => {
    setState('network.sessionCode', 'abc');
    setState('network.lastJoinCode', '');
    expect(getInviteCode()).toBe('------');
  });

  it('prefers sessionCode over lastJoinCode', () => {
    setState('network.sessionCode', '111111');
    setState('network.lastJoinCode', '222222');
    expect(getInviteCode()).toBe('111111');
  });
});

describe('updateRoleBadge', () => {
  function renderBadge(): HTMLElement {
    document.body.innerHTML = `
      <div class="role-badge" id="role-badge">
        <span class="role-dot"></span>
        <span id="role-text"></span>
      </div>
    `;
    return document.getElementById('role-badge') as HTMLElement;
  }

  it('shows LOGIN for an anonymous user regardless of the network route', () => {
    const badge = renderBadge();
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.myDeviceLabel', 'GUEST 1');
    setState('network.connectionType', 'remote');
    setState('sync.lastLatencyMs', 42);

    updateRoleBadge();

    expect(badge.classList.contains('connected')).toBe(false);
    expect(badge.classList.contains('remote')).toBe(false);
    expect(document.getElementById('role-text')?.textContent).toBe('LOGIN');
    expect(document.querySelector('.badge-ping')).toBeNull();
  });

  it('shows the authenticated nickname with the account style', () => {
    const badge = renderBadge();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
    });

    updateRoleBadge();

    expect(badge.classList.contains('account-authenticated')).toBe(true);
    expect(badge.classList.contains('remote')).toBe(false);
    expect(document.getElementById('role-text')?.textContent).toBe('Minsu');
  });

  it('reacts to the account role-badge refresh event', () => {
    renderBadge();
    initPlayerControls();

    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Living Room', profileComplete: true },
    });
    bus.emit('network:role-badge-update');

    expect(document.getElementById('role-text')?.textContent).toBe('Living Room');
  });

  it('does not let PRO transport identity replace the account identity', () => {
    const badge = renderBadge();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Account Name', profileComplete: true },
    });
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('network.myDeviceLabel', 'Listening Room');
    setState('network.connectionType', 'remote');
    setState('sync.lastLatencyMs', 87);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });

    updateRoleBadge();

    expect(badge.classList.contains('connected')).toBe(false);
    expect(badge.classList.contains('remote')).toBe(false);
    expect(badge.classList.contains('pro-equal')).toBe(false);
    expect(badge.classList.contains('account-authenticated')).toBe(true);
    expect(document.getElementById('role-text')?.textContent).toBe('Account Name');
    expect(document.querySelector('.badge-ping')).toBeNull();
  });

  it('pulses the role dot twice per host-clock second', () => {
    vi.useFakeTimers();
    try {
      const badge = renderBadge();
      const dot = badge.querySelector('.role-dot') as HTMLElement;
      vi.setSystemTime(0);
      setState('network.appRole', 'host');

      updateRoleBadge();
      expect(dot.classList.contains('clock-beat')).toBe(true);

      vi.advanceTimersByTime(120);
      expect(dot.classList.contains('clock-beat')).toBe(false);

      vi.advanceTimersByTime(119);
      expect(dot.classList.contains('clock-beat')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(dot.classList.contains('clock-beat')).toBe(true);

      vi.advanceTimersByTime(120);
      expect(dot.classList.contains('clock-beat')).toBe(false);

      vi.advanceTimersByTime(640);
      expect(dot.classList.contains('clock-beat')).toBe(true);
    } finally {
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });
});

describe('local file picker hint', () => {
  it('lists every extension supported by the MIME fallback contract', () => {
    document.body.innerHTML = '<input id="file-input" type="file" />';

    initPlayerControls();

    expect((document.getElementById('file-input') as HTMLInputElement).accept).toBe(
      '.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.webm,.aif,.aiff,.caf,audio/*',
    );
  });
});

describe('PRO room media-source capabilities', () => {
  it('restores the ordinary host affordance when setup changes idle to host', () => {
    document.body.innerHTML = `
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
    `;

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('0.15');

    setState('network.appRole', 'host');

    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('');
  });

  it('updates the standard ADMIN media affordance immediately on grant and revoke', () => {
    document.body.innerHTML = `
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
    `;
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('0.15');

    setState('network.isOperator', true);
    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('');

    setState('network.isOperator', false);
    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('0.15');
  });

  it('uses the explicit media.add capability instead of the legacy operator role', () => {
    document.body.innerHTML = `
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
    `;
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('0.15');

    setState('network.standardRoomCapabilities', ['media.add', 'asset.upload']);
    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('');
  });

  it('keeps repeat and shuffle owner-only even for a delegated administrator', () => {
    document.body.innerHTML = `
      <button id="btn-repeat"></button>
      <button id="btn-shuffle"></button>
    `;
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', [
      'media.add',
      'playback.control',
      'asset.upload',
      'members.manage',
    ]);
    const repeat = vi.fn();
    const shuffle = vi.fn();
    bus.on('playlist:toggle-repeat', repeat);
    bus.on('playlist:toggle-shuffle', shuffle);

    initPlayerControls();
    document.getElementById('btn-repeat')?.click();
    document.getElementById('btn-shuffle')?.click();

    expect(document.getElementById('btn-repeat')?.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById('btn-shuffle')?.getAttribute('aria-disabled')).toBe('true');
    expect(repeat).not.toHaveBeenCalled();
    expect(shuffle).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(t('toast.host_only_control'));
  });

  it('lets a PRO administrator add files and YouTube entries but keeps live capture owner-only', () => {
    document.body.innerHTML = `
      <button id="btn-add-media"></button>
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
      <div id="media-source-overlay"></div>
      <button id="btn-local-file"></button>
      <input id="file-input" type="file" />
      <button id="btn-youtube-source"></button>
      <div id="youtube-url-overlay"></div>
      <div id="youtube-url-input"></div>
      <button id="btn-system-audio"></button>
    `;
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add', 'asset.upload'],
    });
    const input = document.getElementById('file-input') as HTMLInputElement;
    const inputClick = vi.spyOn(input, 'click');

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('');
    document.getElementById('btn-add-media')?.click();
    expect(document.getElementById('media-source-overlay')?.classList.contains('active')).toBe(
      true,
    );

    document.getElementById('btn-local-file')?.click();
    expect(inputClick).toHaveBeenCalledTimes(1);

    document.getElementById('btn-youtube-source')?.click();
    expect(document.getElementById('youtube-url-overlay')?.classList.contains('active')).toBe(true);

    expect(document.getElementById('btn-system-audio')?.hidden).toBe(true);
  });

  it('shows the current owner and never starts a second PRO picker', () => {
    document.body.innerHTML = `
      <button id="btn-add-media"></button>
      <div id="media-source-overlay"></div>
      <button id="btn-system-audio"><span class="media-source-label-text"></span></button>
    `;
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add', 'asset.upload', 'system-audio.publish'],
    });
    Object.assign(proSystemAudio.view, {
      initialized: true,
      phase: 'live',
      generation: 9,
      ownerParticipantId: 'participant-2',
      canStart: false,
    });
    proSystemAudio.ownerName = 'Peer 2';
    const startSpy = vi.fn();
    bus.on('system-audio:start', startSpy);

    initPlayerControls();
    document.getElementById('btn-add-media')?.click();
    document.getElementById('btn-system-audio')?.click();

    expect(startSpy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(t('system_audio.owner_active', { name: 'Peer 2' }));
  });

  it('reports an unavailable PRO publishing capability before opening the native picker', () => {
    document.body.innerHTML = `
      <button id="btn-add-media"></button>
      <div id="media-source-overlay"></div>
      <button id="btn-system-audio"><span class="media-source-label-text"></span></button>
    `;
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add', 'asset.upload', 'system-audio.publish'],
    });
    proSystemAudio.coordinatorCompatible = false;
    const startSpy = vi.fn();
    bus.on('system-audio:start', startSpy);

    initPlayerControls();
    document.getElementById('btn-add-media')?.click();
    document.getElementById('btn-system-audio')?.click();

    expect(startSpy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(t('system_audio.coordinator_update_required'));
  });

  it('keeps standard-room live capture coordinator-only', () => {
    document.body.innerHTML = '<button id="btn-system-audio"></button>';
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    const startSpy = vi.fn();
    bus.on('system-audio:start', startSpy);

    initPlayerControls();
    document.getElementById('btn-system-audio')?.click();

    expect(startSpy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(t('toast.host_only_media'));
  });
});

describe('initPlayerControls playback mode rendering', () => {
  function renderPlaybackControls(): void {
    document.body.innerHTML = `
      <button id="play-btn"><svg><path d=""></path></svg></button>
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
    `;
  }

  it('renders the current playback mode immediately and stays reactive afterward', () => {
    renderPlaybackControls();
    setPlaybackSystemAudioPlaying();

    initPlayerControls();

    const icon = document.querySelector('#play-btn path');
    const mediaBtn = document.getElementById('btn-media-source');
    const mediaLabel = mediaBtn?.querySelector('span');

    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    expect(mediaLabel?.getAttribute('data-i18n')).toBe('system_audio.stop');

    setPlaybackIdle();

    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');
    expect(mediaLabel?.getAttribute('data-i18n')).toBe('player.play_media');
    expect(mediaBtn?.classList.contains('sys-audio-guest')).toBe(false);
  });

  it('uses playback mode for YouTube play-state events', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();

    const icon = document.querySelector('#play-btn path');
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');

    bus.emit('ui:update-play-state', true);
    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
  });

  it.each([PLAYBACK_STATE.DOWNLOADING, PLAYBACK_STATE.AWAITING_PRELOAD, PLAYBACK_STATE.DECODING])(
    'shows the loading play button while a local file is preparing (%s)',
    (lifecycle) => {
      renderPlaybackControls();
      setState('playback.lifecycle', lifecycle);

      initPlayerControls();

      const playBtn = document.getElementById('play-btn');
      expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
      expect(playBtn?.getAttribute('aria-busy')).toBe('true');

      setState('playback.lifecycle', PLAYBACK_STATE.READY);

      expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
      expect(playBtn?.getAttribute('aria-busy')).toBe('false');
    },
  );

  it('shows the loading play button while a PRO member awaits server selection', () => {
    renderPlaybackControls();
    setState('network.pendingTrackChangeQueueItemId', PLAY_QUEUE_ITEM_ID);

    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    setState('network.pendingTrackChangeQueueItemId', null);

    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('shows the loading play button for every participant in a PRO rendezvous', () => {
    renderPlaybackControls();
    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    bus.emit('pro-playback:transition-loading', true);

    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    bus.emit('pro-playback:transition-loading', false);

    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps the spinner after local selection intent yields to the shared PRO transition', () => {
    renderPlaybackControls();
    setState('network.pendingTrackChangeQueueItemId', PLAY_QUEUE_ITEM_ID);
    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    bus.emit('pro-playback:transition-loading', true);
    setState('network.pendingTrackChangeQueueItemId', null);

    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    bus.emit('pro-playback:transition-loading', false);

    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps the play spinner bound to the exact pending PRO play token', () => {
    renderPlaybackControls();
    initPlayerControls();
    const playBtn = document.getElementById('play-btn');

    bus.emit('pro-playback:ui-control-pending', {
      token: 10,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 12,
      wasPlaying: false,
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    bus.emit('pro-playback:ui-control-settled', {
      token: 9,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'superseded',
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);

    bus.emit('pro-playback:ui-control-settled', {
      token: 10,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 12,
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('shows a spinner for a playing seek but makes a pending pause look immediate', () => {
    renderPlaybackControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initPlayerControls();
    const playBtn = document.getElementById('play-btn');
    const icon = playBtn?.querySelector('path');

    bus.emit('pro-playback:ui-control-pending', {
      token: 20,
      kind: 'seek',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 30,
      wasPlaying: true,
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);

    bus.emit('pro-playback:ui-control-settled', {
      token: 20,
      kind: 'seek',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 30,
    });
    bus.emit('pro-playback:ui-control-pending', {
      token: 21,
      kind: 'pause',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 31,
      wasPlaying: true,
    });
    // A late engine state notification must not paint the pause icon back
    // over the participant-local pause projection.
    setState('playback.activity', 'paused');
    setState('playback.activity', 'playing');

    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');

    bus.emit('pro-playback:ui-control-settled', {
      token: 21,
      kind: 'pause',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 31,
    });
  });
});

describe('initPlayerControls tab title marquee wiring', () => {
  it('hydrates metadata when a remote guest is already playing during UI initialization', () => {
    setState('network.hostConn', makeConnection('host-1'));
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'remote.flac',
      title: 'Remote orchestra',
    });
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');

    initPlayerControls();

    expect(document.title).toBe('Remote orchestra · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });

  it('starts the new title when remote metadata arrives after the playing state', () => {
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initPlayerControls();

    expect(document.title).toBe('MUSIXQUARE · 뮤직스퀘어');
    expect(getManagedTimer('tab-title-marquee')).toBeNull();

    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'late.wav',
      title: 'Late remote metadata',
    });

    expect(document.title).toBe('Late remote metadata · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });

  it('replaces the previous title when the next track arrives without an activity transition', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'first.wav',
      title: 'First track',
    });
    initPlayerControls();

    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'second.wav',
      title: 'Second track',
    });

    expect(document.title).toBe('Second track · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });

  it('updates a paused track title immediately instead of waiting for playback to change', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'old.wav',
      title: 'Old title',
    });
    initPlayerControls();

    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'new.wav',
      title: 'New paused title',
    });

    expect(document.title).toBe('New paused title · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).toBeNull();
  });

  it('keeps confirmed YouTube marquee motion when the iframe state is unavailable on focus', () => {
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    setState('player.currentTrackMeta', {
      type: 'youtube',
      name: 'youtube-video',
      title: 'YouTube track',
      videoId: 'video-1',
      playlistId: null,
    });
    initPlayerControls();

    // The real iframe PLAYING event is authoritative even if getPlayerState()
    // is temporarily unavailable during the next page-lifecycle callback.
    bus.emit('ui:update-play-state', true);
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();

    window.dispatchEvent(new Event('focus'));

    expect(document.title).toBe('YouTube track · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });
});

describe('initPlayerControls volume icon', () => {
  function renderVolumeControls(): HTMLElement {
    document.body.innerHTML = `
      <button id="vol-icon-btn" aria-label="Toggle mute">
        <svg class="volume-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path class="volume-speaker" d="M3 9v6h4l5 5V4L7 9H3z"></path>
          <path class="volume-wave volume-wave-inner" d="M15.2 8.5a4.9 4.9 0 0 1 0 7"></path>
          <path class="volume-wave volume-wave-outer" d="M18 5.7a8.9 8.9 0 0 1 0 12.6"></path>
          <g class="volume-muted-backdrop">
            <circle class="volume-muted-ring" cx="17" cy="12" r="4.8"></circle>
            <path class="volume-muted-slash" d="M13.6 8.6l6.8 6.8"></path>
          </g>
          <g class="volume-muted-mark">
            <circle class="volume-muted-ring" cx="17" cy="12" r="4.8"></circle>
            <path class="volume-muted-slash" d="M13.6 8.6l6.8 6.8"></path>
          </g>
        </svg>
      </button>
      <input type="range" id="volume-slider" min="0" max="100" value="100" />
    `;
    return document.getElementById('vol-icon-btn') as HTMLElement;
  }

  it('uses a class-driven muted mark instead of swapping icon paths', () => {
    const button = renderVolumeControls();
    setState('audio.masterVolume', 0);

    initPlayerControls();

    expect(button.classList.contains('is-muted')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(
      document.getElementById('volume-slider')?.style.getPropertyValue('--range-progress'),
    ).toBe('0%');

    setState('audio.masterVolume', 0.65);
    bus.emit('audio:volume-changed', 0.65);

    expect(button.classList.contains('is-muted')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect((document.getElementById('volume-slider') as HTMLInputElement).value).toBe('65');
    expect(
      document.getElementById('volume-slider')?.style.getPropertyValue('--range-progress'),
    ).toBe('65%');
  });
});

describe('initPlayerControls sync button', () => {
  function renderSyncControls(): void {
    document.body.innerHTML = `
      <button id="btn-sync"></button>
      <button id="play-btn"><svg><path d=""></path></svg></button>
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
      <div id="manual-sync-overlay" aria-hidden="true">
        <div role="dialog" aria-modal="true" aria-label="Sync">
          <button id="btn-nudge-minus10">-10</button>
          <button id="btn-nudge-minus1">-1</button>
          <button id="btn-nudge-plus1">+1</button>
          <button id="btn-nudge-plus10">+10</button>
          <button id="btn-auto-sync">Reset</button>
          <button id="btn-sync-done">Done</button>
        </div>
      </div>
      <span id="manual-sync-value"></span>
      <span id="auto-sync-value"></span>
    `;
  }

  it('tells a fresh host to select media instead of suggesting a passive retry', () => {
    renderSyncControls();

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(showToast).toHaveBeenCalledWith(
      "There's no media to sync.\nSelect something to play first",
    );
  });

  it('keeps the transient not-ready message for a guest waiting on the host', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('runs guest YouTube rendezvous before opening the manual sync panel', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    setState('sync.youtubeLocalOffset', 0.25);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    const guestSync = vi.mocked(guestRendezvousSync);
    expect(guestSync).toHaveBeenCalledTimes(1);
    const opts = guestSync.mock.calls[0][0];
    expect(opts?.suppressProgressToast).toBe(true);
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);

    opts?.onComplete?.();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    expect((document.getElementById('manual-sync-value') as HTMLElement | null)?.innerText).toBe(
      '+250',
    );
    expect(showToast).toHaveBeenCalledWith(
      'Automatic sync was just attempted.\nIf it still feels delayed, adjust the value now',
    );
  });

  it('blocks guest YouTube sync while zero-start owns the iframe', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    zeroStartFacade.active = true;

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(guestRendezvousSync).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('sends a YouTube rendezvous request when the host presses sync', () => {
    renderSyncControls();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastYouTubeSync).toHaveBeenCalledWith(true);
    expect(guestRendezvousSync).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      'Precision sync requested.\nAdjust manual sync on a guest device.',
    );
  });

  it('does not report a host sync success while zero-start is active', () => {
    renderSyncControls();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    zeroStartFacade.active = true;

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('reconciles an equal PRO participant before opening the local YouTube nudge panel', async () => {
    renderSyncControls();
    setState('network.appRole', 'host');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    await vi.waitFor(() => {
      expect(proPlaybackRuntime.reconcile).toHaveBeenCalledTimes(1);
      expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    });
    expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    expect(guestRendezvousSync).not.toHaveBeenCalled();
  });

  it('keeps the PRO nudge panel closed when server reconciliation cannot realign media', async () => {
    renderSyncControls();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    proPlaybackRuntime.reconcile.mockResolvedValueOnce(false);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
    });
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
  });

  it('keeps the PRO participant nudge panel closed during zero-start', () => {
    renderSyncControls();
    setState('network.appRole', 'host');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    zeroStartFacade.active = true;

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('does not treat a closed YouTube host connection as either host or guest sync', () => {
    renderSyncControls();
    setState('network.hostConn', { peer: 'host-1', open: false } as DataConnection);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    expect(guestRendezvousSync).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('broadcasts an authoritative local-file PLAY sync when the host presses sync', () => {
    renderSyncControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', PLAY_QUEUE_ITEM_ID);
    setState('player.pausedAt', 42);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const broadcastSpy = vi.fn();
    bus.on('network:broadcast', broadcastSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PLAY,
        queueItemId: PLAY_QUEUE_ITEM_ID,
        time: expect.any(Number),
        hostPlayAt: expect.any(Number),
      }),
    );
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      'Precision sync requested.\nAdjust manual sync on a guest device.',
    );
  });

  it('reconciles a PRO file endpoint before opening its local nudge panel', async () => {
    renderSyncControls();
    setState('network.appRole', 'host');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', PLAY_QUEUE_ITEM_ID);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const broadcastSpy = vi.fn();
    bus.on('network:broadcast', broadcastSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    await vi.waitFor(() => {
      expect(proPlaybackRuntime.reconcile).toHaveBeenCalledTimes(1);
      expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    });
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('broadcasts a local-file PAUSE position sync when the host is paused', () => {
    renderSyncControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    setState('playlist.currentQueueItemId', PAUSE_QUEUE_ITEM_ID);
    setState('player.pausedAt', 33);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const broadcastSpy = vi.fn();
    bus.on('network:broadcast', broadcastSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastSpy).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 33,
      queueItemId: PAUSE_QUEUE_ITEM_ID,
      reason: 'seek',
    });
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
  });

  it('runs one local-file resync before opening the guest manual sync panel', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('sync.localOffset', 0.12);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const forceResyncSpy = vi.fn();
    bus.on('sync:force-resync', forceResyncSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(forceResyncSpy).toHaveBeenCalledTimes(1);
    expect(getState('sync.localOffset')).toBe(0.12);
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
  });

  it('does not open the local-file manual panel before the guest has a decoded buffer', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    const forceResyncSpy = vi.fn();
    bus.on('sync:force-resync', forceResyncSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(forceResyncSpy).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('closes the local-file manual panel if the decoded buffer is cleared', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);

    setCurrentAudioBuffer(null);

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
  });

  it('makes the manual panel modal, traps Tab, closes on Escape, and restores focus', async () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const trigger = document.getElementById('btn-sync') as HTMLButtonElement;
    const overlay = document.getElementById('manual-sync-overlay')!;
    const first = document.getElementById('btn-nudge-minus10') as HTMLButtonElement;
    const done = document.getElementById('btn-sync-done') as HTMLButtonElement;
    trigger.focus();

    initPlayerControls();
    trigger.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(trigger.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(done);

    done.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(done);

    done.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.classList.contains('show')).toBe(false);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('routes the Done event through the shared manual-overlay close path', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const trigger = document.getElementById('btn-sync') as HTMLButtonElement;
    const overlay = document.getElementById('manual-sync-overlay')!;
    trigger.focus();
    initPlayerControls();
    trigger.click();

    bus.emit('sync:close-manual');

    expect(overlay.classList.contains('show')).toBe(false);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(trigger);
  });
});
