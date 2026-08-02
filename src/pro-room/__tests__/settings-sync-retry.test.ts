import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProRoomApiError } from '../api.ts';
import {
  isTransientSettingsSyncFailure,
  SettingsSyncCheckpointState,
} from '../settings-sync-retry.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('settings sync checkpoint retry state', () => {
  it('retries a transient first PUT and retains full takeover until success', async () => {
    vi.useFakeTimers();
    const state = new SettingsSyncCheckpointState();
    const put = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ProRoomApiError('NETWORK_ERROR'))
      .mockResolvedValueOnce();

    state.beginFullPublishIntent();
    state.markDirty();
    const attempt = async (): Promise<void> => {
      const token = state.begin();
      if (!token) return;
      try {
        await put();
        state.succeed(token);
      } catch (error) {
        expect(isTransientSettingsSyncFailure(error)).toBe(true);
        const delay = state.nextRetryDelay(token);
        if (delay !== null) setTimeout(() => void attempt(), delay);
      }
    };

    await attempt();
    expect(put).toHaveBeenCalledOnce();
    expect(state.dirty).toBe(true);
    expect(state.pendingFullPublishIntent).not.toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(state.dirty).toBe(false);
    expect(state.pendingFullPublishIntent).toBe(0);
  });

  it('cancels a scheduled retry when sync or authority is revoked', async () => {
    vi.useFakeTimers();
    const state = new SettingsSyncCheckpointState();
    const put = vi.fn();
    state.beginFullPublishIntent();
    state.markDirty();
    const token = state.begin()!;
    const delay = state.nextRetryDelay(token)!;
    setTimeout(() => {
      if (state.begin()) put();
    }, delay);

    state.cancel();
    await vi.advanceTimersByTimeAsync(delay);

    expect(put).not.toHaveBeenCalled();
    expect(state.dirty).toBe(false);
    expect(state.pendingFullPublishIntent).toBe(0);
  });

  it('does not retry terminal authority failures', () => {
    expect(isTransientSettingsSyncFailure(new ProRoomApiError('CAPABILITY_REQUIRED', 403))).toBe(
      false,
    );
    expect(isTransientSettingsSyncFailure(new ProRoomApiError('ROOM_EPOCH_MISMATCH', 409))).toBe(
      false,
    );
    expect(isTransientSettingsSyncFailure(new ProRoomApiError('HTTP_503', 503))).toBe(true);
  });

  it('caps exponential backoff while honoring Retry-After', () => {
    const state = new SettingsSyncCheckpointState();
    state.markDirty();
    const token = state.begin()!;

    expect(state.nextRetryDelay(token)).toBe(1_000);
    expect(state.nextRetryDelay(token)).toBe(3_000);
    expect(state.nextRetryDelay(token)).toBe(10_000);
    expect(state.nextRetryDelay(token)).toBe(10_000);
    expect(state.nextRetryDelay(token, 30_000)).toBe(30_000);
  });

  it('does not let an older success consume a newer dirty edit', () => {
    const state = new SettingsSyncCheckpointState();
    state.beginFullPublishIntent();
    state.markDirty();
    const first = state.begin()!;
    state.markDirty();

    state.succeed(first);

    expect(state.dirty).toBe(true);
    expect(state.pendingFullPublishIntent).toBe(0);
    expect(state.begin()?.revision).toBeGreaterThan(first.revision);
  });
});
