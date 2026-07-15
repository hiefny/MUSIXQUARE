/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerProRoomHardCloseHandler,
  registerProRoomLeaveHandler,
  requestProRoomLeave,
} from '../lifecycle-hook.ts';

function pageHide(persisted: boolean): Event {
  const event = new Event('pagehide');
  Object.defineProperty(event, 'persisted', { value: persisted });
  return event;
}

afterEach(() => {
  registerProRoomHardCloseHandler(null);
  registerProRoomLeaveHandler(null);
});

describe('PRO room confirmed-unload lifecycle', () => {
  it('starts the atomic close before local pagehide teardown and suppresses explicit leave', () => {
    const order: string[] = [];
    const explicitLeave = vi.fn(() => order.push('explicit-leave'));
    const localTeardown = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) return;
      order.push('local-teardown');
      requestProRoomLeave();
    };
    // This mirrors the common page-lifecycle listener, which is registered
    // before a user dynamically imports and enters the PRO runtime.
    window.addEventListener('pagehide', localTeardown);
    registerProRoomLeaveHandler(explicitLeave);
    registerProRoomHardCloseHandler(() => {
      order.push('atomic-keepalive');
      return true;
    });

    window.dispatchEvent(pageHide(false));

    expect(order).toEqual(['atomic-keepalive', 'local-teardown']);
    expect(explicitLeave).not.toHaveBeenCalled();
    window.removeEventListener('pagehide', localTeardown);
  });

  it('runs a confirmed hard close only once even if teardown asks to leave repeatedly', () => {
    const hardClose = vi.fn(() => true);
    const explicitLeave = vi.fn();
    registerProRoomHardCloseHandler(hardClose);
    registerProRoomLeaveHandler(explicitLeave);

    window.dispatchEvent(pageHide(false));
    window.dispatchEvent(pageHide(false));
    requestProRoomLeave();
    requestProRoomLeave();

    expect(hardClose).toHaveBeenCalledTimes(1);
    expect(explicitLeave).not.toHaveBeenCalled();
  });

  it('keeps ordinary explicit leave unchanged outside confirmed pagehide', async () => {
    const hardClose = vi.fn(() => true);
    const explicitLeave = vi.fn(async () => undefined);
    registerProRoomHardCloseHandler(hardClose);
    registerProRoomLeaveHandler(explicitLeave);

    requestProRoomLeave();
    await Promise.resolve();

    expect(hardClose).not.toHaveBeenCalled();
    expect(explicitLeave).toHaveBeenCalledTimes(1);
  });
});
