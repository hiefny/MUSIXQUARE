/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showDialog: vi.fn(),
}));

vi.mock('../dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));

import { createLongBackgroundWarning } from '../long-background-warning.ts';

interface OpenDialog {
  signal: AbortSignal;
  answer: () => void;
}

/** Each dialog stays open until answered or withdrawn through its signal. */
function holdDialogs(): OpenDialog[] {
  const open: OpenDialog[] = [];
  mocks.showDialog.mockImplementation(
    (options: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        const answer = () => resolve({ action: 'ok' });
        options.signal.addEventListener('abort', () => resolve({ action: 'superseded' }), {
          once: true,
        });
        open.push({ signal: options.signal, answer });
      }),
  );
  return open;
}

describe('long-background warning', () => {
  let audioRecoveryPrompt: boolean;
  let forcedUpdatePending: boolean;

  beforeEach(() => {
    mocks.showDialog.mockReset();
    audioRecoveryPrompt = false;
    forcedUpdatePending = false;
  });

  const create = () =>
    createLongBackgroundWarning({
      hasAudioRecoveryPrompt: () => audioRecoveryPrompt,
      isForcedUpdatePending: () => forcedUpdatePending,
    });

  it('shows the background warning and resolves once it is answered', async () => {
    const open = holdDialogs();
    const warning = create();

    const shown = warning.warn();
    expect(mocks.showDialog).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'dialog.background_resume_title',
        message: 'dialog.background_resume_message',
        buttonText: 'dialog.got_it',
        defaultFocus: 'primary',
      }),
    );

    open[0]!.answer();
    await expect(shown).resolves.toBeUndefined();
  });

  it('skips the warning once audio recovery owns this return', async () => {
    holdDialogs();
    const warning = create();

    warning.beginIncident();
    warning.yieldToAudioRecovery();
    await warning.warn();

    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('skips the warning while an audio recovery dialog is open or queued', async () => {
    holdDialogs();
    const warning = create();
    audioRecoveryPrompt = true;

    warning.beginIncident();
    await warning.warn();

    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('withdraws an open warning when an audio recovery dialog takes over', async () => {
    const open = holdDialogs();
    const warning = create();

    warning.beginIncident();
    const shown = warning.warn();
    expect(open).toHaveLength(1);
    expect(open[0]!.signal.aborted).toBe(false);

    warning.yieldToAudioRecovery();

    expect(open[0]!.signal.aborted).toBe(true);
    await expect(shown).resolves.toBeUndefined();
  });

  it('shows the warning again for the next return', async () => {
    const open = holdDialogs();
    const warning = create();

    warning.beginIncident();
    warning.yieldToAudioRecovery();
    await warning.warn();
    expect(mocks.showDialog).not.toHaveBeenCalled();

    warning.beginIncident();
    const shown = warning.warn();
    expect(mocks.showDialog).toHaveBeenCalledOnce();
    open[0]!.answer();
    await shown;
  });

  it('leaves an answered warning alone when audio recovery arrives later', async () => {
    const open = holdDialogs();
    const warning = create();

    warning.beginIncident();
    const shown = warning.warn();
    open[0]!.answer();
    await shown;

    warning.yieldToAudioRecovery();

    expect(open[0]!.signal.aborted).toBe(false);
  });

  // RO-51: the forced update dialog (RO-22, train 9.0.14) is the highest
  // return-time dialog. While it is open, queued or reloading the page, the
  // warning never opens, and when it takes the screen it withdraws a warning
  // that is open or queued.
  it('skips the warning while a forced update is pending', async () => {
    holdDialogs();
    const warning = create();
    forcedUpdatePending = true;

    warning.beginIncident();
    await warning.warn();

    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('withdraws an open warning when the forced update takes the screen', async () => {
    const open = holdDialogs();
    const warning = create();

    warning.beginIncident();
    const shown = warning.warn();
    expect(open).toHaveLength(1);

    warning.yieldToForcedUpdate();

    expect(open[0]!.signal.aborted).toBe(true);
    await expect(shown).resolves.toBeUndefined();
  });

  it('withdraws a warning still queued behind another dialog when the forced update takes the screen', async () => {
    // The queue resolves a withdrawn dialog only when it reaches it
    // (dialog.ts skips an aborted one): the abort must reach it before then.
    const queued: AbortSignal[] = [];
    mocks.showDialog.mockImplementation((options: { signal: AbortSignal }) => {
      queued.push(options.signal);
      return new Promise(() => undefined);
    });
    const warning = create();

    warning.beginIncident();
    // The queue never reaches it here, so the warning stays pending.
    warning.warn().catch(() => undefined);
    warning.yieldToForcedUpdate();

    expect(queued).toHaveLength(1);
    expect(queued[0]!.aborted).toBe(true);
  });

  it('shows the warning of a later return once no forced update is pending', async () => {
    const open = holdDialogs();
    const warning = create();

    warning.beginIncident();
    warning.yieldToForcedUpdate();
    forcedUpdatePending = false;
    const shown = warning.warn();

    expect(mocks.showDialog).toHaveBeenCalledOnce();
    open[0]!.answer();
    await shown;
  });
});
