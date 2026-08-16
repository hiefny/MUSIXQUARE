# TypeScript 전환 상태

최종 갱신: 2026-08-17
판정: **진행 중 — 완료 아님**

## 수치

역사적 기준선은 107개, 77,793줄이다. 이 중 JS/MJS는 98개 77,491줄이고 JSX는
9개 302줄이다.

현재 통합 묶음은 Cloudflare 모듈/Worker 25개, Node 도구 55개,
browser runtime/TSX 25개, ESLint 구성 2개를 TypeScript 원본으로 전환했다. 모든 수치는 실제 working tree와 기계 manifest가
동일한 상태에서 계산한다.

| 상태      | 전체 파일 | JS/MJS | JSX | 역사적 줄 수 합계 |
| --------- | --------: | -----: | --: | ----------------: |
| initial   |       107 |     98 |   9 |            77,793 |
| remaining |         0 |      0 |   0 |                 0 |
| retired   |       107 |    107 |   0 |            77,793 |

`baselineLines`는 초기 규모를 설명하는 스냅샷이며 현재 구현의 줄 수를 제한하지 않는다.
현재 파일 집합과 상태의 authoritative 값은 `authored-js-baseline.json`이다.

HTML 실행 코드의 별도 기준선은 8개 블록이며 현재 남은 블록은 0개다. 이 값은
`authored-inline-js-baseline.json`과 `guard:authored-inline-js`가 독립적으로 감소만 허용한다.

## 단계 현황

| 단계                   | 상태        | 종료 증거                                      |
| ---------------------- | ----------- | ---------------------------------------------- |
| 0. 기준선과 안전망     | complete    | inventory/diagnostic/CI 통합과 전체 typecheck  |
| 1. TS 기반             | complete    | 6 Worker Env와 browser/SW 경계 완료            |
| 2. strict-clean leaf   | complete    | 6개 leaf strict/coverage/Worker bundle 통과    |
| 3. wire/security       | complete    | 8/8 strict, golden/protocol/Worker bundle 통과 |
| 4. 중형 공용 모듈      | complete    | 공용 auth/grants/bot/control strict/coverage    |
| 5. 작은 Worker entry   | in progress | 네 배포 단위의 순차 deploy/soak                |
| 6. PRO Worker          | in progress | strict 0, rename, 48~72시간 soak               |
| 7. App Worker          | in progress | strict 0, rename, 48~72시간 soak               |
| 8. browser runtime     | complete    | stable URL의 dev/build/compiled behavior 검증  |
| 9. Node tooling        | complete    | 55개 `.mts`, release/recovery fixture 유지     |
| 10. JSX/config/cleanup | complete    | JSX 9개와 ESLint config 2개 retired, inline 0  |

## 다음 체크포인트

1. 현재 107개 전환 묶음의 전체 test/coverage/build와 6개 Worker dry-run을 재확인한다.
2. strict 진단 감소를 새 baseline으로 고정한다.
3. 중형 Worker 공용 모듈을 lifecycle/authority 경계별로 strict TS화한다.
4. classic browser compiler를 다음 중형 script와 Service Worker 전용 경계로 확장한다.
5. Node read-only guard 뒤 mutation-capable release 도구는 별도 fixture와 함께 전환한다.

## 상태 변경 규칙

- `pending → in progress → complete`만 허용한다.
- 단계 완료는 산출물이 존재한다는 사실이 아니라 ROADMAP의 종료 증거가 실제로 통과한
  경우에만 선언한다.
- manifest의 항목은 `remaining → retired`만 허용한다.
- 배포 또는 soak가 필요한 단계는 로컬 테스트만으로 complete 처리하지 않는다.
- 실패, 롤백 또는 계약 변경 발견 시 상태와 근거를 같은 PR에서 기록한다.
