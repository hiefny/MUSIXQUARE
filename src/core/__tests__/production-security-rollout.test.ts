import { describe, expect, it } from 'vitest';
import {
  validateAccountRolloutConfig,
  validateRemoteShareRolloutConfig,
} from '../../../scripts/production-security-rollout.mjs';

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
ROOM_UPLOAD_ASSERTION_MODE = "optional"
# npm run wrangler -- secret put MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET
[[d1_databases]]
binding = "MUSIXQUARE_ADMIN_DB"
`;

const SIGNALING_ASSERTION_SECRET = `
# npm run wrangler -- secret put MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET
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

describe('production Remote Share rollout guard', () => {
  it('accepts both staged assertion modes with a bounded room limit and metrics binding', () => {
    expect(
      validateRemoteShareRolloutConfig(REMOTE_SHARE_ROLLOUT, SIGNALING_ASSERTION_SECRET),
    ).toEqual([]);
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('"optional"', '"required"'),
        SIGNALING_ASSERTION_SECRET,
      ),
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

  it('rejects disabled or missing assertions, telemetry, and either secret declaration', () => {
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('"optional"', '"disabled"'),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('ROOM_UPLOAD_ASSERTION_MODE must be optional or required in production.');
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
