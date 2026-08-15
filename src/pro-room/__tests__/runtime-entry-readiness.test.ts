import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeSource = readFileSync(new URL('../runtime.ts', import.meta.url), 'utf8');

function entryBody(name: string, controllerMethod: string): string {
  const start = runtimeSource.indexOf(`export async function ${name}(`);
  const call = runtimeSource.indexOf(`controller.${controllerMethod}(`, start);
  if (start < 0 || call < 0) throw new Error(`Missing PRO runtime entry ${name}.`);
  return runtimeSource.slice(start, call);
}

describe('PRO room deferred listener readiness', () => {
  it.each([
    ['resumeProRoom', 'resume', 'options.signal'],
    ['joinProRoom', 'join', 'signal'],
    ['activateProRoom', 'activate', 'signal'],
    ['recoverProRoomOwner', 'recoverOwner', 'signal'],
    ['transferProRoomOwner', 'transferOwner', 'signal'],
  ])(
    'gates %s with its caller signal before its session controller can open transport',
    (entry, controllerMethod, signal) => {
      expect(entryBody(entry, controllerMethod)).toContain(
        `await prepareRoomSessionFeatures(${signal});`,
      );
    },
  );
});
