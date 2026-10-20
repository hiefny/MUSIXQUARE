# PRO 행사 입장·Peer 번호 심층 감사 — 2026-10-13

| 항목 | 근거 |
| --- | --- |
| 상태 | 조사 완료, 수정·배포·새 운영 로그 수집 없음 |
| 검토 HEAD | `d279e9d3d0fc9115e36dde2dbc6e08d03627d5d7` |
| 현재 배포 소스 | `332600a9a00fcaafccae884558b5fcf29f816f25`, App 8.10.4 / v665 |
| 행사 시작 당시 소스 | `d76b1432`, App 8.9.0 |
| 조사 대상 | 2026-10-11 고객 행사에 쓴 PRO 방 1개(방 코드는 공개하지 않음) |
| 운영 조회 구간 | 2026-10-11 11:00–17:00 UTC = 10월 11일 20:00–12일 02:00 KST |
| 환경 | Windows, Node v24.13.1, Vitest 5.0.3, 설치된 Miniflare/workerd; Cloudflare 로그인 대시보드 및 D1 SELECT |

## 결론과 증거 수준

서로 다른 세 가지 사실을 하나의 정원 초과 사건으로 묶으면 안 된다.

1. **새 확정 결함:** 최대 동시 presence 4개로도 기본 이름 `Peer 77`이 생성된다.
   당시 소스와 현재 소스를 실제 HTTP 핸들러로 실행해 재현했다. 이전의
   “77이면 1–76번이 동시에 점유됐다”는 일반화는 틀렸다. 후속 확장 실험에서는
   `Peer 101`까지 생성됐고, 앱의 100 초과 번호 거부로 신규 입장이 실패하는
   영향도 확인했다. 단순 표시 문제에 그치지 않는다. 아래 A.1을 참고한다.
2. **새 확정 결함:** PRO 앞단의 공유 registry 조회 Promise는 최초 요청이
   취소되면 끝나지 않는 상태로 남아 뒤 요청까지 막을 수 있다. 당시 원문을
   실제 workerd에서 실행하고 요청별 격리 대조군과 비교했다. 현재 배포본에도
   같은 코드가 있다. 운영 로그의 요청 컨텍스트 취소 경고와 일치하는 결함
   종류지만, 로그에는 해당 Promise를 특정할 스택이 없으므로 현장 원인 확정은 아니다.
3. **현장 원인은 일부 미확정:** 100대 도달, REST 정원 거절, 특정 사용자의
   입장 실패 원인을 복원할 명단·응답 본문은 없다. 기존 stale-ticket 거절과
   실제 방 heartbeat timeout은 확인되지만, 둘만으로 모든 실패를 설명할 수 없다.

고객 보고의 "정원 100명에 걸린 것 같다"는 추정이다.
정확히 정원 오류 문구를 봤다는 증거와 구별해야 한다. 사용자가 관찰한 약 30대와
Peer 70번대 퇴장 알림은 서로 모순이라고 단정할 수 없다.

## A. 기본 Peer 번호가 저장된 옛 세션의 영향을 받음

임의의 높은 번호를 seed하지 않고 기존 `activatedRoom()` fixture에서 시작했다.
순서는 다음과 같다.

1. 익명 기기 73개를 **한 대씩** 입장시키고 presence 종료 요청으로 내보낸다.
   73번 모두 최초 이름은 `Peer 1`이라고 검증했다. 재입장용 세션은 보존된다.
2. 같은 계정으로 기기 두 대가 입장한다.
3. 대표 기기의 계정 연결을 해제한다. 남은 계정 기기의 회원 번호는 1로 남는다.
4. 새 익명 기기가 입장한다. 최초 응답은 `Peer 1`이다.
5. 다음 snapshot 요청에서 그 이름이 **`Peer 77`**로 바뀐다.

모든 단계에서 presence 4개 이하를 assertion으로 확인했다. 마지막 값은 저장
세션 77개, live presence 4개다. dormant 세션이 없는 대조군은 같은 순서에서
`Peer 4`가 됐다. Worker 재시작이나 저장 상태 직접 수정은 필요하지 않았다.

원인은 배정 규칙이 다르기 때문이다.

- 새 입장: live presence의 빈 물리 번호를 선택한다
  (`pro-room-worker.ts:9684–9795`).
- 정규화: dormant를 포함한 모든 저장 세션과 회원 번호 예약을 대상으로 고유
  번호를 만든다 (`9571–9673`).
- 이 정규화는 재시작 때만이 아니라 매 요청의 `ensureReady()`에서도 실행된다
  (`4278`, `normalizeLoadedAccountIdentity`).
- 계정 대표 기기 detach 후에는 남은 그룹과 새 익명의 번호 예약이 충돌할 수 있다
  (`9815`). 기존 dormant 번호까지 피하다가 높은 숫자로 밀린다.

이는 현재 presence 동안 번호가 안정적이어야 한다는
[계정·방 권한 계약](account-identity-and-room-authority.md)과 맞지 않는다.
다만 실제 행사에서 같은 계정 여러 기기 및 대표 기기 detach가 있었는지는 모른다.
계정 lease 만료 등 다른 detach 진입점은 코드에 있으나 이번 실행은 명시적 detach다.

**번호는 정원 점유량이 아니다.** 정원은 `presenceAdmissionAvailable()`의
presence 개수와 비소유자 개수로 검사한다 (`11781`). `Peer 77`을 77자리로
계산하지 않는다. 저장 세션 128개 한도는 별도이고 dormant eviction이 있다.

현재 D1 계정 닉네임 조사에서는 119계정 / 닉네임 113개 중 원문과 정규화 key
모두 `peer` 포함 결과가 0개였다. 현재 값 조사이므로 과거 닉네임까지 배제하지는
않는다. `Peer77`과 `Peer 77`은 닉네임 예약 규칙에서도 다르다.

### A.1 후속 검증: Peer 101은 정원 검사와 별개로 앱 입장을 깨뜨림

사용자의 “Peer 101도 생기면 실제 100명 미만이어도 입장이 막히는가” 질문에
대해 같은 순서를 97개 순차 익명 방문으로 늘렸다. 임의 고번호 seed 없이
현재 HEAD `d279e9d3d0fc9115e36dde2dbc6e08d03627d5d7`와 행사 당시
`d76b1432` 각각의 Worker·클라이언트 원문을 실행했다.

| 검사 | 현재·행사 당시 결과 |
| --- | --- |
| 번호 생성 전 전체 단계의 최대 live presence | 4 |
| 마지막 snapshot | 저장 세션 101, live presence 4, `Peer 101`, `memberDisplayNumber:101` |
| 실제 `parseProRoomSnapshot` | `null` 반환 |
| 같은 응답에서 100 초과 `memberDisplayNumber`만 범위 안으로 옮긴 대조군 | 정상 파싱 |
| 실제 `ProRoomApiClient.createSession()`을 Worker에 연결한 신규 입장 | HTTP 200, 앱 오류 `INVALID_RESPONSE` |
| 실패한 신규 기기 자신의 번호 / 서버 live 수 | 번호 1 / live 5. 본인 번호가 낮아도 명단 속 101 때문에 실패 |
| 이어서 HTTP 핸들러로 정원까지 입장 | 앞선 앱 실패 입장을 포함해 추가 96개 서버 admission 성공, live 100 |
| 그 다음 실제 정원 초과 요청 | HTTP 409, `{error:'ROOM_FULL'}` |

**정원 계산은 최대 번호를 쓰지 않는다.** 하지만 서버 번호 공간은 128까지이고
앱 parser는 참가자·viewer·관리자의 `memberDisplayNumber`가 100을 넘으면
거부한다 (`src/pro-room/snapshot.ts:529`, `646`, `704`). 명단의 한 참가자만
101이어도 snapshot 전체가 거부된다. API는 HTTP 200이어도 parser 실패를
`INVALID_RESPONSE`로 바꾼다 (`api.ts:1389`). UI 코드의 대응 문구는
“PRO 방에 연결하지 못했어요.”이며 전용 `ROOM_FULL` 문구와 다르다
(`setup-flow.ts:171`). 실제 브라우저 UI·WebSocket 연결까지 실행한 검사는 아니다.

추가 코드 검토로 확인한 영향은 다음과 같다. 이 부수 효과 전체의 시간 경과까지
통합 시뮬레이션한 것은 아니며, 위 표의 HTTP/API 결과와 구별한다.

- 서버 입장은 성공했지만 `authenticate()`가 파싱에서 실패하므로
  session controller의 `authenticated` 플래그가 켜지지 않는다. 실패 정리의
  `closeSessionFenced()` 조건을 통과하지 않아 새 presence가 TTL까지 남을 수
  있다 (`session-controller.ts:453–478`). 실제 하니스에서도 실패 직후 live는
  4에서 5로 증가했다.
- 이미 입장한 기기도 같은 snapshot을 받으면 새 명단을 적용하지 못한다.
  heartbeat는 서버 liveness 갱신 후 응답하므로 앱이 응답을 거부해도 서버의
  자리 점유는 살아 있을 수 있다. `INVALID_RESPONSE`는 terminal 오류가 아니므로
  runtime의 heartbeat 재시도가 이어진다. 낮은 수를 표시한 오래된 화면과
  다른 서버 presence 수가 공존할 수 있는 경로다.
- 같은 requestId 재시도는 보존되므로 이 설명은 정상 재시도가 무한히 새 기기를
  복제한다는 뜻이 아니다. 번호 고갈 시 세션 생성 실패도 직접 `ROOM_FULL`로
  매핑되는 것이 아니라 `SERVICE_NOT_CONFIGURED` 503이다.

현장 `Peer 77` 관찰만으로 101 도달을 추정할 수는 없다. 행사 당시 같은 계정의
복수 기기·detach 조합, 고번호가 실린 응답 본문, 실제 실패 문구는 여전히 없다.
따라서 **100명 미만에서 입장 실패를 만드는 코드 결함은 확정**, **행사 원인
귀속은 미확정**이다.

검증: Windows / Node v24.13.1 / Vitest 5.0.3. 현재 1 pass / 0 fail /
430 filtered skip, 행사 당시 1 pass / 0 fail / 405 filtered skip.
최초 진단 실행은 오류 본문을 `error.code`로 잘못 읽은 하니스 assertion 1건으로
실패했다. 실제 계약 `{error:'ROOM_FULL'}`로 바로잡은 뒤 위 결과를 얻었다.
제품 소스 변경·전체 unit/E2E·운영 부하 테스트·배포는 없다.

자료: ignored `scratch/peer101-admission-body.ts`,
`scratch/peer101-admission.config.ts`, `scratch/peer101-{current,d76b1432}.json`.
실행은 `PEER77_SOURCE=current` 또는 `d76b1432`를 설정하고
`node node_modules/vitest/vitest.mjs run --config scratch/peer101-admission.config.ts -t "TEMP peer101"`.

## B. 취소된 요청에 묶인 공유 조회가 이후 요청을 막음

`frontProvisionedRoomGeneration()`은 D1 binding별 module cache에
`refreshPromise`를 저장하고 여러 요청이 공유한다
(`cloudflare/pro-room-worker.ts:1360–1506`). 최초 요청이 만든 비동기 작업의
수명이 끝나면 `finally`까지 실행되지 않아 pending 상태가 남을 수 있다.
5초 cache TTL은 완료된 값의 신선도이며 이 pending을 회수하지 않는다.

실험은 당시 소스의 `interface ProRoomRegistryCache`부터
`function configuredAllowedOrigins` 직전까지를 그대로 추출해 TypeScript만
변환했다. SHA-256은
`848f70791db18b24368f77ea8b74e6714f2caa88560024a3c2c8a79069f16c61`이며,
`d76b1432`, 현재 배포 `332600a9`, HEAD의 해당 원문이 동일하다.

Miniflare/workerd의 App 모사 → PRO 앞단 → 느린 registry I/O 모사, 세 Worker로
실행했다. 최종 루트 재검증은 App 모사에 실제 App의 `2026-05-04`, PRO 앞단에
`2026-07-16` compatibility date를 썼다. 실제 D1과 전체 앱의 부하 재현은 아니다.

| 조건 | 최초 A | 50ms 뒤 B | 이후 C | 조회 상태 |
| --- | --- | --- | --- | --- |
| 원문처럼 pending 공유 | 502 | 502 | 502 | 조회 1회, pending 유지 |
| 요청마다 cache key 격리 대조군 | 502 | 200 | 200 | B·C는 각각 정상 조회 |
| pending 공유, 최초 요청 취소 없음 | 200 | 200 | 200 | 조회 1회, 정상 완료 cache 재사용 |

I/O 지연 500ms, A 취소 deadline 100ms, B·C deadline 2,000ms로 시간을 축소했다.
실제 일반 App→PRO 응답 예산은 5,000ms다. PIN만 보내는 legacy session-create는
직접 fetch 예외가 있으며, 현대 requestId 입장·일반 조회가 이 예산 대상이다.
핵심 조건은 **공유 I/O 완료 전에 최초
호출이 취소되는 것**이지, 운영 D1이 반드시 500ms/5초 걸린다는 뜻이 아니다.
공유 cache를 요청별로 바꾼 것은 원인 격리용 대조군이며 최종 수정 설계가 아니다.

mock `.all()`은 실제 D1 대신 느린 service binding을 기다리고, 동일한 binding
객체 재사용을 global 변수로 보장했다. 운영 D1 자체의 취소 전파와 요청 간
binding 객체 동일성을 이 실험에서 직접 검증한 것은 아니다. 대조군에서는 완료
cache도 분리되므로 그 그룹의 debug cache 값보다 200 응답과 실제 조회 횟수를
근거로 삼았다. 별도 에이전트가 이 하니스를 비판 검토하고 재실행했으며,
루트는 최초 요청이 취소되지 않는 공유-cache 대조군도 추가·실행했다.

이는 한 Worker 실행 인스턴스의 후속 요청에 영향을 주는 문제다. 모든 인스턴스나
모든 방이 동시에 고장 난다는 뜻도, 반드시 1분 후 복구된다는 뜻도 아니다.

같은 계열의 `service-maintenance.ts` 공유 refresh도 축소된 취소 실험에서 pending
잔존이 재현됐다. 다만 이 경로의 내부 예산은 2초로 App의 5초보다 짧다. 실제로는
더 이른 호출 취소 등의 조건이 필요하며, registry 경로와 동일 빈도라고 볼 수 없다.
원문 DO `withMutation()` 대조 실험은 같은 취소 조건에서 뒤 요청이 완료됐다.
따라서 이번 근거로 DO 직렬 대기열 자체가 영구 잠긴다고 지목하지 않는다.

[Cloudflare 공식 설명](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#handle-cross-request-promise-resolution-correctly)도
작업을 만든 요청 컨텍스트가 끝나면 해당 continuation이 실행되지 않을 수 있다고
명시한다. 경고가 제안하는 호환성 flag를 변경하지 않았다.

## C. 실제 운영 기록

### Workers 원시 로그

위 6시간 구간의 Workers 데이터셋에는 다음 4개 raw row가 있었다.
App·PRO custom logs는 head sampling 0.1이므로 발생 총수라고 해석하지 않는다.

| UTC (2026-10-11) | KST | 기록 |
| --- | --- | --- |
| 13:05:17.036 | 22:05:17 | PRO stateless Worker, `<행사 방>/system-audio` GET, 종료된 요청 컨텍스트의 Promise continuation 취소 경고 |
| 14:11:54.006 | 23:11:54 | App `<행사 방>/presence/heartbeat` POST, `SERVICE_RESPONSE_TIMEOUT` |
| 14:12:37.669 | 23:12:37 | 같은 API, 같은 오류 |
| 14:12:46.806 | 23:12:46 | 같은 API, 같은 오류 |

PRO 경고 version `9a93389f-0bb1-4b5f-833a-05925ec34f7d`, App 오류 version
`5d6f99f1-bd20-490a-b5e8-58a6bd2faacd`. 경고는 stateless 앞단에 기록됐으며
어느 공유 cache인지 식별할 스택이 없다. 세 timeout은 방이 명시된 실증거다.
다만 admission 요청 자체의 timeout은 아니므로 그대로 입장 실패 건수로 세지 않는다.

### 행사 방 Durable Object 메트릭

Cloudflare에서 `MusixquareProRoom`의 행사 방 객체(`<행사 방>:generation:0`)를 직접 선택했다.
동일 6시간 구간에 대시보드 표시값은 요청 약 15k, 오류 분류 194개이며 194개는
모두 client disconnected였다. CPU 제한 초과, Worker exception, internal은 0.
요청 wall time P50 310ms, P90 776ms, CPU P99 38.88ms, 메모리 P99 10.72MB였다.

요청·오류 횟수는 참가자 수가 아니다. client disconnected는 HTTP 호출자 취소를
포함하므로 사람 194명이 퇴장했다는 뜻도 아니다. 이 통계는 CPU 한도 초과 근거가
없다는 뜻이며, 앞단에서 DO 도달 전에 실패한 요청이나 일시적인 긴 지연까지
배제하지 않는다. 메모리는 provider가 측정하는 isolate 범위다.

### Signaling D1 카운터와 HTTP 샘플

동일 11:00–17:00 UTC 구간 D1 SELECT 결과:

- `pro_member_joined`: 283. **전체 PRO 방의 연결 성공 이벤트**이며 재연결을 포함한다.
- `pro_ticket_stale_presence`: 19. 전체 PRO 방 집계이며 방별 귀속은 불가능하다.
- `pro_room_full`: 해당 행 없음. 이는 WS map 정원 거절 카운터이고 REST 정원 거절
  카운터가 아니므로, 이것만으로 REST 정원 미도달을 증명하지 못한다.

이전 10:00–22:00 UTC 조회의 성공 연결 315건과는 시간 범위가 다르다.
이번 SELECT의 `changes=0`, `rows_written=0`을 확인했다.

HTTP adaptive log에는 12:36:44 UTC에 `POST /rooms/<행사 방>/sessions`
409가 있었다. 응답 body가 없으므로 `ROOM_FULL`, idempotency 충돌, 세션 replay
불가, 계정/상태 저장 용량 오류 등을 구별할 수 없다. 같은 방의 presence enter
409/502 및 system-audio/account-lease 502도 확인됐다. 같은 6시간의 room 429
조회는 0행이지만, 샘플 조회이므로 전수 부재 증거는 아니다.

8.9.4의 ticket 수정은 실제로 있던 presence revision 경합을 고쳤다.
App proxy/PRO Worker의 이번 두 경로를 바꾼 수정은 아니므로 “그 배포로 전부 해결”로
정리할 근거가 없다.

## D. 정원·명단·재시도의 경계

- REST 정원은 총 presence 100, 비소유자 99다. WS 성공 전에 REST 입장으로 자리를
  차지한다. 화면의 계정 행은 여러 기기를 묶을 수 있으나 연결 숫자는 기기 수다.
- 종료 통보가 없으면 마지막 liveness 후 45초까지 점유한다. heartbeat가 계속되면
  재생 실패·WS 회복 중인 기기도 남는다.
- 실제 Worker 인메모리 admission/prune 실행: 30개는 살아 있고 70개가 종료 통보
  없이 남은 fixture에서 44,999ms에는 `ROOM_FULL`, 45,000ms prune 뒤에는 입장
  성공·presence 31이었다. 이는 조건부 재현이지 행사에 ghost 70개가 있었다는 증거가 아니다.
- 같은 requestId 재시도 20회는 presence를 늘리지 않았다. 정상 멱등 재시도가
  사람 하나를 무한 복제한다는 경로는 발견하지 못했다.
- WS `open`은 서버 승인 `peer-open` 프레임보다 먼저 성공 처리된다. upgrade 뒤
  거절·close되면 즉시 퇴장 대신 heartbeat/ticket 회복 경로가 이어질 수 있다.
- REST 명단 변경이 signaling에 아직 전달되지 않으면 둘의 순간적인 수는 다를 수
  있다. 이는 코드상 가능한 경로이며 이번에 시간차까지 통합 재현하지는 않았다.
- 전용 “PRO 방이 가득 찼어요” 문구는 API의 `ROOM_FULL`에만 연결된다.
  429는 대기 안내, 다른 API 실패와 WS 거절은 일반 연결 실패/회복 경로다.
- **같은 순간의 최신 authoritative 기기 수가 30인데 REST가 정원만으로 full을
  돌려주는 경로는 이번 조사에서 발견하지 못했다.**

## 검증 결과와 미실행 범위

- Peer 번호: 현재 소스 2 pass / 0 fail / 430 filtered skip.
- 같은 HTTP 재현을 당시 전체 소스 archive에서도 실행: 2 pass / 0 fail /
  405 filtered skip. 위 skip은 `-t`로 제외한 기존 테스트이지 환경 미설치가 아니다.
- 루트 조사자가 두 버전 모두 다시 실행해 같은 결과를 확인했다.
- registry 원문 workerd 실험: 공유 시 A/B/C 502, 격리 대조 시 502/200/200.
  최초 취소 없는 공유 대조는 모두 200이다. 루트가 하니스를 읽고 재실행했다.
  운영 장애 전체 재현/실제 D1 장애 재현은 아니다.
- DO 직렬화 대조 및 maintenance 공유 refresh 실험은 조사 에이전트가 실행했다.
- 기존 전체 unit/E2E, 실기기, 운영 부하 테스트는 실행하지 않았다.
- 제품 코드·설정·버전·운영 로그 수집 정책·배포를 변경하지 않았다.

로컬 재현 자료는 ignored `scratch/peer77-reachable-body.ts`,
`scratch/peer77-reachable.config.ts`, `scratch/peer77-{current,d76b1432}-{0,73}.json`에
있다. 실행은 `PEER77_SOURCE=current` 또는 `d76b1432`를 설정하고
`node node_modules/vitest/vitest.mjs run --config scratch/peer77-reachable.config.ts -t "TEMP peer77"`.
registry 하니스는 로컬 TEMP `mxqr-readonly-audit-20261013/registry-promise-cancellation.mjs`에
보존했다. 아직 정식 회귀 테스트로 편입한 파일은 없다.

## 후속 방향

수정 승인이 나면 공유 pending 작업의 수명을 요청과 분리하고, 취소·실패 뒤 후속
요청이 회복되는 것을 actual workerd 회귀로 고정한다. 완료된 값만 cache하는
설계와 안전한 deduplication의 비용을 비교하며 timeout/정원만 늘려 가리지 않는다.
번호는 live/dormant와 회원/물리 기기의 규칙을 일치시켜 위 HTTP 재현을 고정한다.

현장 입장 거절의 최종 귀속은 여전히 열려 있다. 최소 집계가 필요하다면 그 뒤에
REST 거절 사유와 해당 순간 presence 수, WS 거절 수를 개인정보 없이 나누는 것이
유효하다. 이번에는 새 수집 기능을 넣지 않았다.
