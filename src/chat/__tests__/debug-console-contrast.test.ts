/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addSystemChatMessage: vi.fn(),
  clipboardWriteText: vi.fn(() => Promise.resolve()),
  getContrastStatus: vi.fn(),
  setContrastPreference: vi.fn(),
}));

vi.mock('../../ui/chat-render.ts', () => ({
  addSystemChatMessage: mocks.addSystemChatMessage,
}));

vi.mock('../../core/contrast.ts', () => ({
  getContrastStatus: mocks.getContrastStatus,
  setContrastPreference: mocks.setContrastPreference,
}));

import { cmdDebug } from '../debug-console.ts';

const automaticStatus = {
  preference: 'auto' as const,
  authoredContrastActive: true,
  systemPrefersMore: true,
  forcedColorsActive: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.clipboardWriteText },
  });
  mocks.getContrastStatus.mockReturnValue(automaticStatus);
  mocks.setContrastPreference.mockImplementation((preference: 'auto' | 'on' | 'off') => ({
    ...automaticStatus,
    preference,
    authoredContrastActive: preference !== 'off',
  }));
});

describe('/debug contrast', () => {
  it('shows local status when no mode is supplied', () => {
    cmdDebug(['contrast']);

    expect(mocks.getContrastStatus).toHaveBeenCalledOnce();
    expect(mocks.setContrastPreference).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledWith(
      'Contrast: auto | authored:more | OS:more | forced-colors:inactive',
    );
    expect(mocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it.each(['on', 'off', 'auto'] as const)('applies the local %s mode', (preference) => {
    cmdDebug(['contrast', preference.toUpperCase()]);

    expect(mocks.setContrastPreference).toHaveBeenCalledWith(preference);
    expect(mocks.addSystemChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it.each([
    ['contrast', 'maximum'],
    ['contrast', 'on', 'unexpected'],
  ])('prints usage for invalid args without falling through to the full dump', (...args) => {
    cmdDebug(args);

    expect(mocks.getContrastStatus).not.toHaveBeenCalled();
    expect(mocks.setContrastPreference).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledOnce();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledWith(
      'Usage: /debug contrast [on | off | auto]',
    );
    expect(mocks.addSystemChatMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('SYSTEM DEBUG INFO'),
    );
    expect(mocks.clipboardWriteText).not.toHaveBeenCalled();
  });
});
