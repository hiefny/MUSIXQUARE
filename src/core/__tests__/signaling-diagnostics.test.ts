import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  observeSignalingFailure,
  reportSignalingFailure,
} from '../../../cloudflare/signaling-diagnostics.ts';

const VERSION_ID = '440b001f-acde-4321-9876-abcdefabcdef';
const context = {
  objectKind: 'room',
  operation: 'webSocketClose',
  disposition: 'propagated',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signaling error-only diagnostics', () => {
  it('keeps static categories and boolean provider flags without exception or request data', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('private-token room=123456 peer=private-peer'), {
      name: 'private-error-name',
      retryable: true,
      overloaded: 'true',
      remote: true,
      cause: new Error('private-cause'),
      request: { url: 'https://private.example/?token=secret', headers: { Cookie: 'private' } },
    });
    error.stack = 'private-stack';

    reportSignalingFailure(
      { CF_VERSION_METADATA: { id: VERSION_ID, tag: 'private-tag' } },
      context,
      error,
    );

    expect(log).toHaveBeenCalledExactlyOnceWith('[SignalingDiagnostic]', {
      schema: 1,
      ...context,
      versionId: VERSION_ID,
      errorType: 'unknown',
      errorCode: 'unknown',
      retryable: true,
      overloaded: false,
      remote: true,
      locations: [],
      related: [],
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|123456/);
  });

  it('only recognizes exact allowlisted error codes and version UUIDs', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportSignalingFailure({}, context, new TypeError('INVALID_PRO_ROOM_META'));
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      errorType: 'TypeError',
      errorCode: 'INVALID_PRO_ROOM_META',
      versionId: 'unknown',
    });
    reportSignalingFailure(
      { CF_VERSION_METADATA: { id: `${VERSION_ID}?token=secret` } },
      context,
      new Error('INVALID_PRO_ROOM_META: room=123456'),
    );
    expect(log.mock.calls[1]?.[1]).toMatchObject({ errorCode: 'unknown', versionId: 'unknown' });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|room=|\?token/);
  });

  it('keeps only bounded known-module coordinates and excludes raw stack text', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('secret-message');
    error.stack = [
      'Error: secret-message',
      '    at privateFunction (signaling-worker.js:12:34)',
      '    at signaling-worker.js:12:34',
      '    at privateFunction (https://private.example/signaling-worker.js:23:45)',
      '    at privateFunction (C:/private/signaling-worker.ts:23:45)',
      '    at secret-file.js:23:45',
      '    at signaling-diagnostics.ts:1:2',
      '    at service-maintenance.ts:3:4',
      '    at pro-room-generation.ts:5:6',
      '    at standard-room-account-assertion.ts:7:8',
      '    at remote-share-upload-assertion.ts:9:10',
    ].join('\n');

    reportSignalingFailure({}, context, error);

    expect(log.mock.calls[0]?.[1].locations).toEqual([
      'signaling-worker.js:12:34',
      'signaling-diagnostics.ts:1:2',
      'service-maintenance.ts:3:4',
      'pro-room-generation.ts:5:6',
      'standard-room-account-assertion.ts:7:8',
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|private|https:|C:\//);
  });

  it('bounds aggregate detail and does not recursively expose causes or nested error values', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new AggregateError(
      [
        Object.assign(new Error('private-storage-message'), { retryable: true }),
        new AggregateError([new Error('private-nested')], 'private-aggregate'),
        new Error('private-third'),
      ],
      'private-parent',
    );

    reportSignalingFailure({}, context, error);

    const record = log.mock.calls[0]?.[1];
    expect(record).toMatchObject({ errorType: 'AggregateError', errorCode: 'unknown' });
    expect(record.related).toHaveLength(2);
    expect(record.related[0]).toMatchObject({ errorType: 'Error', retryable: true });
    expect(record.related[1]).toMatchObject({ errorType: 'AggregateError' });
    expect(record.related[1]).not.toHaveProperty('related');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  });

  it('does not invoke array methods or species on hostile aggregate members', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const methodAccess = vi.fn();
    const errors = new Proxy([new Error('private-child')], {
      get(target, key, receiver) {
        if (key === 'length') return 500_000;
        if (key === '1') throw new Error('private-index-getter');
        if (key === 'slice' || key === 'map' || key === 'constructor' || key === Symbol.species) {
          methodAccess();
          throw new Error('private-array-method');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    reportSignalingFailure({}, context, {
      name: 'AggregateError',
      message: 'private-parent',
      errors,
    });
    expect(methodAccess).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1].related).toEqual([
      expect.objectContaining({ errorType: 'Error', errorCode: 'unknown' }),
      expect.objectContaining({ errorType: 'unknown', errorCode: 'unknown' }),
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  });

  it.each([null, undefined, 'private-token', 123456, Symbol('private')])(
    'does not coerce a non-object thrown value: %s',
    (error) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      reportSignalingFailure({}, context, error);
      expect(log.mock.calls[0]?.[1]).toMatchObject({
        errorType: 'unknown',
        errorCode: 'unknown',
        locations: [],
        related: [],
      });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|123456/);
    },
  );

  it('preserves the exact rejection when thrown-object getters or the logger fail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poisoned = new Proxy(
      {},
      {
        get() {
          throw new Error('private-getter-failure');
        },
      },
    );
    await expect(
      observeSignalingFailure({}, 'room', 'alarm', async () => {
        throw poisoned;
      }),
    ).rejects.toBe(poisoned);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');

    log.mockImplementation(() => {
      throw new Error('logger-failure');
    });
    const original = new Error('original-error');
    await expect(
      observeSignalingFailure({}, 'worker', 'fetch', async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('starts the operation synchronously and leaves successful results and logs unchanged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = { response: 'original' };
    let ingressClaimed = false;
    const operation = observeSignalingFailure({}, 'room', 'webSocketMessage', async () => {
      ingressClaimed = true;
      return result;
    });
    expect(ingressClaimed).toBe(true);
    await expect(operation).resolves.toBe(result);
    expect(log).not.toHaveBeenCalled();
  });

  it('reports and preserves a synchronous failure before the task returns a Promise', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = new Error('original-private-failure');
    await expect(
      observeSignalingFailure({}, 'room', 'initialize', () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      objectKind: 'room',
      operation: 'initialize',
      disposition: 'propagated',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('original-private');
  });
});
