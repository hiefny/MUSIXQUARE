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

## Local Vite dev/preview controls

| Variable                                 | Accepted value / default                                  | Effect                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `MUSIXQUARE_DEV_PROXY_PRODUCTION_API`    | Exact `true` after trim/case normalization; default false | Enables dev-server forwarding only for the six routes listed below. Preview never forwards them and returns `503`.             |
| `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` | Exact trusted hostname                                    | Lets Vite accept a one-off trusted tunnel hostname without disabling DNS-rebinding protection globally. Do not use a wildcard. |

The opt-in proxy route set is:

- `/api/security-config`
- `/api/capability-challenge`
- `/api/capability-token`
- `/api/youtube-search`
- `/api/youtube-playlist-entry`
- `/api/youtube-playlist-manifest`

With the flag disabled, other unconfigured relative `/api/*` requests receive
`503 LOCAL_API_NOT_CONFIGURED`. Preview applies the same fail-closed responses
regardless of the dev-only proxy flag. Both responses are non-cacheable and
take precedence over the SPA fallback.

## Public browser build and routing inputs

| Variable                                              | Values / validation                                                                                              | Fallback and ownership                                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MUSIXQUARE_TRANSPORT`                           | `auto`, `peerjs`, or `cloudflare`; other values normalize to `auto`                                              | Localhost chooses PeerJS when no signaling URL is configured. Public hosts always choose Cloudflare.                                                                     |
| `VITE_MUSIXQUARE_SIGNALING_URL`                       | Non-empty primary base; configure an absolute credential/query/hash-free `ws:`, `wss:`, `http:`, or `https:` URL | The primary value is not prevalidated like the fallback. Socket construction converts HTTP schemes to WebSocket schemes; public hosts use the canonical URL when absent. |
| `VITE_MUSIXQUARE_SIGNALING_FALLBACK_URL`              | Same protocol and path as the primary URL, but a genuinely different origin                                      | Invalid or same-origin values are ignored. It is the bounded iOS route-handoff escape path, not a general retry alias.                                                   |
| `VITE_MUSIXQUARE_ALLOW_LOCAL_PRODUCTION_API_FALLBACK` | Exact `true` after trim/case normalization; default false                                                        | Lets a non-E2E loopback app origin retry canonical production for PRO, TURN, and Realtime. Public production/staging fallback is unchanged.                              |
| `VITE_PRO_ROOM_ENDPOINT`                              | Canonical production facade, root of an HTTPS `*.musixquare.com` service, or loopback origin                     | A valid override is explicit. Without one, loopback uses same-origin `/api/pro-room`; public origins fall back to the production facade.                                 |
| `VITE_MUSIXQUARE_LOG_LEVEL`                           | `DEBUG`, `INFO`, `WARN`, `ERROR`, or `SILENT` (case-insensitive)                                                 | Resolution order is build input, query parameter, local storage, then default. Production defaults to WARN; localhost development defaults to DEBUG.                     |

Runtime-injected `window.__MUSIXQUARE_TRANSPORT__` and
`window.__MUSIXQUARE_PEER_SERVER__` settings can override browser transport
configuration. They are public runtime state and follow the same no-secret
rule.

## Local isolation matrix

| Path or flow                          | Default local behavior                                              | Isolation action                                                                                |
| ------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Ordinary UI, playback, and state work | No Cloudflare credential is required                                | Avoid entering protected network flows                                                          |
| Six Vite production-proxy routes      | Local `503`; dev can explicitly proxy, preview cannot               | Keep the flag false and mock the route if needed                                                |
| Other relative `/api/*` routes        | Local `503 LOCAL_API_NOT_CONFIGURED`                                | Add a local mock/Worker rather than relying on SPA fallback                                     |
| Standard-room signaling               | Loopback selects PeerJS                                             | Setup intent may request TURN, but its unconfigured same-origin API boundary returns `503`      |
| TURN and Realtime/SFU API             | Loopback tries only the relative route, which returns local `503`   | Mock the route, provide a complete local boundary, or explicitly enable the production fallback |
| PRO facade                            | Missing or invalid override resolves to same-origin `/api/pro-room` | Set a validated loopback endpoint backed by the required local services, or mock the flow       |
| E2E browser clients                   | E2E ignores the implicit fallback flag for PRO, TURN, and Realtime  | Keep E2E mocks/servers local; only a validated explicit PRO endpoint override takes precedence  |

The Vite proxy flag controls only its six named routes. The browser fallback
flag independently permits loopback PRO, TURN, and Realtime clients to retry
the canonical production origin; it does not install a Vite proxy. A validated
external `VITE_PRO_ROOM_ENDPOINT` is also explicit and bypasses the default
loopback same-origin route. Treat either choice as production-affecting and
remove it after the integration run. Public production and staging origins
retain their canonical fallback without this local-only opt-in.

All `VITE_*` values are compiled into the browser bundle. Restart the dev
server after changing one, and rebuild before testing a preview bundle.

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

### App build floor (from App 9.0.14)

The minimum App build that the Signaling and PRO Workers admit is runtime state
in the service-control object, not a build input, a Wrangler `[vars]` entry or a
secret. It defaults to 0 (off), which is also what local Workers, the C5-0 lab
and `vite` development use. It changes only through these workflow inputs; the
procedure is in the [hotfix procedure](hotfix-procedure.md#app-build-floor).

| Input                                                           | Contract                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App Build Floor` workflow: `action`, `min_app_build`, `reason` | `status`, `check`, `set` or `lower` on `main` in the production environment. `min_app_build` is a cache-epoch build (`lower` to 0 turns the floor off); `reason` is kept in the floor history. The inputs reach `scripts/app-build-floor.mts` only through the environment. |
| `Production Release` input `raise_app_build_floor`              | Boolean, default false, target `app` or `all` only. After the commit marker it raises the floor to the released build when that build is the live App.                                                                                                                      |
| `MXQR_APP_BUILD_FLOOR_REASON`                                   | Set by the workflow from its `reason` input and read by the floor script. Not an operator setting.                                                                                                                                                                          |

The setter authenticates with the GitHub OIDC token that the job's
`id-token: write` permission lets the runner request
(`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, provided by
GitHub and never printed). No repository secret, Worker secret or binding was
added, so `cloudflare/ops-drift.contract.json` is unchanged. The App's build
number is not configurable: it comes from `SERVICE_WORKER_CACHE_VERSION` at
build time ([release versioning](release-versioning.md#app-build-number-and-floor)),
and the `X-MXQR-App-Build` request header that carries it is public.

## Safe `.env.example` policy

The committed example contains only a safe local Vite default and commented
browser routing examples. Add a variable there only if it is non-secret,
useful to ordinary local development, and its fallback cannot be mistaken for
full production isolation. Keep test ports, operator output paths, Worker
secrets, provider credentials, and live identifiers out.
