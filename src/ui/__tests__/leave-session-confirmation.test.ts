/**
 * @vitest-environment jsdom
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ showDialog: vi.fn() }));

vi.mock('../dialog.ts', () => ({ showDialog: mocks.showDialog }));

import { t } from '../../i18n/index.ts';
import { confirmLeaveSession } from '../leave-session-confirmation.ts';

// Owner decision (2026-10-29, items 9 and 12): one "Leave Session"
// confirmation for the connect tab's Leave Session buttons, the logo's
// return home and the Back guard. It reads [Stay | Leave] everywhere (it read
// [Cancel | OK] and [Stay | OK] in two of them), Stay keeps the first focus
// on the left, and Leave takes the danger tone on the right. Each caller keeps
// its title and its body.
const read = (path: string): string => readFileSync(resolve(path), 'utf8');

beforeEach(() => {
  mocks.showDialog.mockReset().mockResolvedValue({ action: 'secondary' });
});

describe('the leave-session confirmation', () => {
  it.each([
    ['start-screen', () => `${t('dialog.return_home_msg')}\n${t('dialog.return_home_detail')}`],
    // Browser history may lead to the landing page, another site or a blank
    // tab, so Back's body does not name a destination.
    ['history', () => t('dialog.return_home_detail')],
  ] as const)('asks [Stay | Leave] with the %s body', async (body, message) => {
    await confirmLeaveSession(body);

    expect(mocks.showDialog).toHaveBeenCalledExactlyOnceWith({
      title: t('dialog.return_home_title'),
      message: message(),
      buttonText: t('common.leave'),
      secondaryText: t('common.stay'),
      defaultFocus: 'secondary',
      tone: 'danger',
    });
  });

  it.each([
    ['ok', true],
    ['secondary', false],
    ['back', false],
    ['superseded', false],
    ['fallback', false],
  ] as const)('answers %s as leave=%s', async (action, leave) => {
    mocks.showDialog.mockResolvedValue({ action });

    await expect(confirmLeaveSession('history')).resolves.toBe(leave);
  });

  it('is the only Leave Session dialog, and every leave asks through it', () => {
    const callers = ['src/ui/connect.ts', 'src/app.ts', 'src/ui/player-controls.ts'];
    for (const path of callers) {
      expect(read(path), path).toMatch(
        /\bconfirmLeaveSession\(\s*'(?:start-screen|history)'\s*\)/u,
      );
    }
    const sources = readdirSync(resolve('src'), { recursive: true, encoding: 'utf8' })
      .map((entry) => `src/${entry.replaceAll('\\', '/')}`)
      .filter((path) => /\.m?tsx?$/u.test(path) && !path.includes('__tests__'));
    const titled = sources.filter((path) => read(path).includes("t('dialog.return_home_title')"));
    expect(titled).toEqual(['src/ui/leave-session-confirmation.ts']);
  });
});
