import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageLockEntry {
  version?: string;
  license?: string;
}

const packageJson = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };
const packageLock = JSON.parse(
  readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'),
) as { packages: Record<string, PackageLockEntry> };
const notices = readFileSync(new URL('../../../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');

describe('streaming engine dependency policy', () => {
  it('pins the intentional streaming runtime dependencies exactly', () => {
    expect(packageJson.dependencies['@wasm-audio-decoders/flac']).toBe('0.2.10');
    expect(packageJson.dependencies['codec-parser']).toBe('2.5.0');
    expect(packageJson.dependencies['lanczos-resampler']).toBe('0.4.1');
  });

  it.each([
    ['@wasm-audio-decoders/flac', '0.2.10', 'MIT'],
    ['@wasm-audio-decoders/common', '9.0.7', 'MIT'],
    ['codec-parser', '2.5.0', 'LGPL-3.0-or-later'],
    ['@eshaz/web-worker', '1.2.2', 'Apache-2.0'],
    ['simple-yenc', '1.0.4', 'MIT'],
    ['lanczos-resampler', '0.4.1', 'MIT'],
  ])('locks and records %s@%s under %s', (name, version, license) => {
    const entry = packageLock.packages[`node_modules/${name}`];

    expect(entry).toMatchObject({ version, license });
    expect(notices).toContain(`${name} ${version}`);
  });

  it('retains the embedded libFLAC and puff attributions', () => {
    expect(notices).toContain('Copyright (C) 2000-2009 Josh Coalson');
    expect(notices).toContain('Copyright (C) 2011-2025');
    expect(notices).toContain('Copyright (C) 2002-2013 Mark Adler');
  });
});
