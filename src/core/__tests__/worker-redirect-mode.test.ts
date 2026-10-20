import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Workers runtime throws "Invalid redirect value" for redirect: 'error'
// (only 'follow' and 'manual' exist at the edge), so a Worker fetch or Request
// that asks for it fails before any network I/O. Browser and Node code may
// still use it.
describe('Worker fetch redirect mode', () => {
  it('never asks the Workers runtime for the unsupported error redirect mode', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(resolve('cloudflare'), { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || /(?:^|[\/])__tests__[\/]/u.test(file)) continue;
      const source = readFileSync(resolve(join('cloudflare', file)), 'utf8');
      if (/\bredirect\s*:\s*['"]error['"]/u.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
