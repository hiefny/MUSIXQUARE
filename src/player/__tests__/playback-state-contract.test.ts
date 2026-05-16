import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const REMOVED_APPSTATE_SLOT_PATTERN =
  /\bisAppState[A-Za-z0-9_]*\b|getState\('appState'\)|setState\('appState'\)|state:appState/;

const ALLOWED_REMOVED_APPSTATE_SLOT_FILES = new Map<string, string>();

const REMOVED_APPSTATE_PROJECTION_PATTERN =
  /\b(getPlaybackLegacyAppState|setPlaybackAppState|deriveModeActivityFromAppState|deriveAppStateFromModeActivity|LegacyAppStateValue)\b/;
const IDLE_COMPAT_HELPER = 'isPlaybackIdleCompat';
const DIRECT_PLAYBACK_MODE_ACTIVITY_WRITE_PATTERN =
  /\bsetState\s*\(\s*['"]playback\.(?:mode|activity)['"]|\bbatchSetState\s*\(\s*\{[\s\S]*?['"]playback\.(?:mode|activity)['"]/;

const ALLOWED_IDLE_COMPAT_FILES = new Map<string, string>([
  ['src/player/playlist.ts', 'Historical idle guards preserve async decode race behavior.'],
  ['src/player/transport.ts', 'Stop/pause guards preserve old IDLE compatibility semantics.'],
  ['src/youtube/player.ts', 'Queue/indexing idle checks intentionally stay strict compat IDLE.'],
]);
const ALLOWED_DIRECT_PLAYBACK_MODE_ACTIVITY_WRITE_FILES = new Map<string, string>([
  ['src/player/ownership.ts', 'Central writer for playback mode/activity ownership slots.'],
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

describe('playback state contract', () => {
  it('keeps removed APP_STATE exports out of core constants', () => {
    const constants = readFileSync(join(SRC_ROOT, 'core/constants.ts'), 'utf8');

    expect(constants).not.toContain('export const APP_STATE');
    expect(constants).not.toContain('export type AppStateValue');
  });

  it('keeps production code free of removed appState state-slot access', () => {
    const files = listProductionTypeScriptFiles(SRC_ROOT);
    const actual = files
      .filter((file) => REMOVED_APPSTATE_SLOT_PATTERN.test(readFileSync(file, 'utf8')))
      .map(toRepoPath)
      .sort();

    const expected = [...ALLOWED_REMOVED_APPSTATE_SLOT_FILES.keys()].sort();

    expect(actual).toEqual(expected);

    for (const file of expected) {
      expect(existsSync(join(process.cwd(), file))).toBe(true);
      expect(ALLOWED_REMOVED_APPSTATE_SLOT_FILES.get(file)).toBeTruthy();
    }
  });

  it('keeps removed appState projection helpers out of production code', () => {
    const actual = listProductionTypeScriptFiles(SRC_ROOT)
      .filter((file) => {
        const content = readFileSync(file, 'utf8');
        return REMOVED_APPSTATE_PROJECTION_PATTERN.test(content);
      })
      .map(toRepoPath)
      .sort();

    expect(actual).toEqual([]);
  });

  it('keeps playback mode/activity production writes centralized', () => {
    const actual = listProductionTypeScriptFiles(SRC_ROOT)
      .filter((file) => {
        const content = readFileSync(file, 'utf8');
        return DIRECT_PLAYBACK_MODE_ACTIVITY_WRITE_PATTERN.test(content);
      })
      .map(toRepoPath)
      .sort();

    const expected = [...ALLOWED_DIRECT_PLAYBACK_MODE_ACTIVITY_WRITE_FILES.keys()].sort();

    expect(actual).toEqual(expected);

    for (const file of expected) {
      expect(existsSync(join(process.cwd(), file))).toBe(true);
      expect(ALLOWED_DIRECT_PLAYBACK_MODE_ACTIVITY_WRITE_FILES.get(file)).toBeTruthy();
    }
  });

  it('keeps IDLE compatibility predicate consumers documented', () => {
    const actual = listProductionTypeScriptFiles(SRC_ROOT)
      .filter((file) => {
        const content = readFileSync(file, 'utf8');
        return content.includes(IDLE_COMPAT_HELPER);
      })
      .map(toRepoPath)
      .filter((file) => file !== 'src/player/ownership.ts')
      .sort();

    const expected = [...ALLOWED_IDLE_COMPAT_FILES.keys()].sort();

    expect(actual).toEqual(expected);

    for (const file of expected) {
      expect(existsSync(join(process.cwd(), file))).toBe(true);
      expect(ALLOWED_IDLE_COMPAT_FILES.get(file)).toBeTruthy();
    }
  });
});
