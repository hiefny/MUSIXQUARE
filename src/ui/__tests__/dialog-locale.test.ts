/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { getLanguageMode, setLanguageMode, t } from '../../i18n/index.ts';
import { showDialog, closeDialog } from '../dialog.ts';

let language: ReturnType<typeof getLanguageMode>;
beforeEach(() => {
  closeDialog();
  clearAllManagedTimers();
  bus.clear();
  language = getLanguageMode();
  document.body.innerHTML =
    '<div id="dialog-overlay"><div role="dialog"><h2 id="dialog-title"></h2><div id="dialog-message"></div><div class="dialog-actions"><button id="btn-dialog-secondary"></button><button id="btn-dialog-ok"></button></div></div></div>';
  setLanguageMode('en');
});
afterEach(() => {
  closeDialog();
  clearAllManagedTimers();
  setLanguageMode(language);
  bus.clear();
});

describe('dialog locale lifetime', () => {
  it('refreshes opted-in copy and existing validation without rebuilding the focused draft', async () => {
    const listeners = bus.debug()['i18n:changed'] || 0;
    const pending = showDialog({
      title: () => t('account.nickname_title'),
      message: () => t('account.nickname_message'),
      buttonText: () => t('common.ok'),
      secondaryText: () => t('common.later'),
      inputField: {
        placeholder: () => t('account.nickname_placeholder'),
        hint: () => t('account.nickname_hint'),
        validator: () => t('account.nickname_required'),
      },
    });
    const input = document.querySelector<HTMLElement>('.dialog-input')!;
    // jsdom does not make contentEditable elements natively focusable.
    input.tabIndex = 0;
    input.textContent = 'Keep {{title}}';
    input.focus();
    document.getElementById('btn-dialog-ok')!.click();
    setLanguageMode('ko');
    expect(document.getElementById('dialog-title')?.textContent).toBe(t('account.nickname_title'));
    expect(document.getElementById('dialog-message')?.firstChild?.textContent).toBe(
      t('account.nickname_message'),
    );
    expect(document.getElementById('btn-dialog-ok')?.textContent).toBe(t('common.ok'));
    expect(document.getElementById('btn-dialog-secondary')?.textContent).toBe(t('common.later'));
    expect(input.getAttribute('data-placeholder')).toBe(t('account.nickname_placeholder'));
    expect(input.getAttribute('aria-label')).toBe(t('account.nickname_placeholder'));
    expect(document.getElementById('dialog-input-hint')?.textContent).toBe(
      t('account.nickname_required'),
    );
    expect(document.querySelector('.dialog-input')).toBe(input);
    expect(input.textContent).toBe('Keep {{title}}');
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.getElementById('dialog-input-hint')?.textContent).toBe(
      t('account.nickname_hint'),
    );
    closeDialog('secondary');
    expect(await pending).toMatchObject({ action: 'secondary', inputValue: 'Keep {{title}}' });
    expect(bus.debug()['i18n:changed'] || 0).toBe(listeners);
  });

  it('preserves literal custom copy, including text equal to a translation', async () => {
    const originalTitle = t('account.nickname_title');
    const pending = showDialog({
      title: originalTitle,
      message: 'Account Alpha',
      buttonText: 'Continue Alpha',
      secondaryText: 'Account Beta',
      inputField: { placeholder: 'Literal placeholder', hint: 'Literal hint' },
    });
    setLanguageMode('ko');
    expect(document.getElementById('dialog-title')?.textContent).toBe(originalTitle);
    expect(document.getElementById('dialog-message')?.firstChild?.textContent).toBe(
      'Account Alpha',
    );
    expect(document.getElementById('btn-dialog-ok')?.textContent).toBe('Continue Alpha');
    expect(document.getElementById('btn-dialog-secondary')?.textContent).toBe('Account Beta');
    expect(document.querySelector('.dialog-input')?.getAttribute('data-placeholder')).toBe(
      'Literal placeholder',
    );
    expect(document.getElementById('dialog-input-hint')?.textContent).toBe('Literal hint');
    closeDialog();
    await pending;
  });

  it('relabels PIN segments without changing their entered digits and unsubscribes on abort', async () => {
    const controller = new AbortController();
    const pending = showDialog({
      title: () => t('dialog.room_password_title'),
      signal: controller.signal,
      inputField: {
        placeholder: () => t('dialog.room_password_placeholder'),
        defaultValue: '12345678',
        maxLength: 8,
        splitEvery: 4,
      },
    });
    setLanguageMode('ko');
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.dialog-input-segment')];
    expect(inputs.map((input) => input.value)).toEqual(['1234', '5678']);
    expect(inputs.map((input) => input.getAttribute('aria-label'))).toEqual([
      `${t('dialog.room_password_placeholder')} 1`,
      `${t('dialog.room_password_placeholder')} 2`,
    ]);
    controller.abort();
    expect(await pending).toMatchObject({ action: 'superseded' });
    expect(bus.debug()['i18n:changed'] || 0).toBe(0);
  });
});
