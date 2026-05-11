import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const LEGACY_APPSTATE_PATTERN =
  /\bisAppState[A-Za-z0-9_]*\b|getState\('appState'\)|setState\('appState'\)|state:appState/;

const ALLOWED_LEGACY_APPSTATE_FILES = new Map<string, string>();

const ALLOWED_OWNERSHIP_APPSTATE_CONSUMER_FILES = new Map<string, string>();

const LEGACY_APPSTATE_COMPAT_HELPER = 'getPlaybackLegacyAppState';
const LEGACY_IDLE_COMPAT_HELPER = 'isPlaybackLegacyIdle';

const ALLOWED_LEGACY_IDLE_COMPAT_FILES = new Map<string, string>([
  ['src/player/playlist.ts', 'Historical idle guards preserve async decode race behavior.'],
  ['src/player/transport.ts', 'Stop/pause guards preserve old IDLE compatibility semantics.'],
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

  it('keeps full legacy appState projection out of production consumers', () => {
    const actual = listProductionTypeScriptFiles(SRC_ROOT)
      .filter((file) => {
        const content = readFileSync(file, 'utf8');
        return content.includes(LEGACY_APPSTATE_COMPAT_HELPER);
      })
      .map(toRepoPath)
      .filter((file) => file !== 'src/player/ownership.ts')
      .sort();

    const expected = [...ALLOWED_OWNERSHIP_APPSTATE_CONSUMER_FILES.keys()].sort();

    expect(actual).toEqual(expected);

    for (const file of expected) {
      expect(existsSync(join(process.cwd(), file))).toBe(true);
      expect(ALLOWED_OWNERSHIP_APPSTATE_CONSUMER_FILES.get(file)).toBeTruthy();
    }
  });

  it('keeps legacy IDLE compatibility predicate consumers documented', () => {
    const actual = listProductionTypeScriptFiles(SRC_ROOT)
      .filter((file) => {
        const content = readFileSync(file, 'utf8');
        return content.includes(LEGACY_IDLE_COMPAT_HELPER);
      })
      .map(toRepoPath)
      .filter((file) => file !== 'src/player/ownership.ts')
      .sort();

    const expected = [...ALLOWED_LEGACY_IDLE_COMPAT_FILES.keys()].sort();

    expect(actual).toEqual(expected);

    for (const file of expected) {
      expect(existsSync(join(process.cwd(), file))).toBe(true);
      expect(ALLOWED_LEGACY_IDLE_COMPAT_FILES.get(file)).toBeTruthy();
    }
  });
});
