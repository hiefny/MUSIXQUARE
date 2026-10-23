# PRO 방 아웃박스·길이 읽기 주인 하나 (Phase 1 PRO Worker B, 2026-10-23)

| 항목     | 범위                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 기준 SHA | `10a5f32e` (main, Phase 1 App Worker B 머지본. 처음 작성은 `51ab2be3` 위에서 했다. PRO Worker는 `ae5ac945`로 배포됨) |
| 코드 SHA | `85e143c9`(코드는 `970acdf7`와 같다)                                                                                 |
| 후보     | PRO Worker만, target `pro-room`. App 버전·SW 캐시(9.0.3 / v771)와 버전 표기는 그대로. 미배포                         |
| 열차     | 구조 개선 Phase 1 PRO Worker B: C7-4 시그널링 아웃박스 주인, C7-6 길이 읽기 주인, C7-3 후속. 동작 변경 없음          |
| 환경     | Windows 11, Node 24.20.0, npm 12.0.2, Vitest 5.0.3(node), 로컬 workerd(Miniflare, 실제 두 Worker 번들)               |

## 왜 고쳤나

[자원 소유권 장부](resource-ownership-registry.md)의 두 기록이 Phase 1에서 남은 일이었다.

- RO-07(시그널링 broadcast 전달): Worker A(C7-3)가 요청 빌더를 하나로 합쳤지만, 접속자 표시
  레코드와 재생 아웃박스는 여전히 알람 후보, 알람의 처리 순서, 에포크가 바뀔 때의 비우기, 저장
  레코드 정리를 각자 따로 적었다.
- RO-08(PRO 파일 길이 읽기): 등록 읽기와 재생 읽기가 R2 자리를 나눠 쓰는데, 서로를 확인하는 조건이
  시작 두 곳과 알람 세 곳에 따로 적혀 있었다. 이 결합은 예전에 알람 무한 반복을 한 번 만들었다
  ([등록 길이 읽기](pro-file-duration-registration-2026-10-12.md)).

설계 비평이 짚은 점을 먼저 반영했다. C7-4는 재생 아웃박스를 비우는 계기가 알람 하나뿐이라고 적었지만
실제로는 기본 persist가 모두 비운다. 그래서 계기 목록을 사실대로 적고, 무효화 알림 12곳의 실행
방식(응답 전에 기다림)은 바꾸지 않았다. C7-6은 R2 자리 조건을 하나로 합치면 대기열에만 있고 아직
읽지 않는 파일을 재생 읽기가 가져가므로, 조건을 둘(읽는 중, 대기 중)로 두었다. 두 완료 뒤의 재시작
조건도 그대로 두었다. 하나로 합치면 저장하지 못한 완료가 곧바로 다시 읽기를 시작한다. C7-5(접속자
표시가 전달되면 재생 머리를 바로 다시 보냄)는 비평대로 빼고 예외 RO-31로 남겼다.

## 바뀐 것

- **테스트 먼저(바꾸지 않은 Worker에서 통과).** C7-0 경계 테스트를 늘렸다.
  - `pro-room-signaling-delivery.test.ts`: 계기마다 실행 방식을 고정했다. 접속자 표시 스냅샷은
    `waitUntil`이라 요청이 먼저 답하고, 재생 머리는 그 요청의 persist가 보내며 요청이 그 답을
    기다리고, 대기열 모드 변경은 무효화 알림 1회를 기다린다. 시그널링 바인딩이 없으면 접속자
    표시는 한 번 보내고 재시도 표시를 남기지 않는다. 알람 시각은 접속자 표시 레코드와 아웃박스
    머리 중 이른 쪽이고 머리 뒤의 레코드는 후보가 아니다. 아웃박스는 두 레코드(기준 COMMIT과 그
    뒤)까지만 둔다. 방이 잠들 때와 PIN을 바꿀 때 에포크 변경의 persist가 아웃박스를 비운다는 것은
    저장되는 모든 core 기록으로 확인한다(최종 상태만 보면 flush도 옛 에포크 레코드를 보내지 않고
    지워서 구별되지 않는다).
  - 두 방향 저장 레코드 fixture
    `__helpers__/pro-room-outbox-records-51ab2be3.ts`: 51ab2be3가 쓰는 접속자 표시 레코드와
    PREPARE, CANCEL, COMMIT 레코드를 키 순서까지 그대로 적었다(control-isolation-c9 방식).
    시험하는 Worker가 이 레코드를 바이트 그대로 써야 하고(새 버전에서 옛 버전으로), 이 레코드를
    다시 시작한 뒤 읽어 보내야 한다(옛 버전에서 새 버전으로). 시도 횟수 상한 16인 레코드는 읽혀 계속
    16으로 남고, 17인 레코드는 두 정리 함수가 버린다.
  - `pro-room-duration-reads.test.ts`: 대기 중 조건(아무것도 읽지 않을 때 대기열의 재생 파일은
    등록 읽기가 가져간다. 읽기 결과는 같아서 메모리 자리 이름으로 확인)과 읽는 중 조건(YouTube
    조회는 R2 자리를 차지하지 않지만, 알람은 조회가 하나라도 진행 중이면 대기열 읽기를 10초
    감시까지 미룬다)을 고정했다.
  - `natural-completion-integration.test.ts`: 아무것도 저장하지 못한 완료가 다시 읽지 않는다는
    것을 고정했다. 세대가 바뀐 등록 완료와 재생 완료, 그리고 저장 공간이 모자라 길이를 버린 등록
    완료가 그렇다. 서비스 점검 중의 완료는 기존 경계 테스트가 고정한다.
  - fixture에 `MetadataService.hold()`(멈춘 조회 뒤의 일은 R2 읽기처럼 다음 settle로 넘김)와
    `detachSignaling()`을 더했다.
- **PRO Worker, C7-4(아웃박스 주인).** 아웃박스 구역에 주인 부분을 하나씩 두었다.
  - `signalingOutboxDueAtMs`: 접속자 표시 레코드와 아웃박스 머리 중 이른 시각. `scheduleAlarm`은
    이 값 하나를 받는다.
  - `drainSignalingOutbox`: 알람이 접속자 표시 재시도 뒤 재생 머리를 보낸다(지금 순서 그대로).
  - `onCoordinatorEpochAdvanced`: `bumpRoomEpoch`가 `cancelPendingPlayback` 다음에 부르고, 같은
    persist에서 아웃박스를 비운다.
  - `normalizeLoadedSignalingOutbox`: 두 저장 레코드 정리를 합쳤다. 레거시 방의 에포크를 올릴 수
    있는 `normalizeLoadedPlaybackAuthority` 다음에 돈다.
  - `signalingDeliveryClass`: `scheduleServerEvent`가 접속자 표시, 재생, 일회성 알림으로 나눠
    보낸다. 계기마다 실행 방식은 그대로다.
  - 같은 결과의 중복도 지웠다. 재생 flush의 저장·되돌림 블록 둘을 하나로(옛 에포크 머리는 때와
    상관없이 보내지 않고 지움), enqueue의 CANCEL 찾기를 한 번으로, 실패 표시와 전달 후 지우기
    (`rememberFailedPresenceBroadcast`, `clearDeliveredPresenceBroadcast`)를
    `settlePresenceBroadcast` 하나로(같은 확인, 점검 확인, `retainEarlierAlarm` 저장) 합쳤다.
    알람의 접속자 표시 재시도는 `broadcastServerEvent`의 기본값(지금 대상과 에포크)을 쓴다.
    `scheduleAlarm`이 직접 쓰던 거르기와 다음 틱 규칙은 `earliestAlarmAtMs` 하나가 맡는다.
- **PRO Worker, C7-6(길이 읽기 주인).**
  - 조건 둘: `fileDurationReadInFlight`(등록 읽기 중이거나 재생 자리의 파일 조회 중. 재생 자리는
    키에서 `:file:`을 찾는 대신 `mediaKind`를 적는다)와 `fileDurationQueuedForRegistration`(등록
    대기열에 있으면 읽든 안 읽든 재생 읽기가 양보한다). `playbackDurationProbeBlocked`가 둘과 재생
    자리를 묶어 재생 읽기 시작과 알람 후보에 쓴다.
  - `startDurationWork`: persist 뒤와 알람에서만 쓰는 시작(재생, 등록 순서). 두 완료 뒤의 재시작은
    글자 그대로 두었다(등록은 `if (finished)`, 재생은 키가 다른 탐색만).
  - `durationWorkAlarmAtMs`: YouTube 길이 만료, 재생 탐색 재시도(막혀 있으면 10초 감시), 답을
    받지 못한 디코드 읽기, 등록 대기열(조회 중이면 감시)을 알람 후보 하나로 낸다.
- **C7-3 후속.** 계약 도우미가 시그널링처럼 매개변수가 붙은 JSON content type을 받는다.
  `natural-completion-integration.test.ts`의 가짜 시그널링도 정확한 키 계약으로 감쌌다.
  `FencedSignaling`은 주입한 장애보다 먼저 계약을 확인한다. `postSignalingBroadcast`의 입력 형식은
  `PlaybackBroadcastRecord`에 기대지 않는다. full-fanout 수락의 `sent <= eligible` 비교는 지웠다.
  둘 다 음수가 아닌 안전 정수이고 `sent === eligible`이 이미 그것을 포함하므로 판정이 바뀌는 답은
  없다. 테스트 이름의 아포스트로피는 ASCII로 바꿨다(workerd 계약 1개, 저장 레코드 2개).
- **줄 수.** `pro-room-worker.ts`는 18,149줄에서 18,146줄로 3줄 줄었다(C7-4에서 21줄 줄고, C7-6에서
  19줄 늘고, 후속에서 1줄 줄었다). 한도 20,000줄.
- **가드와 장부.** `check-resource-ownership`의 기준선은 그대로다. broadcast 엔드포인트는
  `postSignalingBroadcast`에, R2 길이 읽기는 두 탐색 함수에 그대로 있어 센 코드가 옮겨지지 않았다.
  RO-07과 RO-08은 남은 독립 기계가 없어 `owner-in-place`가 되었다. 두 탐색이 R2를 각자 읽는 것은
  예외 RO-32, 재전송 없는 알림은 RO-46, 접속자 표시 뒤 재무장 없음은 RO-31로 남는다. 두 기록에 주인
  부분, 계기와 실행 방식, 새 기준 테스트를 적었다. `pro-room-server-authority.md` 10절에 전달 종류
  셋과 순서를 한 문단으로 적었다.

## 그대로 둔 것

- 요청 바이트, 헤더, 900ms 마감, 두 수락 규칙(판정), 두 경로의 백오프(1초부터 60초, 16회), 저장
  레코드 모양과 키 순서.
- 계기와 실행 방식. 접속자 표시는 `waitUntil`. 재생 아웃박스는 `flushPlaybackOutbox: false`를 넘기지
  않는 모든 persist(명령과 요청, prune, 하트비트 저장, 접속자 표시 레코드의 기록·삭제·재시도)가
  머리를 보내고 그 요청이 기다린다. 알람이 접속자 표시를 먼저 보내는 것은 앞선 persist가 없을
  때뿐이다(prune이나 하트비트 저장이 먼저 저장하면 재생 머리가 먼저 간다). 무효화 알림은 persist 뒤
  12곳에서 기다리고, 나머지는 `scheduleServerEvent`를 거쳐 `waitUntil`로 간다.
- 길이 읽기: 두 읽기 함수와 R2 읽기 횟수, 재시도 사다리(5초, 30초, 5분), YouTube 빠른 재시도, 10초
  감시, 등록 메모 백오프, 메모리에 둔 재생 백오프, 첫 실패 진단 로그.
- C7-5(재무장)는 하지 않았다(RO-31). 설계의 `settleDurationWork` 테스트 도우미와 기존 테스트의 이전은
  선택 사항이라 하지 않았다. 기존 자리 이름이 그대로라 기존 테스트가 그대로 돈다.
- 시그널링 Worker와 App Worker 소스는 고치지 않았다.

## 호환성

통신 형식, Durable Object 저장 레코드(모양, 키 순서, 시도 상한 16), D1, 비밀값, 바인딩 변경 없음.
브라우저 앱, App 버전, SW 캐시와 버전 표기도 그대로다(Worker만 바뀌는 변경). 옛 Worker와 새 Worker는
서로의 저장 레코드를 받는다(두 방향 fixture). 부분 릴리스 게이트의 경로 표
(`scripts/release-deployment-state.mts`의 `runtimePathsForWorker`, `changedRuntimePaths`)로 이 브랜치를
배포된 SHA와 비교했다. PRO room(`ae5ac945`)은 `cloudflare/pro-room-worker.ts` 하나만 바뀌었고, 나머지
다섯 Worker(`86ccefe6`)는 런타임 경로 변경이 없으며 App 의존성 목록도 그대로다. 그래서 release target은
`pro-room` 단독이다. 이 브랜치를 올린 뒤 App Worker A(C7-8, C7-11, 12:50 배포)와 B(C7-9)가 main에
들어왔다. App에 배포 안 된 런타임 변경이 남아 있으면 게이트가 `pro-room` 단독을 막으므로, App Worker B를
먼저 배포한 뒤 이 열차를 배포한다. PRO Worker 배포는 살아 있는 PRO 방 Durable Object를 다시
시작하므로(메모리에만 있는 백오프, 길이 읽기 자리, 하트비트 저장 타이머 초기화) 행사 시간은 피한다.

## 검증과 한계

- 테스트 먼저: 테스트 커밋(`acf045e5`)은 바꾸지 않은 Worker에서 통과했다(PRO 단위 4개 파일 570개).
- 실패 확인: 테스트 커밋만 둔 채 옛 Worker를 하나씩 바꿔 PRO 단위 4개 파일(570개)을 돌렸다.
  - 대기 중 조건을 빼면(재생 읽기가 등록 대기열을 무시) 1개 실패: 새 대기 중 조건 테스트.
  - 등록 대기열 알람이 파일 조회만 세면 1개 실패: 새 YouTube 조회 알람 테스트.
  - 알람 시각이 머리 뒤 레코드까지 보면 1개 실패: 새 머리 시각 테스트.
  - 에포크 변경이 아웃박스를 비우지 않으면 2개 실패: 방 잠듦과 PIN 변경 테스트(저장 기록 확인을
    더한 뒤. 더하기 전에는 0개였다).
  - 위 네 변형에서 이번에 더하거나 늘린 테스트 밖의 기존 테스트(`pro-room-worker.test.ts` 포함)는
    모두 통과했다. 새 테스트가 없으면 잡지 못했다는 뜻이다.
  - persist의 재생 flush를 기다리지 않으면 25개 실패(새 "요청이 재생 전송을 기다림" 포함), 바인딩이
    없어도 재시도 경로를 타면 12개 실패(새 바인딩 없음 테스트 포함), 재생 완료의 재시작 조건을 빼면
    2개, 등록 완료의 `if (finished)`를 빼면 2개 실패(새 세대 변경 테스트와 기존 점검 테스트).
  - 후속: `postSignalingBroadcast` 본문에 키 하나를 더하면 감싼 `natural-completion-integration`이
    62개 중 60개 실패한다(전에는 가짜가 어떤 JSON이든 받았다).
- 동작이 같다는 근거: 새 테스트와 기존 C7-0 특성 테스트, `pro-room-worker.test.ts`가 고치지 않은 채
  커밋마다 통과한다(`src/pro-room` 97개 파일 2,485개). 두 방향 레코드 fixture가 저장 레코드의
  바이트와 읽기를 확인한다.
- 전체 검사(`85e143c9`, 로컬): 타입 검사, lint, 서식, 빌드 통과. 단위 테스트 628개 파일 14,219개,
  Worker 테스트 59개 파일 2,857개 통과. 가드(dead-exports, bus-pairing, import-graph,
  lifecycle-writes, release-identity, sw-cache-version, source-complexity, d1-migrations,
  `check:workers`, resource-ownership) 통과. 브라우저 앱이 바뀌지 않아 브라우저 검사는 돌리지
  않았다. 로컬 결과는 정확한 main SHA 배포 후보를 대신하지 않는다.
- 배포 뒤 smoke(`smoke:live:signaling`, pro-room)는 PRO 방에서 시그널링으로 가는 broadcast와 길이
  읽기를 타지 않는다. 근거는 단위 경계 테스트와 실제 PRO·시그널링 Worker를 함께 띄우는 workerd 계약
  테스트다. 로컬 결과는 정확한 main SHA 배포 후보를 대신하지 않는다.
- 실기기 확인은 선택이다(오너가 원할 때): PRO 방에서 모두 나갔다가 재생 중에 다시 들어와 기기 2대가
  함께 이어 재생하는지, 파일을 올려 듣는 사람만 남았을 때 끝에서 다음 트랙으로 넘어가는지 본다.
  서버만 바뀌고 동작이 같아 필수 항목은 두지 않았다.
