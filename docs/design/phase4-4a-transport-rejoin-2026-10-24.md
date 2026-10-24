# Phase 4 4A 배포 묶음: 연결 생존·출력 재합류의 중립 재구성 (2026-10-24)

| 항목      | 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기준      | origin/main `fa256db2`(R2 기록 #477. 런타임은 운영 9.0.6 / v777의 배포 SHA `035abaae`와 같다). 작업 중 main이 `b4293768`(#478, 테스트와 C5-0 랩만)로 나아가 `b8bc42c4`로 합쳤다. 겹치는 파일이 없어 충돌은 없었고 런타임은 그대로다.                                                                                                                                                                                                                                                                                                                                                                          |
| 4A 묶음   | 브랜치 `agent/phase4-4a`. 네트워크 갈래 `agent/p4-net`(`f3cce1ec..9a0fea2a`, C5-1·C5-2·C5-3·C5-5·C5-4, 12 커밋)를 `32a290d2`로, 출력 재합류 갈래 `agent/p4-c3`(`d1ce030d..298c2278`, I8a·C3-I1·죽은 상태 삭제·C3 하네스·C13 문서, 10 커밋)를 `7af1723b`로 합쳤다. 그 위에 초기 JS 줄이기 셋(`4103d42e`·`61187df3`·`a54fcba8`)과 그 정리(`c5dd68ab`·`32439cc0`·`b35b95ff`), 리뷰 정리(`fe327649`·`2a02c75c`·`d5155dcd`·`9ff32f42`)를 쌓았다. 이 보고서와 기록 커밋, registry 커밋 `0c94e421`, 문서 리뷰 정리 `1320eea6`(registry 허용 예외 RO-48·RO-49, 가드 테스트의 빈 ID 하나)은 문서와 그 테스트만 바꾼다. |
| 상태      | 2026-10-24 23:26 KST [Release 40102311205](https://github.com/hiefny/MUSIXQUARE/actions/runs/40102311205)(target `app`)로 `9.0.7` / `v778` 배포됨. 바로 앞 [Release 40101887540](https://github.com/hiefny/MUSIXQUARE/actions/runs/40101887540)은 signaling smoke의 `HTTP 503 RATE_LIMIT_UNAVAILABLE`로 실패해 자동 복구됐다. 오너 결정(2026-10-24 약 15:20 KST)대로 기기 기준선 없이 배포했다(아래 오너 결정).                                                                                                                                                                                               |
| 현재 증분 | 동작을 바꾸지 않는 재구성. 15초 RTC 끊김 유예, 신호 재접속 간격, 전송 레인과 게스트 수신 마감, 공유 시작·재정렬 시간 값을 각각 한 곳에 두었다. 일반방 논리 연결이 끝날 때마다 원인 한 줄(info)을 남기고, 전송 상태 읽기를 한 경로와 가드로 모으고, 재합류 라우터의 죽은 상태를 지웠다. 게으른 경로만 쓰는 모듈을 첫 로딩에서 빼 초기 JS가 두 갈래를 합친 491,726 B에서 477,138 B(gzip)가 됐다.                                                                                                                                                                                                                |
| 제품 식별 | `9.0.7` / `v778`. 9.0.6은 배포됐으므로 SemVer와 SW 캐시 epoch를 함께 올렸다(마지막 런타임 커밋 `8a9e1772`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 배포 대상 | target `app`, Developer API D1 `false`. App 런타임 입력만 바뀌고, `cloudflare/`에서는 bump가 App Worker의 `ADMIN_ASSET_VERSION` 문자열 하나만 바꾼다. 다른 Worker의 런타임 경로는 바뀌지 않는다(아래 배포·회복).                                                                                                                                                                                                                                                                                                                                                                                              |
| 환경      | Windows 11 로컬, Node 24.20.0 / npm 12.0.2. 단위는 jsdom과 가짜 WebRTC·WebSocket, 브라우저 검사는 로컬 헤드리스 Chromium(Playwright 1.63, PeerJS)이다. C5-0 랩은 헤드리스 Chromium 153.0.8010.12와 `wrangler dev --local`로 띄운 신호 Worker 위에서 게스트 페이지의 P2P만 CDP로 끊는다.                                                                                                                                                                                                                                                                                                                       |
| 운영      | 배포 뒤 운영 업데이트 경로(대화상자, 나중에, 적용하기 한 번, 옛 탭 자동 새로고침)를 데스크톱 Chromium에서 방 밖으로 확인했다. 실제 기기, iOS·WebKit, 운영 Cloudflare 전송 경로, 브라우저의 PRO 방은 미실행이다.                                                                                                                                                                                                                                                                                                                                                                                               |

이 문서는 구조 개선 Phase 4의 첫 앱 배포(4A)에 실리는 증분과 QA를 기록한다. 4A는 동작을
바꾸지 않는 묶음이고, 동작을 바꾸는 증분은 4B로 따로 낸다(P4-D3 A). 증분마다 커밋, 검증한 코드
SHA, 환경, PASS/FAIL/SKIP과 한계를 적는다. 갈래에서 검증한 커밋은 합침 커밋으로 그대로
들어왔다(체리픽 없음).

## 오너 결정 (2026-10-24)

오너는 2026-10-24 약 15:20 KST에 Phase 4를 시작하며 추천안 전부를 고르고, 배포까지 맡긴 채
자리를 비웠다. 기기 평가는 나중에 오너가 한다.

- **범위(P4-D6 A, P4-D13 A):** 아직 기기 근거가 없다(Set 1과 기준선 미실행). 그래서 C5-6
  (LinkLiveness), C5-7(백그라운드 복귀 확인), C5-8은 release-record의 #18 보조 연결 ICE 재시작과
  미리받기 재개 항목이 근거로 닫히거나 면제될 때까지 보류한다. 4A는 중립 부분만 싣는다. I8a,
  C5-1·C5-2·C5-3, C3-I1, close(reason)과 C5-5, C5-4와 ADR 수정, C3 죽은 상태 삭제, 문서다.
- **기기 기준선을 미룸, 게이트 편차:** Phase 4 게이트(#18과 미리받기 재개를 닫거나 면제, C5-0
  green, QA007·QA036·QA040 기준선) 중 기기 부분은 면제가 아니라 미룬다. QA007·QA036·QA040
  기준선은 4A 위에서 처음 잰다. 그래서 4A의 중립성은 기기 전후 비교가 아니라 자동 근거(단위,
  특성화 테스트, C5-0 랩)에 기댄다. #18과 미리받기 재개는 release-record §2에 열린 채로 둔다.
  C5-0 green은 #478이 2026-10-24 main(`fa256db2` 런타임, `b4293768`)에서 채웠다(아래 Phase 4 준비
  근거).
- **P4-D11 예외:** 4A는 R2 배포(2026-10-24 12:24 KST) 7일 안이고 Phase 3 실기기 확인 전이다.
  오너가 직접 허락한 것은 기기 기준선 없이, R2 배포 7일 안에 4A를 배포하는 것이다("배포해도
  된다"). 오너는 배포와 기기 평가를 맡기고 자리를 비웠고, Phase 3 실기기 확인 전에 배포하는 것은
  그 위임 아래의 판단이다. P4-D11 A의 원문은 Phase 3 기기 확인 통과를 조건으로 둔다. Phase 3
  시계는 다시 시작하지 않는다. 4A 뒤 업데이트 경로 제보(적용이 멈춤, 새로고침 두 번)가 오면 Phase 3
  몫으로 보고, 그 고침 배포부터 Phase 3의 14일을 다시 센다(P4-D11 A).
- **P4-D3 A:** Phase 4의 앱 업데이트는 두 번이다. 4A(중립)와 4B(위험·동작 변경)이고, 4B는 4A 배포
  7일 뒤 이후에 낸다.
- **P4-D4 A:** 첫 로딩은 5% 예비선(가드)만 막는 선이다. Phase 4는 순 증가 0 이하를 목표로 절약을
  먼저 싣고 증분마다 실제 빌드로 잰다. 로드맵의 증분·Phase당 상한은 Phase마다 보고하는 목표다.
- **P4-D5 A:** 일반방 논리 연결이 끝날 때 짧은 원인 토큰 한 줄을 info 레벨로, 상대 PeerID와 함께
  메모리 로그에만 남긴다. 첫 원인을 남기고 닫힘 순서는 그대로다.
- **P4-D7 A, P4-D8 A, P4-D9 A:** PRO 청취자의 일시정지 틈, 게스트 복귀 맞추기의 두 경우, 데모
  시작 기준 시각은 코드를 바꾸지 않고 테스트로 조사만 했다(아래 Phase 4 준비 근거). 동작 변경이
  필요하면 4B 전에 다시 묻는다.
- **P4-D10 임시 C:** ICE 복구 뒤 같은 파일을 두 레인으로 보내는 경우(F4)는 F4 테스트를 본 뒤
  정한다. 4A는 바꾸지 않는다.
- **P4-D12 A, P4-D14 A, P4-D15 A, 알림 N1:** 기기 라운드는 로그가 필요한 단계를 브라우저 탭으로
  하고, 홈 화면 앱은 화면과 WARN 줄만 본다. Phase 4 종료는 마지막 열차 뒤 기기 재실행에서 퇴행
  없음, 14일 무제보, 구조 확인(RO-15·RO-17·RO-18)이다. 다른 SSID 단계를 못 하면 나머지가 통과할 때
  #18을 닫고 범위를 적는다. #18을 닫는 줄은 방장과 게스트 콘솔을 합쳐 센다(`Restarting isolated
control ICE` 줄은 두 기기 중 재시작을 시작하는 한쪽만 남긴다).

**구현 중 정한 세부(오너가 맡긴 판단, 2026-10-24).** 오너가 돌아와 다시 확인한다.

- 두 갈래를 합친 트리의 초기 JS가 491,726 B로 유지 상한 491,568 B를 158 B 넘었다. 수치를 들고
  다시 묻는 대신 동작을 바꾸지 않고 첫 로딩에서 게으른 모듈을 빼는 줄이기 셋을 실었다(아래 초기
  JS 줄이기). 상한과 예비는 그대로다.
- C5-5는 처음에 원인 기록만 담은 `src/network/transport/link-liveness.ts`를 만들었다. 소비자가
  하나뿐인 모듈이라 `CloudflareDataConnection` 안으로 되돌렸다(`9a0fea2a`, Phase 4 기본값 4).
  그 모듈은 C5-6 때 유예, 재시작 문, 복귀 확인이 실제로 옮겨 올 때 만든다.
- 오류로 시작한 방장·게스트의 닫힘과 PRO epoch 전진의 일괄 닫힘은 합의한 토큰이 없어
  `intentional`로 남긴다. 기기 판정의 단계별 허용표는 결과 전에 따로 고정한다.
- `src/ui/setup.ts`의 재접속 주석을 실제 동작대로 고쳤다. 다시 읽힌 `/CODE` 페이지는 시작 화면에서
  '시작하기'를 눌러야 들어간다(`2a02c75c`, 주석만, Phase 4 기본값 12).

## 제품·런타임 증분

### I8a 데모 방장 시작 기준을 시작 잎 모듈로

커밋 `d1ce030d`. `src/network/sync.ts`가 데모 시작 기준 getter 하나 때문에
`src/demo/playback-timing.ts` 전체(`projectDemoPlay`와 `DEMO_PLAY_*` 상수)를 첫 로딩에 실었다. 기준
값과 setter·getter만 새 잎 `src/demo/host-start-anchor.ts`로 그대로 옮겼다. `demo/mode.ts`는 같은 네
곳에서 setter를 부른다.

중립 근거: 저장 위치가 하나이고 검증, 미래 시각 확인, 호출 위치와 순서가 같다. 기존 고정 테스트
둘(`sync.test.ts`의 늦게 들어온 게스트 PONG, `playback-timing.test.ts`의 발행 대기 기준)은 import
경로만 바뀌었다. 초기 JS는 갈래 단독으로 491,481 B에서 491,310 B(−171 B)다.

### C5-1 RTC 끊김 유예 15초를 한 곳에

테스트 `f3cce1ec`, 코드 `3ea8c4c3`. `RTC_INTERRUPTION_GRACE_MS = 15_000`을 `src/core/constants.ts`에
두었다. 원래 연결의 유예(`cloudflare-signaling.ts` 다섯 곳: 백그라운드 복귀 기준, 유예 마감과
타이머, 재시작 답 대기), 재시작 능력이 없는 보조 연결의 유예(`control-isolation.ts`), heartbeat
임대 상한(`<= 15_000`)이 이 값을 읽는다. `RESTART_WINDOW_MS`(15초)와 `RESTART_CAP_MS`(30초)는
리터럴로 남겼다. 두 끝이 다른 빌드일 수 있고(known-accepted #13) 서로의 재시작 요청과 offer를 이
값으로 묶기 때문이다(RO-35).

중립 근거: 바뀐 자리는 모두 15,000이었다. 남은 시간 15,001 ms인 임대는 무시하고 15,000 ms인
임대는 따르는 새 테스트가 상한을 14,999나 15,001로 바꾸면 실패한다. 동결 fixture
`control-isolation-c9.ts`와 테스트 쪽 15초 사본은 그대로라 15초를 따로 고정한다.

### C5-2 신호 재접속 간격을 한 곳에

테스트 `f3cce1ec`, 코드 `f009d594`. `SIGNALING_RECOVERY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000,
15_000]`을 `src/network/signaling-health.ts`에 두고 시도 수(5)는 그 길이에서 얻는다. `peer.ts`의
사본을 지웠다. PRO의 같은 값 `CONTROL_CHANNEL_RECOVERY_RETRY_MS`는 다른 계약이라
`pro-room/runtime.ts`에 남겼다.

중립 근거: 간격, 시도 수, 신호 상태에 내는 시도 번호, 타이머 키 `peer-signaling-reconnect`, 로그
문자열이 같다. #471의 만료 단락 열 곳은 손대지 않았다(#478의 `signaling-expiry-short-circuits`가
하나씩 고정한다). 재접속은 +1, +3, +7, +15, +30초에 하고 다섯 번 뒤 소진하며, 수동 재시도·online
이벤트·화면 복귀가 1번부터 다시 시작한다는 특성화가 그대로 통과한다. RO-29 지문 기준과
`signaling-liveness.md` 문장이 상수 위치를 가리킨다.

### C3-I1 공유 시작·재정렬 시간 값

테스트 `b181a3a7`, 코드 `03f44410`, 리뷰 정리 `fe327649`.

- (a) 재정렬 재시도 간격 [250, 750, 1,500, 3,000, 5,000] ms를 두 사슬(재합류 라우터, 백그라운드
  복귀)이 `src/youtube/constants.ts`의 `LOCAL_OUTPUT_REALIGN_RETRY_MS`에서 읽는다. 두 사슬이 이미
  닿는 시작 잎이라 청크 목록이 그대로다.
- (b) `DEMO_PLAY_START_LEAD_MS`는 게으른 데모 모듈 안에서 `LOCAL_FILE_START_LEAD_MS`의 별칭이다.
- (c) 2초 `HOST_TIMELINE_TRUST_WINDOW_MS`, (d) 250 ms `GUEST_START_SYNC_PING_DELAY_MS`를
  `src/player/file-play-timing.ts`에 둔다. 파일 검사는 양쪽, 데모 검사는 한쪽 그대로이고 타이머
  이름도 그대로다.
- (e) 랑데부 진행 중의 busy 답도 `MANUAL_RENDEZVOUS_RETRY_MS`를 돌려준다. `fe327649`에서 라우터의
  `?? 250` 대비값도 같은 상수를 읽는다. 오늘 busy 답은 모두 `retryAfterMs`를 실어 이 대비값은
  방어용이다.
- (f) 옛 수신자를 위한 통신 리드(PLAY 200 ms, DEMO_PLAY 350 ms)는 일부러 따로 둔다.

중립 근거: 각 자리는 전과 같은 수를 읽고 조건식, 평가 순서, 타이머 이름, 로그, 통신 필드가 같다.
특성화 테스트가 그대로 통과하고, 공유 값을 5,001·2,001·251로 바꾸면 13건이 실패한다.

### C5-3 전송 레인과 게스트 수신 마감

테스트 `9328d838`, 코드 `9d6e5bd8`. `src/storage/transfer-backpressure.ts`에
`BULK_LOCAL_BUFFER_LIMIT_BYTES`(64 KiB, 여섯 자리)와 `BULK_UNICAST_STALL_TIMEOUT_MS`(30초, 본 파일과
미리받기 unicast)를 두었다. broadcast 멈춤 시간(본 파일 5초, 미리받기 30초)은 일부러 달라서 따로
둔다. 게스트 수신 마감은 `src/core/constants.ts`의 표를 `receiveDeadlineMs(kind, connectionType)`로
읽는다(청크 12초/60초, FILE_PREPARE 15초/60초, 미리받기 대기 30초/60초, remote만 60초).
`PRELOAD_RECEIVE_DEADLINE_MS`는 미리받기 입장 30초와 진행 15초다. 소비자가 하나였던
`WATCHDOG_TIMEOUT`은 지웠다.

중립 근거: 바뀐 값이 모두 같고 관리 타이머 키, 순서, 로그("after 30s" 포함), 통신 형식이 같다.
새 수신 마감 테스트가 remote 60초 분기를 처음 고정하며, 값을 하나라도 바꾸면 실패한다. 표가 첫
로딩 상수 청크에 들어가 초기 JS가 +174 B 늘었다.

### C3 재합류 라우터의 죽은 상태 삭제

테스트 `0ea96ad7`, 코드 `088ef162`. `awaitingAuthoritativeResumeMode`는 쓰기만 하고, 하나뿐인 읽기가
모든 사유가 이미 돌아간 뒤에 있었다. 필드와 쓰기 열두 곳, 리셋 둘, 그것만 하던 구독 둘을 지우고
의도 판정을 never 확인으로 끝나는 사유별 switch로 바꿨다. 형 밖의 사유는 실행 중에 거절된다.

중립 근거: 모드 2 × 사유 4 × 활동 4 × 로컬 일시정지 × 앞선 OS PLAY의 128개 판정표가 지우기 전후
그대로 통과한다. 지우기 전 대비 분기에 넣은 표지는 전체 단위(645 files / 14,978 tests)에서 한 번도
맞지 않았다. 사유를 하나 빼면 tsc가 never 확인에서 실패한다. 라우터는 게으른 방 기능 청크에 있어
초기 JS는 그대로다.

### C5-5 일반방 논리 연결의 종료 원인 한 줄

테스트 `3c43b62d`·`d7bf5319`, 코드 `83077ecf`·`9d7ee20a`·`9a0fea2a`.
`CloudflareDataConnection.terminate(cause)`가 맨 위에서 첫 원인을 기록하고, 나머지 본문(유예 취소,
복귀 확인 정리, 해제, `markClosed` 자리)은 그대로 돈다. PC와 채널을 해제하며 다시 들어오는
`terminate()`는 첫 원인을 바꾸지 않아 논리 연결 하나에 info 줄이 정확히 하나다.

```text
[Transport] Logical connection closed (<cause>) for <peerId>
```

`peerId`는 그 연결의 상대다. 모든 로그처럼 메모리에만 남고, 운영 기본 레벨은 WARN이라
`?mxqrLog=info`로 열어야 보인다. 코드에 고정된 토큰은 다음과 같다.

| 종류 | 토큰                      | 기록하는 곳                                                                                                                                                                                             |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 내부 | `control-send-failed`     | 전송 신용의 hello·receipt 보내기 실패                                                                                                                                                                   |
| 내부 | `side-failed:<사유>`      | 보조 연결 실패. 사유는 `expired`(재시작 창·상한 소진), `route`(보조 경로 실패, 펜스 뒤 거절), `send`(로컬 보내기 예외), `protocol`(프레임 규약 위반, 전달 실패), `limit`(프레임·후보·offer·대기열 상한) |
| 내부 | `channel-closed`          | 데이터나 제어 채널이 닫힘                                                                                                                                                                               |
| 내부 | `original-terminal`       | 원래 PC가 closed, 또는 재시작 연결 없이 failed                                                                                                                                                          |
| 내부 | `original-grace-expired`  | 원래 연결의 15초 유예 끝                                                                                                                                                                                |
| 내부 | `resume-probe-unanswered` | 백그라운드 복귀 확인에 답이 없음, 확인 보내기 실패                                                                                                                                                      |
| 내부 | `resume-stale`            | 복귀 때 RTC가 끝났거나 채널이 건강하지 않음, 신호를 잃은 채 disconnected                                                                                                                                |
| 내부 | `resume-disconnected`     | 복귀 때 disconnected의 짧은 확인 끝                                                                                                                                                                     |
| 외부 | `heartbeat-stale`         | 방장 heartbeat 감시의 오래된 연결 닫기                                                                                                                                                                  |
| 외부 | `open-timeout`            | 방장의 열림 타이머, 게스트의 입장 시간 초과(데이터 채널이 열리지 않음)                                                                                                                                  |
| 외부 | `rollback-unproven`       | 증명할 수 없는 ICE 재시작 되돌리기, 미디어 되돌리기 실패의 연결 은퇴                                                                                                                                    |
| 외부 | `admission-expired`       | 게스트의 방 입장 만료(`ROOM_EXPIRED`)                                                                                                                                                                   |
| 외부 | `peer-left`               | 신호의 peer-left(방장, 게스트)                                                                                                                                                                          |
| 외부 | `leave`                   | `leaveSession`, `cancelPendingSessionSetup`                                                                                                                                                             |
| 대비 | `intentional`             | 이유 없이 부른 `close()`                                                                                                                                                                                |

`intentional`로 읽히는 닫힘은 실제로 의도한 닫힘(강퇴, 교체, 밀려난 협상, destroy, 시작 화면
게스트의 뒤로 가기 취소)만이 아니다. 오류로 시작한 방장·게스트의 닫힘(방장과 열린 뒤 게스트의
오류 처리기)과 PRO epoch 전진의 일괄 닫힘도 합의한 토큰이 없어 `intentional`로 읽힌다.

- `9d7ee20a`(리뷰가 찾은 결함): 방 입장이 만료되면 게스트 입장 흐름의 오류 처리기가 같은 emit 안에서
  이유 없이 닫아 `intentional`이 먼저 기록됐다. `closeAfterError(error, cause)`가 원인을 먼저 적고
  오류를 낸 뒤 닫아, 그 경우에도 `admission-expired`가 남는다. 오류 객체와 순서는 그대로다.
- `9a0fea2a`: 원인 기록을 `CloudflareDataConnection` 안의 모듈 전용 타입과 `terminate()` 맨 위로
  옮기고 `link-liveness.ts`를 지웠다. 줄은 바이트까지 같다.
- PeerJS 경로: `close(reason)`의 문자열 인자를 peerjs 1.5.5는 읽지 않는다(`options?.flush`만 읽음).
  PeerJS 닫힘은 전과 같다.

중립 근거: 타이밍 값, 순서, 상태 전이, 통신 형식, 영구 데이터 모양, `/debug` 타이머 이름, 관리
타이머 키, 기존 로그 문자열이 그대로다. 새 info 줄 하나만 더했다. release-record가 인용하는 다섯
줄(보조 연결 셋, 미리받기 Paused·Resuming)은 바이트가 같다(#478의 고정 테스트가 통합 트리에서
통과). 모든 닫힘 경로 테스트가 줄, 원인, 한 번 닫힘을 확인하고, 해제 정확히 한 번 테스트와
RO-15·RO-16 기준 테스트는 손대지 않았다. #471 규칙 셋(만료 뒤 원래 연결 ICE 재시작 없음, 만료 뒤
복귀 확인은 신호 끊김, `peer.ts` 바깥 루프의 만료 단락)도 그대로다. 관찰: 방장 쪽에서 재시작 연결
없이 원래 PC가 failed가 된 게스트는 heartbeat 감시가 닫기 전에 `original-terminal`로 끝나는 경우가
많다. 초기 JS는 `83077ecf`가 +186 B(대부분 peer 청크, 보조 연결 사유 문자열 약 45 B),
`9d7ee20a`가 +52 B, `9a0fea2a`가 +11 B다.

### C5-4 전송 상태 읽기 경로 하나와 가드

테스트 `df711b3b`, 코드 `026fe6a9`. 새 `src/network/transport-health.ts`의
`readTransportHealth(conn)`이 데이터 연결의 RTC 상태를 한 번 읽고(open, pc, ice, data, control,
recoveryDeadline), 순수 판정 넷이 옮긴 본문을 갖는다. `isBulkWritable`(chunk-pump),
`isRecoverablyInterrupted`(preload), `heartbeatStaleThreshold`(8·30·90초 문턱과 함께),
`honoursRecoveryLease`다. 호출자는 자기 현재 연결 확인을 그대로 한다. heartbeat 감시는 임대, 5초
주기, 펜스, 끊김 발행, 원시 PC 상태를 찍는 경고 문구를 그대로 갖는다. `guard:transport-health`
(`scripts/check-transport-health.mts`, CI 단계와 `package.json` 별칭)가 `src/storage/**`와
`heartbeat-monitor.ts`의 원시 `connectionState`·`iceConnectionState` 읽기를 구문 트리로 센다. 8에서
1(허용한 경고 줄)이 됐다. `realtime-runtime-ownership.md`의 ADR에 이 읽기 규칙을 더했다.

중립 근거: 본문을 그대로 옮기고 속성 읽기만 스냅샷 필드로 바꿨다. 읽는 값은 모두 평범한 필드나
순수 getter다. 앞 커밋의 전수 진리표(현재 연결 2,800 결과, 112행)가 바이트까지 같고, 옮긴 판정을
바꾼 변이 넷이 각각 테스트 하나에서 실패한다. `transport-health.ts`는 critical 커버리지에 99 하한으로
들어갔다(측정 100). 초기 JS는 +8 B다.

### C3 교차 흐름 하네스와 C13 문서

테스트 `c303c06c`·`784dfe47`·`4a10df00`·`815b4271`, 문서 `298c2278`. src 변경은 없다. 하네스
결과는 아래 Phase 4 준비 근거에 적는다. `815b4271`은 실패한 PLAY의 재시도와 라우터의 출력 갱신이
한 세대 펜스를 나눠 쓰는 것을 고정 (k)로 고정했다. `298c2278`은 그것을
`playback-concurrency-invariants.md`의 불변식 C13 '출력 재시작 중재'로 적고 `qa-domains.md` QA007의
진입점을 고쳤다. 로드맵이 C3-I9를 문서로 줄였으므로 lease 이름 바꾸기는 하지 않는다.

### 초기 JS 줄이기

커밋 `4103d42e`·`61187df3`·`a54fcba8`, 정리 `c5dd68ab`·`32439cc0`·`b35b95ff`. 시작 코드가 이름 하나만
쓰는데 그 모듈 전체가 진입 청크에 들어 있던 세 곳을 작은 잎 모듈로 나눴다. 수치는 아래 초기 JS
예산에 있다.

- `4103d42e`: `pro-room/setup-flow.ts`가 `ProRoomApiError` 하나 때문에 PRO API 클라이언트 전체와
  `queue-mode.ts`·`snapshot.ts`를 첫 로딩에 실었다. 클래스와 `ProRoomSessionEndReason`을 새
  `src/pro-room/api-error.ts`로 그대로 옮겼다. `api.ts`는 그 클래스를 import해 던지고 값으로 다시
  내보내, 게으른 PRO 모듈은 같은 클래스를 본다. `api.ts`·`queue-mode.ts`는 setup-flow가 API 호출
  전에 이미 기다리는 PRO 런타임 청크로, `snapshot.ts`는 기존 공유 `system-audio-service` 청크로 갔다.
- `61187df3`: `ui/playlist-view.ts`가 PRO 업로드 행 포트 때문에 `ProRoomUploadQueue` 클래스 전체를
  실었다. 활성 대기열 상태, 알림, 포트 함수 다섯을 새 `src/pro-room/active-upload-queue.ts`로 그대로
  옮겼다. `upload-queue.ts`는 대기열을 만드는 유일한 곳인 PRO 런타임 청크로 갔다.
- `a54fcba8`: `network/peer.ts`가 스스로 부르지 않는 `forceStereoSdp`·`sdpPrefersOpusStereo`를 새
  `src/network/opus-stereo-sdp.ts`로 옮겼다. 사용자는 게으른 시스템 오디오 모듈 다섯뿐이고, 잎은
  기존 `system-audio-sfu` 청크로 갔다.
- 정리: `c5dd68ab`는 `a54fcba8` 뒤 시스템 오디오 게스트 묶음이 실제 peer 모듈을 읽지 않게 빈 mock을
  되살렸다(검사 그대로, 32건 통과). `32439cc0`은 세션 종료 사유 타입을 잎에서 import하고 타입 재내보내기를
  지웠다(내보낸 코드 차이 없음). `b35b95ff`는 이번에 첫 로딩에서 뺀 네 모듈(`demo/playback-timing.ts`,
  `network/opus-stereo-sdp.ts`, `pro-room/api.ts`, `pro-room/upload-queue.ts`)을 `vite.config.ts`의
  `DEFERRED_ENTRY_MODULES`에 더했다. 뒤의 정적 import가 이 모듈을 다시 첫 로딩으로 끌어오면 빌드가
  실패한다. 잎이 네 모듈을 import하는 시험 빌드에서 가드가 정확히 그 넷을 짚어 실패했다.

중립 근거: 클래스, 함수, 정규식, 인자, 호출 위치, instanceof 검사가 같다. 새 동적 import와 새
청크가 없고, 청크 목록(112개)과 서비스 워커 앱 셸 목록(106 자산)이 같다. 청크 사이 정적 간선은
둘만 바뀌었다. `system-audio-service`가 진입 청크를 import하지 않게 됐고, `system-audio-host`가
`system-audio-sfu`를 import한다. `system-audio-host`를 싣는 두 청크(방 기능 런타임, debug console)는
이미 `system-audio-sfu`를 먼저 import하므로 추가로 받는 파일이나 평가 순서가 바뀌지 않는다. 옮긴
모듈은 최상위에 선언만 있어(함수, 클래스, 리터럴 상수, Set, 정규식) 게으른 청크와 함께 평가돼도
관찰할 수 있는 일이 없다.

### 리뷰 정리

`fe327649`(위 C3-I1), `2a02c75c`(재접속 주석, 주석만), `d5155dcd`(테스트 이름 둘. transport-health
테스트가 각 필드를 한 번씩만 읽는지도 확인하고, peer-init-cancellation 도우미 이름을 하는 일대로
바꿈), `9ff32f42`(registry RO-05·RO-06·RO-10·RO-18, C13, transport-health 규칙 문구, 가드 주석. 문서와
주석, 그리고 가드 테스트가 고쳐 보는 RO-10 Status 문구를 새 문구에 맞춤. 단언은 그대로).

문서 리뷰 뒤 `1320eea6`이 오너 결정 P4-D8 A와 P4-D9 A를 registry 허용 예외로 적었다. RO-48(부모
RO-05)은 게스트 YouTube 재정렬 두 레인을 그대로 두고 C3-I3·C3-I4를 하지 않는 결정이고, RO-49(부모
RO-06)는 대기열과 데모의 시작 기준 둘을 그대로 두고 C3-I8·C3-I7을 미루는 결정이다. 각각 위 C3 교차
흐름 하네스가 고정한 틈과 다시 볼 조건을 적었다. 같은 커밋이 끝난 0d 단계(RO-15·RO-17·RO-29)를
색인에서 지우고, registry의 배포 묶음 문단에 P4-D3 A를 적고, C13의 `pro-room/runtime.ts` 줄 번호를
`61187df3` 뒤 값으로 고쳤다. 가드 테스트의 '블록 줄 없는 색인 행' 사례는 이제 기록이 된 RO-48 대신
RO-99를 쓴다(단언은 그대로). 문서와 그 테스트만 바뀌었다.

### 9.0.7 / v778

마지막 런타임 커밋에서 R2의 `7d14ff10`과 같은 자리를 올린다. `package.json`, `package-lock.json` 두
곳, App Worker의 `ADMIN_ASSET_VERSION`, 관리자 스크립트의 `ADMIN_SCRIPT_VERSION`,
`SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 쿼리다. App Worker 줄이 `cloudflare/`의
유일한 변경이므로 R2처럼 bump SHA에서 `build:checked` 전체와 Worker 전체
(`vitest run --config vitest.workers.config.ts`)를 다시 돌린다. bump 커밋은 `8a9e1772`이고 `guard:release-identity`(MUSIXQUARE 9.0.7, cache v778)와
`guard:sw-cache-version`(v778이 모든 PWA 런타임 변경을 덮음)이 PASS했다.

## Phase 4 준비 근거

### #478 테스트와 C5-0 랩 (main `b4293768`, 테스트만)

- **기기 근거 로그 다섯 줄:** 보조 연결 recovered(info), restarting (n/2)(info), did not
  recover(warn), 미리받기 Paused(info)·Resuming(info, 게스트 PeerID 포함)를 실제 경로로 띄워 글자,
  인자 수, 레벨을 고정했다. 4A 통합 트리에서도 통과한다.
- **연결 생존 특성화:** 원래 연결의 15초 유예(벽시계 마감, 경과 시간 타이머, 갱신 없음), 끊김
  하나에 재시작 하나, connected·disconnected·재시작 가능한 failed·끝난 failed의 효과 순서, 보조 PC를
  포함한 백그라운드 복귀 확인의 모든 결과, #471의 만료 행(만료 뒤 원래 연결 ICE 재시작 없음, 15초
  유예는 그대로 닫음, 만료 뒤 복귀 확인은 신호 끊김), `peer.ts` 만료 단락 열 곳 각각.
- **오늘 동작대로 고정한 둘:** 경로 재시도 장벽(Phase 4 기본값 11)은 설정을 만료 없이 설치해 다음
  확인 때 바로 갱신한다. PRO epoch 닫힘은 Worker가 `PRO_ROOM_EPOCH_ADVANCED`로 닫는데 클라이언트 두
  곳이 `PRO_COORDINATOR_EPOCH_ADVANCED`와 비교해, 실제 epoch 닫힘이 평범한 신호 끊김 경로를 탄다.
  고칠지 허용할지는 아직 묻지 않았다.
- **F4 단위 재현**(`ice-recovery-bulk-lanes.test.ts`): local 게스트의 미리받기가 끊긴 동안 방장이 그
  트랙으로 넘기면, 복구 뒤 방장이 같은 연결·대기열 항목·세션으로 `PRELOAD_START restart:true`와 본
  레인 `FILE_START`(청크 0부터)를 모두 보낸다. 세 청크 파일에 페이로드 청크 여섯이다. 게스트는 본
  레인을 재생한다.
- **C5-0 랩**(`e2e/lab/*.lab.ts`, `playwright.lab.config.ts`, CI 밖): 오늘 main(`fa256db2` 런타임)에서
  여덟 시나리오가 세 번 반복 모두 통과했다(24/24, 17.0분). 원래 연결만 10초 끊기면 같은 연결
  객체로 restore 뒤 약 0.44초에 돌아온다. 보조 PC가 failed(15.0~15.8초)에 닿으면 보조 ICE 재시작이
  restore 뒤 0.2~0.5초에 회복하고, 재시작 offer는 원래 제어 채널로만 간다. 미리받기는 Paused·Resuming
  줄이 그 게스트 PeerID로 한 번씩 남고, ABORT 없이 `PRELOAD_START restart:true` 하나로 정확한
  SHA-256까지 끝난다. F4는 17초 끊김에서 전선으로 재현했다. 23,040,044 B 트랙을 미리받기와 본
  레인으로 두 번 보냈고, 게스트는 restore 뒤 77~81초에 트랙을 받았다. 10초 끊김에서는 탐색 실행 한
  번에서 재현되지 않았다. 공용 shaping 결함 둘(최상위 `offline:false`가 규칙별 offline을 덮음, 포트
  없는 HTTP/WS 예외)을 먼저 고쳤다.

### C3 교차 흐름 하네스 (`c303c06c`·`784dfe47`·`4a10df00`, 테스트만)

재합류 라우터와 백그라운드 복귀 사슬을 실제 `youtube/sync.ts` 랑데부, 미디어 세션, 네이티브 제어
권한, 복귀 가드, 프로토콜 처리기 위에서 돌린다. iframe, 네트워크 보내기, 공유 시계, PRO 런타임,
로그, i18n, 토스트만 가짜다. 오늘 동작을 "expected today" 테스트로 고정했다.

- **P4-D7(PRO 청취자의 일시정지 틈):** 라우터 수준에서 재현했다. PRO 청취자가 보이는 영상을
  일시정지하면 로컬 일시정지만 기록하고 `youtube:set-local-paused`를 내지 않는다. 그래서 실패한 OS
  PLAY 재조정의 다음 재시도(250, 1,000, 2,500, 5,500, 10,500 ms)가 일시정지를 풀고 다시
  재조정한다. 재조정이 성공하면 풀린 채로 남는다. 잠금 화면 PAUSE는 그 재시도를 끝낸다. 실제 PRO
  런타임이 영상을 다시 재생하는지는 런타임이 가짜라 코드 읽기로 추론했다(미실행).
- **P4-D8 (a):** 잠금 화면 PLAY는 바로 맞춘다. 약 1.3초 안에 잠금을 풀면 복귀 사슬이 진행 중인
  랑데부에 폴링 다섯 번을 쓰고 포기한다(맞추기 한 번). 1.3~3초 사이에 풀면 첫 맞추기 3,010 ms 뒤
  두 번째 일시정지·탐색·재생이 생긴다.
- **P4-D8 (b):** 방장이 BUFFERING이나 CUED이거나 iframe이 아직 이전 영상이면, 복귀 사슬은 복귀
  1,250 ms 뒤 포기하고 아무도 다시 시도하지 않는다. 방장이 다시 재생할 때 내는 자기 상태 프레임
  (`hostPlayAt` 없는 `YOUTUBE_STATE` PLAYING)이 남은 차이와 관계없이 게스트를 바로 다시 맞춘다
  (탐색과 재생 사이 150 ms만큼 뒤지고, 뒤의 자동 정밀 랑데부가 0으로 맞춘다). 그 프레임이 빠지면
  heartbeat 보정만 남는다. 3초 넘는 차이는 drift 탐색, 150 ms~3초는 확인 두 번 뒤 자동 정밀 랑데부가
  맞추고, 150 ms 미만은 heartbeat가 고치지 않는다.
- **P4-D9(데모 시작 기준):** 오늘 코드에서 PONG과 DEMO_PLAY는 다른 방장 시작 값을 실을 수 없다.
  데모의 200 ms 리드 동안 DEMO_PLAY, SYNC_PONG, 늦게 들어온 게스트의 데모 bootstrap,
  `getPendingDemoHostStartAt()`이 같은 값을 갖고, 데모 중에는 대기열 기준을 읽는 프레임이 없다.
  잠재 문제는 대기열 기준 쪽이다. 데모에 들어가기 전에 대기열 항목이 선택돼 있었으면 데모 재생이 그
  항목의 정준 기준을 데모 버퍼에 대고 켜고(같은 시작의 두 번째 기록), 그 정준 시간선이 데모 방장의
  보고 위치를 정한다. 숨김 상태에서 오디오 시계가 5초 멈춘 뒤 위치가 0초가 아니라 4.8초다. 이것이
  결함인지 의도인지, 실제 기기에서 두 값이 얼마나 다른지는 미확정이다.

하네스의 변이(PRO 네이티브 일시정지가 의도를 발행, 복귀 사슬의 폴링·멈춤 규칙, SYNC_PONG과 늦은
bootstrap이 대기열 기준을 고름, 데모 중 대기열 기준을 켜지 않음)는 각 커밋에 적은 수만큼 실패한다.

## QA 라운드

### 1. 네트워크 갈래 (2026-10-24)

검증 대상은 `9a0fea2a`(기준 `fa256db2`, C5-1·C5-2·C5-3·C5-5·C5-4)다. 환경은 Windows 11 로컬, Node
24.20.0 / npm 12.0.2다.

| 검사          | 결과와 범위                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저   | 테스트 커밋 다섯(`f3cce1ec`, `9328d838`, `3c43b62d`, `d7bf5319`, `df711b3b`)은 바꾸기 전 런타임(`fa256db2`, `f009d594`, `9d6e5bd8`, `83077ecf`, `9d7ee20a`)에서 통과하고 바꾼 뒤에도 수정 없이 통과한다. 변이: 임대 상한 14,999·15,001, C5-3의 각 값, C5-4 판정 넷이 각각 실패한다. |
| 정적          | `typecheck`, `check:workers`, `lint`, `format:check` PASS.                                                                                                                                                                                                                          |
| 단위 전체     | `vitest run` 648 files / 14,937 tests PASS. Worker 60 files / 2,908 tests PASS.                                                                                                                                                                                                     |
| 핵심 커버리지 | `test:coverage:critical` 75 files / 2,724 tests PASS, 파일별 하한 유지(`transport-health.ts` 99 하한, 측정 100).                                                                                                                                                                    |
| 교차 갈래     | #478의 기준 테스트 8 files / 84 tests가 이 갈래 코드에서 PASS(로그 다섯 줄, 연결 생존 특성화, 만료 단락, F4 단위 포함).                                                                                                                                                             |
| Chromium      | `test:e2e:critical` 61/61 PASS. 전송·미리받기 E2E(multi-guest, preload, preload-progress, preload-queue-mode-cancellation, file-transfer) 19/19 PASS. 둘 다 PeerJS 경로다.                                                                                                          |
| 빌드          | 초기 JS 491,911 B로 유지 상한을 넘었다(갈래 단독, 예상. 라운드 3에서 해결). `build:checked`는 bump 전이라 `guard:sw-cache-version`이 설계대로 실패하므로 전체로 돌리지 않았다.                                                                                                      |
| 독립 리뷰     | 증분마다 리뷰했다. 입장 만료가 `intentional`로 기록되던 결함(`9d7ee20a`로 고침)과 원인 기록만 담은 모듈의 근거 부족(`9a0fea2a`로 되돌림)을 찾았다. 오류로 시작한 닫힘의 `intentional`은 합의한 토큰이 없어 그대로 두었다.                                                           |
| SKIP          | 실제 기기, WebKit, 이 갈래 코드의 C5-0 랩. 동결 fixture `control-isolation-c9`은 전체 단위의 `control-isolation.test.ts` 안에서 돈다.                                                                                                                                               |

### 2. 출력 재합류 갈래 (2026-10-24)

검증 대상은 `298c2278`(기준 `fa256db2`, I8a·C3-I1·죽은 상태 삭제·C3 하네스·C13 문서)다. 환경은
라운드 1과 같다.

| 검사          | 결과와 범위                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저   | `b181a3a7`, `0ea96ad7`은 바꾸기 전 코드에서 통과한다. 공유 값 변이(5,001·2,001·251)는 13건, 대비 분기를 되살린 변이는 판정표 128건 중 23건이 실패한다. 하네스 변이는 위 준비 근거와 같다.       |
| 정적          | `typecheck`, `check:workers`, `lint`, `format:check` PASS.                                                                                                                                      |
| 단위 전체     | `vitest run` 647 files / 15,013 tests PASS. Worker 60 files / 2,889 tests PASS.                                                                                                                 |
| 핵심 커버리지 | `test:coverage:critical` 74 files / 2,797 tests PASS. `local-output-rejoin.ts` 분기 79.48 → 81.5.                                                                                               |
| 빌드          | 초기 JS 491,310 B(I8a, `d1ce030d`), 491,319 B(C3-I1, `03f44410`). C3-I1 전후 내보낸 자산 목록(561 files)이 같다.                                                                                |
| 독립 리뷰     | 하네스 리뷰 두 번을 반영했다. `784dfe47`은 P4-D8 (b)의 결론을 하네스가 보인 만큼으로 좁히고 두 시작 기록을 정수 ms로 갈랐다. `4a10df00`은 방장의 자기 상태 프레임을 더해 그 결론을 다시 고쳤다. |
| SKIP          | Playwright(데모 공통 시작·데모 신뢰성·데모 출력 복구 포함), 실제 기기.                                                                                                                          |

### 3. 통합과 초기 JS 줄이기 (2026-10-24)

검증 대상은 `a54fcba8`(두 갈래를 합친 `7af1723b` 위에 줄이기 셋)이다. 환경은 라운드 1과 같다.

| 검사          | 결과와 범위                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 합침          | 두 갈래를 `32a290d2`, `7af1723b`로 합쳤다. 초기 JS 491,726 B로 유지 상한을 158 B 넘었다.                                                                                                                                                                                                                                                                    |
| 정적          | `typecheck`(모든 tsc 프로젝트), `lint`, `format:check` PASS.                                                                                                                                                                                                                                                                                                |
| 단위 전체     | `vitest run` 650 files / 15,122 tests PASS.                                                                                                                                                                                                                                                                                                                 |
| 핵심 커버리지 | `test:coverage:critical` 75 files / 2,855 tests PASS, 파일별 하한 유지.                                                                                                                                                                                                                                                                                     |
| 가드          | dead-exports(테스트 전용 20/20, 자기만 76/76 그대로), bus-pairing(203/203), chunk-pump, import-graph(순환 0), lifecycle-writes, navigation-sinks(393 files, 수치는 R2와 같음), source-complexity, transport-health(12 files, 원시 읽기 1, 소비자 3), `check-resource-ownership`(46 records / 435 files, 타이밍 사본 6·의심 1, 같은 값 쌍 25는 보고만) PASS. |
| 빌드          | `build:checked`는 `guard:sw-cache-version`에서 예상대로 멈췄다(bump 전). 그 앞의 단계와, 뒤의 빌드와 가드(초기 전송 예산, legacy TV Chromium 79, SW 바이트 일치, app-shell 106 자산, prod hooks·보안, 폰트, sitemap, hreflang, ui-kit)를 따로 돌려 PASS. 초기 JS 477,138 B.                                                                                 |
| 독립 리뷰     | 줄이기 셋을 `7af1723b`와 비교했다. 청크 112개, 서비스 워커 목록, 빌드 경고가 같고 정적 간선 변화는 위의 둘뿐이다. 관련 묶음 166 files가 양쪽에서 PASS(4,533 / 4,534 tests). 리뷰 지적 셋은 `c5dd68ab`·`32439cc0`·`b35b95ff`로 반영했다.                                                                                                                     |

### 4. 통합 트리 (2026-10-24)

검증 대상은 `b8bc42c4`(리뷰 정리와 main `b4293768` 합침까지, 이 문서 커밋 바로 앞)다. 환경은
라운드 1과 같다.

| 검사      | 결과와 범위                                                                                                                                                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 손댄 묶음 | 4A가 손댄 테스트와 #478 고정 42 files / 1,631 tests PASS.                                                                                                                                                                                                                                                                   |
| 단위 전체 | `vitest run --maxWorkers=6` 658 files / 15,206 tests PASS, FAIL 0.                                                                                                                                                                                                                                                          |
| 정적      | `tsc --noEmit`, `typecheck:tests`, `lint`, `format:check` PASS.                                                                                                                                                                                                                                                             |
| 가드      | 라운드 3과 같은 수치로 PASS.                                                                                                                                                                                                                                                                                                |
| 빌드      | `npm run build`, `guard:initial-transfer-budget` PASS. 초기 JS 477,138 B, 진입 스크립트 111,597 B, 초기 전체 555,760 B. 이 문서를 쓰며 같은 SHA를 다시 빌드해 청크별 크기가 라운드 3의 줄이기 뒤 값과 같음을 확인했다.                                                                                                      |
| 배포 대상 | 부분 게이트 판정 함수를 로컬에서 돌렸다. 다른 다섯 Worker의 런타임 경로 변경은 R1 `572880a2` 대비 0, App은 R2 `035abaae` 대비 42개 경로, App 운영 의존성 변화 0이다.                                                                                                                                                        |
| SKIP      | 이 SHA의 Playwright(critical E2E, 데모·PRO 입장), 4A 코드의 C5-0 랩, Worker 단위(bump 전에는 `cloudflare/` 변경 없음, 갈래 라운드에서 PASS. bump가 App Worker의 `ADMIN_ASSET_VERSION`을 바꾸므로 bump SHA에서 다시 돌린다), 이 SHA의 `test:coverage:critical`(라운드 3에서 PASS), `build:checked` 전체(bump 전), 실제 기기. |

### 5. 문서 리뷰 정리 (2026-10-24)

검증 대상은 `1320eea6`(registry 허용 예외 RO-48·RO-49와 가드 테스트의 빈 ID, 위 리뷰 정리)이다.
런타임 소스는 `b8bc42c4`와 같다. 환경은 라운드 1과 같다.

| 검사      | 결과와 범위                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 단위 전체 | `vitest run --maxWorkers=6` 658 files / 15,206 tests PASS, FAIL 0.                                                                                                                                                                |
| 가드      | `check-resource-ownership` 48 records / 435 files PASS(타이밍 사본 6·의심 1, 같은 값 쌍 25는 보고만. records 수 말고는 라운드 3과 같음). 그 가드 테스트 37 tests PASS. dead-exports(테스트 전용 20/20, 자기만 76/76 그대로) PASS. |
| 정적      | 바꾼 테스트 파일의 `eslint`와 `prettier --check`, 바꾼 문서 넷의 `prettier --check` PASS.                                                                                                                                         |
| SKIP      | 라운드 4의 SKIP과 같다. 런타임 소스가 바뀌지 않아 빌드와 초기 전송 예산은 다시 돌리지 않았다.                                                                                                                                     |

### 6. bump 뒤 최종 검증과 배포

| 검사                  | 결과와 범위                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 로컬 최종(`8a9e1772`) | unit 658 files / 15,206, Worker 60 / 2,908, critical coverage 75 / 2,855(모든 하한), typecheck·`check:workers`·lint·format·`build:checked` 전체, 가드 묶음, critical E2E 61/61, C5-0 랩 16/16(두 번 반복, flaky 0), 기본 Playwright 목록 722 tests / 104 files(랩 없음). 초기 JS 477,114 B.                                         |
| PR #479 CI·리뷰       | PR head CI 통과, Codex 리뷰 지적 없음. squash 머지 `aededf3c`(트리는 `8a9e1772`와 같음).                                                                                                                                                                                                                                            |
| exact-main CI         | [40100871405](https://github.com/hiefny/MUSIXQUARE/actions/runs/40100871405). attempt 1에서 Critical browser gate의 `screensaver.test.ts:1074`(저음 반응 289 ms > 220 ms) 하나가 실패했다. 4A가 닿지 않는 경로이고 PR CI와 로컬에서는 통과해 실패 작업만 다시 돌렸고 attempt 2에서 통과했다. 후보는 attempt 1 artifact 12562623025. |
| Release 1             | [40101887540](https://github.com/hiefny/MUSIXQUARE/actions/runs/40101887540) 실패·자동 복구. App `8d7ca12e` 배포 뒤 Standard HTTPS signaling smoke가 `HTTP 503 RATE_LIMIT_UNAVAILABLE`(호스트 브리지). App을 R2 `47df5afa`로 되돌리고 최종 경계 verified.                                                                           |
| Release 2             | [40102311205](https://github.com/hiefny/MUSIXQUARE/actions/runs/40102311205) attempt 1 성공. App `1afafcdd`, 23:26:03 KST 소유권 verified, smoke success(`bridgeOpenMs` 방장 844ms·게스트 427ms), generation `main-BFojFck4.js` 365,196 B·33 assets.                                                                                |
| 운영 확인             | 공개 GET `/` 145,216 B(`bootstrap.js?cache=v778`), `/service-worker.js` 39,517 B(`CACHE_VERSION = "v778"`). 데스크톱 Chromium 방 밖: 새 탭 대화상자, 나중에, 적용하기 한 번, 캐시 v778만, 옛 9.0.6 탭 셋 자동 새로고침.                                                                                                             |
| Drift Audit           | [40102714167](https://github.com/hiefny/MUSIXQUARE/actions/runs/40102714167) automated-checks-passed: 31 pass / 0 fail / 5 manual-only.                                                                                                                                                                                             |

로컬 결과는 exact-main-SHA CI 후보를 대신하지 않았다. 실제 기기 확인은 release-record §2에 열려 있다.

## 초기 JS 예산

실제 프로덕션 빌드로 잰 값(gzip, `measureInitialTransfer`)과 유지 상한까지의 여유다. 상한은 초기
JS 491,568 B(517,440 B의 95%), 초기 전체 570,570 B(600,600 B의 95%), 진입 스크립트 461,890 B다.

| 트리                             | 초기 JS   | 여유     | 진입 스크립트 | 초기 전체   |
| -------------------------------- | --------- | -------- | ------------- | ----------- |
| main `fa256db2`(9.0.6 / v777)    | 491,481 B | 87 B     | 126,122 B     | 570,109 B   |
| 두 갈래 합침 `7af1723b`          | 491,726 B | −158 B   | 125,755 B     | 570,349 B   |
| `4103d42e` PRO API 오류 잎       | 479,642 B | 11,926 B | 113,660 B     | (재지 않음) |
| `61187df3` 활성 업로드 대기열 잎 | 477,576 B | 13,992 B | 111,600 B     | (재지 않음) |
| `a54fcba8` Opus 스테레오 SDP 잎  | 477,138 B | 14,430 B | 111,597 B     | 555,760 B   |
| 통합 트리 `b8bc42c4`             | 477,138 B | 14,430 B | 111,597 B     | 555,760 B   |

raw 값은 진입 스크립트 423,152 → 422,013 → 365,196 B, 초기 전체 2,130,277 → 2,130,974 →
2,073,212 B(main, 합침, 통합 트리)다. 갈래 안에서 잰 증분별 초기 JS는 네트워크 갈래가 C5-1
491,466 B(−15), C5-2 491,480 B(+14), C5-3 491,654 B(+174), C5-5 491,840 B(+186), `9d7ee20a`
491,892 B(+52), C5-4 491,900 B(+8), `9a0fea2a` 491,911 B(+11)이고, 출력 재합류 갈래가 I8a
491,310 B(−171), C3-I1 491,319 B(+9)다. 죽은 상태 삭제는 게으른 방 기능 청크만 51 B 줄였다.

줄이기는 바이트를 없앤 것이 아니라 게으른 청크로 옮긴 것이다. 합침(`7af1723b`)에서 통합 트리까지
게으른 청크는 PRO 런타임 39,472 → 49,654 B(+10,182), `system-audio-service` 21,779 → 25,463 B
(+3,684), `system-audio-sfu` 8,450 → 8,898 B(+448)로 커졌다. 경로마다 받는 JS(gzip 합, 캐시 없음)는
다음과 같다. 초기 JS에 그 경로가 기다리는 동적 import(`prepareRoomSessionFeatures`의 방 기능
런타임과 flight recorder, PRO 런타임, 데모 런타임)의 정적 닫힘 가운데 초기 묶음 밖 청크를 더했다.

| 경로                                                | 합침 `7af1723b` | 통합 트리 `b8bc42c4` | 차이      |
| --------------------------------------------------- | --------------- | -------------------- | --------- |
| 첫 화면(초기 JS)                                    | 491,726 B       | 477,138 B            | −14,588 B |
| 일반방 입장(방 기능 런타임·flight recorder, 청크 8) | 538,075 B       | 527,638 B            | −10,437 B |
| PRO 방 입장(위에 PRO 런타임, 청크 9)                | 577,547 B       | 577,292 B            | −255 B    |
| 가이드 데모(데모 런타임·flight recorder, 청크 5)    | 512,089 B       | 497,512 B            | −14,577 B |

PRO 방 입장은 거의 같고, PRO가 아닌 경로는 PRO 코드를 더 받지 않는다. 청크 목록과 서비스 워커
앱 셸 목록이 같아 오프라인 설치가 받는 파일은 그대로다(바이트는 옮긴 만큼 청크 사이에서 바뀐다). Phase 4 4A의 순 변화는 491,481 → 477,138 B(−14,343 B)로, 로드맵의 'Phase당
순 +200 B'와 '프로그램 순 0 이하'(시작점 489,199 B) 목표 안이다. 아키텍처 상한, 5% 예비, 진입 상한,
첫 로딩 글꼴 0은 그대로다. bump 뒤(`8a9e1772`) 프로덕션 빌드를 두 번 재면 초기 JS 477,114 B(유지 상한까지 14,454 B), 진입
111,585 B, 초기 전체 555,735 B로 같았다(버전 문자열과 청크 해시로 −24 B). 정책 문서의
[2026-10-24 덧붙임](initial-bundle-loading-policy.md#2026-10-24-phase-4-train-4a-startup-leaves-addendum)에
같은 표가 있다.

## 배포·회복

**배포 대상.** target `app`, Developer API D1 `false`. 4A는 App 런타임 입력(`src`,
`vite.config.ts`, bump 때의 `package.json`·App Worker·SW 캐시·`index.html`)만 바꾼다. `cloudflare/`에서
바뀌는 것은 bump의 App Worker `ADMIN_ASSET_VERSION` 한 줄뿐이다.
운영 배포 기록을 기준으로 부분 게이트 판정(`release-deployment-state.mts`의
`runtimePathsForWorker`·`changedRuntimePaths`·`changedAppRuntimeDependencies`)을 로컬에서 돌리면 PRO
room, remote-share, signaling, Developer API facade, Developer API의 런타임 경로 변경이 R1
`572880a2` 대비 모두 0이다. App은 R2 `035abaae` 대비 42개 경로가 바뀌고 운영 의존성 변화는 없다.
실제 게이트는 Production Release가 운영 배포 기록을 읽어 다시 판정한다. 업데이트 창이 뜨는 배포이고
오너가 배포를 맡겼다. exact-main CI 후보는 배포 직전에 확인한다. 새 D1 스키마·비밀·바인딩·통신
형식은 없다. `ci.yml`의 새 `guard:transport-health` 단계는 릴리스 워크플로 밖이다.

**혼합 버전**(known-accepted #13, 버전 입장 제한 없음).

- 9.0.6 방장과 9.0.7 게스트, 9.0.7 방장과 9.0.6 게스트: 통신 형식이 같아 같은 프레임을 주고받는다.
  원인 줄은 각 기기의 로컬 로그에만 생긴다. 9.0.7 방장의 콘솔에는 9.0.6 게스트의 닫힘도 방장 쪽
  판단의 원인 줄로 남고, 9.0.6 기기에는 원인 줄이 없다.
- 보조 연결: 상대에게 강제되는 `RESTART_WINDOW_MS`·`RESTART_CAP_MS`를 리터럴로 둬 두 끝의 재시작
  요청·offer 한도가 같다. 옛 빌드 쪽 모양을 고정한 `control-isolation-c9.ts`를 쓰는
  `control-isolation.test.ts`가 그대로 통과한다.
- 파일·데모 시작: 옛 수신자를 위한 리드(PLAY 200 ms, DEMO_PLAY 350 ms)와 데모 시작 값이 같아,
  늦게 들어온 게스트가 받는 PONG도 같은 값을 싣는다.
- PRO: 게으른 청크의 구성만 바뀌고 PRO 통신, PRO 런타임 동작, PRO 재시도 간격은 그대로다.
- 업데이트: 4A는 업데이트 기계를 바꾸지 않는다. 배포 전부터 열린 9.0.6 탭과 배포 뒤 새로 연
  9.0.7 페이지가 같은 R2 기계로 v778을 적용하고, 다음 문서 표지는 그대로다.

**되돌리기.** 코드 되돌리기가 기본이다. revert도 더 높은 SemVer와 캐시 epoch로 다시 배포하고, 4A
열차가 되돌리기 단위다([hotfix-procedure.md](../hotfix-procedure.md)의 Rollback). 급할 때의
Cloudflare App 버전 되돌리기는 9.0.6(R2)이나 9.0.5(R1)로 할 수 있다. 둘 다 PRO 입장 정책 계약
표지(`pro-room-optional-entry-password-v1+pro-owner-transfer-pinless-v1`, 9.0.4부터)를 가져 표지가
유지되고, 9.0.4 아래로는 안 된다. 4A는 동작이 같으므로 9.0.6으로 되돌려도 사용자에게 달라지는 것은
원인 줄이 없어지는 것과 첫 로딩 크기뿐이다. 9.0.5로 되돌리면 R2(로고 재설정)도 함께 되돌아간다.
새 D1·비밀·저장 데이터 마이그레이션은 없다.

**4A 실기기·운영 확인(대기).**

- 4A 배포 뒤 기기 라운드: 결과 전에 고정한 블라인드 절차로 #18 보조 연결 ICE 재시작(와이파이→LTE)과
  회귀(와이파이 복귀, 같은 공유기의 다른 SSID, 원격 LTE 게스트가 와이파이로), 미리받기 재개, QA036
  원격 게스트, QA040 연결 생존, QA007 YouTube·로컬 복귀, 홈 화면 앱을 iPhone Safari·Android
  Chrome 게스트와 Windows Chrome 방장으로 잰다. 기준선을 4A 위에서 처음 재므로 4A 전후 비교는 없고,
  이 값이 4B의 비교 기준이 된다.
- 창으로 끝나는 단계마다 방장 콘솔(`?mxqrLog=info`)에 그 게스트 PeerID의 원인 줄이 하나 있는지,
  그 토큰이 미리 고정한 단계별 허용표 안인지 본다. 허용표는 결과를 본 뒤 넓히지 않는다.
- 4A 코드로 아직 실행하지 않은 것: 운영 Cloudflare 전송 경로의 원인 줄, iOS Safari와 홈 화면 앱,
  브라우저의 PRO 방(입장, 업로드 대기열, 시스템 오디오. 옮긴 잎 모듈이 지나는 경로), C5-0 랩.
- CI: exact-main 후보, 브랜치 push 뒤 `e2e.yml`의 WebKit 레인.

**4B 입력(결정 대기).** C5-6·C5-7·C5-8은 #18과 미리받기 재개의 기기 근거 뒤에 다시 정한다. P4-D10은
F4 근거(단위 재현, 랩 17초 재현, 10초 미재현)로 어느 레인이 이길지 정한다. 경로 재시도 장벽과 PRO
epoch 닫힘 이름 불일치는 고칠지 허용할지 묻는다. P4-D7~P4-D9의 좁은 수정은 기기 근거(YouTube 복귀
단계와 PRO 청취자 단계)와 함께 다시 묻는다. 4B는 4A 기기 라운드가 깨끗하고 4A 배포 7일 뒤
이후에 낸다(P4-D3 A, P4-D13 A).

운영 데이터나 서비스에 장애를 주입하는 검사는 이번 로컬 검증에 포함하지 않았다.

관련 계약: [자원 소유권](resource-ownership-registry.md),
[실시간 런타임 소유권](realtime-runtime-ownership.md),
[재생 동시성 불변식 C13](playback-concurrency-invariants.md),
[신호 생존과 복구](signaling-liveness.md), [첫 로딩 정책](initial-bundle-loading-policy.md),
[현재 릴리스 기록](../release-record.md).
