/**
 * Preserve the reviewed cycle-breaking dynamic edge while giving every lazy
 * caller one mockable import boundary. playlist.ts is already in the startup
 * graph through the app/runtime controls, so this is not a chunk boundary.
 */
type PlaylistModule = typeof import('./playlist.ts');

export function loadPlaylistModule(): Promise<PlaylistModule> {
  return import('./playlist.ts');
}
