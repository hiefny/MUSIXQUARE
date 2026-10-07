/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../audio/engine.ts';
import {
  acceptCanonicalRoomSettings,
  captureRoomSettingsSyncState,
  resetSettingsSyncAuthorityForTests,
  setSettingsSyncEnabled,
} from '../../audio/effects.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initSync } from '../../network/sync.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';
import { setPlaybackFilePaused } from '../../player/ownership.ts';
import { stopAllMedia } from '../../player/transport.ts';
import type { DataConnection } from '../../types/index.ts';
import { __resetModalStackForTests } from '../dom.ts';
import { closeManualSyncOverlayRuntime } from '../manual-sync-overlay-runtime.ts';
import { initPlayerControls } from '../player-controls.ts';
import { initSettings } from '../settings.ts';

vi.mock('../toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));

const queueItemId = '00000000-0000-4000-8000-000000000001';

function element(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function slider(id: string): HTMLInputElement {
  return element(id) as HTMLInputElement;
}

function inputVolume(id: string, value: number): void {
  slider(id).value = String(value);
  slider(id).dispatchEvent(new Event('input', { bubbles: true }));
}

function expectVolume(value: number): void {
  expect(getState('audio.masterVolume')).toBe(value / 100);
  for (const id of ['volume-slider', 'demo-volume-slider']) {
    expect(Number(slider(id).value)).toBeCloseTo(value);
    expect(Number.parseFloat(slider(id).style.getPropertyValue('--range-progress'))).toBeCloseTo(
      value,
    );
  }
  for (const id of ['vol-icon-btn', 'demo-vol-icon-btn']) {
    expect(element(id).classList.contains('is-muted')).toBe(value === 0);
    expect(element(id).getAttribute('aria-pressed')).toBe(String(value === 0));
  }
}

function expectVolumeLocked(locked: boolean): void {
  for (const id of ['volume-slider', 'demo-volume-slider', 'vol-icon-btn', 'demo-vol-icon-btn']) {
    expect((element(id) as HTMLInputElement).disabled).toBe(locked);
    expect(element(id).getAttribute('aria-disabled')).toBe(String(locked));
  }
}

function readyFile(): void {
  setState('playlist.items', [
    { queueItemId, type: 'file', name: 'Ready.wav', videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', queueItemId);
  setCurrentAudioBuffer({ duration: 30 } as AudioBuffer);
  setPlaybackFilePaused();
}

beforeAll(() => {
  // Retain the production engine listeners and mount the real manual-offset
  // command handlers once. These tests do not substitute a volume/state bridge.
  initSync();
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('musixquare-theme', 'light');
  resetState();
  resetSettingsSyncAuthorityForTests();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  document.body.innerHTML = `
    <div id="volume-control-group">
      <button id="vol-icon-btn">Mute</button>
      <input id="volume-slider" type="range" min="0" max="100">
    </div>
    <div class="demo-track-header">
      <div class="demo-controls-pill">
        <button id="btn-demo-settings" aria-controls="demo-inline-controls" aria-expanded="false">Settings</button>
        <div id="demo-inline-controls" class="demo-inline-controls" inert aria-hidden="true">
          <div id="demo-volume-control-group">
            <button id="demo-vol-icon-btn">Mute</button>
            <input id="demo-volume-slider" type="range" min="0" max="100">
          </div>
          <button id="btn-demo-sync">Sync</button>
        </div>
      </div>
      <div class="demo-track-copy">Demo</div>
    </div>
    <button id="btn-sync"><span data-i18n="player.sync_compact">Sync</span></button>
    <div id="manual-sync-overlay" aria-hidden="true">
      <div role="dialog" aria-modal="true">
        <div id="manual-sync-value" contenteditable="true" tabindex="0" role="textbox">0</div>
        <div class="sync-nudge-row">
          <button id="btn-nudge-minus10">-10</button>
          <button id="btn-nudge-minus1">-1</button>
          <button id="btn-nudge-plus1">+1</button>
          <button id="btn-nudge-plus10">+10</button>
        </div>
        <button id="btn-auto-sync">Reset</button>
        <button id="btn-sync-done">Done</button>
      </div>
    </div>
  `;
  __resetModalStackForTests();
});

afterEach(() => {
  closeManualSyncOverlayRuntime();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  __resetModalStackForTests();
  document.body.innerHTML = '';
});

describe('volume and manual-sync UI consistency across real command handlers', () => {
  it('keeps both sliders and mute icons consistent across expanded-demo and main controls', () => {
    setState('demo.active', true);
    initPlayerControls();
    element('btn-demo-settings').click();
    expect(element('demo-inline-controls').getAttribute('aria-hidden')).toBe('false');

    inputVolume('demo-volume-slider', 37);
    expectVolume(37);
    element('vol-icon-btn').click();
    expectVolume(0);
    element('demo-vol-icon-btn').click();
    expectVolume(37);

    // A later canonical/engine update must also repaint the collapsed pill.
    element('btn-demo-settings').click();
    bus.emit('audio:set-volume', 0.62);
    element('btn-demo-settings').click();
    expectVolume(62);
  });

  it.each(['standard', 'pro'] as const)(
    'keeps %s authority revocation, locked stale input, and sync OFF consistent on both surfaces',
    (kind) => {
      setState('network.appRole', kind === 'standard' ? 'guest' : 'host');
      if (kind === 'standard') {
        setState('network.hostConn', {
          peer: 'host',
          open: true,
          send: vi.fn(),
        } as unknown as DataConnection);
        setState('network.isOperator', true);
        setState('network.standardRoomCapabilities', ['effects.control']);
      } else {
        setState('room.context', {
          kind: 'pro',
          roomId: '000001',
          role: 'member',
          coordinatorId: null,
          epoch: 1,
          snapshotRevision: 1,
          capabilities: ['effects.control'],
        });
      }
      setState('setup.sessionStarted', true);
      initPlayerControls();
      expectVolumeLocked(false);
      inputVolume('volume-slider', 41);
      expectVolume(41);

      if (kind === 'standard') setState('network.standardRoomCapabilities', []);
      else setState('room.context', { ...getState('room.context'), capabilities: [] });
      expectVolumeLocked(true);
      inputVolume('demo-volume-slider', 99);
      expectVolume(41);
      element('vol-icon-btn').click();
      expectVolume(41);

      setSettingsSyncEnabled(false);
      expectVolumeLocked(false);
      inputVolume('demo-volume-slider', 28);
      expectVolume(28);
      // OFF retains a PRO canonical value without changing local output.
      if (kind === 'pro') {
        acceptCanonicalRoomSettings(captureRoomSettingsSyncState().effects, 0.73);
        expectVolume(28);
        setSettingsSyncEnabled(true);
        expectVolumeLocked(true);
        // PRO's runtime re-fetches and projects the canonical value after ON;
        // the authority projection below is that asynchronous response seam.
        acceptCanonicalRoomSettings(captureRoomSettingsSyncState().effects, 0.73);
        expectVolume(73);
      }
    },
  );

  it.each(['demo', 'standard host'] as const)(
    'keeps %s editor milliseconds, committed offset, nudge, reset, and reopen consistent',
    async (mode) => {
      if (mode === 'demo') {
        setState('demo.active', true);
        setState('demo.loading', true);
      } else {
        setState('network.appRole', 'host');
        setState('network.sessionCode', '123456');
        setState('setup.sessionStarted', true);
        readyFile();
      }
      setState('sync.localOffset', 0.237);
      initSettings();
      initPlayerControls();
      const open = async () => {
        if (mode === 'demo' && element('demo-inline-controls').hasAttribute('inert')) {
          element('btn-demo-settings').click();
        }
        element(mode === 'demo' ? 'btn-demo-sync' : 'btn-sync').click();
        await vi.dynamicImportSettled();
      };
      await open();
      const editor = element('manual-sync-value');
      expect(editor.textContent).toBe('+237');
      editor.textContent = '−１２３';
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(getState('sync.localOffset')).toBe(-0.123);
      expect(editor.textContent).toBe('-123');

      element('btn-nudge-plus10').click();
      expect(getState('sync.localOffset')).toBeCloseTo(-0.113);
      expect(editor.textContent).toBe('-113');
      element('btn-auto-sync').click();
      expect(getState('sync.localOffset')).toBe(0);
      expect(editor.textContent).toBe('0');
      element('btn-sync-done').click();
      expect(element('manual-sync-overlay').getAttribute('aria-hidden')).toBe('true');

      await open();
      expect(editor.textContent).toBe('0');
      if (mode === 'standard host') {
        stopAllMedia({ cancelInFlight: true, clearBuffer: true });
        expect(element('manual-sync-overlay').getAttribute('aria-hidden')).toBe('true');
        expect(element('btn-sync').getAttribute('aria-disabled')).toBe('true');
        readyFile();
        await open();
        expect(editor.textContent).toBe('0');
        expect(element('manual-sync-overlay').getAttribute('aria-hidden')).toBe('false');
      }
    },
  );
});
