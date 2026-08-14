import { describe, expect, it } from 'vitest';
import {
  PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS,
  validateProSignalingTicketCutover,
} from '../../../scripts/pro-signaling-ticket-cutover.mjs';

const LEGACY_WORKER = `
const PRO_SIGNALING_CLIENT_UPDATE_REQUIRED = 'PRO_SIGNALING_CLIENT_UPDATE_REQUIRED';
const PRO_SIGNALING_LEGACY_QUERY_ACCEPT_UNTIL_MS = Date.UTC(2026, 8, 9);
const ticketValues = url.searchParams.getAll('ticket');
return { ticket: ticketValues[0], transport: 'legacy-query' };
json({}, 426, { 'x-mxqr-client-action': 'refresh' });
recordMetric('pro_ticket_legacy_query_used');
recordMetric('pro_ticket_legacy_query_update_required');
if (isProSignalingClientUpdateRequired(credential)) {
  return proSignalingClientUpdateRequired();
}
`;

const PRIVATE_OBSERVABILITY = `
[observability.logs]
enabled = true
head_sampling_rate = 0.1
invocation_logs = false

[observability.traces]
enabled = false

[[d1_databases]]
binding = "MUSIXQUARE_ADMIN_DB"
database_name = "musixquare-admin"

[[durable_objects.bindings]]
name = "MUSIXQUARE_SERVICE_CONTROL"
class_name = "MusixquareServiceControl"
`;

const ADMIN_INVENTORY = `
{ key: 'pro_ticket_legacy_query_used' },
{ key: 'pro_ticket_legacy_query_update_required' },
`;

const POST_CUTOFF_REFRESH_WORKER = `
const PRO_SIGNALING_CLIENT_UPDATE_REQUIRED = 'PRO_SIGNALING_CLIENT_UPDATE_REQUIRED';
const ticketValues = url.searchParams.getAll('ticket');
json({}, 426, { 'x-mxqr-client-action': 'refresh' });
recordMetric('pro_ticket_legacy_query_update_required');
if (isProSignalingClientUpdateRequired(credential)) {
  return proSignalingClientUpdateRequired();
}
return {
  error: PRO_SIGNALING_CLIENT_UPDATE_REQUIRED,
  metricEligible: isStructurallyPlausibleProSignalingTicket(ticketValues[0], roomId, nowMs),
  transport: 'legacy-query-expired'
};
`;

function validate(
  workerSource = LEGACY_WORKER,
  signalingConfig = PRIVATE_OBSERVABILITY,
  nowMs = PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS - 1,
): string[] {
  return validateProSignalingTicketCutover({
    workerSource,
    signalingConfig,
    adminWorkerSource: ADMIN_INVENTORY,
    nowMs,
  });
}

describe('PRO signaling query-ticket cutover guard', () => {
  it('accepts the bounded, metric-backed grace contract before cutoff', () => {
    expect(validate()).toEqual([]);
  });

  it('forces removal of the dead admission branch on the first post-cutoff deployment', () => {
    expect(
      validate(LEGACY_WORKER, PRIVATE_OBSERVABILITY, PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS),
    ).toContain(
      'legacy PRO query-ticket admission is past cutoff; remove its ticket verification/admission branch before deploying',
    );
  });

  it('detects renamed and element-access query bearer admission after cutoff', () => {
    const renamedAdmission = LEGACY_WORKER.replace(
      "const ticketValues = url.searchParams.getAll('ticket');\nreturn { ticket: ticketValues[0], transport: 'legacy-query' };",
      "const cached = url['searchParams']['getAll']('ticket');\nreturn { bearer: cached[0], channel: 'compat' };",
    );

    expect(
      validate(renamedAdmission, PRIVATE_OBSERVABILITY, PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS),
    ).toContain(
      'legacy PRO query-ticket admission is past cutoff; remove its ticket verification/admission branch before deploying',
    );
  });

  it('follows immutable query-key constants while excluding known non-ticket keys', () => {
    const constantKeyAdmission = LEGACY_WORKER.replace(
      "const ticketValues = url.searchParams.getAll('ticket');",
      "const PARAM = 'tick' + 'et';\nconst ticketValues = url.searchParams.getAll(PARAM);",
    );
    const knownRoleRead = `
const PARAM = 'role';
url.searchParams.get(PARAM);
`;

    expect(
      validate(constantKeyAdmission, PRIVATE_OBSERVABILITY, PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS),
    ).toContain(
      'legacy PRO query-ticket admission is past cutoff; remove its ticket verification/admission branch before deploying',
    );
    expect(
      validateProSignalingTicketCutover({
        workerSource: knownRoleRead,
        signalingConfig: PRIVATE_OBSERVABILITY,
        nowMs: PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS,
      }),
    ).toEqual([]);
  });

  it('detects destructured bearers and bearer-bearing object mutation after cutoff', () => {
    const destructuredAdmission = LEGACY_WORKER.replace(
      "const ticketValues = url.searchParams.getAll('ticket');\nreturn { ticket: ticketValues[0], transport: 'legacy-query' };",
      "const [bearer] = url.searchParams.getAll('ticket');\nreturn { credential: bearer, channel: 'compat' };",
    );
    const mutatedAdmission = LEGACY_WORKER.replace(
      "const ticketValues = url.searchParams.getAll('ticket');\nreturn { ticket: ticketValues[0], transport: 'legacy-query' };",
      "const ticketValues = url.searchParams.getAll('ticket');\nconst holder = {};\nholder.credential = ticketValues[0];\nreturn holder;",
    );

    for (const workerSource of [destructuredAdmission, mutatedAdmission]) {
      expect(
        validate(workerSource, PRIVATE_OBSERVABILITY, PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS),
      ).toContain(
        'legacy PRO query-ticket admission is past cutoff; remove its ticket verification/admission branch before deploying',
      );
    }
  });

  it('detects destructured searchParams, helper readers, and computed methods', () => {
    const patterns = [
      `
const { searchParams: params } = url;
const values = params.getAll('ticket');
return { ticket: values[0] };
`,
      `
function readTicket(params) { return params.getAll('ticket')[0]; }
return { ticket: readTicket(url.searchParams) };
`,
      `
const METHOD = 'getAll';
const values = url.searchParams[METHOD]('ticket');
return { ticket: values[0] };
`,
    ];

    for (const pattern of patterns) {
      const workerSource = `${POST_CUTOFF_REFRESH_WORKER}\n${pattern}`;
      expect(
        validate(workerSource, PRIVATE_OBSERVABILITY, PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS),
      ).toContain(
        'legacy PRO query-ticket admission is past cutoff; remove its ticket verification/admission branch before deploying',
      );
    }
  });

  it('keeps provider URL telemetry off while a ticket query can still arrive', () => {
    const unsafe = PRIVATE_OBSERVABILITY.replace(
      'invocation_logs = false',
      'invocation_logs = true',
    ).replace('[observability.traces]\nenabled = false', '[observability.traces]\nenabled = true');

    expect(validate(LEGACY_WORKER, unsafe)).toEqual(
      expect.arrayContaining([
        'signaling invocation_logs must stay false while any legacy ticket query can arrive',
        'signaling automatic traces must stay disabled while any legacy ticket query can arrive',
      ]),
    );
    expect(validate(LEGACY_WORKER, PRIVATE_OBSERVABILITY.replace('enabled = false', ''))).toContain(
      'signaling automatic traces must stay disabled while any legacy ticket query can arrive',
    );
  });

  it('forbids retaining or verifying the bearer in the post-cutoff refresh branch', () => {
    const unsafeVerifier = LEGACY_WORKER.replace(
      'return proSignalingClientUpdateRequired();',
      'await verifyProSignalingTicket(credential.ticket);\n  return proSignalingClientUpdateRequired();',
    );
    const unsafeCredential = LEGACY_WORKER.replace(
      "return { ticket: ticketValues[0], transport: 'legacy-query' };",
      `return {
  error: PRO_SIGNALING_CLIENT_UPDATE_REQUIRED,
  ticket: ticketValues[0],
  transport: 'legacy-query-expired'
};
return { ticket: ticketValues[0], transport: 'legacy-query' };`,
    );
    expect(validate(unsafeVerifier)).toContain(
      'post-cutoff refresh handling must not retain or verify the query bearer',
    );
    expect(validate(unsafeCredential)).toContain(
      'post-cutoff refresh handling must not retain or verify the query bearer',
    );
  });

  it('allows a reviewed observability restoration only after every query detector is removed', () => {
    const postCutoverWorker = `
const PRO_SIGNALING_WEBSOCKET_PROTOCOL = 'mxqr.pro-signaling.v1';
readSubprotocolCredential(request);
`;
    const restored = PRIVATE_OBSERVABILITY.replace(
      'invocation_logs = false',
      'invocation_logs = true',
    ).replace('[observability.traces]\nenabled = false', '[observability.traces]\nenabled = true');

    expect(validate(postCutoverWorker, restored, PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS)).toEqual([]);
  });

  it('allows the refresh-only recovery window after legacy admission is removed', () => {
    expect(
      validateProSignalingTicketCutover({
        workerSource: POST_CUTOFF_REFRESH_WORKER,
        signalingConfig: PRIVATE_OBSERVABILITY,
        adminWorkerSource: `{ key: 'pro_ticket_legacy_query_update_required' }`,
        nowMs: PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS,
      }),
    ).toEqual([]);
  });

  it('requires aggregate metrics, dashboard visibility, and a refresh response together', () => {
    expect(
      validateProSignalingTicketCutover({
        workerSource: LEGACY_WORKER.replace("{ 'x-mxqr-client-action': 'refresh' }", '{}').replace(
          "recordMetric('pro_ticket_legacy_query_update_required');",
          '',
        ),
        signalingConfig: PRIVATE_OBSERVABILITY,
        adminWorkerSource: '',
        nowMs: PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS - 1,
      }),
    ).toEqual(
      expect.arrayContaining([
        'legacy PRO query detection must return the explicit refresh/update contract',
        'legacy PRO query detection must retain the aggregate refresh metric',
        'the admin metric inventory must expose the legacy PRO usage counter',
        'the admin metric inventory must expose the legacy PRO refresh counter',
      ]),
    );
  });

  it('requires both metric persistence and its bounded rate-control bindings', () => {
    const withoutAdminDb = PRIVATE_OBSERVABILITY.replace(
      'binding = "MUSIXQUARE_ADMIN_DB"',
      'binding = "REMOVED_ADMIN_DB"',
    );
    const withoutServiceControl = PRIVATE_OBSERVABILITY.replace(
      'name = "MUSIXQUARE_SERVICE_CONTROL"',
      'name = "REMOVED_SERVICE_CONTROL"',
    );

    expect(validate(LEGACY_WORKER, withoutAdminDb)).toContain(
      'legacy PRO query-ticket metrics require the MUSIXQUARE_ADMIN_DB signaling binding',
    );
    expect(validate(LEGACY_WORKER, withoutServiceControl)).toContain(
      'legacy PRO query-ticket metrics require the MUSIXQUARE_SERVICE_CONTROL signaling binding',
    );
  });
});
