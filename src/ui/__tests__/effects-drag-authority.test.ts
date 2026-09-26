/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureRoomSettingsSyncState,
  initEffectsHandlers,
  resetSettingsSyncAuthorityForTests,
} from '../../audio/effects.ts';
import { MSG } from '../../core/constants.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initGuestProtocolHandlers } from '../../network/guest.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import type { DataConnection, RoomSettingsSyncState } from '../../types/index.ts';
import { installRangeDragGuard } from '../range-drag.ts';
import { initSettings } from '../settings.ts';

vi.mock('../toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));

const canonical: RoomSettingsSyncState = {
  masterVolume: 1,
  effects: {
    ...createDefaultRoomEffectsState(),
    reverb: { ...createDefaultRoomEffectsState().reverb, mixPercent: 23 },
    equalizer: { bandsDb: [2, 0, 0, 0, 0] },
  },
};

function pointer(range: HTMLInputElement, type: string, value: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const isEq = range.classList.contains('eq-slider');
  for (const [key, coordinate] of Object.entries({
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX: isEq ? 50 : value,
    clientY: isEq ? ((12 - value) / 24) * 100 : 50,
  })) {
    Object.defineProperty(event, key, { value: coordinate });
  }
  range.dispatchEvent(event);
}

function captureRange(id: string): HTMLInputElement {
  const range = document.getElementById(id) as HTMLInputElement;
  vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  });
  // jsdom does not implement native pointer capture. Model only its ownership;
  // input/change, permission projection, snapshots and range updates are real.
  let captured: number | null = null;
  range.setPointerCapture = vi.fn((id: number) => {
    captured = id;
  });
  range.hasPointerCapture = vi.fn((id: number) => captured === id);
  range.releasePointerCapture = vi.fn((id: number) => {
    if (captured === id) captured = null;
  });
  return range;
}

async function establishAdministrator() {
  const send = vi.fn();
  const conn = { peer: 'effects-host', open: true, send } as unknown as DataConnection;
  resetInboundRateLimit(conn.peer);
  setState('network.appRole', 'guest');
  setState('network.hostConn', conn);
  setState('room.context', { ...getState('room.context'), roomId: '123456', role: 'member' });
  setState('setup.sessionStarted', true);
  initSettings();
  installRangeDragGuard();
  await handleData(
    { type: MSG.OPERATOR_GRANT, capabilities: ['effects.control'], silent: true },
    conn,
  );
  await handleData(
    {
      type: MSG.SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      epoch: 0,
      sequence: 0,
      settings: canonical,
      _bootstrap: true,
    },
    conn,
  );
  return { conn, send };
}

beforeAll(() => {
  initGuestProtocolHandlers();
  initEffectsHandlers();
});

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  resetState();
  resetSettingsSyncAuthorityForTests();
  localStorage.clear();
  localStorage.setItem('musixquare-theme', 'light');
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  document.body.innerHTML = `
    <div id="grid-reverb">
      <button data-rvb-type="advanced" class="ch-opt">Advanced</button>
      <button data-rvb-type="off" class="ch-opt">Off</button>
    </div>
    <div id="reverb-sliders-area">
      <span id="val-reverb"></span>
      <input id="reverb-slider" type="range" min="0" max="100" step="1">
    </div>
    <div id="grid-eq">
      <button data-eq-type="advanced" class="ch-opt">Advanced</button>
      <button data-eq-type="off" class="ch-opt">Off</button>
    </div>
    <div id="eq-sliders-area">
      ${Array.from(
        { length: 5 },
        (_, band) => `
        <span id="eq-val-${band}"></span>
        <input id="eq-slider-${band}" class="eq-slider" type="range" min="-12" max="12" step="1">
      `,
      ).join('')}
    </div>
  `;
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('effects pointer ownership across live authority revocation', () => {
  const cases = [
    {
      id: 'reverb-slider',
      initial: 23,
      preview: 40,
      afterRevoke: 80,
      read: () => getState('audio.reverbMix') * 100,
    },
    {
      id: 'eq-slider-0',
      initial: 2,
      preview: 6,
      afterRevoke: 12,
      read: () => getState('audio.eqValues')[0],
    },
  ];

  it.each(cases)(
    'keeps $id canonical after revocation while its pointer is captured',
    async ({ id, initial, preview, afterRevoke, read }) => {
      const { conn, send } = await establishAdministrator();
      const range = captureRange(id);
      expect(range.disabled).toBe(false);
      expect(Number(range.value)).toBe(initial);
      pointer(range, 'pointerdown', preview);
      expect(range.hasPointerCapture(1)).toBe(true);
      expect(read()).toBe(preview);
      expect(send).not.toHaveBeenCalled();

      // A remote owner can revoke while this browser is holding the pointer.
      // host.ts resyncDemotedStandardPeer sends this quiet canonical snapshot
      // immediately after the revoke on the ordered connection.
      await handleData({ type: MSG.OPERATOR_REVOKE, silent: true }, conn);
      await handleData(
        {
          type: MSG.SETTINGS_SYNC_SNAPSHOT,
          version: 1,
          epoch: 0,
          sequence: 0,
          settings: canonical,
          _bootstrap: true,
        },
        conn,
      );
      expect(range.disabled).toBe(true);
      expect(Number(range.value)).toBe(initial);
      expect(read()).toBe(initial);

      // Native capture continues to route the owning pointer even when the
      // range becomes disabled / pointer-events:none between its down and up.
      pointer(range, 'pointermove', afterRevoke);
      pointer(range, 'pointerup', afterRevoke);
      expect(range.hasPointerCapture(1)).toBe(false);
      expect(range.classList.contains('is-dragging')).toBe(false);
      expect(read()).toBe(initial);
      expect(send).not.toHaveBeenCalled();
      expect(Number(range.value)).toBe(initial);
      const expectedProgress = id === 'eq-slider-0' ? ((initial + 12) / 24) * 100 : initial;
      expect(Number.parseFloat(range.style.getPropertyValue('--range-progress'))).toBeCloseTo(
        expectedProgress,
      );
    },
  );

  it.each(cases)(
    'releases a revoked $id without emitting input or change when the pointer does not move',
    async ({ id, initial, preview, read }) => {
      const { conn, send } = await establishAdministrator();
      const range = captureRange(id);
      pointer(range, 'pointerdown', preview);
      expect(range.hasPointerCapture(1)).toBe(true);
      expect(read()).toBe(preview);
      await handleData({ type: MSG.OPERATOR_REVOKE, silent: true }, conn);
      await handleData(
        {
          type: MSG.SETTINGS_SYNC_SNAPSHOT,
          version: 1,
          epoch: 0,
          sequence: 0,
          settings: canonical,
          _bootstrap: true,
        },
        conn,
      );
      const input = vi.fn();
      const change = vi.fn();
      range.addEventListener('input', input);
      range.addEventListener('change', change);

      pointer(range, 'pointerup', preview);
      pointer(range, 'lostpointercapture', preview);
      expect(range.hasPointerCapture(1)).toBe(false);
      expect(range.classList.contains('is-dragging')).toBe(false);
      expect(input).not.toHaveBeenCalled();
      expect(change).not.toHaveBeenCalled();
      expect(read()).toBe(initial);
      expect(Number(range.value)).toBe(initial);
      expect(send).not.toHaveBeenCalled();

      // The retired gesture must not prevent a later, newly authorized drag.
      await handleData(
        { type: MSG.OPERATOR_GRANT, capabilities: ['effects.control'], silent: true },
        conn,
      );
      expect(range.disabled).toBe(false);
      pointer(range, 'pointerdown', preview);
      pointer(range, 'pointerup', preview);
      expect(input).toHaveBeenCalledOnce();
      expect(change).toHaveBeenCalledOnce();
      expect(read()).toBe(preview);
      expect(send).toHaveBeenCalledExactlyOnceWith({
        type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
        version: 1,
        settings: captureRoomSettingsSyncState(),
      });
    },
  );

  it.each(cases)(
    'still previews and publishes an authorized $id drag once',
    async ({ id, preview, afterRevoke, read }) => {
      const { send } = await establishAdministrator();
      const range = captureRange(id);
      pointer(range, 'pointerdown', preview);
      pointer(range, 'pointermove', afterRevoke);
      expect(read()).toBe(afterRevoke);
      expect(send).not.toHaveBeenCalled();
      pointer(range, 'pointerup', afterRevoke);
      expect(Number(range.value)).toBe(afterRevoke);
      expect(send).toHaveBeenCalledExactlyOnceWith({
        type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
        version: 1,
        settings: captureRoomSettingsSyncState(),
      });
    },
  );
});
