/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_USED_KEY,
  DEMO_PROMPT_SEEN_KEY,
  hasAppUseRecord,
  hasSeenDemoPrompt,
  markAppUsed,
  markDemoPromptSeen,
} from '../storage.ts';

describe('demo first-run storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with no app usage or prompt record', () => {
    expect(hasAppUseRecord()).toBe(false);
    expect(hasSeenDemoPrompt()).toBe(false);
  });

  it('stores app usage and prompt seen flags independently', () => {
    markAppUsed();
    expect(localStorage.getItem(APP_USED_KEY)).toBe('1');
    expect(hasAppUseRecord()).toBe(true);
    expect(hasSeenDemoPrompt()).toBe(false);

    markDemoPromptSeen();
    expect(localStorage.getItem(DEMO_PROMPT_SEEN_KEY)).toBe('1');
    expect(hasSeenDemoPrompt()).toBe(true);
  });
});
