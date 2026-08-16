#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ANSI_SGR_RE = /\u001b\[[0-9;]*m/gu;
const WRANGLER_NON_TTY_PROGRESS_RE =
  /^(?:\u251c (?:Checking if file needs uploading|\u{1f300} Uploading [^\u0000-\u001f\u007f]+)|\u2502(?: \u{1f300} Uploading complete\.)?)$/u;

export interface WranglerD1Execution {
  success: true;
  results: unknown[];
  [key: string]: unknown;
}

function isWranglerD1Execution(value: unknown): value is WranglerD1Execution {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'success' in value &&
    value.success === true &&
    'results' in value &&
    Array.isArray(value.results)
  );
}

function assertWranglerD1Envelope(payload: unknown): WranglerD1Execution[] {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Wrangler D1 JSON must be a non-empty execution array.');
  }
  if (!payload.every(isWranglerD1Execution)) {
    throw new Error('Wrangler D1 JSON contains a failed or malformed execution.');
  }
  return payload;
}

function progressPrefixIsKnown(prefix: string): boolean {
  const normalized = prefix
    .replace(/^\uFEFF/u, '')
    .replace(ANSI_SGR_RE, '')
    .replace(/\r\n?/gu, '\n');
  return normalized
    .split('\n')
    .filter((line) => line.trim() !== '')
    .every((line) => WRANGLER_NON_TTY_PROGRESS_RE.test(line));
}

export function parseWranglerD1JsonOutput(source: string): WranglerD1Execution[] {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('Wrangler D1 produced no JSON output.');
  }
  const output = source.replace(/^\uFEFF/u, '');

  const candidateOffsets: number[] = [];
  let offset = 0;
  for (const line of output.split(/(?<=\n)/u)) {
    const content = line.replace(/\r?\n$/u, '');
    const match = /^[ \t]*(?=\[)/u.exec(content);
    if (match) candidateOffsets.push(offset + match[0].length);
    offset += line.length;
  }

  const matches: WranglerD1Execution[][] = [];
  for (const candidateOffset of candidateOffsets) {
    const prefix = output.slice(0, candidateOffset);
    if (!progressPrefixIsKnown(prefix)) continue;
    const jsonSource = output.slice(candidateOffset).trim();
    try {
      matches.push(assertWranglerD1Envelope(JSON.parse(jsonSource)));
    } catch {
      // Keep looking only for another line-delimited JSON envelope. A malformed
      // or contaminated candidate is never repaired or partially accepted.
    }
  }

  const [match] = matches;
  if (matches.length !== 1 || match === undefined) {
    throw new Error(
      matches.length === 0
        ? 'Wrangler D1 output did not contain one valid JSON envelope.'
        : 'Wrangler D1 output contained multiple valid JSON envelopes.',
    );
  }
  return match;
}

function usage(): never {
  throw new Error('Usage: node scripts/capture-wrangler-d1-json.mts <output.json>');
}

function main(args: string[] = process.argv.slice(2)): void {
  const outputPath = args[0];
  if (args.length !== 1 || !outputPath) usage();
  const payload = parseWranglerD1JsonOutput(readFileSync(0, 'utf8'));
  writeFileSync(resolve(outputPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Cannot capture Wrangler D1 JSON: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
