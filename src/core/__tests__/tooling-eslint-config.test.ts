import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: 'eslint.tooling.config.js',
});

async function undefinedNames(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath, warnIgnored: false });
  return result.messages
    .filter(({ ruleId }) => ruleId === 'no-undef')
    .map(({ message }) => message.match(/^'([^']+)'/u)?.[1] ?? message);
}

describe('tooling ESLint runtime profiles', () => {
  it('rejects Node-only globals in Cloudflare Workers', async () => {
    await expect(
      undefinedNames('void process.env; void Buffer.from("x");', 'cloudflare/runtime-probe.js'),
    ).resolves.toEqual(['process', 'Buffer']);
  });

  it('rejects generic service-worker globals that Cloudflare does not implement', async () => {
    await expect(
      undefinedNames(
        'void clients; void registration; void skipWaiting; void importScripts;',
        'cloudflare/runtime-probe.js',
      ),
    ).resolves.toEqual(['clients', 'registration', 'skipWaiting', 'importScripts']);
  });

  it('rejects Cloudflare-only globals in Node tooling', async () => {
    await expect(
      undefinedNames('void WebSocketPair; void HTMLRewriter;', 'scripts/runtime-probe.mjs'),
    ).resolves.toEqual(['WebSocketPair', 'HTMLRewriter']);
  });

  it('accepts each runtime own globals', async () => {
    await expect(
      undefinedNames(
        'void WebSocketPair; void HTMLRewriter; void caches;',
        'cloudflare/runtime-probe.js',
      ),
    ).resolves.toEqual([]);
    await expect(
      undefinedNames('void process.env; void Buffer.from("x");', 'scripts/runtime-probe.mjs'),
    ).resolves.toEqual([]);
  });
});
