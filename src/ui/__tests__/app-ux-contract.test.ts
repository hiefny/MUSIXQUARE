/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let appDocument: Document;

beforeAll(() => {
  const source = readFileSync(resolve('index.html'), 'utf8');
  appDocument = new DOMParser().parseFromString(source, 'text/html');
});

describe('app UX markup contract', () => {
  it('uses native buttons for every invite-code copy action', () => {
    const inviteActions = [...appDocument.querySelectorAll('.invite-code-container')];

    expect(inviteActions).toHaveLength(3);
    expect(inviteActions.every((element) => element.tagName === 'BUTTON')).toBe(true);
    expect(inviteActions.every((element) => element.getAttribute('type') === 'button')).toBe(true);
  });

  it('keeps one playlist add action without duplicating it in the empty state', () => {
    expect(appDocument.querySelectorAll('#btn-add-media')).toHaveLength(1);
    expect(appDocument.querySelector('#playlist-ui .list-empty-state button')).toBeNull();
  });

  it('keeps the intentional contenteditable URL field and mobile zoom lock', () => {
    const youtubeField = appDocument.getElementById('youtube-url-input');
    expect(youtubeField?.tagName).toBe('DIV');
    expect(youtubeField?.getAttribute('contenteditable')).toBe('true');

    const viewport = appDocument.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    expect(viewport?.content).toContain('maximum-scale=1');
    expect(viewport?.content).toContain('user-scalable=no');
  });
});
