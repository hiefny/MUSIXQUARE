# TypeScript 전환 상태

최종 갱신: 2026-08-17
판정: **완료 — production 배포와 live drift 검증 완료**

최초 production 전환 release SHA: `674b77d297022f66c6d4c8138ef3a9207378dda8`

## 수치

역사적 기준선은 직접 작성 JavaScript 계열 107개, 77,793줄이다. 이 중 JS/MJS는
98개 77,491줄이고 JSX는 9개 302줄이다. 기계 판독 가능한 authoritative 값은
`authored-js-baseline.json`이다.

| 상태      | 전체 파일 | JS/MJS | JSX | 역사적 줄 수 합계 |
| --------- | --------: | -----: | --: | ----------------: |
| initial   |       107 |     98 |   9 |            77,793 |
| remaining |         0 |      0 |   0 |                 0 |
| retired   |       107 |     98 |   9 |            77,793 |

실행 가능한 authored inline JavaScript도 역사적 8개 블록에서 0개가 됐다.
`guard:authored-js-inventory`와 `guard:authored-inline-js`가 두 0 상태의 역행을 CI에서
차단한다.

`dist/`, Wrangler bundle과 다음 ignored E2E 파일은 TypeScript 원본에서 재현되는 생성물이라
authored source가 아니다.

- `e2e/report-viewer.js`: `browser/auxiliary-runtime/report-viewer.ts`에서 materialize
- `e2e/e2e-report-data.js`: `e2e/live-reporter.ts`가 테스트 결과를 materialize

## 단계 현황

| 단계                   | 상태     | 종료 증거                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| 0. 기준선과 안전망     | complete | permanent zero-JS/inline-JS guard와 CI 통합                        |
| 1. TS 기반             | complete | 6개 격리 Worker Env project와 browser/SW/tooling strict 경계       |
| 2. strict-clean leaf   | complete | leaf strict, coverage와 Worker bundle 통과                         |
| 3. wire/security       | complete | token golden, protocol validator와 Worker bundle 통과              |
| 4. 중형 공용 모듈      | complete | auth/grants/bot/control strict와 전체 소비자 검증                  |
| 5. 작은 Worker entry   | complete | Facade/API/Remote Share/Signaling 배포와 smoke                     |
| 6. PRO Worker          | complete | strict 0, generated Env/DO contract, production 배포와 smoke       |
| 7. App Worker          | complete | exact 19-binding contract, production 배포와 public boundary smoke |
| 8. browser runtime     | complete | stable URL dev/build, compiled behavior와 Service Worker v446      |
| 9. Node tooling        | complete | 55개 `.mts`, release/recovery fixture와 native Node 실행           |
| 10. JSX/config/cleanup | complete | JSX/Babel/inline JS 제거, TS ESLint config, legacy type 장치 제거  |

## 완료 증거

- 추적 및 비무시 authored `.js/.mjs/.cjs/.jsx`: 0개
- Wrangler production entry: 6/6 `.ts`; generated Env drift check와 production dry-run 6/6 통과
- runtime/tooling project: 19개 strict `tsc` project가 tracked/new-unignored TS-family 815개를 모두 포함
  (non-declaration source 805개 + reviewed generated/external declaration 10개), `allowJs/checkJs` 없음
- production TypeScript: explicit `any`, `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error` 0
- 수기 JS companion declaration: 0; 남은 `.d.ts`는 Wrangler 생성 타입, Vite/외부 모듈 및
  타입이 없는 외부 패키지 declaration뿐
- 전체 단위 테스트: 334 files / 5,874 tests
- 전체 coverage: statements 80.47%, branches 74.12%, functions 87.97%, lines 84.04%
- Worker coverage: 22 files / 1,189 tests; 기존 모든 floor 유지
- Chromium critical E2E: 5/5
- build, stable browser assets, Service Worker app-shell, six Worker bundle dry-run 통과
- [PR #69](https://github.com/hiefny/MUSIXQUARE/pull/69) merge
- [exact-SHA main CI](https://github.com/hiefny/MUSIXQUARE/actions/runs/31977011967) 9/9 통과
- [production `target=all` release](https://github.com/hiefny/MUSIXQUARE/actions/runs/31977169304)
  성공: checkpoint와 mutation authorization 뒤 여섯 Worker 순차 배포, 모든 live smoke와
  final ownership 통과, rollback/recovery 미실행
- [post-release live drift audit](https://github.com/hiefny/MUSIXQUARE/actions/runs/31977380418)
  성공
- `https://musixquare.com/`: HTTP 200, CSP/nosniff, cache-busted index와 최초 전환 배포의 Service Worker v445 확인
- 후속 completion-audit release는 Service Worker v446으로 cache boundary를 이동한다.

## 배포 후 관찰

운영 관찰 시작점은 위 production release 완료 시각이다. 24시간(Signaling/작은 Worker),
48~72시간(PRO/App), 한 cache generation(Service Worker)의 관찰 권고는 migration 완료를
지연시키는 별도 승인 gate가 아니다. 이상 발견 시 exact-SHA checkpoint rollback 또는 더
높은 cache epoch의 forward fix를 사용하며, daily live drift audit은 계속 유지한다.
