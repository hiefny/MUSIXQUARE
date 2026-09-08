# Beta dependency upgrade — 2026-09-09

The owner requested an experimental `mxqr_beta` branch starting from current
`main`, rather than upgrading production through the existing Dependabot PR.
The starting commit is `aa869dd0270bd203dae7d33138368ea5738a2c08` (8.6.8).
This branch identifies its build as **8.6.9-beta.0**, with cache epoch **v570**.
Neither a beta push nor a successful beta CI run authorizes production release.

## Version choices

Direct dependencies were checked against the npm registry on September 9.
The lockfile records the exact tested dependency graph. Major upgrades include:

| Tool | Previous installed version | Beta version |
| --- | --- | --- |
| Node.js | 24.13.1 | 24.20.0, current LTS patch |
| npm | 11.8.0 | 12.0.2 |
| Vite | 6.4.3 | 8.2.2 |
| TypeScript | 5.9.3 | 6.0.3 |
| typescript-eslint | 8.58.2 | 8.70.0 |
| Vitest and V8 coverage | 4.1.4 | 5.0.0 |
| jsdom | 28.1.0 | 30.0.1 |
| Playwright | 1.59.1 | 1.63.0 |
| Wrangler | 4.114.0 | 4.130.0 |
| esbuild | 0.25.12 | 0.28.2 |
| Prettier | 3.8.3 | 3.9.6 |
| ContentShield | 0.1.1 | 0.8.0 |
| Three.js | 0.184.0 | 0.186.0 |
| Satori | 0.26.0 | 0.33.4 |

ESLint, globals, PostCSS, lil-gui, subset-font, tsx, ws, and the corresponding
available type packages were also updated. The four SHA-pinned GitHub Actions
already matched their latest stable release tags and remain unchanged.

Intentional compatibility constraints:

- TypeScript 7.0.2 is outside typescript-eslint 8.70.0's supported range
  (`>=4.8.4 <6.1.0`). The compiler uses `~6.0.3` until its lint integration
  supports a newer compiler. No peer-dependency checks are bypassed.
- Node 24.20.0 is the current LTS patch. Node 26 is still the Current release
  line. `@types/node` stays at the latest available 24.x release, 24.13.3, to
  describe the actual runtime rather than APIs from a different major.
- `three-types-0162` describes two archived, non-production promotional studies
  that explicitly import Three.js 0.162.0. Later Three.js releases change their
  environment lighting and materials. Those studies retain matching runtime
  and types until a separate visual recalibration; the current npm-based
  promotional renderer uses the updated Three.js.
- Satori 0.33.4 directly pins vulnerable fflate 0.7.3. A targeted override uses
  patched 0.7.5, matching the existing OpenType override. The resulting audit
  reports no vulnerabilities, without forcing an unrelated fflate major change.

## Compatibility work

Vite now uses Rolldown configuration and chunk splitting. HTML and the service
worker are emitted through supported plugin APIs, with complete asset sources.
The application still targets Chromium 79 for JavaScript and CSS. The legacy
CSS transformation, initial transfer budgets, and optional font policy remain
in effect.

The service-worker manifest parser understands static template literals and
the empty-string `import.meta.url` coercion emitted by the new minifier. It
still rejects dynamic or external worker URLs and invalid JavaScript modules.
The fullscreen overlay guard checks all four physical zero edges without
depending on CSS declaration ordering.

TypeScript configurations no longer use deprecated `baseUrl` or Classic module
resolution. Classic browser scripts retain global scope with explicit legacy
module detection, and the existing import/declaration ownership checks remain
enabled. Wrangler's six generated declaration files were regenerated against
the existing Worker configurations; runtime compatibility dates and bindings
were not changed.

Vitest retains the previous mock-clearing behavior explicitly. Sequential
suites use the supported non-concurrent option. jsdom fixture assertions use
actual CSS semantics where its serialization changed. Test budgets and coverage
thresholds are retained. Prettier's formatting changes are included separately
from the small functional adaptations.

ContentShield's Korean dictionary moved from `profanity` to `words`. Adapting
the generator produces exactly the existing three regular-expression strings;
chat filtering and the English-only account-name policy are unchanged.

npm 12 install scripts are approved only for the exact installed esbuild and
workerd versions in `allowScripts`. Other dependency install scripts remain
subject to npm's approval mechanism.

## Validation and release boundary

Both `main` and `mxqr_beta` run the same CI checks. Only successful `main` push
runs can create production candidate metadata. Production Release and candidate
selection remain restricted to `main`; a regression test rejects beta CI as a
production candidate.

Local evidence is saved under `scratch/beta-upgrade-2026-09-09/`. Final CI status
and any remaining limitations must be checked before considering a future merge.
This experiment does not deploy or merge to `main`.
