import { describe, expect, it } from 'vitest';
import {
  formatSystemAudioProfileLabel,
  normalizeSystemAudioSurface,
} from '../system-audio-profile.ts';

describe('system audio display profile', () => {
  it.each([
    ['browser', 'browser'],
    ['window', 'window'],
    ['application', 'window'],
    ['monitor', 'display'],
    ['display', 'display'],
    ['future-surface', 'display'],
    [undefined, 'display'],
    [null, 'display'],
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeSystemAudioSurface(input)).toBe(expected);
  });

  it.each([
    ['browser', '≤256 kbps · BROWSER'],
    ['window', '≤256 kbps · WINDOW'],
    ['display', '≤256 kbps · DISPLAY'],
    ['untrusted picker title', '≤256 kbps · DISPLAY'],
  ] as const)('formats the fixed aggregate profile for %s', (surface, expected) => {
    expect(formatSystemAudioProfileLabel(surface)).toBe(expected);
  });
});
