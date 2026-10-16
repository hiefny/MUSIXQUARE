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

  beforeEach(() => {
    mocks.showDialog.mockReset();
    audioRecoveryPrompt = false;
  });

  const create = () =>
    createLongBackgroundWarning({ hasAudioRecoveryPrompt: () => audioRecoveryPrompt });

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
});
