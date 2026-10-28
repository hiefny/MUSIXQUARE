/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';

const { switchPlaylist } = vi.hoisted(() => ({ switchPlaylist: vi.fn(() => true) }));

vi.mock('../../player/playlist.ts', () => ({
  switchPlaylist,
  transferTracks: vi.fn(() => true),
}));

// The dialog module binds its buttons once, so the markup stays for the file.
beforeAll(() => {
  const parsed = new DOMParser().parseFromString(
    readFileSync(resolve('index.html'), 'utf8'),
    'text/html',
  );
  document.body.innerHTML = parsed.body.innerHTML;
});

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  switchPlaylist.mockClear();
  setState('playlist.slots', {
    activeSlot: 0,
    slots: [
      { count: 4, bytes: 1024 },
      { count: 2, bytes: 512 },
      { count: 0, bytes: null },
    ],
  });
});

afterEach(() => {
  overlay().classList.remove('show');
  overlay().setAttribute('aria-hidden', 'true');
  vi.useRealTimers();
});

const overlay = () => document.getElementById('playlist-slots-overlay')!;
const rows = () =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>('#playlist-slots-list .playlist-slot-option'),
  );

describe('playlist switcher exit', () => {
  it('puts Cancel on the left of OK, as the [exit | primary] pair', () => {
    // Owner policy (2026-10-28): every leavable window shows a visible exit,
    // on the left of a two-button pair; RTL mirrors it with the document.
    const actions = Array.from(
      overlay().querySelectorAll<HTMLButtonElement>('.dialog-actions > button'),
    );
    expect(actions.map((button) => button.id)).toEqual([
      'btn-playlist-slots-cancel',
      'btn-playlist-slots-done',
    ]);
    const [cancel, ok] = actions;
    expect(cancel?.type).toBe('button');
    expect(cancel?.classList.contains('dialog-secondary')).toBe(true);
    expect(cancel?.dataset.i18n).toBe('common.cancel');
    expect(ok?.classList.contains('dialog-primary')).toBe(true);
    expect(ok?.dataset.i18n).toBe('common.ok');
  });

  it('closes on Cancel without switching, after another playlist was chosen', async () => {
    const { openPlaylistSlotsDialog } = await import('../playlist-slots-dialog.ts');
    openPlaylistSlotsDialog();
    expect(overlay().classList.contains('show')).toBe(true);
    rows()[1]!.click();
    expect(rows()[1]!.getAttribute('aria-pressed')).toBe('true');

    document.getElementById('btn-playlist-slots-cancel')!.click();

    expect(overlay().classList.contains('show')).toBe(false);
    expect(overlay().getAttribute('aria-hidden')).toBe('true');
    expect(switchPlaylist).not.toHaveBeenCalled();

    // The next opening starts from the active playlist again.
    openPlaylistSlotsDialog();
    expect(rows().map((row) => row.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    document.getElementById('btn-playlist-slots-done')!.click();
    expect(switchPlaylist).not.toHaveBeenCalled();
  });

  it('still switches the room on OK after another playlist was chosen', async () => {
    const { openPlaylistSlotsDialog } = await import('../playlist-slots-dialog.ts');
    openPlaylistSlotsDialog();
    rows()[2]!.click();

    document.getElementById('btn-playlist-slots-done')!.click();

    expect(overlay().classList.contains('show')).toBe(false);
    expect(switchPlaylist).toHaveBeenCalledExactlyOnceWith(2);
  });
});
