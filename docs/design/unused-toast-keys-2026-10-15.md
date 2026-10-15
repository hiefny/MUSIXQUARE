# Unused toast keys — 2026-10-15

## Scope and evidence

While shortening verbose toast translations (8.10.23), five toast keys turned
out to have no caller. A full check then found twelve `toast.*` keys that
nothing outside the locale dictionaries references:

- `toast.device_connected`
- `toast.distortion_warn`
- `toast.host_only`
- `toast.host_only_control`
- `toast.host_only_file`
- `toast.host_only_media`
- `toast.host_only_youtube`
- `toast.host_sync_not_recommended`
- `toast.host_sync_requested`
- `toast.invite_code`
- `toast.operator_required`
- `toast.yt_host_sync_sent`

How the check worked:

- Each `toast.*` key was searched with `git grep`, in single and in double
  quotes, across the whole repository except the `src/i18n/*.ts` dictionaries
  and `docs/`. This covered source, HTML `data-i18n` attributes, scripts, the
  workshop pages and tests.
- `src` and `browser` were searched for keys built at run time
  (`toast.${…}`, `'toast.' +`). There were none.
- Only tests used `toast.device_connected`:
  - three interpolation tests in `src/i18n/__tests__/i18n.test.ts` used it as a
    sample key;
  - a Korean presence-message pin in `src/i18n/__tests__/translations.test.ts`.

Owner decision (2026-10-15): remove the keys and ship the cleanup.

## Change

- The twelve keys are removed from all 42 locales: 504 entries, 540 lines,
  some wrapped by Prettier. None had plural forms.
- The interpolation tests use the live `toast.device_disconnected` instead.
- The Korean presence pin drops the removed key and keeps the two chat presence
  messages.
- The `t()` usage example in `src/i18n/index.ts` uses
  `toast.device_disconnected`.
- The toast copy guard takes `toast.*` keys from the English dictionary, so it
  now checks 195 toast keys: 62 `toast.*` and 133 shared.
- Release identity: 8.10.24, cache epoch v690.

## Verification

Environment: Windows 11 Pro local worktree, Node 24.13.1 (the repository pins
24.20.0, which pull request CI uses), Vitest 5.0.3, Playwright 1.63.0 with
Chromium.

Tested source: **`57a00519c34692326071144ca8344518e2721e50`** (8.10.24, cache
epoch v690), branch `agent/remove-dead-toast-keys`, clean tree before and after
the run. Later commits merge documentation-only main commits and add
documentation. These are local and branch results, not the exact-main release
candidate.

| Check | Result |
| --- | --- |
| Full `vitest run` | 564 files, **12,734 passed / 0 failed / 0 skipped**, 178.92 s |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed, zero lint warnings |
| `npm run test:e2e:critical` | **29 passed / 0 failed / 0 skipped / 0 flaky**, 1.3 min |
| `guard:sw-cache-version`, `guard:release-identity` | Passed (v690 covers every runtime change) |

`tsc` confirms that no code names a removed key, because the dictionaries are
typed by `I18nKey`.

## Limits

- The check covers this repository only. A key referenced only by an external
  system would now render as its raw key name. No such use is known.

## Release and recovery

App-only release (`target=app`). Recovery is the ordinary Production Release
rollback to the 8.10.23 checkpoint, which brings the unused keys back.
