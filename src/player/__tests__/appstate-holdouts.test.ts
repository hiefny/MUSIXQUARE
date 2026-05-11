import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const LEGACY_APPSTATE_PATTERN =
  /\bisAppState[A-Za-z0-9_]*\b|getState\('appState'\)|setState\('appState'\)|state:appState/;

const ALLOWED_LEGACY_APPSTATE_FILES = new Map<string, string>([
  [
    'src/audio/beat-detector.ts',
    'Module-local cache intentionally follows state:appState for BPM analysis freshness.',
  ],
  ['src/chat/commands.ts', 'Debug/status output still reports the legacy enum alongside mode/activity.'],
  ['src/network/sync.ts', 'SYNC_PONG wire compatibility still dual-emits and accepts appState.'],
  ['src/player/decode.ts', 'Terminal file cleanup still clears strict PLAYING_AUDIO/PAUSED state.'],
  ['src/player/ownership.ts', 'Single bridge between legacy appState and playback mode/activity.'],
  ['src/player/playback.ts', 'Late-join bootstrap still carries legacy protocol state.'],
  ['src/player/playlist.ts', 'Historical idle guards protect async decode and previous-track races.'],
  ['src/player/transport.ts', 'Central legacy appState transition owner until source-of-truth flip.'],
  ['src/player/video.ts', 'Central media-engine mode bridge writes legacy appState.'],
  ['src/types/index.ts', 'State tree and EventMap keep appState types until removal phase.'],
  ['src/youtube/player.ts', 'Queue/indexing idle checks intentionally stay strict legacy IDLE.'],
]);

function listProductionTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...listProductionTypeScriptFiles(fullPath));
      continue;
    }

    if (entry.endsWith('.ts')) files.push(fullPath);
  }

  return files;
}

function toRepoPath(path: string): string {
  return relative(process.cwd(), path).replace(/\\/g, '/');
}

describe('legacy appState holdouts', () => {
  it('keeps production legacy appState readers inside the documented boundary', () => {
    const actual = listProductionTypeScriptFiles(SRC_ROOT)
      .filter((file) => LEGACY_APPSTATE_PATTERN.test(readFileSync(file, 'utf8')))
      .map(toRepoPath)
      .sort();

    const expected = [...ALLOWED_LEGACY_APPSTATE_FILES.keys()].sort();

    expect(actual).toEqual(expected);

    for (const file of expected) {
      expect(existsSync(join(process.cwd(), file))).toBe(true);
      expect(ALLOWED_LEGACY_APPSTATE_FILES.get(file)).toBeTruthy();
    }
  });
});
