/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_LAYOUT_QUERY } from '../../core/layout-breakpoints.ts';

const mocks = vi.hoisted(() => ({
  desktop: true,
}));

vi.mock('../../core/timers.ts', () => ({
  clearManagedTimer: vi.fn(),
  setManagedTimer: vi.fn(),
}));

vi.mock('../../core/platform.ts', () => ({
  isCompactLandscape: vi.fn(() => false),
}));

vi.mock('../dom.ts', () => ({
  animateTransition: vi.fn((apply: () => void) => apply()),
  updateOverlayOpenClass: vi.fn(),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../player-controls.ts', () => ({
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  showPlacementToastForChannel: vi.fn(),
}));

vi.mock('../../core/wake-lock.ts', () => ({
  activateNoSleep: vi.fn(),
}));

vi.mock('../settings.ts', () => ({
  selectStandardChannelButton: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

import {
  setupSetCode,
  setupShowCodeArea,
  setupShowJoinArea,
  syncDesktopLeftPanel,
} from '../setup-shared.ts';

function renderSetup(): void {
  document.body.innerHTML = `
    <div id="setup-overlay" class="active">
      <div id="desktop-step-header"></div>
      <div id="desktop-diagram-area"></div>
      <div class="setup-mobile-view">
        <div id="setup-welcome-area" style="display: none"><div id="ob-slider-area"></div></div>
        <div id="setup-role-area" style="display: none"></div>
        <div id="setup-join-area" style="display: none">
          <div class="setup-header-text"><h2>Join</h2></div>
          <div id="guest-stage" class="setup-guest-qr-stage"></div>
        </div>
        <div id="setup-auto-join-area" style="display: none"></div>
        <div id="setup-code-area" style="display: none">
          <div class="setup-header-text"><h2>Start</h2></div>
          <div id="setup-host-invite-stage" class="setup-host-invite-stage"></div>
          <input id="setup-code" value="------">
        </div>
      </div>
    </div>
  `;
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

beforeEach(() => {
  mocks.desktop = true;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === DESKTOP_LAYOUT_QUERY ? mocks.desktop : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  renderSetup();
});

describe('desktop setup left panel', () => {
  it('keeps the host QR stage mounted while its code arrives', () => {
    setupShowCodeArea(true);
    const stage = el('setup-host-invite-stage');
    expect(stage.parentElement).toBe(el('desktop-diagram-area'));

    // Moving the stage out and back would restart its spinner and cancel the
    // QR crossfade that starts with the code.
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true, subtree: true });
    setupSetCode('654321');
    const stageMoves = observer
      .takeRecords()
      .filter((record) => [...record.addedNodes, ...record.removedNodes].includes(stage));
    observer.disconnect();

    expect(stageMoves).toHaveLength(0);
    expect(stage.parentElement).toBe(el('desktop-diagram-area'));
    expect((el('setup-code') as HTMLInputElement).value).toBe('654321');
    expect(el('desktop-step-header').textContent).toContain('Start');
  });

  it('returns the QR stage to its own place when another area takes the panel', () => {
    setupShowCodeArea(true);
    setupShowCodeArea(false);
    setupShowJoinArea(true);

    const stage = el('setup-host-invite-stage');
    expect(stage.parentElement).toBe(el('setup-code-area'));
    expect(stage.nextElementSibling?.id).toBe('setup-code');
    expect(el('guest-stage').parentElement).toBe(el('desktop-diagram-area'));
    expect(el('desktop-step-header').textContent).toContain('Join');
  });

  it('returns the mirrored diagram when the layout leaves desktop', () => {
    setupShowCodeArea(true);
    mocks.desktop = false;

    syncDesktopLeftPanel();

    expect(el('setup-host-invite-stage').parentElement).toBe(el('setup-code-area'));
    expect(el('desktop-diagram-area').children).toHaveLength(0);
    expect(el('desktop-step-header').children).toHaveLength(0);
  });
});
