import { describe, expect, it } from 'vitest';
import { validateAccountRolloutConfig } from '../../../scripts/production-security-rollout.mjs';

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
