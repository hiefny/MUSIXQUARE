# Phase 5 5A 배포 묶음: 시스템 오디오 수신 슬롯을 주인 하나로, 동작 그대로 (2026-10-25)

| 항목      | 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기준      | origin/main `2d605739`(4D 기록 #493. 런타임은 운영 9.0.11 / v784의 배포 SHA `244aca48`과 같다). 브랜치는 `bd94075c`(그때 운영 9.0.7 / v778, main에는 머지만 된 #483)에서 잘랐고 origin/main을 세 번 합쳤다. `aa62fe34`(`2038b51f`, 9.0.10 / v783, 4B·4C), `aab3628b`(`244aca48`, 9.0.11 / v784, 4D), `c344b46f`(`2d605739`, 문서만). 세 번 모두 글자 충돌이 없었다.                                                                                                                                                              |
| 5A 묶음   | 브랜치 `agent/phase5-5a`. 준비 넷(테스트·가드·설정만): T2·T3 `8b34a24e`, T4 `c30c17a5`, T5 `470227ca`, T6 `8244531f`. 증분마다 테스트 먼저 커밋과 코드 커밋 한 쌍이다. C4-1 `c5ba8c4d` → `da3ff369`, C4-2 `254328c6` → `d1f22a61`, C4-3 `900cbb40` → `ab5bc996`, C4-4 `493b48a5` → `830bfb2d`, C4-5 `f4dec9d5` → `a7735b92`, C4-6 `605134a9` → `3233ac10`, C4-7 `7f96730e` → `bde907e0`, C4-8 `0879d6ec` → `e9a9e731`, C4-12 `3867c7e4` → `cc2510ce`. 그 위에 main 합침 `c344b46f`(문서만)와 이 보고서·기록 커밋(문서만)이 있다. |
| 상태      | 배포 전, 버전 미정. 레인 규칙대로 SemVer와 SW 캐시 epoch를 올리지 않았다(통합이 마지막 런타임 커밋에서 올린다). 오너 결정(2026-10-25 약 22:30 KST)대로 강제 업데이트 열차(9.0.12)와 그 floor가 먼저 나가고, 5A는 그 뒤 자기 앱 릴리스로 나간다. 남은 것: 그때의 origin/main 합침과 다시 검증, bump, PR CI, Codex, exact-main CI, 릴리스 smoke, 배포.                                                                                                                                                                             |
| 현재 증분 | 기기 하나의 시스템 오디오 수신 자리(registry RO-04)에 주인 모듈 `src/network/system-audio-receive-slot.ts`를 두고, 일반방 직접 통화, 일반방 SFU 게스트, PRO 코디네이터가 그 슬롯을 부르게 옮겼다(C4-2~C4-8). 매체 값은 `src/network/system-audio-media.ts` 한 집으로 모으고(C4-1), PRO 발행 정리는 이름 붙인 연산 셋으로 바꿨다(C4-12). 동작, 통신 프레임, 기기 판독 줄, 타이머 이름은 그대로다.                                                                                                                                 |
| 제품 식별 | 이 브랜치의 버전 문자열은 운영과 같은 `9.0.11` / `v784`다(`guard:release-identity`). 다음 번호는 통합 때 그때의 main을 보고 정한다.                                                                                                                                                                                                                                                                                                                                                                                              |
| 배포 대상 | 예정 target `app`, Developer API D1 `false`. App 런타임 입력은 `src/`와 `vite.config.ts`(지연 전용 모듈 목록 두 줄)만 바뀐다. `cloudflare/`, D1, 비밀, 바인딩, 시스템 오디오 계약 표지 `single-stereo-v3+heartbeat-state-v1`은 그대로다.                                                                                                                                                                                                                                                                                         |
| 환경      | Windows 11 로컬, Node 24.20.0 / npm 12.0.2. 단위는 jsdom과 가짜 WebRTC, Web Audio, Cloudflare Realtime이다. 로컬 Playwright(헤드리스 Chromium, PeerJS 일반방)의 `e2e/system-audio-controls.test.ts`를 C4-4, C4-5, C4-6 뒤에 돌렸다. 실제 기기, WebKit, 실제 Cloudflare Realtime은 5A 코드로 돌리지 않았다.                                                                                                                                                                                                                       |
| 운영      | 없음(배포 전).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

이 문서는 구조 개선 Phase 5의 첫 앱 배포(5A)에 실리는 준비, 증분, QA를 기록한다. Phase 5는 시스템
오디오 수신 자리(RO-04)를 다섯 기계가 따로 움직이던 것을 슬롯 주인 하나로 모은다. 5A는 동작을 바꾸지
않는 이동만 싣고, C4-0(#454, #482)이 오늘 동작으로 고정한 틈을 고치는 일은 5B로 간다(P5-D3 A, P5-D5
A). 증분마다 테스트 커밋을 먼저 두었고, 그 테스트는 바꾸기 전 코드에서 통과한다. 증분마다 커밋, 검증한
코드 SHA, 환경, PASS/FAIL/SKIP과 한계를 적는다. 유지 계약은
[시스템 오디오 수신 소유](system-audio-receive-ownership.md)다.

## 오너 결정

- **2026-10-25 약 01:20 KST, Phase 5를 지금:** 오너는 Phase 5를 쓰고, 준비되는 대로 머지하고 배포하기로
  했다(P4-D14 A를 Phase 5에 대해 덮어씀). 고르기 전에 들은 결과: Phase 4와 Phase 5가 데이터 PC SDP
  레인(RO-16)을 같이 써서 두 열차 뒤 퇴행을 배포 간격으로 가를 수 없고, 기기 확인이 쌓인다. 메인
  세션이 지키는 완화: Phase 5는 자기 열차와 보고서, 오너 결정 없이는 중립 증분만, 이동 전 C4-0, 보고서에
  겹침을 적는다(아래 [Phase 4와 겹침](#phase-4와-겹침)).
- **약 01:50 KST, 배포 시점과 기기 게이트:** 모든 열차는 자동 게이트(로컬 검사, 리뷰, PR CI, Codex,
  exact-main CI, 릴리스 smoke)가 통과하면 바로 내고, 기기 근거는 코드의 게이트가 아니다
  ([4C 보고서의 오너 결정](phase4-4c-link-liveness-2026-10-25.md#오너-결정)). 열차 보고서마다 기기로
  확인하지 않은 것을 적는다(아래 마지막 절).
- **약 04:00 KST, Phase 5 추천안 전부:** 로드맵 기록에 이름이 적힌 것은 다음과 같다.
  - P5-D3 A: 앱 업데이트 두 번. 5A는 중립(C4-1~C4-8, C4-12), 5B는 동작 변경(각자 실패 테스트와 라벨).
    C4-6·C4-7은 5A 안에 두되 네 계약 묶음의 오늘 동작·틈 테스트가 그대로 통과해야 하고, 하나라도
    뒤집어야 하면 그 증분은 5B로 간다.
  - P5-D4 A: 새 지연 전용 모듈 `src/network/system-audio-receive-slot.ts`, `DEFERRED_ENTRY_MODULES`와
    핵심 커버리지에 넣는다. 선택지 문구에는 '새 청크가 생기거나 첫 로딩이 늘면 멈추고 수치를 들고 다시
    묻는다'가 있었다(아래 C4-7 청크 구성).
  - P5-D7 A: 버스 쌍 둘을 슬롯 입력으로 바꾸고 타이머 이름 `sys-audio-guest-*`는 그대로 둔다.
  - P5-D5 A: C4-0 틈은 5B에서 라벨 붙인 묶음으로 고치고, 단위 근거를 받아들인다.
  - P5-D11 B: C4-13(공유 뒤 두 번째 멈춤)을 5B에 넣고, F3 단위 재현을 실패 테스트로 쓴다.
  - P5-D9 C: 혼합 버전 기기 행 없이 자동 프레임 모양 근거로 본다.
  - P5-D2 A: Phase 5 기기 절차를 Phase 4 세션 2에 붙인다.

  '추천안 전부'를 따라 나머지 질문도 추천안으로 읽었다. P5-D8 A(C4-9의 attachEpoch 울타리를 넣지
  않음), P5-D10 A(경로마다 다른 수신 패리티를 그대로 둠), P5-D12 A(C4-11 Realtime 제어 클라이언트와 운영
  smoke 없음, RO-39 유지), P5-D13 A(C4-14 없음, RO-42 유지), P5-D14 A(코드 완료는 구조 확인과 자동
  근거로 정하고, 기기 재실행과 14일 무보고는 기록 항목으로 둠), P5-D6(5P-6은 USB 디버깅이 될 때, 둘째
  PC 없음, 잠들었던 배포자 페이지는 기기에서 만들지 않음)다.

- **약 16:40 KST, 옛 버전 정책:** 옛 앱 버전과의 혼합 호환은 더 이상 설계 제약이 아니고, 필요하면 강제
  업데이트로 다룬다. 5A는 프레임을 바꾸지 않으므로 이 정책에 기대는 곳이 없다(아래 혼합 버전).
- **약 22:30 KST, 병렬 열차:** 5A를 C4-2에서 다시 이어 가고(main `244aca48` 합침), 강제 업데이트 열차
  (9.0.12)와 옛 버전 제거 1차를 다른 워크트리에서 함께 진행한다. 출시 순서는 9.0.12와 그 floor가 먼저,
  그다음 5A와 제거 1차가 준비되는 대로 하나씩이다. 그래서 5A 레인은 병렬 열차가 바꾸는 파일을 피했다.
  예외는 둘이다. C4-6이 두 버스 이벤트를 은퇴시키며 `src/types/index.ts`의 이벤트 맵 두 줄을 지웠고,
  C4-8 테스트 먼저(`0879d6ec`)가 슬롯 이름을 부르게 테스트 셋의 import만 고쳤다
  (`src/player/__tests__/file-prepare-pause.test.ts`, `src/storage/__tests__/recovery-owner-transition.test.ts`,
  `src/youtube/__tests__/load-lifecycle.test.ts`. 마지막 것은 C4-6에서 시작 인자 하나도 바뀌었다).

**구현과 리뷰 중 정한 세부(오너가 맡긴 판단, 2026-10-25~26).** 오너 확인을 기다린다. 배포의 게이트는
아니고, 현재 릴리스 기록의 5A 범위 항목에 남겨 두었다.

- **C4-7 뒤 청크 구성.** 청크 수(112)와 SW 앱 셸 자산 수(106)는 그대로지만 청크 하나가 바뀌었다. PRO
  서비스가 Standard SFU 모듈을 더는 import하지 않자 Rollup이 슬롯과 매체 집을 새 청크
  `system-audio-receive-slot`(6,412 B raw, 2,849 B gzip)으로 떼고 `system-audio-host` 청크를
  `system-audio-sfu`에 합쳤다. 첫 로딩에 들어온 코드는 없지만, main과 peer 청크의 미리 읽기 목록이 더 긴
  청크 이름을 적어 초기 JS가 11 B gzip(raw 16 B) 늘었다. P5-D4 A 선택지의 '새 청크가 생기거나 첫 로딩이
  늘면 멈추고 다시 묻는다'에 글자 그대로 걸리지만 레인은 멈추지 않고 이 수치를 여기와 기록에 적었다.
  막는 선은 P4-D4 A의 5% 예비선이고 통과했다(아래 초기 JS 예산). 받아들이지 않으면 C4-7의 RULE D와
  import 정리는 그대로 두고 청크 이름을 고정하는 방법(manualChunks)을 따로 물어야 한다.
- **PRO 코디네이터는 경로 하나.** 설계는 PRO 전송마다 경로('pro-sfu', 'pro-direct')를 두었지만,
  코디네이터는 어느 전송이 트랙을 줘도 source와 프라이머를 하나만 가졌다. 그래서 경로 하나
  'pro-coordinator'로 했다. 전송마다 두면 정리를 건너뛰는 길에서 한 전송의 source가 이어진 채 남는다.
- **수신을 시작하는 붙이기는 경로가 정한다.** 직접 통화 'first-for-slot'(슬롯이 수신 중이 아닐 때의 첫
  붙이기), Standard SFU 'first-for-route'(경로가 마지막으로 떼어진 뒤의 첫 붙이기, 재발행마다 2시간 제한도
  다시), PRO 'every-attach'(모든 트랙). 오늘 동작을 경로마다 적은 것이다.
- **붙이기는 다시 prime하지 않는다.** 설계는 '둘째 prime은 아무 일도 하지 않는다'고 보았지만, 같은
  통화의 뒤 스트림이 먼저 스트림의 initAudio 동안 prime하면 맞지 않는다(테스트 먼저 `900cbb40`이 고정).
- **슬롯 '유휴 아님' 확인을 넣지 않았다.** 설계 C4-3의 붙이기 확인은 울타리 일이라 틈 2·3을 고치는 5B
  몫이다. 리뷰는 커밋 메시지의 이유('S9·S8b 고정이 오늘 동작으로 남는다')가 정확하지 않다고 짚었다. 그
  고정은 이 확인에 기대지 않는다. 넣지 않은 것 자체는 맞다.
- **SFU 정리의 수신 끝 판단.** `cleanupGuestSfu`는 '이 구독이 source를 붙였나'를
  `getSystemAudioReceiveRouteSnapshot('standard-sfu').sourceAttached`로 읽는다(설계는 `isAttachedBy` 같은
  질의). 오늘 동작은 같다. 스냅샷은 `/debug`도 읽으므로 그 뜻을 바꾸면 끝 판단도 바뀐다(리뷰 낮음).
- **쓰기 규율 가드의 자리.** 설계 C4-8의 `check-lifecycle-writes.mts` CHECK 6 대신
  `check-resource-ownership.mts` CHECK 9(기본값 7, T5)에 두었다. 매체 집은 새 CHECK 10(C4-1), import
  규칙은 `check-import-graph.mts` RULE D(C4-7)다.
- **시간 값의 쓰임 이름.** `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS`(30초)는 매체 집 하나에서 끌어오고, 슬롯의
  경계 대기는 `TRUSTED_BOUNDARY_WAIT_MS`, 서비스의 직접 수신 마감은 `DIRECT_RECEIVE_DEADLINE_MS`로 읽는다.
  설계 C4-1이 함께 적은 서비스 `RECOVERY_DELAY_MS`(2.5초) 쪼개기는 하지 않았다. 그 값은 코디네이터 자기
  마감과 리스·발행자 재시도(RO-20)를 재므로 수신 슬롯 증분이 옮길 것이 없었다.
- **C4-12는 연산 셋만.** 설계의 'LocalPublicationState 한 기록으로 묶기'는 하지 않고 계획 §2.2대로 정리
  블록을 이름 붙인 연산 셋으로 바꿨다. 순서 하나가 바뀌었다(아래 C4-12).
- **`/debug sa` 슬롯 줄은 더하지 않았다.** 기본값 3이 허락한 슬롯 줄 하나를 5A에서 더하지 않았다. PRO
  수신은 지금처럼 `[Playback]` 줄의 공유 플래그로만 보인다.

## 준비 (배포 없음, 테스트·가드·설정만)

| 단계 | 커밋                  | 내용                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1   | #482 `252dd765`(main) | PRO SFU 재생 지연 힌트 0.5, LAN-direct 힌트 없음을 진짜 전송으로 고정. C4-1의 근거.                                                                                                                                                                                                                                                                                                                                                                                                        |
| T2   | `8b34a24e`            | 보내는 쪽 음악 튜닝을 진짜 발행자로 고정. Standard SFU와 PRO SFU 발행자는 캡처 트랙에 `{echoCancellation, noiseSuppression, autoGainControl: false}`를 한 번 묻고 256 kbps 인코딩 하나를 보낸다(직접→SFU 승격의 SFU sender 포함). 제약 거절과 읽을 수 없는 sender는 발행을 실패시키지 않는다. PRO LAN-direct는 비트레이트만 건다.                                                                                                                                                          |
| T3   | `8b34a24e`            | 기기 판독 줄 열넷을 글자, 인자 수, 로그 수준까지 진짜 guest, Standard SFU, 방장, PRO 서비스와 전송으로 고정(#478 방식). 일반방 직접 넷, 일반방 SFU 넷, PRO SFU 셋, PRO 승격 하나, 세 앞머리의 프라이머 쌍. `/debug sa`의 `[Playback]`·`[DirectGuest]`·`[SFUGuest]` 줄과 guest·SFU 스냅샷 키를 START 전, 대기, 경로마다, STOP 뒤에 고정. src를 바꿔 하나씩 실패를 확인했다(남은 하나 `gotStereo`와 `sourceStereo`는 그때 늘 같아 구별 불가).                                                |
| T4   | `c30c17a5`            | 네 계약 묶음, `system-audio-guest.test.ts`, G1 하네스 `system-audio-subscriber-watchdog.test.ts`를 핵심 프로필에 등록(77 files / 3,025 → 83 / 3,181). 커버리지에 guest, `pro-system-audio-direct.ts`, `system-audio-service.ts`를 넣고 파일마다 두 번 같은 실행보다 약 1점 아래 하한을 두었다. 기존 하한은 내리지 않았다.                                                                                                                                                                  |
| T5   | `470227ca`            | CHECK 9: 슬롯 직접 쓰기를 파일마다 정확히 센다(오늘 수에서 시작). `setSystemAudioReceiving` 9, `'system-audio'` claim 6, `widener.input` 5, 원시 `'systemAudio.isReceiving'` 1.                                                                                                                                                                                                                                                                                                            |
| T6   | `8244531f`            | 네 생산 파일을 글자로 읽던 `system-audio-start.test.ts`의 START 검사를 진짜 방장, Standard SFU, 전달 정책, 라우터로 네 보내는 자리의 정확한 프레임을 보는 행동 테스트로 바꿨다(C4-4 전 필수). 여섯 보내는 자리 어디에 원시 `{ type: START }`를 넣어도 실패한다.                                                                                                                                                                                                                            |
| T7   | 하지 않음             | 선택. C5-0 랩 시스템 오디오 시나리오는 만들지 않았다.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T8   | 커밋 없음             | 결과 음성. F3 하네스에 진짜 flight recorder를 붙여 보니, 두 번 arm하는 F3 경우도 대조(첫 복원 성공, 보통의 숨김 뒤 복귀)도 화면이 보인 뒤 `pro-checkpoint`가 0줄이다(숨김 중 한 줄뿐). `recordAppliedPlaybackCheckpoint`는 `applyPlaybackCommit` 안에서만 돌고, 같은 revision의 다시 arm은 그 전에 돌아온다. 그래서 C4-13의 기기 보조 근거(같은 revision 두 줄)는 없다. 기기 결과는 '귀로만 보임' 아니면 '기기에서 안 보임'만 될 수 있다. 독립 리뷰가 다른 임시 테스트로 같은 결과를 냈다. |

## 제품·런타임 증분

### C4-1 매체 값 한 집 (중립)

테스트 `c5ba8c4d`, 코드 `da3ff369`. 새 지연 전용 모듈 `src/network/system-audio-media.ts`(RO-04의 시간 값
집)로 경로 어댑터마다 따로 가졌던 매체 값을 옮겼다.

- 받는 쪽: 재생 지연 힌트 0.5초와 `applySystemAudioPlayoutDelay()`. 일반방 직접 통화, 일반방 SFU, PRO SFU
  수신기가 부르고, PRO LAN-direct 수신기는 여전히 힌트가 없다.
- 보내는 쪽: `tuneSystemAudioMusicSender()`(일반방 직접 통화의 senderTuning, 일반방 SFU와 PRO SFU
  발행자. 음악용 제약과 256 kbps 인코딩 하나, 오디오 sender만), `tuneSystemAudioLanDirectSender()`(PRO
  LAN-direct, 비트레이트만).
- Cloudflare Realtime: 두 SFU 전송이 같이 쓰는 STUN 항목, 15초 요청 마감, 1 MiB 응답 상한. 제어
  클라이언트 자체는 사본 둘 그대로다(RO-39).

그대로인 것: 사본들이 달랐던 가장자리 하나(인코딩을 하나도 적지 않은 sender를 음악 경로는 그대로 두고
LAN-direct는 바뀌지 않은 매개변수를 다시 넣음)는 오늘 동작으로 남는다.

테스트 먼저: `c5ba8c4d`가 직접 통화 수신의 힌트가 오디오 수신기에만 가는 것, 직접 통화 sender 튜닝의
가장자리(오디오 아닌 sender와 트랙 없는 sender는 건드리지 않음, 인코딩 목록이 없으면 256 kbps 하나, 빈
목록이면 제약만), 두 SFU 발행자와 LAN-direct의 같은 가장자리를 고정했고 바꾸기 전 코드에서 통과했다. 옮긴
가장자리를 하나씩 바꾸면(힌트 값과 오디오만 거르기, 음악 경로의 트랙 확인, 목록 채우기, 두 경로의 빈 목록
정책, LAN-direct의 제약, 빠진 `.catch`) 고정 하나가 실패했다. 가드: CHECK 5의 C4-1 사본 넷(Realtime 마감과
재생 지연 셋)을 지웠고(사본 6 → 2, 같은 값 쌍 26 → 25), 새 CHECK 10이 경로 파일에서 `playoutDelayHint`·
`maxBitrate` 쓰기와 `stun.cloudflare.com`을 집의 세 곳에만 둔다. 모듈은 `DEFERRED_ENTRY_MODULES`와 핵심
커버리지(하한 99, 100% 덮임)에 들어갔다. 초기 JS 478,015 → 478,033 B(늦은 청크 해시만).

### C4-2 신뢰 수신을 슬롯으로 (중립)

테스트 `254328c6`, 코드 `d1f22a61`(그 사이 `aab3628b`에서 9.0.11 main을 합침). 새 지연 전용 모듈
`src/network/system-audio-receive-slot.ts`(RO-04 주인, P5-D4 A)로 `system-audio-guest.ts`의 신뢰 수신을
옮겼다.

- 슬롯은 guest의 따로 있던 변수 대신 `ReceiveSlot` 합 타입(`idle`, `claiming`, `held`)을 갖는다. 경로의
  경계 대기를 가르는 수신 세대, 걸린 시작, 시작이 받아 둔 복원 지점이다. 대기 중인지 수신 중인지는 전처럼
  플레이어 상태(자리표시 meta, `systemAudio.isReceiving`)에서 읽는다.
- 함께 옮긴 것: 경계 대기와 그 30초 문 타이머, 시작과 commit(`stopAllMedia`, 파일 받기와 원격 공유 대기
  취소, 프리로드 감시 지움, 자리표시 claim, `system-audio:host-started`), 30초 수신 감시와 그 신호,
  handoff interrupt, 수신 끝(슬롯이 자리표시나 주인을 아직 가질 때만 제목 복원), `/debug`의 시작·무시된
  시작·정리·감시 필드.
- 일반방 직접 통화는 끝 포트 하나를 등록한다. 끝은 복원 지점을 받고 감시를 지운 뒤, 수신 플래그를 내리기
  전에 그 포트를 부른다. 그 결과 직접 통화의 첫 unmute 대기 취소가 슬롯 자기 정리 뒤로 옮겨졌다. 그 대기는
  효과 없이 돌아오는 continuation만 풀고, 로그 줄의 상대 순서는 바뀌지 않는다.
- guest는 시작, 경계 대기, 끝(`cleanupGuestSystemAudio`), `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS`를 C4-8까지
  호환 별칭으로 남겨 Standard SFU, PRO 코디네이터, 그 테스트 mock을 건드리지 않았다. 수신 마감 상수는
  시간 집(`system-audio-media.ts`)으로 갔다.

테스트 먼저: `254328c6`(11행)이 경로들이 부르는 이름으로 경계 대기(아무 시작도 없으면 30초 뒤 실패, 시작
전 대기는 그 시작으로 해결, 자리표시 중이면 바로, 정리는 모두 실패시킴), 세대(commit 중 연 대기가 그
세대를 받고 그 안의 시작은 거절), 복원 지점(시작 안의 중첩 정리가 비움. PRO 틈 7의 일반방 형제로 오늘
동작), 감시(자리표시 중 신호, 복원 뒤 `receive_failed`, 다른 주인 뒤 물러남), 다른 경로의 정리, `/debug`
기록을 고정했고 바꾸기 전 코드에서 통과했다. 이동 전후로 guest 묶음, 네 계약 묶음, G1 하네스 168행이
그대로 통과했다. 가드: CHECK 4가 수신 마감을 시간 집에서 읽는다(앵커 `G1_WATCHDOG_FILE`). CHECK 9는 수신
플래그 guest 3 → 1·슬롯 2, claim guest 2 → 1·슬롯 1(합 그대로). 핵심 커버리지에 슬롯 93.75/86.36/100/96.59
(하한 92/85/99/95). 슬롯은 `system-audio-sfu` 청크에 들어갔다(8,925 → 9,166 B gzip). 초기 JS 478,185 →
478,196 B(늦은 청크 해시만).

### C4-3 일반방 직접 통화의 붙이기 (중립)

테스트 `900cbb40`, 코드 `ab5bc996`. guest의 `_sourceStereo`, `_decoderPrimer`, `_gotStereo`가 없어졌다.

- 슬롯이 경로마다 붙인 것(source와 프라이머, `RouteMedia`)을 갖는다. 한 경로의 붙이기는 자기 source만
  바꾸고, 떼기도 자기 것만 버린다.
- `primeSystemAudioDecoder(route, tracks, {streamKey, label, logPrefix})`: 직접 통화는 전처럼 스트림이
  도착하면 unmute 대기와 경계 전에 자기 키, 라벨, `[SysAudioGuest]` 앞머리로 prime한다. 스트림 키당
  프라이머 하나다.
- `attachSystemAudioSource(route, received, request)`는 동기다. 직접 통화는 자기 `await initAudio()`와 통화
  재확인을 그대로 가져, 재확인과 그래프 사이에 await가 끼지 않는다. 그래프가 없으면 false를 돌려주고 직접
  통화가 전처럼 로그를 남기고 `audio-graph-not-ready`를 던진다. 있으면 source를 바꾸고 경로 장부(그래프
  시각, 교체 감시 지움)를 돌린 뒤, 수신의 첫 붙이기에서 감시 지움, 수신 플래그, `'system-audio'` claim,
  비주얼라이저 시작, 연결 줄을 한다.
- `detachSystemAudioRoute(route)`가 그 경로의 source와 프라이머를 버린다. 직접 통화의 끝 포트가 교체 감시를
  지운 뒤, 통화를 닫기 전에 부른다.
- `/debug`: `getSystemAudioReceiveRouteSnapshot(route)`가 그 경로가 source를 붙였는지와 프라이머를 가졌는지
  답한다. guest 스냅샷 키와 순서는 그대로이고, `gotStereo`와 `sourceStereo`는 둘 다 '직접 통화가 source를
  붙였나'를 읽는다(동기 끝 밖에서는 늘 같았다). 차이 하나: 수신의 첫 붙이기에서 `source.connect()`가
  던지면, 실패의 끝이 지우기 전 한 microtask 동안 `gotStereo`가 yes다.

테스트 먼저: `900cbb40`이 스트림 키당 프라이머(도착 때 prime, 붙이기는 다시 prime하지 않음, initAudio 중
같은 통화의 둘째 스트림은 바로 prime하고 둘 다 도착 순서로 붙음, 줄과 비주얼라이저는 키나 수신당 한
번), `/debug sa`의 프라이머와 source 분리, 직접 통화가 원격 스트림 객체 자체를 widener 입력에 잇는 것,
그래프 없음과 initAudio 거절이 그 통화의 `/debug` 채널에 남는 것을 고정했다. 가드: CHECK 9 guest 1 → 0
(수신 플래그, claim, `widener.input`), 슬롯 2 → 3, 1 → 2, 0 → 1(합 그대로). 슬롯 커버리지 95.41/88.88/100/
97.54. 초기 JS 478,196 → 478,195 B, `system-audio-sfu` 청크 9,166 → 9,350 B gzip.

### C4-4 일반방 SFU 게스트의 붙이기 (중립)

테스트 `493b48a5`, 코드 `830bfb2d`. SFU의 `guestSourceStereo`, `guestDecoderPrimer`, `guestReceiving`이
없어졌다.

- 슬롯 붙이기가 경로가 받은 것을 받는다. 직접 통화는 `{ stream }`(그대로 연결), SFU는 `{ track }`(그래프
  확인 뒤 자기 스트림으로 감쌈, 전처럼). SFU의 수신 시작 규칙은 'first-for-route'다. 방장 재발행은 옛 구독을
  `cleanupGuestSfu(false)`로 내리고 수신 플래그는 남기므로, 구독마다 claim, 비주얼라이저, 연결 줄, 2시간
  제한이 다시 걸린다(계약 `:743-780`).
- `onGraphReady(context)`는 슬롯이 그래프를 확인한 뒤, source 교체 전에 돈다. SFU는 여기서 돌지 않는
  context를 같은 줄로 경고하고 `sfu:stereo` 키, STEREO 라벨, `[SysAudioSFU]` 앞머리로 prime한다. 그래프가
  없으면 둘 다 하지 않고 붙이기가 전처럼 'System audio graph not ready'로 실패한다. `onReceptionStart`가
  수신 플래그 전에 2시간 제한을 건다(전처럼).
- 붙이기가 수신을 시작할 때 플래그가 꺼져 있었을 때만 수신 감시를 지운다. SFU에서는 그 지움이 guest의
  플래그 상태 리스너에서 같은 false→true 뒤집힘에 왔다. 플래그가 이미 켜져 있으면 지우지 않는다(전처럼).
- `cleanupGuestSfu`는 source를 끊고 프라이머를 버리던 자리에서 경로를 떼고, 그 구독이 붙였을 때만 공유
  수신을 끝낸다. SFU는 끝 포트를 등록하지 않는다. 오늘 끝은 SFU 전송, source, 프라이머를 건드리지 않았다.
- `/debug`: SFU 게스트 키와 순서 그대로. `receiving`과 `sourceStereo`는 '이 구독이 source를 붙였나',
  `decoderPrimerCount`는 경로 프라이머다. C4-3과 같은 `connect()` 예외의 한 microtask 차이가 있다.

테스트 먼저: `493b48a5`가 SFU 단위 묶음의 'guest SFU attach' 묶음(트랙을 자기 스트림으로 widener에, 프라이머,
첫 붙이기의 시작 한 번과 둘째 트랙은 교체만, 재발행의 첫 붙이기가 시작을 다시 하고 그 앞 내림은 수신을
끝내지 않음, 정리는 붙인 뒤에만 수신을 끝냄, `/debug` 키, 돌지 않는 context 경고는 그래프 확인 뒤)과 T3
증거 묶음의 재발행 행을 고정했다. 가드: CHECK 9 SFU 1 → 0(셋 모두), 합 9 → 8, 6 → 5, 5 → 4. 단위 671 files /
15,686, 로컬 Playwright `e2e/system-audio-controls.test.ts` 5/5(일반방 P2P. Cloudflare Realtime에 닿을 수
없어 SFU 수신은 단위로만 봤다). 커버리지 슬롯 95.62/90/100/97.63, `system-audio-sfu.ts` 84.09/74.4/95.6/
90.78. 초기 JS 478,195 → 478,192 B, `system-audio-sfu` 청크 9,350 → 9,448 B gzip.

### C4-5 PRO 코디네이터를 슬롯 입력으로 (중립)

테스트 `f4dec9d5`, 코드 `a7735b92`. 서비스의 `coordinatorSource`, `coordinatorPrimer`,
`cleanupCoordinatorAudioNodes`가 없어지고, 서비스는 audio context, widener, 프라이머, 수신 플래그와 claim
쓰기를 import하지 않는다.

- 경로 하나 'pro-coordinator'(위 세부). `attachCoordinatorTrack`은 경계 대기, 자기 `await initAudio()`,
  발행·설명자·주인 재확인을 그대로 갖고, 슬롯 붙이기를 `{ track }`과 'every-attach'로 부른다. 모든
  코디네이터 붙이기가 수신 중에도 플래그, claim, 비주얼라이저를 다시 한다(전처럼). `onGraphReady`에서
  `pro-stereo` 키, 'stereo' 라벨, `[ProSysAudio]` 앞머리로 prime하고, `onConnected`에서 직접 수신 마감을
  지운다. 연결 줄은 남기지 않는다(전처럼). 그래프가 없으면 전처럼 아무것도 건드리기 전에
  `PRO_SYSTEM_AUDIO_GRAPH_UNAVAILABLE`.
- SFU 'subscribed'는 `resumeSystemAudioRoute`를 부른다(경로가 source를 아직 가질 때만 수신 시작을 다시).
- 끊김 유예, 구독 재시도, 수신기 대체는 슬롯 마감 없이 interrupt한다(코디네이터가 자기 마감을 가진다).
  재시도와 대체는 먼저 경로를 떼고, 끊김 유예는 source를 남긴다. 직접 수신 마감은 슬롯에 '이 경로가
  source를 붙였나'를 묻는다.
- 서비스에 남은 것: 구독 키와 같은 발행 재시도의 시작 건너뛰기(G6), 직접 수신 마감과 그 해제 다섯 곳,
  LAN-direct 시작이 시작 뒤에 그 마감을 거는 순서(틈 7), 타이머 이름, 끝 포트 없음(틈 4).
- 보이지 않는 차이(리뷰용): 트랙 prime이 옛 source를 끊기 전으로 옮겼다(둘 다 로그도 await도 없고
  브라우저에서 프라이머는 던지지 않는다). 꺼진 플래그에서 붙이기가 수신을 시작하면 슬롯이 감시를 스스로
  지운다(guest의 플래그 리스너가 같은 뒤집힘에 하던 일). 첫 붙이기의 `connect()` 예외 차이는 C4-3·C4-4와
  같다.

테스트 먼저: `f4dec9d5`가 실제 상태 PRO 계약 묶음에 '코디네이터 수신 입력' 묶음을 더했다. 2.5초 끊김 유예
안의 'subscribed'가 내림을 취소하고 수신 시작을 다시 한다. 유예를 넘긴 끊김은 플래그를 한 번 내리고
마감을 걸지 않는다(1분 뒤에도 알림, 시간 초과, idle 없음). 실패가 source를 뗀 뒤의 'subscribed'는 아무것도
claim하지 않는다. 모든 코디네이터 붙이기가 수신 시작을 다시 한다. 서비스 단위 묶음은 상태를 손으로 mock해
플래그·claim mock 단언이 실제 상태를 보지 못하므로, 같은 행을 실제 상태 계약 묶음이 고정한 것을 확인하고
이 변경에서 그 단언을 옮겼다(남은 서비스 테스트는 바꾸기 전 소스에서도 통과). 가드: CHECK 9 서비스 5 → 0,
2 → 0, 1 → 0(합 8 → 3, 5 → 3, 4 → 3), CHECK 4 재시도 앵커가 interrupt를 따라감. 단위 671 files / 15,690,
Playwright 5/5. 커버리지 슬롯 95.8/91.54/100/97.69, 서비스 50.45/40.86/58.01/53.4(하한 50/40/56/53. 덮인
붙이기 줄이 슬롯으로 갔다). 초기 JS 478,192 → 478,193 B.

### C4-6 버스 쌍 둘을 슬롯 입력으로 (중립, P5-D7 A)

테스트 `605134a9`, 코드 `3233ac10`. `'system-audio:delivery-handoff'`와 `'system-audio:receive-timeout'`이
이벤트 맵에서 빠졌다.

- 마감 종류: 시작과 interrupt가 필수 인자 `{ deadline: 'slot' | 'route' }`(`ReceiveDeadline`)를 받는다.
  'slot'은 슬롯의 30초 마감(옛 `receiveWatchdog` true), 'route'는 마감 없음(옛 false)이다. 방장 START와
  직접 경로 실패 뒤의 SFU 시작은 'slot', PRO 코디네이터의 시작 둘과 interrupt 셋은 'route'다.
- handoff: SFU의 emit 두 곳(대기 READY로 넘기는 실패한 구독, SFU를 대신하는 직접 통화)이
  `handOffGuestSfuReception`을 부른다. guest 리스너가 하던 역할 확인(`isGuestSfuReceiver`)을 지키고, 슬롯의
  `handOffTrustedSystemAudioReception`(자리표시 중이면 슬롯 마감으로 interrupt)을 emit이 있던 자리에서
  동기로 부른다.
- 마감 만료: 슬롯 30초 마감과 직접 통화의 교체 마감이 자기 warn 줄 뒤 `expireTrustedSystemAudioReception`을
  부른다. 등록된 경로의 `onDeadline`, 수신 끝, `receive_failed` 순서이고, 옛 emit, 끝, 토스트의 순서와 같다.
  `onDeadline`은 SFU만 등록한다(게스트면 `cleanupGuestSfu()`).
- 보이지 않는 차이(리뷰용): 버스는 리스너 예외를 가뒀지만 직접 호출은 가두지 않는다. 두 반응 모두
  브라우저에서 던지지 않는다(플래그 쓰기와 관리 타이머, Realtime close는 잡힌 promise, source 끊기는 try 안,
  `RTCPeerConnection.close()`). SFU의 마감 포트는 Map 항목이라 리스너를 두 번 등록해도 반응은 하나다(운영은
  페이지당 한 번 등록).

테스트 먼저: `605134a9`가 네 계약 묶음과 G1 하네스가 세던 두 버스 이벤트를 전후 모두 있는 신호로 바꿨다.
수신 시간 초과는 마감의 warn 줄(같은 자리에서 한 번씩 찍혀 기존 `receiveTimeouts` 단언이 모두 그대로)로,
handoff 일곱 개는 '자리표시 유지, handoff 시각부터 슬롯 마감 다시 걸림'(`/debug` guest 스냅샷의 감시 키)
단언으로 바꿨다. 새 행: 슬롯 마감이 SFU 어댑터의 구독을 수신 끝 전에 내리고, `receive_failed`가 제목 복원
뒤에 온다. 두 형태 모두 바꾸기 전 코드에서 통과했다. 돌연변이: SFU의 역할 확인 하나를 빼면 새 SFU 두 행,
경로 반응 전에 끝을 돌리면 계약 순서 행과 guest 마감 두 행이 실패했다. 가드: CHECK 4의 꺼진 시작 리터럴이
`{ deadline: 'route' }`(armed 2, G1 모드 그대로), room-authority-boundaries 직접 읽기 84 → 83, bus-pairing
202/202. 단위 671 files / 15,694. 초기 JS 478,193 → 478,195 B.

### C4-7 PRO 서비스가 Standard 수신 어댑터를 import하지 않음 (중립)

테스트 `7f96730e`, 코드 `bde907e0`.

- adopt: 슬롯의 `adoptSystemAudioReceiveRoute(route)`가 다른 등록 경로의 새 `retire` 포트를 부르고 슬롯
  자체는 바꾸지 않는다(수신, 자리표시, 복원 지점, 플래그, claim, 마감 그대로, adopt하는 경로의 source도
  그대로). SFU가 `onDeadline`과 함께 retire를 등록한다(옛 `cleanupSystemAudioSfuGuestRoute` 본문 그대로:
  `cleanupGuestSfu(false)`와 얼린 공유 경로 초기화, 수신 끝 없음). 서비스는 SFU 정리를 부르던 세 곳(방
  성격이 PRO로 바뀜, `ensureCoordinatorSubscription` 맨 위, `cleanupCoordinatorSubscriptionForRetry` 끝)에서
  같은 위치로 `adoptSystemAudioReceiveRoute('pro-coordinator')`를 부른다.
- 끝: `cleanupCoordinatorGraph`가 같은 `playback.mode === 'system-audio' && !latestView.isLocalOwner` 가드
  뒤에서 슬롯의 끝을 부르고, `resetProSystemAudioService`는 로컬 주인을 잊기 전에 그 정리를 돌린다(기본값
  11).
- 마감: 서비스는 `SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS`를 시간 집에서 `DIRECT_RECEIVE_DEADLINE_MS`라는 쓰임
  이름으로 읽는다. 타이머 이름 `pro-system-audio-direct-receive-deadline`은 그대로다.
- 앱에서 중립인 이유: SFU는 방 세션 기능 런타임에서 guest 다음, PRO 서비스 리스너 전에 동기로 포트를
  등록하고 PRO 방 진입은 그 런타임을 기다리므로, 코디네이터가 adopt할 수 있을 때 retire는 이미 있다.

테스트 먼저: `7f96730e`가 PRO 계약 S7을 늘렸다(전환이 얼린 공유 경로를 풀고 SFU `/debug` 게스트 키를 비우며,
재생 활동 변화, 알림, force-stop이 없는 끝이 아닌 일). 새 S7 행은 연결 중인 Standard 구독을 내리고
자리표시와 Standard 시작의 슬롯 마감을 같은 armedAt으로 남기며 PRO 시작('route')이 그 마감을 지우는 것을
고정했다. 서비스 단위 두 행은 모든 live reconcile 맨 위의 SFU 은퇴(idle에는 없음)와, 로컬 주인일 때
코디네이터 정리가 수신 끝을 건너뛰는 것(리셋 포함)이다. 돌연변이: `&& !latestView.isLocalOwner`를 빼면
단위 새 행과 S11·재진입 계약 세 행, 리셋에서 로컬 주인을 먼저 잊으면 단위 행과 S11 두 행, retire에서 공유
경로 초기화를 빼면 S7 두 행, retire가 수신을 끝내면 첫 S7 행이 실패했다. 이 변경에서 옮긴 테스트(단언
그대로): 서비스 단위와 G1 하네스의 guest·SFU 모듈 mock이 슬롯 부분 mock과 슬롯에 등록한 retire 스파이로
바뀌었고, SFU 단위 묶음에 '코디네이터 adopt가 은퇴시킴' 행이 생겼다. 가드: `check-import-graph.mts` RULE D가
`src/pro-room/**` 생산 코드의 `system-audio-guest.ts`·`system-audio-sfu.ts` import(정적이든 `import()`든)와
대상이 없어진 경계를 막는다(돌연변이로 확인). 커버리지 슬롯 96.02/91.3/100/97.77. 단위 671 files / 15,698.
초기 JS 478,195 → 478,206 B와 청크 구성은 위 세부에 적었다.

### C4-8 별칭 삭제, 쓰기 수 확정, 소유 계약 문서 (중립)

테스트 `0879d6ec`, 코드 `e9a9e731`.

- guest의 슬롯 별칭 셋(시작, 경계 대기, 끝 `cleanupGuestSystemAudio`)을 지웠다. Standard SFU가 슬롯 이름을
  직접 import하고 guest 모듈은 import하지 않는다. guest가 SFU보다 먼저 평가되는 순서는 그대로다(방 세션
  런타임과 `system-audio-debug.ts`가 guest를 먼저 import).
- CHECK 9 수가 최종이다. 수신 플래그 3(슬롯: 끝, interrupt, 수신 시작), claim 3(슬롯 2와 공유자 자기
  claim), `widener.input` 3(슬롯 1과 파일 재생 경로 2), 원시 플래그 1(`leaveSession` 리셋). 경로 어댑터는
  항목이 없어 직접 쓰면 기준선 초과가 아니라 허락 안 된 쓰기로 실패한다.
- 새 유지 문서 [시스템 오디오 수신 소유](system-audio-receive-ownership.md)(자원, 슬롯 상태, 세 경로와 포트,
  입력, 끝 순서, 붙이기 실패, 마감과 시간 집, 쓰기 규칙, `/debug`와 판독 줄, 틈 14개, 검증)를
  `docs/README.md`에 올리고, `docs/qa-domains.md` QA045·QA046의 진입점과 방법을 고쳤다.

테스트 먼저: `0879d6ec`가 CHECK 9 새 행('경로 어댑터의 직접 쓰기를 허락하지 않음')을 더하고, 별칭으로
부르던 테스트의 import를 슬롯 이름으로 바꿨다(같은 바인딩이라 단언 그대로). 바이트: `0879d6ec` 빌드와
112 청크 모두 해시까지 같다(guest, SFU, 방장이 한 청크라 빠진 재export가 내보내는 코드를 바꾸지 않음).
import-graph 간선 2,069(SFU의 guest import 하나가 빠짐). 단위 671 files / 15,699.

### C4-12 PRO 발행 정리를 이름 붙인 연산 셋으로 (중립, RO-40 은퇴)

테스트 `3867c7e4`, 코드 `cc2510ce`. `src/pro-room/system-audio-service.ts`가 이 기기의 발행을 손으로 베낀
다섯 블록과 부분 블록 둘로 내리던 것(registry 예외 RO-40)을 연산 셋의 조합으로 바꿨다.

- `clearLocalPublicationTimers()`: 리스 하트비트, 리스 해제 재시도, 발행자 재시도, 직접 승격 재시도 타이머
  (이름 그대로).
- `retireLocalMedia(directReset, kept?)`: 단일 SFU 발행자, LAN-direct 경로(`directReset`대로 닫음), 진행
  중인 직접→SFU 승격, 모호한 승격 조정, 실패한 SFU 발행자 재확인. 부분 정리는 남기는 것을 이름으로 적는다
  ('promotion-recovery', 'promotion', 'sfu-publisher').
- `resetPublicationHealth()`: 하트비트 실패 토스트 걸쇠와 LAN-direct 권한 잃음 창. 같은 쌍을 초기화하던
  성공 지점 셋(하트비트, 발행, 받아들인 승격)도 쓴다.

자리마다 조합: 명시적 정지, 리스 잃음(예상된 리스 전환 중에는 전처럼 권한 잃음 창만), 새 presence
incarnation과 서비스 리셋(옛 자리 그대로라 리셋은 로컬 주인을 잊기 전에 코디네이터 그래프를 정리), 끝난
발행자 복구(타이머 없음, 'fallback' 미디어가 승격 복구를 남김), 실패한 발행('fallback'이 승격을 남김),
PRO가 아닌 방 성격(조용한 미디어가 SFU 발행자를 남김, 타이머 없음). 중립인 이유: 모든 자리가 같은 것을
같은 `{notifyPeers, reason}`으로 지우고, 멈추고, 남긴다. 순서 하나가 바뀌었다. 명시적 정지와 실패한 발행이
LAN-direct 초기화 전에 SFU 발행자를 멈춘다(다른 네 자리와 같게). 두 전송은 상태를 나누지 않고, SFU 멈춤의
동기 콜백은 서비스가 무시하는 'publisher-state stopped' 하나뿐이며, LAN-direct 초기화는 아무것도 다시 부르지
않고, 이 길에서 둘 다 로그를 남기지 않으며, 그 사이에 읽는 승격 필드가 없다. 반복 하나: 예상하지 않은 리스
잃음 뒤 권한 잃음 창을 두 번 지운다(그 사이 읽기 없음).

테스트 먼저: `3867c7e4`의 새 묶음 `system-audio-publication-teardown.test.ts`(7행)가 각 진입점 직전에 타이머
넷을 이름으로 걸고, 남는 타이머, SFU 발행자 멈춤 횟수, LAN-direct 초기화와 그 `{notifyPeers, reason}`, capture가
받는 리스 잃음 원인을 고정했다. 전송 사이 순서는 일부러 고정하지 않았다. 끝난 복구에서 타이머를 지우거나
방 성격 갈래에서 발행자를 멈추는 돌연변이는 실패한다. 핵심 프로필에 등록했다. registry: RO-40 삭제(47 → 46
records), RO-20이 연산 셋과 진입점을 적는다. 커버리지 서비스 64.54/56.59/69.4/68.43(새 묶음 등록 뒤). 단위
15,705 통과(workerd 'bad port' 하나, 혼자 돌리면 통과). 초기 JS 478,206 → 478,210 B(바뀐 청크 해시), 서비스
청크 25,214 → 25,267 B gzip.

### 리뷰 낮음(반영하지 않고 남긴 것)

증분마다 독립 적대 리뷰가 돌았고 모두 승인이었다. 높음과 중간은 없었다. 낮음 가운데 고치지 않은 것:

- T2·T3: 스냅샷 키 고정이 순서에 기댄다(읽는 쪽은 이름으로 읽음). PRO 청취자의 `/debug sa` `[Playback]`
  값은 `/debug` 글자로 고정하지 않았다(PRO 증거 묶음은 상태만 본다). 테스트 도우미가 쓰이지 않는 이름 둘을
  내보낸다(생산 dead-exports 수와 무관).
- T4: 새 하한이 실행값보다 약 1점 아래라 서비스 여유가 1점 안이다(C4-5 뒤 50.45 대 50, 53.4 대 53. C4-12
  뒤 64.54로 넓어짐).
- T5: CHECK 9는 별칭 import(`import { setSystemAudioReceiving as x }`)를 보지 못한다. 이 커밋에서 registry
  가드 절과 유지 계약에 그 한계를 적었다.
- C4-1: CHECK 10의 범위 정규식이 지연 전용이 아닌 `system-audio-delivery.ts`, `system-audio-start.ts`,
  `system-audio-debug.ts`도 덮는다(지금은 해당 쓰기가 없음).
- C4-2: 커밋이 실패할 수 없는 방어 갈래가 남았다(커버리지가 덮지 못하는 줄). `isSystemAudioPlaceholder()`가
  guest와 슬롯에 둘이다.
- C4-3: 설계의 testsToRetire(guest 묶음의 프라이머 mock 단언 넷을 슬롯 스냅샷 단언으로)는 하지 않았다.
  `detachSystemAudioRoute`가 붙인 적 없는 경로에 빈 항목을 만든다.
- C4-5: CHECK 4는 armed 시작만 센다. interrupt의 마감 종류는 C4-6부터 필수 인자라 빠뜨리면 타입 오류지만
  'slot'과 'route'의 선택은 가드가 보지 않는다. 직접 마감 해제 둘(붙이기의 지움과 마감 콜백의 확인)은 함께만
  고정돼 있다(C4-5 전부터). PRO 계약 묶음에 'pro-sfu' 경로를 계획하던 옛 주석 셋이 남았다.
- C4-6: handoff '정확히 한 번'은 이제 SFU 단위 묶음의 mock 호출 수로만 고정된다.

## 5B로 간 것과 하지 않은 것

기본값 1에 따라 오늘 동작이나 틈 테스트를 뒤집어야 하는 증분은 5B로 보낼 것이었다. 멈춘 증분은 없다. 네 계약
묶음의 틈 14개는 모두 오늘 동작 그대로 통과하고, 그것을 고치는 일은 5B에 남는다
([틈 목록](system-audio-receive-ownership.md#todays-gaps)). 각 증분이 일부러 하지 않은 부분은 다음과 같다.

| 5A가 하지 않은 것                                                                                                                      | 이유와 갈 곳                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 붙이기 울타리(슬롯이 끝났거나 다른 주인이면 붙이지 않음)                                                                               | 틈 2(S9), 3(PRO S8b)을 고치는 동작 변경. 5B 묶음 (1). C4-3·C4-5는 경로 재확인만 남겼다.                                                                                                  |
| 모든 경로를 덮는 슬롯 끝(코디네이터 끝 포트), force-stop이 PRO source·프라이머·구독·대기 재시도를 끝냄, 다른 주인 뒤 PRO SFU 구독 닫기 | 틈 4, 5. 5B 묶음 (2). C4-5·C4-7은 경로 범위 끝과 로컬 주인 가드를 그대로 두었다.                                                                                                         |
| Standard SFU 재발행 뒤 실패한 구독의 마감                                                                                              | 틈 1. 5B 묶음 (3)(마감을 다시 걸지, `receive_failed`로 끝낼지는 5B 구성 때).                                                                                                             |
| 이 기기가 공유를 시작할 때 남는 수신 플래그                                                                                            | 틈 6(S11). 5B 묶음 (4).                                                                                                                                                                  |
| 재진입 시작의 복원 지점                                                                                                                | 틈 7. 5B 묶음 (5). C4-5는 LAN-direct 마감을 시작 뒤에 거는 순서를 지켰다.                                                                                                                |
| 경로가 닫힌 것을 슬롯이 듣기(LAN 'stopped', 승격 뒤 PRO SFU 2시간 예산 만료)                                                           | 틈 11, 12. 5B 묶음 (6). 테스트 주석이 'C4-5가 정한다'고 적었지만 중립 C4-5는 오늘 동작을 지켰다.                                                                                         |
| 시도마다 슬롯 마감 하나(RO-04 목표)                                                                                                    | PRO 코디네이터는 'route'로 자기 마감(재구독 백오프, 2.5초 끊김 유예, 직접 수신 마감)을 그대로 가진다. 마감을 슬롯으로 옮기면 알림과 시각이 바뀐다. 그래서 RO-04는 `duplicated`로 남는다. |
| C4-13 공유 뒤 두 번째 멈춤(RO-41)                                                                                                      | P5-D11 B로 5B. F3 단위 재현이 실패 테스트. T8 음성으로 기기 보조 근거는 없다.                                                                                                            |
| 그대로 두는 틈                                                                                                                         | 틈 8(경로마다 다른 알림, P5-D10 A), 9(승격 때 시작 다시, 5P-4 공백을 본 뒤 다시 물음), 13, 14(알림 갈래), 10(RO-21, C4-13과 함께).                                                       |

하지 않는 것(§2.4): C4-9 attachEpoch 울타리(P5-D8 A, PRO SFU 전송 epoch와 isCurrent가 막고 #482가 고정),
C4-10 설계안(G5 9.0.2가 대체), C4-11 Realtime 제어 클라이언트와 운영 smoke(P5-D12 A), C4-14(P5-D13 A),
5A 전 `/debug sa` PRO 구역, 타이머 이름 바꾸기(P5-D7 A), T7 랩(선택).

## 중립성 근거

5A 전 기기 기준선이 없다(아래 실기기로 확인하지 않은 것). 그래서 5A의 중립성은 4A처럼 자동 근거에 기댄다.

- **같은 최종 계약 묶음이 9.0.11 런타임에서도 통과한다.** `c344b46f`의 네 계약 묶음과 그 도우미 둘을 main
  `2d605739`(런타임은 운영 9.0.11 / v784)의 소스 트리에 얹어 돌렸더니 4 files / 116 tests가 PASS였다. 같은
  방법으로 T2·T3·T6의 고정과 C4-3·C4-4 테스트 먼저 행이 든 다섯 묶음(받는 쪽 판독 줄 둘, 보내는 쪽 튜닝 둘,
  START 보내는 자리, 47 tests)도 PASS였다. 같은 파일이 `c344b46f`에서도 같은 수로 통과한다(아래 QA 라운드 2).
  이 묶음들은 슬롯과 매체 집을 import하지 않는다.
- **계약 묶음에서 바뀐 단언은 은퇴한 두 버스 이벤트를 세던 것뿐이다.** Standard와 lifecycle 묶음의 handoff
  수 일곱 개가 '자리표시 유지, handoff 시각부터 슬롯 마감'으로, `receiveTimeouts`는 마감 warn 줄을 세게
  바뀌었고(C4-6 테스트 먼저, 바꾸기 전 코드에서 통과), C4-7 테스트 먼저가 S7 행을 늘리고 하나를 더했다.
  PRO와 pro-transport 묶음에서 빠진 줄은 주석과 import뿐이다. 틈 14개 행의 기대값은 바뀌지 않았다.
- **기기 판독 줄과 `/debug sa`는 T3가 고정한 그대로다.** 직접 통화와 SFU의 연결 줄 두 개는 이제 슬롯이
  같은 글자를 info로 찍는다(경로가 `connectedLog`로 넘김).
- **글자 비교(런타임 `src/`, 테스트 제외, main `2d605739` 대 `c344b46f`, TypeScript 구문 트리).** 관리 타이머
  이름은 371개로 다중집합이 같다. `t()` 키, 로그 문자열, 버스 이벤트의 차이는 모두 이동이나 합침이다.
  `system-audio:delivery-handoff`·`system-audio:receive-timeout`의 emit 둘씩과 리스너 하나씩이 사라졌고
  (C4-6), `visualizer:start` emit 7 → 4와 `ui:show-toast` 26 → 25, `t('system_audio.receive_failed')` 4 → 3은
  세 경로의 수신 시작과 두 마감의 알림이 슬롯 한 곳으로 모인 것이다. 연결 줄 두 개는 위처럼 인자로 옮겼다.
  런타임 diff에 `MSG.` 줄의 변화는 없다.
- **프레임 모양 고정 테스트는 바뀌지 않고 통과한다.** PRO 발행 모양(`src/pro-room/__tests__/system-audio-contract.test.ts`)과
  Standard `SYSTEM_AUDIO_SFU_READY`(`src/network/__tests__/protocol.test.ts`). START 보내는 자리 여섯은 T6
  행동 테스트가 정확한 프레임으로 본다.
- **보내는 쪽 이동(C4-1, C4-12)은 T2와 정리 묶음이 고정한다.** 음악 튜닝, LAN-direct 비트레이트, 정리
  자리마다의 타이머·멈춤·초기화·원인.
- **가드:** dead-exports 테스트 전용 20/20, 자기만 76/76 그대로, bus-pairing 204/204 → 202/202, CHECK 9
  최종 수, RULE D.

## QA 라운드

### 1. 증분별 (2026-10-25~26)

| 검사          | 결과와 범위                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 테스트 먼저   | 위 증분별 절. 모든 테스트 먼저 커밋은 바꾸기 전 코드에서 통과했고, 각 코드 커밋 뒤 수정 없이 통과했다. 증분마다 독립 적대 리뷰가 승인했다(높음·중간 없음).                                                                                                                     |
| 단위 전체     | C4-4 15,686, C4-5 15,690, C4-6 15,694, C4-7 15,698, C4-8 15,699, C4-12 15,705(C4-12만 672 files, 나머지 671 files, `--maxWorkers=6`. C4-12와 C4-2 실행에서 workerd 포트 실패 하나씩, 혼자 다시 돌리면 통과).                                                                   |
| 정적          | 런타임 증분마다 `tsc --noEmit`, `typecheck:tests`, `typecheck:node-scripts`, tooling tsc, `lint:app`, `format:check`.                                                                                                                                                          |
| 가드          | resource-ownership, dead-exports, bus-pairing, import-graph, lifecycle-writes, room-authority-boundaries, source-complexity, declaration-ownership, standard-room-hot-path, navigation-sinks, transport-health. `guard:sw-cache-version`은 bump 전이라 레인에서 설계대로 FAIL. |
| 핵심 커버리지 | 증분마다 슬롯과 경로 파일의 값은 위 절. 하한은 내리지 않았다.                                                                                                                                                                                                                  |
| 빌드 바이트   | 런타임 증분마다 `npm run build`와 `guard:initial-transfer-budget`(아래 초기 JS 예산). C4-7·C4-8은 테스트 먼저 커밋의 빌드와 청크마다 비교했다.                                                                                                                                 |
| Chromium      | C4-4, C4-5, C4-6 뒤 로컬 `e2e/system-audio-controls.test.ts` 5/5(PeerJS 일반방 P2P. PRO 두 브라우저 시스템 오디오 e2e는 없다). C4-3 때는 공유 행 둘이 바꾸기 전 빌드에서도 같은 자리(상태 훅 undefined)에서 실패해 그 환경의 문제로 보았다.                                    |
| SKIP          | 실제 기기, WebKit, 실제 Cloudflare Realtime, C5-0 랩, 전체 `npm run typecheck`와 `build:checked`(아래 라운드 2에서 typecheck는 돌림).                                                                                                                                          |

### 2. main 합침 뒤 (2026-10-26)

검증 대상은 `c344b46f`(origin/main `2d605739` 합침, 문서만)다. 그 뒤 커밋은 이 보고서, 기록, 색인, registry와
유지 계약 문서만 바꾼다. 환경은 위 표와 같다.

| 검사                            | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 단위 전체                       | `vitest run --maxWorkers=6` 672 files / 15,706 tests PASS, FAIL 0(251초). 4D 기록의 main 666 files / 15,594 대비 6 files, 112 tests 많다.                                                                                                                                                                                                                                                                                                                                                                                                          |
| 핵심 커버리지                   | `test:coverage:critical` 87 files / 3,277 tests PASS(main 79 / 3,074), 파일별 하한 유지. 합계 80.25/74.89/86.6/84.15. 슬롯 96.02/91.3/100/97.77, guest 92.67/82.47/98.03/95.12, `system-audio-sfu.ts` 84.35/74.76/95.69/90.84, 서비스 64.54/56.59/69.4/68.43, `pro-system-audio-sfu.ts` 87.35/72.96/94.11/93.05, `pro-system-audio-direct.ts` 39.06/38.14/54.67/43.34, `system-audio-media.ts` 100.                                                                                                                                                |
| 정적                            | `npm run typecheck`(모든 tsc 프로젝트와 그 가드, Worker 포함), `lint`(app, tooling), `format:check` PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 가드                            | resource-ownership(46 records / 439 files. G1 watchdog-off, armed 시작 2, 타이밍 사본 2·의심 1, 같은 값 쌍 25는 보고만, 수신 슬롯 쓰기 3·3·3·1, 매체 튜닝 3곳 모두 집), dead-exports(테스트 전용 20/20, 자기만 76/76, 완전 죽음 0), bus-pairing 202/202, import-graph(397 files, 2,069 간선, 순환 0, RULE D 포함), lifecycle-writes, room-authority-boundaries(직접 읽기 83), source-complexity, transport-health(은퇴 이름 24), declaration-ownership, standard-room-hot-path, navigation-sinks, chunk-pump, release-identity(9.0.11, v784) PASS. |
| SW 캐시 가드                    | `guard:sw-cache-version`은 bump 전이라 설계대로 FAIL. 가드는 v784를 합침 `aab3628b`(bump 줄을 가져온 커밋)에서 세므로 그 뒤의 일곱 파일만 나열하지만, C4-1의 `system-audio-host.ts`, `pro-system-audio-sfu.ts`, `pro-system-audio-direct.ts` 변경도 v784에 없다. 통합의 bump가 5A 전체를 덮는다.                                                                                                                                                                                                                                                   |
| 빌드와 예산                     | `npm run build`, `guard:initial-transfer-budget`, `guard:sw-app-shell`(106 자산) PASS. 초기 JS 478,210 B(아래 초기 JS 예산). 같은 기계에서 main `2d605739` 트리(`git archive`)도 빌드해 쟀다.                                                                                                                                                                                                                                                                                                                                                      |
| 최종 테스트를 9.0.11 런타임에서 | 위 중립성 근거. `c344b46f`의 네 계약 묶음(116 tests)과 판독 줄·튜닝·START 묶음 다섯(47 tests)을 그 도우미 셋과 함께 main `2d605739` 트리에 얹어 PASS, `c344b46f`에서도 같은 수로 PASS.                                                                                                                                                                                                                                                                                                                                                             |
| SKIP                            | 실제 기기, WebKit, 실제 Cloudflare Realtime, 이번 라운드의 Playwright와 C5-0 랩, Worker 단위와 `check:workers`(`cloudflare/` 변경 없음. bump가 App Worker를 바꾸므로 bump 뒤에 돌린다), `build:checked` 전체(bump 전이라 sw-cache-version이 설계대로 실패), PR CI·Codex·exact-main CI·릴리스 smoke(이 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다).                                                                                                                                                                                          |

## Phase 4와 겹침

01:20 완화가 요구하는 기록이다. 나중 기기 라운드가 증상을 경로별로 가를 수 있게 적는다.

- **코드:** 5A 파일 목록에 `src/network/transport/**`(`cloudflare-signaling.ts` 포함), `src/network/host.ts`,
  `src/network/guest.ts`, `src/network/transport-health.ts`, `src/network/peer.ts`가 없다. 4B(닫힘 원인 토큰,
  C5-11·C5-12, P4-D7 B, P4-D9), 4C(C5-6~C5-8, C5-10), 4D(C5-9)는 시스템 오디오 수신 파일을 건드리지 않았다.
- **레인 증상:** 일반방 P2P 시스템 오디오 통화는 데이터 PC 위에서 협상한다(RO-16). 게스트 answer와 ICE
  재시작이 한 직렬 레인을 쓰고, 방장의 직접 통화 준비 판정은 같은 PC의 ICE 상태를 읽는다
  (`system-audio-host.ts`, C5-4 허용 목록). 일반방은 원격 게스트도 이 직접 통화를 쓴다. 그래서 '와이파이가
  바뀐 뒤 시스템 오디오가 안 들린다, 끊긴다'는 제보는 Phase 4(연결 생존, 재시작, 닫힘 원인)와 Phase 5(슬롯의
  붙이기, 정리, handoff, 교체 감시) 어느 쪽 탓일 수도 있다. 먼저 방장 콘솔의
  `[Transport] Logical connection closed (<cause>) for <peerId>` 줄로 레인 쪽을 가른다.
- **레인 밖:** 4B의 P4-D7 B는 PRO 청취자의 보이는 일시정지가 대기 중 재합류 재시도를 끝내게 했고, 5A는
  공유가 끝난 뒤 돌아갈 복원 meta를 슬롯으로 옮겼다. 'PRO에서 공유가 끝난 뒤 YouTube가 안 돌아온다, 멈춘다'는
  제보는 둘 중 어느 쪽 탓일 수도 있다. YouTube 방장 스피커 기준 고침(9.0.8)도 같은 증상 쪽에 걸린다.
- **기기 근거:** 4A~4D 위 기기 근거는 #18 은퇴 확인(9.0.10)뿐이고, 시스템 오디오 실기 항목이 열려 있으며, PRO
  시스템 오디오는 4A 뒤 코드로 실행한 기록이 없다.

## 혼합 버전

known-accepted #13대로 버전 입장 제한이 없고, 오너 정책(2026-10-25 약 16:40 KST)으로 옛 버전 호환은 설계
제약이 아니다. P5-D9 C로 혼합 버전 기기 행은 하지 않는다. 5A는 MSG 리터럴, 프레임 모양, 계약 표지를 바꾸지
않는다(위 중립성 근거).

| 조합                          | 결과                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.0.11 이하 공유자, 5A 청취자 | 받는 쪽 이동은 기기 안 상태만 바꾼다. 같은 START·STOP, SFU READY, PRO 발행 설명자를 같은 순서로 다룬다.                                           |
| 5A 공유자, 9.0.11 이하 청취자 | 보내는 쪽에서 바뀐 것은 매체 값의 집(C4-1)과 PRO 발행 정리의 이름(C4-12)뿐이고 값과 정리 결과가 같다(T2, 정리 묶음).                              |
| PRO 방                        | 발행 모양, 하트비트, 리스 통신이 같다. 옛 구성원과 주고받는 프레임이 같다.                                                                        |
| 업데이트                      | 5A는 업데이트 기계를 바꾸지 않는다. 9.0.12 강제 업데이트와 그 floor가 먼저 나가므로, 5A가 나갈 때 floor 아래 빌드는 새 입장과 재접속이 막혀 있다. |

## 초기 JS 예산

실제 프로덕션 빌드로 잰 값(gzip, `measureInitialTransfer`)과 유지 상한까지의 여유다. 상한은 초기 JS
491,568 B다. 같은 코드도 빌드마다 수십 B 흔들린다.

| 트리                                  | 초기 JS   | 여유     | 진입 스크립트 | 초기 전체 |
| ------------------------------------- | --------- | -------- | ------------- | --------- |
| main `2d605739`(9.0.11 / v784 런타임) | 478,186 B | 13,382 B | 111,431 B     | 556,806 B |
| 5A `c344b46f`                         | 478,210 B | 13,358 B | 111,441 B     | 556,831 B |

두 값은 같은 기계에서 차례로 빌드해 쟀다. main의 진입 청크 `main-Bzl7gsk7.js`(raw 364,761 B)와 초기 JS는 운영
9.0.11 / v784의 generation과 4D 기록 값과 같다. 5A의 진입 청크는 `main-B8dNi_kK.js`(raw 364,769 B, +8 B)이고,
초기 전체 raw는 2,074,912 → 2,074,928 B다. 5A는 초기 JS를 24 B 늘렸고, 그 가운데 코드는 없다. C4-7의 청크
이름 길이(+11 B)와 바뀐 청크 해시의 흔들림이다. 늦은 청크(gzip): `system-audio-sfu` 8,896 → 8,887 B(raw
24,546 → 26,447 B, 이제 방장도 담음), `system-audio-host` 2,365 B는 합쳐져 없어지고 새
`system-audio-receive-slot` 2,851 B(raw 6,412 B), `system-audio-service` 25,461 → 25,267 B(raw 93,816 →
93,059 B). 시스템 오디오 늦은 청크 셋의 합은 main(SFU, 방장, 서비스) 36,722 B에서 5A(SFU, 슬롯, 서비스)
37,005 B로 283 B 늘었고, 청크 수는 112로 같다.

증분별(같은 기계, 앞 증분 빌드와 비교): 9.0.10 바탕 `8244531f` 478,015 → C4-1 478,033, 9.0.11 합침 뒤 바탕
478,185 → C4-2 478,196 → C4-3 478,195 → C4-4 478,192 → C4-5 478,193 → C4-6 478,195 → C4-7 478,206 → C4-8
478,206 → C4-12 478,210 B. C4-7의 +11 B만 해시 흔들림이 아니라 미리 읽기 목록의 청크 이름 길이다(위 세부).
늦은 청크: `system-audio-sfu`(지금 SFU, guest, 방장)와 새 `system-audio-receive-slot`(슬롯, 매체 집),
`system-audio-service`. PRO 방 진입 정적 닫힘(main과 PRO 방 진입 뿌리)은 C4-7에서 568,311 → 568,294 B
gzip(35 chunks)이었다. 이 합은 scratch 스크립트로 셌고 계획 패키지의 577,292 B와 셈법이 달라 앞뒤 차이만
뜻이 있다.

P4-D4 A대로 막는 선은 5% 예비선(가드) 하나이고 통과했다. 로드맵의 '증분당 +300 B'를 넘은 증분은 없다.

## 배포·회복

**배포 대상.** 예정 target `app`, Developer API D1 `false`. App 런타임 입력(`src`, `vite.config.ts`, 통합 bump
때의 `package.json`·App Worker `ADMIN_ASSET_VERSION`·SW 캐시·`index.html`)만 바뀐다. 새 D1 스키마, 비밀,
바인딩, 통신 형식은 없다. 업데이트 창이 뜨는 배포이고, 오너 결정(01:50)대로 자동 게이트가 통과하면 따로
묻지 않고 낸다.

**통합.** 9.0.12와 그 floor 뒤, 그때의 origin/main을 합치고 단위, 핵심 커버리지, 가드, 빌드를 다시 돌린 뒤
마지막 런타임 커밋에서 SemVer와 SW 캐시를 함께 올린다(올리기 직전 origin/main을 다시 본다). 이 보고서 커밋
전 `c344b46f`에서 `git merge-tree`로 `agent/forced-update`와 `agent/old-version-removal-1`을 시험 합쳐 보니
글자 충돌은 없었다. 옛 버전 제거 1차와 같은 파일(registry, `scripts/check-room-authority-boundaries.mts`와 그
테스트, `src/types/index.ts`, `vite.config.ts`, `docs/qa-domains.md`, `file-prepare-pause.test.ts`)은 합친 뒤
가드 수(직접 읽기 83 등)를 다시 맞춰야 할 수 있다.

**되돌리기.** 코드 되돌리기가 기본이다. revert도 더 높은 SemVer와 캐시 epoch로 다시 배포하고, 5A 열차가
되돌리기 단위다([hotfix-procedure.md](../hotfix-procedure.md)의 Rollback). 급할 때의 Cloudflare App 버전
되돌리기는 PRO 입장 정책 계약 표지(9.0.4부터)를 가진 버전까지 된다. 5A 전으로 돌아가면 수신 자리를 다섯
기계가 다시 따로 움직일 뿐 동작, 통신, 저장 형식은 같다. 새 D1·비밀·저장 데이터 마이그레이션은 없다.

## 실기기로 확인하지 않은 것

오너 결정(01:50)대로 기기 근거는 배포의 게이트가 아니다. 아래는 5A 코드로 아직 실행하지 않은 것이다.

- 5A 전 기기 기준선이 없다. v3 세션 2와 Phase 5 단계를 아직 하지 않았고, 그 사이에 4B~4D가 나갔으며
  9.0.12도 5A보다 먼저 나간다. 그래서 첫 세션이 5A 뒤면 Phase 5 기기 전후 비교는 없고, 그 세션 값이 '5A
  뒤 값'으로 5B의 기준선이 된다.
- 설계가 증분마다 적은 기기 확인. C4-2: iOS Safari와 Android Chrome 게스트가 데스크톱 시스템 오디오를 받고,
  STOP이 앞 제목을 되돌리고, 소리 없는 START가 30초 뒤 `receive_failed`. C4-3: Windows Chrome 청취자의
  프라이머(둘째 PC 없음, P5-D6 2 A라 iPhone·Android의 프라이머·unmute 줄로 봄)와 방장 공유 재시작 뒤 2분 동안
  겹친 소리 없음. C4-4: SFU 수신은 직접 경로가 실패해 handoff WARN이 생긴 시도에서만 생긴다(일반방은 원격
  게스트도 직접 통화이고 기기 상한 4라 LAN 넘침 'all'도 없다. 설계의 '셀룰러 원격 게스트가 SFU로 받음'은 오늘
  코드와 다르다). C4-5: PRO 방에서 LAN-direct, 원격 참가 뒤 SFU 승격, 승격 동안의 연속성, iOS 청취자 30초
  백그라운드. C4-12: 데스크톱 Chrome PRO 공유자의 시작, 정지, 다시 시작, 브라우저의 '공유 중지', 탭 전환
  인계, 청취자가 하트비트 하나 안에 끝을 봄.
- 시스템 오디오 열린 기록 항목: 9.0.3 G6, 9.0.2 G5, 9.0.1의 PRO 구독 실패 지속 부분, 9.0.0 PRO 하트비트,
  D01 PRO 공유 중 참가, 8.11.25 공유 중지 버튼 정렬, 4A 항목의 PRO 시스템 오디오 부분. 5A 뒤에는 이 항목들을
  5A 코드로 확인하게 된다.
- 틈 14개(단위 근거만. 2·3·12·14는 기기에서 만들 수 없고 1·4·5·11·13은 어렵다).
- WebKit 레인, 실제 Cloudflare Realtime, PRO 두 브라우저 시스템 오디오 e2e(없음), 혼합 버전 기기 행(P5-D9 C).

### Phase 5 기기 절차 (오너가 나중에 쓸 것, P5-D2 A)

절차는 결과 전에 고정했다. 판정 기준과 기대값은 메인 세션이 따로 보관하고 이 절과 오너 시트에 넣지
않는다(블라인드). 기준선 자체에는 합격·불합격이 없고, 같은 단계를 두 버전에서 쟀을 때만 비교한다. Phase 4
판정(v3)과 Phase 5 기록은 섞지 않는다.

**기기와 규칙.** Phase 4 v3 시트의 기기, 로그, 규칙 R, 확인 3종, 무효, 방 만료, 재생 규칙을 그대로 쓴다. H는
Windows 노트북 Chrome 방장이자 공유자, G1은 iPhone Safari, G2는 Android Chrome이다. PRO 방은 오너의 PRO 방을
쓰고(Claude는 운영 방을 만들지 않음), G는 늘 `musixquare.com/<PRO 방 코드>?mxqrLog=info`로 열어 로그아웃 청취자로
들어간다. PRO 확인은 `/debug sync` 셋째 줄 버전, `/debug console`의 INFO 줄, `/debug` 사진이고, PRO 페이지가
다시 읽히면 규칙 RP(적을 것을 먼저 적고 같은 탭 주소로 다시 들어가 30초 뒤 PRO 확인)다.

**일정.** 세션 0 사전 시험(약 15분, 결과로 쓰지 않음), 세션 2a(Set 2에 2-8 기록 추가, Set 5S, 약 115분), 세션
2b(Set 3·4, 3-9, Set 5P, 약 120분, 5P-6 포함 약 130분). 혼합 버전 행은 하지 않는다(P5-D9 C). 미리 보기 뒤
운영 릴리스가 `src/network/**`, `src/audio/**`, signaling Worker를 바꾸면 2-8 기록과 Set 5S 전부, 수신 파일·PRO
파일·PRO room Worker를 바꾸면 Set 5P 전부, `src/player/**`·`src/youtube/**`·`src/storage/**`면 5S-3, 5S-4, 5P-1,
5P-3, 5P-5를 다시 잰다.

**준비(세션마다).** 3시간 넘는 MP3 D를 H Chrome의 새 창(메모장 쪽 반)에서 틀어 공유 원본으로 쓰고, 그 창이
MUSIXQUARE 창을 가리지 않게 한다. 공유 시작은 앱의 '시스템 오디오 공유' → 'Chrome 탭' → D 탭 → '탭 오디오도
공유' 확인 → '공유'(그 순간이 공유 0초), 공유 중지는 앱의 '공유 중지'(5P-7만 다름). H 소리는 Windows 볼륨을
가장 낮게. 소리 기록은 'D까지 초'(60초 동안 없으면 그렇게), '겹침', '제목'이다. `/debug sa`는 폰이 가로·세로
사진, H는 메모장 파일로 남긴다. 공유 중지 버튼 캡처는 PNG와 바로 뒤 `/debug screen` 파일을 한 쌍으로 남긴다.

**무효와 다시 하기.** D가 멈췄거나 끝남, 공유 창에서 다른 것을 고름, '탭 오디오도 공유'가 꺼짐, Chrome 공유
막대 버튼을 실수로 누름(5P-7 제외), PRO 단계에서 H가 MUSIXQUARE 탭을 떠남, 다른 창이 MUSIXQUARE 창을 가림은
무효다. 끊김 창, 토스트, 저절로 다시 읽힘은 결과로 적는다. 단계마다 최대 3번이다.

**2-8 기록 추가(Set 2 안).** 공유 원본 D. G1에서 D가 들린 뒤 30초에 비행기 모드를 켜고, 공유 0초부터 켠
순간까지 초, G1·G2 D까지 초와 제목, 2-8 동안 G2 소리와 겹침, LTE에서 소리가 돌아온 뒤 G1 `/debug sa` 사진과 H
파일, 공유 중지 뒤 G1·G2가 D를 멈춘 초와 그 뒤 소리·제목을 적는다.

**Set 5S 일반방(세션 2a, 2-8 바로 뒤).** 시도마다 H `[Peers]`에서 G1·G2의 local/remote를 적고, '대기열 [A]로
하고 A를 재생' 뒤 A가 들린 지 30초에 시작한다.

- 5S-1(두 번, 둘 다 local): 공유 시작. D까지 초, 제목, 토스트, A 겹침, D가 들린 뒤 60초의 `/debug sa`, 첫
  시도의 공유 중지 버튼 캡처, 중지 뒤 소리와 제목.
- 5S-2: 공유 30초 뒤 중지하고 바로 다시 공유. 두 번째 D까지 초, 2분 동안 겹침과 끊김.
- 5S-3: 대기열 [A, C]. 공유 30초 뒤 H가 C를 누름. D가 멈춘 초, C까지 초, 겹침, 토스트.
- 5S-4(두 번)·5S-4b(선택, G2): G1을 홈 화면으로 보낸 10초 뒤 공유, 15초 뒤 G1 복귀. 뜬 창·토스트, D까지 초,
  그때 H `[Peers]`의 G1 표시.
- 5S-5·5S-5b: G2(그다음 G1)를 LTE만으로 다시 들어오게 하고 공유. D까지 초, 제목, 토스트, `/debug sa`, 중지 뒤
  소리. 5S-6(선택): remote인 채 공유 중 와이파이를 켬.
- 5S-7: 공유 30초 뒤 G1이 규칙 R로 다시 들어옴. '시작하기'부터 D까지 초, 그때 G1 표시.
- 5S-8(선택, 화면만): 라이트·다크 테마의 공유 중지 버튼 캡처.

**Set 5P PRO 방(세션 2b, Set 3·4와 3-9 뒤).** 준비에서 G1의 블루투스와 홈 화면 앱을 정리하고, G1·G2의
로그아웃(계정 버튼 창 제목)을 확인한다. 시도마다 YouTube 1이 G1·G2에서 들린 뒤 30초에 시작한다. 버튼이 하나인
창은 문구를 적고 누르며, 버튼이 둘인 끊김 창은 '다시 연결' 뒤 규칙 RP다.

- 5P-1(두 번): 공유 시작. D까지 초, 제목, 토스트, YouTube가 멈춘 초, `/debug sa`, 중지 뒤 D가 멈춘 초,
  YouTube 1까지 초와 30초 동안 튀는 횟수.
- 5P-2(늦은 청취자): G1이 방을 나간 30초 뒤 공유, G2가 D를 들은 지 30초 뒤 G1이 같은 탭으로 다시 들어감.
  들어가기 버튼부터 D까지 초, 토스트와 시각, 60초 동안 소리. H 파일에 `ProSysAudioSFU`나 `Promoted`가 있으면 한
  번 더.
- 5P-3: 공유 30초 뒤 G1을 홈 화면에 30초. 복귀부터 D까지 초, 창·토스트, 제목.
- 5P-4: 공유 30초 뒤 G2가 LTE만으로 새 탭에서 들어옴. G2 D까지 초, G1 끊김 시작·끝(H 시계), 겹침, 토스트.
- 5P-5(iPhone 두 번, Android 한 번): 공유 30초 뒤 G1 잠금, 10초 뒤 공유 중지, 그 10초 뒤 잠금 해제.
  YouTube 1까지 초, 소리가 처음 다시 난 뒤 30초 동안 멈춤 횟수와 길이, 이어짐 여부, 창·토스트, 그 뒤 G1
  `/debug sync`의 `EVENTS JSONL`(잘렸으면 '잘림').
- 5P-6(선택, Android USB 디버깅): G2를 LTE로, 검사 창에서 `*cloudflare-realtime*` 요청을 막고 공유. 3분 30초
  동안 G2 토스트와 시각, 제목, 소리. 차단을 푼 순간부터 D까지 초, 차단된 요청 줄 사진.
- 5P-7: 공유 30초 뒤 H가 Chrome 공유 막대의 '공유 중지'로 끝냄. D가 멈춘 초, 제목, YouTube 1까지 초, 토스트.

이 단계들이 근거를 낼 수 있는 기록 항목은 D01(5P-4), 9.0.2 G5의 늦은 청취자(5P-2), 9.0.1·9.0.3의 PRO 구독
실패 지속 부분(5P-6), 4A의 PRO 시스템 오디오 부분(5P-1), 8.11.25 공유 중지 버튼(5S-1, 5S-8)이다. 9.0.0 PRO
하트비트는 이 절차로 닫지 않는다. C4-13은 5P-5의 귀로 들은 값만 근거가 된다(T8 음성).

운영 데이터나 서비스에 장애를 주입하는 검사는 이번 로컬 검증에 포함하지 않았다.

관련 계약: [시스템 오디오 수신 소유](system-audio-receive-ownership.md),
[자원 소유권](resource-ownership-registry.md)(RO-04, RO-20, RO-21, RO-39, RO-41, RO-42),
[4D 보고서](phase4-4d-side-route-owner-2026-10-25.md), [4C 보고서](phase4-4c-link-liveness-2026-10-25.md),
[현재 릴리스 기록](../release-record.md).
