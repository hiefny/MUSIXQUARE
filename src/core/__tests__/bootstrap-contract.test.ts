import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_REQUIRED_STEPS } from '../bootstrap-contract.ts';

const BOOTSTRAP_RECORD_PATTERN =
  /(?:safeInit\(\s*|runBootstrapStepAsync\(\s*bootstrapReadiness,\s*|bootstrapReadiness\.recordSuccess\(\s*)'([^']+)'/gu;

function readRecordedBootstrapSteps(): string[] {
  const source = readFileSync(new URL('../../app.ts', import.meta.url), 'utf8');
  return Array.from(source.matchAll(BOOTSTRAP_RECORD_PATTERN), (match) => match[1]);
}

describe('eager bootstrap contract', () => {
  it('matches every app initializer in source order without duplicate names', () => {
    const recorded = readRecordedBootstrapSteps();

    expect(new Set(recorded).size).toBe(recorded.length);
    expect(recorded).toEqual([...BOOTSTRAP_REQUIRED_STEPS]);
  });
});
