import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner decision (2026-10-27, UI audit item 6, option A): a hover hint shows
 * only what a control's shape cannot say, which is why it cannot be used right
 * now or the mode a press starts. Names stay in aria-label and visible text
 * needs no hint. src/ui/control-hint.ts owns every control hint and writes it
 * when the control's state changes, never on hover, so an unavailable
 * control's reason is already its accessible description for keyboard and
 * screen reader users.
 *
 * The only other title writes name or complete content, not controls. Each is
 * counted exactly, so a new one needs a reason here.
 */
const HELPER = 'src/ui/control-hint.ts';

const CONTENT_TITLES: ReadonlyArray<{ file: string; count: number; reason: string }> = [
  {
    file: 'src/ui/toast.ts',
    count: 1,
    reason: 'the full text of a toast message cut to fit',
  },
  {
    file: 'src/ui/player-controls.ts',
    count: 2,
    reason: 'the full metadata line under the track title, which can be cut',
  },
  {
    file: 'src/youtube/iframe.ts',
    count: 2,
    reason: 'the YouTube frame’s name and its key for language changes',
  },
  {
    file: 'src/ui/screensaver.ts',
    count: 2,
    reason: 'the screensaver frame’s name, set again when the language changes',
  },
  {
    file: 'src/i18n/index.ts',
    count: 1,
    reason: 'translation of data-i18n-title, which only the YouTube frame name uses',
  },
];

const TITLE_WRITES: readonly RegExp[] = [
  // element.title = …, but not document.title or comparisons.
  /(?<!\bdocument)\.title\s*=(?!=)/gu,
  /\[\s*['"`]title['"`]\s*\]\s*=(?!=)/gu,
  /\b(?:set|remove|toggle)Attribute(?:NS)?\(\s*(?:null\s*,\s*)?['"`]title['"`]/gu,
  // title="…" in markup built from strings.
  /(?<![\w.$-])title=(?!=)/gu,
  /data-i18n-title|\bi18nTitle\b/gu,
];

function appSources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => /\.(?:ts|tsx|mts)$/u.test(file))
    .filter((file) => !/(?:^|\/)__tests__\//u.test(file))
    .filter((file) => existsSync(file) && statSync(file).isFile());
}

// Comments may describe title writes; blank them but keep line numbers.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gmu, '$1');
}

function titleWrites(source: string): string[] {
  const code = stripComments(source);
  return TITLE_WRITES.flatMap((pattern) =>
    [...code.matchAll(pattern)].map((match) => {
      const line = code.slice(0, match.index).split('\n').length;
      return `${line}: ${code.split('\n')[line - 1]?.trim()}`;
    }),
  );
}

describe('hover hint policy', () => {
  it('finds title writes in every form it forbids', () => {
    const samples = [
      'button.title = label;',
      "button['title'] = label;",
      "button.setAttribute('title', label);",
      'button.removeAttribute("title");',
      "button.toggleAttribute('title', true);",
      'html = `<button title="${label}">`;',
      "button.setAttribute('data-i18n-title', key);",
      'button.dataset.i18nTitle = key;',
    ];
    for (const sample of samples) expect(titleWrites(sample), sample).not.toEqual([]);

    const allowed = [
      'document.title = staticTitle(track);',
      'if (item.title === nextTitle) return;',
      "const title = t('chat.title');",
      'return { title: item.title };',
      "dialog.setAttribute('aria-label', title);",
      '// button.title = label;',
    ];
    for (const sample of allowed) expect(titleWrites(sample), sample).toEqual([]);
  });

  it('writes control hints only through the hint helper', () => {
    const counts = new Map<string, string[]>();
    for (const file of appSources()) {
      if (file === HELPER) continue;
      const writes = titleWrites(readFileSync(file, 'utf8'));
      if (writes.length) counts.set(file, writes);
    }

    const unexpected = [...counts].filter(
      ([file]) => !CONTENT_TITLES.some((entry) => entry.file === file),
    );
    expect(unexpected).toEqual([]);
    for (const { file, count } of CONTENT_TITLES) {
      expect(counts.get(file)?.length ?? 0, `${file}: ${counts.get(file)?.join(' | ')}`).toBe(
        count,
      );
    }
  });

  it('keeps tooltips out of the app markup', () => {
    const markup = readFileSync('index.html', 'utf8').replace(/<!--[\s\S]*?-->/gu, '');
    expect([...markup.matchAll(/\stitle\s*=/gu)]).toEqual([]);
    expect(markup).not.toContain('data-i18n-title');
  });

  it('writes the hint when state changes, never from a pointer event', () => {
    const helper = stripComments(readFileSync(path.resolve(HELPER), 'utf8'));
    expect(helper).not.toMatch(/addEventListener|\bon(?:pointer|mouse)\w*\s*=|:hover|matches\(/u);
    expect(helper).toMatch(/export function setControlUnavailable\(/u);
    expect(helper).toMatch(/export function setControlHint\(/u);
  });
});
