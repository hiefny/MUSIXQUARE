import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function runGuard(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/check-source-complexity.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('source complexity ratchet', () => {
  it('keeps every named hotspot and release inline block below its extraction threshold', () => {
    const result = runGuard();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('cloudflare/pro-room-worker.js');
    expect(result.stdout).toContain('largest inline run block');
  });

  it('fails with an extraction instruction when a source exceeds its ratchet', () => {
    const result = runGuard('--budget=.github/workflows/release.yml:1:1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source complexity ratchet failed');
    expect(result.stderr).toContain('Extract a cohesive module or release helper');
  });

  it('is mandatory in checked builds and main CI', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(manifest.scripts['guard:source-complexity']).toContain('check-source-complexity.mjs');
    expect(manifest.scripts['build:checked']).toContain('guard:source-complexity');
    expect(workflow).toContain('npm run guard:source-complexity');
  });
});
