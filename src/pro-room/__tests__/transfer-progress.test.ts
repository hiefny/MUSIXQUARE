import { describe, expect, it, vi } from 'vitest';
import { createByteWeightedProgressEntries } from '../transfer-progress.ts';

describe('PRO room aggregate transfer progress', () => {
  it('weights a multi-file batch by bytes instead of file count', () => {
    const report = vi.fn();
    const [small, large] = createByteWeightedProgressEntries([{ size: 1 }, { size: 3 }], report);

    small!.onProgress(1);
    expect(report).toHaveBeenLastCalledWith(0.25);

    large!.onProgress(0.5);
    expect(report).toHaveBeenLastCalledWith(0.625);

    large!.onProgress(1);
    expect(report).toHaveBeenLastCalledWith(1);
  });

  it('clamps malformed ticks and never moves aggregate progress backwards', () => {
    const report = vi.fn();
    const [entry] = createByteWeightedProgressEntries([{ size: 4 }], report);

    entry!.onProgress(0.7);
    entry!.onProgress(0.2);
    entry!.onProgress(Number.NaN);
    entry!.onProgress(2);

    expect(report.mock.calls.map(([fraction]) => fraction)).toEqual([0.7, 0.7, 0.7, 1]);
  });
});
