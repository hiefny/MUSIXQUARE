import { describe, expect, it } from 'vitest';
import {
  canCollapseChatDrawerFullToHalf,
  canExpandChatDrawer,
  canUseChatDrawerHalfDetent,
  getChatDrawerFullDismissThreshold,
  getInitialChatDrawerDetent,
  resolveChatDrawerRelease,
  type ChatDrawerViewportContext,
} from '../chat-drawer-detents.ts';

function viewport(overrides: Partial<ChatDrawerViewportContext> = {}): ChatDrawerViewportContext {
  return {
    viewportWidth: 390,
    viewportHeight: 844,
    isPortrait: true,
    stageBottom: 300,
    ...overrides,
  };
}

describe('chat drawer detent policy', () => {
  it('opens ordinary portrait phones at half and allows full expansion', () => {
    const context = viewport();
    expect(getInitialChatDrawerDetent(context)).toBe('half');
    expect(canExpandChatDrawer(context)).toBe(true);
  });

  it('lets short portrait phones expand but closes full without collapsing to half', () => {
    const context = viewport({ viewportWidth: 370, viewportHeight: 558 });
    expect(getInitialChatDrawerDetent(context)).toBe('half');
    expect(canExpandChatDrawer(context)).toBe(true);
    expect(canCollapseChatDrawerFullToHalf(context)).toBe(false);

    expect(
      resolveChatDrawerRelease({
        startDetent: 'half',
        deltaY: -72,
        canExpand: canExpandChatDrawer(context),
        canCollapseFullToHalf: canCollapseChatDrawerFullToHalf(context),
      }),
    ).toBe('full');
    expect(
      resolveChatDrawerRelease({
        startDetent: 'full',
        deltaY: 100,
        canExpand: canExpandChatDrawer(context),
        canCollapseFullToHalf: canCollapseChatDrawerFullToHalf(context),
      }),
    ).toBe('closed');
  });

  it('keeps a short landscape phone full-height', () => {
    const context = viewport({
      viewportWidth: 844,
      viewportHeight: 390,
      isPortrait: false,
      stageBottom: 230,
    });
    expect(canUseChatDrawerHalfDetent(context)).toBe(false);
    expect(getInitialChatDrawerDetent(context)).toBe('full');
  });

  it('uses half-height on tall landscape only when it clears the media stage', () => {
    const clearContext = viewport({
      viewportWidth: 829,
      viewportHeight: 690,
      isPortrait: false,
      stageBottom: 330,
    });
    const overlappingContext = { ...clearContext, stageBottom: 340 };

    expect(canUseChatDrawerHalfDetent(clearContext)).toBe(true);
    expect(getInitialChatDrawerDetent(clearContext)).toBe('half');
    expect(canUseChatDrawerHalfDetent(overlappingContext)).toBe(false);
    expect(getInitialChatDrawerDetent(overlappingContext)).toBe('full');
  });

  it('uses a conservative fallback when the media stage cannot be measured', () => {
    expect(
      canUseChatDrawerHalfDetent(
        viewport({
          viewportWidth: 1024,
          viewportHeight: 719,
          isPortrait: false,
          stageBottom: null,
        }),
      ),
    ).toBe(false);
    expect(
      canUseChatDrawerHalfDetent(
        viewport({
          viewportWidth: 1024,
          viewportHeight: 720,
          isPortrait: false,
          stageBottom: null,
        }),
      ),
    ).toBe(true);
  });

  it('never enables mobile detents in the desktop grid', () => {
    const context = viewport({
      viewportWidth: 1280,
      viewportHeight: 720,
      isPortrait: false,
      stageBottom: 300,
    });
    expect(canUseChatDrawerHalfDetent(context)).toBe(false);
    expect(canExpandChatDrawer(context)).toBe(false);
    expect(canCollapseChatDrawerFullToHalf(context)).toBe(false);
  });
});

describe('chat drawer release reducer', () => {
  it('expands half only at the upward threshold', () => {
    expect(
      resolveChatDrawerRelease({
        startDetent: 'half',
        deltaY: -71,
        canExpand: true,
        canCollapseFullToHalf: true,
      }),
    ).toBe('half');
    expect(
      resolveChatDrawerRelease({
        startDetent: 'half',
        deltaY: -72,
        canExpand: true,
        canCollapseFullToHalf: true,
      }),
    ).toBe('full');
  });

  it('closes half only at the downward dismiss threshold', () => {
    expect(
      resolveChatDrawerRelease({
        startDetent: 'half',
        deltaY: 99,
        canExpand: true,
        canCollapseFullToHalf: true,
      }),
    ).toBe('half');
    expect(
      resolveChatDrawerRelease({
        startDetent: 'half',
        deltaY: 100,
        canExpand: true,
        canCollapseFullToHalf: true,
      }),
    ).toBe('closed');
  });

  it('settles an ordinary full-height drag at half', () => {
    const fullDismissThreshold = getChatDrawerFullDismissThreshold(844);
    expect(
      resolveChatDrawerRelease({
        startDetent: 'full',
        deltaY: 71,
        canExpand: true,
        canCollapseFullToHalf: true,
        fullDismissThreshold,
      }),
    ).toBe('full');
    expect(
      resolveChatDrawerRelease({
        startDetent: 'full',
        deltaY: 72,
        canExpand: true,
        canCollapseFullToHalf: true,
        fullDismissThreshold,
      }),
    ).toBe('half');
    expect(
      resolveChatDrawerRelease({
        startDetent: 'full',
        deltaY: fullDismissThreshold - 1,
        canExpand: true,
        canCollapseFullToHalf: true,
        fullDismissThreshold,
      }),
    ).toBe('half');
  });

  it('closes directly after a deliberately long full-height drag', () => {
    const fullDismissThreshold = getChatDrawerFullDismissThreshold(844);
    expect(fullDismissThreshold).toBeCloseTo(295.4);
    expect(
      resolveChatDrawerRelease({
        startDetent: 'full',
        deltaY: fullDismissThreshold,
        canExpand: true,
        canCollapseFullToHalf: true,
        fullDismissThreshold,
      }),
    ).toBe('closed');
  });

  it('closes full directly only when no intermediate detent is available', () => {
    expect(
      resolveChatDrawerRelease({
        startDetent: 'full',
        deltaY: 99,
        canExpand: false,
        canCollapseFullToHalf: false,
      }),
    ).toBe('full');
    expect(
      resolveChatDrawerRelease({
        startDetent: 'full',
        deltaY: 100,
        canExpand: false,
        canCollapseFullToHalf: false,
      }),
    ).toBe('closed');
  });

  it('returns to the starting detent when the gesture is cancelled', () => {
    expect(
      resolveChatDrawerRelease({
        startDetent: 'half',
        deltaY: 300,
        canExpand: true,
        canCollapseFullToHalf: true,
        cancelled: true,
      }),
    ).toBe('half');
    expect(
      resolveChatDrawerRelease({
        startDetent: 'full',
        deltaY: 300,
        canExpand: true,
        canCollapseFullToHalf: true,
        cancelled: true,
      }),
    ).toBe('full');
  });
});
