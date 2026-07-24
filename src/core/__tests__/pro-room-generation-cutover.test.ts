import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertGenerationCutoverStatus,
  assertGenerationSchemaVerification,
  assertInitialDeletionEvidence,
  generationCutoverWorkflowOutputs,
  generationMigrationState,
  probePublicDeletionEvidence,
  renderForwardCompletionSql,
} from '../../../scripts/pro-room-generation-cutover.mjs';
import { parseWranglerD1JsonOutput } from '../../../scripts/capture-wrangler-d1-json.mjs';

function d1(results: Array<Record<string, unknown>>, success = true) {
  return [{ success, results }];
}

function initialDeletionEvidence() {
  const observedAt = 10_000_000;
  const admin = d1(
    ['000002', '000003'].map((roomCode) => ({
      room_code: roomCode,
      registry_status: 'decommissioned',
      registry_generation: 0,
      registry_updated_at: 9_500_000,
      history_count: 1,
      history_decommissioned_at: 5_000_000,
      allocation_count: 1,
      other_allocation_count: 0,
      authorized_delete_audit_count: 1,
      authorized_delete_audit_latest_at: 4_800_000,
      observed_at: observedAt,
    })),
  );
  const developer = d1(
    ['000002', '000003'].map((roomCode) => ({
      room_code: roomCode,
      legacy_tombstone_count: 1,
      legacy_request_id: `delete-${roomCode}`,
      legacy_decommissioned_at: 4_900_000,
      generation_tombstone_count: 1,
      generation_request_id: `delete-${roomCode}`,
      generation_decommissioned_at: 4_900_000,
      other_generation_tombstone_count: 0,
      key_count: 0,
      api_audit_count: 0,
      admin_audit_count: 0,
    })),
  );
  const publicEvidence = {
    checkedAt: observedAt,
    rooms: ['000002', '000003'].map((roomCode) => ({
      roomCode,
      status: 404,
      error: 'ROOM_NOT_FOUND',
    })),
  };
  return { admin, developer, publicEvidence };
}

describe('PRO room generation release cutover', () => {
  it('captures one successful Wrangler D1 JSON envelope despite its known non-TTY prefix', () => {
    const payload = d1([{ features_present: 20, features_expected: 20 }]);
    expect(parseWranglerD1JsonOutput(JSON.stringify(payload))).toEqual(payload);
    expect(parseWranglerD1JsonOutput(`\uFEFF${JSON.stringify(payload)}`)).toEqual(payload);
    expect(
      parseWranglerD1JsonOutput(
        `\u001b[90m\u251c\u001b[39m Checking if file needs uploading\n\u001b[90m\u2502\u001b[39m\n${JSON.stringify(payload, null, 2)}\n`,
      ),
    ).toEqual(payload);
    expect(
      parseWranglerD1JsonOutput(
        `\u251c Checking if file needs uploading\n\u2502\n\u251c \u{1f300} Uploading release-probe.sql\n\u2502 \u{1f300} Uploading complete.\n\u2502\n${JSON.stringify(payload, null, 2)}\n`,
      ),
    ).toEqual(payload);
  });

  it('fails closed on contaminated, trailing, or unsuccessful Wrangler D1 output', () => {
    const payload = d1([{ schema_ready: 1 }]);
    expect(() =>
      parseWranglerD1JsonOutput(`unrecognized progress\n${JSON.stringify(payload)}`),
    ).toThrow(/did not contain one valid JSON envelope/);
    expect(() => parseWranglerD1JsonOutput(`${JSON.stringify(payload)}\ntrailing output`)).toThrow(
      /did not contain one valid JSON envelope/,
    );
    expect(() =>
      parseWranglerD1JsonOutput(JSON.stringify(d1([{ schema_ready: 1 }], false))),
    ).toThrow(/did not contain one valid JSON envelope/);
    expect(() => parseWranglerD1JsonOutput('{"error":"query failed"}')).toThrow(
      /did not contain one valid JSON envelope/,
    );
  });

  it('classifies only untouched and fully applied migrations', () => {
    expect(
      generationMigrationState('admin', d1([{ features_present: 0, features_expected: 20 }])),
    ).toBe('legacy');
    expect(
      generationMigrationState('admin', d1([{ features_present: 20, features_expected: 20 }])),
    ).toBe('ready');
    expect(
      generationMigrationState('admin', d1([{ features_present: 10, features_expected: 20 }])),
    ).toBe('partial');
  });

  it('renders a forward-completion migration without repeating existing ALTER columns', () => {
    const source = readFileSync(
      resolve('cloudflare/admin-metrics.pro-room-generation.migration.sql'),
      'utf8',
    );
    const rendered = renderForwardCompletionSql(
      'admin',
      d1([
        {
          features_present: 3,
          features_expected: 20,
          registry_generation_column: 1,
          audit_generation_column: 0,
        },
      ]),
      source,
    );
    expect(rendered).not.toMatch(/ALTER TABLE mxqr_pro_room_registry\s+ADD COLUMN room_generation/);
    expect(rendered).toMatch(/ALTER TABLE mxqr_pro_room_admin_audit\s+ADD COLUMN room_generation/);
    expect(rendered).toContain('CREATE TABLE IF NOT EXISTS mxqr_pro_room_generation_history');
    expect(rendered).toContain('INSERT OR IGNORE INTO mxqr_pro_room_generation_cutover');
  });

  it('fails closed on malformed or unsuccessful schema verification', () => {
    expect(assertGenerationSchemaVerification('admin', d1([{ schema_ready: 1 }]))).toEqual({
      label: 'admin',
      schemaReady: true,
    });
    expect(() => assertGenerationSchemaVerification('admin', d1([{ schema_ready: 0 }]))).toThrow(
      /not ready/,
    );
    expect(() =>
      assertGenerationSchemaVerification('admin', d1([{ schema_ready: 1 }], false)),
    ).toThrow(/failed or malformed/);
  });

  it('requires an exact release SHA before accepting ready', () => {
    const releaseSha = '1234567890abcdef1234567890abcdef12345678';
    expect(
      assertGenerationCutoverStatus(
        d1([
          {
            contract_version: 1,
            status: 'ready',
            release_sha: releaseSha,
            floor_release_sha: releaseSha,
            ever_enabled: 1,
            generation_floor: 1,
          },
        ]),
        'ready',
        releaseSha,
      ),
    ).toEqual({
      contractVersion: 1,
      status: 'ready',
      releaseSha,
      floorReleaseSha: releaseSha,
      everEnabled: true,
      generationFloor: true,
    });
    expect(() =>
      assertGenerationCutoverStatus(
        d1([
          {
            contract_version: 1,
            status: 'ready',
            release_sha: releaseSha,
            floor_release_sha: releaseSha,
            ever_enabled: 1,
            generation_floor: 1,
          },
        ]),
        'ready',
        'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ),
    ).toThrow(/release SHA/);
    expect(() =>
      assertGenerationCutoverStatus(
        d1([
          {
            contract_version: 1,
            status: 'disabled',
            release_sha: releaseSha,
            floor_release_sha: releaseSha,
            ever_enabled: 1,
            generation_floor: 1,
          },
        ]),
        'disabled',
      ),
    ).toThrow(/must not retain/);
    expect(() =>
      assertGenerationCutoverStatus(
        d1([
          {
            contract_version: 1,
            status: 'disabled',
            release_sha: null,
            floor_release_sha: null,
            ever_enabled: 0,
            generation_floor: 1,
          },
        ]),
        'disabled',
      ),
    ).toThrow(/irreversible floor/);
  });

  it('exports the immutable release floor and rejects malformed workflow evidence', () => {
    const floorReleaseSha = '1234567890abcdef1234567890abcdef12345678';
    expect(
      generationCutoverWorkflowOutputs(
        d1([
          {
            status: 'disabled',
            floor_release_sha: floorReleaseSha,
            ever_enabled: 1,
            generation_floor: 1,
          },
        ]),
      ),
    ).toEqual({
      wasReady: false,
      everEnabled: true,
      generationFloor: true,
      floorReleaseSha,
    });
    expect(() =>
      generationCutoverWorkflowOutputs(
        d1([
          {
            status: 'disabled',
            floor_release_sha: 'not-a-release-sha',
            ever_enabled: 1,
            generation_floor: 1,
          },
        ]),
      ),
    ).toThrow(/invalid rollback floor/);
    expect(() =>
      generationCutoverWorkflowOutputs(
        d1([
          {
            status: 'disabled',
            floor_release_sha: floorReleaseSha,
            ever_enabled: 0,
            generation_floor: 0,
          },
        ]),
      ),
    ).toThrow(/invalid rollback floor/);
  });

  it('requires complete immutable and public evidence before the first cutover', () => {
    const evidence = initialDeletionEvidence();
    expect(
      assertInitialDeletionEvidence(evidence.admin, evidence.developer, evidence.publicEvidence),
    ).toEqual({
      ok: true,
      roomCodes: ['000002', '000003'],
      minimumCompletionAgeMs: 4_200_000,
    });

    const tooRecent = initialDeletionEvidence();
    (tooRecent.admin[0].results[0] as Record<string, unknown>).history_decommissioned_at =
      9_000_000;
    expect(() =>
      assertInitialDeletionEvidence(tooRecent.admin, tooRecent.developer, tooRecent.publicEvidence),
    ).toThrow(/Admin deletion evidence is incomplete/);

    const futureRegistry = initialDeletionEvidence();
    (futureRegistry.admin[0].results[0] as Record<string, unknown>).registry_updated_at =
      10_000_001;
    expect(() =>
      assertInitialDeletionEvidence(
        futureRegistry.admin,
        futureRegistry.developer,
        futureRegistry.publicEvidence,
      ),
    ).toThrow(/Admin deletion evidence is incomplete/);

    const staleRegistry = initialDeletionEvidence();
    (staleRegistry.admin[0].results[0] as Record<string, unknown>).registry_updated_at = 4_999_999;
    expect(() =>
      assertInitialDeletionEvidence(
        staleRegistry.admin,
        staleRegistry.developer,
        staleRegistry.publicEvidence,
      ),
    ).toThrow(/Admin deletion evidence is incomplete/);

    const missingAuthorization = initialDeletionEvidence();
    (
      missingAuthorization.admin[0].results[1] as Record<string, unknown>
    ).authorized_delete_audit_count = 0;
    expect(() =>
      assertInitialDeletionEvidence(
        missingAuthorization.admin,
        missingAuthorization.developer,
        missingAuthorization.publicEvidence,
      ),
    ).toThrow(/Admin deletion evidence is incomplete/);

    const lateAuthorization = initialDeletionEvidence();
    (
      lateAuthorization.admin[0].results[1] as Record<string, unknown>
    ).authorized_delete_audit_latest_at = 5_000_001;
    expect(() =>
      assertInitialDeletionEvidence(
        lateAuthorization.admin,
        lateAuthorization.developer,
        lateAuthorization.publicEvidence,
      ),
    ).toThrow(/Admin deletion evidence is incomplete/);

    const staleCredential = initialDeletionEvidence();
    (staleCredential.developer[0].results[1] as Record<string, unknown>).key_count = 1;
    expect(() =>
      assertInitialDeletionEvidence(
        staleCredential.admin,
        staleCredential.developer,
        staleCredential.publicEvidence,
      ),
    ).toThrow(/Developer credential deletion evidence is incomplete/);

    const genericEdge404 = initialDeletionEvidence();
    genericEdge404.publicEvidence.rooms[0].error = 'NOT_FOUND';
    expect(() =>
      assertInitialDeletionEvidence(
        genericEdge404.admin,
        genericEdge404.developer,
        genericEdge404.publicEvidence,
      ),
    ).toThrow(/Public bootstrap still exposes/);
  });

  it('probes both public bootstrap routes and requires application tombstones', async () => {
    const fetchImpl = async (input: URL | RequestInfo) => {
      const roomCode = new URL(String(input)).pathname.split('/').at(-2);
      return Response.json(
        { error: roomCode === '000002' ? 'ROOM_NOT_FOUND' : 'PRO_ROOM_NOT_FOUND' },
        { status: 404 },
      );
    };
    await expect(
      probePublicDeletionEvidence('https://musixquare.com', fetchImpl),
    ).resolves.toMatchObject({
      rooms: [
        { roomCode: '000002', status: 404, error: 'ROOM_NOT_FOUND' },
        { roomCode: '000003', status: 404, error: 'PRO_ROOM_NOT_FOUND' },
      ],
    });
  });

  it('orders all generation migrations and Workers before the cutover marker', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const orderedNeedles = [
      'Apply admin PRO room generation migration',
      'Apply account PRO room generation migration',
      'Apply Developer API PRO room generation migration',
      'Verify every PRO room generation schema',
      'Deploy and record PRO room Worker',
      'Smoke PRO room Worker',
      'Deploy and record signaling Worker',
      'Smoke signaling Worker',
      'Deploy and record Developer API facade Worker',
      'Deploy and record Developer API Worker',
      'Smoke Developer API Worker',
      'Deploy and record app Worker with immutable dist',
      'Smoke app session endpoint',
      'Verify release still owns current production deployments',
      'Verify initial 000002 and 000003 deletion evidence',
      'Enable immutable PRO room generation cutover',
    ];
    let previous = -1;
    for (const needle of orderedNeedles) {
      const next = workflow.indexOf(needle);
      expect(next, `missing workflow step: ${needle}`).toBeGreaterThan(previous);
      previous = next;
    }
  });

  it('captures every release D1 JSON probe through the strict envelope helper', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const d1JsonExecutions = workflow.match(
      /npm run --silent wrangler -- d1 execute[\s\S]*?--remote --json[\s\S]*?(?=\n {10}npm run|\n {10}node|\n {6}- name:)/gu,
    );
    const strictCaptures = workflow.match(/\| node scripts\/capture-wrangler-d1-json\.mjs/gu);
    const d1JsonExecutionCount = d1JsonExecutions?.length ?? 0;
    expect(d1JsonExecutionCount).toBe(13);
    expect(strictCaptures).toHaveLength(d1JsonExecutionCount);
    for (const execution of d1JsonExecutions ?? []) {
      expect(execution).toContain('| node scripts/capture-wrangler-d1-json.mjs');
    }
    expect(workflow).not.toMatch(
      /--remote --json[\s\S]{0,1000}?> release-artifacts\/deployments\/[^ \n]+\.json/gu,
    );
    for (const sqlFile of [
      'pro-room-generation-admin-migration-state.sql',
      'pro-room-generation-auth-migration-state.sql',
      'pro-room-generation-developer-migration-state.sql',
      'pro-room-generation-admin-readiness.sql',
      'pro-room-generation-auth-readiness.sql',
      'pro-room-generation-developer-readiness.sql',
      'pro-room-generation-admin-deletion-evidence.sql',
      'pro-room-generation-developer-deletion-evidence.sql',
    ]) {
      expect(workflow).toContain(`--command="$(cat scripts/sql/${sqlFile})"`);
      expect(workflow).not.toContain(`--command "$(cat scripts/sql/${sqlFile})"`);
      expect(workflow).not.toContain(`--file scripts/sql/${sqlFile}`);
    }
  });

  it('requires explicit external cleanup attestation and disables before rollback', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain('enable_pro_room_generation_cutover:');
    expect(workflow).toContain('DIRECTLY_VERIFIED_000002_000003');
    expect(workflow).toContain('pro-room-generation-admin-deletion-evidence.sql');
    expect(workflow).toContain('pro-room-generation-developer-deletion-evidence.sql');
    expect(workflow).toContain('probe-public-deletion');
    expect(workflow).toContain('decommissioned_at <= (unixepoch() * 1000) - 4200000');
    expect(workflow).toContain("audit.action = 'room.delete'");
    expect(workflow).toContain("audit.result = 'authorized'");
    expect(workflow).toContain('registry.updated_at < history.decommissioned_at');
    expect(workflow).toContain(
      'EXISTS (SELECT 1 FROM mxqr_pro_room_generation_allocations WHERE room_generation > 0)',
    );
    expect(workflow).toMatch(
      /Enable immutable PRO room generation cutover[\s\S]*inputs\.enable_pro_room_generation_cutover/,
    );
    expect(workflow).toContain('Fence room-code reuse during dependency rollout');
    expect(workflow).toContain('Verify full release honors immutable PRO generation floor');
    expect(workflow).toContain(
      'steps.pro_room_generation_cutover_before_rollout.outputs.floor_release_sha',
    );
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$floor_release_sha" "${{ github.sha }}"',
    );
    expect(
      workflow.indexOf('Verify full release honors immutable PRO generation floor'),
    ).toBeLessThan(workflow.indexOf('Fence room-code reuse during dependency rollout'));
    expect(workflow).toContain(
      'steps.pro_room_generation_cutover_disable.outputs.generation_floor',
    );
    expect(
      workflow.indexOf('Disable PRO room generation cutover before failed-release rollback'),
    ).toBeLessThan(workflow.indexOf('Restore Worker deployments after a failed release'));
    expect(workflow).toContain(
      'rollback_skip_targets="${rollback_skip_targets},pro-room,signaling,developer-api-facade,developer-api,app"',
    );
  });

  it('keeps the migration-created cutover singleton disabled', () => {
    const migration = readFileSync(
      resolve('cloudflare/admin-metrics.pro-room-generation.migration.sql'),
      'utf8',
    );
    expect(migration).toMatch(
      /INSERT INTO mxqr_pro_room_generation_cutover[\s\S]*VALUES \(1, 'disabled', NULL, 0, NULL, 0\)/,
    );
    expect(migration).not.toMatch(
      /INSERT INTO mxqr_pro_room_generation_cutover[\s\S]*VALUES \(1, 'ready'/,
    );
  });
});
