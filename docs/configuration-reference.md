# Configuration Reference

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Maintained reference                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Applies to         | Vite local development, public browser build inputs, Playwright E2E, and source-only operations audit                                                                                                                                                                                                                                                                                                                                                                     |
| Last source review | 2026-08-30                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Executable sources | [`vite.config.ts`](../vite.config.ts), [transport config](../src/network/transport/config.ts), [API fallback](../src/network/api-endpoints.ts), [TURN prerequisites](../src/network/standard-room-prerequisites.ts), [PRO endpoint](../src/pro-room/api.ts), [logging](../src/core/log.ts), [E2E config](../e2e/config.ts), [production hook guard](../scripts/assert-production-build-clean.mts), and [`ops-drift.contract.json`](../cloudflare/ops-drift.contract.json) |
| Related documents  | [Local Worker integration](local-worker-integration.md), [contributor guide](../CONTRIBUTING.md)                                                                                                                                                                                                                                                                                                                                                                          |

## Security model

The namespace identifies ownership; it does not make a value secret.

- `VITE_*` values are embedded in browser code and are public. Never put a key,
  bearer, pepper, signing secret, private service token, or credential-bearing
  URL in them.
- `MUSIXQUARE_DEV_*` and Vite server controls affect the local Node/Vite
  process. They are not Cloudflare Worker configuration.
- Wrangler `[vars]` are checked-in non-secret Worker inputs. Worker secrets are
  server-only and belong only on the consuming Worker.
- Test and operator variables must not be copied into `.env.example` merely for
  discoverability.
- Worker runtime secret-name expectations are authoritative in
  [`cloudflare/ops-drift.contract.json`](../cloudflare/ops-drift.contract.json).
  Release-smoke, provider API, and operator credentials remain owned by their
  workflows and runbooks. This reference intentionally duplicates no inventory
  or value.

## Local Vite server controls

| Variable                                 | Accepted value / default                                  | Effect                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `MUSIXQUARE_DEV_PROXY_PRODUCTION_API`    | Exact `true` after trim/case normalization; default false | Enables forwarding only for the six routes listed below. False returns `503 LOCAL_API_PROXY_DISABLED` for them.                |
| `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` | Exact trusted hostname                                    | Lets Vite accept a one-off trusted tunnel hostname without disabling DNS-rebinding protection globally. Do not use a wildcard. |

The opt-in proxy route set is:

- `/api/security-config`
- `/api/capability-challenge`
- `/api/capability-token`
- `/api/youtube-search`
- `/api/youtube-playlist-entry`
- `/api/youtube-playlist-manifest`

With the flag disabled, other unconfigured relative `/api/*` requests receive
`503 LOCAL_API_NOT_CONFIGURED`. Both responses are non-cacheable and take
precedence over the SPA fallback.

## Public browser build and routing inputs

| Variable                                 | Values / validation                                                                                              | Fallback and ownership                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MUSIXQUARE_TRANSPORT`              | `auto`, `peerjs`, or `cloudflare`; other values normalize to `auto`                                              | Localhost chooses PeerJS when no signaling URL is configured. Public hosts always choose Cloudflare.                                                                     |
| `VITE_MUSIXQUARE_SIGNALING_URL`          | Non-empty primary base; configure an absolute credential/query/hash-free `ws:`, `wss:`, `http:`, or `https:` URL | The primary value is not prevalidated like the fallback. Socket construction converts HTTP schemes to WebSocket schemes; public hosts use the canonical URL when absent. |
| `VITE_MUSIXQUARE_SIGNALING_FALLBACK_URL` | Same protocol and path as the primary URL, but a genuinely different origin                                      | Invalid or same-origin values are ignored. It is the bounded iOS route-handoff escape path, not a general retry alias.                                                   |
| `VITE_PRO_ROOM_ENDPOINT`                 | Canonical production facade, root of an HTTPS `*.musixquare.com` service, or localhost origin                    | Missing or invalid values fall back to `https://musixquare.com/api/pro-room`. This can reach production from local development.                                          |
| `VITE_MUSIXQUARE_LOG_LEVEL`              | `DEBUG`, `INFO`, `WARN`, `ERROR`, or `SILENT` (case-insensitive)                                                 | Resolution order is build input, query parameter, local storage, then default. Production defaults to WARN; localhost development defaults to DEBUG.                     |

Runtime-injected `window.__MUSIXQUARE_TRANSPORT__` and
`window.__MUSIXQUARE_PEER_SERVER__` settings can override browser transport
configuration. They are public runtime state and follow the same no-secret
rule.

## Local isolation matrix

| Path or flow                           | Default local behavior                                                 | Isolation action                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ordinary UI, playback, and state work  | No Cloudflare credential is required                                   | Avoid entering protected network flows                                                     |
| Six Vite production-proxy routes       | Local `503` while the proxy flag is false                              | Keep the flag false and mock the route if needed                                           |
| Other relative `/api/*` routes         | Local `503 LOCAL_API_NOT_CONFIGURED`                                   | Add a local mock/Worker rather than relying on SPA fallback                                |
| Standard-room signaling                | Localhost selects PeerJS                                               | Remember that setup intent can still request TURN through the API fallback below           |
| TURN and Realtime/SFU API              | Non-E2E builds try the relative route, then `https://musixquare.com`   | Mock fetches or provide a complete local boundary before invoking the flow                 |
| PRO facade                             | Missing or invalid override resolves directly to the production facade | Set a validated localhost endpoint backed by the required local services, or mock the flow |
| E2E `localFirstApiEndpoints` consumers | E2E mode removes the canonical-production retry                        | Keep E2E mocks/servers local; separately mock or override the PRO facade                   |

The Vite proxy flag therefore controls forwarding, not every client-authored
absolute fallback. Treat PRO, TURN, and Realtime integration checks as
production-affecting unless local routing is proven before the flow starts.

## Test-only inputs

| Variable                       | Contract                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MUSIXQUARE_TEST_HOOKS=1` | Exposes browser state/playback test hooks. Do not use for production builds; `guard:prod-hooks` requires those markers absent from `dist`. |
| `MXQR_E2E_APP_PORT`            | Playwright app/preview port; integer 1-65535, default 4183.                                                                                |
| `MXQR_E2E_PEER_PORT`           | Playwright PeerJS server port; integer 1-65535, default 9010.                                                                              |

These variables belong in a test command or CI job, not committed `.env` files.

## Operator and CI inputs

`MXQR_OPS_DRIFT_REPORT` changes the output path of the source/live drift audit
report. Cloudflare API tokens, GitHub tokens, release-smoke expectations, and
deployment credentials belong in protected GitHub environments or the
operator's ephemeral process environment. Use the owning workflow and runbook;
do not aggregate them into `.env.local` or document their values.

## Safe `.env.example` policy

The committed example contains only a safe local Vite default and commented
browser routing examples. Add a variable there only if it is non-secret,
useful to ordinary local development, and its fallback cannot be mistaken for
full production isolation. Keep test ports, operator output paths, Worker
secrets, provider credentials, and live identifiers out.
