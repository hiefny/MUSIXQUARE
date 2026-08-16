# 저장소 전체 TypeScript 전환 로드맵

상태: **accepted execution plan**
목표: 직접 작성 `.js`, `.mjs`, `.cjs`, `.jsx` 소스 0개

## 1. 출발점과 범위

2026-08-17 역사적 기준선은 다음과 같다. 줄 수는 LF 수(`wc -l`과 같은 방식)로
고정하여 운영체제에 관계없이 재현한다.

| 영역                 |    파일 | 기준선 줄 수 | 실행 경계                                      |
| -------------------- | ------: | -----------: | ---------------------------------------------- |
| `cloudflare/**/*.js` |      25 |       49,369 | Workers, Durable Objects, 공유 보안·wire 모듈  |
| `scripts/**/*.mjs`   |      55 |       17,197 | 검사, 생성, smoke, release와 recovery          |
| `public/**/*.js`     |      16 |       10,660 | classic browser runtime, admin, Service Worker |
| `public/**/*.jsx`    |       9 |          302 | 디자인 시스템의 브라우저 Babel UI kit          |
| `eslint*.config.js`  |       2 |          265 | lint 설정                                      |
| **합계**             | **107** |   **77,793** | JS/MJS 98개 77,491줄 + JSX 9개 302줄           |

파일 단위 근거는 `authored-js-baseline.json`이다. HTML 안의 실행 가능한 inline script는
`authored-inline-js-baseline.json`과 `guard:authored-inline-js`가 별도로 shrink-only 관리하며,
파일 기준선에 포함되지 않지만 최종 단계에서 별도로 추출·제거한다. `package.json`이나
workflow의 `node -e` 실행 문자열도 같은 원칙으로 `.mts` 도구로 옮긴다. JSON-LD 같은
데이터 script와 외부 vendor URL은 직접 작성 실행 소스가 아니므로 예외다.

## 2. 절대 불변식

1. **동작 보존:** rename/type 작업에서 HTTP status/header/body, WebSocket frame, token
   byte sequence, storage key/schema를 바꾸지 않는다.
2. **런타임 검증 유지:** request JSON, D1 row, Durable Object storage, WebSocket 및 외부
   API 결과는 `unknown`에서 runtime validator로 좁힌다. TypeScript만 믿지 않는다.
3. **배포 계약 보존:** Wrangler binding, secret 이름, route, compatibility date, Durable
   Object export와 migration을 언어 전환과 함께 바꾸지 않는다.
4. **엄격성 우회 금지:** `@ts-nocheck`, 광범위한 `@ts-ignore`, 대량 `any`, 무근거 이중
   assertion을 진척으로 계산하지 않는다. 불가피한 경계 cast는 좁게 두고 이유를 기록한다.
5. **구조 보존 우선:** 큰 Worker는 타입 전환과 분해를 분리한다. 독립 lifecycle, 공유 계약,
   보안/wire 불변식, 실제 lazy/Worker/DO 경계가 있을 때만 추출한다.
6. **상시 배포 가능:** 각 병합 단위에서 main의 기존 release/recovery 경로가 유효해야 한다.
7. **안전장 선행:** 배포 도구와 그 도구가 배포하는 Worker를 같은 PR에서 동시에 전환하지
   않는다.

## 3. 목표 아키텍처

### Cloudflare

- Worker마다 독립 `Env`와 독립 typecheck 경계를 둔다. 서로 다른 compatibility date와
  binding을 하나의 전역 Env로 합치지 않는다.
- 각 Wrangler 설정에서 생성한 runtime type을 별도 파일로 유지하고 `wrangler types
--check`로 drift를 차단한다.
- Wrangler는 `.ts` entry를 직접 bundle하며 생성 JS는 추적하지 않는다.
- 기존 수기 `.d.ts` companion은 구현이 strict TS가 되는 순간 삭제한다.

### Node 도구

- `.mjs → .mts`로 전환하고 Node 24의 erasable TypeScript 실행 경계를 사용한다.
- 타입 검사는 실행과 별도인 `tsc --noEmit` 단계로 강제한다.
- `enum`, parameter property처럼 런타임 변환이 필요한 문법은 사용하지 않는다.
- release mutator는 stdout/stderr/exit code와 mutation authorization을 fixture로 먼저
  고정한다.

### 브라우저 정적 런타임

- TypeScript 원본은 `public/` 밖의 source 디렉터리에 둔다. `public/`은 Vite가 변환하지
  않고 복사하므로 raw `.ts`를 배치하지 않는다.
- 빌드가 `/admin.js`, `/bootstrap.js`, `/service-worker.js`, `/events/event.js` 등 기존의
  안정 URL을 `dist/`에 생성한다.
- classic/defer 실행 순서, CSP, bootstrap 동기성, Service Worker registration 형식과
  cache epoch 계약을 유지한다.
- Service Worker는 DOM lib와 분리한 WebWorker 전용 typecheck 경계를 갖는다.

### 설정과 JSX

- 디자인 시스템 JSX는 build-time TSX entry로 전환하고 브라우저 Babel standalone을
  제거한다.
- ESLint 설정은 마지막에 TypeScript로 옮겨 release 경로가 안정된 상태에서 설정 loader
  호환성을 검증한다.

## 4. 실행 단계

### Phase 0 — 기준선과 안전망

- authored JS manifest와 shrink-only guard 도입
- 새 JavaScript 계열 파일 증가 금지
- strict 진단을 파일/오류 코드별 shrink-only baseline으로 수집
- path 기반 guard와 coverage가 `.js/.ts`, `.mjs/.mts`를 전환 기간에 모두 인식
- 기존 전체 CI와 bundle 기준선 보존

완료 기준: 생산 동작 변경 없이 안전망이 main의 필수 게이트가 된다.

### Phase 1 — TypeScript 기반

- Worker별 generated runtime type과 독립 tsconfig
- tooling, browser classic, Service Worker, TSX용 typecheck 경계
- Worker entry/path 계약의 중앙 manifest
- stable browser-output canary

완료 기준: 아직 전환하지 않은 JS를 허용하면서 모든 새 TS 경계를 strict하게 검사한다.

### Phase 2 — strict-clean Cloudflare leaf

순서: `pro-room-body`, `pro-room-generation`, `pro-room-validation`, `pro-room-effects`,
`pro-room-queue-mode`, `pro-room-permissions`.

한 PR에 1~3개 모듈만 전환하며 대응 `.d.ts`, import 경로, 소비 Worker 테스트와 bundle
dry-run을 원자적으로 갱신한다.

### Phase 3 — wire와 security 계약

순서: `pro-room-crypto`, `display-name-policy`, `account-nickname`, `account-assertion`,
`standard-room-account-assertion`, `remote-share-upload-assertion`, `signaling-protocol`,
`pro-room-claims`.

claim/token golden vector, legacy/current generation, expiry/revocation, authority epoch,
WebSocket discriminated union과 직렬화 스키마를 고정한다.

### Phase 4 — 중형 공용 모듈

순서: `service-control-object`, `service-maintenance`, `account-auth`, `pro-room-grants`,
`pro-bot`.

JS 상태에서 strict 진단을 0으로 만든 뒤 rename한다. 여러 Worker가 소비하는 모듈은 영향
서비스 전체의 bundle과 smoke 범위를 적용한다.

### Phase 5 — 작은 Worker entry

배포 순서: Developer API Facade → Developer API → Remote Share → Signaling.

Worker 하나씩 Env, DTO, D1 row, DO storage 타입을 확정하고 Wrangler `main`을 변경한다.
Facade/API는 하나의 호환성 단위로 취급한다. Signaling은 hibernation attachment,
first-frame auth, reconnect/alarm, superseded-socket fencing과 ordered protocol trace를
추가로 검증한다.

### Phase 6 — PRO Worker

먼저 storage key/schema, hibernation attachment, owner/session/permission transition,
alarm retry, media ledger, tombstone, idempotency replay를 characterization test로 고정한다.
strict 진단은 작은 묶음으로 제거하고 0이 된 후 `.js → .ts` rename-only PR을 만든다.
DO lifecycle을 공유하는 mutation은 줄 수를 줄이기 위해 분리하지 않는다.

### Phase 7 — App Worker

Assets/R2/KV, 세 D1 DB, service binding, OAuth/session, admin mutation,
capability/rate-limit/CORS, scheduled cleanup, static cache와 sanitization 경계를 타입화한다.
route/method/status/header matrix와 auth/CSRF, cron, proxy buffering, XSS 테스트를 먼저
고정하고 strict 0 이후 entry를 rename한다.

### Phase 8 — 브라우저 런타임

순서: 작은 정적 script → landing/event/i18n → Admin → bootstrap → Service Worker.

테스트는 source가 아니라 생성된 `dist/*.js`도 실행한다. Service Worker는 install,
activate, fetch, message, range response, offline navigation, multi-tab cache retirement를
검증한다. 문제 발생 시 cache version을 낮추지 않고 더 높은 epoch의 forward fix를 낸다.

### Phase 9 — Node 운영 도구

순서: 순수 parser/library → read-only guard → generator → live smoke → claim/key/admin CLI
→ release evidence/manifest → recovery/floor/R2 → deployment state/ops drift/emergency deploy.

package script, workflow, 테스트와 문서에 박힌 호출 경로는 대상 `.mts`와 같은 PR에서
바꾼다. 생산 Worker의 전환 PR에는 해당 Worker를 배포하는 release mutator 전환을 넣지
않는다.

### Phase 10 — JSX, inline JS, 설정과 청소

- JSX 9개를 TSX로 전환하고 browser Babel 제거
- 실행 가능한 inline JS를 TypeScript entry로 추출
- package/workflow의 실행 가능한 `node -e` 문자열을 명명된 `.mts` 도구로 교체
- ESLint 설정 TypeScript화
- 수기 companion declaration, `allowJs/checkJs`, 전환용 dual-path와 진단 baseline 제거
- authored JS guard가 빈 remaining inventory를 강제하도록 유지

## 5. PR 검증 행렬

모든 PR은 관련 범위의 focused test 외에 아래에서 영향받는 경계를 수행한다.

| 변경 경계            | 필수 증거                                                                     |
| -------------------- | ----------------------------------------------------------------------------- |
| 모든 전환            | authored-JS guard, strict typecheck, lint, format, focused test               |
| Cloudflare 공용 모듈 | 모든 소비 Worker typecheck, unit/coverage, Wrangler dry-run                   |
| Worker entry         | generated types check, production dry-run, deploy smoke, rollback target 확인 |
| Browser runtime      | stable output URL, source-map 없는 production policy, built JS contract test  |
| Service Worker       | cache/app-shell guard, offline/range/multi-tab E2E                            |
| Node release 도구    | CLI fixture, exit code, dry-run, checkpoint/recovery 테스트                   |

coverage 경로가 바뀌어도 threshold 숫자는 낮추지 않는다. `.js`와 `.ts`의 이중 구현을
남기지 않으며 생성된 JS를 Git에 커밋하지 않는다.

## 6. 배포와 롤백

- 임시 URL을 억지 canary로 만들지 않는다. 기존 exact-SHA release, checkpoint,
  smoke와 자동 복구 계약을 사용한다.
- 공유 모듈을 함께 바꾼 전체 전환은 exact-SHA `target=all` release 안에서 dependency
  순서대로 배포하고, mutation authorization과 immutable checkpoint 뒤에만 production을
  변경한다.
- 배포 성공 뒤 작은 Worker와 Signaling은 24시간, PRO/App은 48~72시간, Service Worker는
  최소 한 cache generation을 운영 관찰한다. 이 관찰은 완료된 source migration을 다시
  미완료로 만드는 시간 기반 gate가 아니라 회귀 발견 시 rollback/forward-fix를 시작하는
  post-release 운영 절차다.
- 공유 모듈 변경은 한 소비 Worker만 부분 배포하지 않는다.
- 실패 시 기준 SHA의 immutable Worker version으로 되돌린다. storage/migration과 wire
  format을 건드리지 않았다는 불변식이 rollback 가능성의 전제다.

## 7. 최종 완료 정의

- tracked authored `.js/.mjs/.cjs/.jsx` 0개
- 실행 가능한 authored inline JS 0개
- Wrangler entry 6개 모두 `.ts`
- 모든 runtime/tooling config가 strict이며 `allowJs/checkJs` 제거
- `@ts-nocheck` 0, 설명 없는 `@ts-ignore`와 신규 explicit `any` 0
- 외부 데이터 runtime validator 유지
- companion `.d.ts/.d.mts` 제거 또는 실제 외부 declaration만 명시적 예외
- 기존 coverage floor, 전체 CI와 여섯 Worker production dry-run 통과
- exact-SHA release 안의 서비스 순차 배포, production smoke와 live drift 검증 완료
- post-release 관찰 시작 시점과 대응 절차가 `STATUS.md`에 기록됨
- `STATUS.md`의 모든 단계가 complete이고 manifest의 모든 항목이 `retired`
