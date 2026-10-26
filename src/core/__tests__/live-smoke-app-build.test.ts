import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  APP_BUILD_HEADER,
  APP_UPDATE_REQUIRED_CODE,
  APP_UPDATE_REQUIRED_ERROR_TYPE,
} from '../../../cloudflare/app-build-floor-contract.ts';
import {
  appBuildRequestHeaders,
  classifyHostAdmission,
  readServiceWorkerAppBuild,
  requireLegacyShapeHostOutcome,
  resolveLiveSmokeAppBuild,
  withAppBuild,
} from '../../../scripts/live-smoke-app-build.mts';
import {
  parseServiceWorkerCacheEpoch,
  readReleaseIdentity,
} from '../../../scripts/release-identity.mts';

const REFUSAL = Object.freeze({
  type: 'error',
  errorType: APP_UPDATE_REQUIRED_ERROR_TYPE,
  message: APP_UPDATE_REQUIRED_CODE,
  minAppBuild: 786,
});
const INVALID_FIRST_FRAME = Object.freeze({
  type: 'error',
  errorType: 'invalid-id',
  message: 'HOST_AUTH_FIRST_FRAME_INVALID',
});

describe('live smoke App build', () => {
  it('reports the checked-out release build', () => {
    const { serviceWorkerCacheEpoch } = readReleaseIdentity();
    expect(resolveLiveSmokeAppBuild()).toEqual({ build: serviceWorkerCacheEpoch });
    expect(resolveLiveSmokeAppBuild({ readBuild: () => 785 })).toEqual({ build: 785 });
    expect(() => resolveLiveSmokeAppBuild({ readBuild: () => 0 })).toThrow('positive App build');
  });

  it('puts the build on PRO requests through the shared header name', () => {
    expect(appBuildRequestHeaders(785)).toEqual({ [APP_BUILD_HEADER]: '785' });
  });

  it('adds appBuild to an auth frame', () => {
    const frame = { type: 'guest-auth', password: '', reconnectSecret: 'secret' };
    expect(withAppBuild(frame, 785)).toEqual({ ...frame, appBuild: 785 });
    expect(frame).not.toHaveProperty('appBuild');
  });

  it('classifies admission, the exact floor refusal and an invalid first frame', () => {
    expect(classifyHostAdmission({ type: 'peer-open', roomId: '123456' })).toEqual({
      outcome: 'admitted',
      frame: { type: 'peer-open', roomId: '123456' },
    });
    expect(classifyHostAdmission({ ...REFUSAL })).toEqual({
      outcome: 'below-floor',
      minAppBuild: 786,
    });
    // The Signaling Worker refuses a host-auth it cannot parse; the smoke's
    // frame is then wrong, never a sign of an older Worker.
    expect(classifyHostAdmission({ ...INVALID_FIRST_FRAME })).toEqual({ outcome: 'invalid-frame' });
    for (const frame of [
      { ...REFUSAL, minAppBuild: 0 },
      { ...REFUSAL, minAppBuild: '786' },
      { ...REFUSAL, minAppBuild: 786.5 },
      { ...REFUSAL, extra: true },
      { type: 'error', errorType: APP_UPDATE_REQUIRED_ERROR_TYPE, message: 'OTHER' },
      { type: 'error', errorType: 'room-password-invalid', message: 'ROOM_PASSWORD_INVALID' },
    ]) {
      expect(classifyHostAdmission(frame).outcome).toBe('refused');
    }
  });

  it('accepts either admission or the exact refusal for the legacy host shape', () => {
    expect(requireLegacyShapeHostOutcome({ type: 'peer-open' }, 'legacy host')).toEqual({
      admitted: { type: 'peer-open' },
    });
    expect(requireLegacyShapeHostOutcome({ ...REFUSAL }, 'legacy host')).toEqual({
      minAppBuild: 786,
    });
    expect(() => requireLegacyShapeHostOutcome({ ...INVALID_FIRST_FRAME }, 'legacy host')).toThrow(
      'legacy host: host-auth refused as an invalid first frame (HOST_AUTH_FIRST_FRAME_INVALID)',
    );
    expect(() =>
      requireLegacyShapeHostOutcome({ ...REFUSAL, minAppBuild: -1 }, 'legacy host'),
    ).toThrow('legacy host');
  });

  it('reads the live App build from the one canonical service-worker line', async () => {
    const fetcher = vi.fn(
      async () => new Response("self.x=1;\nconst CACHE_VERSION = 'v785';\n", { status: 200 }),
    );
    await expect(readServiceWorkerAppBuild(fetcher)).resolves.toBe(785);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://musixquare.com/service-worker.js');
    expect(init.cache).toBe('no-store');

    for (const body of [
      "const CACHE_VERSION = 'v785';\nconst CACHE_VERSION = 'v786';",
      "const CACHE_VERSION = 'latest';",
      '<!doctype html>',
    ]) {
      await expect(
        readServiceWorkerAppBuild(async () => new Response(body, { status: 200 })),
      ).resolves.toBeNull();
    }
    await expect(
      readServiceWorkerAppBuild(async () => new Response('', { status: 404 })),
    ).resolves.toBeNull();
    await expect(
      readServiceWorkerAppBuild(async () => {
        throw new TypeError('fetch failed');
      }),
    ).resolves.toBeNull();
  });

  it('shares the release identity parser for the cache epoch instead of retyping it', () => {
    expect(parseServiceWorkerCacheEpoch("const CACHE_VERSION = 'v785';")).toBe(785);
    expect(parseServiceWorkerCacheEpoch("export const SERVICE_WORKER_CACHE_VERSION = 'v9';")).toBe(
      9,
    );
    expect(() => parseServiceWorkerCacheEpoch("const CACHE_VERSION = 'v0';")).toThrow();
    expect(() =>
      parseServiceWorkerCacheEpoch("const CACHE_VERSION = 'v1';\nconst CACHE_VERSION = 'v2';"),
    ).toThrow('exactly one');
  });
});

/**
 * Every Signaling auth frame a live smoke sends carries the candidate build
 * through withAppBuild, so a release after the floor is turned on never
 * refuses its own smoke and rolls itself back. The legacy-shape attempt is the
 * one deliberate exception: it proves what a pre-floor client meets.
 */
describe('live smoke auth frames', () => {
  const SMOKES = [
    'scripts/live-signaling-smoke.mts',
    'scripts/live-remote-share-smoke.ts',
    'scripts/live-standard-http-signaling-smoke.mts',
  ];
  const LEGACY_SHAPE_FUNCTIONS = new Set(['runLegacyCompatibilityAttempt']);

  function authFrameLiterals(path: string) {
    const source = readFileSync(path, 'utf8');
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const found: Array<{
      type: string;
      wrapped: boolean;
      legacyShape: boolean;
      keys: string[];
      text: string;
    }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const typeProperty = node.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(file) === 'type' &&
            ts.isStringLiteral(property.initializer),
        );
        const type = typeProperty ? (typeProperty.initializer as ts.StringLiteral).text : '';
        if (type === 'host-auth' || type === 'guest-auth') {
          const parent = node.parent;
          const wrapped =
            ts.isCallExpression(parent) &&
            parent.expression.getText(file) === 'withAppBuild' &&
            parent.arguments[0] === node;
          let legacyShape = false;
          for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
            if (
              ts.isFunctionDeclaration(cursor) &&
              cursor.name &&
              LEGACY_SHAPE_FUNCTIONS.has(cursor.name.text)
            ) {
              legacyShape = true;
            }
          }
          const keys = node.properties.flatMap((property) =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
            property.name
              ? [property.name.getText(file)]
              : [],
          );
          found.push({ type, wrapped, legacyShape, keys, text: node.getText(file) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  }

  it.each(SMOKES)('%s sends every auth frame through withAppBuild', (path) => {
    const frames = authFrameLiterals(path);
    expect(frames.some((frame) => frame.type === 'host-auth')).toBe(true);
    for (const frame of frames) {
      if (frame.legacyShape) {
        expect(frame.wrapped, frame.text).toBe(false);
      } else {
        expect(frame.wrapped, frame.text).toBe(true);
      }
    }
  });

  it('keeps exactly one legacy-shape host in the Signaling smoke', () => {
    const legacy = authFrameLiterals('scripts/live-signaling-smoke.mts').filter(
      (frame) => frame.legacyShape,
    );
    expect(legacy.filter((frame) => frame.type === 'host-auth')).toHaveLength(1);
  });

  // The Signaling Worker requires the desired PIN and its mutation ID on every
  // host-auth (old-version removal W-3). A smoke or the floor probe without
  // them would be refused as an invalid first frame and roll the release back
  // or fail the floor proof. The legacy-shape host carries them too: it stands
  // for an App without appBuild, and every App since 8.4.17 sends both.
  it.each([...SMOKES, 'scripts/app-build-floor.mts'])(
    '%s sends the PIN fields on every host-auth',
    (path) => {
      const hostAuth = authFrameLiterals(path).filter((frame) => frame.type === 'host-auth');
      expect(hostAuth.length).toBeGreaterThan(0);
      for (const frame of hostAuth) {
        expect(frame.keys, frame.text).toEqual(
          expect.arrayContaining(['desiredRoomPassword', 'pinMutationId']),
        );
      }
    },
  );
});
