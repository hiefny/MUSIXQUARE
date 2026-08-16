#!/usr/bin/env node

import path from 'node:path';

import { materializeFileUrlAuxiliaryAssets } from './auxiliary-browser-assets.ts';

const repository = path.resolve(import.meta.dirname, '..');
const outputs = await materializeFileUrlAuxiliaryAssets(repository);
console.log(`[auxiliary-browser] Materialized ${outputs.join(', ')} for direct file:// execution.`);
