import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTranslationSuggestions } from '../../../scripts/apply-translation-suggestions.mts';
import { loadCatalogs } from '../../../scripts/translation-catalog.ts';
import type {
  ApprovedTranslationDraft,
  ApprovedTranslationsExport,
} from '../../i18n/translation-community';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});
const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
const aboutPath = 'browser/classic-runtime/landing-i18n.ts';
const timestamp = '2026-09-08T06:00:00.000Z';
let root: string;
let input: string;
let originals: Map<string, string>;

function approved(drafts: ApprovedTranslationDraft[]): ApprovedTranslationsExport {
  return { version: 1, kind: 'musixquare-approved-translations', exportedAt: timestamp, drafts };
}

function proposal(overrides: Partial<ApprovedTranslationDraft> = {}): ApprovedTranslationDraft {
  return {
    id: 'app:greet',
    surface: 'app',
    key: 'greet',
    locale: 'fr',
    sourceEn: 'Hello {{name}}',
    sourceKo: '안녕 {{name}}',
    current: 'Bonjour {{name}}',
    proposed: 'Salut {{name}}',
    reason: 'More natural',
    updatedAt: timestamp,
    suggestionId: 'approved-1',
    reviewRevision: 2,
    approvedAt: 1_788_847_200_000,
    ...overrides,
  };
}

function aboutProposal(
  overrides: Partial<ApprovedTranslationDraft> = {},
): ApprovedTranslationDraft {
  return proposal({
    id: 'about:hero.h1',
    surface: 'about',
    key: 'hero.h1',
    sourceEn: '<b>Help</b>',
    sourceKo: '<b>도움</b>',
    current: '<b>Aide</b>',
    proposed: '<b>Assistance</b>',
    suggestionId: 'approved-2',
    ...overrides,
  });
}

async function setInput(value: unknown): Promise<void> {
  await fs.writeFile(input, JSON.stringify(value));
}

async function expectOriginals(): Promise<void> {
  for (const [file, text] of originals)
    expect(await fs.readFile(path.join(root, file), 'utf8'), file).toBe(text);
  const files = await fs.readdir(root, { recursive: true });
  expect(files.filter((file) => file.includes('.translation-'))).toEqual([]);
}

beforeEach(async () => {
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actualFs.writeFile);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'musixquare-translation-apply-'));
  input = path.join(root, 'approved.json');
  originals = new Map([
    [
      'src/i18n/locales.ts',
      `export const LANGUAGE_OPTIONS = [
      { code: 'en', nativeName: 'English', htmlLang: 'en' },
      { code: 'ko', nativeName: '한국어', htmlLang: 'ko' },
      { code: 'fr', nativeName: 'Français', htmlLang: 'fr' },
      { code: 'ja', nativeName: '日本語', htmlLang: 'ja' },
    ];`,
    ],
    [
      'src/i18n/en.ts',
      `const en = { greet: 'Hello {{name}}', plain: 'Plain' }; export default en;`,
    ],
    ['src/i18n/ko.ts', `const ko = { greet: '안녕 {{name}}', plain: '문구' }; export default ko;`],
    [
      'src/i18n/fr.ts',
      `// Preserve this comment and all unrelated code.\r\nimport en from './en.ts';\r\nconst fr = { ...en, greet: 'Bonjour {{name}}', plain: 'Simple' };\r\nexport default fr;\r\nthrow new Error('This source must never execute');\r\n`,
    ],
    ['src/i18n/ja.ts', `export default { greet: 'こんにちは {{name}}', plain: '文言' };`],
    [
      aboutPath,
      `(function () {
      const baseDictionaries = {
        en: { 'hero.h1': '<b>Help</b>' }, ko: { 'hero.h1': '<b>도움</b>' },
        ja: { 'hero.h1': '<b>ヘルプ</b>' },
      };
      const i18n = baseDictionaries;
      function addLang(code, dict) { i18n[code] = dict; }
      addLang('fr', { 'hero.h1': '<b>Aide</b>' });
      throw new Error('This browser script must never execute');
    })();`,
    ],
  ]);
  for (const [file, text] of originals) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
});

afterEach(async () => {
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actualFs.writeFile);
  if (
    path.dirname(root) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith('musixquare-translation-apply-')
  ) {
    throw new Error('Refusing to clean an unexpected fixture directory.');
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe('approved translation application', () => {
  it('defaults to a dry run and reads catalogs as data without executing source', async () => {
    await setInput(approved([proposal(), aboutProposal()]));
    await expect(applyTranslationSuggestions(root, input)).resolves.toEqual({
      mode: 'dry-run',
      suggestions: 2,
      files: [
        { path: 'src/i18n/fr.ts', changes: 1 },
        { path: aboutPath, changes: 1 },
      ],
    });
    await expectOriginals();
  });

  it('writes only selected literal ranges, preserving references, comments, CRLF and unrelated code', async () => {
    await setInput(approved([proposal(), aboutProposal()]));
    await expect(applyTranslationSuggestions(root, input, true)).resolves.toMatchObject({
      mode: 'write',
      suggestions: 2,
    });
    for (const [file, text] of originals) {
      const expected =
        file === 'src/i18n/fr.ts'
          ? text.replace("'Bonjour {{name}}'", "'Salut {{name}}'")
          : file === aboutPath
            ? text.replace("'<b>Aide</b>'", "'<b>Assistance</b>'")
            : text;
      expect(await fs.readFile(path.join(root, file), 'utf8'), file).toBe(expected);
    }
    const catalogs = await loadCatalogs(root);
    expect(catalogs.get('fr')?.entries.find((entry) => entry.id === 'app:greet')?.current).toBe(
      'Salut {{name}}',
    );
    expect(
      (await fs.readdir(root, { recursive: true })).filter((file) =>
        file.includes('.translation-'),
      ),
    ).toEqual([]);
  });

  it('supports direct app exports and base About dictionaries without touching EN/KO', async () => {
    await setInput(
      approved([
        proposal({ locale: 'ja', current: 'こんにちは {{name}}', proposed: 'やあ {{name}}' }),
        aboutProposal({ locale: 'ja', current: '<b>ヘルプ</b>', proposed: '<b>使い方</b>' }),
      ]),
    );
    await applyTranslationSuggestions(root, input, true);
    const catalogs = await loadCatalogs(root);
    expect(catalogs.get('ja')?.entries.map((entry) => entry.current)).toEqual([
      'やあ {{name}}',
      '文言',
      '<b>使い方</b>',
    ]);
    for (const file of ['src/i18n/en.ts', 'src/i18n/ko.ts'])
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(originals.get(file));
  });

  it.each([
    {
      locale: 'en',
      current: 'Hello {{name}}',
      proposed: 'Welcome {{name}}',
      aboutCurrent: '<b>Help</b>',
      aboutProposed: '<b>Get started</b>',
    },
    {
      locale: 'ko',
      current: '안녕 {{name}}',
      proposed: '반가워요 {{name}}',
      aboutCurrent: '<b>도움</b>',
      aboutProposed: '<b>시작하기</b>',
    },
  ])(
    'applies approved $locale wording to app and About while retaining other languages',
    async (target) => {
      await setInput(
        approved([
          proposal({ locale: target.locale, current: target.current, proposed: target.proposed }),
          aboutProposal({
            locale: target.locale,
            current: target.aboutCurrent,
            proposed: target.aboutProposed,
          }),
        ]),
      );
      await applyTranslationSuggestions(root, input);
      await expectOriginals();
      await applyTranslationSuggestions(root, input, true);
      for (const [file, text] of originals) {
        const expected =
          file === `src/i18n/${target.locale}.ts`
            ? text.replace(`'${target.current}'`, `'${target.proposed}'`)
            : file === aboutPath
              ? text.replace(`'${target.aboutCurrent}'`, `'${target.aboutProposed}'`)
              : text;
        expect(await fs.readFile(path.join(root, file), 'utf8'), file).toBe(expected);
      }
      const catalogs = await loadCatalogs(root);
      expect(
        catalogs.get(target.locale)?.entries.find(({ id }) => id === 'app:greet')?.current,
      ).toBe(target.proposed);
      expect(
        catalogs.get(target.locale)?.entries.find(({ id }) => id === 'about:hero.h1')?.current,
      ).toBe(target.aboutProposed);
      const sourceEn = target.locale === 'en' ? target.proposed : 'Hello {{name}}';
      for (const catalog of catalogs.values())
        expect(catalog.entries.find(({ id }) => id === 'app:greet')?.sourceEn).toBe(sourceEn);
    },
  );

  it('validates one shared baseline before applying the same app and About keys in EN, KO and French', async () => {
    const english = proposal({
      locale: 'en',
      current: 'Hello {{name}}',
      proposed: 'Welcome {{name}}',
      suggestionId: 'approved-en-app',
    });
    const korean = proposal({
      locale: 'ko',
      current: '안녕 {{name}}',
      proposed: '반가워요 {{name}}',
      suggestionId: 'approved-ko-app',
    });
    const englishAbout = aboutProposal({
      locale: 'en',
      current: '<b>Help</b>',
      proposed: '<b>Get started</b>',
      suggestionId: 'approved-en-about',
    });
    const koreanAbout = aboutProposal({
      locale: 'ko',
      current: '<b>도움</b>',
      proposed: '<b>시작하기</b>',
      suggestionId: 'approved-ko-about',
    });
    const drafts = [english, korean, proposal(), englishAbout, koreanAbout, aboutProposal()];
    await setInput(approved(drafts));
    await expect(applyTranslationSuggestions(root, input, true)).resolves.toEqual({
      mode: 'write',
      suggestions: 6,
      files: [
        { path: 'src/i18n/en.ts', changes: 1 },
        { path: 'src/i18n/ko.ts', changes: 1 },
        { path: 'src/i18n/fr.ts', changes: 1 },
        { path: aboutPath, changes: 3 },
      ],
    });
    const catalogs = await loadCatalogs(root);
    for (const draft of drafts)
      expect(catalogs.get(draft.locale)?.entries.find(({ id }) => id === draft.id)?.current).toBe(
        draft.proposed,
      );
    for (const catalog of catalogs.values()) {
      expect(catalog.entries.find(({ id }) => id === 'app:greet')).toMatchObject({
        sourceEn: english.proposed,
        sourceKo: korean.proposed,
      });
      expect(catalog.entries.find(({ id }) => id === 'about:hero.h1')).toMatchObject({
        sourceEn: englishAbout.proposed,
        sourceKo: koreanAbout.proposed,
      });
    }
    for (const file of ['src/i18n/locales.ts', 'src/i18n/ja.ts'])
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(originals.get(file));
  });

  it('applies multiple different-length literals in one file without shifting later edit ranges', async () => {
    await setInput(
      approved([
        proposal({ proposed: 'Bonjour et bienvenue {{name}}' }),
        proposal({
          id: 'app:plain',
          key: 'plain',
          sourceEn: 'Plain',
          sourceKo: '문구',
          current: 'Simple',
          proposed: 'Texte',
          suggestionId: 'approved-plain',
        }),
        aboutProposal(),
        aboutProposal({
          locale: 'ja',
          current: '<b>ヘルプ</b>',
          proposed: '<b>使い方</b>',
          suggestionId: 'approved-ja-about',
        }),
      ]),
    );
    await expect(applyTranslationSuggestions(root, input, true)).resolves.toMatchObject({
      files: [
        { path: 'src/i18n/fr.ts', changes: 2 },
        { path: aboutPath, changes: 2 },
      ],
    });
    const catalogs = await loadCatalogs(root);
    expect(catalogs.get('fr')?.entries.map((entry) => entry.current)).toEqual([
      'Bonjour et bienvenue {{name}}',
      'Texte',
      '<b>Assistance</b>',
    ]);
    expect(catalogs.get('ja')?.entries.find((entry) => entry.surface === 'about')?.current).toBe(
      '<b>使い方</b>',
    );
  });

  it('escapes executable-looking text, controls and lone surrogates into a single inert literal', async () => {
    const proposed =
      "L'été {{name}} \\ '); globalThis.compromised = true; // ` ${process.exit()}\n\t\u2028\ud800";
    await setInput(approved([proposal({ proposed })]));
    await applyTranslationSuggestions(root, input, true);
    const catalogs = await loadCatalogs(root);
    expect(catalogs.get('fr')?.entries[0]?.current).toBe(proposed);
    const source = await fs.readFile(path.join(root, 'src/i18n/fr.ts'), 'utf8');
    expect(source).toContain('\\ud800');
    expect(source).toContain("plain: 'Simple' };\r\nexport default fr;");
    expect(globalThis).not.toHaveProperty('compromised');
  });

  it.each(['sourceEn', 'sourceKo', 'current'] as const)(
    'rejects a stale %s baseline before writing any otherwise valid entry',
    async (field) => {
      await setInput(approved([proposal(), aboutProposal({ [field]: 'Outdated reference' })]));
      await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
        'Stale translation baseline',
      );
      await expectOriginals();
    },
  );

  it.each([
    proposal({ proposed: 'Salut' }),
    proposal({ proposed: 'Salut {{name}} {{name}}' }),
    aboutProposal({ proposed: '<b onclick="bad()">Assistance</b>' }),
    aboutProposal({ proposed: '<b>Assistance</b><script>bad()</script>' }),
  ])('validates against canonical placeholder and HTML contracts', async (invalid) => {
    await setInput(approved([invalid]));
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'Invalid proposal',
    );
    await expectOriginals();
  });

  it.each([
    proposal({ locale: '../en' }),
    proposal({ locale: 'EN' }),
    proposal({ locale: 'ko/../fr' }),
    proposal({ id: 'app:plain' }),
    proposal({ reviewRevision: 0 }),
    proposal({ approvedAt: -1 }),
  ])('rejects malformed target or review metadata without mutations', async (invalid) => {
    await setInput(approved([invalid]));
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'Invalid approved translation fields',
    );
    await expectOriginals();
  });

  it('rejects nonexistent keys and language files outside the supported catalog', async () => {
    await setInput(approved([proposal({ id: 'app:unknown', key: 'unknown' })]));
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'Unsupported translation',
    );
    await fs.writeFile(
      path.join(root, 'src/i18n/xx.ts'),
      "export default { greet: 'Hello', plain: 'Plain' };",
    );
    await setInput(approved([proposal({ locale: 'xx' })]));
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'Unsupported translation',
    );
    await expectOriginals();
  });

  it('rejects redirected source directories instead of following a writable alias', async () => {
    const originalDirectory = path.join(root, 'src/i18n');
    const redirectedDirectory = path.join(root, 'redirected-i18n');
    await fs.rename(originalDirectory, redirectedDirectory);
    await fs.symlink(redirectedDirectory, originalDirectory, 'junction');
    await setInput(approved([proposal()]));
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'regular path inside the repository',
    );
    expect(await fs.readFile(path.join(redirectedDirectory, 'fr.ts'), 'utf8')).toBe(
      originals.get('src/i18n/fr.ts'),
    );
    await fs.unlink(originalDirectory);
    await fs.rename(redirectedDirectory, originalDirectory);
    await expectOriginals();
  });

  it('rejects duplicate revisions and multiple approved suggestions for the same target', async () => {
    for (const second of [
      proposal({ reviewRevision: 3 }),
      proposal({ suggestionId: 'another-approved-id' }),
    ]) {
      await setInput(approved([proposal(), second]));
      await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
        'Duplicate suggestion/revision',
      );
    }
    await expectOriginals();
  });

  it('requires exact known schemas rather than accepting local-draft or decorated exports', async () => {
    for (const value of [
      { version: 1, exportedAt: timestamp, drafts: [proposal()] },
      { ...approved([proposal()]), extra: true },
      approved([{ ...proposal(), approved: true } as ApprovedTranslationDraft]),
      { ...approved([proposal()]), exportedAt: '2026-02-31T00:00:00.000Z' },
    ]) {
      await setInput(value);
      await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow();
    }
    await expectOriginals();
  });

  it('rejects invalid UTF-8, oversized JSON and duplicate JSON field names before touching sources', async () => {
    for (const bytes of [
      Buffer.from([0xc3, 0x28]),
      Buffer.alloc(8 * 1024 * 1024 + 1, 32),
      Buffer.from(
        JSON.stringify(approved([proposal()])).replace('"version":1', '"version":2,"version":1'),
      ),
    ]) {
      await fs.writeFile(input, bytes);
      await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow();
      await expectOriginals();
    }
  });

  it('refuses inherited or concatenated values instead of expanding the edit beyond one literal', async () => {
    const file = path.join(root, 'src/i18n/fr.ts');
    await fs.writeFile(
      file,
      originals.get('src/i18n/fr.ts')!.replace("'Bonjour {{name}}'", "'Bon' + 'jour {{name}}'"),
    );
    await setInput(approved([proposal()]));
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'one explicit string literal',
    );
    const inherited = originals.get('src/i18n/fr.ts')!.replace("greet: 'Bonjour {{name}}', ", '');
    await fs.writeFile(file, inherited);
    await setInput(approved([proposal({ current: 'Hello {{name}}' })]));
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'one explicit dictionary key',
    );
    expect(await fs.readFile(file, 'utf8')).toBe(inherited);
  });

  it('rejects replay after a successful application rather than treating approval metadata as freshness', async () => {
    await setInput(approved([proposal()]));
    await applyTranslationSuggestions(root, input, true);
    const applied = await fs.readFile(path.join(root, 'src/i18n/fr.ts'), 'utf8');
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'Stale translation baseline',
    );
    expect(await fs.readFile(path.join(root, 'src/i18n/fr.ts'), 'utf8')).toBe(applied);
  });

  it('detects a reference edit during staging before committing any target', async () => {
    await setInput(approved([proposal(), aboutProposal()]));
    const korean = path.join(root, 'src/i18n/ko.ts');
    let changed = false;
    vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
      await actualFs.writeFile(...args);
      if (!changed && typeof args[0] === 'object' && 'fd' in args[0]) {
        changed = true;
        await actualFs.writeFile(
          korean,
          originals.get('src/i18n/ko.ts')!.replace('안녕', '안녕하세요'),
        );
      }
    });
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'Source changed during review',
    );
    expect(fs.rename).not.toHaveBeenCalled();
    originals.set('src/i18n/ko.ts', await fs.readFile(korean, 'utf8'));
    await expectOriginals();
  });

  it('restores an already committed source if a later file rename fails', async () => {
    await setInput(approved([proposal(), aboutProposal()]));
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith('.tmp') && String(to).endsWith('landing-i18n.ts'))
        throw new Error('Injected rename failure');
      return actualFs.rename(from, to);
    });
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'Injected rename failure',
    );
    await expectOriginals();
  });

  it('retains the original backup instead of overwriting a concurrent edit during rollback', async () => {
    await setInput(approved([proposal(), aboutProposal()]));
    const french = path.join(root, 'src/i18n/fr.ts');
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith('.tmp') && String(to).endsWith('landing-i18n.ts')) {
        await actualFs.writeFile(french, '// A concurrent user edit.');
        throw new Error('Injected rename failure');
      }
      return actualFs.rename(from, to);
    });
    await expect(applyTranslationSuggestions(root, input, true)).rejects.toThrow(
      'original backup requires manual recovery',
    );
    expect(await fs.readFile(french, 'utf8')).toBe('// A concurrent user edit.');
    const backups = (await fs.readdir(path.dirname(french))).filter((file) =>
      file.endsWith('.bak'),
    );
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(french), backups[0]!), 'utf8')).toBe(
      originals.get('src/i18n/fr.ts'),
    );
    expect(await fs.readFile(path.join(root, aboutPath), 'utf8')).toBe(originals.get(aboutPath));
  });
});
