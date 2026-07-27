import { describe, expect, it } from 'vitest';
import { validateAccountRolloutConfig } from '../../../scripts/production-security-rollout.mjs';

function proConfig(
  identity: string | null,
  authority: string | null,
  { authBinding = true } = {},
): string {
  return [
    '[vars]',
    identity === null ? '' : `PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = ${identity}`,
    authority === null ? '' : `PRO_ROOM_MEMBER_AUTHORITY_PROJECTION = ${authority}`,
    ...(authBinding ? ['[[d1_databases]]', 'binding = "MUSIXQUARE_AUTH_DB"'] : []),
  ].join('\n');
}

const APP_WITH_AUTH_DB = `
[[d1_databases]]
binding = "MUSIXQUARE_AUTH_DB"
database_name = "musixquare-auth"
`;

describe('production account rollout guard matrix', () => {
  it('accepts the legacy projection only when both flags are explicitly disabled', () => {
    expect(validateAccountRolloutConfig(proConfig('"0"', '"0"'), '')).toEqual([]);
    expect(validateAccountRolloutConfig(proConfig(null, '"0"'), '')).toEqual([
      'Both PRO account projection flags must be explicitly set to "0" or "1".',
    ]);
    expect(validateAccountRolloutConfig(proConfig('true', 'true'), APP_WITH_AUTH_DB)).toEqual([
      'Both PRO account projection flags must be explicitly set to "0" or "1".',
    ]);
  });

  it.each([
    ['"0"', '"1"'],
    ['"1"', '"0"'],
  ])('rejects a split projection rollout (%s / %s)', (identity, authority) => {
    expect(validateAccountRolloutConfig(proConfig(identity, authority), APP_WITH_AUTH_DB)).toEqual([
      'PRO account identity and member authority projections must change together.',
    ]);
  });

  it('requires the dedicated App account database before enabling both projections', () => {
    const enabled = proConfig('"1"', '"1"');
    expect(validateAccountRolloutConfig(enabled, '')).toEqual([
      'PRO account projection is enabled without an active MUSIXQUARE_AUTH_DB App binding.',
    ]);
    expect(
      validateAccountRolloutConfig(
        enabled,
        '# binding = "MUSIXQUARE_AUTH_DB"\nbinding = "SOME_OTHER_DB"',
      ),
    ).toEqual([
      'PRO account projection is enabled without an active MUSIXQUARE_AUTH_DB App binding.',
    ]);
  });

  it('requires the account database in the PRO Worker even with identity projection disabled', () => {
    expect(proConfig('"0"', '"0"', { authBinding: false })).not.toContain('MUSIXQUARE_AUTH_DB');
    expect(
      validateAccountRolloutConfig(proConfig('"0"', '"0"', { authBinding: false }), ''),
    ).toEqual([
      'PRO room decommissioning is enabled without an active MUSIXQUARE_AUTH_DB Worker binding.',
    ]);
    expect(
      validateAccountRolloutConfig(
        `${proConfig('"0"', '"0"', { authBinding: false })}\n# binding = "MUSIXQUARE_AUTH_DB"`,
        '',
      ),
    ).toEqual([
      'PRO room decommissioning is enabled without an active MUSIXQUARE_AUTH_DB Worker binding.',
    ]);
  });

  it('accepts an atomic enabled rollout with an active exact account binding', () => {
    expect(validateAccountRolloutConfig(proConfig("'1'", '"1"'), APP_WITH_AUTH_DB)).toEqual([]);
    expect(
      validateAccountRolloutConfig(
        '# PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = "0"\n' + proConfig('"1"', '"1"'),
        "binding = 'MUSIXQUARE_AUTH_DB'",
      ),
    ).toEqual([]);
  });
});
