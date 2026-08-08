import { ESLint } from 'eslint';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: 'eslint.tooling.config.js',
});

const EXPECTED_TOOLING_WARNING_IDENTITIES = [
  'cloudflare/account-auth.js|no-unused-vars|normalizeAccountNickname',
  'cloudflare/account-auth.js|no-unused-vars|error',
  'cloudflare/developer-api-facade-worker.js|no-unused-vars|INITIAL_PRO_ROOM_GENERATION',
  'cloudflare/developer-api-worker.js|no-unused-vars|INITIAL_PRO_ROOM_GENERATION',
  'cloudflare/developer-api-worker.js|no-unused-vars|QUEUE_ITEM_ID_RE',
  'cloudflare/pro-room-worker.js|no-unused-vars|DEVELOPER_COMMAND_RETRY_MS',
  'cloudflare/pro-room-worker.js|no-unused-vars|DEVELOPER_COMMAND_DISPATCH_RESERVE_BYTES',
  'cloudflare/pro-room-worker.js|no-unused-vars|DEVELOPER_COMMAND_TERMINAL_RESERVE_BYTES',
  'cloudflare/signaling-worker.js|no-unused-vars|proRoomMediaPrefix',
  'cloudflare/signaling-worker.js|no-unused-vars|defaultProParticipantHighWater',
  'scripts/benchmark-pro-room-heartbeats.mjs|no-unused-vars|WORKER_PATH',
  'e2e/audio-effects.test.ts|@typescript-eslint/no-unused-vars|uploadFixture',
  'e2e/chaos-scenarios.test.ts|@typescript-eslint/no-unused-vars|connectHostAndGuest',
  'e2e/chaos-scenarios.test.ts|@typescript-eslint/no-unused-vars|uploadFixtures',
  'e2e/chat-commands.test.ts|@typescript-eslint/no-unused-vars|getChatInputPlaceholder',
  'e2e/complex-scenarios.test.ts|@typescript-eslint/no-unused-vars|Browser',
  'e2e/complex-scenarios.test.ts|@typescript-eslint/no-unused-vars|Page',
  'e2e/complex-scenarios.test.ts|@typescript-eslint/no-unused-vars|uploadFixtures',
  'e2e/complex-scenarios.test.ts|@typescript-eslint/no-unused-vars|code',
  'e2e/connection.test.ts|@typescript-eslint/no-unused-vars|isVisible',
  'e2e/edge-cases.test.ts|@typescript-eslint/no-unused-vars|stateBefore',
  'e2e/helpers/setup-flow.ts|@typescript-eslint/no-unused-vars|expect',
  'e2e/late-join.test.ts|@typescript-eslint/no-unused-vars|hostRepeat',
  'e2e/playback-advanced.test.ts|@typescript-eslint/no-unused-vars|isVisible',
  'e2e/playlist.test.ts|@typescript-eslint/no-unused-vars|isVisible',
  'e2e/reconnection.test.ts|@typescript-eslint/no-unused-vars|isVisible',
  'e2e/settings.test.ts|@typescript-eslint/no-unused-vars|setupHostAndStart',
  "e2e/youtube-sync.test.ts|directive|Unused eslint-disable directive (no problems were reported from 'no-console').",
] as const;

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

  it('pins the reviewed tooling warning identities instead of only their count', async () => {
    const results = await eslint.lintFiles([
      'cloudflare',
      'scripts',
      'e2e',
      '*.config.{js,mjs,ts}',
      'eslint*.config.js',
    ]);
    const identities = results.flatMap((result) =>
      result.messages
        .filter(({ severity }) => severity === 1)
        .map((message) => {
          const file = relative(process.cwd(), result.filePath).replaceAll('\\', '/');
          const subject = message.message.match(/^'([^']+)'/u)?.[1] ?? message.message;
          return `${file}|${message.ruleId ?? 'directive'}|${subject}`;
        }),
    );

    expect(identities.sort()).toEqual([...EXPECTED_TOOLING_WARNING_IDENTITIES].sort());
  });
});
