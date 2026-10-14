# Sharing action failure isolation and spacing — 2026-10-14

## Scope

The owner authorized fixing and deploying the two follow-ups recorded in the
[sender-action review](system-audio-sharing-actions-2026-10-14.md#post-release-review-follow-up--2026-10-14).
Base: `f4e95b23a5e4cbc717960166d953473c697df951`. Runtime/test implementation:
`5a03fc8b` (App 8.10.17, service-worker cache v683).

Previously, an optional motion factory exception was contained but left
`data-sharing` and Sync's accessibility state unapplied. A sender could see Media
while the accessible name and actual action were Stop Sharing. This was a
source-confirmed exceptional path, not a reported production outage or an
authorization bypass. Four separate CSS spacing expressions also encoded the
same 12px gap.

## Implementation

- The eager `bindSharingActionControls` controller owns `data-sharing`, Sync's
  native disabled/inert/aria-hidden state, focus transfer and teardown restoration.
  `player-controls` supplies current sender authority as before.
- Lazy motion owns measurement, hover locks, observers and timers only. It reads
  the previous geometry before the controller commits the new semantic state.
  Late registration seeds the latest state without replaying a transition.
- Each motion instance has a child AbortController. Factory or update exceptions
  abort partial decoration and disable further motion updates for that DOM
  generation; the controls keep working. Reinitialization creates a fresh
  generation. No retry loop or added network request is introduced.
- One `--play-action-gap` value owns CSS gap and width arithmetic. Motion reads
  computed columnGap, including zero. The Stop label also fits its final full
  button width when no measurement value exists.
- The controller exposes `data-motion-ready` only after successful factory and
  initial-state setup. Without it, controls use a static layout: collapsed Sync
  is excluded from the grid, and transitions are disabled. This prevents its
  hidden text from wrapping inside a zero-width item and enlarging Stop.
- Existing authority, pointer hover behavior, translations, iOS touch policy,
  native scrolling and media protocols are unchanged. No new dependency, schema,
  secret, binding, storage or compatibility floor is introduced.

## Validation

Local environment: Windows, Node 24.13.1, npm 11.8.0, Vitest 5.0.3. These checks
do not replace successful exact-main CI before deployment.

- Focused unit: motion/port 21, player controls 204 (including four new
  Standard/PRO factory/update-failure cases), UI source contracts 32 passed.
  Cases cover focus-before-hide, pre-existing accessibility policy restoration,
  absent/late factory, partial failure cleanup, role changes and actual Stop
  dispatch. New integration tests first ran after the implementation was already
  edited; no RED run is claimed.
- Independent read-only lifecycle review found no blocker in state ordering,
  late registration, partial initialization or reinitialization ownership.
- The earlier local runtime revision `6faaa995` (superseded before push by
  `5a03fc8b`, which adds the final readiness fallback) passed the full unit suite:
  562 files / 12,669 tests, zero failures/skips, 375.20 seconds. Typecheck,
  lint, format, Worker syntax, Developer API boundaries, D1/ops-drift contracts,
  source complexity and committed-HEAD checked build passed. The final readiness
  addition was then checked with all four affected unit files: 257 passed.
- The first Chromium run passed all 18 cases (five system-audio and 13 RTL/layout)
  in 1.3 minutes. Direct screenshot review nevertheless found that the injected
  failure made Stop 94px tall: hidden Sync text was growing the row. The final
  static fallback above fixes that finding, and the two failure browser cases now
  assert the expanded button does not exceed the original height. Initial
  artifacts are retained separately; this first run is not claimed as final
  visual acceptance.
- Final `5a03fc8b`: committed-HEAD `build:checked` and `build:e2e` passed. Entry
  418.0 KiB raw / 123.6 KiB gzip; eager JavaScript 457.4 KiB gzip; eager total
  1997.1 KiB raw / 532.0 KiB gzip; every budget retains its 5% minimum headroom.
- Final Chromium: **18 passed / 0 failed / 0 skipped**, 1.5 minutes. Both 390px
  and 1440px failure paths pass the height assertion, with no clipping; expanded
  and restored screenshots were inspected. Existing stationary-pointer hover,
  host/guest transport restoration and pending-picker replacement pass. The 13
  RTL/layout cases cover the authored transport layout, not a PRO SFU session.
  Logs and both initial/final screenshots are in local
  `scratch/sharing-fallback/`; the initial artifact folder was not overwritten.
- Final full typecheck, lint and format checks pass. Independent review of the
  readiness delta found no concrete regression in late setup, hover or abort
  ordering. The serial full E2E suite was not rerun for this bounded change.

Browser checks use actual application controllers and synthetic media capture.
The failure fixture injects an exception only when ResizeObserver observes the
action row, after the real motion factory has installed listeners and measured
it. The counter and warning prove the injected path was exercised. Narrow
Chromium layout is not physical iOS capture or an OS picker test. Existing
iOS 17.6.1 owner verification remains in the
[touch-policy report](shared-touch-policy-2026-10-14.md#owner-verification--2026-10-14).

## Release and recovery

Prepared App 8.10.17/v683, target `app`, Developer API D1 application `false`.
Production deployment is authorized; exact-main CI and the standard immutable
candidate, recovery checkpoint, compatibility and ownership checks are required.
No production deployment has yet been performed for this change.

An App-only rollback to a verified compatible baseline restores the previous
motion-dependent fallback and duplicated spacing; it does not repair the
exceptional path. No data migration is needed and existing recovery floors
remain binding. Actual run IDs, live smoke and ownership evidence follow after
the authorized release; documentation-only follow-ups need no further release.
