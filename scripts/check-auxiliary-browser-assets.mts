#!/usr/bin/env node

import path from 'node:path';

import {
  AUXILIARY_BROWSER_ASSETS,
  compileAuxiliaryBrowserAssets,
} from './auxiliary-browser-assets.ts';

const repository = path.resolve(import.meta.dirname, '..');
await compileAuxiliaryBrowserAssets(repository);
console.log(
  `[auxiliary-browser] OK: ${AUXILIARY_BROWSER_ASSETS.length} strict TypeScript sources own their stable browser URLs.`,
);
