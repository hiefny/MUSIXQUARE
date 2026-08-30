import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LANGUAGE_OPTIONS, localizedAboutPath, localizedAppPath } from '../src/i18n/locales.ts';
import { renderLocalizedAbout, renderLocalizedApp } from './localized-html-lib.mts';

const repoRoot = process.cwd();
const distRoot = path.join(repoRoot, 'dist');
const appHtml = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const aboutHtml = await readFile(path.join(distRoot, 'about.html'), 'utf8');
const landingI18nJavaScript = await readFile(path.join(distRoot, 'landing-i18n.js'), 'utf8');

for (const option of LANGUAGE_OPTIONS) {
  const localizedAbout = renderLocalizedAbout(aboutHtml, landingI18nJavaScript, option.code);
  const localizedApp = renderLocalizedApp(appHtml, option.code, localizedAbout.metadata);
  const outputDirectory =
    option.code === 'en' ? distRoot : path.join(distRoot, option.code.toLowerCase());
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, 'index.html'), localizedApp, 'utf8'),
    writeFile(path.join(outputDirectory, 'about.html'), localizedAbout.html, 'utf8'),
  ]);
  process.stdout.write(
    `[localized-html] ${localizedAppPath(option.code)} ${localizedAboutPath(option.code)}\n`,
  );
}
