/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setControlHint, setControlUnavailable } from '../control-hint.ts';

/**
 * Owner decision (2026-10-27, UI audit item 6, option A): a hover hint shows
 * only what a control's shape cannot say, which is why it cannot be used right
 * now or the mode a press starts. Names stay in aria-label and are never
 * repeated as tooltips; visible text needs no hint.
 */

const REASON = 'Playback control permission required';
const HINT = 'Select this track and enter selection mode';

function iconButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Repeat');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12h10"/></svg>';
  document.body.appendChild(button);
  return button;
}

function textButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Sync';
  document.body.appendChild(button);
  return button;
}

function hintOf(element: Element) {
  return {
    title: element.getAttribute('title'),
    ariaDisabled: element.getAttribute('aria-disabled'),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('control hint truth table', () => {
  it('shows the reason while a control is unavailable', () => {
    const button = iconButton();
    setControlUnavailable(button, REASON);
    expect(hintOf(button)).toEqual({ title: REASON, ariaDisabled: 'true' });
  });

  it('drops the reason, and shows nothing, once the control is available again', () => {
    const button = iconButton();
    setControlUnavailable(button, REASON);
    setControlUnavailable(button, null);
    expect(hintOf(button)).toEqual({ title: null, ariaDisabled: 'false' });
  });

  it('returns to the mode hint once the reason clears', () => {
    const button = iconButton();
    setControlHint(button, HINT);
    setControlUnavailable(button, REASON);
    expect(hintOf(button)).toEqual({ title: REASON, ariaDisabled: 'true' });

    setControlUnavailable(button, null);
    expect(hintOf(button)).toEqual({ title: HINT, ariaDisabled: 'false' });
  });

  it('shows the mode hint on an available control without touching its availability', () => {
    const button = iconButton();
    setControlHint(button, HINT);
    expect(hintOf(button)).toEqual({ title: HINT, ariaDisabled: null });

    setControlHint(button, null);
    expect(hintOf(button)).toEqual({ title: null, ariaDisabled: null });
  });

  it('gives an icon-only control without a hint or reason no tooltip, not its name', () => {
    const button = iconButton();
    setControlHint(button, null);
    setControlUnavailable(button, null);
    expect(button.getAttribute('aria-label')).toBe('Repeat');
    expect(button.hasAttribute('title')).toBe(false);
  });

  it('gives a control with visible text no tooltip', () => {
    const button = textButton();
    setControlUnavailable(button, null);
    expect(button.hasAttribute('title')).toBe(false);
  });

  it('keeps the reason ahead of a hint that changes while the control is unavailable', () => {
    const button = iconButton();
    setControlUnavailable(button, REASON);
    setControlHint(button, HINT);
    expect(button.getAttribute('title')).toBe(REASON);

    setControlHint(button, null);
    setControlUnavailable(button, null);
    expect(button.hasAttribute('title')).toBe(false);
  });

  it('marks a control unavailable without words when its own state already says why', () => {
    const button = iconButton();
    setControlHint(button, HINT);
    setControlUnavailable(button, '');
    expect(hintOf(button)).toEqual({ title: null, ariaDisabled: 'true' });

    setControlUnavailable(button, null);
    expect(hintOf(button)).toEqual({ title: HINT, ariaDisabled: 'false' });
  });

  it('never renames the control', () => {
    const button = iconButton();
    setControlHint(button, HINT);
    setControlUnavailable(button, REASON);
    setControlUnavailable(button, null);
    expect(button.getAttribute('aria-label')).toBe('Repeat');
  });
});

describe('control hint writes', () => {
  it('writes the hint when state changes, not when a pointer arrives', () => {
    const button = iconButton();
    const elementListen = vi.spyOn(button, 'addEventListener');
    const documentListen = vi.spyOn(document, 'addEventListener');
    const windowListen = vi.spyOn(window, 'addEventListener');

    setControlUnavailable(button, REASON);
    setControlHint(button, HINT);

    // The reason is already there for keyboard and screen reader users.
    expect(button.getAttribute('title')).toBe(REASON);
    expect(elementListen).not.toHaveBeenCalled();
    expect(documentListen).not.toHaveBeenCalled();
    expect(windowListen).not.toHaveBeenCalled();
  });

  it('leaves the DOM alone when the same state is written again', async () => {
    const button = iconButton();
    setControlHint(button, HINT);
    setControlUnavailable(button, REASON);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(button, { attributes: true });

    setControlHint(button, HINT);
    setControlUnavailable(button, REASON);
    await Promise.resolve();
    observer.disconnect();

    expect(records).toEqual([]);
  });

  it('also makes the reason the description where a title would not be read', () => {
    // A group whose own controls are natively disabled, or that already has
    // aria-describedby (which outranks title), carries the reason in a hidden
    // node it references first, and gets its own description back afterwards.
    document.body.innerHTML = `
      <p id="reverb-description">Adjust the reverb.</p>
      <div id="grid-reverb" role="group" aria-describedby="reverb-description">
        <button type="button">Studio</button>
      </div>`;
    const group = document.getElementById('grid-reverb')!;
    setControlUnavailable(group, REASON, { describe: true });
    const reason = document.getElementById('grid-reverb-reason')!;
    expect(reason.hidden).toBe(true);
    expect(reason.textContent).toBe(REASON);
    expect(group.contains(reason)).toBe(false);
    expect(group.getAttribute('aria-describedby')).toBe('grid-reverb-reason reverb-description');
    expect(hintOf(group)).toEqual({ title: REASON, ariaDisabled: 'true' });

    setControlUnavailable(group, REASON, { describe: true });
    expect(group.getAttribute('aria-describedby')).toBe('grid-reverb-reason reverb-description');

    setControlUnavailable(group, null, { describe: true });
    expect(reason.textContent).toBe('');
    expect(group.getAttribute('aria-describedby')).toBe('reverb-description');
    expect(hintOf(group)).toEqual({ title: null, ariaDisabled: 'false' });
  });

  it('uses an authored reason node and drops a description it alone made', () => {
    document.body.innerHTML = `
      <div id="volume-control-group" role="group">
        <span id="volume-control-group-reason" hidden></span>
      </div>`;
    const group = document.getElementById('volume-control-group')!;
    setControlUnavailable(group, REASON, { describe: true });
    expect(document.querySelectorAll('#volume-control-group-reason')).toHaveLength(1);
    expect(document.getElementById('volume-control-group-reason')!.textContent).toBe(REASON);
    expect(group.getAttribute('aria-describedby')).toBe('volume-control-group-reason');
    setControlUnavailable(group, null, { describe: true });
    expect(group.hasAttribute('aria-describedby')).toBe(false);
    // Without the option nothing is described, and no node is made.
    const plain = iconButton();
    plain.id = 'plain';
    setControlUnavailable(plain, REASON);
    expect(plain.hasAttribute('aria-describedby')).toBe(false);
    expect(document.getElementById('plain-reason')).toBeNull();
  });

  it('keeps each control’s hint to itself', () => {
    const first = iconButton();
    const second = iconButton();
    setControlHint(first, HINT);
    setControlUnavailable(second, REASON);
    setControlUnavailable(first, null);

    expect(first.getAttribute('title')).toBe(HINT);
    expect(second.getAttribute('title')).toBe(REASON);
  });
});
