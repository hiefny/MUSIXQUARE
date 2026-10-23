# App Worker 사가 도우미·펜스 쓰기 하나 (Phase 1 App Worker A, 2026-10-23)

| 항목     | 범위                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------- |
| 기준 SHA | `ae5ac945` (main, Phase 1 PRO Worker A(C7-3) 배포본)                                                     |
| 코드 SHA | (작성 중)                                                                                                |
| 후보     | App Worker만, target `app`. App 버전·SW 캐시(9.0.3 / v771)와 버전 표기는 그대로. 미배포                  |
| 열차     | 구조 개선 Phase 1 App Worker A: C7-8 사가 도우미, C7-11 펜스 쓰기 타입과 쓰는 곳 가드. 동작 변경 없음    |
| 환경     | Windows 11, Node 24.20.0, npm 12.0.2, Vitest 5.0.3(node), node:sqlite 위의 실제 App Worker와 PRO 방 객체 |

## 왜 고쳤나

[자원 소유권 장부](resource-ownership-registry.md) RO-09(소유권 이전 사가)와 RO-25(Developer
API 권한 펜스) 정리의 첫 단계다.

- **사가.** 이전 대상 계정이 삭제되는 중에 이미 커밋된 이전을 끝내는 순서(삭제 정리, 감사,
  권리 확정, `target_deleted`)를 네 곳이 손으로 따로 적었다. 크론 세 곳과 요청 한 곳이고,
  감사 위치가 서로 다르다. 권리(entitlement) 함수에 넘기는 식별 정보도 크론의 클로저와 요청의
  리터럴 네 개, 해체 정리의 리터럴 하나로 흩어져 있었다. 다음 단계(C7-9)가 실행기 하나로
  합치기 전에, 지금 순서를 그대로 지키는 도우미 둘로 이름을 하나씩 준다.
- **펜스.** `revokeDeveloperApiKeysForAuthorityChange`의 호출 네 곳이 감사 주체, 감사 결과,
  펜스 사유, 비교 후 교체 여부를 위치 인자로 넘겼다. 마지막 인자를 빠뜨리면(`undefined`) 비교
  후 교체가 꺼지는 식이라, 실수가 드러나지 않는다. 펜스 테이블에 누가 쓰는지도 검사가 없었다.

## 바뀐 것

- **테스트 먼저(바꾸지 않은 Worker에서 통과, `c74f2477`).**
  - 사가 fixture를 `src/core/__tests__/helpers/owner-transfer-saga-fixture.ts`로 옮겨 펜스
    테스트도 같은 실제 Worker로 쓰는 곳을 몰 수 있게 했다. 실제 객체로 만들 수 없는 방(레거시
    중복 방장의 두 번째 방)은 `stubAdminRoom`으로 상태 응답만 대신한다.
  - `owner-transfer-saga-convergence-sqlite.test.ts` "deleted-target exits": 네 곳에서 단계
    하나가 실패할 때를 고정했다. 요청은 삭제 정리, 권리 확정, 종료 전진 중 하나라도 실패하면
    끝에 `reconcile_required`를 감사하고 503을 답한다. 종료 전진 뒤 감사 삽입이 실패하면 503
    `PRO_ROOM_AUDIT_UNAVAILABLE`이고, 그 감사 줄은 영영 쓰이지 않는다(크론 목록에서 빠지므로).
    크론 세 곳은 종료 전진 전에 멈추고 행을 다음 회차에 남긴다. 확정 전에 감사하는 두 곳은
    다시 돌 때 감사를 한 번 더 쓰고(최소 한 번), 최종 재확인 자리는 감사하지 않는다.
  - 같은 파일 "entitlement identity": 요청은 시각을 넘기지 않아 권리 모듈이 자기 시계를 찍고,
    크론은 회차 시각을 넘긴다. 확정과 취소의 바인딩 값을 고정했다.
  - `developer-api-authority-fence-sqlite.test.ts` "Developer API authority fence writers (RO-25)":
    쓰는 곳마다 실제 호출 경로로 SQL 원문과 바인딩 값 전부를 고정했다. 계정 삭제 정리는 행이
    없을 때 `null`, 이전 펜스 위에서는 읽어 둔 다이제스트로 비교 후 교체한다(`?6 = 1`). 이전
    요청, 크론의 이전 채택, 레거시 중복 방장 해제는 비교 없이 쓴다(`?6 = 0`, `?7 = null`).
    이전의 해제는 자기 다이제스트만 지운다. 다이제스트는 정해진 재료로 다시 계산해 맞춘다.
    이 파일이 App Worker를 불러오므로 Worker 커버리지 설정(`vitest.workers.config.ts`)에
    넣었다.
  - `app-worker-cors.test.ts`: 해체 정리의 취소가 사가 식별 정보와 회차 시각을 바인딩한다.
- **C7-8 (`3582f7b4`).**
  - `ownerTransferEntitlementInput(saga, nowMs?)`가 권리 식별 정보를 만든다. 크론의 클로저,
    요청의 리터럴 네 개(예약, 취소, 확정 두 곳), 해체 정리의 리터럴을 바꿨다. 크론은 회차
    시각을, 요청은 시각 없이 넘겨 바인딩 값이 같다.
  - `terminateOwnerTransferForDeletedTarget(env, db, saga, options)`가 네 곳의 순서를 그대로
    재현한다. 옵션은 `{purge, auditTiming, auditResult, nowMs}`다.
    - 크론, 방이 이미 삭제로 정지된 자리: 삭제 정리 없음, 확정 전 감사.
    - 크론, 커밋을 채택한 직후: 삭제 정리, 확정 전 감사.
    - 크론, 최종 재확인: 삭제 정리, 감사 없음.
    - 요청: 삭제 정리, 종료 전진 뒤 감사, 실패 시 `reconcile_required`.
  - 크론 쪽 감사와 전진의 예외는 예전처럼 회차로 올라가고, 요청 쪽은 예전처럼 잡는다.
- **C7-11 (`d44a5fd5`).**
  - `revokeDeveloperApiKeysForAuthorityChange`가 위치 인자 대신 `AuthorityFenceWrite`
    (`{source, reason, fenceDigest, expected}`)를 받는다. `source`가 펜스 사유와 키 폐기 감사
    주체를 정한다(`AUTHORITY_FENCE_WRITERS`). 계정 삭제는 `expected`에 읽어 둔 다이제스트나
    `null`을, 나머지 셋은 `'any'`를 넘긴다. `'any'`는 예전과 같이 `?6 = 0`으로 묶인다.
  - `check-resource-ownership`에 CHECK 7(RO-25)을 더했다. 펜스 테이블에 넣거나 바꾸거나
    지우는 문자열, 또는 테이블 이름을 다른 식으로 담은 문자열은 활성기, 해제기, PRO 방 해체의
    `deleteDeveloperRoomData` 목록에만 있을 수 있다. 맨 이름이 `DELETE FROM ${table}` 같은
    템플릿 SQL로 들어갈 수 있어서다. 읽기(FROM, JOIN)와 `테이블.열`, 주석,
    `DEVELOPER_API_AUTHORITY_FENCED` 오류 코드는 세지 않는다. 대소문자는 무시하고, 이름 꼬리
    (`authority_fences`)만 담은 조각도 센다. 기준선은 정확히 3곳이며 각 이유를 적었다.
    위반을 심은 테스트 4개를 `resource-ownership-guard.test.ts`에 더했다. 가드는 이미 CI에서
    돈다.
  - [계정 인증 운영](../account-auth-operations.md)에 쓰는 곳 셋과 우선순위(삭제가 정지시키고
    이전이 다시 연다)를 적었다.
- **장부.** RO-09에 도우미 둘과 새 기준 테스트를 적고, 중복 성공 감사가 재현됐다고 고쳤다.
  단일 사후 실행기(C7-9)가 남아 `duplicated` 그대로다. RO-25는 `owner-in-place`가 됐다. 타입이
  있는 활성기, 해제기, 해체 삭제만 쓰고 가드가 그렇게 지킨다. 이전 쓰기의 비교 후 교체 여부는
  열린 오너 결정이고 두 번째 기계가 아니다.
- **크기.** `cloudflare/app-worker.ts`는 16,399줄에서 16,481줄이 됐다(도우미, 타입, 설명 주석).
  한도 20,000줄 안이다.

## 그대로 둔 것

- 순서: 네 자리의 삭제 정리, 감사, 확정, `target_deleted` 순서와 HTTP 답(409
  `OWNER_TRANSFER_TARGET_UNAVAILABLE`, 503 `PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED`, 503
  `PRO_ROOM_AUDIT_UNAVAILABLE`)이 같다. 오너 결정 D3(감사를 모든 종료 전진보다 먼저, 확정을
  `verified`보다 먼저, 실행기 하나)는 C7-9에서 한다. 이번에는 어떤 순서도 바꾸지 않았다.
- 크론의 `verified` 뒤 확정, 크론 최종 재확인의 감사 없음, 요청의 종료 뒤 감사(삽입 실패 시
  유실), 성공 감사 중복은 그대로이고 테스트가 지금 모습으로 고정한다.
- 펜스 SQL 원문과 바인딩, 다이제스트 재료, 키 폐기 감사 줄, 해제 SQL, PRO 방 해체 삭제는 같다.
  이전 쓰기도 비교 후 교체 없이 쓴다. 이를 바꿀지는 열린 오너 결정(서버 설계의 D5)이다.
- PRO 방 Worker 소스, D1 스키마, 통신 형식은 고치지 않았다.

## 호환성

통신 형식, Durable Object 저장 레코드, D1 스키마와 SQL, 비밀값, 바인딩 변경 없음. 브라우저 앱,
App 버전, SW 캐시와 버전 표기도 그대로다(Worker만 바뀌는 변경). 바뀐 런타임 파일은
`cloudflare/app-worker.ts` 하나라 release target은 `app` 단독이다. 부분 릴리스 게이트가 쓰는
`changedRuntimePaths`와 `TARGET_RUNTIME_PATHS`(`scripts/release-deployment-state.mts`)로 직접
확인했다. 선택하지 않은 Worker는 배포본 이후 바뀐 런타임 경로가 0개다(PRO room은 배포본
`ae5ac945`, signaling·remote-share·Developer API·facade는 `86ccefe6` 기준). App 쪽은
`cloudflare/app-worker.ts` 하나다. 테스트, 테스트 도우미, 가드 스크립트, Vitest 설정, 문서는
어느 Worker의 런타임 경로에도 들지 않는다. App Worker 배포는 PRO 방 Durable Object를 다시
시작하지 않는다.

## 검증과 한계

- 테스트 먼저: 테스트 커밋(`c74f2477`)은 바꾸지 않은 Worker에서 통과했다(사가 42개, 펜스 9개,
  `app-worker-cors` 280개).
- 실패 확인: 테스트 커밋만 둔 채 옛 코드를 바꿔 봤다.
  - 크론 최종 재확인이 거절된 삭제 정리를 무시하면 새 고정 1개가 실패했다("cron at the final
    recheck: when the purge (its fence write) fails").
  - 레거시 중복 방장 해제가 `null`을 넘겨 비교 후 교체를 켜면 새 쓰는 곳 고정 1개가 실패했다
    (`?6` 0이 1로). 같은 변형에서 사가 테스트 42개(호출별 펜스 정책 고정 포함)는 모두
    통과했다. 새 고정이 없으면 이 회귀를 잡지 못했다는 뜻이다.
  - 요청이 종료 뒤 감사 실패를 삼키면 새 고정 1개가 실패했다.
  - 가드: `cloudflare/app-worker.ts`에 펜스를 바로 고치는 함수를 하나 더하면
    `node scripts/check-resource-ownership.mts`가 `UNSANCTIONED authority fence write (RO-25)`로
    종료 코드 1을 냈다.
- 동작이 같다는 근거: 테스트 커밋의 고정(네 자리의 순서·실패 출구·감사 위치, 권리 바인딩, 쓰는
  곳마다 SQL과 바인딩)과 C7-0 특성 테스트가 고치지 않은 채 C7-8과 C7-11 뒤에도 통과한다.
- 대상 테스트: 사가·펜스·`app-worker-cors`·`owner-transfer-saga-states`·
  `resource-ownership-guard`·`pro-room-grants` 통과. `check:workers`,
  `guard:developer-api-boundaries`, `guard:d1-migrations`, `guard:source-complexity`, 소유권
  가드 통과.
- 전체 검사: (작성 중)
- 배포 뒤 smoke(`smoke:live:app-generation`, `smoke:live:developer-api`)는 소유권 이전과 계정
  삭제 경로를 타지 않는다. 근거는 node:sqlite 위의 실제 App Worker와 PRO 방 객체 테스트다.
  운영 환경에서 테스트 PRO 방의 이전을 직접 해 보는 확인은 C7-9(실행기 하나) 때 다시 다룬다.
  로컬 결과는 정확한 main SHA 배포 후보를 대신하지 않는다.
