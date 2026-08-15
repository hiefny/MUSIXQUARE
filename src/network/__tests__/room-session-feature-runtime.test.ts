import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  guest: vi.fn(),
  sfu: vi.fn(),
  pro: vi.fn(),
  prepareMediaSession: vi.fn(() => Promise.resolve()),
  localOutputRejoin: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({ log: { warn: mocks.warn } }));
vi.mock('../system-audio-host.ts', () => ({
  registerSystemAudioHostListeners: mocks.host,
}));
vi.mock('../system-audio-guest.ts', () => ({
  registerSystemAudioGuestListeners: mocks.guest,
}));
vi.mock('../system-audio-sfu.ts', () => ({
  registerSystemAudioSfuListeners: mocks.sfu,
}));
vi.mock('../../pro-room/system-audio-service.ts', () => ({
  registerProSystemAudioServiceListeners: mocks.pro,
}));
vi.mock('../../player/media-session-loader.ts', () => ({
  prepareMediaSession: mocks.prepareMediaSession,
}));
vi.mock('../../player/local-output-rejoin.ts', () => ({
  initLocalOutputRejoin: mocks.localOutputRejoin,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('room session feature runtime initialization policy', () => {
  it('keeps protocol listeners ready when an optional enhancement throws', async () => {
    mocks.localOutputRejoin.mockImplementationOnce(() => {
      throw new Error('unsupported local output rejoin');
    });

    await expect(import('../room-session-feature-runtime.ts')).resolves.toBeDefined();

    expect(mocks.host).toHaveBeenCalledOnce();
    expect(mocks.guest).toHaveBeenCalledOnce();
    expect(mocks.sfu).toHaveBeenCalledOnce();
    expect(mocks.pro).toHaveBeenCalledOnce();
    expect(mocks.prepareMediaSession).toHaveBeenCalledOnce();
    expect(mocks.localOutputRejoin).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      '[RoomSession] Optional LocalOutputRejoin initialization failed',
      expect.any(Error),
    );
  });

  it('fails closed when a protocol-critical listener cannot initialize', async () => {
    mocks.host.mockImplementationOnce(() => {
      throw new Error('critical listener failed');
    });

    await expect(import('../room-session-feature-runtime.ts')).rejects.toThrow(
      'critical listener failed',
    );

    expect(mocks.guest).not.toHaveBeenCalled();
    expect(mocks.prepareMediaSession).not.toHaveBeenCalled();
  });
});
