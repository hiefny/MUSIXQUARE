import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertGenerationCutoverStatus,
  generationCutoverWorkflowOutputs,
} from '../../../scripts/pro-room-generation-cutover.mjs';
import { parseWranglerD1JsonOutput } from '../../../scripts/capture-wrangler-d1-json.mjs';

function d1(results: Array<Record<string, unknown>>, success = true) {
  return [{ success, results }];
}

const FLOOR_SHA = '1234567890abcdef1234567890abcdef12345678';

function cutoverRow(status: 'disabled' | 'ready', releaseSha: string | null = null) {
  return {
    contract_version: 1,
    status,
    release_sha: releaseSha,
    floor_release_sha: FLOOR_SHA,
    ever_enabled: 1,
    generation_floor: 1,
  };
}

describe('PRO room generation release fence', () => {
  it('captures one successful Wrangler D1 JSON envelope despite its known non-TTY prefix', () => {
    const payload = d1([cutoverRow('disabled')]);
    expect(parseWranglerD1JsonOutput(JSON.stringify(payload))).toEqual(payload);
    expect(parseWranglerD1JsonOutput(`\uFEFF${JSON.stringify(payload)}`)).toEqual(payload);
    expect(
      parseWranglerD1JsonOutput(
        `\u001b[90m\u251c\u001b[39m Checking if file needs uploading\n\u001b[90m\u2502\u001b[39m\n${JSON.stringify(payload, null, 2)}\n`,
      ),
    ).toEqual(payload);
  });

  it('fails closed on contaminated, trailing, or unsuccessful Wrangler D1 output', () => {
    const payload = d1([cutoverRow('disabled')]);
    expect(() =>
      parseWranglerD1JsonOutput(`unrecognized progress\n${JSON.stringify(payload)}`),
    ).toThrow(/did not contain one valid JSON envelope/);
    expect(() => parseWranglerD1JsonOutput(`${JSON.stringify(payload)}\ntrailing output`)).toThrow(
      /did not contain one valid JSON envelope/,
    );
    expect(() =>
      parseWranglerD1JsonOutput(JSON.stringify(d1([cutoverRow('disabled')], false))),
    ).toThrow(/did not contain one valid JSON envelope/);
  });

  it('accepts only the established immutable floor and exact ready release SHA', () => {
    expect(assertGenerationCutoverStatus(d1([cutoverRow('disabled')]), 'disabled')).toEqual({
      contractVersion: 1,
      status: 'disabled',
      releaseSha: null,
      floorReleaseSha: FLOOR_SHA,
      everEnabled: true,
      generationFloor: true,
    });
    expect(
      assertGenerationCutoverStatus(d1([cutoverRow('ready', FLOOR_SHA)]), 'ready', FLOOR_SHA),
    ).toMatchObject({ status: 'ready', releaseSha: FLOOR_SHA });
    expect(() =>
      assertGenerationCutoverStatus(
        d1([cutoverRow('ready', FLOOR_SHA)]),
        'ready',
        'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ),
    ).toThrow(/release SHA/);
    expect(() =>
      assertGenerationCutoverStatus(
        d1([{ ...cutoverRow('disabled'), ever_enabled: 0, generation_floor: 0 }]),
        'disabled',
      ),
    ).toThrow(/immutable generation-floor/);
    expect(() =>
      assertGenerationCutoverStatus(d1([cutoverRow('disabled', FLOOR_SHA)]), 'disabled'),
    ).toThrow(/must not retain/);
  });

  it('exports only a valid established release floor to the workflow', () => {
    expect(generationCutoverWorkflowOutputs(d1([cutoverRow('disabled')]))).toEqual({
      floorReleaseSha: FLOOR_SHA,
      generationFloor: true,
    });
    expect(() =>
      generationCutoverWorkflowOutputs(
        d1([{ ...cutoverRow('disabled'), floor_release_sha: 'not-a-release-sha' }]),
      ),
    ).toThrow(/immutable generation-floor/);
  });

  it('fences every full rollout, verifies floor ancestry, and restores ready only after success', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const prepareRecords = workflow.indexOf('Prepare deployment records');
    const readFloor = workflow.indexOf(
      'Read PRO room generation cutover before dependency rollout',
    );
    const verifyFloor = workflow.indexOf(
      'Verify full release honors immutable PRO generation floor',
    );
    const fence = workflow.indexOf('Fence room-code reuse during dependency rollout');
    const firstDeploy = workflow.indexOf('Deploy and record remote-share Worker');
    const finalVerification = workflow.indexOf(
      'Verify release still owns current production deployments',
    );
    const restoreReady = workflow.indexOf('Restore PRO room generation readiness');

    expect(prepareRecords).toBeGreaterThan(-1);
    expect(readFloor).toBeGreaterThan(prepareRecords);
    expect(verifyFloor).toBeGreaterThan(readFloor);
    expect(fence).toBeGreaterThan(verifyFloor);
    expect(firstDeploy).toBeGreaterThan(fence);
    expect(restoreReady).toBeGreaterThan(finalVerification);
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$floor_release_sha" "${{ github.sha }}"',
    );
    expect(workflow).toContain(
      'WHERE contract_version = 1 AND ever_enabled = 1 AND floor_release_sha IS NOT NULL',
    );
    expect(workflow).not.toContain('COALESCE(floor_release_sha');
  });

  it('retires the initial-room ceremony and keeps the failure fence before rollback', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    for (const retired of [
      'apply_pro_room_generation_d1',
      'enable_pro_room_generation_cutover',
      'DIRECTLY_VERIFIED_000002_000003',
      'verify-initial-deletion',
      'probe-public-deletion',
      'render-migration',
      'plan-migrations',
    ]) {
      expect(workflow).not.toContain(retired);
    }
    expect(workflow).not.toContain("room_code IN ('000002', '000003')");
    expect(
      workflow.indexOf('Disable PRO room generation cutover before failed-release rollback'),
    ).toBeLessThan(workflow.indexOf('Restore Worker deployments after a failed release'));
    expect(workflow).toContain(
      'steps.pro_room_generation_cutover_disable.outputs.generation_floor',
    );
    expect(workflow).toContain(
      'rollback_skip_targets="pro-room,signaling,developer-api-facade,developer-api,app"',
    );
  });

  it('captures every remaining release D1 JSON probe through the strict envelope helper', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const d1JsonExecutions = workflow.match(
      /npm run --silent wrangler -- d1 execute[\s\S]*?--remote --json[\s\S]*?(?=\n {10}npm run|\n {10}node|\n {6}- name:)/gu,
    );
    const strictCaptures = workflow.match(/\| node scripts\/capture-wrangler-d1-json\.mjs/gu);
    expect(d1JsonExecutions?.length).toBeGreaterThan(0);
    expect(strictCaptures).toHaveLength(d1JsonExecutions?.length ?? 0);
    for (const execution of d1JsonExecutions ?? []) {
      expect(execution).toContain('| node scripts/capture-wrangler-d1-json.mjs');
    }
  });

  it('preserves the immutable migration history that established the disabled singleton', () => {
    const migration = readFileSync(
      resolve('cloudflare/admin-metrics.pro-room-generation.migration.sql'),
      'utf8',
    );
    expect(migration).toMatch(
      /INSERT INTO mxqr_pro_room_generation_cutover[\s\S]*VALUES \(1, 'disabled', NULL, 0, NULL, 0\)/,
    );
  });
});
