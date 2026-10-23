# App Worker 사가 마무리 실행기 하나 (Phase 1 App Worker B, 2026-10-23)

| 항목     | 범위                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 기준 SHA | `09ecb95b` (main, Phase 1 App Worker A(C7-8, C7-11) 병합본, 미배포)                                                                   |
| 코드 SHA | `f1b362c7`(코드는 `59e83e84`와 같다)                                                                                                  |
| 후보     | App Worker만, target `app`. App 버전·SW 캐시(9.0.3 / v771)와 버전 표기는 그대로. 미배포                                               |
| 열차     | 구조 개선 Phase 1 App Worker B: C7-9 사후 실행기 하나와 오너 결정 D3의 순서. 의도한 동작 변경 있음(아래 "동작 변경")                  |
| 환경     | Windows 11, Node 24.20.0, npm 12.0.2, Vitest 5.0.3(node), node:sqlite 위의 실제 App Worker와 PRO 방 객체, git 기록으로 만든 이전 빌드 |

## 왜 고쳤나

[자원 소유권 장부](resource-ownership-registry.md) RO-09(소유권 이전 사가)의 마지막 단계다.
PRO 방 객체가 이전을 커밋한 뒤 사가를 `complete`까지 끝내는 꼬리(대상 재확인, 등록부 반영,
이전 방장 연결 정리, 최종 재확인, 권리 확정, `verified`, 펜스 해제, 감사, `complete`)를 이전
요청과 1분 크론이 따로 적었고, 그사이 순서가 갈라졌다.

- **순서.** 요청은 권리를 확정한 뒤 `verified`로, 크론은 `verified`로 간 뒤 권리를 확정했다.
- **성공 감사.** 둘 다 중복 확인 없이 썼다. 요청이 멈춘 사이 크론이 끝내면 성공 줄이 두 개
  남았다(C7-0 테스트로 재현).
- **삭제된 대상 감사.** 요청은 종료 전진(`target_deleted`) 뒤에 썼다. 종료된 행은 크론 목록에서
  빠지므로 그 삽입이 실패하면 줄이 영영 남지 않았다. 크론은 권리 확정 전에 써서 확정이 실패할
  때마다 같은 줄이 늘었고, 크론의 최종 재확인 자리는 아예 쓰지 않았다.

오너 결정 D3(2026-10-23, RO-09 기록)가 하나의 순서를 정했다. 두 입구가 같은 실행기를 부르고,
권리 확정, `verified`, 펜스 해제, 감사, `complete` 순이다. 감사 줄은 어떤 종료 전진보다 먼저,
최소 한 번 쓰고, 이전 단위로 중복을 없앤다. 크론 채택 리스(D4, C7-10)는 승인되지 않아 넣지
않았다.

## 바뀐 것

- **테스트 먼저(바꾸지 않은 Worker에서 통과, `0612bc19`).**
  - `owner-transfer-saga-convergence-sqlite.test.ts` "request outcome table": 대상 계정이
    살아 있을 때 요청 꼬리가 멈출 수 있는 모든 자리를 실제 경로로 일으켜 (HTTP 응답, 감사 줄,
    사가 상태)를 고정했다. 단계마다 예외(D1 장애)와 거절(다른 실행기가 행을 끝내 비교 후
    교체가 빗나감, 운영자 정지 뒤 객체의 409, 정식 상태가 활성이 아님, 다른 쓰는 곳이 바꾼
    펜스)을 나눴고, 최종 등록부 읽기가 다른 세대를 가리키는 경우(409
    `PRO_ROOM_GENERATION_MISMATCH`)도 넣었다. 이전 방장 연결 정리의 거절은 인증 DB가 없거나
    식별 정보가 틀릴 때만 나서 사가 행으로는 일으킬 수 없다. 응답은 예외와 같다.
  - 같은 파일 "cron tail crash matrix": 크론 자신의 꼬리가 단계마다 실패할 때 남는 사가 상태와
    권리 상태(옛 순서에서는 확정 전에 `verified`), 다음 회차의 수렴, 감사 줄을 고정했다.
    `complete` 쓰기가 실패한 뒤 재시도는 성공 줄을 한 번 더 썼다.
  - 같은 파일 겹침: 완료 뒤 같은 요청을 다시 보내면(응답 유실) 꼬리를 다시 돌며 성공 줄을 한
    번 더 썼다. 한 방 세대에서 이전을 두 번 하면 줄이 이전마다 하나씩이다(중복 제거가 방 단위가
    아니라 이전 단위여야 한다는 고정).
  - 새 파일 `owner-transfer-saga-mixed-version-sqlite.test.ts`: 배포 중 섞인 버전. 이전
    빌드는 `helpers/legacy-app-worker.ts`가 만든다. `cloudflare/app-worker.ts`와 그것이
    가져오는 저장소 모듈 전부를 지정 커밋 그대로 `git show`로 읽어 esbuild로 묶고, 지금 모듈과
    따로 불러온다. 대상은 운영 중인 App Worker(`86ccefe6`, Phase 0d)와 App Worker A
    트리(`09ecb95b`)다. 이전 요청과 새 크론, 새 요청과 이전 크론을 한 사가 행에서 양방향으로
    섞는다: 커밋 직후와 성공 감사 직후에 멈춘 요청, 한쪽 크론이 순서 중간에 멈춘 행, 삭제된
    대상. Worker 커버리지 설정에 넣었다. CI는 `fetch-depth: 0`이라 두 커밋이 있다.
  - fixture: 두 계정 모두 App 세션을 갖고, `issueClaim`은 대상을, `requestTransfer`는 계정,
    요청 id, 새 PIN, App Worker 빌드를, `cron`은 회차 입구를 받는다.
- **C7-9 (`59e83e84`).**
  - `finishCommittedOwnerTransfer(env, db, saga, entry)`가 커밋된 이전을 하나의 순서로
    끝낸다: 대상 재확인, 등록부 반영과 `registry_active`, 이전 방장 연결 정리와
    `old_owner_edge_retired`, 최종 대상 재확인, 정식 방 상태 확인, 그리고 D3대로 권리 확정,
    `verified`, Developer API 펜스 해제, 성공 감사, `complete`. 예외를 던지지 않고 결과를
    돌려준다: `{ok: true, state}` 또는 멈춘 단계와 방식(`threw`, `refused`, `not_found`).
    단계마다 가능한 방식만 타입에 적어 요청의 응답표가 빠짐없이 채워지게 했다.
  - 크론 `reconcileOneOwnerTransferSaga`는 `committed`로 간 뒤 실행기를 부르고 `ok`를
    돌려준다. 옛 꼬리(약 100줄)를 지웠다. 회전과 목록은 그대로다.
  - 요청 `handleProRoomOwnershipTransferSaga`는 객체 커밋과 `committed` 뒤 실행기를 부르고,
    멈춘 자리를 `OWNER_TRANSFER_REQUEST_TAIL_ANSWERS` 표 하나로 예전의 감사 줄과 HTTP 응답에
    옮긴다. 완료면 커밋 응답의 Set-Cookie를 예전처럼 붙인다. 손으로 적은 약 220줄을 지웠다.
  - `terminateOwnerTransferForDeletedTarget`: 모든 자리가 삭제 정리(크론이 이미 정지된 방을
    만나면 생략), 권리 확정, 감사, `target_deleted` 순이다. 위치별 감사 옵션
    (`auditTiming`)을 지웠다. 크론 최종 재확인 자리도 `target_deleted_during_reconcile`을
    쓴다(설계가 이름 붙인 빠진 감사).
  - `auditOwnerTransferCommitOnce`가 이전을 닫는 감사 줄(`success` 또는 삭제된 대상
    결과)을 쓴다. `appendSystemAdminProRoomAudit`에 `onceSinceMs`를 더했다(아래 "중복
    제거").
  - D3가 뒤집은 테스트 고정은 모두 주석에 D3를 적었다(아래 "동작 변경"). 변형 검사로 찾은
    빈틈 두 개도 이 커밋에서 고정했다. 멈춘 자리를 기록하는 줄의 삽입이 함께 실패하면, 삭제된
    대상 자리는 503 `PRO_ROOM_AUDIT_UNAVAILABLE`로, 본 꼬리 자리는 원래 응답으로 답한다. 두
    고정 모두 바꾸지 않은 Worker(`09ecb95b`)에서도 통과함을 따로 확인했다.
- **장부.** RO-09를 `owner-in-place`로 바꿨다. 사후 실행기 하나에 요청과 크론이 입구로 붙고,
  커밋 전까지는 설계대로 각자의 길(요청은 커밋 증명, 크론은 `/reconcile`)을 쓴다. 기준
  테스트에 응답표, 실패 행렬, 겹침, 섞인 버전을 더했고, 남은 한계 둘을 적었다.
  [QA 범위](../qa-domains.md) QA091 진입점에 두 테스트 파일을 더했다.
- **크기.** `cloudflare/app-worker.ts`는 16,481줄에서 16,578줄이 됐다(실행기, 결과 타입, 응답표,
  설명 주석이 두 꼬리보다 조금 길다). 한도 20,000줄 안이다.
- **가드.** 소유권 가드의 개수는 바뀌지 않았다. RO-09는 가드가 세지 않는 기록이라 기준선 변경이
  없다.

## 동작 변경 (오너 결정 D3)

1. **순서.** 크론도 권리를 확정한 뒤 `verified`로 간다. 이제 `verified`는 "방이 새 방장으로
   활성이고 권리가 옮겨졌다"는 뜻이다. `verified`를 읽는 곳은 목록뿐이라 사용자 응답은 같다.
2. **감사 시점.** 이전을 닫는 감사 줄은 언제나 효과(삭제 정리, 권리 확정, 펜스 해제) 뒤,
   종료 전진 바로 앞에 쓴다.
   - 요청의 삭제된 대상: 예전에는 종료 뒤에 써서 삽입이 실패하면 줄이 사라졌다. 이제 행이
     비종료로 남아 크론이 끝내며 줄을 쓴다(최소 한 번).
   - 크론의 삭제된 대상: 감사가 권리 확정 앞에서 뒤로 옮겨졌다. 확정이 실패한 회차는 줄을
     남기지 않는다(예전에는 회차마다 늘었다).
   - 크론 최종 재확인: 줄이 없던 자리에 `target_deleted_during_reconcile`이 생겼다.
3. **중복 제거.** 닫는 줄은 결과별로 이전 하나에 한 번이다. 감사 테이블에는 이전 열이 없어서
   사가의 의도 시각(`intent_at`)으로 범위를 잡는다. 한 문장 `INSERT ... SELECT ... WHERE NOT
EXISTS`가 같은 주체·동작·결과·방·세대이고 `created_at >= intent_at`인 줄이 없을 때만 넣는다.
   새 줄의 `created_at`은 `max(지금, intent_at)`이라 시계가 조금 늦은 Worker가 쓴 줄도 다음
   확인이 찾는다. D1 스키마와 마이그레이션은 바뀌지 않고, 기존 인덱스
   `idx_mxqr_pro_room_admin_audit_incarnation_created`를 쓴다.
   - 효과: 요청과 크론이 겹쳐도, 크론이 `complete` 실패 뒤 다시 돌아도, 응답을 잃은 요청을 다시
     보내도 성공 줄은 하나다. 같은 방 세대의 다음 이전은 자기 줄을 갖는다.
   - 방·세대 단위인 기존 `{once: true}`를 쓰지 않은 이유: 그러면 다음 이전의 성공 줄까지
     막는다(변형 검사로 확인).
   - 결과가 다르면 다른 줄이다. 요청의 종료 전진만 실패하고 크론이 끝내면
     `target_deleted_after_commit`, `reconcile_required`, `target_deleted_during_reconcile`
     세 줄이 남는다(같은 종료를 요청과 크론이 각자의 이름으로 적은 것).
   - 멈춘 자리를 기록하는 줄(`reconcile_required`, `entitlement_reconcile_required`)은 예전처럼
     멈출 때마다 쓴다.
4. **사용자 응답.** 바뀌지 않았다. 요청 응답표가 고치기 전과 같은 값으로 통과한다.

요청이 멈춘 자리별 응답(고치기 전과 같다):

| 멈춘 자리                   | 방식        | 감사 줄                                | 응답                                                                                  |
| --------------------------- | ----------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| 커밋 직후 대상 확인         | 예외        | `reconcile_required`                   | 503 `ACCOUNT_STORE_UNAVAILABLE`                                                       |
| 등록부 반영                 | 거절 / 예외 | 없음 / `reconcile_required`            | 409 `PRO_ROOM_STATE_CONFLICT` / 503 `PRO_ROOM_REGISTRY_UNAVAILABLE`                   |
| `registry_active`           | 거절 / 예외 | 없음 / `reconcile_required`            | 503 `PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED` / 503 `PRO_ROOM_REGISTRY_UNAVAILABLE` |
| 이전 방장 연결 정리         | 거절·예외   | `reconcile_required`                   | 503 `ACCOUNT_STORE_UNAVAILABLE`                                                       |
| `old_owner_edge_retired`    | 거절 / 예외 | 없음                                   | 503 `PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED` / 503 `PRO_ROOM_REGISTRY_UNAVAILABLE` |
| 최종 대상 확인              | 예외        | `reconcile_required`                   | 503 `ACCOUNT_STORE_UNAVAILABLE`                                                       |
| 정식 방 상태                | 다른 세대   | 없음                                   | 409 `PRO_ROOM_GENERATION_MISMATCH`                                                    |
| 정식 방 상태                | 예외 / 거절 | `reconcile_required`                   | 503 `PRO_ROOM_REGISTRY_UNAVAILABLE` / 503 `PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED` |
| 권리 확정                   | 거절        | `entitlement_reconcile_required`       | 503 `PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED`                                       |
| `verified`, `complete`      | 거절 / 예외 | 없음                                   | 503 `PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED` / 503 `PRO_ROOM_REGISTRY_UNAVAILABLE` |
| 펜스 해제                   | 거절·예외   | `reconcile_required`                   | 503 `DEVELOPER_API_ADMIN_UNAVAILABLE`                                                 |
| 성공 감사                   | 예외        | 없음                                   | 503 `PRO_ROOM_AUDIT_UNAVAILABLE`                                                      |
| 삭제 대상: 정리, 확정, 종료 | 거절·예외   | `reconcile_required`(실패 시 503 감사) | 503 `PRO_ROOM_TRANSFER_RECONCILIATION_REQUIRED`                                       |
| 삭제 대상: 닫는 감사        | 예외        | 없음                                   | 503 `PRO_ROOM_AUDIT_UNAVAILABLE`                                                      |
| 삭제 대상 종료 완료         |             | 닫는 줄(실행기)                        | 409 `OWNER_TRANSFER_TARGET_UNAVAILABLE`                                               |

본 꼬리에서 멈춘 자리를 기록하는 줄의 삽입이 실패하면 응답은 그대로이고, 삭제된 대상 자리는
503 `PRO_ROOM_AUDIT_UNAVAILABLE`이다(고치기 전과 같다).

## 그대로 둔 것

- 커밋 전 단계(의도, PREPARE, 권리 예약, 연결, 펜스, 영수증, 객체 커밋)와 그 감사·응답, 크론의
  채택·만료·대체, 해체된 방 처리, 회전과 목록 SQL.
- 펜스 쓰기 정책과 SQL, 권리 식별 정보와 바인딩 값(요청은 자기 시계, 크론은 회차 시각).
- 크론이 이미 삭제로 정지된 방을 만나면 다시 정리하지 않는다. 요청의 정리가 객체 제거 뒤 펜스
  쓰기에서 멈춘 경우 펜스 이름 바꾸기와 확인 응답은 계정 삭제 작업의 다음 시도가 맡는다(키는
  계속 폐기 상태다).
- 크론 채택 리스 없음(D4 미승인). PRO 방 Worker 소스, D1 스키마, 통신 형식은 고치지 않았다.

## 섞인 버전

App Worker 배포는 한 번에 바뀌지만 진행 중인 요청은 옛 버전에서 끝나고, 배포 직전에 시작한
크론 회차도 옛 버전으로 끝난다. 그래서 옛 실행기와 새 실행기가 한 사가 행에서 만날 수 있다.
두 버전 모두 단계가 멱등이고 사가 전진은 순위 비교 후 교체라, 어느 순서로 섞여도 수렴한다.
`owner-transfer-saga-mixed-version-sqlite.test.ts`가 운영 중인 `86ccefe6`과 App Worker A
`09ecb95b` 두 이전 빌드 각각으로 확인한다.

| 섞인 경우                                               | 결과                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| 옛 요청이 커밋 직후 멈추고 새 크론이 끝냄               | 둘 다 성공, 성공 줄 2개(옛 버전의 삽입은 확인 없이 쓴다)                 |
| 새 요청이 커밋 직후 멈추고 옛 크론이 끝냄               | 둘 다 성공, 성공 줄 1개(새 요청이 옛 크론의 줄을 찾는다)                 |
| 옛 요청이 성공 감사 뒤 멈추고 새 크론이 끝냄            | 성공 줄 1개(새 크론이 옛 요청의 줄을 찾는다)                             |
| 새 요청이 성공 감사 뒤 멈추고 옛 크론이 끝냄            | 성공 줄 2개                                                              |
| 옛 크론이 `verified` 뒤 확정 전에 멈추고 새 크론이 끝냄 | 수렴, 성공 줄 1개. 그 사이 `verified` 행의 권리는 아직 예약 상태         |
| 새 크론이 확정 뒤 `verified` 전에 멈추고 옛 크론이 끝냄 | 수렴, 성공 줄 1개(옛 크론의 확정은 이미 옮겨진 권리에서 그대로 성공한다) |
| 옛 요청이 삭제된 대상을 끝내다 멈추고 새 크론이 끝냄    | `target_deleted`, 크론 줄 뒤에 옛 요청이 자기 줄을 더한다                |
| 새 요청이 삭제된 대상을 끝내다 멈추고 옛 크론이 끝냄    | `target_deleted`, 새 요청 줄 뒤에 옛 크론이 자기 줄을 더한다             |

배포 창이 남기는 것은 옛 버전이 마지막에 쓰는 경우의 중복 줄(오늘과 같다)과, 창 동안
`verified` 행의 권리가 아직 예약 상태일 수 있다는 점뿐이다. 둘 다 사용자 응답과 권한에는 영향이
없다. 옛 버전이 모두 사라지면 이 테스트 파일은 지운다.

## 롤백

D1 스키마, 마이그레이션, 바인딩, 비밀값, Durable Object 저장 형식, 통신 형식이 바뀌지 않아 App
Worker만 이전 버전(`09ecb95b`이 배포됐다면 그것, 아니면 `86ccefe6`)으로 되돌려도 된다. 새 코드가
남긴 행(확정 뒤 `verified` 전, 종료 전진 전에 감사가 써진 행)을 옛 실행기가 끝낸다는 점은 섞인
버전 테스트의 "새 크론이 멈추고 옛 크론이 끝냄"이 보여 준다. 되돌리면 중복 제거와 D3 순서만
예전으로 돌아간다. 새 코드가 쓴 감사 줄은 보통 줄이다. App Worker 배포는 PRO 방 Durable Object를
다시 시작하지 않는다.

## 호환성

통신 형식, Durable Object 저장 레코드, D1 스키마, 비밀값, 바인딩 변경 없음. 바뀐 SQL은 새 감사
삽입 문장 하나이고 기존 열과 인덱스만 쓴다. 브라우저 앱, App 버전, SW 캐시와 버전 표기도
그대로다(Worker만 바뀌는 변경). 바뀐 런타임 파일은 `cloudflare/app-worker.ts` 하나다. 테스트,
테스트 도우미, Vitest 설정, 문서는 어느 Worker의 런타임 경로(`TARGET_RUNTIME_PATHS`)에도 들지
않는다. App Worker A(`09ecb95b`)는 2026-10-23 12:50 KST에 먼저 배포됐다
([Release 39896971208](https://github.com/hiefny/MUSIXQUARE/actions/runs/39896971208)). 이 브랜치에서 PRO room 런타임 경로는 배포본 `ae5ac945`과 같아 target `app` 단독이
가능하다. 병렬로 진행 중인 PRO Worker B가 먼저 main에 들어가면 부분 릴리스 게이트가 정하는
대로 target을 다시 고른다.

## 검증과 한계

- 테스트 먼저: 테스트 커밋(`0612bc19`)은 바꾸지 않은 Worker에서 통과했다(사가 77개, 섞인 버전
  16개, 펜스·`app-worker-cors`·상태 목록 포함 대상 5개 파일 392개).
- 뒤집힘 확인: 테스트 커밋의 고정을 그대로 둔 채 C7-9 코드를 돌리면 31개가 실패했고, 모두 D3가
  뜻한 변화였다(크론 순서, 감사 위치, 중복 제거, 최종 재확인 감사). 응답표 20개는 그대로
  통과했다.
- 변형 검사(C7-9 코드에서 하나씩 바꾸고 되돌림):
  - 중복 제거를 빼면 12개 실패(겹침, 재전송, 크론 재시도, 섞인 버전).
  - 방·세대 단위 `{once: true}`로 바꾸면 두 번의 이전 테스트 1개 실패.
  - `verified`를 확정 앞으로 돌리면 8개 실패.
  - 삭제된 대상 감사를 종료 전진 뒤로 돌리면 17개 실패.
  - 응답표의 등록부 반영 거절을 503으로 바꾸면 1개 실패.
  - 최종 대상 재확인을 지우면 7개 실패(`app-worker-cors` 1개 포함).
  - 삭제된 대상 자리에서 기록 줄 실패를 무시하게 바꾸면 처음에는 아무것도 실패하지 않았다.
    이 빈틈을 고정 두 개로 막았고 이제 1개가 실패한다.
- 대상 테스트(코드 커밋): 사가 80개, 섞인 버전 16개, 펜스·`app-worker-cors`·상태 목록 통과.
  Worker 테스트 59개 파일 2,842개 통과, Worker 커버리지 문턱 통과(App Worker 줄 87.1%).
  `check:workers`, `check:worker-bundles`(빌드 뒤), `guard:d1-migrations`,
  `guard:source-complexity`, 소유권 가드, 타입 검사, lint, 서식 통과.
- 전체 검사(`f1b362c7`, 로컬): 타입 검사, lint, 서식, 빌드 통과. 단위 테스트 628개 파일 14,204개,
  Worker 테스트 59개 파일 2,842개 통과. 가드(dead-exports, bus-pairing, import-graph,
  lifecycle-writes, release-identity, sw-cache-version, source-complexity, d1-migrations,
  `check:workers`, resource-ownership) 통과. 브라우저 앱이 바뀌지 않아 브라우저 검사는 돌리지
  않았다. 로컬 결과는 정확한 main SHA 배포 후보를 대신하지 않는다.
- 한계:
  - node:sqlite는 D1의 한 문장 원자성을 따른다. 실제 D1에서 두 실행기가 같은 순간에 넣어도
    한 문장 안의 확인과 삽입은 직렬로 실행된다는 전제다.
  - 시간 범위 중복 제거의 빈틈: 앞선 이전의 꼬리가 객체의 완료 재전송 창(10분)보다 오래 멈춰
    있다가, 같은 방 세대의 다음 이전이 의도를 적고 PREPARE하기 전 몇 ms 사이에 같은 결과 줄을
    쓰면 다음 이전의 줄이 막힐 수 있다. 감사 테이블에 이전 열을 더해야 없어지며, 스키마
    변경이라 하지 않았다.
  - 이전 빌드는 오늘의 npm 패키지로 묶인다(저장소 모듈은 그 커밋 그대로).
  - 배포 뒤 smoke(`smoke:live:app-generation`, `smoke:live:developer-api`)는 소유권 이전을 타지
    않는다. 설계의 운영 확인(QA091, 오너 본인 계정 둘로 테스트 PRO 방 한 번 이전)은 방의
    Developer API 키를 모두 폐기하고 유료 권리를 옮기며 감사 줄을 영구히 남긴다. 키가 없는
    테스트 방, PRO 방이 없는 두 번째 계정, 되돌리는 이전까지 포함해 오너가 할지 정한다.
  - 로컬 결과는 정확한 main SHA 배포 후보를 대신하지 않는다.
