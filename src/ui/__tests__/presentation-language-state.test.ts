/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { __resetAccountStateForTests, applyAccountSession } from '../../account/state.ts';
import { getResolvedLanguage, setLanguageMode, t } from '../../i18n/index.ts';
import { roomCapabilityRequiredMessage } from '../../rooms/permission-feedback.ts';
import type { DataConnection } from '../../types/index.ts';
import { initPlayerControls } from '../player-controls.ts';

beforeEach(() => {
  bus.clear();
  clearAllManagedTimers();
  resetState();
  __resetAccountStateForTests();
  localStorage.clear();
  setLanguageMode('en');
  document.body.innerHTML = `
    <button id="role-badge"><span id="role-text">LOGIN</span></button>
    <button id="play-btn"></button>
    <button id="btn-prev"></button>
    <button id="btn-next"></button>
  `;
});

afterEach(() => {
  clearAllManagedTimers();
  bus.clear();
});

describe('presentation copy follows the selected language without another state transition', () => {
  it('updates the stable anonymous account badge accessible label', () => {
    applyAccountSession({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    initPlayerControls();
    const badge = document.getElementById('role-badge')!;
    expect(badge.getAttribute('aria-label')).toBe(t('account.login_title'));

    for (const language of ['ko', 'en']) {
      setLanguageMode(language);
      expect(getResolvedLanguage()).toBe(language);
      expect(badge.getAttribute('aria-label')).toBe(t('account.login_title'));
      expect(document.getElementById('role-text')?.textContent).toBe('LOGIN');
    }
  });

  it('translates the authenticated badge label while preserving the account nickname', () => {
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Listener', profileComplete: true },
      statsScope: 's'.repeat(43),
    });
    initPlayerControls();
    for (const language of ['ko', 'en']) {
      setLanguageMode(language);
      expect(document.getElementById('role-badge')?.getAttribute('aria-label')).toBe(
        `${t('account.account_title')}: Listener`,
      );
      expect(document.getElementById('role-text')?.textContent).toBe('Listener');
    }
  });

  it.each(['standard', 'pro'] as const)(
    'updates denied transport tooltips while the %s guest authority is unchanged',
    (kind) => {
      setState('network.appRole', 'guest');
      setState('network.hostConn', {
        peer: 'host',
        open: true,
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      } as unknown as DataConnection);
      if (kind === 'pro') {
        setState('room.context', {
          kind: 'pro',
          roomId: '000001',
          role: 'member',
          coordinatorId: 'coordinator-1',
          epoch: 1,
          snapshotRevision: 1,
          capabilities: [],
        });
      }
      const room = getState('room.context');
      const connection = getState('network.hostConn');
      initPlayerControls();
      const buttons = ['play-btn', 'btn-prev', 'btn-next'].map((id) =>
        document.getElementById(id)!,
      );
      for (const button of buttons) {
        expect(button.title).toBe(roomCapabilityRequiredMessage('playback.control'));
        expect(button.getAttribute('aria-disabled')).toBe('true');
      }

      for (const language of ['ko', 'en']) {
        setLanguageMode(language);
        expect(getResolvedLanguage()).toBe(language);
        for (const button of buttons) {
          expect(button.title).toBe(roomCapabilityRequiredMessage('playback.control'));
          expect(button.getAttribute('aria-disabled')).toBe('true');
        }
        expect(getState('room.context')).toBe(room);
        expect(getState('network.hostConn')).toBe(connection);
      }
    },
  );
});
