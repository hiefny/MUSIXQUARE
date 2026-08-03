import { describe, expect, it } from 'vitest';
import { localFirstApiEndpoints } from '../api-endpoints.ts';

describe('local-first API endpoints', () => {
  it('fails closed to the local origin in E2E builds', () => {
    expect(localFirstApiEndpoints('/api/get-turn-config', 'e2e')).toEqual(['/api/get-turn-config']);
  });

  it('retains the canonical production fallback outside E2E builds', () => {
    expect(localFirstApiEndpoints('/api/get-turn-config', 'production')).toEqual([
      '/api/get-turn-config',
      'https://musixquare.com/api/get-turn-config',
    ]);
  });
});
