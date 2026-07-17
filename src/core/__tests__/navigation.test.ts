import { describe, expect, it, vi } from 'vitest';
import { navigateToAppHome } from '../navigation.ts';

describe('app home navigation', () => {
  it('replaces the active room route with the app home path', () => {
    const replace = vi.fn();

    navigateToAppHome({ replace });

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('/');
  });
});
