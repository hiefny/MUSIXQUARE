# PRO 방 시그널링 전송 하나 (Phase 1 PRO Worker A, 2026-10-23)

| 항목     | 범위                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 기준 SHA | `2ba4cbd6` (main, Phase 0d 서버 Worker 배포·기록본: C7-0 workerd 계약, 0d 서버 상수 포함)              |
| 코드 SHA | `059778c1`                                                                                             |
| 후보     | PRO Worker만, target `pro-room`. App 버전·SW 캐시(9.0.3 / v771)와 버전 표기는 그대로. 미배포           |
| 열차     | 구조 개선 Phase 1 PRO Worker A: C7-3 시그널링 요청 빌더 하나. 동작 변경 없음                           |
| 환경     | Windows 11, Node 24.20.0, npm 12.0.2, Vitest 5.0.3(node), 로컬 workerd(Miniflare, 실제 두 Worker 번들) |

## 왜 고쳤나

PRO 방 Durable Object가 시그널링 객체의 `/internal/realtime/v1/broadcast`로 보내는 요청을 두
곳이 따로 만들었다. 프레즌스 스냅샷과 재시도 없는 무효화 알림은 `broadcastServerEvent`가, 재생
아웃박스(PREPARE, CANCEL, COMMIT)는 `dispatchPlaybackBroadcast`가 엔드포인트, 헤더, 세대 필드,
본문, 900ms 마감을 각자 적었다. 두 사본은 받은 답을 언제 "전달됨"으로 치는지만 달랐다.
[자원 소유권 장부](resource-ownership-registry.md) RO-07의 목표(요청 빌더 하나, 아웃박스 주인
하나)로 가는 첫 단계다.

이 빌더가 틀리면 운영에서 바로 깨지는데, 지금까지는 아무 검사도 그걸 잡지 못했다. 시그널링은
본문 키가 하나라도 더 있거나 빠지면 400으로 거절한다(`hasExactKeys`). 방은 그 거절을 "전달
안 됨"으로 받아 재시도만 하고, 단위 테스트의 가짜 시그널링은 어떤 JSON이든 받았다. 배포 뒤
smoke도 이 경로를 타지 않는다. 그래서 테스트를 먼저 강화한 뒤 코드를 합쳤다.

## 바뀐 것

- **테스트 먼저(바꾸지 않은 Worker에서 통과).**
  - `src/pro-room/__tests__/__helpers__/signaling-broadcast-contract.ts`: 시그널링이 받는 본문
    키 집합(`coordinatorEpoch`, `event`, `roomCode`, `roomGeneration`, `targets`)과 방 코드·세대
    헤더 규칙을 한 곳에 적었다. 가짜 fetch를 감싸 broadcast 요청마다 본문 복사본을 옆에서 읽어
    검사하고, 위반은 afterEach의 `assertClean()`이 테스트 실패로 낸다. 가짜 안에서 바로
    assert하면 방의 `catch`가 삼켜 "전달 안 됨"이 될 뿐이기 때문이다. 감싼 가짜는 같은 요청을
    같은 시점에 받는다.
  - `pro-room-worker.test.ts`: `installRealtimeRecorder`와 broadcast에 답하는 다른 가짜 시그널링
    18곳을 모두 감쌌다. 새 묶음 "one signaling broadcast transport"가 두 경로의 요청 바이트(키
    순서 포함)·헤더·방 주소가 같다는 것, 기본 대상과 에포크, 두 수락 규칙 표(답 14가지), 예외와
    바인딩 없음, 900ms 마감과 요청 중단을 고정한다.
  - 소유권 경계 fixture의 `FencedSignaling`도 같은 규칙을 쓰고, 거절한 본문이 하나라도 있으면
    `dispose()`가 테스트를 실패시킨다.
  - 실제 workerd 계약(`pro-room-signaling-contract-workerd`)에 PIN 변경 사례를 더했다. 방이
    스스로 보낸 새 에포크의 프레즌스 스냅샷이 시그널링 펜스를 올리고, 새 에포크의 PREPARE와
    COMMIT이 그 에포크에 연 소켓까지 간다(eligible 1, sent 1). 옛 에포크의 PREPARE와 프레즌스
    본문은 409 `PRO_ROOM_EPOCH_STALE`을 받는다. 기존 두 사례(모든 경로의 정확한 키, PREPARE와
    COMMIT 수락, 손으로 올린 펜스 뒤의 409)는 그대로다.
- **PRO Worker (C7-3).** `postSignalingBroadcast({coordinatorEpoch, targets, event}, acceptance)`가
  요청을 한 번 만든다. `broadcastServerEvent`는 `'http-ok-json'`(HTTP 200이고 본문이 null이 아닌
  JSON), `dispatchPlaybackBroadcast`는 `'full-fanout'`(HTTP 200이고 본문이 정확히
  `{broadcast: true, eligible, sent}`이며 sent와 eligible이 같음)으로 부른다. 둘 다 이름, 인자,
  기본값, 참/거짓 결과가 그대로다. 둘은 이제 async가 아니고 빌더의 promise를 그대로 돌려줘서,
  호출한 쪽이 결과를 받는 마이크로태스크 시점도 예전과 같다. 파일은 4줄 줄었다(18,153줄에서
  18,149줄).
- **가드와 장부.** `check-resource-ownership`의 RO-07 엔드포인트 호출 위치 기준선에서
  `broadcastServerEvent`와 `dispatchPlaybackBroadcast`(각 1)를 빼고 `postSignalingBroadcast`(1)를
  넣었다. 시그널링 라우트까지 합쳐 3곳에서 2곳이 됐다. RO-07 기록에 빌더 하나와 두 수락 규칙을
  적었다. 아웃박스 주인(C7-4)이 남아 상태는 `duplicated` 그대로다.

## 그대로 둔 것

- 요청: URL, 메서드, 헤더 세 개, 본문 바이트와 키 순서, 900ms 마감과 중단, 바인딩이 없을 때
  바로 실패, 예외를 실패로 바꾸는 처리, 로그(두 함수 모두 남기지 않음)가 같다.
- 수락 규칙과 재시도는 경로마다 그대로다. 프레즌스는 HTTP 200 JSON이면 부분 전달(sent <
  eligible)도 전달로 치고, 재생은 모두에게 전달됐을 때만 레코드를 지운다. 프레즌스의 즉시 3회와
  표시 레코드, 재생 아웃박스의 백오프, 무효화 알림의 1회 전송(RO-46)은 건드리지 않았다.
- 호출 위치의 실행 방식(응답 전에 기다림, 백그라운드)은 하나도 바뀌지 않았다.
  - 응답 전에 기다리는 무효화 전송 12곳(persist 뒤 `broadcastServerEvent`를 직접 await):
    `handleInternalDeveloperCommandCreate` 2곳(효과, 재생목록 전환), `handleUpdateEffects`,
    `handleUpdateSettingsSync`, `handleUpdateQueueMode`, `handleAcquireSystemAudio`,
    `handleCommitSystemAudio` 2곳, `handleReleaseSystemAudio`,
    `commitParticipantSnapshot`(`handleCompactSnapshotMutation`에서), `handlePlaylistSwitch`,
    `handlePlaylistTransfer`.
  - 백그라운드: `scheduleServerEvent`가 프레즌스 스냅샷은 `deliverPresenceBroadcast`로, 다른
    서버 이벤트는 `broadcastServerEvent`로 보내고 `waitUntil`에 맡긴다(`waitUntil`이 없으면
    `catch`에서 경고 로그). 재생 이벤트는 여기서 보내지 않고 아웃박스에 넣는다.
  - 프레즌스 경로 안: `deliverPresenceBroadcast`(최대 3회 await), 알람의
    `retryPendingPresenceBroadcast`(await).
  - 재생 아웃박스: `flushPendingPlaybackBroadcasts`가 머리 레코드를 `dispatchPlaybackBroadcast`로
    await한다.
- 저장 레코드(`pendingPresenceBroadcast`, `pendingPlaybackBroadcasts`)의 모양, 아웃박스
  주인(C7-4), 길이 읽기 주인(C7-6)은 이번 범위가 아니다.
- 시그널링 Worker 소스는 고치지 않았다.

## 호환성

통신 형식(요청 바이트와 헤더, 시그널링 답의 해석), Durable Object 저장 레코드, D1, 비밀값,
바인딩 변경 없음. 브라우저 앱, App 버전, SW 캐시와 버전 표기도 그대로다(Worker만 바뀌는
변경). 바뀐 런타임 파일은 `cloudflare/pro-room-worker.ts` 하나라 release target은 `pro-room`
단독이다. 마지막 배포(`86ccefe6`) 뒤 App 런타임 경로(테스트를 뺀 `src`, `browser`,
`cloudflare/app-worker.ts` 등)는 바뀌지 않았으므로, 부분 릴리스 호환성 게이트가 `pro-room`
단독 배포를 막지 않는다. 새 테스트 도우미는 `src/**/__tests__/**` 아래라 App 경로에서 빠진다.
PRO Worker 배포는 살아 있는 PRO 방 Durable Object를 다시 시작하므로(메모리에만 있는 백오프와
하트비트 플러시 타이머 초기화) 행사 시간은 피한다.

## 검증과 한계

- 테스트 먼저: 테스트 커밋(`4d709a84`)은 바꾸지 않은 Worker에서 통과했다(PRO 단위 4개 파일
  555개, workerd 계약 3개).
- 실패 확인: 테스트 커밋만 둔 채 옛 빌더를 바꿔 봤다. `broadcastServerEvent` 본문에 키
  하나(`presenceRevision`)를 더하면 72개, `dispatchPlaybackBroadcast` 본문에서 `targets`를 빼면
  73개가 실패했다(`pro-room-worker` 52개와 56개, `pro-room-signaling-delivery` 14개와 13개,
  `pro-room-duration-reads` 6개와 4개). 같은 두 변형에서 고치기 전의 `pro-room-worker.test.ts`는
  458개 모두 통과했다. 새 정확한 키 검사가 없으면 이 파일은 빌더 회귀를 잡지 못했다는 뜻이다.
- 동작이 같다는 근거: 새 전송 테스트(요청 바이트, 수락 표, 마감)와 C7-0 특성 테스트(전달
  경로의 수락, 백오프, 순서, 저장 모양)가 고치지 않은 채 구현 뒤에도 통과한다.
- 대상 테스트: `src/pro-room`, `resource-ownership-guard`, `src/network/transport`(111개 파일
  3,243개)와 Worker 설정 `vitest.workers.config.ts`(57개 파일 2,760개, workerd 계약 포함)
  통과. `check:workers`, `guard:source-complexity`, 소유권 가드 통과.
- 전체 검사(`059778c1`, 로컬): 타입 검사, lint, 서식, 빌드 통과. 단위 테스트 627개 파일 14,122개,
  Worker 테스트 57개 파일 2,760개 통과. 가드(dead-exports, bus-pairing, import-graph,
  lifecycle-writes, release-identity, sw-cache-version, source-complexity, d1-migrations,
  `check:workers`, resource-ownership) 통과. 브라우저 앱이 바뀌지 않아 브라우저 검사는 돌리지
  않았다. 로컬 결과는 정확한 main SHA 배포 후보를 대신하지 않는다.
- 배포 뒤 smoke(`smoke:live:signaling`, pro-room)는 PRO 방에서 시그널링으로 가는 broadcast를
  타지 않는다. 근거는 실제 PRO Worker와 시그널링 Worker를 함께 띄우는 workerd 계약 테스트다.
  로컬 결과는 정확한 main SHA 배포 후보를 대신하지 않는다.
- 실기기 확인은 선택이다(오너가 원할 때): PRO 방 하나에 기기 2대로 트랙을 고르고 둘이 함께
  시작하는지 본다. 서버만 바뀌고 동작이 같아 필수 항목은 두지 않았다.
