/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { handleData } from '../../network/protocol.ts';
import { setRepeatMode, setShuffle, clearPreloadState, initPlaylist } from '../playlist.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

function makeConnection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

function makeConnectedPeer(id: string, isOp: boolean): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: null,
    isOp,
    preloadedIndexes: new Set<number>(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: 0,
  };
}

describe('setRepeatMode', () => {
  it('sets repeat mode 0 (off)', () => {
    setRepeatMode(0, false);
    expect(getState('playlist.repeatMode')).toBe(0);
  });

  it('sets repeat mode 1 (all)', () => {
    setRepeatMode(1, false);
    expect(getState('playlist.repeatMode')).toBe(1);
  });

  it('sets repeat mode 2 (one)', () => {
    setRepeatMode(2, false);
    expect(getState('playlist.repeatMode')).toBe(2);
  });
});

describe('setShuffle', () => {
  it('enables shuffle', () => {
    setShuffle(true, false);
    expect(getState('playlist.isShuffle')).toBe(true);
  });

  it('disables shuffle', () => {
    setShuffle(false, false);
    expect(getState('playlist.isShuffle')).toBe(false);
  });
});

describe('clearPreloadState', () => {
  it('resets preload.nextTrackIndex to -1', () => {
    setRepeatMode(0, false); // ensure state initialized
    clearPreloadState();
    expect(getState('preload.nextTrackIndex')).toBe(-1);
  });
});

describe('request-setting authorization', () => {
  beforeEach(() => {
    initPlaylist();
  });

  it('lets demo non-operators use only the settings exposed by demo UI', async () => {
    const conn = makeConnection('guest-demo');
    setState('demo.active', true);

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.VBASS, value: 60 }, conn);
    expect(getState('audio.virtualBass')).toBeCloseTo(0.6);

    await handleData(
      { type: MSG.REQUEST_SETTING, settingType: MSG.STEREO_WIDTH, value: 120 },
      conn,
    );
    expect(getState('audio.stereoWidth')).toBeCloseTo(1.2);

    const beforeDecay = getState('audio.reverbDecay');
    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.REVERB_DECAY, value: 8 }, conn);
    expect(getState('audio.reverbDecay')).toBe(beforeDecay);
  });

  it('still allows operators to apply full request-setting effects', async () => {
    const conn = makeConnection('guest-op');
    getState('network.connectedPeers').push(makeConnectedPeer(conn.peer, true));

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.REVERB_DECAY, value: 8 }, conn);

    expect(getState('audio.reverbDecay')).toBe(8);
  });
});
