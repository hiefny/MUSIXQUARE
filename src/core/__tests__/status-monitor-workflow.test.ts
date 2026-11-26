import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  STATUS_BROWSER_CRON,
  STATUS_BROWSER_JOB_TIMEOUT_MINUTES,
  STATUS_BROWSER_NAVIGATION_TIMEOUT_MS,
  STATUS_BROWSER_REPORT_ATTEMPTS,
  STATUS_BROWSER_STEP_TIMEOUT_MS,
  STATUS_CHECK_INTERVAL_MINUTES,
} from '../../../cloudflare/status-contract.ts';
import { checkInlineNodeJavaScript } from '../../../scripts/check-authored-js-inventory.mts';
import {
  STATUS_MONITOR_CONNECTION_BUDGET_MS,
  STATUS_MONITOR_REPORT_RETRY_DELAY_MS,
  STATUS_MONITOR_REQUEST_TIMEOUT_MS,
} from '../../../scripts/lib/status-browser-monitor-lib.mts';

const WORKFLOW_PATH = '.github/workflows/status-monitor.yml';
const workflow = readFileSync(resolve(WORKFLOW_PATH), 'utf8').replace(/\r\n/gu, '\n');
const e2eWorkflow = readFileSync(resolve('.github/workflows/e2e.yml'), 'utf8').replace(
  /\r\n/gu,
  '\n',
);

/** The text from one top-level key to the next. */
function topLevel(source: string, key: string): string {
  const start = source.indexOf(`\n${key}:`);
  expect(start, key).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/\n[a-z][a-z_-]*:/u);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/** One job, from its key to the next job or the end. */
function job(source: string, name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/** The block of keys indented under a `key:` line at the given depth. */
function block(source: string, key: string, indent: number): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `${' '.repeat(indent)}${key}:`);
  expect(start, key).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(' '.repeat(indent + 2))) break;
    if (line.trim() && !line.trim().startsWith('#')) body.push(line.trim());
  }
  return body;
}

const probe = job(workflow, 'probe');

function stepTimeouts(source: string): Array<readonly [string, number]> {
  return [...source.matchAll(/^ {6}- name: (.+)\n {8}timeout-minutes: (\d+)$/gmu)].map(
    (match) => [match[1] ?? '', Number(match[2])] as const,
  );
}

describe('status monitor workflow', () => {
  it('runs on the browser schedule and by hand, from main only', () => {
    expect(workflow.startsWith('name: Status monitor\n')).toBe(true);
    const triggers = topLevel(workflow, 'on');
    expect(block(triggers, 'on', 0)).toEqual([
      'schedule:',
      `- cron: '${STATUS_BROWSER_CRON}'`,
      'workflow_dispatch:',
    ]);
    expect([...workflow.matchAll(/cron: '([^']+)'/gu)].map((match) => match[1])).toEqual([
      STATUS_BROWSER_CRON,
    ]);
    expect(workflow).not.toMatch(
      /\n {2}(?:push|pull_request|pull_request_target|workflow_call|workflow_run|repository_dispatch):/u,
    );
    expect([...workflow.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gmu)].map((match) => match[1])).toEqual(
      ['schedule', 'workflow_dispatch', 'probe'],
    );
    expect(probe).toContain('\n    name: Status browser checks\n');
    expect(probe).toContain("\n    if: github.ref == 'refs/heads/main'\n");
  });

  it('lets only the job mint an OIDC token, with no GitHub environment or secret', () => {
    expect(block(topLevel(workflow, 'permissions'), 'permissions', 0)).toEqual(['contents: read']);
    expect(block(probe, 'permissions', 4)).toEqual(['contents: read', 'id-token: write']);
    expect(workflow.match(/id-token/gu)).toHaveLength(1);
    // The report and claim routes require the environment claim to be absent.
    expect(workflow).not.toMatch(/^\s*environment:/mu);
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('vars.');
    // The routes match workflow_ref: the job runs its own steps, not a reusable workflow.
    expect(probe).toMatch(/\n {4}steps:\n/u);
    expect(probe).not.toMatch(/\n {4}uses:/u);
  });

  it('uses its own concurrency group, never the production release group', () => {
    expect(block(topLevel(workflow, 'concurrency'), 'concurrency', 0)).toEqual([
      'group: musixquare-status-monitor',
      'cancel-in-progress: false',
    ]);
    expect(workflow).not.toContain('musixquare-production-release');
  });

  it('installs the pinned toolchain of the production browser job, then runs the script', () => {
    expect(probe).toContain('\n      image: mcr.microsoft.com/playwright:v1.65.1-noble\n');
    expect(probe).toContain('\n      options: --user 1001 --ipc=host\n');
    expect(probe).toContain('\n      TZ: Etc/UTC\n');
    expect(probe).toContain('\n          node-version-file: .node-version\n');
    expect(probe).toContain('\n          cache: npm\n');
    expect(probe).toContain('\n        run: corepack npm ci\n');
    expect(probe).toContain('\n        run: npx playwright install chromium\n');
    expect(probe).toContain('\n        run: npx tsx scripts/status-browser-monitor.ts\n');
    expect(existsSync(resolve('scripts/status-browser-monitor.ts'))).toBe(true);

    const pins = (source: string): Map<string, string> =>
      new Map(
        [...source.matchAll(/uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # v\d+\.\d+\.\d+$/gmu)].map(
          (match) => [match[1] ?? '', match[2] ?? ''],
        ),
      );
    const used = [...probe.matchAll(/uses: (\S+)/gu)].map((match) => match[1]);
    const pinned = pins(probe);
    expect(used).toHaveLength(pinned.size);
    expect([...pinned.keys()]).toEqual(['actions/checkout', 'actions/setup-node']);
    const productionBrowserJob = pins(job(e2eWorkflow, 'production-large-room'));
    for (const [action, sha] of pinned) {
      expect(productionBrowserJob.get(action), action).toBe(sha);
    }
  });

  it('ends a run before the next is due, and leaves the script time to report', () => {
    expect(probe).toContain(`\n    timeout-minutes: ${STATUS_BROWSER_JOB_TIMEOUT_MINUTES}\n`);
    expect(STATUS_BROWSER_JOB_TIMEOUT_MINUTES).toBeLessThan(STATUS_CHECK_INTERVAL_MINUTES);
    expect(stepTimeouts(probe)).toEqual([
      ['Checkout', 3],
      ['Setup Node.js', 3],
      ['Install dependencies with pinned npm', 4],
      ['Install Chromium', 3],
      ['Run status browser checks', 4],
    ]);
    expect([...probe.matchAll(/^ {6}- name: /gmu)]).toHaveLength(5);

    // The slowest run that still reports: the status read, both mints, the
    // website check, the whole connection budget, every report attempt with
    // its pauses, and one more mint for an expiring report token.
    const runStepMs = 4 * 60_000;
    const slowestReportingRunMs =
      STATUS_MONITOR_REQUEST_TIMEOUT_MS * 3 +
      STATUS_BROWSER_NAVIGATION_TIMEOUT_MS +
      STATUS_BROWSER_STEP_TIMEOUT_MS +
      STATUS_MONITOR_CONNECTION_BUDGET_MS +
      STATUS_BROWSER_REPORT_ATTEMPTS * STATUS_MONITOR_REQUEST_TIMEOUT_MS +
      (STATUS_BROWSER_REPORT_ATTEMPTS - 1) * STATUS_MONITOR_REPORT_RETRY_DELAY_MS +
      STATUS_MONITOR_REQUEST_TIMEOUT_MS;
    // Browser start and close, and the diagnostics of a failed run, fit the rest.
    expect(runStepMs - slowestReportingRunMs).toBeGreaterThanOrEqual(30_000);

    // The live App's build is read beside the status read (readStatusPreflight),
    // so its own bound must not outlast that read's.
    const liveApp = readFileSync(resolve('scripts/live-smoke-app-build.mts'), 'utf8');
    const liveAppTimeout = /^const LIVE_APP_REQUEST_TIMEOUT_MS = ([\d_]+);$/mu.exec(liveApp);
    expect(liveAppTimeout, 'LIVE_APP_REQUEST_TIMEOUT_MS').not.toBeNull();
    expect(liveApp).toContain('signal: AbortSignal.timeout(LIVE_APP_REQUEST_TIMEOUT_MS)');
    expect(Number(liveAppTimeout?.[1]?.replaceAll('_', ''))).toBeLessThanOrEqual(
      STATUS_MONITOR_REQUEST_TIMEOUT_MS,
    );
  });

  it('runs no inline JavaScript and uploads nothing to the public run', () => {
    expect(checkInlineNodeJavaScript(WORKFLOW_PATH, workflow)).toEqual([]);
    expect(workflow).not.toMatch(/\bnode\s+(?:-e|--eval|-p|--print)\b/u);
    expect(workflow).not.toContain('upload-artifact');
    expect(workflow).not.toContain('continue-on-error');
  });
});
