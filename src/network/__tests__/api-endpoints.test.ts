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

  it('does not retry the same Worker route twice on the canonical production origin', () => {
    expect(
      localFirstApiEndpoints(
        '/api/cloudflare-realtime',
        'production',
        'https://musixquare.com/room/123456',
      ),
    ).toEqual(['/api/cloudflare-realtime']);
  });

  it('keeps the production fallback on local and staging origins', () => {
    expect(
      localFirstApiEndpoints('/api/cloudflare-realtime', 'production', 'http://127.0.0.1:4173/'),
    ).toEqual(['/api/cloudflare-realtime', 'https://musixquare.com/api/cloudflare-realtime']);
  });
});
