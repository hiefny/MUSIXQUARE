# 서버 Worker 상수의 집 하나 (Phase 0d, 2026-10-23)

| 항목     | 범위                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 기준 SHA | `d84f53f5` (main, 9.0.3 머지본: 자원 소유권 장부·가드, C7-0 서버 특성 테스트 포함)                                     |
| 코드 SHA | (작성 중)                                                                                                              |
| 후보     | PRO Worker는 target `pro-room`, App Worker는 target `app`. App 버전·SW 캐시(9.0.3 / v771)와 버전 표기는 그대로. 미배포 |
| 열차     | 구조 개선 Phase 0d 서버 상수: C7-1, C7-2a(PRO Worker), C7-2b(App Worker). 동작 변경 없음                               |
| 환경     | Windows 11, Node 24.20.0, npm 12.0.2, Vitest 5.0.3(node), node:sqlite                                                  |

## 왜 고쳤나

2026-10-22 자원 소유권 조사에서 서버 쪽에 같은 값이나 같은 상태 목록을 여러 곳에 따로 적은
사본이 나왔다. [자원 소유권 장부](resource-ownership-registry.md)의 원칙 4(시간 값과 단계
목록은 이름 있는 집 하나)를 어긴 곳이다. Phase 1에서 서버 주인을 합치기 전에, 동작은 그대로
두고 값과 목록부터 한 곳에 모은다.

- **RO-07 시그널링 broadcast 전달.** 프레즌스 표시와 재생 아웃박스가 1초, 60초, 16회를 각자
  상수 세 개씩 적었고, 같은 백오프 식도 두 벌이었다. 두 요청이 함께 쓰는 900ms 마감은 이름이
  `DEVELOPER_COMMAND_DISPATCH_TIMEOUT_MS`라 실제 쓰임(시그널링 broadcast 요청 두 곳)과 맞지
  않았다.
- **RO-08 PRO 파일 길이 읽기.** 답을 못 받은 R2 읽기의 재시도 5초, 30초, 5분이
  `deferAssetDurationRead`와 재생 쪽 읽기 실패 처리에 따로 있었고, 뒤쪽은 5분을 `300_000`
  숫자로 다시 적었다.
- **RO-09 소유권 이전 사가.** 상태 목록이 TypeScript 확인 함수 하나, SQL 문 다섯 곳(채움
  확인, 폐기된 방 종료 처리, 크론 목록, 회전, 순위 비교)에 따로 있었다.
- **RO-25 Developer API 권한 펜스.** 펜스 다이제스트 정규식이 네 곳에 있었다.

## 바뀐 것

- **PRO Worker (C7-1).** `SIGNALING_BROADCAST_TIMEOUT_MS`(900ms),
  `SIGNALING_BROADCAST_RETRY_BASE_MS`, `SIGNALING_BROADCAST_RETRY_MAX_MS`,
  `SIGNALING_BROADCAST_RETRY_MAX_ATTEMPTS`(1초, 60초, 16회)와 백오프 함수
  `signalingBroadcastRetryDelayMs` 하나로 모았다. 프레즌스는 저장하는 시도 횟수를, 재생은 그
  횟수에서 1을 뺀 값을 지금처럼 넘긴다. 저장 레코드 정규화 두 곳도 같은 상한 16을 쓴다.
- **PRO Worker (C7-2a).** `FILE_DURATION_READ_RETRY_MS`(5초, 30초,
  `PLAYBACK_DURATION_FILE_RETRY_MS`)와 `fileDurationReadRetryDelayMs`를 두 곳이 함께 쓴다.
  YouTube 조회의 빠른 재시도(5초, 30초)는 공급자 할당량 정책이라 파일 사다리와 따로
  `PLAYBACK_DURATION_YOUTUBE_QUICK_RETRY_MS`로 이름을 붙였다.
- **App Worker (C7-2b).** `OWNER_TRANSFER_SAGA_STATES`가 상태 목록의 집이다. 사가 상태 타입,
  크론이 맡는 상태(`OWNER_TRANSFER_SAGA_NONTERMINAL_STATES`), 거기서 계산한 종료 상태, 기존
  순위표가 모두 이 목록을 따른다. `complete`를 뺀 종료 상태 세 개(이전이 끝내 이뤄지지 않은
  상태)도 종료 상태에서 계산한 `OWNER_TRANSFER_SAGA_ABANDONED_STATES` 하나로,
  `recordOwnerTransferIntent` 두 곳과 `advanceOwnerTransferSagaState` 한 곳이 함께 쓴다.
  SQL의 상태 목록은 `sqlStateList()`가 만들고, 같은 상태를 같은 순서로 낸다. 펜스
  다이제스트는 `FENCE_DIGEST_RE` 하나를 네 곳이 쓴다.
- **드리프트 테스트.** `src/core/__tests__/owner-transfer-saga-states.test.ts`가 사가
  마이그레이션 SQL, 새 설치 스키마, `ensureAdminProRoomRegistry`의 런타임 DDL 세 곳의 상태
  CHECK를 TypeScript 목록과 비교한다. 생성한 크론 목록·회전·폐기된 방 종료 SQL은
  node:sqlite에서 직접 돌리고, 크론이 목록을 읽은 뒤 다른 실행 주체가 사가를 끝낸 경우(종료
  처리와 회전이 끝난 사가를 건드리지 않음)도 돌린다. 펜스 다이제스트는 추적되는 SQL 정의 네
  곳이 같은 CHECK를 적었는지, 정규식이 펜스 행·사가 행(새 설치 스키마와 런타임 DDL)의 D1
  CHECK가 받는 값과 정확히 같은 값을 받는지 확인한다(이 확인용으로 `isFenceDigestForTests`를
  내보낸다). C7-0의 `owner-transfer-saga-convergence-sqlite`에는 멈췄던 요청이 크론이 끝낸
  사가를 앞선 순위 상태로 되돌리지 않는다는 확인을 더했다. Worker 커버리지 프로필에도 넣었다.
- **장부.** RO-07, RO-08, RO-09, RO-25 기록의 값의 집과 상태를 고쳤고, 두 Worker 파일에
  `Resource owner` 머리 주석을 달았다. 소유권 가드 기준선은 바뀌지 않았다. 복사된 시간 상수
  검사는 `cloudflare/`를 세지 않고, broadcast 엔드포인트와 길이 읽기 호출 위치는 그대로다.

## 그대로 둔 것

- 동작: 지연 값, 시도 상한, 저장 레코드 검사, SQL이 고르는 상태 집합은 모두 그대로다.
- 프레즌스와 재생은 같은 전송을 쓰고 같은 실패로 물러서므로 한 일정을 쓴다. 검토 의견대로
  프레즌스는 낡은 소켓 정리와 삭제 펜스 해제를 맡아 따로 조정할 여지가 필요하다. 그때는 이
  상수 자리에서 갈라 쓴다고 주석에 적었다.
- D1 마이그레이션 SQL, 새 설치 스키마, 런타임 DDL의 상태 CHECK 문구는 고치지 않았다.
  `check-d1-migration-contract`는 `.sql` 파일과 매니페스트만 읽으므로, 런타임 DDL은 새
  드리프트 테스트가 맡는다.
- 채워지지 않은 사가 행이 가질 수 있는 상태(`intent`, `expired`, `superseded`)는
  `normalizeOwnerTransferSagaRow`에 그대로 적혀 있다. 테이블의 행 CHECK를 그대로 옮긴
  것이라 그 CHECK와 같이 둔다.
- 소유권 이전 클레임 발급(issuance) 테이블의 상태 목록, 같은 모양의 다른 43자 정규식(세션
  토큰, 통계 범위, API 키 비밀값 등)은 계약이 달라 합치지 않았다.
- 요청 빌더 하나(C7-3), 아웃박스 주인(C7-4), 길이 읽기 주인(C7-6), 사가 꼬리 하나(C7-9)는
  Phase 1이며 따로 오너 결정이 필요하다.

## 호환성

통신 형식, Durable Object 저장 레코드(프레즌스 표시와 재생 아웃박스의 모양, 시도 상한 16),
D1 스키마와 SQL의 의미, 비밀값, 바인딩 변경 없음. 브라우저 앱, App 버전, SW 캐시도 그대로다
(새 테스트 파일은 앱 배포 범위 밖). 두 Worker는 서로 기대지 않으므로 배포 순서는 상관없고
한쪽만 되돌려도 된다. target `all`은 쓰지 않는다. 부분 배포 게이트 때문에 main의 앱 소스가
배포본과 같을 때(9.0.3 배포 뒤)만 Worker 배포를 돈다. PRO Worker 배포는 살아 있는 PRO 방
Durable Object를 다시 시작하므로(메모리에만 있는 백오프 초기화) 행사 시간은 피한다.

## 검증과 한계

- 동작이 같다는 근거: C7-0 특성 테스트(시그널링 전달의 백오프 표와 상한, 길이 읽기 사다리
  세 칸, 사가 수렴 sqlite)가 고치지 않은 채 통과했다. 새 테스트의 SQL 실행 사례는 상태 목록을
  직접 적은 사본으로 바꿔 고치기 전 App Worker에서도 통과했다. 종료 처리 목록에서 `intent`를
  빼거나 크론 목록에서 `verified`를 빼면 실패하는 것도 확인했다.
- 느슨하게 바꾸는 변형도 잡는지 확인했다. 펜스 다이제스트 정규식을 `{43,44}`나 `{42,43}`로
  바꾸거나 `-`를 빼면, 종료 처리 UPDATE가 모든 상태를 받으면, `advanceOwnerTransferSagaState`의
  앞으로만 가는 걸러내기가 모든 순위 상태를 받으면, `complete`를 뺀 종료 상태 목록에서
  `target_deleted`를 빼면 각각 새 테스트(또는 기존 테스트)가 실패한다.
- 테스트가 아니라 읽어서 확인한 목록이 두 곳 남는다. 회전 UPDATE의 `state NOT IN (종료 상태)`은
  같은 문의 `state = ?6`(크론이 읽은 진행 중 상태)과 겹치는 방어라, 목록에서 종료 상태 하나를
  빼도 결과가 같다. 준비 기록 다시 쓰기(`recordPreparedOwnerTransferSaga`)의 순위 상태
  목록에서 `complete`를 빼면, 이미 끝난 사가를 다시 받을 때 `updated_at`만 갱신되지 않고 반환
  값과 상태는 같다. 둘 다 `sqlStateList` 출력이 고치기 전 문자열과 같음을 읽어서 확인했고,
  우연한 시각 값을 고정하는 테스트는 만들지 않았다.
- PRO Worker의 YouTube 빠른 재시도는 `probe.attempts < 2 ? (0이면 5초 : 30초)`에서
  `PLAYBACK_DURATION_YOUTUBE_QUICK_RETRY_MS[probe.attempts]`로 바뀌었다. 둘은 음수나 소수
  시도 횟수에서만 다른데(예전 식은 30초, 새 식은 백오프), 방을 불러올 때
  `isSafeNonNegativeInteger`로 시도 횟수를 검사하고 0이나 `Math.min(100, attempts + 1)`로만
  쓰므로 그런 값은 생기지 않는다. 같다는 근거는 이 정규화다.
- 대상 테스트: `pro-room-worker`, `natural-completion-integration`,
  `pro-room-duration-reads`, `pro-room-signaling-delivery`(4개 파일 537개)와
  `app-worker-cors`, `owner-transfer-saga-convergence-sqlite`, `owner-transfer-saga-states`,
  `pro-room-generation-registry-sqlite`, `developer-api-authority-fence-sqlite`,
  `d1-migration-contract`, `resource-ownership-guard`(7개 파일 362개) 통과. `check:workers`,
  테스트 타입 검사, 소유권 가드, 쓰이지 않는 export 검사도 통과.
- 전체 검사: (작성 중)
- 배포 뒤 smoke(signaling, pro-room)는 PRO 방에서 시그널링으로 가는 broadcast를 직접 타지
  않는다. 실제 시그널링 Worker와의 계약은 C7-0의 `pro-room-signaling-contract-workerd`가
  확인한다. 로컬 결과는 정확한 main SHA 배포 후보를 대신하지 않는다.
- 서버만 바뀌고 동작이 같아 실기기 확인 항목은 없다.
