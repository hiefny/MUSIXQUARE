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
import {
  clearFilePlaybackLoading,
  FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS,
} from '../file-playback-loading-state.ts';

const PLAY_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const PAUSE_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002';

const zeroStartFacade = vi.hoisted(() => ({ active: false }));
const youtubePrimer = vi.hoisted(() => ({
  prime: vi.fn((_options?: { retryPending?: boolean }) => false),
  wait: vi.fn(async () => true),
}));

const proPlaybackRuntime = vi.hoisted(() => ({
  reconcile: vi.fn<() => Promise<boolean>>(),
}));

const proRoomClock = vi.hoisted(() => ({
  connected: false,
  offsetMs: 0,
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

vi.mock('../../youtube/iframe.ts', () => ({
  primeYouTubePlayer: youtubePrimer.prime,
  waitForPendingYouTubePrimeBounce: youtubePrimer.wait,
}));

vi.mock('../../pro-room/runtime.ts', () => ({
  requestActiveProRoomPlaybackReconciliation: proPlaybackRuntime.reconcile,
}));

vi.mock('../../pro-room/network-bridge.ts', () => ({
  getProRoomServerNow: vi.fn(() => Date.now() + proRoomClock.offsetMs),
  proRoomServerBridge: {
    get connected() {
      return proRoomClock.connected;
    },
  },
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
  clearFilePlaybackLoading();
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
  proRoomClock.connected = false;
  proRoomClock.offsetMs = 0;
  zeroStartFacade.active = false;
  proPlaybackRuntime.reconcile.mockResolvedValue(true);
  document.body.innerHTML = '';
});

afterEach(() => {
  clearAllManagedTimers();
  clearFilePlaybackLoading();
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

  it('pulses an authenticated PRO role dot from the connected server clock', () => {
    vi.useFakeTimers();
    try {
      const badge = renderBadge();
      const dot = badge.querySelector('.role-dot') as HTMLElement;
      vi.setSystemTime(0);
      proRoomClock.connected = true;
      setState('network.appRole', 'guest');
      setState('network.hostConn', null);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: [],
      });
      applyAccountSession({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
      });

      updateRoleBadge();

      expect(badge.classList.contains('account-authenticated')).toBe(true);
      expect(dot.classList.contains('clock-beat')).toBe(true);
      vi.advanceTimersByTime(120);
      expect(dot.classList.contains('clock-beat')).toBe(false);
      vi.advanceTimersByTime(120);
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

  it('keeps playlist media addition available while the host shares system audio', () => {
    document.body.innerHTML = `
      <button id="btn-add-media"></button>
      <button id="btn-media-source"></button>
      <div id="media-source-overlay"></div>
    `;
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setPlaybackSystemAudioPlaying();

    initPlayerControls();
    const addMedia = document.getElementById('btn-add-media');
    expect(addMedia?.getAttribute('aria-disabled')).toBe('false');

    addMedia?.click();
    expect(document.getElementById('media-source-overlay')?.classList.contains('active')).toBe(
      true,
    );
  });

  it('lets a delegated media manager control repeat and shuffle independently', () => {
    document.body.innerHTML = `
      <button id="btn-repeat"></button>
      <button id="btn-shuffle"></button>
    `;
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', [
      'media.add',
      'queue.mutate',
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

    expect(document.getElementById('btn-repeat')?.getAttribute('aria-disabled')).toBe('false');
    expect(document.getElementById('btn-shuffle')?.getAttribute('aria-disabled')).toBe('false');
    expect(repeat).toHaveBeenCalledTimes(1);
    expect(shuffle).toHaveBeenCalledTimes(1);
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
    const reveal = vi.fn();
    bus.on('ui:scrollbar-reveal', reveal);

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.style.opacity).toBe('');
    expect(document.getElementById('btn-add-media')?.getAttribute('aria-disabled')).toBe('false');
    document.getElementById('btn-add-media')?.click();
    expect(document.getElementById('media-source-overlay')?.classList.contains('active')).toBe(
      true,
    );
    expect(reveal).toHaveBeenCalledWith(document.getElementById('media-source-overlay'));

    document.getElementById('btn-local-file')?.click();
    expect(inputClick).toHaveBeenCalledTimes(1);

    document.getElementById('btn-youtube-source')?.click();
    expect(document.getElementById('youtube-url-overlay')?.classList.contains('active')).toBe(true);
    expect(reveal).toHaveBeenCalledWith(document.getElementById('youtube-url-overlay'));
    expect(youtubePrimer.prime).toHaveBeenCalledTimes(1);

    expect(document.getElementById('btn-system-audio')?.hidden).toBe(true);
  });

  it('focuses, traps, escapes, and restores the media picker dialog', async () => {
    document.body.innerHTML = `
      <button id="btn-media-source"></button>
      <div id="media-source-overlay" role="dialog" aria-modal="true" tabindex="-1">
        <button id="btn-local-file"></button>
        <button id="btn-close-media-popup"></button>
      </div>
      <input id="file-input" type="file" />
    `;
    setState('network.appRole', 'host');
    setState('network.standardRoomCapabilities', ['media.add', 'asset.upload']);

    initPlayerControls();
    const trigger = document.getElementById('btn-media-source') as HTMLButtonElement;
    const first = document.getElementById('btn-local-file') as HTMLButtonElement;
    const close = document.getElementById('btn-close-media-popup') as HTMLButtonElement;
    trigger.focus();
    trigger.click();

    await vi.waitFor(() => expect(document.activeElement).toBe(first));
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(close);

    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.getElementById('media-source-overlay')?.classList).not.toContain('active');
  });

  it('focuses the media picker surface instead of visually selecting an action for pointer opens', async () => {
    document.body.innerHTML = `
      <button id="btn-media-source"></button>
      <div id="media-source-overlay" role="dialog" aria-modal="true" tabindex="-1">
        <button id="btn-local-file"></button>
        <button id="btn-close-media-popup"></button>
      </div>
      <input id="file-input" type="file" />
    `;
    setState('network.appRole', 'host');
    setState('network.standardRoomCapabilities', ['media.add', 'asset.upload']);

    initPlayerControls();
    document
      .getElementById('btn-media-source')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

    const overlay = document.getElementById('media-source-overlay') as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(overlay));
    expect(overlay.classList.contains('active')).toBe(true);
  });

  it('updates script-aware fonts while typing a YouTube search query', () => {
    document.body.innerHTML = `<div id="youtube-url-input" contenteditable="true"></div>`;
    const input = document.getElementById('youtube-url-input') as HTMLDivElement;

    initPlayerControls();
    input.textContent = 'เพลงไทย';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

    expect(input.classList).toContain('user-text-font');
    expect(input.classList).toContain('user-text-font-th');
  });

  it('does not let Enter bypass a disabled YouTube preview submit gate', () => {
    document.body.innerHTML = `
      <div id="youtube-url-input" contenteditable="true"></div>
      <button id="youtube-play-btn" disabled></button>
    `;
    const input = document.getElementById('youtube-url-input') as HTMLDivElement;
    const submit = vi.fn();
    bus.on('youtube:load-from-input', submit);

    initPlayerControls();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(submit).not.toHaveBeenCalled();
  });

  it('waits for a gesture-bound iOS prime proof before submitting the real video load', async () => {
    document.body.innerHTML = `
      <div id="youtube-url-overlay" class="active"></div>
      <div id="youtube-url-input" contenteditable="true">https://youtube.com/playlist?list=PL_READY</div>
      <button id="youtube-play-btn"></button>
    `;
    const submit = vi.fn();
    bus.on('youtube:load-from-input', submit);
    youtubePrimer.prime.mockReturnValueOnce(true);

    initPlayerControls();
    const playButton = document.getElementById('youtube-play-btn') as HTMLButtonElement;
    playButton.click();

    expect(submit).not.toHaveBeenCalled();
    expect(playButton.disabled).toBe(true);
    expect(playButton.getAttribute('aria-busy')).toBe('true');
    expect(youtubePrimer.prime).toHaveBeenCalledWith({ retryPending: true });
    expect(youtubePrimer.wait).toHaveBeenCalledWith(1_500);

    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(playButton.disabled).toBe(false);
    expect(playButton.hasAttribute('aria-busy')).toBe(false);
  });

  it('keeps an already-primed YouTube submit in the original click stack', () => {
    document.body.innerHTML = `
      <div id="youtube-url-input" contenteditable="true">https://youtube.com/watch?v=AAAAAAAAAAA</div>
      <button id="youtube-play-btn"></button>
    `;
    const submit = vi.fn();
    bus.on('youtube:load-from-input', submit);
    youtubePrimer.prime.mockReturnValueOnce(false);

    initPlayerControls();
    document.getElementById('youtube-play-btn')?.click();

    expect(submit).toHaveBeenCalledOnce();
    expect(youtubePrimer.prime).toHaveBeenCalledWith({ retryPending: true });
    expect(youtubePrimer.wait).not.toHaveBeenCalled();
  });

  it('does not let a closed submit resume into a reopened popup with the same URL', async () => {
    document.body.innerHTML = `
      <div id="youtube-url-overlay" class="active"></div>
      <div id="youtube-url-input" contenteditable="true">https://youtube.com/playlist?list=PL_STALE</div>
      <button id="youtube-play-btn"></button>
      <button id="btn-yt-cancel"></button>
    `;
    let resolvePrime!: (value: boolean) => void;
    youtubePrimer.prime.mockReturnValueOnce(true);
    youtubePrimer.wait.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolvePrime = resolve;
      }),
    );
    const submit = vi.fn();
    bus.on('youtube:load-from-input', submit);

    initPlayerControls();
    const overlay = document.getElementById('youtube-url-overlay') as HTMLDivElement;
    const input = document.getElementById('youtube-url-input') as HTMLDivElement;
    const playButton = document.getElementById('youtube-play-btn') as HTMLButtonElement;
    playButton.click();
    expect(playButton.disabled).toBe(true);

    document.getElementById('btn-yt-cancel')?.click();
    overlay.classList.add('active');
    input.textContent = 'https://youtube.com/playlist?list=PL_STALE';
    playButton.disabled = true;

    resolvePrime(true);
    await vi.waitFor(() => expect(youtubePrimer.wait).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).not.toHaveBeenCalled();
    expect(playButton.disabled).toBe(true);
    expect(playButton.hasAttribute('aria-busy')).toBe(false);
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
    expect(showToast).toHaveBeenCalledWith(t('toast.system_audio_owner_required'));
  });
});

describe('initPlayerControls playback mode rendering', () => {
  function renderPlaybackControls(): void {
    document.body.innerHTML = `
      <button id="btn-prev"></button>
      <button id="play-btn"><svg><path d=""></path></svg></button>
      <button id="btn-next"></button>
      <button id="btn-media-source"><span data-i18n="player.play_media">Play media</span></button>
      <div class="vinyl-wrapper" aria-busy="false"><canvas id="visualizerCanvas"></canvas></div>
      <div class="video-wrapper" aria-busy="false">
        <div id="youtube-player-container"></div>
        <div
          id="youtube-sync-loading-overlay"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-hidden="true"
          hidden
        ></div>
      </div>
    `;
  }

  function expectYouTubeSyncOverlay(showing: boolean): void {
    const wrapper = document.querySelector('.video-wrapper');
    const youtubeContainer = document.getElementById('youtube-player-container');
    const overlay = document.getElementById('youtube-sync-loading-overlay') as HTMLElement | null;
    expect(wrapper?.getAttribute('aria-busy')).toBe(String(showing));
    expect(youtubeContainer?.hasAttribute('inert')).toBe(showing);
    expect(overlay?.hidden).toBe(!showing);
    expect(overlay?.getAttribute('aria-hidden')).toBe(String(!showing));
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

  it('blocks only the YouTube frame for the complete sync-loading lifecycle', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();

    expectYouTubeSyncOverlay(false);
    bus.emit('youtube:sync-loading', true);
    expectYouTubeSyncOverlay(true);

    bus.emit('youtube:sync-loading', false);
    expectYouTubeSyncOverlay(false);
  });

  it('keeps the shield while any independently owned YouTube sync remains pending', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();

    bus.emit('youtube:sync-loading', true, 'rendezvous');
    bus.emit('youtube:sync-loading', true, 'clock-action');
    expectYouTubeSyncOverlay(true);

    bus.emit('youtube:sync-loading', false, 'rendezvous');
    expectYouTubeSyncOverlay(true);

    bus.emit('youtube:sync-loading', false, 'clock-action');
    expectYouTubeSyncOverlay(false);
  });

  it('never exposes the YouTube shield for non-YouTube loading', () => {
    renderPlaybackControls();
    setState('playback.mode', 'file');
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    initPlayerControls();

    expect(document.getElementById('play-btn')?.classList).toContain('yt-syncing');
    expectYouTubeSyncOverlay(false);

    bus.emit('youtube:sync-loading', true);
    expectYouTubeSyncOverlay(false);
  });

  it('keeps the visualizer unobscured while delayed V2 file seek loading ignores stale settlement', () => {
    vi.useFakeTimers();
    try {
      renderPlaybackControls();
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      initPlayerControls();

      bus.emit('player:v2-host-seek-pending', {
        token: 401,
        queueItemId: PLAY_QUEUE_ITEM_ID,
        targetSeconds: 35,
      });

      const playBtn = document.getElementById('play-btn');
      const wrapper = document.querySelector('.vinyl-wrapper');
      expect(wrapper?.getAttribute('aria-busy')).toBe('true');
      expect(document.getElementById('file-playback-loading-overlay')).toBeNull();
      expect(playBtn?.classList.contains('yt-syncing')).toBe(false);

      vi.advanceTimersByTime(FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS);
      expect(document.getElementById('file-playback-loading-overlay')).toBeNull();
      expect(playBtn?.classList.contains('yt-syncing')).toBe(true);

      bus.emit('player:v2-host-seek-settled', {
        token: 400,
        queueItemId: PLAY_QUEUE_ITEM_ID,
        status: 'superseded',
        positionSeconds: 8,
      });
      expect(playBtn?.classList.contains('yt-syncing')).toBe(true);

      bus.emit('player:v2-host-seek-settled', {
        token: 401,
        queueItemId: PLAY_QUEUE_ITEM_ID,
        status: 'committed',
        positionSeconds: 35,
      });
      expect(wrapper?.getAttribute('aria-busy')).toBe('false');
      expect(document.getElementById('file-playback-loading-overlay')).toBeNull();
      expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let V2 file preparation shield or busy the YouTube iframe', () => {
    vi.useFakeTimers();
    try {
      renderPlaybackControls();
      setState('playback.mode', 'youtube');
      setState('playback.activity', 'playing');
      initPlayerControls();

      bus.emit('player:v2-host-seek-pending', {
        token: 402,
        queueItemId: PLAY_QUEUE_ITEM_ID,
        targetSeconds: 19,
      });
      vi.advanceTimersByTime(FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS);

      expect(document.getElementById('file-playback-loading-overlay')).toBeNull();
      expect(document.querySelector('.vinyl-wrapper')?.getAttribute('aria-busy')).toBe('false');
      expect(document.getElementById('play-btn')?.classList.contains('yt-syncing')).toBe(false);
      expectYouTubeSyncOverlay(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears delayed V2 file loading synchronously on stop', () => {
    vi.useFakeTimers();
    try {
      renderPlaybackControls();
      setState('playback.mode', 'file');
      initPlayerControls();
      bus.emit('player:v2-host-seek-pending', {
        token: 403,
        queueItemId: PLAY_QUEUE_ITEM_ID,
        targetSeconds: 23,
      });
      bus.emit('player:stop-all-media');
      vi.advanceTimersByTime(FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS);

      expect(document.getElementById('file-playback-loading-overlay')).toBeNull();
      expect(document.querySelector('.vinyl-wrapper')?.getAttribute('aria-busy')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders generic V2 start preparation only on the play control for its exact token', () => {
    vi.useFakeTimers();
    try {
      renderPlaybackControls();
      setState('playback.mode', null);
      initPlayerControls();

      bus.emit('player:v2-file-loading-pending', {
        owner: 'host-start',
        token: 'start:1',
      });
      vi.advanceTimersByTime(FILE_PLAYBACK_LOADING_VISUAL_DELAY_MS);

      const playBtn = document.getElementById('play-btn');
      expect(document.getElementById('file-playback-loading-overlay')).toBeNull();
      expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
      expect(playBtn?.getAttribute('aria-disabled')).toBe('true');

      // Exact renderer publication enables media independently from its
      // loading token; standard and PRO commits may publish these two events
      // in either order.
      bus.emit('ui:play-btn-state', true);
      expect(playBtn?.getAttribute('aria-disabled')).toBe('false');
      expect(playBtn?.classList.contains('yt-syncing')).toBe(true);

      bus.emit('player:v2-file-loading-settled', {
        owner: 'host-start',
        token: 'stale',
      });
      expect(playBtn?.classList.contains('yt-syncing')).toBe(true);

      bus.emit('player:v2-file-loading-settled', {
        owner: 'host-start',
        token: 'start:1',
      });
      expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
      expect(playBtn?.getAttribute('aria-busy')).toBe('false');
      expect(playBtn?.getAttribute('aria-disabled')).toBe('false');
      expect(document.getElementById('file-playback-loading-overlay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows immediate V2 host PLAY feedback until its exact token settles', () => {
    renderPlaybackControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    const icon = playBtn?.querySelector('path');
    bus.emit('player:v2-host-ui-control-pending', {
      token: 501,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
    });

    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');
    expect(document.getElementById('file-playback-loading-overlay')).toBeNull();
    expectYouTubeSyncOverlay(false);

    bus.emit('player:v2-host-ui-control-settled', {
      token: 500,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'failed',
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    bus.emit('player:v2-host-ui-control-settled', {
      token: 501,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'committed',
    });
    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('projects V2 host PAUSE immediately without a spinner and restores truth on failure', () => {
    renderPlaybackControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    const icon = playBtn?.querySelector('path');
    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');

    bus.emit('player:v2-host-ui-control-pending', {
      token: 601,
      kind: 'pause',
      queueItemId: PAUSE_QUEUE_ITEM_ID,
    });
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');
    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');

    bus.emit('player:v2-host-ui-control-settled', {
      token: 600,
      kind: 'pause',
      queueItemId: PAUSE_QUEUE_ITEM_ID,
      status: 'failed',
    });
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');

    bus.emit('player:v2-host-ui-control-settled', {
      token: 601,
      kind: 'pause',
      queueItemId: PAUSE_QUEUE_ITEM_ID,
      status: 'failed',
    });
    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('projects an exact V2 guest PAUSE gate immediately and ignores stale settlement', () => {
    renderPlaybackControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    const icon = playBtn?.querySelector('path');
    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');

    bus.emit('player:v2-guest-pause-gate-pending', { token: 701 });
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');
    expect(playBtn?.classList.contains('yt-syncing')).toBe(false);

    bus.emit('player:v2-guest-pause-gate-settled', { token: 700 });
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');

    bus.emit('player:v2-guest-pause-gate-settled', { token: 701 });
    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
  });

  it('removes the shield on mode exit even while a PRO transition remains pending', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();

    bus.emit('pro-playback:transition-loading', true);
    expectYouTubeSyncOverlay(true);

    setState('playback.mode', 'file');
    expect(document.getElementById('play-btn')?.classList).toContain('yt-syncing');
    expectYouTubeSyncOverlay(false);
  });

  it('clears a stale shield when player controls are re-initialized', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();
    bus.emit('youtube:sync-loading', true);
    expectYouTubeSyncOverlay(true);

    initPlayerControls();
    expect(document.getElementById('play-btn')?.classList).not.toContain('yt-syncing');
    expectYouTubeSyncOverlay(false);
  });

  it('shows the shield for pending PRO YouTube play and playing-seek controls', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();

    bus.emit('pro-playback:ui-control-pending', {
      token: 30,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 12,
      wasPlaying: false,
    });
    expectYouTubeSyncOverlay(true);

    bus.emit('pro-playback:ui-control-settled', {
      token: 30,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 12,
    });
    expectYouTubeSyncOverlay(false);

    bus.emit('pro-playback:ui-control-pending', {
      token: 31,
      kind: 'seek',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 30,
      wasPlaying: true,
    });
    expectYouTubeSyncOverlay(true);

    bus.emit('pro-playback:ui-control-settled', {
      token: 31,
      kind: 'seek',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 30,
    });
    expectYouTubeSyncOverlay(false);
  });

  it('updates a ready PRO play button immediately when playback authority is revoked or granted', () => {
    renderPlaybackControls();
    const context = {
      kind: 'pro' as const,
      roomId: '000001',
      role: 'member' as const,
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control' as const],
    };
    setState('room.context', context);
    initPlayerControls();
    const playBtn = document.getElementById('play-btn');

    bus.emit('ui:play-btn-state', true);
    expect(playBtn?.getAttribute('aria-disabled')).toBe('false');

    setState('room.context', { ...context, snapshotRevision: 2, capabilities: [] });
    expect(playBtn?.getAttribute('aria-disabled')).toBe('true');

    setState('room.context', { ...context, snapshotRevision: 3 });
    expect(playBtn?.getAttribute('aria-disabled')).toBe('false');
  });

  it('projects granular standard-room playback authority onto every transport control', () => {
    renderPlaybackControls();
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['media.add', 'queue.mutate']);
    initPlayerControls();
    bus.emit('ui:play-btn-state', true);

    for (const id of ['btn-prev', 'play-btn', 'btn-next']) {
      expect(document.getElementById(id)?.getAttribute('aria-disabled')).toBe('true');
    }

    setState('network.standardRoomCapabilities', ['media.add', 'queue.mutate', 'playback.control']);
    for (const id of ['btn-prev', 'play-btn', 'btn-next']) {
      expect(document.getElementById(id)?.getAttribute('aria-disabled')).toBe('false');
    }
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
      <button id="btn-sync"><span data-i18n="common.sync">Sync</span></button>
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
    expect(document.getElementById('btn-sync')?.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById('btn-sync')?.title).toContain("There's no media to sync");
    document.getElementById('btn-sync')?.click();

    expect(showToast).toHaveBeenCalledWith(
      "There's no media to sync.\nSelect something to play first",
    );
  });

  it('updates sync readiness before activation when playable media appears', () => {
    renderSyncControls();

    initPlayerControls();
    const button = document.getElementById('btn-sync') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');

    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(button.hasAttribute('title')).toBe(false);
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

  it('shows one PRO synchronization request as pending until reconciliation settles', async () => {
    renderSyncControls();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    let resolveReconciliation!: (value: boolean) => void;
    proPlaybackRuntime.reconcile.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveReconciliation = resolve;
      }),
    );

    initPlayerControls();
    const button = document.getElementById('btn-sync') as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(proPlaybackRuntime.reconcile).toHaveBeenCalledTimes(1));

    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toBe('Syncing...');

    resolveReconciliation(true);
    await vi.waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));

    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(button.textContent).toBe('Sync');
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

  it('does not surface a stale PRO reconciliation failure after switching rooms', async () => {
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

    let rejectReconciliation!: (error: Error) => void;
    proPlaybackRuntime.reconcile.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectReconciliation = reject;
      }),
    );

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await vi.waitFor(() => expect(proPlaybackRuntime.reconcile).toHaveBeenCalledTimes(1));

    setState('room.context', {
      kind: 'pro',
      roomId: '000002',
      role: 'member',
      coordinatorId: null,
      epoch: 2,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    rejectReconciliation(new Error('old room request failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(showToast).not.toHaveBeenCalled();
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
