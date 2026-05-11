import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const LEGACY_APPSTATE_PATTERN =
  /\bisAppState[A-Za-z0-9_]*\b|getState\('appState'\)|setState\('appState'\)|state:appState/;

const ALLOWED_LEGACY_APPSTATE_FILES = new Map<string, string>();

const LEGACY_APPSTATE_PROJECTION_PATTERN =
  /\b(getPlaybackLegacyAppState|setPlaybackAppState|deriveModeActivityFromAppState|deriveAppStateFromModeActivity|LegacyAppStateValue)\b/;
const IDLE_COMPAT_HELPER = 'isPlaybackIdleCompat';

const ALLOWED_IDLE_COMPAT_FILES = new Map<string, string>([
  ['src/player/playlist.ts', 'Historical idle guards preserve async decode race behavior.'],
  ['src/player/transport.ts', 'Stop/pause guards preserve old IDLE compatibility semantics.'],
  ['src/youtube/player.ts', 'Queue/indexing idle checks intentionally stay strict compat IDLE.'],
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
  it('keeps legacy APP_STATE out of core constants exports', () => {
    const constants = readFileSync(join(SRC_ROOT, 'core/constants.ts'), 'utf8');

    expect(constants).not.toContain('export const APP_STATE');
    expect(constants).not.toContain('export type AppStateValue');
  });

  it('keeps production code free of raw legacy appState state-slot access', () => {
    const files = listProductionTypeScriptFiles(SRC_ROOT);
    const actual = files
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

  it('keeps full legacy appState projection helpers out of production code', () => {
    const actual = listProductionTypeScriptFiles(SRC_ROOT)
      .filter((file) => {
        const content = readFileSync(file, 'utf8');
        return LEGACY_APPSTATE_PROJECTION_PATTERN.test(content);
      })
      .map(toRepoPath)
      .sort();

    expect(actual).toEqual([]);
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
