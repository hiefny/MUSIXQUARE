# Phase 4 4C 배포 묶음: Cloudflare 데이터 연결마다 연결 생존 주인 하나 (2026-10-25)

| 항목      | 범위                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기준      | origin/main `9fca1cad`(4B 기록 #488. 런타임은 운영 9.0.9 / v782의 배포 SHA `aa23172a`와 같다). 4C 갈래는 4B 브랜치 끝 `b1962ed5`(9.0.9 / v781, PR #487의 Codex P2 반영 전)에서 시작했고 `c23f3057`에서 origin/main을 합쳤다(아래 라운드 2).                                                                                                                                                                          |
| 4C 묶음   | 브랜치 `agent/phase4-4c`. 증분마다 테스트 먼저 커밋과 코드 커밋 한 쌍이다. C5-6 `6521425b` → `89e1144b`, C5-7 `e687b345` → `fd5f5233`, C5-8 `76ecc766` → `f98099fd`, C5-10 `a6741636` → `8510a179`. 그 위에 main 합침 `c23f3057`, 리뷰 낮음 반영 `ab4ba114`(테스트, 가드의 은퇴 이름 목록, 주석, 문서), 이 보고서와 기록 커밋(문서만), 두 번째 리뷰 반영 `8582e71c`(테스트)와 그 문서 커밋이 있다.                   |
| 상태      | 배포 전. SemVer와 SW 캐시 epoch bump 전이다(9.0.9는 배포됐으므로 둘을 함께 올린다). 오너 결정(2026-10-25 약 01:50 KST)대로 자동 게이트(로컬 검사, 리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke)가 통과하면 따로 묻지 않고 낸다.                                                                                                                                                                                   |
| 현재 증분 | 원래 경로의 15초 유예, 공개하는 복구 마감, 끊김당 ICE 재시작 하나를 허락하는 문(C5-6), 게스트 백그라운드 복귀 확인(C5-7), 링크의 모든 닫힘과 그 첫 원인(C5-10의 연결 부분)을 `LinkLiveness` 하나가 갖는다. 전송 상태 읽기는 그 주인의 보기를 읽는다(C5-8, 이 열차의 유일한 동작 변경). C5-9(보조 경로의 기한을 주인으로 옮기기)는 싣지 않는다.                                                                       |
| 제품 식별 | 아직 `9.0.9` / `v782`(main과 같다). `guard:sw-cache-version`은 bump 전이라 설계대로 실패한다(아래 라운드 2).                                                                                                                                                                                                                                                                                                         |
| 배포 대상 | target `app`, Developer API D1 `false`(예상). 4C는 App 런타임 네 파일(새 `src/network/transport/link-liveness.ts`, `cloudflare-signaling.ts`, `transport-health.ts`, `transport/types.ts`)과 가드·테스트 설정(`scripts/check-transport-health.mts`, `scripts/check-resource-ownership.mts`, `vitest.critical.config.ts`)만 바꾼다. `cloudflare/` 변경은 없다. 실제 부분 게이트는 Production Release가 다시 판정한다. |
| 환경      | Windows 11 로컬, Node 24.20.0 / npm 12.0.2. 단위는 jsdom과 가짜 WebRTC다. C5-0 랩은 헤드리스 Chromium과 `wrangler dev --local`로 띄운 신호 Worker 위에서 게스트 페이지의 P2P만 CDP로 끊는다.                                                                                                                                                                                                                         |
| 운영      | 아직 배포하지 않았다. 실제 기기, iOS·WebKit, 운영 Cloudflare 전송 경로, 브라우저의 PRO 방은 4C 코드로 실행하지 않았다(아래 실기기로 확인하지 않은 것).                                                                                                                                                                                                                                                               |

이 문서는 구조 개선 Phase 4의 세 번째 앱 배포(4C)에 실리는 증분과 QA를 기록한다. 4A는 동작을
바꾸지 않는 묶음, 4B는 오너가 고른 동작 변경이었고([4A 보고서](phase4-4a-transport-rejoin-2026-10-24.md),
[4B 보고서](phase4-4b-behaviour-2026-10-25.md)), 4C는 4A에서 기기 근거를 기다리며 보류했던 연결 생존
주인(C5-6, C5-7, C5-8)과 C5-10의 연결 부분을 싣는다. 증분마다 테스트 커밋을 먼저 두었다. 중립
증분의 테스트는 바꾸기 전 코드에서 통과하는 특성화이고, 동작 위험 증분(C5-8)의 새 행은 바꾸기 전
코드에서 실패한다. 증분마다 커밋, 검증한 코드 SHA, 환경, PASS/FAIL/SKIP과 한계를 적는다.

## 오너 결정

- **2026-10-24 약 15:20 KST, 보류(P4-D6 A, P4-D13 A):** C5-6(LinkLiveness), C5-7(백그라운드 복귀
  확인), C5-8은 release-record의 #18 보조 연결 ICE 재시작과 미리받기 재개 항목이 근거로 닫히거나
  면제될 때까지 보류한다. C5-9는 Phase 4 밖이다(registry RO-35).
- **Phase 4 계획 v3의 기본값 2(오너 기본값, 2026-10-24):** C5-8은 주인이 보지 않는 원시
  `iceConnectionState` 행을 그대로 두고, 원시 상태와 주인 보기의 불일치 로그를 넣지 않는다(그 로그를
  받을 텔레메트리 경로가 없고 첫 로딩 바이트가 는다). 4C에서도 이 기본값을 그대로 쓴다.
- **2026-10-25 약 01:50 KST, 배포 시점과 기기 게이트:** 오너는 되는 대로 바로 배포하고 문제가
  나오면 그때 다루며, 지금은 코드베이스를 끝내는 것이 먼저라고 했다('나중에 배포'는 없음). 기기
  근거는 더 이상 코드의 게이트가 아니고, C5-6·C5-7·C5-8은 4B 다음 자기 열차로 진행한다. 그래서 위
  보류는 풀렸고 4C도 자동 게이트가 통과하면 바로 낸다. 기기 절차는 오너가 나중에 쓰도록 그대로 두고,
  열차 보고서마다 기기로 확인하지 않은 것을 적는다(아래 마지막 절). 그대로인 것: 자동 게이트, 동작
  변경의 실패 테스트 먼저, 열차당 보고서 하나, 배포 뒤 release-record와 이력, 되돌리기와 forward fix
  절차, 공개 저장소 위생, CI e2e를 새로 넣지 않음. P4-D3 A가 둔 Phase 4 앱 업데이트 두 번(4A, 4B)은
  이 결정으로 4C까지 세 번이 된다.
- **4C 범위:** C5-6, C5-7, C5-8, C5-10(연결 부분). C5-9를 싣지 않으므로 C5-10은 제어 격리
  (`control-isolation.ts`)의 보조 경로 기한, `originalReady`, `originalChanged`를 그대로 둔다.

**구현과 리뷰 중 정한 세부(오너가 맡긴 판단, 2026-10-25).** 오너가 돌아와 다시 확인한다.

- **C5-7은 도달할 수 없는 가드 둘을 지웠다.** 확인 타이머가 발화할 때 확인이 걸려 있고 링크가 열려
  있는지 다시 보던 것(확인을 끝내는 길, 곧 정확한 pong, 진짜 connected, stop이 두 타이머를 함께
  지우고 stop 뒤에는 확인을 걸지 않는다)과, ping id 생성기가 `Uint32Array` 두 값을 기본값으로 메우던
  것(늘 숫자다)이다. id 범위(안전 정수의 위쪽 절반)는 같다. 덮지 못하는 분기를 남기지 않으려는 것이다.
- **C5-10은 '정확히 한 번' 가드를 넣지 않았다.** 모든 닫힘이 닫힘 포트에 닿게 해서, 연결이 채널을
  정리하며 다시 들어온 닫힘에서도 `close` 이벤트의 자리(첫 채널이 닫힌 뒤, 둘째 채널과 PC가 닫히기
  전)를 지킨다. 원인 줄은 첫 원인 하나뿐이다.
- **리뷰 낮음은 동작을 바꾸지 않고 반영했다(`ab4ba114`, 아래 리뷰 반영 절).** C5-7 커밋 메시지가
  말하는 '두 번째 복귀는 3초 창을 다시 시작하되 돌고 있는 1초 보기를 지우지 않는다'는 코드와 같아서
  메시지가 아니라 테스트로 고정했다.

## 제품·런타임 증분

### C5-6 원래 경로의 유예와 재시작 문 (중립)

테스트 `6521425b`, 코드 `89e1144b`. 한 `CloudflareDataConnection`의 원래 경로 끊김에 주인 하나를 둔다.

- 새 `src/network/transport/link-liveness.ts`의 `LinkLiveness`(registry RO-15)가 원래 PC의 끊김 표지,
  15초 유예(연결이 만드는 같은 관리 타이머 키 `cloudflare-data-disconnected-grace-N`), 벽시계로
  공개하는 복구 마감, 재시작 가능 묶음(bind 입력), 끊김당 재시작 하나의 문, 원래 PC의
  `connectionstatechange` 처리 논리를 갖는다.
- `CloudflareDataConnection`은 `iceRestartBinding`(이제 접근자 쌍), `iceRecoveryDeadline`,
  `beginIceRestart`, `finishIceRestart`를 한 줄 위임으로 남기고, `terminate()`가 유예를 지우던
  자리에서 주인을 멈춘다. SDP 실행기, 하트비트 감시, transport-health, 기존 테스트의 생성자 호출은
  그대로다.

그대로인 것: 관리 타이머로 재고 벽시계로 공개하는 마감, 갱신하지 않는 유예(돌고 있는 유예는 재시작과
뒤 끊김에도 마감을 지키고, 발화한 유예는 다음 전이까지 공개된 채이며, 페이지 전체 타이머 지움 뒤에는
새로 건다), 전이마다 효과 순서(connected: 유예 지움, 문 다시 엶, 복귀 확인 반응, 상태 콜백, 보조 경로,
`ice-recovered`. disconnected: 복귀 확인 반응, 상태 콜백, 콜백이 닫지 않았으면 유예와 보조 경로.
재시작 가능한 failed: 유예, 콜백, 보조 경로. 그 밖은 `original-terminal`), 상태 콜백이 없는 방장
연결의 유예, #471 만료 규칙.

테스트 먼저: `6521425b`가 공개 연결 표면으로 각 전이의 효과 순서(콜백이 문에 다시 들어오거나 연결을
닫는 경우 포함), 열리기 전 유예, 재시작을 건너는 갱신하지 않는 마감, 묶이지 않은 링크의 마감 감춤,
상태 콜백 없는 방장 연결이 제자리 재시작 답을 지나 disconnected 15초 뒤 닫히는 것을 고정했고 바꾸기 전
코드에서 통과했다. `89e1144b`가 주인의 포트 순서 행 17개(파일 34행)를 더했다. 핵심 커버리지에
`link-liveness.ts`를 100/100/100/100(하한 99)으로 넣었다. 초기 JS +218 B.

### C5-7 백그라운드 복귀 확인 (중립)

테스트 `e687b345`, 코드 `fd5f5233`. 게스트의 백그라운드 복귀 확인이 같은 주인으로 들어간다.

- 걸린 확인을 하위 상태 하나(ping id, 경로가 disconnected로 읽혔는지)로 갖고, id 생성기, 3초 확인 창,
  disconnected로 읽힌 경로의 1초 보기, 복귀 진입(`recoverAfterBackground`), 두 경로를 다시 읽는
  조정(복귀 때, 원래 경로의 disconnected 때, provider에서), 원래 경로 connected에 대한 반응, 두 레인
  어디로 오든 정확한 `SYNC_PONG`, stop 때 지움을 갖는다.
- 연결은 두 PC와 채널을 읽는 snapshot 포트 하나(원래 PC, 보조 PC, 원래 채널 둘, 활성 보조 채널)와 같은
  `SYNC_PING` 프레임을 보내는 ping 포트를 채우고, 받은 프레임을 모두 주인에게 넘기고,
  `recoverAfterBackground`와 `reconcileBackgroundResumeRecovery`를 한 줄 위임으로 남긴다.

그대로인 것: 타이머 키 둘(`cloudflare-data-disconnected-grace-N-background-resume-liveness`,
`-background-resume-disconnected`), 3초와 1초, 가드(닫혔거나 열리지 않은 링크, 유예보다 짧거나 유한하지
않은 숨김 시간), 결과와 원인 모두(원래 PC가 없거나 failed·closed, 보조 PC가 failed·closed, 원래 채널이나
활성 보조 채널이 열려 있지 않음, 신호도 끊긴 disconnected 경로는 `resume-stale`. 1초 보기가 끝날 때 원래
경로 connected, 두 채널 열림, 보조 PC가 disconnected 아님 중 하나라도 빠지면 `resume-disconnected`.
정확한 pong이 없거나 확인을 보낼 수 없으면 `resume-probe-unanswered`), 두 번째 복귀가 확인을 바꾸고 3초
창을 다시 시작하되 돌고 있는 1초 보기는 지우지 않는 것, 효과 순서에서 확인의 자리(connected에서는 유예와
문 다음, 상태 콜백 앞. disconnected에서는 상태 콜백 앞이고, 그 안의 닫힘은 유예를 걸지 않는다).

테스트 먼저: `e687b345`가 보조 PC 경우와 각 닫힘의 원인을 고정했고 바꾸기 전 코드에서 통과했다.
`fd5f5233`이 주인의 확인 행(스냅샷·ping 포트를 지나는 모든 결과, 1초 보기의 세 조건, 타이머 키, stop,
두 번째 복귀)을 더했고, C5-6 포트 순서 행 넷은 확인을 걸거나 안으로 들어간 두 포트를 빼고 같은 순서를
본다. 커버리지는 `link-liveness.ts` 16/16 함수, 87/87 분기. 초기 JS +43 B.

### C5-8 전송 상태가 주인의 보기를 읽음 (동작 위험)

테스트 `76ecc766`, 코드 `f98099fd`. 설계가 behaviour-risk로 붙인 증분이다. 방장의 대용량 레인, 미리받기
멈춤, 하트비트 lease의 한 읽기 길(RO-17)이 PC의 `connectionState`로 원래 경로를 다시 추정하지 않고 연결
생존 주인을 읽는다.

- `types.ts`: `TransportLinkLivenessView`(`phase`, `recoveryDeadline`)와 선택 필드
  `TransportDataConnection.linkLiveness`. 모든 `CloudflareDataConnection`(일반방과 PRO 방 모두)이 자기
  주인을 내보인다. PeerJS 연결에는 없다.
- `LinkLiveness.phase`: stop 뒤 `closed`, 링크가 열리기 전 `opening`, 주인이 원래 경로의 끊김
  (disconnected, 또는 재시작 가능한 failed, connected 이벤트까지)을 쥐고 경로가 connected로 읽히지 않으면
  `recovering`(유예가 링크를 닫는 조건과 같다), 그 밖은 `live`. 보조 경로는 이 값을 바꾸지 않는다(RO-35).
- `transport-health.ts`: 주인이 있으면 `isBulkWritable`은 phase `live`를, `isRecoverablyInterrupted`는
  phase `recovering`을 PC connectionState 행 대신 읽는다. 주인이 보지 않는 원시 `iceConnectionState`
  행(disconnected, failed, closed)은 두 길 모두 그대로다. 하트비트 lease는 주인이 공개한 마감을 읽는다
  (C5-6부터 `iceRecoveryDeadline`이 위임하던 값이라 lease는 같다). 하트비트 stale 기준은 계속 PC 상태를
  읽는다. 주인이 없는 연결(PeerJS)은 전과 같이 읽는다.

**동작 위험과 바뀌는 것.** 의도한 변화는 원래 경로의 재시작 창 하나다. 주인이 끊김을 쥔 채 경로가
`connecting`이나 `new`로 읽히는 동안:

- 그 peer는 bulk-writable이 아니다. 새 본 레인·미리받기 스트림은 그 peer를 빼고, 게스트는 disconnected일
  때처럼 자기 복구 요청에 기댄다(RO-18).
- 미리받기 레인은 멈춘 채로 있다가 주인의 `connected`(`ice-recovered`)에서 9.0.9처럼 청크 0부터 다시
  시작한다. 그 전의 선택 쌍 변경 보고로는 재개하지 않는다. 방장의 `Paused`·`Resuming` 줄은 바이트가
  같고 `Resuming`이 나오는 때만 늦어질 수 있다.

그 밖의 경우:

- 보조 경로만의 끊김은 bulk를 막지 않고 미리받기를 멈추지 않는다. 바꾸기 전에도 그랬다(`76ecc766`에서
  고정).
- 주인이 이벤트를 아직 듣지 못한 사이 PC가 disconnected나 failed로 읽히면 주인 행은 `live`다. ICE가 함께
  끊긴 보통의 경우는 원시 `iceConnectionState` 행이 전처럼 막는다. ICE는 connected인데 PC만 failed로
  읽히는 드문 경우(DTLS 실패 등)만 원시 길과 다르다(코드 읽기, 미측정).
- PRO 방의 연결도 주인을 내보인다(보조 경로가 없고 재시작을 묶지 않는다). PRO 방의 영구 재생목록 미디어는
  각 구성원이 방 버킷에서 받아 레인으로 중계하지 않으므로(`src/player/decode.ts`,
  `src/storage/preload.ts`) PRO에서 이 변화가 보이는 곳은 레거시 레인이 도는 경우뿐이고, 하트비트 lease
  값은 같다(코드 읽기).
- 원시 상태와 주인 보기를 비교하는 로그는 없다(위 오너 기본값).

그대로인 것: 주인의 상태, 타이머와 키, 마감, 효과 순서, 닫힘 원인, 통신, 기기 근거 다섯 줄과 닫힘 원인 줄,
`host.ts`의 `network:peer-ice-recovered`. `heartbeat-monitor.ts`, `chunk-pump.ts`, `preload.ts`의 멈춤·재개
가드는 바뀌지 않았다(이미 공유 술어를 묻고, guard:transport-health가 그 짝을 본다).

테스트 먼저: `76ecc766`이 바꾸기 전 코드에서 통과하는 지킬 것을 고정했다. 실제 `CloudflareDataConnection`의
하트비트 lease가 끊김 안에서 시작한 재시작을 지나 주인의 15초 유예가 링크를 닫을 때까지 유지되고 그 뒤 보통
기준으로 떼어지는 것, 보조 경로만의 끊김, 원시(PeerJS) 길이 PC가 connecting일 때 복구 보고에서 멈춘 미리받기를
다시 시작하는 것, `preload-lane-ownership.test.ts` 도우미가 실제 주인을 몰 수 있는 것이다. 바뀌는 행은
`f98099fd`의 테스트 다섯 파일을 `76ecc766` 소스에 얹어 다시 돌렸다. 283행 중 21행이 실패하고 262행이 통과했다
(transport-health의 주인 보기 행 12, link-liveness의 실제 연결 단계 행 4와 주인 phase 행 1, chunk-pump의 주인
보기 golden table 1, preload 1, preload-lane-ownership의 connecting 행 2). `f98099fd`에서 모두 통과한다. 원시
golden table과 기존 테스트는 수정 없이 통과했다. 주인 보기 golden table
(`src/storage/__tests__/__fixtures__/bulk-writable-owner-view-truth-table.txt`)은 PC connectionState가 무엇이든
같고, 그 `live` 행은 원시 표의 pc=connected 행과 같다. 커버리지(핵심 프로필): `link-liveness.ts`와
`transport-health.ts` 100, `cloudflare-signaling.ts` 82.63/80.4/85.2/87.6(하한 72/71/72/78), `preload.ts`
71.25/62.5/84.12/74.97(하한 68/59/84/71)로 `f98099fd`에서 쟀다. 초기 JS +121 B.

### C5-10 링크의 모든 닫힘이 주인을 지남 (중립, 연결 부분)

테스트 `a6741636`, 코드 `8510a179`. 주인이 연결 안의 유일한 닫힘 권한이 되고, 정적 ratchet이 그것을 지킨다.

- `LinkCloseCause`가 주인 모듈로 옮겼다(왜 닫혔는지는 주인이 답한다). 새 입력 `close(cause)`가 링크의 첫
  원인을 두고 모든 닫힘을 닫힘 포트에 (cause, first)로 넘긴다. 주인 자신의 닫힘(`original-terminal`,
  `original-grace-expired`, `resume-stale`, `resume-disconnected`, `resume-probe-unanswered`)도 이 입력을 지난다.
- 채널의 close 이벤트(`channel-closed`), 대용량 신용 송신기의 제어 송신 실패(`control-send-failed`), 보조
  경로의 `fail(reason)`(`side-failed:<reason>`)과 `close(reason)`이 `liveness.close(cause)`로 들어간다. 연결의
  private `terminate()`는 닫힘 포트에서만 닿고 `first`일 때 줄을 쓴다. 연결의 첫 원인 필드와 유예 키 필드는
  지웠다(키 문자열과 번호는 같다).

그대로인 것: 링크당 `[Transport] Logical connection closed (<cause>) for <peerId>` 한 줄과 그 첫 원인,
`noteLinkClose`(P4-D5 B의 메모리 기록), 모든 뒤 닫힘이 `terminate()`에 닿는 것(그래서 정리 중 다시 들어온
닫힘의 `close` 이벤트 자리), stop·dispose·markClosed 순서, 타이머 키, 마감, 효과 순서, 통신, 기기 근거 다섯 줄.

가드(`guard:transport-health`, `scripts/check-transport-health.mts`, CI): CHECK 3은 주인이 대신한 기계들의
이름(C5-6 유예와 재시작 문, C5-7 복귀 확인, C5-10 유예 키 필드와 첫 원인 필드, 리뷰 뒤 16개)이
`link-liveness.ts` 밖 production 파일에 없는지 본다(식별자, private 이름, 문자열 멤버 이름, 요소 키. 주석과
다른 문자열은 세지 않는다). CHECK 4는 production 코드가 주인을 연결에서 한 번만 만들고 `terminate()`가
private이며 주인에게 넘기는 `close` 포트 안에서만 참조되는지, CHECK 5는 주인 모듈 안에서 닫힘 포트를
`close(cause)`에서만 부르는지 본다. 허용은 없고 걸리면 모두 발견이다.

테스트 먼저: `a6741636`이 링크당 닫힘 하나(채널, provider의 `close(reason)`, 원래 경로의 끝 상태, 유예 중 누가
먼저 알리든 원인 하나로 한 번 닫히고 뒤에 알리는 쪽은 닫힘도 줄도 더하지 않음)와 정리 중 다시 들어온 닫힘의
`close` 이벤트 자리를 고정했고 바꾸기 전 코드에서 통과했다. `8510a179`가 'the one close input (C5-10)' 3행과
가드 자기 테스트 10행을 더했다. 커버리지는 `link-liveness.ts` 18/18 함수, 97/97 분기. 초기 JS −9 B.

### 리뷰 낮음 반영 (`ab4ba114`)

갈래 리뷰가 남긴 낮음을 런타임 동작을 바꾸지 않고 반영했다. 바뀐 것은 테스트, 가드의 은퇴 이름 목록, 주석,
문서다.

- 가드 CHECK 3의 은퇴 이름에 C5-10이 지운 연결의 첫 원인 필드 `closeCause`를 더했고(16개), 가드 자기
  테스트가 연결 모듈에 심은 `closeCause`를 발견으로 잡는다.
- 연결의 관리 타이머 키를 고정했다. 유예 키 `cloudflare-data-disconnected-grace-N`은 연결마다 번호가 하나씩
  늘고, 복귀 확인의 두 타이머는 그 뒤에 `-background-resume-liveness`, `-background-resume-disconnected`를
  붙인다.
- disconnected에서 보조 경로가 듣기 전에 유예가 걸리고 마감이 공개되는 것을 주인과 실제 연결 둘 다로
  고정했다.
- 두 번째 백그라운드 복귀가 disconnected를 본 적 없는 확인을 새로 시작해 뒤 connected 이벤트가 그 확인을
  끝내지 않는 것, 그리고 connected로 읽은 두 번째 복귀가 돌고 있는 1초 보기를 지우지 않아 그 보기가 첫
  복귀의 마감에 끝나는 것을 고정했다(주인과 실제 연결).
- 새 행 여섯은 현재 코드에서 통과한다. 이름 붙인 동작을 하나씩 바꾸면(두 번째 복귀가 `sawDisconnected`를
  이어받게, 두 번째 복귀가 1초 보기를 지우게, 보조 경로 알림을 유예 앞으로, 연결의 유예 키 문자열이나 확인
  키 접미사를 바꾸게) 각각 해당 행이 실패하는 것을 확인하고 되돌렸다.
- 문서와 주석: `linkLiveness`는 일반방 연결만이 아니라 모든 `CloudflareDataConnection`(PRO 포함)이
  내보인다(`types.ts`, `transport-health.ts`, `link-liveness.ts`의 주석, 실시간 런타임 소유권 ADR, registry
  RO-15·RO-17·RO-18). ADR의 '외부에서 닫는 쪽은 원인을 대야 한다'는 실제와 달라서(강퇴와 PIN 철회, 중복·오래된
  열림의 교체, 정원 초과 거절, 밀려난 협상, 게스트의 오래되거나 교체된 입장, 뒤로 가기 취소, destroy는 원인
  없이 `close()`를 부르고 `intentional`로 읽힌다) '원인은 선택이고, 어느 쪽이든 같은 주인으로 들어간다'로
  고쳤다. registry RO-15의 anchor에 새 행을 적었다.

### 두 번째 리뷰 반영 (`8582e71c`와 문서)

`2cea2a91`을 본 코드·문서 리뷰가 남긴 중간 하나와 낮음을 반영했다. 런타임 코드는 바뀌지 않았다.

- **중간(문서):** registry의 배포 묶음 문단과 release-record의 구조 개선 배포 묶음 항목이 아직 Phase 4 앱
  업데이트를 두 번(4A, 4B)으로 적고 있었다. 2026-10-25 결정이 C5-6·C5-7·C5-8을 4B 다음 자기 열차로 보내 4C까지
  세 번이 된다는 문장(C5-9는 Phase 4 밖)과 이 보고서의 오너 결정 절 링크를 둘 다에 더했다.
- **낮음(테스트):** 4B의 C5-12 물러남·철회 행(`ice-recovery-bulk-lanes.test.ts`)은 주인이 없는 가짜 연결만 몰아
  전송 상태가 원시 길을 탔다. `8582e71c`가 `runHost`에 주인 보기 변형을 더했다. 실제 `LinkLiveness`가 원래
  경로의 전이를 듣고, 그 `recovered` 포트가 연결의 `ice-recovered`다(host.ts가 복구를 알리고 경로를 unknown으로
  되돌린다). 주인이 connected를 듣기 전에는 재시작한 경로가 connecting으로 읽히는 동안 선택 쌍 변경이 복구를
  알리고, 방장이 그때 경로를 다시 찾아 공개할 수도 있다. 새 11행이 고정하는 것: connecting 때의 보고는 아무것도
  재개하지 않고, 주인의 connected가 레인을 route-pending으로 다시 시작하며, connecting 동안에만 공개된 local로는
  물러나지 않고, 물러남·유지 행과 뒤 알림의 철회는 원시 길과 같다. 원시 23행은 이름과 결과가 그대로다. 새 11행은
  C5-8 전의 `transport-health.ts`(`76ecc766`)를 얹으면 모두 실패하고, `revokeRestartedPreloadYields`를 건너뛰게
  하면 두 길의 두 번째 알림 방장 행 넷과 그 결과를 쓰는 게스트 행 둘이 실패한다(둘 다 확인 뒤 되돌림). 새 끊김
  동안의 철회는 따로 행이 없다. 재시작한 레인은 다음 검사에서 먼저 멈추고(`canContinue`가 물러남보다
  `suspendPreloadPeer`를 먼저 묻는다), 다음 connected가 새 route-pending 레인을 시작한다. registry RO-18의 주인
  보기 anchor에 새 행을 적었다.
- **낮음(문서·주석):** ADR 절 머리의 'C5-6 to C5-10'을 C5-9가 빠진 범위로, `signaling-liveness.md`와 가드
  (`scripts/check-transport-health.mts`) 머리 주석의 '일반방 연결마다'를 'Cloudflare 데이터 연결마다(일반방과
  PRO 방)'로, release-record 4C 항목의 '중립 넷의 테스트 커밋'을 '테스트 커밋 넷'으로 고쳤고, C5-8 절의
  커버리지가 `f98099fd`에서 잰 값임을 적었다.

## QA 라운드

### 1. 갈래 (2026-10-25)

검증 대상은 `8510a179`(기준 `b1962ed5`)다. 아래는 갈래 커밋 메시지에 남은 기록이다.

| 검사          | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저   | 위 증분별 절. 중립 증분의 테스트 커밋은 바꾸기 전 코드에서 통과하고, C5-8의 새 행은 바꾸기 전 코드에서 실패한다.                                                                                                                                                                                                                                                                                                             |
| 영향 단위     | 커밋마다 link-liveness, link-liveness 특성화, room-expiry, evidence-log, 동결 fixture `control-isolation-c9.ts`를 쓰는 control-isolation 묶음이 수정 없이 통과했다.                                                                                                                                                                                                                                                          |
| 핵심 커버리지 | `8510a179`에서 77 files / 3,019 tests PASS, 파일별 하한 유지.                                                                                                                                                                                                                                                                                                                                                                |
| 가드          | transport-health, `check-resource-ownership`(C5-6에서 `link-liveness.ts`를 RO-15·RO-17 타이밍 계약 파일 목록에 더함. 복사 상수와 기준값 변화 없음. C5-7 뒤 보고만 하는 같은 값 쌍이 하나 늘었다: `link-liveness.ts`의 `BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS`와 `cloudflare-signaling.ts`의 `STANDARD_ROOM_SETUP_ADMISSION_TIMEOUT_MS`, 3,000), import-graph, dead-exports 20/20·76/76, bus-pairing, source-complexity PASS. |
| 초기 JS       | 증분마다 프로덕션 빌드: 477,516 B(4B v781 트리) → C5-6 477,734 → C5-7 477,777 → C5-8 477,898 → C5-10 477,889 B.                                                                                                                                                                                                                                                                                                              |
| 갈래 기록     | 커밋에 전체 단위 수치는 없다. 합친 트리에서 전체를 돌렸다(라운드 2).                                                                                                                                                                                                                                                                                                                                                         |
| SKIP          | 실제 기기, WebKit, Playwright, C5-0 랩(라운드 2에서 돌림).                                                                                                                                                                                                                                                                                                                                                                   |

### 2. main 합침과 리뷰 반영 뒤 (2026-10-25)

검증 대상은 `ab4ba114`다. 그 뒤 커밋은 이 보고서·기록·색인만 바꾼다. 환경은 위 표와 같다.

| 검사             | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 합침             | `git fetch` 뒤 origin/main `9fca1cad`를 `c23f3057`로 합쳤다. main의 4B는 squash(`aa23172a`)라 merge-base가 `47b9a273`이 되어 4B 쪽 파일 열 개가 충돌했다. 실제 바탕인 `b1962ed5`로 세 방향 합침을 다시 했다. 4C가 바꾸지 않은 파일(4B 최종의 `preload.ts`, `transfer-receive.ts`, `file-request-authority.ts`와 그 테스트, v782의 `index.html`·`service-worker-asset.ts`, 4B 보고서·기록·색인·이력)은 main 것, main이 `b1962ed5` 뒤로 바꾸지 않은 파일(`cloudflare-signaling.ts`, `types.ts`)은 4C 것이다. 둘 다 바꾼 registry는 RO-18 상태 문단 하나만 겹쳐 4B의 Codex P2 문장과 4C의 C5-8 문장을 함께 두었다. 합친 직후 network·storage 단위 100 files / 2,722 tests, `tsc --noEmit`, `typecheck:tests`, transport-health, dead-exports, resource-ownership PASS.                                                                                            |
| 테스트 먼저 다시 | 테스트 커밋 넷(`6521425b`, `e687b345`, `76ecc766`, `a6741636`)을 각자의 바꾸기 전 소스에서 다시 돌렸다(link-liveness, heartbeat-monitor, preload-lane-ownership, link-liveness 특성화 4 files): 121, 151, 188, 199 tests PASS. `f98099fd`의 테스트 다섯 파일을 `76ecc766` 소스에서: 283행 중 21행 FAIL, 262행 PASS(위 C5-8 절).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 단위 전체        | `vitest run --maxWorkers=6` 664 files / 15,531 tests PASS, FAIL 0(약 3.8분). 기기 근거 다섯 줄 고정(`control-isolation-evidence-logs.test.ts`, `preload-evidence-logs.test.ts`)과 동결 fixture `control-isolation-c9.ts`(셋 다 origin/main 대비 바뀌지 않음)를 쓰는 `control-isolation.test.ts`가 그 안에서 통과한다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 정적             | `npm run typecheck`(모든 tsc 프로젝트와 그 가드), `lint`, `format:check` PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 가드             | transport-health(12 files, 원시 읽기 1, 소비자 3, 은퇴 이름 16, `terminate()`는 주인의 닫힘 포트에서만), dead-exports(테스트 전용 20/20, 자기만 76/76 그대로), bus-pairing, chunk-pump, import-graph(395 files, 순환 0), lifecycle-writes, navigation-sinks, source-complexity, room-authority-boundaries, standard-room-hot-path, release-identity(9.0.9, v782), `check-resource-ownership`(48 records / 437 files, 타이밍 사본 6·의심 1, 같은 값 쌍 26은 보고만) PASS.                                                                                                                                                                                                                                                                                                                                                                                       |
| SW 캐시 가드     | `guard:sw-cache-version`은 bump 전이라 설계대로 FAIL. 가드는 v782를 합침 `c23f3057`(bump 줄을 가져온 커밋)에서 세므로 지금은 리뷰 반영의 세 파일만 나열하지만, C5-6~C5-10의 런타임 변경(`cloudflare-signaling.ts`, `link-liveness.ts`, `transport-health.ts`, `types.ts`)도 v782에 없다. bump는 4C 전체를 덮는다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 핵심 커버리지    | `test:coverage:critical` 77 files / 3,025 tests PASS, 파일별 하한 유지. `link-liveness.ts` 108/108 줄, 97/97 분기, 18/18 함수. `transport-health.ts` 100. `cloudflare-signaling.ts` 82.61/80.4/85.2/87.58(하한 72/71/72/78). `preload.ts` 71.25/62.5/84.12/74.97.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 빌드 바이트      | `npm run build` 두 번 모두 초기 JS 478,019 B. `guard:initial-transfer-budget` PASS(아래 초기 JS 예산). 같은 기계에서 main `9fca1cad`도 빌드해 쟀다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| C5-0 랩          | `playwright.lab.config.ts` 전체 8/8 PASS(5.1분, 실제 Cloudflare 전송의 일반방). 10초 원래 경로 끊김은 세션을 닫지 않고 restore 뒤 0.42초에 회복. 보조 연결은 게스트 보조 PC가 끊김 15.95초 뒤 failed에 닿고 `Restarting isolated control ICE (1/2)` 뒤 `Isolated control ICE recovered`. 미리받기 재개는 그 게스트 PeerID로 `Paused`(끊긴 동안) 하나와 `Resuming`(restore +281 ms) 하나, `PRELOAD_START restart:true` 하나(+283 ms, 끊길 때 30%), `PRELOAD_ABORT` 없음, 미리받기 Blob의 SHA-256 일치. F4 전선: `Paused` −10.8초, `Resuming` +259 ms, 재시작 머리 +262 ms, 게스트 요청 +3.33초, 본 레인 `FILE_START` +3.44초, 40 ms 뒤 보조 제어 채널로 `PRELOAD_ABORT` 하나와 `Yielding`, `PRELOAD_END` 없음, 미리받기 청크 0 B, 본 레인 23,040,044 B, 게스트 +50.8초. 게스트는 끊긴 동안 진행 감시로 멈춘 세션(107/352)을 놓았다. 4B v782 행과 같은 판정이다. |
| Chromium         | `test:e2e:critical` 61/61 PASS(3.6분, flaky 0, PeerJS 경로라 주인 보기는 타지 않는다). 주인 보기의 브라우저 근거는 위 C5-0 랩이다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SKIP             | 실제 기기, WebKit, Worker 단위와 `check:workers`(`cloudflare/` 변경 없음. bump가 App Worker의 `ADMIN_ASSET_VERSION`을 바꾸므로 bump 뒤에 돌린다), `build:checked` 전체(bump 전이라 sw-cache-version이 설계대로 실패한다), PR CI·Codex·exact-main CI·릴리스 smoke(이 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### 3. 두 번째 리뷰 반영 뒤 (2026-10-25)

검증 대상은 `8582e71c`와 그 위 문서 커밋이다(위 두 번째 리뷰 반영 절). 런타임 파일은 `ab4ba114`와 같고,
가드 스크립트는 머리 주석만 바뀌었다. 환경은 위 표와 같다.

| 검사             | 결과와 범위                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 새 행 판별       | `ice-recovery-bulk-lanes.test.ts` 34 tests PASS(원시 23, 주인 보기 11). C5-8 전 `transport-health.ts`(`76ecc766`)를 얹으면 주인 보기 11행이 모두 FAIL하고 원시 23행은 PASS. `revokeRestartedPreloadYields`를 건너뛰게 하면 6행 FAIL. 둘 다 확인 뒤 되돌렸다. |
| 단위 전체        | `vitest run --maxWorkers=6` 664 files / 15,542 tests PASS, FAIL 0(약 4분). 라운드 2보다 11행 많다.                                                                                                                                                           |
| 정적             | `npm run typecheck`, `lint`, `format:check` PASS.                                                                                                                                                                                                            |
| 가드             | transport-health(12 files, 원시 읽기 1, 소비자 3, 은퇴 이름 16), dead-exports(테스트 전용 20/20, 자기만 76/76 그대로), `check-resource-ownership`(48 records / 437 files, 타이밍 사본 6·의심 1, 같은 값 쌍 26), release-identity(9.0.9, v782) PASS.          |
| 다시 돌리지 않음 | 런타임이 `ab4ba114`와 같아 핵심 커버리지(새 테스트 파일은 핵심 프로필 밖), 빌드 바이트, C5-0 랩, `test:e2e:critical`은 라운드 2 값을 그대로 쓴다. 실제 기기, WebKit, PR CI·Codex·exact-main CI·릴리스 smoke도 SKIP이다.                                      |

## 혼합 버전

known-accepted #13대로 버전 입장 제한이 없다. 4C에는 통신 형식, 메시지 종류, 영구 데이터 모양 변경이 없다.
복귀 확인은 같은 `SYNC_PING` 프레임을 보내고 정확한 `SYNC_PONG`만 받는다(방장은 이미 답한다). ICE 재시작
통신과 보조 경로 프레임은 그대로이고, 옛 빌드 쪽 모양을 고정한 `control-isolation-c9.ts`를 쓰는
`control-isolation.test.ts`가 통과한다.

| 조합                        | 결과                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4C 방장, 9.0.4~9.0.9 게스트 | 방장 기기 안의 변화다. 원래 경로의 재시작 창(주인이 끊김을 쥔 채 `connecting`·`new`)에서 방장은 그 게스트에게 새 대용량 스트림을 시작하지 않고 미리받기를 멈춘 채 둔다. 게스트는 disconnected 때와 같은 자기 복구 요청 경로로 다시 묻고, 재개한 미리받기는 전처럼 청크 0부터 `restart:true`로 온다. 4B의 C5-12 규칙(물러남과 옛 게스트의 남은 경로)은 그대로다. |
| 9.0.9 이하 방장, 4C 게스트  | 게스트 쪽 변화는 복귀 확인과 닫힘 원인이 어디서 정해지는지뿐이고 결과, 원인 낱말, 프레임이 같다. 방장은 전처럼 원시 PC 상태를 읽는다.                                                                                                                                                                                                                           |
| PRO 방                      | PRO 연결도 주인을 갖는다(보조 경로 없음, 재시작 묶음 없음). 15초 유예 닫힘, 묶이지 않은 failed의 즉시 `original-terminal`, 닫힘 원인은 4B와 같다. 영구 재생목록 미디어는 레인을 쓰지 않는다. 옛 PRO 구성원·조정자와 주고받는 프레임이 같다.                                                                                                                     |
| 닫힘 원인 줄                | 각 기기의 로컬 로그다. 원인 낱말과 줄 모양이 4B와 같다.                                                                                                                                                                                                                                                                                                         |
| 업데이트                    | 4C는 업데이트 기계를 바꾸지 않는다.                                                                                                                                                                                                                                                                                                                             |

## 초기 JS 예산

실제 프로덕션 빌드로 잰 값(gzip, `measureInitialTransfer`)과 유지 상한까지의 여유다. 상한은 초기 JS
491,568 B, 초기 전체 570,570 B다. 같은 코드도 빌드마다 수십 B 흔들린다.

| 트리                          | 초기 JS   | 여유     | 진입 스크립트 | 초기 전체 |
| ----------------------------- | --------- | -------- | ------------- | --------- |
| main `9fca1cad`(9.0.9 / v782) | 477,600 B | 13,968 B | 111,428 B     | 556,219 B |
| 4C `ab4ba114`                 | 478,019 B | 13,549 B | 111,434 B     | 556,642 B |

두 값은 같은 기계에서 차례로 빌드해 쟀다. main의 진입 청크(`main-DOlyYtcX.js`)와 값은 운영 9.0.9 / v782의
generation, 4B 보고서의 v782 행과 같다. 4C의 진입 청크는 `main-CEfdhrNr.js`이고 raw 364,761 B로 같다. 4C는
초기 JS를 +419 B 늘렸고, 그 대부분은 첫 로딩에 실리는 peer 청크의 몫이다(gzip 103,052 → 103,383 B, +331 B.
연결 생존 주인 모듈이 이 청크에 있다). 초기 전체 raw는 2,074,871 → 2,074,729 B로 오히려 142 B 줄었다. 갈래에서
잰 증분의 합(+218, +43, +121, −9 = +373 B, 4B v781 트리 위)과 빌드 흔들림 안에서 맞는다.

P4-D4 A대로 막는 선은 5% 예비선(가드) 하나이고 통과했다. 로드맵의 '증분당 +300 B'는 넘은 증분이 없고(가장 큰
C5-6 +218 B), 4C 하나만 보면 'Phase당 순 +200 B'는 넘는다. Phase 4 전체로는 4A의 −14,367 B, 4B의 +666 B, 4C의
+419 B를 합해 약 −13,280 B라 Phase 목표와 '프로그램 순 0 이하' 목표 안이다. 유지 상한, 5% 예비, 진입 상한, 첫
로딩 글꼴 0은 그대로다.

## 배포·회복

**배포 대상.** target `app`, Developer API D1 `false`(예상). 4C는 App 런타임 입력(`src`, bump 때의
`package.json`·App Worker·SW 캐시·`index.html`)만 바꾼다. 새 D1 스키마·비밀·바인딩·통신 형식은 없다. bump는 이
문서 뒤에 SemVer(9.0.9 다음)와 SW 캐시 epoch(v782 다음)를 함께 올린다. 업데이트 창이 뜨는 배포이고, 오너
결정(2026-10-25 약 01:50 KST)대로 자동 게이트가 통과하면 따로 묻지 않고 낸다.

**되돌리기.** 코드 되돌리기가 기본이다. revert도 더 높은 SemVer와 캐시 epoch로 다시 배포하고, 4C 열차가
되돌리기 단위다([hotfix-procedure.md](../hotfix-procedure.md)의 Rollback). 급할 때의 Cloudflare App 버전
되돌리기는 9.0.9, 9.0.8, 9.0.7, 9.0.6, 9.0.5로 할 수 있다. 모두 PRO 입장 정책 계약 표지
(`pro-room-optional-entry-password-v1+pro-owner-transfer-pinless-v1`, 9.0.4부터)를 가진다. 9.0.9로 되돌리면 전송
상태가 다시 원시 PC 상태를 읽고(재시작 창의 `connecting`이 다시 bulk-writable, 미리받기는 선택 쌍 보고에서도
재개) 연결 생존 기계들이 연결 안으로 돌아간다. 통신·저장 형식은 같고 새 D1·비밀·저장 데이터 마이그레이션은 없다.

## 실기기로 확인하지 않은 것

오너 결정(2026-10-25 약 01:50 KST)대로 기기 근거는 배포의 게이트가 아니다. 아래는 4C 코드로 아직 실행하지 않은
것이고, 오너가 나중에 쓰도록 기기 절차를 적어 둔다. 판정 기준은 결과를 보기 전에 고정하고 결과를 본 뒤 넓히지
않는다.

- 4A 기기 라운드(#18, 미리받기 재개, QA036·QA040·QA007, 홈 화면 앱)와 4B 기기 확인도 아직 없다. 그래서 4C의
  전후 기기 비교 기준이 없다.
- **C5-6 기기 절차(원래 경로의 유예와 재시작 문).** Windows Chrome 방장(`?mxqrLog=info`), 같은 와이파이의 iPhone
  Safari·Android Chrome 게스트, 로컬 파일 재생 중. (1) 게스트 와이파이를 약 5초 껐다 켠다: 창과 재접속 없이
  재생이 이어지고 방장 콘솔에 그 게스트 PeerID의 `[Transport] Logical connection closed` 줄이 없다. (2) 약 25초
  껐다 켠다: 끊긴 뒤 15초 근처에 링크가 닫히고 방장 콘솔에 그 게스트의 원인 줄이 하나 있다(유예가 닫으면
  `original-grace-expired`). 원인 줄은 4A·4B 허용표로 판정한다. (3) 와이파이에서 LTE로 바꾼다(release-record의
  #18 단계): 원래 경로의 `[Transport] Restarting established Standard-room ICE within disconnect grace`와 보조
  연결 두 줄을 방장과 게스트 콘솔을 합쳐 본다.
- **C5-7 기기 절차(백그라운드 복귀 확인).** iPhone Safari 게스트가 방에 있는 채로 15초 넘게 홈 화면이나 잠금
  화면에 두었다가 돌아온다. 방장이 그대로면 창 없이 이어진다(정확한 pong). 방장 탭을 닫아 둔 채 돌아오면
  게스트가 창으로 끝나고, P4-D5 B 절차(4B 보고서)로 다음 info 페이지의 `[Transport] Previous page closed
(<cause>)` 원인을 적는다(복귀 확인이 닫으면 `resume-stale`, `resume-disconnected`, `resume-probe-unanswered`
  중 하나). WebKit이 죽은 RTC를 connected로 보이는 경우는 기기에서만 생긴다.
- **C5-8 기기 절차(전송 상태가 주인을 읽음).** release-record의 8.11.25 미리받기 재개 단계(폰이 다음 곡을
  미리받는 중 와이파이를 몇 초 껐다 켜거나 LTE로 바꿈) 위에서 방장 콘솔의 `Paused preload`가 끊긴 동안 하나,
  `Resuming preload`가 복구 뒤 하나인지, 다음 곡이 다시 받지 않고 바로 재생되는지 본다. 4C에서는 `Resuming`이
  방장 원래 PC가 connected로 돌아온 뒤에 나와야 한다(방장 PC의 `chrome://webrtc-internals` connectionState
  기록과 시각 비교). 재시작 창 동안 새 트랙을 시작하면 그 게스트가 받는 표시와 재생까지 초를 적는다(게스트의
  복구 요청으로 받는 길). 끊김이 15초보다 짧으면 방장이 그 게스트를 떼지 않는지(하트비트 lease)도 본다.
- **C5-10:** 실제 망의 닫힘에서도 링크당 원인 줄이 하나인지.
- WebKit 레인, 운영 Cloudflare 전송 경로, 브라우저의 PRO 방(이제 PRO 연결도 주인을 가진다).

운영 데이터나 서비스에 장애를 주입하는 검사는 이번 로컬 검증에 포함하지 않았다.

관련 계약: [자원 소유권](resource-ownership-registry.md)(RO-15, RO-17, RO-18, RO-35),
[실시간 런타임 소유권](realtime-runtime-ownership.md), [신호 생존](signaling-liveness.md),
[4A 보고서](phase4-4a-transport-rejoin-2026-10-24.md), [4B 보고서](phase4-4b-behaviour-2026-10-25.md),
[현재 릴리스 기록](../release-record.md).
