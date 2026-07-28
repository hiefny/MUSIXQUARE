import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageLockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  license?: string;
  dependencies?: Record<string, string>;
}

const packageJson = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };
const packageLock = JSON.parse(
  readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'),
) as { packages: Record<string, PackageLockEntry> };
const notices = readFileSync(new URL('../../../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');
const mpg123Lgpl = readFileSync(
  new URL('../../../public/licenses/mpg123-lgpl-2.1.txt', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

describe('streaming engine dependency policy', () => {
  it('pins the intentional streaming runtime dependencies exactly', () => {
    expect(packageJson.dependencies['@wasm-audio-decoders/flac']).toBe('0.2.10');
    expect(packageJson.dependencies['codec-parser']).toBe('2.5.0');
    expect(packageJson.dependencies['lanczos-resampler']).toBe('0.4.1');
    expect(packageJson.dependencies['mpg123-decoder']).toBe('1.0.3');
  });

  it.each([
    ['@wasm-audio-decoders/flac', '0.2.10', 'MIT'],
    ['@wasm-audio-decoders/common', '9.0.7', 'MIT'],
    ['codec-parser', '2.5.0', 'LGPL-3.0-or-later'],
    ['@eshaz/web-worker', '1.2.2', 'Apache-2.0'],
    ['simple-yenc', '1.0.4', 'MIT'],
    ['lanczos-resampler', '0.4.1', 'MIT'],
    ['mpg123-decoder', '1.0.3', 'MIT'],
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

  it('locks the audited mpg123 decoder artifact and records its embedded LGPL code', () => {
    expect(packageLock.packages['node_modules/mpg123-decoder']).toMatchObject({
      version: '1.0.3',
      resolved: 'https://registry.npmjs.org/mpg123-decoder/-/mpg123-decoder-1.0.3.tgz',
      integrity:
        'sha512-+fjxnWigodWJm3+4pndi+KUg9TBojgn31DPk85zEsim7C6s0X5Ztc/hQYdytXkwuGXH+aB0/aEkG40Emukv6oQ==',
      license: 'MIT',
      dependencies: {
        '@wasm-audio-decoders/common': '9.0.7',
      },
    });

    expect(notices).toContain('mpg123 1.29.0');
    expect(notices).toContain('8f2428c1cd96b54dab74836c8471ff75fe35cbee');
    expect(notices).toContain('08247b317163175e62035893af3ff9e71a5dfefd');
    expect(notices).toContain('LGPL-2.1-only');
    expect(notices).toContain('public/licenses/mpg123-lgpl-2.1.txt');
    expect(mpg123Lgpl).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(mpg123Lgpl).toContain('Version 2.1, February 1999');
    expect(createHash('sha256').update(mpg123Lgpl).digest('hex')).toBe(
      '730aca838484e53c7c4838873de0cf2f77fc08f27b18f3f20ab775a52687042a',
    );
  });
});
