import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  getState: vi.fn(),
  getActiveProRoomAdministrators: vi.fn(),
  initConnect: vi.fn(),
}));

vi.mock('../../core/events.ts', () => ({
  bus: { emit: runtimeMocks.emit },
}));

vi.mock('../../core/state.ts', () => ({
  getState: runtimeMocks.getState,
}));

vi.mock('../../rooms/authority.ts', () => ({
  getRoomContext: () => ({ kind: 'pro' }),
}));

vi.mock('../../pro-room/runtime.ts', () => ({
  getActiveProRoomAdministrators: runtimeMocks.getActiveProRoomAdministrators,
}));

vi.mock('../connect.ts', () => ({
  initConnect: runtimeMocks.initConnect,
}));

describe('Connect session runtime boundary', () => {
  it('initializes the panel before replaying state after the opening event import race', async () => {
    const devices = [{ id: 'guest-1', label: 'Guest 1' }];
    const administrators = [{ memberId: 'owner-1', role: 'owner' }];
    runtimeMocks.getState.mockReturnValue(devices);
    runtimeMocks.getActiveProRoomAdministrators.mockReturnValue(administrators);

    const { connectSessionRuntimeReady } = await import('../connect-session-runtime.ts');
    await connectSessionRuntimeReady;

    expect(runtimeMocks.initConnect).toHaveBeenCalledOnce();
    expect(runtimeMocks.emit).toHaveBeenCalledWith(
      'network:device-list-update',
      expect.arrayContaining(devices),
    );
    expect(runtimeMocks.emit).toHaveBeenCalledWith(
      'pro-room:administrators-updated',
      administrators,
    );
    expect(runtimeMocks.initConnect.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeMocks.emit.mock.invocationCallOrder[0]!,
    );
    expect(runtimeMocks.emit.mock.calls[0]?.[1]).not.toBe(devices);
    expect(runtimeMocks.initConnect.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeMocks.getActiveProRoomAdministrators.mock.invocationCallOrder[0]!,
    );
  });
});
