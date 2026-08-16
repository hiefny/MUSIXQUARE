import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function runGuard(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/check-source-complexity.mts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('source complexity safety limit', () => {
  it('keeps every named hotspot and release inline block below its accident threshold', () => {
    const result = runGuard();
    expect(result.status, result.stderr).toBe(0);
    const expectedBudgets: ReadonlyArray<{
      path: string;
      maxLines: number;
      maxRunLines?: number;
    }> = [
      { path: 'cloudflare/pro-room-worker.ts', maxLines: 20_000 },
      { path: 'cloudflare/service-control-object.ts', maxLines: 2_000 },
      { path: 'cloudflare/pro-room-body.ts', maxLines: 500 },
      { path: 'cloudflare/app-worker.ts', maxLines: 20_000 },
      { path: 'cloudflare/signaling-worker.ts', maxLines: 10_000 },
      { path: 'cloudflare/signaling-protocol.ts', maxLines: 1_000 },
      { path: 'src/pro-room/runtime.ts', maxLines: 10_000 },
      { path: 'browser/classic-runtime/admin.ts', maxLines: 10_000 },
      { path: '.github/workflows/release.yml', maxLines: 2_000, maxRunLines: 200 },
      { path: '.github/workflows/release-recovery.yml', maxLines: 1_000, maxRunLines: 200 },
    ];

    for (const { path, maxLines, maxRunLines } of expectedBudgets) {
      const sourceMarker = path + ': ';
      const sourceSummary = result.stdout.slice(result.stdout.indexOf(sourceMarker));
      expect(sourceSummary.startsWith(sourceMarker)).toBe(true);
      expect(/^.+?: \d+\/(\d+) lines/u.exec(sourceSummary)?.[1]).toBe(String(maxLines));

      if (maxRunLines === undefined) continue;
      const runMarker = path + ': largest inline run block ';
      const runSummary = result.stdout.slice(result.stdout.indexOf(runMarker));
      expect(runSummary.startsWith(runMarker)).toBe(true);
      expect(/^.+?: largest inline run block \d+\/(\d+) lines/u.exec(runSummary)?.[1]).toBe(
        String(maxRunLines),
      );
    }
  });

  it('fails with an ownership review instruction when a source exceeds its safety limit', () => {
    const result = runGuard('--budget=.github/workflows/release.yml:1:1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source complexity safety limit failed');
    expect(result.stderr).toContain('Keep tightly coupled state and lifecycle co-located');
  });

  it('is mandatory in checked builds and main CI', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(manifest.scripts['guard:source-complexity']).toContain('check-source-complexity.mts');
    expect(manifest.scripts['build:checked']).toContain('guard:source-complexity');
    expect(workflow).toContain('npm run guard:source-complexity');
  });
});
