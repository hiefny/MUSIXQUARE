# Desktop action button width — 2026-10-16

## Scope

Owner-approved preview: Sync and Media should keep their existing maximum
160px width from the 1280px desktop breakpoint. Their height remains 56px and
their shared gap remains 12px. Mobile styling and sharing animation ownership
are unchanged.

The desktop action row already has a 332px preferred width inside an inset
secondary rail. Its additional `max-width: calc(100% - 80px)` narrowed that row
to 263px at a 1280×800 viewport, producing two 125.5px buttons. Use `max-width:
100%` so the existing parent rail provides the inset once. The row remains
centered and can still fit its parent. Sharing motion reads the resulting row
width through its existing ResizeObserver.

Release scope is App only, **8.10.27 / v693**, with Developer API D1 application
disabled. There are no dependency, schema, secret, binding or protocol changes.
Mixed client versions are compatible. Reverting this CSS change restores the
previous narrower desktop buttons; existing release recovery floors apply.

## Verification

Local and branch checks are pending. Record the tested source SHA, environment
and actual pass/fail/skip limits here before merging. The preview used actual
production DOM with a browser-only style override; it was not a release test.

## Release and recovery

Pending the reviewed PR, successful exact-main CI candidate and App release.
