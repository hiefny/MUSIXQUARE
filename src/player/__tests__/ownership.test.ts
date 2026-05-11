import { beforeEach, describe, expect, it } from 'vitest';
import { PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import {
  claimPlaybackOwner,
  createFileTrackMeta,
  createSystemAudioTrackMeta,
  createYouTubeTrackMeta,
  getPlaybackModeActivity,
  getPlaybackModeActivitySnapshot,
  getPlaybackOwnership,
  isExternalOwner,
  isFileOwner,
  isPlaybackIdle,
  isPlaybackIdleCompat,
  isPlaybackIdleCompatModeActivity,
  isPlaybackActivityValue,
  isPlaybackModeSystemAudio,
  isPlaybackModeValue,
  isPlaybackModeYouTube,
  isPlaybackNonIdleFile,
  isPlaybackPausedOrPendingFile,
  isPlaybackPending,
  isPlaybackPendingFile,
  isPlaybackPlayingFile,
  isPlaybackPlayingSystemAudio,
  isPlaybackPlayingYouTube,
  isSystemAudioOwner,
  isSystemAudioPlaceholderMeta,
  isYouTubeOwner,
  releasePlaybackOwner,
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  setPlaybackSystemAudioPlaying,
  setPlaybackLifecycleState,
  setPlaybackTransferState,
  setPlaybackYouTubePlaying,
  setSystemAudioReceiving,
  setPlaybackTrackMeta,
  updatePlaybackTrackMeta,
  updatePlaybackTrackTitle,
} from '../ownership.ts';

beforeEach(() => {
  resetState();
});

function expectPlaybackModeActivitySlots(mode: string | null, activity: string): void {
  expect(getState('playback.mode')).toBe(mode);
  expect(getState('playback.activity')).toBe(activity);
}

describe('playback ownership view', () => {
  it('defaults to no owner', () => {
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'none',
      mode: null,
      activity: 'idle',
      hasFilePipeline: false,
      isExternalOwner: false,
    });
    expect(getPlaybackModeActivity()).toEqual({ mode: null, activity: 'idle' });
    expect(getPlaybackModeActivitySnapshot()).toEqual({ mode: null, activity: 'idle' });
    expect(isPlaybackIdle()).toBe(true);
    expectPlaybackModeActivitySlots(null, 'idle');
  });

  it('treats YouTube as an external owner', () => {
    setPlaybackYouTubePlaying();

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'youtube',
      mode: 'youtube',
      activity: 'playing',
      isExternalOwner: true,
    });
    expect(isExternalOwner()).toBe(true);
    expect(isYouTubeOwner()).toBe(true);
    expect(isPlaybackModeYouTube()).toBe(true);
    expect(isPlaybackPlayingYouTube()).toBe(true);
    expectPlaybackModeActivitySlots('youtube', 'playing');
  });

  it('treats system audio playback as an external owner', () => {
    setPlaybackSystemAudioPlaying();

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      mode: 'system-audio',
      activity: 'playing',
      isExternalOwner: true,
    });
    expect(isSystemAudioOwner()).toBe(true);
    expect(isPlaybackModeSystemAudio()).toBe(true);
    expect(isPlaybackPlayingSystemAudio()).toBe(true);
    expectPlaybackModeActivitySlots('system-audio', 'playing');
  });

  it('treats the guest system-audio placeholder as ownership', () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });

    expect(isSystemAudioPlaceholderMeta(getPlaybackOwnership().currentTrackMeta)).toBe(true);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      mode: 'system-audio',
      activity: 'pending',
      isSystemAudioPlaceholder: true,
      isExternalOwner: true,
    });
    expect(isSystemAudioOwner()).toBe(true);
    expect(isPlaybackModeSystemAudio()).toBe(true);
    expect(isPlaybackPending()).toBe(true);
    expectPlaybackModeActivitySlots('system-audio', 'pending');
  });

  it('treats active file lifecycle or transfer work as file ownership', () => {
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    expect(isFileOwner()).toBe(true);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'file',
      mode: 'file',
      activity: 'pending',
      hasFilePipeline: true,
      isExternalOwner: false,
    });
    expectPlaybackModeActivitySlots('file', 'pending');

    resetState();
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'file',
      mode: 'file',
      activity: 'pending',
      hasFilePipeline: true,
      isExternalOwner: false,
    });
    expectPlaybackModeActivitySlots('file', 'pending');
  });

  it('claims active system-audio ownership with canonical metadata', () => {
    claimPlaybackOwner('system-audio', {
      currentTrackMeta: createSystemAudioTrackMeta('sharing'),
    });

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      mode: 'system-audio',
      activity: 'playing',
      currentTrackMeta: {
        name: 'system-audio',
        title: 'System Audio Sharing',
      },
    });
    expectPlaybackModeActivitySlots('system-audio', 'playing');
  });

  it('claims pending system-audio ownership through placeholder mode/activity', () => {
    claimPlaybackOwner('system-audio', {
      pending: true,
      currentTrackMeta: createSystemAudioTrackMeta('receiving'),
    });

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      mode: 'system-audio',
      activity: 'pending',
      isSystemAudioPlaceholder: true,
    });
    expectPlaybackModeActivitySlots('system-audio', 'pending');
  });

  it('releases only the requested owner unless forced', () => {
    setPlaybackYouTubePlaying();
    const before = getPlaybackOwnership();

    releasePlaybackOwner('system-audio');
    expect(getPlaybackOwnership()).toEqual(before);

    releasePlaybackOwner('system-audio', {
      force: true,
      currentTrackMeta: null,
    });
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'none',
      mode: null,
      activity: 'idle',
      currentTrackMeta: null,
    });
    expectPlaybackModeActivitySlots(null, 'idle');
  });

  it('sets track metadata through the ownership write helper', () => {
    setPlaybackTrackMeta({ type: 'file', name: 'track.mp3', title: 'Track' });

    expect(getPlaybackOwnership().currentTrackMeta).toMatchObject({
      name: 'track.mp3',
      title: 'Track',
    });
    expectPlaybackModeActivitySlots(null, 'idle');
  });

  it('dual-writes placeholder metadata ownership into playback mode/activity slots', () => {
    setPlaybackTrackMeta(createSystemAudioTrackMeta('receiving'));

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      mode: 'system-audio',
      activity: 'pending',
      isSystemAudioPlaceholder: true,
    });
    expectPlaybackModeActivitySlots('system-audio', 'pending');
  });

  it('freshens owner predicates when shadow mode/activity slots are stale', () => {
    setPlaybackTrackMeta(createSystemAudioTrackMeta('receiving'));
    setState('playback.mode', null);
    setState('playback.activity', 'idle');

    expect(isSystemAudioOwner()).toBe(true);
    expect(isExternalOwner()).toBe(true);
    expectPlaybackModeActivitySlots('system-audio', 'pending');
  });

  it('dual-writes lifecycle, transfer, and system-audio source helpers into playback slots', () => {
    setPlaybackTransferState(TRANSFER_STATE.RECEIVING);
    expectPlaybackModeActivitySlots('file', 'pending');

    setPlaybackLifecycleState(PLAYBACK_STATE.PAUSED);
    expectPlaybackModeActivitySlots('file', 'paused');

    resetState();
    setSystemAudioReceiving(true);
    expectPlaybackModeActivitySlots('system-audio', 'playing');
  });

  it('updates track metadata through the ownership write helper', () => {
    setPlaybackTrackMeta(createFileTrackMeta('track.mp3'));

    updatePlaybackTrackMeta((meta) => (meta ? { ...meta, artist: 'Artist' } : meta));

    expect(getPlaybackOwnership().currentTrackMeta).toMatchObject({
      name: 'track.mp3',
      artist: 'Artist',
    });
  });

  it('updates track titles with an optional fallback meta', () => {
    updatePlaybackTrackTitle('Fetched Title', createYouTubeTrackMeta({ name: 'Loading' }));

    expect(getPlaybackOwnership().currentTrackMeta).toMatchObject({
      type: 'youtube',
      name: 'Loading',
      title: 'Fetched Title',
    });
  });

  it('creates canonical synthetic file track metadata', () => {
    expect(createFileTrackMeta('demo.mp3')).toEqual({
      type: 'file',
      title: 'demo',
      name: 'demo.mp3',
      videoId: null,
      playlistId: null,
    });
  });

  it('creates canonical synthetic YouTube track metadata', () => {
    expect(createYouTubeTrackMeta({ name: 'Video', videoId: 'abc', playlistId: null })).toEqual({
      type: 'youtube',
      name: 'Video',
      title: 'Video',
      videoId: 'abc',
      playlistId: null,
    });
  });

  it('preserves compatibility IDLE semantics as a narrow predicate', () => {
    expect(isPlaybackIdleCompatModeActivity({ mode: null, activity: 'idle' })).toBe(true);
    expect(isPlaybackIdleCompatModeActivity({ mode: 'file', activity: 'idle' })).toBe(true);
    expect(isPlaybackIdleCompatModeActivity({ mode: 'file', activity: 'pending' })).toBe(false);
    expect(isPlaybackIdleCompatModeActivity({ mode: 'file', activity: 'paused' })).toBe(false);
    expect(isPlaybackIdleCompatModeActivity({ mode: 'youtube', activity: 'playing' })).toBe(false);
    expect(isPlaybackIdleCompatModeActivity({ mode: 'system-audio', activity: 'pending' })).toBe(
      true,
    );
    expect(isPlaybackIdleCompatModeActivity({ mode: 'system-audio', activity: 'playing' })).toBe(
      false,
    );

    setPlaybackSystemAudioPlaying();
    expect(isPlaybackIdleCompat()).toBe(false);

    setState('playback.activity', 'pending');
    expect(isPlaybackIdleCompat()).toBe(true);
  });

  it('writes playback mode/activity through semantic helpers', () => {
    setPlaybackFilePlaying();
    expect(getPlaybackModeActivity()).toEqual({ mode: 'file', activity: 'playing' });

    setPlaybackFilePaused();
    expect(getPlaybackModeActivity()).toEqual({ mode: 'file', activity: 'paused' });

    setPlaybackYouTubePlaying();
    expect(getPlaybackModeActivity()).toEqual({ mode: 'youtube', activity: 'playing' });

    setPlaybackSystemAudioPlaying();
    expect(getPlaybackModeActivity()).toEqual({ mode: 'system-audio', activity: 'playing' });

    setPlaybackIdle();
    expect(getPlaybackModeActivity()).toEqual({ mode: null, activity: 'idle' });
  });

  it('evaluates mode/activity predicates against supplied snapshots', () => {
    expect(isPlaybackModeValue('file')).toBe(true);
    expect(isPlaybackModeValue('audio')).toBe(false);
    expect(isPlaybackActivityValue('playing')).toBe(true);
    expect(isPlaybackActivityValue('loading')).toBe(false);
    expect(isPlaybackPlayingFile({ mode: 'file', activity: 'playing' })).toBe(true);
    expect(isPlaybackPlayingFile({ mode: 'file', activity: 'paused' })).toBe(false);
    expect(isPlaybackPendingFile({ mode: 'file', activity: 'pending' })).toBe(true);
    expect(isPlaybackPausedOrPendingFile({ mode: 'file', activity: 'paused' })).toBe(true);
    expect(isPlaybackPausedOrPendingFile({ mode: 'file', activity: 'pending' })).toBe(true);
    expect(isPlaybackPausedOrPendingFile({ mode: 'youtube', activity: 'paused' })).toBe(false);
    expect(isPlaybackNonIdleFile({ mode: 'file', activity: 'paused' })).toBe(true);
    expect(isPlaybackNonIdleFile({ mode: 'file', activity: 'idle' })).toBe(false);
  });
});
