#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ANSI_SGR_RE = /\u001b\[[0-9;]*m/gu;
const WRANGLER_NON_TTY_PROGRESS_RE =
  /^(?:\u251c (?:Checking if file needs uploading|\u{1f300} Uploading [^\u0000-\u001f\u007f]+)|\u2502(?: \u{1f300} Uploading complete\.)?)$/u;

function assertWranglerD1Envelope(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Wrangler D1 JSON must be a non-empty execution array.');
  }
  for (const execution of payload) {
    if (
      !execution ||
      typeof execution !== 'object' ||
      Array.isArray(execution) ||
      execution.success !== true ||
      !Array.isArray(execution.results)
    ) {
      throw new Error('Wrangler D1 JSON contains a failed or malformed execution.');
    }
  }
  return payload;
}

function progressPrefixIsKnown(prefix) {
  const normalized = prefix
    .replace(/^\uFEFF/u, '')
    .replace(ANSI_SGR_RE, '')
    .replace(/\r\n?/gu, '\n');
  return normalized
    .split('\n')
    .filter((line) => line.trim() !== '')
    .every((line) => WRANGLER_NON_TTY_PROGRESS_RE.test(line));
}

export function parseWranglerD1JsonOutput(source) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('Wrangler D1 produced no JSON output.');
  }
  const output = source.replace(/^\uFEFF/u, '');

  const candidateOffsets = [];
  let offset = 0;
  for (const line of output.split(/(?<=\n)/u)) {
    const content = line.replace(/\r?\n$/u, '');
    const match = /^[ \t]*(?=\[)/u.exec(content);
    if (match) candidateOffsets.push(offset + match[0].length);
    offset += line.length;
  }

  const matches = [];
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

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'Wrangler D1 output did not contain one valid JSON envelope.'
        : 'Wrangler D1 output contained multiple valid JSON envelopes.',
    );
  }
  return matches[0];
}

function usage() {
  throw new Error('Usage: node scripts/capture-wrangler-d1-json.mjs <output.json>');
}

function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !args[0]) usage();
  const payload = parseWranglerD1JsonOutput(readFileSync(0, 'utf8'));
  writeFileSync(resolve(args[0]), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
