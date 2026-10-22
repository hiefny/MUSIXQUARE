/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';
import { setElementInertForOwner } from '../inert-ownership.ts';

describe('setElementInertForOwner', () => {
  let element: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="window" aria-hidden="true"></div>';
    element = document.getElementById('window') as HTMLElement;
  });

  it('holds inert until the last owner releases and restores the saved state', () => {
    setElementInertForOwner(element, 'a', true);
    setElementInertForOwner(element, 'b', true);
    expect(element.getAttribute('aria-hidden')).toBe('true');

    element.setAttribute('aria-hidden', 'false');
    setElementInertForOwner(element, 'a', false);
    expect(element.inert).toBe(true);
    expect(element.getAttribute('aria-hidden')).toBe('true');

    setElementInertForOwner(element, 'b', false);
    expect(element.inert).toBe(false);
    expect(element.hasAttribute('inert')).toBe(false);
    expect(element.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves aria-hidden to the element when an owner claims inert only', () => {
    setElementInertForOwner(element, 'reset', true, { ariaHidden: false });
    expect(element.inert).toBe(true);
    expect(element.getAttribute('aria-hidden')).toBe('true');

    // The window opens while locked and writes its own value.
    element.setAttribute('aria-hidden', 'false');
    setElementInertForOwner(element, 'reset', false);
    expect(element.inert).toBe(false);
    expect(element.getAttribute('aria-hidden')).toBe('false');
  });

  it('saves aria-hidden at the first aria-hidden claim, not the first inert claim', () => {
    setElementInertForOwner(element, 'reset', true, { ariaHidden: false });
    element.setAttribute('aria-hidden', 'false');
    setElementInertForOwner(element, 'modal', true);
    expect(element.getAttribute('aria-hidden')).toBe('true');

    // The aria-hidden owner leaves first: its saved value returns while the
    // inert-only owner keeps the lock.
    setElementInertForOwner(element, 'modal', false);
    expect(element.inert).toBe(true);
    expect(element.getAttribute('aria-hidden')).toBe('false');

    element.setAttribute('aria-hidden', 'true');
    setElementInertForOwner(element, 'reset', false);
    expect(element.inert).toBe(false);
    expect(element.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps aria-hidden held when the inert-only owner leaves first', () => {
    element.removeAttribute('aria-hidden');
    setElementInertForOwner(element, 'modal', true);
    setElementInertForOwner(element, 'reset', true, { ariaHidden: false });

    setElementInertForOwner(element, 'reset', false);
    expect(element.inert).toBe(true);
    expect(element.getAttribute('aria-hidden')).toBe('true');

    setElementInertForOwner(element, 'modal', false);
    expect(element.inert).toBe(false);
    expect(element.hasAttribute('aria-hidden')).toBe(false);
  });

  it('preserves a pre-existing unmanaged inert state', () => {
    element.inert = true;
    setElementInertForOwner(element, 'reset', true, { ariaHidden: false });
    setElementInertForOwner(element, 'reset', false);
    expect(element.inert).toBe(true);
    expect(element.hasAttribute('inert')).toBe(true);
  });
});
