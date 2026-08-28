import { describe, expect, it } from 'vitest';

import {
  assertRoomAuthorityBoundaries,
  loadRoomAuthoritySources,
} from '../../../scripts/check-room-authority-boundaries.mts';

let baselineSources: ReadonlyMap<string, string> | null = null;

function sources(): Map<string, string> {
  baselineSources ??= new Map(loadRoomAuthoritySources(process.cwd()));
  return new Map(baselineSources);
}

describe('room-authority static boundary', { timeout: 30_000 }, () => {
  it('freezes every production legacy access and keeps PRO reads at zero', () => {
    expect(assertRoomAuthorityBoundaries(sources())).toMatchObject({
      directReads: 86,
      stateEvents: 22,
      writes: 16,
      proDirectReads: 0,
      snapshotLegacyReads: 0,
      proSnapshotLegacyReads: 0,
    });
  });

  it('rejects a direct legacy read added to PRO code', () => {
    const current = sources();
    current.set(
      'src/pro-room/legacy-authority-regression.ts',
      "import { getState } from '../core/state.ts';\nexport const trusted = getState('network.appRole') === 'host';\n",
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /PRO direct reads|legacy direct reads/u,
    );
  });

  it('rejects an extra read even in a grandfathered compatibility consumer', () => {
    const current = sources();
    current.set(
      'src/app.ts',
      `${current.get('src/app.ts') ?? ''}\nvoid getState('network.appRole');\n`,
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /src\/app\.ts: legacy direct reads/u,
    );
  });

  it('rejects replacing a grandfathered read with a dangerous read at a new use-site', () => {
    const current = sources();
    const appSource = current.get('src/app.ts') ?? '';
    const grandfatheredRead = "getState('network.appRole')";
    expect(appSource).toContain(grandfatheredRead);
    current.set(
      'src/app.ts',
      appSource.replace(grandfatheredRead, "('idle' as const)") +
        '\nexport const unsafeProAuthorityRegression = () =>\n' +
        "  getState('room.context').kind === 'pro' &&\n" +
        "  getState('network.appRole') === 'host';\n",
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /src\/app\.ts: legacy authority callsite fingerprints changed/u,
    );
  });

  it('pins same-function consumers of a grandfathered getState result', () => {
    const current = sources();
    const appSource = current.get('src/app.ts') ?? '';
    const existing =
      "    const role = getState('network.appRole');\n" +
      "    if (role === 'host' || role === 'guest') load();";
    expect(appSource).toContain(existing);
    current.set(
      'src/app.ts',
      appSource.replace(
        existing,
        "    const role = getState('network.appRole');\n" +
          "    if (getState('room.context').kind === 'pro' && role === 'host') load();",
      ),
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /src\/app\.ts: legacy authority callsite fingerprints changed/u,
    );
  });

  it('rejects direct full-state snapshot authority reads in PRO code', () => {
    const current = sources();
    current.set(
      'src/pro-room/snapshot-authority-regression.ts',
      "import { snapshot as stateSnapshot } from '../core/state.ts';\n" +
        "export const trusted = stateSnapshot().network.appRole === 'host';\n",
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /full-state snapshot reads legacy network\.appRole|PRO.*snapshot authority read/u,
    );
  });

  it('rejects snapshot callable, root, network, and destructuring aliases', () => {
    const current = sources();
    current.set(
      'src/pro-room/snapshot-alias-regression.ts',
      "import * as state from '../core/state.ts';\n" +
        'const takeSnapshot = state.snapshot;\n' +
        'const full = takeSnapshot();\n' +
        'const aliased = full;\n' +
        'const { network: legacyNetwork } = aliased;\n' +
        'const { isOperator: trusted } = legacyNetwork;\n' +
        'export { trusted };\n',
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /full-state snapshot reads legacy network\.isOperator|PRO.*snapshot authority read/u,
    );
  });

  it('rejects computed-key and state-event indirection', () => {
    const current = sources();
    current.set(
      'src/legacy-authority-indirection.ts',
      "const key = 'network.isOperator';\nconst event = 'state:network.appRole';\nvoid key;\nvoid event;\n",
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /unsupported indirect legacy authority key/u,
    );
  });

  it('rejects an unreviewed compatibility projection writer', () => {
    const current = sources();
    current.set(
      'src/pro-room/legacy-authority-writer.ts',
      "import { setState } from '../core/state.ts';\nsetState('network.isOperator', true);\n",
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(/legacy writes/u);
  });

  it('keeps the PRO branch ahead of every legacy fallback in the canonical adapter', () => {
    const current = sources();
    const authority = current.get('src/rooms/authority.ts') ?? '';
    current.set(
      'src/rooms/authority.ts',
      authority.replace(
        "  if (context.kind === 'pro') return context.role === 'coordinator';\n  return getState('network.appRole') === 'host' && !getState('network.hostConn');",
        "  const legacyCoordinator =\n    getState('network.appRole') === 'host' && !getState('network.hostConn');\n  if (context.kind === 'pro') return context.role === 'coordinator';\n  return legacyCoordinator;",
      ),
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /isCoordinator\(\).*before reading legacy standard-room state/u,
    );
  });

  it('resolves a local getState alias when enforcing the canonical PRO-first branch', () => {
    const current = sources();
    const authority = current.get('src/rooms/authority.ts') ?? '';
    current.set(
      'src/rooms/authority.ts',
      authority.replace(
        "  if (context.kind === 'pro') return context.role === 'coordinator';\n  return getState('network.appRole') === 'host' && !getState('network.hostConn');",
        '  const read = getState;\n' +
          '  const legacyCoordinator =\n' +
          "    read('network.appRole') === 'host' && !read('network.hostConn');\n" +
          "  if (context.kind === 'pro') return context.role === 'coordinator';\n" +
          '  return legacyCoordinator;',
      ),
    );

    expect(() => assertRoomAuthorityBoundaries(current)).toThrow(
      /isCoordinator\(\).*before reading legacy standard-room state/u,
    );
  });
});
