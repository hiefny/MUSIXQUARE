# Grouped dependency update — 2026-10-11

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Evidence — dependency and toolchain update with its repository adaptations, not yet released                                                                                                                                                                                                                                                                                                                  |
| Applies to         | npm dependencies and GitHub Action pins from Dependabot PR #288, the App build, the large-audio container list, and the generated Worker type files                                                                                                                                                                                                                                                           |
| Last source review | 2026-10-11 (main `a2ba65c6`, tested code `5869e236`)                                                                                                                                                                                                                                                                                                                                                          |
| Executable sources | [package.json](../../package.json), [Dependabot policy](../../.github/dependabot.yml), [large-audio entry](../../src/player/large-audio/index.ts), [container pin](../../src/player/large-audio/__tests__/codec-support.test.ts), [legacy TV build guard](../../scripts/check-legacy-tv-build.mts), [service-worker manifest](../../scripts/service-worker-asset.ts), [Worker types](../../cloudflare/types/) |
| Related documents  | [Release record](../release-record.md), [2026-09-09 dependency upgrade](../beta-dependency-upgrade-2026-09-09.md), [release procedure](../hotfix-procedure.md), [version rules](../release-versioning.md)                                                                                                                                                                                                     |

## Status and release

[Dependabot PR #288](https://github.com/hiefny/MUSIXQUARE/pull/288)
(branch `dependabot/dependencies-e059956dae`, Dependabot commit `02ad0bb4`)
bumps 19 npm packages and three GitHub Actions. Its first CI run
([38074914866](https://github.com/hiefny/MUSIXQUARE/actions/runs/38074914866))
failed three jobs. Building the change also exposed a fourth failure that the
first run never reached. The adaptation commits on the PR branch are:

- `b467cc7e` — regenerated Worker types, the workerd install-script approval,
  the ESLint CI pin, and the Mediabunny notice.
- `5b56f4ac` — the large-audio container list without HLS, and its pin.
- `72d8ab51` — PWA cache `v648` (`scripts/service-worker-asset.ts` and the
  `index.html` bootstrap query).
- `5869e236` (`5869e236ba714044d84f116812a269d1e5a16458`) — merge of main `a2ba65c6`
  (PR #289). The verification below ran on this commit.

Not merged or deployed. Production remains `8.8.0` / `v646`. App SemVer stays
`8.8.0` in this change. No Worker source, wrangler configuration, D1, R2,
secret, binding, or protocol changes. The release record's undeployed-App item
covers this change. These local results are not the exact-main-SHA CI
candidate.

## Versions

| Package                            | Main                                                                                                                                                                           | This change                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| mediabunny (production dependency) | 1.59.0                                                                                                                                                                         | 1.61.3                                                         |
| vite (rolldown)                    | 8.2.2 (1.2.7)                                                                                                                                                                  | 8.3.3 (1.2.13)                                                 |
| wrangler (miniflare, workerd)      | 4.130.0 (5.20260908.0-alpha, 1.20260908.1)                                                                                                                                     | 4.148.0 (5.20261006.0-alpha, 1.20261006.1)                     |
| vitest, @vitest/coverage-v8        | 5.0.0                                                                                                                                                                          | 5.0.3                                                          |
| eslint / typescript-eslint         | 10.10.0 / 8.70.0                                                                                                                                                               | 10.12.0 / 8.71.1                                               |
| prettier                           | 3.9.6                                                                                                                                                                          | 3.9.9                                                          |
| @types/node                        | 24.13.3                                                                                                                                                                        | 24.19.1 (still the Node 24 line)                               |
| jsdom                              | 30.0.1                                                                                                                                                                         | 30.1.2                                                         |
| satori                             | 0.33.4                                                                                                                                                                         | 0.36.0                                                         |
| others                             | `@csstools/postcss-cascade-layers` 6.0.0, `@csstools/postcss-is-pseudo-class` 6.0.0, globals 17.12.0, postcss 8.5.28, subset-font 2.7.0, three 0.186.0, tsx 4.23.13, ws 8.21.3 | 6.0.2, 6.0.3, 17.13.0, 8.5.29, 2.9.0, 0.186.1, 4.23.15, 8.22.0 |
| GitHub Actions                     | setup-node v7.0.0, upload-artifact v7.0.1, download-artifact v8.0.1                                                                                                            | v7.1.0, v7.0.2, v8.0.2                                         |

Every SHA-pinned action reference matches its tag through
`gh api repos/actions/<name>/git/ref/tags/<tag>`: checkout v7.0.1
`3d3c42e5`, setup-node v7.1.0 `949feb24`, upload-artifact v7.0.2 `cf430e03`,
download-artifact v8.0.2 `9000827c`. Each is its repository's latest release.

In the lockfile, 78 package versions change and four entries are removed.
Mediabunny is the only production package that changes. TypeScript stays on
`~6.0.3` and `@types/node` on 24.x under the Dependabot ignore rules from
PR #285.

## Repository adaptations

1. **Worker types.** Wrangler 4.148.0 generates runtime types from workerd
   1.20261006.1. `types:workers:generate` rewrote all six
   `cloudflare/types/*.generated.d.ts` files. They now also declare Wrangler's
   module rules (`*.txt`, `*.html`, `*.sql`, `*.bin`, `*.wasm`), and the
   runtime types add APIs such as `CacheContext.invalidate`. `types:workers:check`
   and every Worker `tsc` project pass with them.
2. **Install scripts.** npm 12 runs install scripts only for exact versions in
   `allowScripts`. The workerd approval moves from `1.20260908.1` to the
   installed `1.20261006.1`. Without it, `npm ci` blocked workerd's postinstall.
   The two esbuild approvals (0.28.2, and 0.28.1 nested under Wrangler) still
   match the installed versions.
3. **ESLint pin.** `ci-quality-gates.test.ts` pins the ESLint range that loads
   both strict TypeScript ESLint configs. The pin moves from `^10.10.0` to
   `^10.12.0`. `npm run lint` loads both configs with ESLint 10.12.0 and
   jiti 2.7.0.
4. **Large-audio container list.** Mediabunny 1.61.0 added HLS variable
   substitution, which calls `String.prototype.replaceAll` (Chromium 85+).
   `openLargeAudioTrack` passed `ALL_FORMATS`, so the HLS demuxer was bundled
   into the large-audio chunk. `guard:legacy-tv-build` then rejected the
   Chromium 79 build: `large-audio-*.js contains unpolyfilled .replaceAll(`.
   The entry now passes Mediabunny's `ALL_FORMATS` minus `HLS`, in the same
   detection order. HLS only recognises an `#EXTM3U` playlist, so detection of
   every audio file is unchanged. A playlist is no longer opened as a manifest
   whose demuxer would fetch segments. The HLS code leaves the bundle: the
   large-audio chunk goes from 366.6 kB to 325.4 kB. `codec-support.test.ts`
   pins the list against `ALL_FORMATS`, so a Mediabunny release that adds a
   container fails the test instead of silently changing detection. The pin
   fails when the entry passes `ALL_FORMATS`.
5. **PWA cache.** Mediabunny, the Vite 8.3 build, and the container list are
   App runtime inputs. `SERVICE_WORKER_CACHE_VERSION` and the `index.html`
   bootstrap query move to `v648`. On a synthetic PR merge and a synthetic
   squash onto main, `guard:sw-cache-version` passes. Without the bump it fails
   exactly as CI did, naming `package.json` and `package-lock.json`.
6. **Notice.** `THIRD-PARTY-NOTICES.md` names Mediabunny 1.61.3 and links its
   tagged source revision `9d36fc57`. The MPL-2.0 text in `public/licenses/`
   is byte-identical to the package's `LICENSE`.

Mediabunny 1.59.1–1.61.3 release notes include parser fixes for containers
this App opens. Composition offsets in MP4 `trun` boxes are now always
parsed as signed, and Matroska segment duration is interpreted differently.
The unit suites and the Chromium parity suites below decode synthetic MP3,
FLAC, M4A (AAC LC, HE, HEv2, surround, leading edit list) and ADTS fixtures.
They do not include files written by faulty muxers.

## Overrides and audit

- Miniflare 5.20261006.0-alpha still pins sharp `0.35.4`, which is affected by
  [GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).
  The targeted `sharp: 0.35.5` override is still required, and it resolves.
- Miniflare now pins undici `7.29.1` itself. The `undici: 7.29.1` override is
  redundant but harmless. It was kept, so no audit-relevant input changed.
- Satori 0.36.0 still pins fflate `0.7.3`. The `fflate: 0.7.5` overrides for
  Satori and `@shuding/opentype.js` still apply.
- `npm audit` and `npm audit --omit=dev` report 0 vulnerabilities.
  `npm audit signatures` verifies 482 packages, 105 with attestations. There
  are 0 open Dependabot alerts.

## Verification

Environment: Windows 11 Pro 10.0.26200, Node 24.13.1 (the repository pins
24.20.0 for CI, which was not installed locally), npm 12.0.2 through Corepack
(it warns that it supports Node ^24.15.0), Vitest 5.0.3, TypeScript 6.0.3,
Playwright 1.63.0 Chromium. `node_modules` came from `corepack npm ci` in the
branch worktree with the PR lockfile.

All commands ran at `5869e236` with a clean working tree. Wall times are
local.

| Command                                                                           | Result                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run types:workers:check`                                                     | pass; all six Worker type files up to date (6 s)                                                                                                                                                                                                                                                                    |
| `npm run typecheck`                                                               | pass (52 s)                                                                                                                                                                                                                                                                                                         |
| `npm run lint`                                                                    | pass, 0 warnings (59 s)                                                                                                                                                                                                                                                                                             |
| `npm run format:check`                                                            | pass (23 s)                                                                                                                                                                                                                                                                                                         |
| `npm test`                                                                        | 535 files / 11,253 pass, 1 skip, 0 fail (191 s)                                                                                                                                                                                                                                                                     |
| `npm run test:coverage:critical`                                                  | 57 files / 1,943 tests pass, all thresholds met (54 s)                                                                                                                                                                                                                                                              |
| `npm run test:coverage:workers`                                                   | 37 files / 1,997 tests pass, all thresholds met (35 s)                                                                                                                                                                                                                                                              |
| `npm run test:coverage:tooling`                                                   | 13 files / 344 pass, 1 skip, all thresholds met (18 s)                                                                                                                                                                                                                                                              |
| `npm run build:checked`                                                           | pass (29 s), including `guard:sw-cache-version` (`v648`), `guard:legacy-tv-build`, and `guard:sw-app-shell` (90 assets)                                                                                                                                                                                             |
| `npm run check:worker-bundles`                                                    | pass; all six production Workers bundle with Wrangler 4.148.0 (9 s)                                                                                                                                                                                                                                                 |
| `npm audit` / `npm audit --omit=dev`                                              | 0 vulnerabilities / 0 vulnerabilities                                                                                                                                                                                                                                                                               |
| `npm run security:signatures`                                                     | 482 verified registry signatures, 105 verified attestations                                                                                                                                                                                                                                                         |
| CI static guards                                                                  | pass: `import-graph` (346 files, 0 cycles), `dead-exports` (test-only 21 / baseline 21, self-only 79 / baseline 79), `bus-pairing`, `source-complexity`, `standard-room-hot-path`, `room-authority-boundaries`, `chunk-pump`, `lifecycle-writes`, `developer-api-boundaries`, `d1-migrations`, `ops-drift-contract` |
| `npm run test:e2e:candidate`                                                      | 17 Chromium tests pass against the `build:checked` artifact (39 s)                                                                                                                                                                                                                                                  |
| `npm run test:e2e:critical`                                                       | 22 Chromium tests pass (64 s)                                                                                                                                                                                                                                                                                       |
| `playwright test` large-audio codec and AAC parity, hybrid file engine (Chromium) | 34 pass, at `72d8ab51` (72 s)                                                                                                                                                                                                                                                                                       |

The same ladder had already passed at `72d8ab51`, before main `a2ba65c6` was
merged in (`npm test` 535 files, 11,217 pass, 1 skip). An earlier run, made
before the container change and before the adaptations were split into the
three commits above, failed only `build:checked` at `guard:legacy-tv-build`.
That failure led to adaptation 4.

The local skip is the jq-dependent `release-deployment-state` case, which is
skipped when `jq` is unavailable outside CI. Remote CI skips the Windows-only
cross-drive case instead.

## Limits

- Local Node 24.13.1 is not the pinned 24.20.0. PR CI on Linux with the pinned
  runtime is the authoritative run, and the exact-main-SHA candidate still has
  to pass after merge.
- No physical-device or real-file check of Mediabunny 1.61.3 was made beyond
  the synthetic fixtures in the unit and Chromium parity suites. WebKit
  (iPhone) projects were not run.
- This change touches App runtime paths only. Wrangler bundles the App Worker
  at the next App release; the other Workers keep their Wrangler 4.130 bundles
  until they are next deployed. The partial-release gate does not treat the
  Wrangler version or the generated type files as runtime inputs of those
  Workers.
- Full E2E was not run.
