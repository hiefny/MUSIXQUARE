# Documentation Truth Audit — 2026-08-17

Status: completed repository and public-copy audit record

This is a dated evidence ledger, not a substitute for current source, tests, or
operations runbooks. Runtime code and Cloudflare configuration take precedence,
followed by executable tests and guards, then maintained contract documents.

## Scope and method

The audit enumerated all 59 tracked Markdown files, including the 47 files under
`docs/` and the three Cloudflare operations guides. It also reviewed the five
production editorial HTML sources under `.workshop/`, the public Developer API
OpenAPI document, the sitemap, the public design-system guide, and all 17 About
page locale catalogs.

Maintained documents and public copy were compared with the current TypeScript
sources, Wrangler configuration, D1 schemas and migration manifests, release
workflow, repository guards, and focused contract tests. Dated historical
records were preserved as history; only a maintained addendum or an unlabelled
claim that could be mistaken for today's contract was corrected.

The source review does not prove dashboard-only Cloudflare or GitHub settings,
live D1 contents, physical-browser media behavior, or every external-provider
matching rule. Those boundaries remain explicit manual checks in the relevant
runbooks.

## Corrections made

- Separated temporary standard-room browser-host/P2P behavior from persistent,
  server-authoritative PRO behavior across the README, About, FAQ, policy, and
  design-system surfaces.
- Documented System Audio Sharing and the 17-language picker as Beta, including
  the current desktop-Chromium, four-device, and two-hour System Audio limits.
- Corrected PRO access to include both direct operator issuance and one-time
  vouchers from operator-run campaigns, with no paid plan, public checkout, or
  subscription. Added the account, voucher-digest, entitlement, allocation,
  redemption, audit, and retention disclosures to the privacy contract.
- Replaced the former browser-coordinator Developer API narrative with the
  current server-owned command/timeline model, including sleeping-room command
  handling and explicitly labelled v1 compatibility result names.
- Corrected queue identity, playback state, persistence-v2, system-audio sync,
  RAM-only browser working-set, AudioBuffer admission, and completed TypeScript
  migration descriptions without rewriting their historical rationale.
- Reconciled operations guides with the four admin-D1 binding consumers, 17
  metric events, 18-table admin schema, Remote Share public routes, Worker
  metadata bindings, exact release ordering, and current rollback/version
  monotonicity rules.
- Distinguished repository-only documentation publication from hosted
  `public/**` and `.workshop/**` publication. Hosted copy requires an App
  candidate, a monotonic service-worker cache epoch, exact-main-SHA CI, and the
  approved App production release.

## Release impact

No playback, authority, storage, protocol, or authorization implementation was
changed by this audit. Runtime-source edits are limited to public About-page
copy and release identity mirrors. The hosted editorial changes advance product
version `8.3.65` and service-worker cache epoch `v447`; repository-only documents
would not have required a Cloudflare release on their own.

## Verification contract

Before publication, the final committed tree must pass the Markdown link and
diff-whitespace checks, focused public-copy/API contract tests, the full unit
suite, typecheck, lint, format check, Worker checks, release-identity/version
guards, and `build:checked`. Because the service-worker history guard reads
committed first-parent `HEAD`, `build:checked` must be rerun after the release
commit, not only against the working tree.

The exact merge-SHA `main` push CI result and the subsequent App production
release/live-smoke record are the authoritative deployment evidence.

## Local verification result

The final pre-commit working tree passed the relative Markdown-link and
diff-whitespace checks, 34 focused public-copy/API contract tests, all 5,874
unit tests in 334 files, typecheck, lint, format checks, Worker checks, release
identity (`8.3.65` / `v447`), and `build:checked`. The committed-HEAD cache
history check is intentionally repeated after the release commit.
