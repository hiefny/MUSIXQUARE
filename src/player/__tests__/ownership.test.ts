import { beforeEach, describe, expect, it } from 'vitest';
import { APP_STATE, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import {
  claimPlaybackOwner,
  createFileTrackMeta,
  createSystemAudioTrackMeta,
  createYouTubeTrackMeta,
  getPlaybackModeActivity,
  getPlaybackOwnership,
  isAppStateIdle,
  isAppStatePaused,
  isAppStatePlayingAudio,
  isAppStatePlayingSystemAudio,
  isAppStatePlayingYouTube,
  isExternalOwner,
  isSystemAudioOwner,
  isSystemAudioPlaceholderMeta,
  releasePlaybackOwner,
  setPlaybackAppState,
  setPlaybackTrackMeta,
  updatePlaybackTrackMeta,
  updatePlaybackTrackTitle,
} from '../ownership.ts';

beforeEach(() => {
  resetState();
});

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
  });

  it('treats YouTube as an external owner', () => {
    setState('appState', APP_STATE.PLAYING_YOUTUBE);

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'youtube',
      mode: 'youtube',
      activity: 'playing',
      isExternalOwner: true,
    });
    expect(isExternalOwner()).toBe(true);
    expect(isAppStatePlayingYouTube()).toBe(true);
  });

  it('exposes appState-specific playback predicates', () => {
    expect(isAppStateIdle()).toBe(true);

    setState('appState', APP_STATE.PLAYING_AUDIO);
    expect(isAppStatePlayingAudio()).toBe(true);
    expect(isAppStateIdle()).toBe(false);

    setState('appState', APP_STATE.PAUSED);
    expect(isAppStatePaused()).toBe(true);
  });

  it('treats system audio app state as an external owner', () => {
    setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      mode: 'system-audio',
      activity: 'playing',
      isExternalOwner: true,
    });
    expect(isAppStatePlayingSystemAudio()).toBe(true);
    expect(isSystemAudioOwner()).toBe(true);
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
    expect(isAppStatePlayingSystemAudio()).toBe(false);
    expect(isSystemAudioOwner()).toBe(true);
  });

  it('treats active file lifecycle or transfer work as file ownership', () => {
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'file',
      mode: 'file',
      activity: 'pending',
      hasFilePipeline: true,
      isExternalOwner: false,
    });

    resetState();
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'file',
      mode: 'file',
      activity: 'pending',
      hasFilePipeline: true,
      isExternalOwner: false,
    });
  });

  it('claims active system-audio ownership with canonical metadata', () => {
    claimPlaybackOwner('system-audio', {
      currentTrackMeta: createSystemAudioTrackMeta('sharing'),
    });

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      mode: 'system-audio',
      activity: 'playing',
      appState: APP_STATE.PLAYING_SYSTEM_AUDIO,
      currentTrackMeta: {
        name: 'system-audio',
        title: 'System Audio Sharing',
      },
    });
  });

  it('claims pending system-audio ownership without changing appState', () => {
    claimPlaybackOwner('system-audio', {
      pending: true,
      currentTrackMeta: createSystemAudioTrackMeta('receiving'),
    });

    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'system-audio',
      mode: 'system-audio',
      activity: 'pending',
      appState: APP_STATE.IDLE,
      isSystemAudioPlaceholder: true,
    });
  });

  it('releases only the requested owner unless forced', () => {
    setState('appState', APP_STATE.PLAYING_YOUTUBE);
    const before = getPlaybackOwnership();

    releasePlaybackOwner('system-audio', { nextAppState: APP_STATE.IDLE });
    expect(getPlaybackOwnership()).toEqual(before);

    releasePlaybackOwner('system-audio', {
      force: true,
      nextAppState: APP_STATE.IDLE,
      currentTrackMeta: null,
    });
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'none',
      mode: null,
      activity: 'idle',
      appState: APP_STATE.IDLE,
      currentTrackMeta: null,
    });
  });

  it('sets track metadata through the ownership write helper', () => {
    setPlaybackTrackMeta({ type: 'file', name: 'track.mp3', title: 'Track' });

    expect(getPlaybackOwnership().currentTrackMeta).toMatchObject({
      name: 'track.mp3',
      title: 'Track',
    });
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

  it('routes playback app state changes through ownership claims', () => {
    setPlaybackAppState(APP_STATE.PLAYING_AUDIO);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'file',
      mode: 'file',
      activity: 'playing',
      appState: APP_STATE.PLAYING_AUDIO,
    });

    setPlaybackAppState(APP_STATE.PLAYING_YOUTUBE);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'youtube',
      mode: 'youtube',
      activity: 'playing',
      appState: APP_STATE.PLAYING_YOUTUBE,
      isExternalOwner: true,
    });

    setPlaybackAppState(APP_STATE.PAUSED);
    expect(getPlaybackOwnership()).toMatchObject({
      owner: 'none',
      mode: 'file',
      activity: 'paused',
      appState: APP_STATE.PAUSED,
    });
    expect(getPlaybackModeActivity()).toEqual({ mode: 'file', activity: 'paused' });
  });
});
