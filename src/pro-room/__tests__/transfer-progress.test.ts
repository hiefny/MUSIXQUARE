import { describe, expect, it, vi } from 'vitest';
import { createByteWeightedProgressEntries } from '../transfer-progress.ts';

describe('PRO room aggregate transfer progress', () => {
  it('weights a multi-file batch by bytes instead of file count', () => {
    const report = vi.fn();
    const [small, large] = createByteWeightedProgressEntries([{ size: 1 }, { size: 3 }], report);

    small!.onProgress(1);
    expect(report).toHaveBeenLastCalledWith(0.25);

    large!.onProgress(0.5);
    expect(report).toHaveBeenLastCalledWith(0.62);

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

    expect(report.mock.calls.map(([fraction]) => fraction)).toEqual([0.7, 1]);
  });

  it('reports at most once per visible integer percent', () => {
    const report = vi.fn();
    const [entry] = createByteWeightedProgressEntries([{ size: 10 }], report);

    entry!.onProgress(0.201);
    entry!.onProgress(0.209);
    entry!.onProgress(0.21);

    expect(report.mock.calls.map(([fraction]) => fraction)).toEqual([0.2, 0.21]);
  });
});
