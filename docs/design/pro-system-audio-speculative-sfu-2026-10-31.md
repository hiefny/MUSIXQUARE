# PRO 시스템 오디오 SFU 대체를 LAN-direct 시도 옆에서 미리 깔기 (미디어 보류, 2026-10-31)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 구현과 로컬 QA 라운드 1 끝, 브랜치 `agent/spec-sfu`(로컬만). PR 전, 미병합·미배포. 버전 올리기(bump)는 없다: 9.0.28 / 다음 SW 캐시 epoch는 9.0.28 열차의 마지막 런타임 커밋이 따로 올린다                                                                                                                                                                                                                                                     |
| Base               | `agent/app-9-0-27-rebuild`의 끝 `3042b015`(9.0.27 / v800 열차, 버전 올리기 `676a1670` 뒤 문서·시험 커밋). 곧 main에 들어갈 9.0.27 squash와 같은 트리라 이 브랜치는 나중에 충돌 없이 main 위로 옮길 수 있다                                                                                                                                                                                                                                  |
| Commits            | 테스트 먼저 `1b2be559`(시험만, 부모에서 29행 실패), 런타임 `17002160`(두 파일), 이 문서와 RO-20·아키텍처 문서 커밋                                                                                                                                                                                                                                                                                                                         |
| Scope              | PRO 시스템 오디오 공유자의 첫 발행 순서만. `src/network/pro-system-audio-sfu.ts`(보류 발행, 보류 풀기, 진단 줄)와 `src/pro-room/system-audio-service.ts`(`publishLocalProSystemAudio`의 호출 순서). 청취자 코드, LAN-direct 전송(`pro-system-audio-direct.ts`), 서버, 시그널링, 발행 서술자 모양은 그대로다. 화면 글자와 배치는 바뀌지 않는다([화면 그대로]; 바뀌는 것은 소리가 나오는 시각뿐)                                              |
| Deploy target      | `app`(App 런타임 두 파일). Worker 배포, 계약 표지, App 빌드 바닥(RO-50), 호환 경계 변경 없음                                                                                                                                                                                                                                                                                                                                               |
| Operations         | 운영 요청, 프로덕션 요청, GitHub 쓰기 없음(push, PR, 배포 없음). 시간은 실제 서비스·SFU·LAN-direct 모듈을 묶어 돌린 Chromium 하네스(로컬 루프백, Cloudflare는 가짜)의 측정이다                                                                                                                                                                                                                                                              |
| Resource ownership | 새 레코드, 색인 행, 가드 기준값 없음. RO-20이 이 수명의 주인이고, 이 변경은 그 publish 동작을 같은 SFU 발행자 싱글턴 위에서 넓힌다(두 번째 기계 없음). RO-20의 Resource, Current owners/flows, Deadline owner, Anchor tests를 같은 변경에서 고쳤다. 새 타이머, 재시도, 시간 값은 없고 보류 발행은 기존 `SFU_CONTROL_REQUEST_TIMEOUT_MS`(집 `src/network/system-audio-media.ts`) 아래에서 돈다. `node scripts/check-resource-ownership.mts` 통과(개수 변화 없음) |

## 오너 결정 (2026-10-31)

SFU 대체 대기를 줄이는 질문에 오너가 '두 단계'로 답했다. 9.0.27은 iPhone 청취자의 LAN-direct 쌍 판정과
`no-lan-candidate`의 이른 대체를 내고, 9.0.28은 이 변경(SFU 추측 발행, 미디어 보류)을 더한다. 오너는 그 결과도 받아들였다:
LAN-direct가 성공한 공유도 Cloudflare Realtime 발행 세션 하나를 잠깐 열었다가 닫는다(미디어는 0). 그래서
`pro-system-audio-sfu.ts`의 'LAN 성공은 SFU 세션 비용이 없다'는 약속(preflight 주석)과 서비스의 같은 주석, 아키텍처
문서의 문장을 이 변경에서 바꿨다. 비교한 다른 안(SFU 먼저 틀고 직결로 바꾸기, 시간 상한 등)과 그 수치는
[9.0.27 열차 보고서](app-9-0-27-train-2026-10-30.md)의 오너 질문 항목과 비공개 작업 노트에 있다.

## 원인

9.0.27까지 공유자는 LAN-direct 시도가 실패한 **뒤에야** SFU 발행(`publishProSystemAudioSfu`)을 시작했다. 9.0.26 현장
줄로 보면 그 발행(새 세션, 트랙 요청, SDP)이 약 1.7~3초 걸렸고(P), 그래서 직결이 끝내 안 되는 공유의 커밋은 'LAN 결정
시각 F + P'였다. 직결 시도와 SFU 발행은 서로 기다릴 이유가 없다. 같은 시각에 시작하면 커밋은 대략 'max(F, P)'가 된다.

## 바뀐 것

### 전송 (`src/network/pro-system-audio-sfu.ts`)

1. `publishProSystemAudioSfu`가 `holdMedia`를 받는다(없으면 예전 그대로; 승격 경로는 쓰지 않는다). 보류 발행은 예전과
   같은 송신기(`addTransceiver(track, sendonly, 같은 스트림)`), 같은 SDP와 같은 Realtime 요청으로 협상하되, 제안 전에
   `replaceTrack(null)`로 송신기 트랙을 비운다. LAN-direct 송신기가 증명 전까지 소리를 잡아 두는 방식(`pro-system-audio-direct.ts`)과
   같다. 협상 전의 `replaceTrack(null)`은 재협상이 필요 없고, 트랙 없는 송신기는 RTP를 보내지 않는다. 보류 중에는 송신기
   조정(`tuneSystemAudioMusicSender`)도 하지 않아 LAN-direct가 성공한 공유는 캡처 트랙에 손대지 않는다.
2. 보류 발행이 준비되면 `published` 사건 없이 서술자만 돌려주고 info 한 줄을 남긴다. 실패·정지 사건에는 서술자를 싣지
   않는다. 그래서 서비스의 `failedSfuPublisherSessionId`는 커밋되지 않은 세션을 이름으로 가질 수 없고, 보류 세션이 재확인
   타이머나 `recoverLocalPublisher`를 부를 길이 구조적으로 없다.
3. 새 내보내기 `releaseProSystemAudioSfuPublisherHold(descriptor)`: 지금의 **준비된** 보류 발행이고 서술자 키가 같을 때만
   원래 캡처 트랙을 붙이고(`replaceTrack(track)`), 송신기를 한 번 조정(음악 제약 셋, 256 kbps 상한, 같은 집과 같은 함수)한
   뒤 바뀌지 않은 `[ProSysAudioSFU] Published generation N` 줄과 `published` 사건을 낸다. 정지·실패·대체된 발행, 아직
   준비 중인 발행, 끝난 캡처 트랙은 거절한다(`PRO_SFU_FALLBACK_UNAVAILABLE` 또는 트랙 검사의 TypeError). 다른 발행의
   송신기는 건드리지 않는다. 보류 송신기가 트랙을 받는 곳은 여기 하나다.
4. 정리는 그대로 한 곳(`stopPublisherInternal`)이다: 시대(epoch) 올리기, 진행 중 요청 중단, `pc.close()`, 요청한 트랙의
   `tracks-close`(force).

### 서비스 (`src/pro-room/system-audio-service.ts`, `publishLocalProSystemAudio`)

직결 대상이 있는 공유에서(대상 0인 공유는 예전 그대로 SFU를 쓰지 않는다):

1. LAN-direct 시도를 먼저 시작한다(동기 거절과 거부도 'LAN 없음'으로 바꾼다).
2. 같은 차례에 공유당 한 번인 SFU 시도를 보류로 시작한다(`startHeldSfuPublication`, 임대 시도의 preflight를 쓴다). 그
   결과는 곧바로 데이터(`{ ok, descriptor | error }`)가 되어, LAN-direct가 성공해 아무도 기다리지 않아도 처리 안 된 거부가
   생기지 않는다.
3. LAN-direct가 증명되면 보류 발행을 멈추고(`stopProSystemAudioSfuPublisher`) 9.0.26과 같은 lan-direct 커밋을 보낸다.
   멈춤이 커밋보다 먼저다.
4. LAN-direct가 실패하면 보류 발행을 기다린 뒤(보통 이미 준비됨) 비행 소유권을 확인하고, 보류를 풀어 트랙을 붙인 다음 그
   서술자를 커밋한다. 커밋은 송신기가 트랙을 가진 뒤에 나간다(예전과 같다). 보류 발행이 실패했으면 공유가 실패한다(예전의
   실패한 SFU 발행과 같은 결과, 같은 정리, 같은 알림).
5. 그 뒤는 그대로다: 커밋, `settleCanonicalSfuPublisher`(임시 만료를 서버의 `liveExpiresAt`으로 바꿈), 활성화, 하트비트.

### 정리 경로 (새 정리 코드 없음)

보류 발행은 SFU 발행자 싱글턴이므로 모든 정리 입구가 예전처럼 `retireLocalMedia`로 멈춘다: 명시적 정지, 임대 상실(다른
주인, 다섯 번째 기기 포함), 새 presence 인스턴스, 서비스 초기화(방 나가기, pagehide), 실패한 발행, 끝난 발행자 복구.
PRO 방 문맥을 떠날 때는 예전처럼 발행자를 남기고, 비행은 예전의 순차 발행과 같은 결과(조금 더 일찍)로 끝난다. 묵은
비행은 소유권 확인에 걸려 후속 비행의 보류를 풀지도 멈추지도 않고, 풀기 자체도 지금의 준비된 보류가 아니면 거절한다.
그냥 숨겨진 페이지는 아무것도 정리하지 않는다(예전처럼 공유는 배경에서 계속). 남는 것: `new-session` 응답 전에 중단되면
이 클라이언트가 붙지 않는 트랙 없는 Realtime 세션 객체가 남는다(Realtime v1에는 세션 닫기가 없다; 지금도 중단된 발행이면
똑같다).

### 진단 줄 (모두 `log.info`, 인자 하나, IP·방 코드·세션 id·트랙 이름·토큰·전체 참가자 id 없음)

- `[ProSysAudioSFU] Prepared SFU fallback for generation N in T ms`: 보류 발행 준비 끝(T는 보류 발행 시작부터, 즉 나란히
  잰 P).
- `[ProSysAudioSFU] Published generation N`: 글자 그대로. 보류 경로에서는 풀기에서, 커밋 바로 앞에 나온다. 승격 경로는
  예전처럼 발행에서 나온다. 기기 기준은 여전히 '이 공유는 SFU로 갔다'로 읽는다.
- `[ProSysAudioSFU] Closed unused SFU fallback for generation N (open T ms)` 또는
  `(before it was prepared, T ms after the start)`: LAN-direct 성공이나 창 안의 정리로 쓰이지 않고 닫힘.
- `[ProSysAudioSFU] SFU fallback for generation N failed after T ms (<오류 이름|connection-failed|capability-cancelled>)`:
  보류 발행 실패. 메시지는 싣지 않는다(Cloudflare 오류 글에 id가 있을 수 있음). 오류 이름 목록은 구독 실패 줄과 같은
  허용 목록(`FAILURE_NAMES`)이다.

새 줄은 증거 정규식 `/Published generation|Promoted LAN-direct publication/`에 걸리지 않아 9.0.27의 'direct (presumed)'
판정은 뜻이 그대로다. 9.0.28 기기 기준은 'LAN 통과에서 Prepared/Closed unused 줄은 있어도 된다'를 더한다.

## 서버가 보는 것과 비용

- PRO 방 Durable Object: 요청과 본문이 그대로다. 공유당 임대 하나, 커밋 하나. LAN 성공이면
  `{ publicationId, transport: 'lan-direct', protocolVersion: 2 }`가 9.0.27과 같은 시각에, LAN 실패면
  `{ publicationId, sessionId, track: { trackName, mid } }`가 F + P 대신 약 max(F, P)에 간다. 추측 세션 id는 커밋 전에는
  DO, 방 상태, 무효화 방송, 청취자 어디에도 가지 않고, 커밋되지 않은 것은 끝까지 가지 않는다. 시스템 오디오 커밋은 멱등 영수증을
  쓰지 않아(RO-53 범위 밖) 256칸 장부는 그대로이고, 45초 준비 claim에는 더 일찍 닿으며, 2시간 SFU 예산은 여전히 커밋에서
  시작한다.
- 시그널링 중계: LAN-direct 제안·응답·후보·닫기 그대로.
- App Worker: `/api/get-turn-config`는 공유당 한 번(임대 시도의 preflight가 이제 LAN 성공에서도 취소되지 않고 쓰인다).
  `/api/cloudflare-realtime`의 `new-session`과 `tracks-new`는 LAN 실패 뒤가 아니라 LAN 시도와 함께 시작한다. LAN 성공이면
  트랙을 요청한 뒤일 때 `tracks-close`(force) 하나가 더 간다. 모두 기존 묶음 능력 토큰 아래라 새 Turnstile이나
  작업증명 UI는 없다.
- LAN 성공 공유당 Cloudflare 비용: Realtime `new-session` 하나(LAN 증명이 응답을 중단해도 세션 객체는 생긴다), 증명이
  `new-session` 응답 뒤에 오면 `tracks-new`와 `tracks-close` 하나씩, 원격 설명 적용 뒤에 오면 ICE/DTLS(와 preflight 서버의
  TURN 할당). 어느 경우든 RTP는 0이다(송신기에 트랙이 한 번도 없었다). 세션은 LAN 시작부터 증명까지, 최대 LAN 창(응답 2초 +
  증명 1초 = 3초) 동안 산다. 현장에서는 증명(약 0.5~1.5초)이 보통 P(1.7~3초)보다 앞서 발행 중간에 버려진다. Realtime과
  TURN은 공개 요금표상 나가는 바이트로 매기므로 예상 요금은 거의 0이지만, 미디어 0 세션의 청구는 확인하지 않았다.
- Worker 예산: LAN 성공 공유도 `new-session` 하나를 쓴다(`REALTIME_NEW_SESSION_PER_CAPABILITY_LIMIT` 능력 토큰당 60초 4회,
  `ROOM_BURST_REALTIME_NEW_SESSION_LIMIT` IP당 60초 250회). `tracks-new`/`tracks-close`는 변경 한도(토큰당 12, 세션당 8,
  60초) 안이다.

## 섞인 버전

청취자 코드는 그대로이고 커밋 모양, 발행 id, 세대, 시간 필드가 9.0.26/9.0.27과 같다. 그래서 9.0.26·9.0.27 청취자는 예전처럼
구독한다(SFU일 때 더 일찍). 9.0.26·9.0.27 공유자와 9.0.28 청취자는 지금과 같다. 시험: 청취자 쪽 계약 묶음
(`system-audio-receive-slot-pro-contract`, `-pro-transport-contract`)은 바뀌지 않고 통과한다.

## 측정 (Chromium 하네스, 공유 시작에서 SFU 커밋까지)

방법. bound-wait 하네스(실제 LAN-direct 모듈을 두 페이지에서 돌림)를 넓혀, 공유자 페이지에 **실제** 서비스
(`publishLocalProSystemAudio`), 실제 컨트롤러, 실제 PRO SFU 발행자와 LAN-direct 전송을 묶었다(이전 = 부모 `3042b015`,
이후 = 이 변경; LAN-direct 모듈은 두 트리에서 바이트로 같다). 방 API는 바로 답하는 가짜이고 커밋 요청 시각을 적는다.
Cloudflare는 `fetchWithCapability` 뒤의 가짜다: TURN은 바로 404(공개 STUN으로), `new-session`은 P/2 뒤, `tracks-new`는
실제 로컬 RTCPeerConnection이 만든 답(스테레오 강제)으로 P/2 뒤에 답한다. 그래서 공유자의 실제 제안, 로컬·원격 설명,
`replaceTrack` 호출이 모두 돈다. P는 9.0.26 현장 줄의 1.7~3초로 모형화했다. 청취자 페이지는 실제 LAN-direct 수신자이고,
신호 지연은 bound-wait와 같다(제안 650 ms, 나머지 100 ms). Chromium 153, 반복 3회(LAN 성공 P=1000은 2회).

경우: lan(청취자가 공유자의 mDNS host를 바로 풀어 LAN-direct 증명), never(청취자 원장은 후보를 더하지만 libwebrtc는 끝내
받지 못해 쌍이 정제되지 않음: 증명 창 끝에 실패), numeric-pub(공유자가 카메라 권한을 가져 LAN 후보가 없음:
`no-lan-candidate`로 일찍 실패).

| 경우                    | P(ms) | LAN 결정(이전 / 이후) | 커밋 이전(ms) | 커밋 이후(ms) | 줄어든 시간(회별)  | 전송       |
| ----------------------- | ----- | --------------------- | ------------- | ------------- | ------------------ | ---------- |
| never (끝내 정제 안 됨) | 1700  | 1808-1815 / 1815-1823 | 3528-3530     | 1816-1825     | 1705-1712          | sfu        |
| never                   | 3000  | 1814-1817 / 1804-1814 | 4832-4841     | 3027-3044     | 1788-1812          | sfu        |
| numeric-pub             | 1700  | 143-164 / 142-170     | 1859-1874     | 1736-1743     | 116-138            | sfu        |
| numeric-pub             | 3000  | 140-142 / 144-152     | 3161-3175     | 3031-3033     | 130-142            | sfu        |
| lan                     | 1700  | 810-844 / 815-828     | 810-845       | 816-829       | -6~25 (잡음)       | lan-direct |
| lan                     | 3000  | 810-816 / 816-840     | 810-817       | 817-841       | -24~-5 (잡음)      | lan-direct |
| lan                     | 1000  | 813-816 / 814-815     | 813-816       | 815-817       | -4~1 (잡음)        | lan-direct |

- SFU로 끝나는 공유는 커밋이 F + P에서 max(F, P) + 몇 ms로 왔다. 줄어든 시간은 min(F, P)다: 끝내 정제 안 되는
  경우 1.70~1.81초(판정 모형 1.5~1.9초 안), `no-lan-candidate` 경우 0.12~0.14초(그때는 F가 짧다). 보류 풀기(트랙 붙이기와
  조정)는 LAN 결정 줄 뒤 1~9 ms다.
- LAN 성공 커밋 시각은 이전과 같다(차이 -24~+25 ms, 반복 사이 잡음 폭 안). 보류 발행과 나란히 돌아도 LAN 증명이 늦어지지
  않았다.
- LAN 성공의 Cloudflare 요청(이후): P=1700·3000에서는 `new-session` 하나만(증명 약 0.82초가 P/2 응답보다 앞서 중단,
  'Closed unused … before it was prepared'), P=1000에서는 `new-session`, `tracks-new`, `tracks-close` 하나씩(증명이 트랙
  요청 중에 와서 요청한 mid를 force로 닫음). 어느 경우도 커밋이나 `Published` 줄은 없다.
- 현장 환산: 9.0.27 현장 모양(F 약 1.9초)이면 SFU로 끝나는 공유가 첫 소리까지 약 1.5~1.9초 빨라진다. 청취자 구독(약
  5.4~6.3초)은 그대로라 끝내 정제 안 되는 공유의 첫 소리는 약 9.7~10.8초(9.0.26보다 1.1~1.5초 빠름)로 본다. 하네스는
  로컬 루프백이고 P는 모형이다.

하네스 스크립트와 결과 줄은 저장소 밖 작업 노트에 있다.

## 사용자가 알아챌 것

- 화면: 바뀌지 않는다. 버튼, 문구, 토스트, 배치 그대로다.
- 소리: LAN-direct가 안 붙는 공유(같은 Wi-Fi에서 직결이 안 되는 기기, 원격 청취자, 게스트 Wi-Fi 등)에서 소리가 약
  1.5~1.9초 빨리 나온다. LAN-direct가 붙는 공유는 지금과 같다.
- 보이지 않는 차이: LAN-direct가 성공한 공유도 Cloudflare에 소리 없는 발행 세션을 잠깐 열었다 닫는다(오너가 받아들임).

## 위험과 막는 법

- **소리 두 번.** 보류 송신기는 LAN 실패 가지에서 소유권 확인 뒤 부르는 풀기에서만 트랙을 받는다. LAN 성공이면 lan-direct
  커밋 전에 멈추고 그 세션 id는 아무도 모른다. LAN 실패면 시도가 이미 직결 세션을 닫았다('fallback' 닫기). 고정:
  서비스 행(LAN 성공은 풀기 없음, 멈춤이 커밋보다 먼저), 증거 행(LAN 성공의 `replaceTrack` 기록이 `[null]`뿐).
- **커밋 전 추측 발행 노출.** 서술자는 커밋 요청 전까지 기기 밖으로 나가지 않는다. 보류 경로는 `published`를 내지 않고
  실패·정지 사건에 서술자가 없다. 새 줄에는 세션 id, 트랙 이름, 방 코드, 토큰이 없다. 고정: SFU 행.
- **세션 누수.** 새 정리 코드 없이 모든 경로가 싱글턴 정지에 닿는다(진행 중 요청 중단, 요청한 트랙 닫기, 연결 닫기). 묵은
  비행은 후속 비행을 건드리지 못한다. 남는 것은 위 '정리 경로'의 `new-session` 중단 경우다. 고정: 정리 행(창 안의 각 입구),
  서비스 행(정지, 풀기 중 정리, 묵은 비행), SFU 행(준비 전 정지, 풀기 거절).
- **묵은 `failedSfuPublisherSessionId`나 커밋 안 된 세션의 복구.** 보류 발행은 서술자 없이 실패·정지를 알린다. 고정: SFU
  연결 실패 행, 서비스의 'LAN 증명 시 실패한 보류 무시' 행.
- **처리 안 된 거부.** 보류 결과를 시작 때 데이터로 바꾸고, 동기 검사 실패도 데이터로 바꾼다(preflight 취소). Vitest가 처리
  안 된 거부에서 실행을 실패시키므로 LAN 성공 행들이 회귀를 잡는다.
- **LAN 창 안에서 잃은 보류 발행.** ICE 실패나 실패한 요청은 LAN 실패 때 공유를 실패로 끝낸다(지금은 발행에서 커밋까지의
  더 짧은 창에서 ICE가 실패하면 죽은 세션을 커밋한 뒤 복구한다). '공유당 한 번, 새 재시도 없음'으로 받아들였다. 창은 최대
  3초이고 실패는 이름으로 남으며, 캡처는 기존 `pro_publish_failed` 알림을 보인다.
- **Worker 요청 한도.** LAN 성공 공유도 `new-session` 하나를 쓴다. 한 브라우저가 공유를 빠르게 되풀이하면서 승격·복구·구독까지
  겹치면 보류 발행이 429를 받을 수 있다. LAN 성공에는 영향이 없고, LAN 실패면 오늘의 429 SFU 발행처럼 실패한다(줄:
  `… failed after N ms (Error)`). 서버 변경은 없다.
- **트랙 없이 협상한 뒤 최대 약 3초 늦게 RTP가 시작되는 push 트랙**(`replaceTrack(null)` 뒤 `replaceTrack(track)`)을
  Cloudflare가 어떻게 다루는지는 지금 코드 어디서도 겪지 않았고, 운영·실기기 요청 없이는 확인할 수 없다. 배포 전 확인:
  청취자를 Wi-Fi 밖에 두어 SFU로 가게 한 기기 QA 공유에서 공유자의 Prepared와 Published 줄, 청취자의 'Subscription to
  generation … ready'와 들리는 소리. 실패하면 소리 두 번이 아니라 기존 청취자 재시도와 알림으로 드러난다.
- **보류 SFU 연결과 LAN-direct 경로의 경합.** 판정 하네스 추정 2~10 ms. 이 하네스의 LAN 성공 커밋 시각 차이도 잡음 폭
  안이었다. LAN 시도가 같은 차례에 먼저 시작하고 그 시한은 그대로다. QA는 'LAN route … proven in N ms'를 9.0.27과 견준다.
- **캡처 트랙 조정.** 보류 송신기는 풀 때만 조정하므로 LAN 성공 공유는 캡처 트랙과 LAN 송신기가 9.0.27과 같다. 비트레이트
  상한은 소리가 시작된 몇 ms 뒤에 걸린다(변형된 제안이 이미 `maxaveragebitrate`를 싣는다).
- **기기 증거 읽기.** `Published generation`은 첫 SFU 경로에서 커밋 바로 앞의 풀기를 뜻하게 되고, LAN 통과에 새 줄 둘이
  나온다. 글자는 그대로이고 새 줄은 증거 정규식에 안 걸린다.

## 시험 (테스트 먼저)

테스트 먼저 커밋 `1b2be559`(시험만)는 부모 `3042b015`에서 29행이 실패하고(새 행과 새 계약을 적은 고친 행), 나머지 141행은
통과했다(같은 다섯 파일). 실패 이유는 모두 의도한 것이다: 보류 발행이 없음(`holdMedia` 무시, 시도 대기 중 발행 없음),
`releaseProSystemAudioSfuPublisherHold` 없음, 새 줄 없음, `stopped`·`failed`가 서술자를 실음, 창 안의 정지가
`OPERATION_SUPERSEDED` 대신 발행 오류로 끝남.

- `src/network/__tests__/pro-system-audio-sfu.test.ts` 'PRO system-audio SFU held fallback' 7행: 보류 협상(제안 전
  `replaceTrack(null)`, 조정 없음, `publishing`만), 풀기(원래 트랙, 조정 한 번, Published 한 번), 준비된 보류 정지(닫힌 줄,
  `tracks-close` force), 준비 전 정지(중단, `tracks-new` 없음), 연결 실패(서술자 없는 `failed`, 풀기 거절), 이름만 남기는 실패
  줄(Error, TimeoutError, capability-cancelled), 풀기 거절(정지, 대체, 끝난 트랙, 후속 송신기 안 건드림). 모든 새 줄에 세션,
  토큰, 트랙 이름, 방 코드가 없다.
- `src/pro-room/__tests__/system-audio-service.test.ts`: 'a proven LAN-direct stops the held publisher before committing the
  9.0.26 lan-direct shape and never releases it', 'a failed LAN-direct (the probe returns null / rejects) releases the held
  publication…', 묶음 'PRO system-audio held SFU fallback beside the LAN-direct attempt' 8행(임대 preflight로 시도 옆에서
  시작, 준비된 보류면 LAN 실패 순간 커밋(2,000 ms, 이전은 3,600 ms), 실패한 보류는 LAN 실패에 공유 실패, LAN 증명이면
  실패한 보류 무시(알림·복구 없음), 창 안의 정지(LAN 실패·증명 둘 다), 풀기 중 정리, 묵은 비행). 고친 행: 프레즌스 변경
  행(보류 하나와 승격 하나), 묵은 활성화 행(보류만, 승격 없음), 승격 응답 유실 행·마감 행·유지 경로 두 행(승격 발행만
  셈), 명시적 정지 행(`OPERATION_SUPERSEDED`). 대상 0 행은 그대로 통과한다(보류 없음).
- `src/pro-room/__tests__/system-audio-publication-teardown.test.ts`: LAN 창 안의 다섯 입구(명시적 정지, 임대 상실, 새 presence
  인스턴스, 서비스 초기화는 공유 뒤 행과 같은 목록이고 풀기·커밋 없음; PRO 방 문맥 떠나기는 발행자를 남기고 예전 순차 발행처럼
  풀고 커밋).
- `src/pro-room/__tests__/system-audio-pro-publish-evidence.test.ts`(실제 SFU 모듈과 네이티브 가짜): 첫 SFU 경로의
  Prepared 다음 Published 한 번(세션 하나, `replaceTrack` `[null, track]`), 준비 뒤 LAN 증명(세션 하나 열고 닫음, 미디어 0,
  캡처 제약 요청 0, Published 없음), 준비 전 LAN 증명(트랙 요청 0, 준비 전 닫힌 줄). 승격 행은 승격 자신의 세션을 기대하고
  T2 조정 행은 그대로 통과한다(보류 송신기는 조정되지 않는다).
- 도우미: 가짜 송신기 둘에 기록되는 `replaceTrack`, 다른 SFU 모듈 가짜(감시견, 수신 하네스)에 새 내보내기.

## QA 라운드 1 (로컬, 2026-10-31)

| 항목        | 값                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| 시험한 코드 | 런타임 `17002160`(문서 커밋은 코드를 바꾸지 않는다)                                                     |
| 환경        | Windows 11, Node 24.22.2(`mxq-tools`), `npm ci`, Chromium 153(Playwright), 로컬만                        |
| 결과        | 통과(런타임 `17002160` 위 문서 커밋 트리에서; 그 뒤 이 결과 칸만 고쳤다). `npm run typecheck`, `npm run lint`, `npm run format:check`, `node scripts/check-resource-ownership.mts`(개수 변화 없음), `npm run build`와 `guard:*` 전부가 통과했고 `guard:sw-cache-version`만 예상대로 실패했다(버전 올리기 없음: 두 런타임 파일이 v800 `676a1670`보다 새로움). 전체 `vitest --maxWorkers=6`은 16,938행 중 16,931행 통과, 7행은 임시 git 저장소를 만드는 도구 시험 두 파일(`sw-cache-version-guard`, `release-deployment-state`)의 시간 초과였고 그 두 파일만 다시 돌리면 156/156 통과(이 변경과 무관; 첫 전체 실행에서도 같은 파일이 셋 시간 초과). `npm run test:e2e:critical` 100 통과, `e2e/system-audio-controls.test.ts` 5 통과(Chromium). 바뀐 다섯 시험 파일 170행 통과 |
| 건너뜀·한계 | 실기기, WebKit 실기기, 운영 Cloudflare, 실제 P와 미디어 0 세션 청구는 시험하지 않았다(아래 '확인 안 된 것') |

## 확인 안 된 것

- 실기기(iOS Safari, Edge, Android)와 운영 Cloudflare Realtime. 특히 트랙 없이 협상한 push 트랙이 몇 초 뒤 RTP를 받기
  시작할 때의 Cloudflare 동작, LAN 시도와 나란히 돈 실제 P.
- 미디어 0 세션에 대한 Cloudflare 청구.
- 하네스는 로컬 루프백과 가짜 Cloudflare다(P는 모형).

## 배포 뒤 확인 (제안)

오너 기기로 `?mxqrLog=info` 공유 몇 번: (1) 같은 Wi-Fi에서 LAN-direct가 붙는 공유는 공유자에 'LAN route … proven' 다음
'Closed unused SFU fallback …'이 있고 `Published generation` 줄은 없다. (2) 청취자를 Wi-Fi 밖에 둔 공유는 공유자에
'Prepared SFU fallback … in T ms'와 'Published generation N'이, 청취자에 'Subscription to generation … ready'와 들리는
소리가 있다. 판정 기준은 따로 건네지 않는다(블라인드 확인).
