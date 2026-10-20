/**
 * Playlist names: the first playlist is just "Playlist"; the others add their
 * number ("Playlist 2"). A long name is cut before the number, so "Playl… 2"
 * still tells the playlists apart.
 */

import { t } from '../i18n/index.ts';

export function renderPlaylistSlotName(target: HTMLElement, slot: number): void {
  const base = document.createElement('span');
  base.className = 'playlist-slot-name-base';
  base.dir = 'auto';
  base.textContent = t('nav.playlist');
  if (slot === 0) {
    target.replaceChildren(base);
    return;
  }
  const number = document.createElement('span');
  number.className = 'playlist-slot-name-number';
  number.textContent = ` ${slot + 1}`;
  target.replaceChildren(base, number);
}
