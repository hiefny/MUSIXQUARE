# PRO 행사 피드백 코드 심층 리뷰: 정원 오판·슬립 정지·Peer 번호 — 2026-10-13

| 항목 | 값 |
| --- | --- |
| 상태 | 읽기 전용 코드 리뷰. 제품 코드·설정·문서 색인·릴리스 기록 변경 없음, 실행·배포 없음 |
| 검토 HEAD | `d279e9d3` (main) |
| 입력 | 행사 주최 측 고객의 피드백 메일, 오너 관찰("최대 30명 남짓", "피어 70번대 퇴장 기록"), 참가자가 이동하며 폰을 주머니에 넣고 쓰는 대규모 야외 행사 사용 보고 |
| 목적 | 로그 수집 작업을 설계하기 전에, 코드만으로 어떤 경로가 증상을 만들 수 있고 어떤 경로는 구조적으로 불가능한지 가른다 |
| 병행 문서 | [PRO 행사 입장·Peer 번호 심층 감사](pro-event-admission-deep-audit-2026-10-13.md) (같은 날, 로컬 재현 포함). 이 문서는 그 감사가 다루지 않은 슬립·백그라운드 체인, 과금 외 거절 경로, 로그 설계를 보강하고 중복 주장은 반복하지 않는다 |

## 0. 한 줄 요약

- "12명인데 100명 한도처럼 입장 불가"는 코드상 **실제 `ROOM_FULL`이 아니어도 같은
  체감을 만드는 경로가 네 가지** 있다(§3). 실제 `ROOM_FULL`은 45초 안에 하트비트를
  보낸 비소유자 프레즌스가 99개일 때만 나오며, 만료 프레즌스가 정원에 섞이는
  경로는 없다(§2.3). 따라서 로그 없이는 "정원 도달"과 "정원처럼 보이는 실패"를
  구별할 수 없고, 수집해야 할 항목은 바로 그 구별에 맞춰야 한다(§6).
- "폰이 슬립하면 음악이 멈춤"은 플랫폼 정책(iOS WebKit 서스펜드)과 **앱 자체
  설계(45초 프레즌스 TTL → 만료 → 런타임 전면 해체 → 미디어 캐시 폐기 → 재입장
  → 탭 요구)** 가 겹친 결과다(§4). 이동 중처럼 모든 폰이 주머니에 들어가는 사용에서는
  마지막 프레즌스 만료 시 **방이 sleeping으로 가며 재생 위치를 동결**하므로 그룹 전체의
  음악이 멈춘다.
- "피어 70번대 퇴장 기록"은 동시 접속 수의 증거가 아니다. 병행 감사가 live 4대에서
  `Peer 77`·`Peer 101` 생성을 재현했고, 이 리뷰는 그 경로(매 요청 `ensureReady()` 안의 번호
  정규화)를 코드에서 확인했다(§5). 퇴장 알림 자체는 슬립으로 인한 TTL 만료 churn과
  일치한다.

## 1. 증상 ↔ 사용자 노출 문구 매핑

| 사용자 체감 | 서버 응답 | 앱이 보여 주는 문구 | 근거 |
| --- | --- | --- | --- |
| "PRO 방이 가득 찼어요 / 최대 100대, 소유자 자리 1개 예약" | REST `ROOM_FULL` 409 | `pro.room_full` + `pro.room_full_detail` | `src/pro-room/setup-flow.ts:171-183`, `src/i18n/en.ts:812-814` |
| "입장 시도가 너무 많아요. N분 뒤" | REST `RATE_LIMITED` 429 | `pro.join_rate_limited(_later)` | 같은 함수, `en.ts:815-816` |
| "PRO 방에 연결하지 못했어요" (일반) | 그 외 모든 REST 실패, 파서 거부(`INVALID_RESPONSE`), 시그널링 WS 거절 | `pro.connect_failed` | `setup-flow.ts:183`, `network-bridge.ts:619-636` |
| "이전 연결이 남아 있어요 / 여기서 계속" | `presence/enter` → `PRESENCE_ACTIVE_ELSEWHERE` 409 | 8.9.4 takeover 안내 | `pro-room-worker.ts:15094-15101`, [PWA 강제종료 감사](pro-pwa-force-close-audit-2026-10-12.md) |
| 스탠다드 방 "방이 가득 찼어요 / 호스트 포함 100대" | 시그널링 `room-full` 계열 close | `network.session_full(_detail)` | `src/ui/setup.ts:596,651,749-756`, `en.ts:526-528` |

고객 보고의 "정원 100명에 걸린 것 같다"는 추정 표현이다. 위 다섯 문구 중
어느 것을 봤는지가 수집 1순위다(§6.4).

## 2. 정원 판정 경로: 코드로 확정한 사실

### 2.1 상수와 배포 설정

| 항목 | 값 | 위치 |
| --- | --- | --- |
| PRO 프레즌스 정원 | 총 100, 비소유자 99 (소유자 자리 1 예약) | `cloudflare/pro-room-worker.ts:1080-1090`, `11781-11790` |
| 프레즌스 TTL | 45 s (운영 var도 "45") | `1143`, `cloudflare/wrangler.pro-room.toml:28` |
| 클라이언트 하트비트 | 15 s, 완료 후 재예약 (요청 시간이 간격에 더해짐) | `src/pro-room/runtime.ts:182`, `3055-3058` |
| 하트비트 요청 타임아웃 | 15 s | `src/core/request-lifetime.ts:1` |
| 저장 세션(쿠키) | 최대 128, TTL 30일 (운영 2592000) | `1091`, `1135`, `wrangler.pro-room.toml:27` |
| 시그널링 PRO 소켓 정원 | 100 | `cloudflare/signaling-protocol.ts:6`, `signaling-worker.ts:6255-6264`, `3618-3622` |
| 스탠다드 방 정원 | 호스트 + 게스트 99, 재접속 바인딩 256 (TTL 5분) | `signaling-worker.ts:560-562`, `618-636` |

### 2.2 `ROOM_FULL`이 나오는 다섯 지점은 모두 같은 함수를 지난다

`joinPresence()`(`11792`)는 이미 프레즌스가 있는 participantId면 `lastSeenAtMs`만
갱신하고 정원을 보지 않는다. 새 participantId일 때만 `presenceAdmissionAvailable()`
(`11781`)을 거친다. 호출 지점: 신규 입장 `14817`/`14860`, 재시도 replay·recovery
`14684`/`14746`, 쿠키 resume `15094`. 즉 **정원 거절을 받는 사람은 "새 세션"이거나
"프레즌스가 만료된 뒤 돌아온 세션"뿐**이고, 살아 있는 참가자는 절대 거절되지 않는다.
"12명 중 2명만 실패"는 이 구조와 정확히 맞는다(그 2명은 새 쿠키 또는 만료 후 복귀).

### 2.3 만료 프레즌스가 정원에 섞이는 경로는 없다

- 모든 `/v1/rooms/{code}/*` 요청(bootstrap 제외)은 핸들러 전에 `prune(Date.now())`를
  돈다(`7163`, 내부 경로 `6904`/`6913`/`7104`, 알람 `17168`). prune은
  `lastSeenAtMs + TTL <= now`인 프레즌스를 제거한다(`16896-16900`).
- `lastSeenAtMs`를 갱신하는 모든 지점은 요청자 자신의 프레즌스다(하트비트 `15429`,
  시스템오디오 `11629-11742`, READY `15874`, takeover `11902`, PIN 회전 시 소유자
  `15265`). 남의 프레즌스를 살려 두는 경로는 없다.
- 세션 128개 초과 시 **프레즌스가 없는** 가장 오래된 세션만 축출한다(`10880-10894`).
  살아 있는 사람을 밀어내지 않는다.
- 세션 수와 프레즌스 수는 다르다. 명시적 나가기(`handleCloseSession`, `15106`)만
  세션을 지우고, 탭 닫기 `pagehide`(`handleClosePresence`, `15484`)와 TTL 만료는
  세션을 남긴다. 그래서 30일 동안 dormant 세션이 쌓인다(§5).

결론: REST `ROOM_FULL`은 "그 순간 45초 안에 하트비트를 보낸 문서가 99/100개"일 때만
나온다. 사람 수가 아니라 **하트비트를 보내는 문서 수**다. 한 사람이 인앱 브라우저
(Instagram/WhatsApp WebView), Safari, 설치형 PWA 등 서로 다른 쿠키 저장소로 열면
각각 세션·프레즌스를 차지하고, 백그라운드 탭도 JS가 살아 있는 한 하트비트를 계속
보낸다(§4.2). 행사에서 이것이 99까지 갔는지는 로그가 없어 미확정이다. 병행 감사의
D1 조회에서 시그널링 `pro_room_full`은 0행이지만, REST가 비소유자 99에서 먼저 거절하면
WS 소켓 맵은 100에 도달할 수 없으므로 **그 0행은 REST 정원 도달 여부를 가르지 못한다**.

### 2.4 시그널링 100 소켓 정원은 REST 프레즌스에 종속된다

`proMembers`는 participantId 키 맵이며 ① 소켓 close/error(`8116-8120`),
② 프레즌스 스냅샷 브로드캐스트 때 live incarnation에 없는 소켓 revoke
(`6143-6153`, `PRO_PRESENCE_REVOKED`), ③ 재기동 시 live 소켓 재색인(`3578-3622`)으로
정리된다. 따라서 WS 정원은 REST 프레즌스 수를 거의 그대로 따라가고, 독립적으로
거짓 "full"을 만들기 어렵다. 거절돼도 앱은 `pro.connect_failed`(일반 문구)로 보인다.

## 3. "입장 불가"를 만들 수 있는 경로 (가능성 순)

| # | 경로 | 보이는 문구 | 전제 조건 | 현재 증거 |
| --- | --- | --- | --- | --- |
| H1 | 실제 `ROOM_FULL`: 하트비트 문서 99/100개 | PRO 방이 가득 찼어요 (100대) | 사람 수 × 쿠키 저장소 수 + 백그라운드 생존 탭이 99에 도달 | 직접 증거 없음. `pro_room_full` 0행은 판별 불가(§2.3) |
| H2 | 병행 감사 A.1: dormant 세션 + 계정 detach 조합으로 `Peer 101` 생성 → 앱 파서가 스냅샷 거부 → 정원 미달에서도 신규 입장 실패 | PRO 방에 연결하지 못했어요 | 같은 계정 복수 기기 + 대표 기기 detach + dormant 세션 다수 | 로컬 재현 확정, 현장 발생은 미확정. 파서 한계 `src/pro-room/snapshot.ts:529,646,704`(100 초과 거부), `api.ts:1389` |
| H3 | 복귀 사용자의 takeover 안내에서 취소: 이전 문서(인앱 브라우저·강제종료 PWA)가 45초 안에 살아 있음 | 이전 연결이 남아 있어요 | 같은 쿠키로 두 번째 문서 열기 | 현장 HTTP 샘플에 `presence/enter 409` 존재(병행 감사 §C). `PRESENCE_ACTIVE_ELSEWHERE`가 바로 이 409다 |
| H4 | PIN 실패 10회/시간이 **정확한 IP 해시** 단위: 통신사 CGNAT 뒤 군중이 한 IP를 공유 | 입장 시도가 너무 많아요 | 방에 PIN이 있었을 것 | 샘플 로그에 429 0행(전수 아님). PIN 유무 미확인. `pro-room-worker.ts:9330-9333`, `14829-14836`, 앞단 `4067-4082` |
| H5 | 병행 감사 B: 앞단 공유 registry 조회 Promise가 취소 뒤 pending 잔존 → 후속 요청 502 | PRO 방에 연결하지 못했어요 | 느린 D1 + 최초 요청 취소 | 현장에 presence enter/system-audio 502 관찰 |
| H6 | 시그널링 소켓 정원 | PRO 방에 연결하지 못했어요 | H1과 같은 전제 | `pro_room_full` 0행이라 낮음 |

H4 보충: 입장 throttle(200회/10분)은 IPv4 전체 주소·IPv6 /64 단위라
(`1206-1207`, `3933`, `4086-4094`) 30명 규모에서 걸리기 어렵다. 반면 PIN 실패와
소유자 복구 계열은 `rateLimitKey()`가 정확한 IP 해시다. 현지 모바일망 IPv4는 CGNAT
비율이 높아 **같은 IP를 쓰는 낯선 사람들의 오타까지 합산**된다. 공개방(PIN 없음)이면
이 경로는 해당 없다. [known-accepted #11](../known-accepted.md)은 입장 throttle만
서술하고 이 PIN 키 단위는 "정확한 주소"라고만 적어 두었다.

## 4. "폰이 슬립하면 음악이 멈춤": 코드가 만드는 체인

### 4.1 설계 의도와 실제 체인

설계 문서는 "hidden/background는 leave가 아니다, 재생은 화면 잠금을 넘겨야 한다"고
못 박았다([PWA 강제종료 감사](pro-pwa-force-close-audit-2026-10-12.md)). 실제로
`visibilitychange → hidden`은 복구 플래그만 세우고 하트비트 타이머를 끄지 않는다
(`runtime.ts:3381-3390`). 그러나 타이머는 평범한 `setTimeout`이다
(`src/core/timers.ts:34-48`, 워커 기반 아님). 그래서 다음 체인이 성립한다.

1. 화면 잠금 → iOS Safari/PWA는 JS를 서스펜드(오디오 세션이 살아 있지 않으면). Android
   Chrome은 가청 탭이면 타이머를 유지하지만 OEM 절전·탭 폐기가 끼어들 수 있다.
   (플랫폼 동작이라 코드로 증명 불가. [known-accepted #6](../known-accepted.md) 범위.)
2. 하트비트가 끊기면 **45초** 뒤 서버 prune이 프레즌스를 제거한다. 요청 타임아웃 15 s +
   간격 15 s 구조라 **연속 2회 실패(터널·군중 혼잡)만으로도 만료**될 수 있다. 대규모
   야외 행사의 셀 혼잡은 이 조건을 쉽게 만든다. 병행 감사가 본 하트비트
   `SERVICE_RESPONSE_TIMEOUT` 3건이 이 유형이다.
3. 제거 즉시 다른 참가자 화면에 "{{name}} left"가 뜬다(`en.ts:848`,
   `runtime.ts:1057-1090`, `presence-projection.ts`). **오너가 본 "퇴장 기록"의 상당수는
   이 TTL 만료**로 설명된다. 시그널링은 다음 스냅샷에서 그 소켓을
   `PRO_PRESENCE_REVOKED`로 끊는다(`signaling-worker.ts:6143-6153`).
4. **마지막 참가자까지 만료되면** 방이 `sleeping`이 되고 재생 위치를 동결한다
   (`removePresence` `13592-13600`, `freezePlayback` `11930`). 이동하는 참가자는 전원이 폰을
   주머니에 넣는 순간 이 조건에 들어간다. 첫 복귀자가 들어오면 동결 지점부터 wake
   PREPARE로 재개한다(`11817-11856`). 사용자는 "다 같이 멈췄다가 누가 폰을 보면 다시
   나온다"로 체감한다.
5. 폰을 깨운 기기는 하트비트에서 `PRESENCE_EXPIRED`(`11274-11284`, 복구 헤더가 있을 때)를
   받고 `recoverTerminalSession()`으로 간다(`runtime.ts:2812-2863`). 이 경로는
   `stopLifecycle()` + `resetProSystemAudioService()` + `resetPlaylistRuntime()`을 실행하고
   **RAM 미디어 캐시를 비운다**(`runtime.ts:1520` `mediaTransfer?.cache.clear()`,
   `src/pro-room/media-cache.ts:137-140`). 재입장 뒤 현재 곡을 R2에서 다시 받아야 하므로
   모바일 데이터 소모와 수 초 이상의 공백이 생긴다.
6. iOS에서는 AudioContext가 `interrupted`/정지 상태라 제스처 없이는 못 살린다
   (`src/audio/context-recovery.ts` 헤더, `context.ts:860-870`). 재생 복원 실패 시
   "탭해서 재생 재개"(`pro.resume_tap`, `runtime.ts:2990-2994`, `en.ts:782`) 토스트가
   뜬다. 즉 주머니 속 폰은 스스로 복귀하지 못한다.

### 4.2 백그라운드 하트비트의 양면

같은 메커니즘이 거꾸로 **ghost 프레즌스**를 만든다. Android에서 사용자가 다른 앱으로
전환하고 음악을 껐어도 탭이 살아 있으면 하트비트가 계속 가고, 그 문서는 정원 1자리를
점유한 채 명단에 남는다. 인앱 브라우저로 한 번, Safari/Chrome으로 또 한 번 연 사람은
두 자리를 점유할 수 있다. H1(§3)이 성립하려면 이 종류의 중복이 필요하고, 이것은 사용자
입장에서 "연결돼 있지 않은데 자리를 차지한" 상태라 "12명인데 가득"이라는 진술과도
맞물린다. 병행 감사의 fixture(30 live + 종료 통보 없는 70)가 44,999 ms에 `ROOM_FULL`을
낸 것도 같은 구조다.

### 4.3 화면 wake lock은 답이 아니다

`activateNoSleep()`은 Screen Wake Lock만 요청한다(`src/core/wake-lock.ts`, 호출
`src/ui/setup-shared.ts:262`, `setup-start.ts:12`). 이 API는 문서가 보일 때만 유효하고
사용자가 전원 버튼으로 잠그는 것을 막지 못한다. 고객의 "슬립 끄기" 제안은
화면 유지가 아니라 **백그라운드 오디오·프레즌스 생존 정책**의 문제다. 앱은 이미
`audioSession.type = 'playback'`(`media-session.ts:53-66`)과 Media Session 상태 힌트
(`68-78`)를 쓰지만, 실기기 검증 기록은 없다(known-accepted #6).

### 4.4 설계 선택지 (결정은 오너 몫, 여기서는 후보만)

- 프레즌스 만료와 로컬 재생 해체를 분리: `PRESENCE_EXPIRED` 복구에서 미디어 캐시와
  재생을 유지하고, 재입장 성공 뒤 위치만 재정렬. 현재는 `resetPlaylistRuntime()`이
  캐시까지 비운다.
- TTL·하트비트 여유: 45/15/15 조합은 2회 실패를 허용하지 않는다. TTL을 늘리면 ghost가
  더 오래 남아 H1을 악화시키므로, "가청·포그라운드 문서"와 "숨은 문서"의 만료를
  다르게 두는 쪽이 더 낫다(정원 집계에도 같은 구분 적용 가능).
- 방 sleeping 조건: 이동 중 사용에서는 "모든 문서가 사라짐"이 "청취 종료"와 같지 않다.
  마지막 만료 뒤 일정 유예 동안 타임라인을 계속 진행시키는 선택지가 있다.
- 공개 안내: 현재 iOS는 잠금 뒤 탭이 필요하다는 사실을 제품이 말해 주지 않는다.

## 5. "피어 70번대 퇴장 기록"의 의미

- 신규 세션의 `Peer N`은 **모든 저장 세션(dormant 포함)** 에서 빈 번호를 고른다
  (`createSessionRecord` `10896-10900` → `nextPhysicalDeviceOrdinal` `10992`). 프레즌스
  진입 시 **live 기준 최저 번호**로 다시 배정한다(`assignSessionPresenceIdentity`
  `9749-9795`). 하트비트는 live 충돌이 없으면 기존 번호를 유지한다(`11009-11035`).
- 그러나 `fetch()`는 매 요청 `ensureReady()`(`6892` → `4227`)를 거치고 그 안의
  `normalizeLoadedAccountIdentity()`(`4278`)가 `normalizeLoadedPhysicalSlotAssignments()`
  (`4759`, 정의 `9571`)를 호출한다. 이 정규화는 dormant 세션·계정 회원 번호 예약
  (`memberDisplayNumberReservations` `9525`)을 피해 번호를 다시 만든다. 병행 감사는
  dormant 73 + 같은 계정 2대 + 대표 detach 조합에서 live 4대인데 `Peer 77`,
  확장하면 `Peer 101`이 생기는 것을 당시·현재 소스 모두에서 재현했다.
- 따라서 "Peer 7x"는 동시 접속 수의 하한이 아니다. 처음에는 live 기준 압축 배정만
  보고 "7x면 72대가 동시에 있었다"고 추론했으나, 위 경로를 확인한 뒤 철회한다.
- 반대로 번호가 **사람을 추적하지도 못한다**. 만료 후 재진입은 "새 순서 사건"이라
  (`9756-9758` 주석) 같은 사람이 `Peer 12 left` 뒤 `Peer 3 joined`로 보일 수 있다.
  오너가 본 퇴장 기록을 인원 추정에 쓰면 안 된다.
- 번호 공간은 128(`1586`, `9702`)인데 앱 파서는 100까지만 받는다
  (`snapshot.ts:529,646,704`). 서버·앱 계약 불일치이며 병행 감사가 결함으로 기록했다.
  이 리뷰는 그 판정을 지지한다.

## 6. 로그 수집 설계에 반영할 사실

### 6.1 현재 수집 능력의 한계 (코드 확인)

- PRO DO는 메트릭을 전혀 쓰지 않는다(`recordMetric` 호출 0건, `console.warn` 4줄뿐:
  `1495`, `5879`, `9309`, `12374`). 운영 로그는 `head_sampling_rate = 0.1`
  (`wrangler.pro-room.toml:18`)이라 호출 단위로 90%가 버려진다. 앱 Worker도 0.1,
  시그널링만 1.0이다.
- 시그널링은 D1 `mxqr_metric_buckets`에 분 단위로 `pro_member_joined`·`pro_room_full`·
  `pro_ticket_stale_presence` 등을 쓰지만(`signaling-worker.ts:1623-1649`), **방 코드
  차원이 없고** 관리자 대시보드 목록(`app-worker.ts:486-514`)에도 PRO 키가 없어 SQL로만
  볼 수 있다.
- 클라이언트 진단(`src/diagnostics/sync-flight-recorder.ts`, `pro-start-observations.ts`,
  `core/log-capture.ts` + `/debug console`)은 RAM 전용이고 전송 기능이 없다. 설계상
  식별자는 숫자 세대만 남긴다.

### 6.2 가설을 가르는 최소 집계 (서버)

PRO DO에는 `MUSIXQUARE_ADMIN_DB` 바인딩이 이미 있으므로 시그널링과 같은 분 단위
카운터를 **방 코드 차원 포함**으로 쓸 수 있다(새 테이블 또는 event 이름에 코드 접미).
개인정보 없이 가능한 항목:

| 이벤트 | 구별하는 가설 |
| --- | --- |
| `rest_room_full`(비소유자 99 / 총 100 어느 쪽인지) | H1 |
| `rest_rate_limited{pin,admission}` | H4 |
| `presence_enter{new,resume,takeover}`, `presence_active_elsewhere` | H3 |
| `presence_removed{expired,leave,close,kick,pin}` | §4 체인 빈도, "퇴장 기록" 해석 |
| `room_sleep`, `room_wake` | §4.1 4단계 발생 여부 |
| 분·시간별 프레즌스 high-water, 저장 세션 수, `devicePlatform` 분포 | H1의 "문서 수 vs 사람 수" |
| 배정된 `peerOrdinal` 최대값, 100 초과 발생 카운트 | H2 |
| 앞단: PRO upstream 502/timeout 분류 카운트 | H5 |

같은 방식으로 시그널링에 `pro_presence_revoked`와 close reason별 카운트를 더하면
WS 쪽 churn을 REST와 대조할 수 있다. 1.2 MiB 코어 예산에 이벤트 링을 넣지 않도록
D1이나 별도 storage 키를 써야 한다([아키텍처 문서](pro-room-architecture-and-operations.md)
"Persistent state and sleep").

### 6.3 클라이언트에서만 알 수 있는 것

서버는 "왜 하트비트가 끊겼는지"를 모른다. 플라이트 레코더에 다음을 추가하고 `/debug`
오버레이에서 복사·내보내기를 붙이면, 다음 행사에서 시험해 보겠다는 고객
측 제안을 바로 활용할 수 있다.

- visibility 전환 시각과 hidden 지속 시간, 그 사이 하트비트 성공/타임아웃/오류 코드
- `PRESENCE_EXPIRED` 복구 발생 시각, 재입장 소요, 미디어 재다운로드 여부
- AudioContext 상태 전이(running/suspended/interrupted)와 clock-stall 판정
- wake lock 획득/해제, standalone(PWA)·브라우저 종류·OS 버전(식별자 없이)
- 입장 실패 시 서버 오류 코드와 표시된 문구 키

### 6.4 코드 없이 지금 물어볼 것

- 실패한 두 사람이 본 **정확한 문구**(§1 표의 다섯 가지 중 무엇인지, 스크린샷)
- 방에 PIN이 있었는지, 링크를 어떤 앱(Instagram/WhatsApp 등)으로 공유·열었는지
- 그 두 사람이 같은 날 같은 폰으로 **먼저 입장했다가** 다시 들어오려 했는지
- 멈춤을 겪은 기기의 OS(iOS/Android)와 브라우저/PWA 여부

## 7. 이번 리뷰에서 배제한 것

- 정원 집계에 만료 프레즌스가 섞이는 버그: 없음(§2.3).
- 세션 128 축출이 접속자를 밀어내는 경로: 없음(`10880-10894`).
- 시그널링 100 소켓 정원의 독립적 오작동: 낮음(§2.4).
- 스탠다드 방이었을 가능성: 메일 제목과 "Peer" 호칭이 PRO를 가리킨다. 스탠다드 방이면
  호스트 폰 슬립이 전체 연결을 끊고(`src/network/heartbeat-monitor.ts` 8 s/90 s),
  게스트 소켓 맵(`guests`)은 인증 후 침묵 소켓을 서버가 걷어내지 않으므로
  (`signaling-worker.ts:6708-6766` 알람은 pending·identity·binding만 정리) 재로드마다
  새 peerId가 쌓이면 99에 닿을 수 있다. PRO가 확인되면 이 경로는 닫는다.

## 8. 검증 범위

코드 읽기와 기존 문서 대조만 수행했다. 테스트·로컬 재현·운영 조회·실기기는 실행하지
않았고, 로컬 재현이 필요한 주장은 병행 감사 문서의 결과를 인용했다. 이 문서는 오너
지시에 따라 `docs/README.md` 색인과 릴리스 기록에 등록하지 않았다.
