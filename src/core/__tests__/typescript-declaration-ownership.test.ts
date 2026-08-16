import { describe, expect, it } from 'vitest';

import {
  DECLARATION_ALLOWLIST,
  auditDeclarationOwnership,
  nativeOwnerCandidates,
  repositoryDeclarationPaths,
  runDeclarationOwnershipCheck,
} from '../../../scripts/check-typescript-declaration-ownership.mts';

describe('TypeScript declaration ownership guard', () => {
  it('maps declarations to every possible native TypeScript owner', () => {
    expect(nativeOwnerCandidates('module.d.ts')).toEqual(['module.ts', 'module.tsx']);
    expect(nativeOwnerCandidates('module.d.mts')).toEqual(['module.mts']);
    expect(nativeOwnerCandidates('module.d.cts')).toEqual(['module.cts']);
  });

  it('rejects unreviewed declarations and redundant native companions', () => {
    expect(
      auditDeclarationOwnership({
        declarations: ['external.d.ts', 'native.d.mts'],
        allowlist: { 'external.d.ts': 'external package' },
        sourceExists: (path) => path === 'native.mts',
      }),
    ).toEqual(['native.d.mts: redundant declaration shadows native source native.mts']);

    expect(
      auditDeclarationOwnership({
        declarations: ['unreviewed.d.ts'],
        allowlist: {},
        sourceExists: () => false,
      }),
    ).toEqual(['unreviewed.d.ts: declaration has no reviewed external/generated owner']);
  });

  it('fails closed when a reviewed declaration disappears or lacks a reason', () => {
    expect(
      auditDeclarationOwnership({
        declarations: ['empty.d.ts'],
        allowlist: { 'empty.d.ts': '', 'missing.d.ts': 'generated' },
        sourceExists: () => false,
      }),
    ).toEqual([
      'empty.d.ts: reviewed declaration reason is empty',
      'missing.d.ts: reviewed declaration is missing',
    ]);
  });

  it('keeps the repository declaration inventory exact and owned', () => {
    expect(repositoryDeclarationPaths()).toEqual(Object.keys(DECLARATION_ALLOWLIST).sort());
    expect(runDeclarationOwnershipCheck()).toEqual([]);
  });
});
