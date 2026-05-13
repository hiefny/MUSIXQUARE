export const DEMO_PROMPT_SEEN_KEY = 'musixquare-demo-prompt-seen-v1';
export const APP_USED_KEY = 'musixquare-app-used-v1';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function markAppUsed(): void {
  storageSet(APP_USED_KEY, '1');
}

export function hasAppUseRecord(): boolean {
  return storageGet(APP_USED_KEY) === '1';
}

export function markDemoPromptSeen(): void {
  storageSet(DEMO_PROMPT_SEEN_KEY, '1');
}

export function hasSeenDemoPrompt(): boolean {
  return storageGet(DEMO_PROMPT_SEEN_KEY) === '1';
}
