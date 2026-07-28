import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = readFileSync(new URL('../../app.ts', import.meta.url), 'utf8');

function functionBody(startMarker: string, endMarker: string): string {
  const start = APP_SOURCE.indexOf(startMarker);
  const end = APP_SOURCE.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return APP_SOURCE.slice(start, end);
}

describe('app file-playback product runtime wiring', () => {
  it('initializes the fixed runtime directly before protocol registration', () => {
    const bootstrap = functionBody('async function bootstrap()', '// Run bootstrap');
    const runtimeInit = bootstrap.indexOf(
      'getFilePlaybackProductRuntime().initializeBeforeProtocol();',
    );
    const protocolInit = bootstrap.indexOf("safeInit('Protocol', initProtocol);");

    expect(runtimeInit).toBeGreaterThanOrEqual(0);
    expect(protocolInit).toBeGreaterThan(runtimeInit);
    expect(bootstrap.match(/initializeBeforeProtocol\(\)/gu)).toHaveLength(1);
    expect(bootstrap).not.toContain("safeInit('FilePlaybackApplicationSessions'");
  });

  it('routes background wake through the gate-aware facade', () => {
    const recovery = functionBody(
      'async function recoverLongBackgroundResume',
      'function warnLongBackgroundResume',
    );

    expect(recovery).toContain('getFilePlaybackProductRuntime().handleWake();');
    expect(recovery.indexOf('handleWake();')).toBeLessThan(
      recovery.indexOf('await resumeAudioForBackgroundRecovery();'),
    );
  });

  it('does not directly acquire legacy application-session authority', () => {
    expect(APP_SOURCE).toContain(
      "import { getFilePlaybackProductRuntime } from './player/file-playback-product-runtime.ts';",
    );
    expect(APP_SOURCE).not.toContain('getFilePlaybackApplicationSessionManager');
    expect(APP_SOURCE).not.toContain('handleFilePlaybackApplicationWake');
    expect(APP_SOURCE).not.toContain("from './network/file-playback-application-session.ts'");
  });
});
