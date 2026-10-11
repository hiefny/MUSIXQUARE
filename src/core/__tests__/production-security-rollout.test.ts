import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { experimental_readRawConfig } from 'wrangler';
import {
  collectProductionSecurityFindings,
  formatProductionSecurityFailure,
  type ProductionSecurityFindings,
} from '../../../scripts/production-security-guard-lib.mts';
import {
  readConfigurationAssignment,
  validateAccountRolloutConfig,
  validateRemoteShareRolloutConfig,
} from '../../../scripts/production-security-rollout.mts';

const PRO_WITH_AUTH_DB = `
[[d1_databases]]
binding = "MUSIXQUARE_AUTH_DB"
database_name = "musixquare-auth"
`;

const APP_WITH_AUTH_DB = `
[[d1_databases]]
binding = "MUSIXQUARE_AUTH_DB"
database_name = "musixquare-auth"
`;

const REMOTE_SHARE_ROLLOUT = `
[version_metadata]
binding = "CF_VERSION_METADATA"
[vars]
ROOM_UPLOADS_PER_WINDOW = "120"
ROOM_UPLOAD_ASSERTION_MODE = "required"
# npm run wrangler -- secret put MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET
[[d1_databases]]
binding = "MUSIXQUARE_ADMIN_DB"
`;

const SIGNALING_ASSERTION_SECRET = `
# npm run wrangler -- secret put MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET
`;

const REMOTE_SHARE_CONFIG = 'cloudflare/wrangler.remote-share.toml';
const PRO_ROOM_CONFIG = 'cloudflare/wrangler.pro-room.toml';
const REMOTE_SHARE_FLAG = 'MXQR_ALLOW_UNGUARDED_REMOTE_SHARE';
const RETIRED_PROJECTION_FLAG = 'PRO_ROOM_MEMBER_AUTHORITY_PROJECTION';
const RETIRED_PROJECTION_ASSIGNMENT = `"${RETIRED_PROJECTION_FLAG}" = false`;
const UNREADABLE_CONFIG = '[vars]\nsecret = "sensitive-parser-excerpt\n';
const GUARD_CONFIG_FILES = [
  PRO_ROOM_CONFIG,
  'cloudflare/wrangler.app.toml',
  REMOTE_SHARE_CONFIG,
  'cloudflare/wrangler.signaling.toml',
  'cloudflare/signaling-worker.ts',
  'cloudflare/standard-room-pin-membership.ts',
] as const;
const GUARD_CLI = 'scripts/assert-production-security-config.mts';
const GUARD_SCRIPT_FILES = [
  GUARD_CLI,
  'scripts/production-security-guard-lib.mts',
  'scripts/production-security-rollout.mts',
  'scripts/pro-signaling-credential-boundary.mts',
  'scripts/standard-room-pin-storage-boundary.mts',
] as const;
const CLEAN_FINDINGS: ProductionSecurityFindings = {
  hits: [],
  rolloutErrors: [],
  remoteShareRolloutErrors: [],
  proSignalingCredentialErrors: [],
  standardRoomPinStorageErrors: [],
};

function copyGuardFixture(root: string, files: readonly string[]): void {
  for (const file of files) {
    const target = resolve(root, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
}

function onlyHit(source: string, flag: string): ProductionSecurityFindings {
  return { ...CLEAN_FINDINGS, hits: [{ source, flag }] };
}

describe('production security guard findings', () => {
  // The guard library runs from this checkout; only its repository root points
  // at a disposable copy of the production configuration it inspects.
  let root = '';
  let remoteShareSource = '';
  let proRoomSource = '';

  // Pass only the flag under test so a developer shell exporting another
  // bypass flag can never change these results.
  const collect = (environmentValue = '') =>
    collectProductionSecurityFindings({
      repoRoot: root,
      env: { [REMOTE_SHARE_FLAG]: environmentValue },
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mxqr-security-guard-'));
    copyGuardFixture(root, GUARD_CONFIG_FILES);
    remoteShareSource = readFileSync(resolve(root, REMOTE_SHARE_CONFIG), 'utf8');
    proRoomSource = readFileSync(resolve(root, PRO_ROOM_CONFIG), 'utf8');
  });

  afterEach(() => {
    writeFileSync(resolve(root, REMOTE_SHARE_CONFIG), remoteShareSource);
    writeFileSync(resolve(root, PRO_ROOM_CONFIG), proRoomSource);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('finds nothing in the unmodified production configuration', async () => {
    const findings = await collect();
    expect(findings).toEqual(CLEAN_FINDINGS);
    expect(formatProductionSecurityFailure(findings)).toBeNull();
  });

  it.each([
    ['"true" # operator note', '', REMOTE_SHARE_CONFIG],
    ["'true' # operator note", '', REMOTE_SHARE_CONFIG],
    ['false # operator note', '', null],
    ['"true#value" # operator note', '', null],
    ['"false" # operator note', 'true # literal environment value', null],
    ['"false" # operator note', 'true', 'environment'],
  ] as const)(
    'enforces file value %s with environment value %j',
    async (fileValue, environmentValue, expectedSource) => {
      writeFileSync(
        resolve(root, REMOTE_SHARE_CONFIG),
        remoteShareSource.replace('[vars]', `[vars]\n${REMOTE_SHARE_FLAG} = ${fileValue}`),
      );
      const findings = await collect(environmentValue);
      if (expectedSource === null) {
        expect(findings).toEqual(CLEAN_FINDINGS);
        expect(formatProductionSecurityFailure(findings)).toBeNull();
      } else {
        expect(findings).toEqual(onlyHit(expectedSource, REMOTE_SHARE_FLAG));
        expect(formatProductionSecurityFailure(findings)).not.toBeNull();
      }
    },
  );

  it.each([
    ['"MXQR_ALLOW_UNGUARDED_REMOTE_SHARE" = "true"', 'true', true],
    ["'MXQR_ALLOW_UNGUARDED_REMOTE_SHARE' = true", 'true', true],
    ['"MXQR_ALLOW_UNGUARDED_REMOTE_SH\\u0041RE" = "true"', 'true', true],
    ['MXQR_ALLOW_UNGUARDED_REMOTE_SHARE = "tr\\u0075e"', 'true', true],
    ['MXQR_ALLOW_UNGUARDED_REMOTE_SHARE = """true"""', 'true', true],
    ['MXQR_ALLOW_UNGUARDED_REMOTE_SHARE = """\ntrue"""', 'true', true],
    ['"MXQR_ALLOW_UNGUARDED_REMOTE_SHARE" = false # safe', 'false', false],
    ['"MXQR_ALLOW_UNGUARDED_REMOTE_SHARE" = "true#literal"', 'true#literal', false],
    ['"MXQR_ALLOW_UNGUARDED_REMOTE_SHARE" = \'"true"\'', '"true"', false],
  ] as const)(
    'applies deployment TOML semantics to %s',
    async (assignment, parsedValue, unsafe) => {
      const configPath = resolve(root, REMOTE_SHARE_CONFIG);
      writeFileSync(configPath, remoteShareSource.replace('[vars]', `['vars']\n${assignment}`));
      const parsed = experimental_readRawConfig({ config: configPath }).rawConfig;
      expect(String(parsed.vars?.[REMOTE_SHARE_FLAG])).toBe(parsedValue);
      const findings = await collect();
      if (unsafe) {
        expect(findings).toEqual(onlyHit(REMOTE_SHARE_CONFIG, REMOTE_SHARE_FLAG));
        expect(formatProductionSecurityFailure(findings)).not.toBeNull();
      } else {
        expect(findings).toEqual(CLEAN_FINDINGS);
        expect(formatProductionSecurityFailure(findings)).toBeNull();
      }
    },
  );

  it('rejects a retired PRO projection flag even when it is disabled', async () => {
    writeFileSync(
      resolve(root, PRO_ROOM_CONFIG),
      proRoomSource.replace('[vars]', `[vars]\n${RETIRED_PROJECTION_ASSIGNMENT}`),
    );
    const findings = await collect();
    expect(findings).toEqual(onlyHit(PRO_ROOM_CONFIG, RETIRED_PROJECTION_FLAG));
    expect(formatProductionSecurityFailure(findings)).toEqual([
      '[prod-security-guard] Unsafe production configuration detected:',
      `  - ${PRO_ROOM_CONFIG}: ${RETIRED_PROJECTION_FLAG}`,
      '[prod-security-guard] Fix the production security/rollout configuration before deploying.',
    ]);
  });

  it('fails closed on unreadable TOML without echoing parser excerpts', async () => {
    writeFileSync(resolve(root, REMOTE_SHARE_CONFIG), UNREADABLE_CONFIG);
    const error: unknown = await collect().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toBe(
      `Production security configuration is unreadable: ${REMOTE_SHARE_CONFIG}`,
    );
    expect(failure.stack ?? '').not.toContain('sensitive-parser-excerpt');
    expect(failure.cause).toBeUndefined();
  });
});

describe('production security guard CLI', () => {
  it('reads the deploy environment and fails closed through the real release-gate command', () => {
    // Keep the fixture inside the ignored scratch tree so its unchanged
    // TypeScript helper imports resolve from this checkout's dependencies.
    const cache = resolve('scratch/security-guard-fixtures');
    mkdirSync(cache, { recursive: true });
    const root = mkdtempSync(resolve(cache, 'mxqr-security-guard-'));
    const cleanup = () => {
      if (!root.startsWith(`${cache}${sep}`)) throw new Error('Invalid guard fixture cleanup path');
      rmSync(root, { recursive: true, force: true });
    };
    try {
      copyGuardFixture(root, [...GUARD_SCRIPT_FILES, ...GUARD_CONFIG_FILES]);
      const runGuard = (environmentValue: string) =>
        spawnSync(process.execPath, [resolve(root, GUARD_CLI)], {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, [REMOTE_SHARE_FLAG]: environmentValue },
        });

      // One spawn proves the CLI wires process.env, its own repository root
      // and the shared formatter together.
      const proPath = resolve(root, PRO_ROOM_CONFIG);
      const proSource = readFileSync(proPath, 'utf8');
      writeFileSync(
        proPath,
        proSource.replace('[vars]', `[vars]\n${RETIRED_PROJECTION_ASSIGNMENT}`),
      );
      const unsafe = runGuard('true');
      expect(unsafe.error).toBeUndefined();
      expect(unsafe.status, unsafe.stdout + unsafe.stderr).toBe(1);
      expect(unsafe.stdout).not.toContain('[prod-security-guard] OK');
      expect(unsafe.stderr).toContain(
        '[prod-security-guard] Unsafe production configuration detected:\n',
      );
      expect(unsafe.stderr).toContain(`\n  - environment: ${REMOTE_SHARE_FLAG}\n`);
      expect(unsafe.stderr).toContain(`\n  - ${PRO_ROOM_CONFIG}: ${RETIRED_PROJECTION_FLAG}\n`);
      expect(unsafe.stderr).toContain(
        '\n[prod-security-guard] Fix the production security/rollout configuration before deploying.\n',
      );
      writeFileSync(proPath, proSource);

      writeFileSync(resolve(root, REMOTE_SHARE_CONFIG), UNREADABLE_CONFIG);
      const invalid = runGuard('');
      expect(invalid.error).toBeUndefined();
      expect(invalid.status, invalid.stdout + invalid.stderr).toBe(1);
      expect(invalid.stderr).toContain('Production security configuration is unreadable');
      expect(invalid.stdout + invalid.stderr).not.toContain('sensitive-parser-excerpt');
    } finally {
      cleanup();
    }
  }, 60_000);
});

describe('configuration assignment comments', () => {
  it.each([
    ['true # operator note', 'true'],
    ['"true" # operator note', '"true"'],
    ["'true' # operator note", "'true'"],
    ['false # operator note', 'false'],
    ['"false" # operator note', '"false"'],
    ['"true#value" # operator note', '"true#value"'],
    ["'true#value' # operator note", "'true#value'"],
    ['"value\\"#inside" # outside', '"value\\"#inside"'],
    ['"value\\\\" # outside', '"value\\\\"'],
  ])('reads file value %s', (source, expected) => {
    expect(readConfigurationAssignment(`FLAG = ${source}`, 'FLAG')).toBe(expected);
    expect(readConfigurationAssignment(`# FLAG = ${source}`, 'FLAG')).toBeNull();
  });

  it('accepts inline comments on the existing Remote Share rollout values', () => {
    const config = REMOTE_SHARE_ROLLOUT.replace('"120"', '"120" # room limit').replace(
      '"required"',
      '"required" # assertion policy',
    );
    expect(validateRemoteShareRolloutConfig(config, SIGNALING_ASSERTION_SECRET)).toEqual([]);
  });
});

describe('production account launch guard', () => {
  it('rejects either retired projection flag while ignoring comments', () => {
    expect(
      validateAccountRolloutConfig(
        `${PRO_WITH_AUTH_DB}\nPRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = "1"`,
        APP_WITH_AUTH_DB,
      ),
    ).toEqual(['Retired PRO account projection flags must not be present.']);
    expect(
      validateAccountRolloutConfig(
        `${PRO_WITH_AUTH_DB}\nPRO_ROOM_MEMBER_AUTHORITY_PROJECTION = "0"`,
        APP_WITH_AUTH_DB,
      ),
    ).toEqual(['Retired PRO account projection flags must not be present.']);
    expect(
      validateAccountRolloutConfig(
        `${PRO_WITH_AUTH_DB}\n# PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = "1"`,
        APP_WITH_AUTH_DB,
      ),
    ).toEqual([]);
  });

  it('requires the account database in both PRO and App Workers', () => {
    expect(validateAccountRolloutConfig('', APP_WITH_AUTH_DB)).toEqual([
      'PRO room decommissioning is enabled without an active MUSIXQUARE_AUTH_DB Worker binding.',
    ]);
    expect(validateAccountRolloutConfig(PRO_WITH_AUTH_DB, '')).toEqual([
      'Account identity is enabled without an active MUSIXQUARE_AUTH_DB App binding.',
    ]);
    expect(validateAccountRolloutConfig('', '')).toEqual([
      'PRO room decommissioning is enabled without an active MUSIXQUARE_AUTH_DB Worker binding.',
      'Account identity is enabled without an active MUSIXQUARE_AUTH_DB App binding.',
    ]);
  });

  it('accepts the launch contract with both exact account bindings', () => {
    expect(validateAccountRolloutConfig(PRO_WITH_AUTH_DB, APP_WITH_AUTH_DB)).toEqual([]);
  });
});

describe('production Remote Share rollout guard', () => {
  it('accepts required assertions with a bounded room limit and metrics binding', () => {
    expect(
      validateRemoteShareRolloutConfig(REMOTE_SHARE_ROLLOUT, SIGNALING_ASSERTION_SECRET),
    ).toEqual([]);
  });

  it.each(['0', '-1', '1.5', '1025', 'not-a-number'])(
    'rejects unsafe room allocation limit %s',
    (limit) => {
      expect(
        validateRemoteShareRolloutConfig(
          REMOTE_SHARE_ROLLOUT.replace('"120"', `"${limit}"`),
          SIGNALING_ASSERTION_SECRET,
        ),
      ).toContain('ROOM_UPLOADS_PER_WINDOW must be an integer from 1 through 1024.');
    },
  );

  it('rejects optional, disabled, or missing assertions, telemetry, and either secret declaration', () => {
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('"required"', '"optional"'),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('ROOM_UPLOAD_ASSERTION_MODE must be required in production.');
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('"required"', '"disabled"'),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('ROOM_UPLOAD_ASSERTION_MODE must be required in production.');
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('ROOM_UPLOAD_ASSERTION_MODE = "required"', ''),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('ROOM_UPLOAD_ASSERTION_MODE must be required in production.');
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('binding = "MUSIXQUARE_ADMIN_DB"', ''),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('Remote Share assertion rollout requires the MUSIXQUARE_ADMIN_DB binding.');
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET', 'OTHER_SECRET'),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('Remote Share and signaling must both declare the shared assertion secret name.');
    expect(validateRemoteShareRolloutConfig(REMOTE_SHARE_ROLLOUT, '')).toContain(
      'Remote Share and signaling must both declare the shared assertion secret name.',
    );
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('binding = "CF_VERSION_METADATA"', ''),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('Remote Share release approval requires the CF_VERSION_METADATA binding.');
  });
});
