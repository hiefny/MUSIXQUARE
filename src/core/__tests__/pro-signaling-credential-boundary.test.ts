import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateProSignalingCredentialBoundary } from '../../../scripts/pro-signaling-credential-boundary.mjs';

const CHECKED_IN_SIGNALING_WORKER = readFileSync('cloudflare/signaling-worker.js', 'utf8');

const SUBPROTOCOL_ONLY_WORKER = `
const PRO_SIGNALING_WEBSOCKET_PROTOCOL = 'mxqr.pro-signaling.v1';
const PRO_SIGNALING_TICKET_PROTOCOL_PREFIX = 'mxqr.ticket.';
function readProSignalingCredential(request, url) {
  if (url.search || url.hash) return null;
  const protocolHeader = request.headers.get('Sec-WebSocket-Protocol');
  const protocols = protocolHeader.split(',');
  if (protocols.length !== 2) return null;
  return protocols;
}
`;

function validate(workerSource = SUBPROTOCOL_ONLY_WORKER): string[] {
  return validateProSignalingCredentialBoundary({ workerSource });
}

describe('PRO signaling credential boundary guard', () => {
  it('accepts the checked-in subprotocol-only Worker', () => {
    expect(
      validateProSignalingCredentialBoundary({
        workerSource: CHECKED_IN_SIGNALING_WORKER,
      }),
    ).toEqual([]);
  });

  it.each([
    "url.searchParams.get('ticket');",
    "url['searchParams']['getAll']('ticket');",
    "const KEY = 'tick' + 'et'; url.searchParams.get(KEY);",
    "const { searchParams: params } = url; params.has('ticket');",
    'url.searchParams.get(runtimeSelectedKey);',
  ])('rejects a URL ticket reader: %s', (reader) => {
    expect(validate(`${SUBPROTOCOL_ONLY_WORKER}\n${reader}`)).toContain(
      'PRO signaling must never read a ticket credential from URL search parameters',
    );
  });

  it('does not confuse standard-room routing parameters with credentials', () => {
    expect(validate(`${SUBPROTOCOL_ONLY_WORKER}\nurl.searchParams.get('role');`)).toEqual([]);
  });

  it('requires the exact two-token subprotocol parser and blanket query rejection', () => {
    expect(
      validate(SUBPROTOCOL_ONLY_WORKER.replace('url.search || url.hash', 'url.hash')),
    ).toContain('PRO signaling credential parsing must reject every URL query or fragment');
    expect(
      validate(SUBPROTOCOL_ONLY_WORKER.replace('protocols.length !== 2', 'protocols.length < 2')),
    ).toContain('PRO signaling must require exactly the stable marker and one ticket token');
    expect(
      validate(
        SUBPROTOCOL_ONLY_WORKER.replace(
          "request.headers.get('Sec-WebSocket-Protocol')",
          "request.headers.get('Authorization')",
        ),
      ),
    ).toContain('PRO signaling credentials must come from Sec-WebSocket-Protocol');
  });

  it('rejects retired cutoff and refresh machinery', () => {
    const retiredCutoff = 'const PRO_SIGNALING_QUERY_ACCEPT_UNTIL = Date.now();';
    const retiredRefresh = `const ${['PRO_SIGNALING', 'CLIENT', 'UPDATE_REQUIRED'].join('_')} = 'refresh';`;

    expect(validate(`${SUBPROTOCOL_ONLY_WORKER}\n${retiredCutoff}`)).toContain(
      'PRO signaling must not retain a dated query-credential cutoff',
    );
    expect(validate(`${SUBPROTOCOL_ONLY_WORKER}\n${retiredRefresh}`)).toContain(
      'PRO signaling must not retain retired client-refresh compatibility',
    );
  });
});
