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

App **8.10.24/v690** shipped through
[Production Release 38727700806](https://github.com/hiefny/MUSIXQUARE/actions/runs/38727700806),
attempt 1, target `app`, Developer API D1 application `false`. The deploy job
completed successfully at **2026-10-15 20:32:04 KST** using the immutable candidate
from exact-main CI `38726918203` for `31c3b19c6f792185ba24ca0138dc1c5836430fbf`.
No rollback was needed; the recovery job was skipped.

- Exact-main CI ran 11 jobs: 564 unit files, 12,733 passed / 0 failed / 1 skipped
  (the Windows-only cross-drive path check on Linux), 17 candidate browser and
  29 critical browser tests passed, and every coverage, static and build gate
  passed. The Codex review of pull request #352 completed with no findings.
- App version `62e7e692-4ad6-4b6d-8992-4b079285c161` became
  `a6827c11-21e2-4305-bd79-a671e058abd1`. Final deployment ownership was verified
  at 20:31:57.252 KST, and the coherent production marker records the exact SHA
  and target `app`.
- The partial-release compatibility recheck at 20:31:25.835 KST was compatible.
  The five unselected Workers were not deployed and keep the `d9364cd9`
  identities in `docs/release-record.md` §1; the PRO smoke re-read pro-room
  `8d5d44c0`. The new App deployment identity is in the 90-day run artifact
  `production-deployments-31c3b19c6f792185ba24ca0138dc1c5836430fbf-38727700806-1`.
- App generation (`main-C_faCbku.js`, 27 assets converged), anonymous App account
  boundary, current PRO public boundary and Standard HTTPS signaling smokes
  passed. Out-of-scope Worker smokes were skipped, not counted as passes.
- Public checks at 20:32 KST returned HTTP 200 for `/`, the v690 service worker,
  `bootstrap.js?cache=v690`, `main-C_faCbku.js` and `main-BNiplmKU.css`. The
  public English bundle has none of the removed keys and still has
  `toast.device_disconnected`.
- [Operations Drift Audit 38728043443](https://github.com/hiefny/MUSIXQUARE/actions/runs/38728043443)
  succeeded. Its 20:32:45.085 KST report records **31 pass / 0 fail / 5 manual-only**;
  manual checks are not treated as completed.

The immutable recovery checkpoint captured at 20:30:44.543 KST
(`production-recovery-checkpoint-31c3b19c6f792185ba24ca0138dc1c5836430fbf-38727700806-1`)
preserves the previous App `5903ed41205e2a165c4bcbce5f7c2d6590abf0b5`, 8.10.23/v689,
version `62e7e692-4ad6-4b6d-8992-4b079285c161`. Rolling back to it only brings the
unused keys back into the dictionaries; what users see does not change. Mixed
versions are safe. The checkpoint is not a user-data backup; no data migration
is needed and existing recovery floors remain binding.
