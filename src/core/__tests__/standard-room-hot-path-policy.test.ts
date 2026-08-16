import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertStandardRoomHotPath,
  loadStandardRoomHotPathSources,
  type StandardRoomHotPathSources,
} from '../../../scripts/check-standard-room-hot-path.mts';

function replaceOrThrow(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) throw new Error(`Fixture anchor is missing: ${search}`);
  return source.replace(search, replacement);
}

async function sources(): Promise<StandardRoomHotPathSources> {
  return loadStandardRoomHotPathSources(process.cwd());
}

describe('standard-room security/performance policy', () => {
  it('keeps unbenchmarked adaptive proof of work disabled in production', () => {
    const productionConfig = readFileSync('cloudflare/wrangler.app.toml', 'utf8');

    expect(productionConfig).toMatch(/^MXQR_CAPABILITY_POW_ADAPTIVE_ENABLED = "false"\r?$/mu);
    expect(productionConfig).not.toMatch(/^MXQR_CAPABILITY_POW_ADAPTIVE_ENABLED = "true"\r?$/mu);
    expect(productionConfig).toMatch(/^MXQR_CAPABILITY_POW_ADAPTIVE_MAX_DIFFICULTY = "16"\r?$/mu);
  });

  it('keeps one composite TURN admission, same-tier WebSocket admission, and parallel startup', async () => {
    await expect(sources().then(assertStandardRoomHotPath)).resolves.toEqual({
      capabilityPowDifficulty: 12,
      turnAtomicConsumes: 1,
      standardWebSocketServiceControlConsumes: 0,
      signalingStartsBeforeTurn: true,
      inviteReturnsBeforeTurn: true,
      rtcConfigurationFence: true,
    });
  });

  it('rejects restoring a more expensive default proof-of-work challenge without evidence', async () => {
    const current = await sources();
    const expensive = replaceOrThrow(
      current.appWorker,
      'const CAPABILITY_POW_DIFFICULTY_DEFAULT = 12;',
      'const CAPABILITY_POW_DIFFICULTY_DEFAULT = 16;',
    );

    expect(() => assertStandardRoomHotPath({ ...current, appWorker: expensive })).toThrow(
      /proof-of-work difficulty must remain 12/u,
    );
  });

  it('rejects a scalar atomic decision before the composite TURN branch', async () => {
    const current = await sources();
    const stacked = replaceOrThrow(
      current.appWorker,
      '  if (options.combinePerCapabilityRateLimit === true && perCapabilityLimit !== null) {',
      '  await checkPaidRateLimit(request, env, rateLimitKey, authenticatedRateLimit, 60);\n' +
        '  if (options.combinePerCapabilityRateLimit === true && perCapabilityLimit !== null) {',
    );

    expect(() => assertStandardRoomHotPath({ ...current, appWorker: stacked })).toThrow(
      /before its composite branch/u,
    );
  });

  it('rejects a second synchronous atomic consume on the standard TURN path', async () => {
    const current = await sources();
    const duplicated = replaceOrThrow(
      current.appWorker,
      'return consumeAbuseRateLimitPair(env, {',
      'await consumeAbuseRateLimitPair(env, {\n' +
        "    scope: 'duplicate-turn-decision',\n" +
        '    identity: digest,\n' +
        '    limit,\n' +
        '    windowMs: windowSec * 1_000,\n' +
        '    secondary: null,\n' +
        '  });\n' +
        '  return consumeAbuseRateLimitPair(env, {',
    );

    expect(() => assertStandardRoomHotPath({ ...current, appWorker: duplicated })).toThrow(
      /exactly one atomic pair consume/u,
    );
  });

  it('rejects waiting for TURN before the host signaling claim starts', async () => {
    const current = await sources();
    const serialized = replaceOrThrow(
      current.peer,
      '      const newPeer = await createTransportPeer(requestedId, peerOpts);',
      '      await turnCredentialsRequest;\n' +
        '      const newPeer = await createTransportPeer(requestedId, peerOpts);',
    );

    expect(() => assertStandardRoomHotPath({ ...current, peer: serialized })).toThrow(
      /signaling must start before awaiting TURN/u,
    );
  });

  it('rejects restoring a control-plane readiness preflight ahead of room signaling', async () => {
    const current = await sources();
    const gatedHost = replaceOrThrow(
      current.setupHost,
      '    const code = await createHostSessionWithShortCode();',
      '    await waitForStandardRoomReadiness();\n' +
        '    const code = await createHostSessionWithShortCode();',
    );

    expect(() => assertStandardRoomHotPath({ ...current, setupHost: gatedHost })).toThrow(
      /host setup must start signaling without a control-plane readiness preflight/u,
    );
  });

  it('rejects the former peer-open plus TURN Promise.all before invite return', async () => {
    const current = await sources();
    const serialized = replaceOrThrow(
      current.peer,
      '      const id = await peerOpenRequest;',
      '      const rtcConfigurationRequest = turnCredentialsRequest;\n' +
        '      const [id] = await Promise.all([peerOpenRequest, rtcConfigurationRequest]);',
    );

    expect(() => assertStandardRoomHotPath({ ...current, peer: serialized })).toThrow(
      /invite id must come from the peer-open promise alone|invite code must return.*without awaiting TURN/u,
    );
  });

  it('rejects a wrapped TURN wait inserted between peer-open and invite return', async () => {
    const current = await sources();
    const serialized = replaceOrThrow(
      current.peer,
      '      const id = await peerOpenRequest;',
      '      const waitForInvitePrerequisites = () => turnCredentialsRequest;\n' +
        '      const id = await peerOpenRequest;\n' +
        '      await waitForInvitePrerequisites();',
    );

    expect(() => assertStandardRoomHotPath({ ...current, peer: serialized })).toThrow(
      /invite code must return.*without awaiting TURN/u,
    );
  });

  it('rejects restoring the PRO service-control dependency to standard WebSocket admission', async () => {
    const current = await sources();
    const crossTier = replaceOrThrow(
      current.signalingWorker,
      'const binding = env?.MUSIXQUARE_ROOMS;',
      'const binding = env?.MUSIXQUARE_SERVICE_CONTROL;',
    );

    expect(() => assertStandardRoomHotPath({ ...current, signalingWorker: crossTier })).toThrow(
      /standard WebSocket admission/u,
    );
  });

  it('rejects a direct Service-Control consume inserted in the standard WebSocket branch', async () => {
    const current = await sources();
    const stacked = replaceOrThrow(
      current.signalingWorker,
      '    const rate = await checkStandardWsRateLimit(request, env);',
      '    await consumeAbuseRateLimit(env, {\n' +
        "      scope: 'signaling-standard-regression',\n" +
        "      identity: 'standard-regression',\n" +
        '      limit: 120,\n' +
        '      windowMs: 60_000,\n' +
        '    });\n' +
        '    const rate = await checkStandardWsRateLimit(request, env);',
    );

    expect(() => assertStandardRoomHotPath({ ...current, signalingWorker: stacked })).toThrow(
      /standard WebSocket path must not reach Service-Control outside maintenance/u,
    );
  });
});
