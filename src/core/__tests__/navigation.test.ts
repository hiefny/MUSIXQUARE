/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigateHome, navigateToAppHome, returnToRoomStart } from '../navigation.ts';
import { NAVIGATION_COMMIT_TIMEOUT_MS, RECONNECT_TARGET_KEY } from '../navigation-contract.ts';
import { isSessionResetPending, scheduleSessionReset } from '../session-reset.ts';
import {
  IN_ROOM,
  MSG_LEAVING,
  MSG_REFRESHING,
  PAINT_MS,
  bootPageNavigationShell,
  type PageNavigationShell,
} from './__helpers__/page-navigation-harness.ts';

/** A synthetic six-digit room code. */
const ROOM_CODE = '123456';

describe('app home navigation', () => {
  it('replaces the active room route with the app home path', () => {
    const replace = vi.fn();

    navigateToAppHome({ replace });

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('/');
  });
});

// C6-3: the home and return-to-room-start intents, at the owner boundary (the
// real reset with recorded location sinks; see the page navigation harness).
describe('navigation intents', () => {
  let shell: PageNavigationShell;

  beforeEach(() => {
    vi.useFakeTimers();
    shell = bootPageNavigationShell({ app: IN_ROOM });
  });

  afterEach(() => {
    shell.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    ['replace', 'replace'],
    ['push', 'href'],
  ] as const)(
    'navigates home behind the reset screen, keeping history as %s',
    async (history, op) => {
      navigateHome(MSG_LEAVING, { history });

      expect(isSessionResetPending()).toBe(true);
      expect(shell.resetMessage()).toBe(MSG_LEAVING);
      expect(shell.sinks.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(PAINT_MS);
      // 'push' is the setup-guest Back buttons' location.href = '/', kept by the
      // owner's Phase 2 decision 6; every other home navigation replaces.
      expect(shell.sinks.calls).toEqual([expect.objectContaining({ op, url: '/' })]);
      expect(shell.beforeunloadPrompts()).toBe(false);
    },
  );

  it('returns to the room Start screen as a pushed entry and marks the reconnect before the reset', async () => {
    const fallback = vi.fn();

    expect(
      returnToRoomStart(ROOM_CODE, { message: MSG_REFRESHING, reconnect: true, fallback }),
    ).toBe(true);

    // setup's join error reads the marker in the next document.
    expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBe(ROOM_CODE);
    expect(shell.resetMessage()).toBe(MSG_REFRESHING);
    await vi.advanceTimersByTimeAsync(PAINT_MS);
    expect(shell.sinks.calls).toEqual([
      expect.objectContaining({ op: 'href', url: `/${ROOM_CODE}` }),
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('writes no reconnect marker for a plain return', async () => {
    returnToRoomStart(ROOM_CODE, { message: MSG_REFRESHING, reconnect: false, fallback: vi.fn() });

    expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(PAINT_MS);
    expect(shell.sinks.calls).toEqual([
      expect.objectContaining({ op: 'href', url: `/${ROOM_CODE}` }),
    ]);
  });

  it.each([['../123456'], ['12345'], ['1234567'], ['12345a'], [''], [null], [undefined], [123456]])(
    'runs the fallback instead of navigating for %j',
    async (code) => {
      const fallback = vi.fn();
      const onRecovered = vi.fn();

      expect(
        returnToRoomStart(code, {
          message: MSG_REFRESHING,
          reconnect: true,
          fallback,
          onRecovered,
        }),
      ).toBe(false);

      expect(fallback).toHaveBeenCalledOnce();
      expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBeNull();
      expect(isSessionResetPending()).toBe(false);
      await vi.advanceTimersByTimeAsync(PAINT_MS + NAVIGATION_COMMIT_TIMEOUT_MS);
      expect(shell.sinks.calls).toEqual([]);
      // The fallback owns what happens next; the return reports nothing.
      expect(onRecovered).not.toHaveBeenCalled();
    },
  );

  it('reports a return that never commits once, when the reset recovers', async () => {
    const onRecovered = vi.fn();
    returnToRoomStart(ROOM_CODE, {
      message: MSG_REFRESHING,
      reconnect: true,
      fallback: vi.fn(),
      onRecovered,
    });

    await vi.advanceTimersByTimeAsync(PAINT_MS + NAVIGATION_COMMIT_TIMEOUT_MS - 1);
    expect(onRecovered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(isSessionResetPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it('reports a return refused because another navigation holds the page at once, and still marks it', () => {
    scheduleSessionReset(MSG_LEAVING, vi.fn());
    const onRecovered = vi.fn();

    returnToRoomStart(ROOM_CODE, {
      message: MSG_REFRESHING,
      reconnect: true,
      fallback: vi.fn(),
      onRecovered,
    });

    expect(onRecovered).toHaveBeenCalledOnce();
    expect(shell.resetMessage()).toBe(MSG_LEAVING);
    expect(sessionStorage.getItem(RECONNECT_TARGET_KEY)).toBe(ROOM_CODE);
  });

  it('stays silent once the return commits', async () => {
    const onRecovered = vi.fn();
    returnToRoomStart(ROOM_CODE, {
      message: MSG_REFRESHING,
      reconnect: true,
      fallback: vi.fn(),
      onRecovered,
    });

    await vi.advanceTimersByTimeAsync(PAINT_MS);
    shell.leaveDocument(false);
    await vi.advanceTimersByTimeAsync(NAVIGATION_COMMIT_TIMEOUT_MS + 10_000);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(isSessionResetPending()).toBe(true);
  });
});
