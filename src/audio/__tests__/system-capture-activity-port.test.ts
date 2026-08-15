import { describe, expect, it } from 'vitest';

import {
  configureSystemAudioCaptureActivityProbe,
  isSystemAudioCaptureActive,
} from '../system-capture-activity-port.ts';

describe('system capture activity port', () => {
  it('defaults to inactive when no capture implementation is loaded', () => {
    expect(isSystemAudioCaptureActive()).toBe(false);
  });

  it('delegates synchronously and restores the previous probe', () => {
    const restoreInactive = configureSystemAudioCaptureActivityProbe(() => false);
    const restoreActive = configureSystemAudioCaptureActivityProbe(() => true);

    expect(isSystemAudioCaptureActive()).toBe(true);
    restoreActive();
    expect(isSystemAudioCaptureActive()).toBe(false);
    restoreInactive();
  });
});
