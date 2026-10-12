import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('deferred PRO realtime sender', () => {
  beforeEach(() => vi.resetModules());

  it('rejects before transport readiness without importing the bridge or replaying later', async () => {
    const { sendProRoomRealtime, bindProRoomRealtimeSender } =
      await import('../realtime-sender.ts');
    const payload = { type: 'CHAT', text: 'before entry' };
    expect(sendProRoomRealtime('chat', payload)).toBe(false);
    const send = vi.fn(() => true);
    bindProRoomRealtimeSender(send);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(sendProRoomRealtime('chat', payload)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('chat', payload);
  });

  it('returns the live synchronous transport result without retaining failed submissions', async () => {
    const { sendProRoomRealtime, bindProRoomRealtimeSender } =
      await import('../realtime-sender.ts');
    const send = vi.fn(() => false);
    bindProRoomRealtimeSender(send);
    expect(sendProRoomRealtime('presence', { active: true })).toBe(false);
    send.mockReturnValue(true);
    expect(sendProRoomRealtime('chat', { text: 'after reconnect' })).toBe(true);
    expect(send.mock.calls).toEqual([
      ['presence', { active: true }],
      ['chat', { text: 'after reconnect' }],
    ]);
  });
});
