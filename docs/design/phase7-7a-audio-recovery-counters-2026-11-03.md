# Phase 7 7A: 오디오 복구 숫자와 소리 중립 정리 (2026-11-03)

| Field              | Value |
| ------------------ | ----- |
| Status             | 준비됨, 머지 전, 배포 전. Phase 7의 첫 App 열차다(오너 Q2 '셋': 7A, 7B, 7C). 갈래 `agent/p7-7a`는 `agent/p7-t1`(끝 `56d4e2dd`: Phase 7 T0 둘째 PR의 시험 커밋 둘과 T1의 가드·문서 커밋 넷, 릴리스 없음) 위 커밋 열과 이 기록 커밋이다: 7A-2, 7A-3, 7A-4, 7A-6, 7A-1 각각 테스트 먼저 커밋과 코드 커밋, 코드 끝 `dd758372`. 계획의 시작 조건대로 Phase 6 6D가 머지·배포·기록되고 그 머지 뒤 Full E2E와 배포 뒤 smoke가 통과하기 전에는 머지하지 않는다(아래 '머지 전에 할 일'). |
| Base               | main `432d4ae7`(#564, App 9.0.34 / v807의 배포 기록). 그 App 런타임은 운영 9.0.34의 머지 `cd8eaf47`(#563)과 같다(`git diff cd8eaf47 432d4ae7`는 문서 일곱 파일뿐). 이 갈래는 처음 `cd8eaf47` 위에 만들어 QA 라운드 1 ~ 3을 그 SHA에서 돌렸고, QA 라운드 4에서 `432d4ae7` 위로 옮겼다(패치 열여섯 모두 같음, 아래 'SHA 대응'). |
| Version            | 없음. 9.0.34 / v807 그대로다(`guard:release-identity` 'MUSIXQUARE 9.0.34; service-worker cache epoch v807'). App 런타임 경로가 바뀌므로 다음 App 패치와 SW epoch를 함께 올려야 하고(계획의 7A-5), 그 전에는 `guard:sw-cache-version`이 그 이유 하나로 실패한다: '[sw-cache-version] FAIL: committed PWA runtime changes are newer than v807 (cd8eaf47).'와 아래 'Deploy target'의 App 11 파일, 'Bump CACHE_VERSION in scripts/service-worker-asset.ts after these changes, then commit the bump.'(QA 라운드 5). 예상 번호는 9.0.37 / v810이다[추론: 공개 페이지 글꼴 9.0.35 / v808과 6D 9.0.36 / v809가 먼저 나가면. 사이에 다른 App 릴리스가 끼면 하나씩 밀림]. |
| Scope              | 계획 §4.5의 7A-1(숫자와 단계 쓰기 깔때기, 이름표 '의도(진단 표시)': `/debug sync` 줄), 7A-2(C1-I1 시간 집과 준비 상태 술어 하나), 7A-3(C1-I2 a·b), 7A-4(`attemptResume` 필수), 7A-6(닿지 않는 재무장 삭제, E5). 7A-2 ~ 7A-6은 중립이다. 7A-5(버전 올리기와 release-record §2 항목)는 릴리스 단계 몫이라 이 갈래에 없다. 7B·7C의 일은 없다. |
| Deploy target      | `app`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`로 바탕 `432d4ae7`과 코드 끝 `dd758372`를 견준 로컬 git 판정(QA 라운드 5, 운영 App의 머지 `cd8eaf47` 대비도 같음): App 11(`src/app.ts`, `src/audio/context-protocol.ts`, `src/audio/context-recovery.ts`, `src/audio/context.ts`, `src/audio/output-recovery-counters.ts`, `src/audio/ui-sounds.ts`, `src/chat/debug-console.ts`, `src/core/navigation-contract.ts`, `src/core/session-reset.ts`, `src/diagnostics/sync-flight-recorder.ts`, `src/types/index.ts`), PRO room 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 변경 없음. `raise_app_build_floor` false, Developer API D1 false, 바닥 795 그대로. |
| Operations         | 운영에 닿지 않았다. 로컬 git(`git fetch` 한 번), 로컬 시험·빌드·Playwright(127.0.0.1:5591 앱, 5592 PeerJS, trace 끔, 재시도 0)만이고, 사진도 로컬 E2E 빌드와 로컬 PeerJS의 합성 방에서 찍었다. push, GitHub 쓰기, 배포, 운영 방 만들기는 없다. |
| Resource ownership | 새 레코드 없음. RO-01(이 열차의 자원)과 RO-23(페이지 전환 주인)을 같은 변경에서 고쳤다: RO-01 시간 집(7A-2), 단계 깔때기 둘과 관측 잎 `output-recovery-counters.ts`('관측, 주인 아님'), `context-recovery.ts`의 `Resource owner: RO-01` 머리(7A-1), Status의 Phase 0d 문장(이 기록 커밋), RO-23의 pagehide 콜백 한 문장(7A-1), 가드 절 5번(RO-01 시간 집)과 6번(`attemptResume` 필수, 7A-4). 정확한 개수는 모두 그대로다(native resume·suspend 11, 간접 재개 `ensureRunning` 4·`restartAudioContextFromGesture` 2·`probeAudioContextHealth` 5, dead-exports 20 / 76, bus-pairing 202 / 202). CHECK 5의 RO-01 계약에 `scalarHome`이 생겨 보고만 하는 같은 값 짝이 45에서 38이 됐다(RO-01 몫 7 → 0). |

이 문서는 Phase 7 계획의 첫 App 열차 7A의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의 Phase 7 계획(2026-11-01)과
그 영역 조사, 오너 답(2026-11-02 밤)이고, PRE, GO, LP, RL, E 번호와 Q 번호, C1-I 번호는 그 노트와 C1 설계의 번호다. 앞선 Phase 7 단계는 시험만인
T0 첫 PR(#559, main `7b869c35`)이고, T0 둘째 PR과 T1은 이 갈래 아래 `agent/p7-t1`에 쌓여 있다(릴리스 없음, 보고서 없음: `AGENTS.md`). 소유권
결정 기록은 [AudioContext ownership](audio-context-ownership.md)(Proposed, T1이 시작)이다. 이 보고서에서 '중립'은 T0의 주인 표 셋
(`audio-output-recovery-boundary`, `-holding`, `-parity`), 잠금 화면 일시정지 행(`media-session-lock-screen-pause`), 도우미
`__helpers__/audio-output-owners.ts`, T0 둘째 PR의 두 파일, 로컬 Chromium 오디오 lab(`e2e/audio-lab/output-recovery.lab.ts`)이 바이트 그대로
통과하고, T0가 찾은 '알려진 빈 곳' 목록(작업 노트의 `t0-known-gaps-2026-11-02.md`, 아홉 항목)이 그대로라는 뜻이다(아래 'T0 표와 중립 증명').

## 오너 결정 (2026-11-02 밤, 모두 권장)

- **Q2 셋:** Phase 7을 App 업데이트 셋(7A 숫자 표시와 중립 정리, 7B 소리 복구 동작, 7C 안쪽 정리)으로 낸다. 7A는 첫째이고 업데이트 창은
  버전 올리기와 함께 한 번 뜬다. 오너는 만들기 전에 지금 업데이트 창 사진과 앞으로 뜨는 횟수(공개 페이지 글꼴, 6D, 7A, 7B, 7C의 다섯)를 봤다.
- **Q3 (가) 예:** 앱이 멈춘 소리를 다시 살리려고 한 시도, 정해진 시간 안에 안 켜진 횟수, 소리 시계 확인을 기다린 시간을 이 기기 안에서만 세어
  `/debug sync` 창의 머리 열 줄 바로 아래(사건 목록 앞)에 보인다. 서버로 보내지 않는다.
- **Q3 (나) 예:** 크롬 146 이상이 세어 둔 출력 끊김 수(`AudioContext.playbackStats.underrunEvents`)를 그 창을 여는 순간 한 번 읽어 한 줄로
  보인다. 다른 브라우저는 'none'.
- **Q4 남김:** 같은 탭에서 새로고침하면 직전 페이지의 숫자를 한 번 남겨 다음 페이지의 `/debug sync`에 한 줄로 보이고, 창 아래 안내가
  'RAM only'에서 'RAM + tab storage'로 바뀐다.
- **글자 사진 승인(2026-11-02 22:50 무렵 KST):** 오너는 위 셋의 바뀐 뒤 글자를 넣은 사진(휴대폰과 데스크톱, 지금과 바뀐 뒤 나란히, 새 줄
  확대, 창 아래 안내 확대)을 보고 승인했다. 승인한 글자와 자리는 아래 '7A-1 의도한 변경'에 그대로 옮겼다.
- **코드 안쪽 정리 E1 ~ E22 추천대로:** 화면·소리가 그대로인 것들이다. 이 열차에 든 것은 E1(시간 집, 아래 '계획과 달라진 것' 1), E2(숫자 잎과
  단계 깔때기), E5(7A-6으로 앞당긴 죽은 재무장 삭제), E15(`attemptResume` 필수)다.
- **Q16 추천대로:** 6단계 몫의 기기 기준선과 7단계 첫 회차 기기 확인(7B의 '전' 세트)을 7A가 나간 뒤 한 번에 한다. 기기 확인은 게이트가 아니다.

## 증분 한눈에

'부모에서'는 테스트 먼저 커밋을 그 트리 그대로(런타임은 부모의 것) 돌린 결과이고, '코드에서'는 같은 파일을 코드 커밋에서 돌린 결과다.
SHA는 `432d4ae7` 위로 옮긴 뒤의 것이고, 괄호 안은 검사를 돌린 옮기기 전 SHA다(패치가 같다, 'SHA 대응'). 바이트는 운영 빌드의 eager JS
gzip이고 부모 대비다.

| 증분 | 이름표 | 테스트 먼저 → 코드 | 부모에서 | 코드에서 | eager JS gzip |
| --- | --- | --- | --- | --- | --- |
| 7A-2 시간 집과 준비 상태 술어 하나(C1-I1) | 중립 | `e22f7910` → `d336f13c`(`802f5214` → `43513524`) | 가드 자체 시험 3 실패 / 125(2 files), 새 준비 상태 표 14행은 통과 | 이름 붙인 묶음 98 files / 2,504 | 465,434 → 465,380(−54) |
| 7A-3 쓰기만 하는 `fallbackEligible`·`fallbackClaimed`와 쓰지 않는 `'stale-play-lock'` 삭제(C1-I2 a·b) | 중립 | `7ea79f15` → `f7e0f685`(`14833f98` → `30874071`) | 18 실패(키를 뺀 정확 비교 11곳의 행) | 98 / 2,504 | 465,380 → 465,260(−120) |
| 7A-4 `attemptResume` 필수 | 중립 | `43b18d7e` → `00370096`(`eb7785d7` → `bad87990`) | `typecheck:tests` 실패(TS2345, TS2339), vitest 24 / 24 | 98 / 2,505 | 465,260 → 465,259(−1) |
| 7A-6 닿지 않는 재무장 삭제(E5) | 중립 | `f7040c85` → `5a56c387`(`9d1113b8` → `b6c2ce77`) | 25 / 25 통과(중립 고정), 확정이 슬롯을 남기게 바꾼 변이에서 그 행 실패 | 98 / 2,506 | 465,259 → 465,245(−14) |
| 7A-1 숫자, 단계 깔때기, `/debug sync` 줄 | 의도(진단 표시) | `b50b000d` → `dd758372`(`9a5d4d79` → `5775ccf1`) | 새 파일 셋 불러오기 실패와 6행 실패, `typecheck:tests` 19 오류 | 100 files / 2,566 | 465,245 → 466,148(+903) |

부모에서 실패한 이유는 모두 아직 없는 코드다. 7A-2는 가드가 아직 `context-protocol.ts`를 RO-01의 시간 집으로 모른다는 것(같은 이름 사본을 심은
세 행). 7A-3은 결과에 아직 `fallbackEligible: false`가 있다는 것(`context-recovery.test.ts` 6곳과 하네스 5곳의 정확 비교에서 그 키를 뺌). 7A-4는
`probeAudioContextHealth`의 `attemptResume`이 아직 선택이라는 것(형 수준 행 `expectTypeOf(...).toHaveProperty('attemptResume').toEqualTypeOf<boolean>()`).
7A-1은 새 잎 모듈이 없어 새 파일 셋(`audio-output-recovery-counts`, `output-recovery-counters`, `sync-flight-recorder-audio-recovery`)이 불러오기에서
실패하고, `debug-sync-window` 2행(창 아래 안내, 끊김 수를 열 때 한 번 읽음)과 `navigation-contract`(새 키), `page-lifecycle`(pagehide 콜백),
`page-navigation-harness-parity`(고정한 `app.ts` 배선 글자)가 실패했다. 7A-6은 동작을 바꾸지 않는 삭제라 새 행이 부모에서도 통과하는 고정이고,
그 고정이 무엇을 지키는지는 변이로 보였다(확정이 슬롯을 비우지 않게 바꾸면 그 행이 실패). 로그는 저장소 밖 작업 폴더(`mxq-wt/p7-7a-logs`,
오너 PC)의 `7a/`와 `7a1/`에 있다.

## 증분

### 7A-2 시간 집과 준비 상태 술어 하나 (C1-I1, PRE-06, RL-12, E1)

- **바뀐 것:** 새 잎 `src/audio/context-protocol.ts`가 AudioContext 복구의 시간 값 열둘과 준비 상태 술어 하나의 집이다:
  `AUDIO_RESUME_DEADLINE_MS` 500, `AUDIO_CLOCK_SAMPLE_MS` 180, `AUDIO_CLOCK_MIN_ADVANCE_SECONDS` 0.01, `AUDIO_SUSPEND_PREPARE_DEADLINE_MS` 500,
  `AUDIO_LATE_SUSPEND_FENCE_MS` 250, `AUDIO_SUSPEND_WATCHDOG_MS`(= 500 + 250), `AUDIO_SUSPEND_MAX_ATTEMPTS` 2, `AUDIO_RECOVERY_RESUME_DEADLINE_MS` 750,
  `AUDIO_RETIRED_SUSPEND_CLEANUP_DEADLINE_MS` 500, `AUDIO_RECOVERY_GESTURE_WAIT_MS` 1,000, `AUDIO_RECOVERY_CLOCK_REQUIREMENT_WAIT_MS` 5,000,
  `AUDIO_RECOVERY_CLOCK_REQUIREMENT_POLL_MS` 50, 술어 `isAudioContextPrepared`(suspended 또는 interrupted). `context.ts`, `context-recovery.ts`,
  `app.ts`가 이 이름을 가져오고 자기 사본과 인라인 1 s·5 s·50 ms·250 ms가 없어졌다. 같은 500이라도 뜻이 다른 셋은 이름을 따로 둔다.
  두 주인의 술어 `isForegroundRestartPrepared`(`context.ts`)와 `isPreparedState`(`context-recovery.ts`)가 이 하나로 바뀌었다.
- **가드와 기록:** CHECK 5의 RO-01 계약이 `scalarHome: 'src/audio/context-protocol.ts'`와 파일 넷(`context-protocol.ts`, `context.ts`,
  `context-recovery.ts`, `src/app.ts`)을 갖는다. 그래서 집 밖의 같은 이름 사본은 접미사와 상관없이 실패하고, 보고만 하는 같은 값 짝이 45 → 38(RO-01
  몫 7 → 0)이 됐다. registry RO-01 'Timing-constant home', 가드 절 5번, 가드 머리 주석, 결정 기록의 mock 함정 문장을 같은 커밋에서 고쳤다.
- **중립 증명:** 기존 값 고정(`context-health.test.ts`, `context-recovery.test.ts`, 하네스의 500·750·1,000·1,500 ms 행)이 그대로 통과한다. 새
  `audio-context-prepared-state.test.ts`(14행)는 두 주인의 공개 API로 suspended·interrupted·running·closed를 모는 행동 표이고 부모와 코드 커밋
  모두에서 통과한다. 'interrupted'를 술어에서 빼는 변이에서 4행이 실패한다. 시험용 export는 없다(dead-exports 20 / 76 그대로).

### 7A-3 쓰기만 하는 복구 값 삭제 (C1-I2 a·b, PRE-07)

- **바뀐 것:** `ContextResumeResult.fallbackEligible`, `PendingContextRecovery.fallbackClaimed`, `contextResumeResult`의 쓰지 않는 `source` 인자,
  `app.ts` `GestureRecoveryFlightResult.fallbackEligible`과 그 리터럴 다섯, 복구 사유 합집합의 `'stale-play-lock'`(`src/types/index.ts` 한 줄과
  `app.ts` 두 곳). 읽는 곳이 없었다(typecheck). 버스 사건 이름은 그대로다(bus-pairing 202 / 202).
- **중립 증명:** 정확 비교 11곳(`context-recovery.test.ts` 6, 하네스 `audio-context-ownership.test.ts` 5)에서 그 키만 지웠다. 하네스의 다른 줄은
  그대로다. `background-resume`, `demo-output-recovery`, `back-navigation.test.ts`의 'a required audio recovery dialog survives Back'(사유
  `'clock-stalled'`를 직접 냄)이 앞뒤로 통과했다.

### 7A-4 `attemptResume` 필수 (PRE-09, E15)

- **바뀐 것:** `probeAudioContextHealth(options: { attemptResume: boolean; ... })`는 기본값이 없다. 운영 호출 다섯은 이미 값을 줬다. 시험의 인자 없는
  호출 여섯이 옛 기본값 `{ attemptResume: true }`를 직접 준다. 가드 주석과 registry 가드 절 6번이 'resumes when its caller passes
  `attemptResume: true`'로 바뀌었다. 간접 재개 래칫 수는 그대로다.

### 7A-6 닿지 않는 재무장 삭제 (E5, GO-04)

- **바뀐 것:** `app.ts`의 복구 창이 재시도에 실패한 뒤 부르던 `retireForegroundAudioContextRestart`와 `armForegroundAudioContextClockHealthCheck`를
  지웠다(그 자리에 까닭을 적은 주석). transport의 `confirmForegroundRestart`는 `confirmForegroundAudioContextRestartHealth`를 거쳐서만 참을
  돌려주고 그 확인이 슬롯을 비우므로, 그 뒤의 retire는 늘 false였고 재무장에 닿지 않았다.
- **중립 증명:** `context-health.test.ts`의 새 행 'leaves nothing to retire once a restart is confirmed, even after a newer restart starts'가 부모와
  코드 커밋 모두에서 통과한다. `app.ts`를 싣는 단위 시험은 없고(grep) lab 행 (i)·(d-*)는 확정 뒤 실패하는 재시도에 닿지 않는다(읽음). lab 17 / 17과
  그 op 순서가 바탕과 같다.

### 7A-1 숫자, 단계 깔때기, `/debug sync` 줄 (이름표 '의도(진단 표시)', PRE-12, GO-13, LP-12, RL-07, E2)

- **새 잎 `src/audio/output-recovery-counters.ts`(RO-01의 관측, 주인 아님):** 형식 배열 하나(`Float64Array`, 37칸)에 번호 열쇠로 센다. 칸 번호는
  export 상수이고 이름은 지연 독자(`src/diagnostics/sync-flight-recorder.ts`)에만 있다. `core/log.ts`·`core/timers.ts`를 가져오지 않고
  `performance.now()`만 쓴다(mock 함정 규칙). 가져오는 것은 `core/navigation-contract.ts`의 키 하나뿐이다. 식별자, 방 코드, 이름, 파일 이름을 두지
  않는다.
- **세는 자리:** native resume을 출처별로 여덟(`playRequest` 재생 요청 제스처 재개, `playGesture` 재생 범위 제스처 재개, `dialog` 복구 창 자신의
  재개, `auto` 자동 재개, `ensureRunning`, `probe` 재개해도 되는 측정, `retire` 은퇴한 정지 정리, `uiSound` UI 사운드 두 자리), 기한 넘김 열셋
  (`context.ts` 일곱, `context-recovery.ts` 넷, `app.ts` 둘: 1 s 제스처 비행과 5 s 요구 대기), 시계 확인 대기(들어감·나감, 합·최대, 확정·취소·복구 필요),
  native suspend와 둘째 이상 suspend, 탭을 기다리던 시도가 바깥 running 뒤 다시 정지로 간 수, 복구 창 요청(PLAY 쪽, 복귀 쪽), `audio-context-recovered`
  재합류, 거절된 탭, 한 문맥에 동시에 산 lease 수 최대, 탭을 기다리는 동안 UI 사운드가 재개한 수.
- **기한 넘김은 이긴 쪽으로만 센다:** 경주는 `raceAudioRecoveryDeadline(slot, flight, deadline)`을 거친다. 같은 `Promise.race`를 돌려주고, 타이머가
  먼저 풀렸을 때만 그 칸을 올린다(비행이 이기면 그대로). 감시 타이머(정지 감시, 늦은 정지 울타리)와 5 s 요구 대기는 실제로 넘었을 때 센다. 경주나
  감시를 시작할 때마다 '지켜본 경주' 수가 오른다.
- **단계 깔때기:** 두 기계가 단계를 쓰는 자리 서른(`context.ts` 10, `context-recovery.ts` 20)이 함수 하나씩(`setRestartPhase`, `setRecoveryPhase`)을
  거친다. 깔때기는 단계를 바꾼 뒤 잎에 '이전 → 다음'만 알리고, 잎은 대기 시작 시각을 시도 객체 열쇠의 `WeakMap`에 둔다. 주인 상태를 베끼지 않는다.
  잎이 주인의 답이 필요할 때(문맥의 살아 있는 lease 수, 탭을 기다리는 시도가 있는지)는 두 주인이 모듈 평가 때 등록한 읽기 전용 질의를 그 순간
  부른다. 그래서 `ui-sounds.ts` → `context-recovery.ts` 정적 간선이 생기지 않는다. 7A의 '탭 기다림' 질의는 Q9 정의의 근사(단계, 파일 모드, 주인이
  쥠)이고 7B-3이 진짜 holding 질의로 바꾼다.
- **읽는 쪽:** 지연 청크의 `/debug sync`(`src/chat/debug-console.ts`의 `cmdDebugSync`, `sync-flight-recorder.ts`의 머리 열 줄 다음). 크롬 끊김 수는
  창을 여는 순간 `readChromeOutputUnderruns()`가 한 번 읽고, 창이 1초마다 다시 그리는 글과 복사본이 그 읽은 값을 쓴다. 오디오 엔진이 아직 없으면
  읽지 않는다.
- **직전 페이지(Q4):** RO-23 페이지 전환 주인(`src/core/session-reset.ts`의 `initPageNavigation`)의 캡처 단계 pagehide 처리기가 `app.ts`가 넘긴
  선택 콜백 `onPageHide` 하나를 부른다(새 리스너 없음). 콜백 `keepAudioRecoveryForNextPage`는 이 페이지가 하나라도 셌으면
  `sessionStorage['mxqr-prev-audio-recovery']`에 '`<라벨 묶음 판> <빌드> <37칸>`'을 쓴다(pagehide마다 최신 값). 다음 페이지가 시작할 때(`app.ts`
  bootstrap의 PageLifecycle 초기화) `takeAudioRecoveryFromPreviousPage`가 한 번 읽고 바로 지우며, 그 페이지의 내비게이션 종류가 reload일 때만
  메모리에 둔다(sessionStorage는 새로 연 탭에 복제되기 때문). 저장이 거절되면 줄이 없다. 지연 독자는 해석하지 않은 값만 받아, 다른 라벨 묶음 판이나
  깨진 값은 버리고 다른 빌드의 값은 그 빌드 번호와 함께 따로 한 줄로 보인다(이 페이지 숫자에 더하지 않음). 키는 `src/core/navigation-contract.ts`의
  `PREVIOUS_LINK_CLOSE_KEY` 옆 `PREVIOUS_AUDIO_RECOVERY_KEY`다.
- **기록(같은 커밋):** registry RO-01 'Current owners'의 깔때기·관측 잎 문단과 `Resource owner: RO-01` 머리, RO-23의 pagehide 콜백 한 문장.
  `page-navigation-harness.ts`(시험 도우미)가 새 `app.ts` 배선을 그대로 베낀다(그 parity 고정이 요구).

#### 7A-1 의도한 변경 ([화면 바뀜: `/debug sync` 창 줄과 창 아래 안내], 승인한 글자)

승인한 글자(2026-11-02 22:50 무렵 KST)와 자리: `/debug sync` 머리 열 줄(셋째 줄 Client build 그대로, 'Retention: RAM-only …'와 'Privacy' 줄
그대로) 바로 다음, 빈 줄과 `EVENTS JSONL` 앞에 아래 줄이 들어간다. 숫자는 승인 사진의 예시다.

```text
AUDIO RECOVERY (this page, on device, not sent)
Resume attempts: 5 | playRequest:1 playGesture:0 dialog:1 auto:2 ensureRunning:0 probe:1 retire:0 uiSound:0
Deadline fires: 1 | gestureFlow1s:1 (12 races watched)
Time awaiting clock verification: totalMs:640 maxMs:410 | waits:3 confirmed:2 cancelled:0 recoveryNeeded:1
Suspend calls: 1 | second suspends:0 | re-suspended after running:0
Recovery dialog requests: 1 | play:0 return:1 | audio-context-recovered rejoins:1 | taps refused:0
Leases at once (max): 1 | UI sound resumes while waiting for tap: 0
Chrome output underruns: 3 (playbackStats.underrunEvents, read when opened)
Previous page: this tab sessionStorage | app=9.0.34 | resume attempts:4 deadline fires:2 clock wait totalMs:2310 maxMs:1500 dialog requests:1
```

크롬 146 아래, 사파리, 파이어폭스의 끊김 줄은 `Chrome output underruns: none (not reported by this browser)`이고, 창 아래 안내는
`tap edge / ESC to close | RAM only | copied once`에서 `tap edge / ESC to close | RAM + tab storage | copied once`가 된다.

만든 것은 이 글자, 순서, 자리 그대로다. `sync-flight-recorder-audio-recovery.test.ts`의 'reads exactly as the approved picture for the same counts'가
승인 사진과 같은 숫자를 넣어 아홉 줄을 글자 그대로 비교한다. 구현이 정한 것(승인한 글자를 바꾼 것은 없음):

1. **기한이 하나도 넘지 않았을 때:** 승인 사진은 넘은 것이 있는 경우만 보였다. 넘은 것이 없으면 이름 목록이 비므로 ' | ' 없이
   `Deadline fires: 0 (N races watched)`로 쓴다. 넘은 것이 있으면 넘은 이름만 고정 순서로 `이름:수`를 늘어놓는다.
2. **'(N races watched)':** 이 페이지에서 시작한 기한 경주와 감시의 수다(자리 수가 아님). 사진의 12는 예시였다.
3. **아홉째 줄:** 같은 탭 새로고침 뒤에만 있다(Q4 그대로). 새로 연 페이지는 여덟 줄이다.
4. **이름표 열셋:** `playRequestPrepare500ms`, `playRequestResume750ms`, `playRequestWatchdog750ms`, `lateSuspendFence250ms`, `retireCleanup500ms`,
   `ensureRunning500ms`, `probe500ms`, `scopePrepare500ms`, `scopeWatchdog750ms`, `autoResume750ms`, `playGestureResume750ms`, `gestureFlow1s`,
   `clockRequirement5s`. '전' 세트를 모은 뒤에는 이름을 얼린다(바꾼 이름은 새 숫자). 칸이나 이름표 묶음을 바꾸면 `AUDIO_RECOVERY_LABEL_SET`을 올린다.

**실제 창 사진(저장소 밖 `mxq-wt/p7-7a-logs/debug-sync`, 오너 PC):** 코드 끝 `dd758372`의 E2E 빌드(2026-11-03 04:53 KST)를 로컬 미리보기(5591)와
로컬 PeerJS(5592)로 띄워 Playwright Chromium 153 headless(배율 2, 다크, 한국어)로 찍었다. 휴대폰(390 × 844)과 데스크톱(1440 × 900) 각각: 창 1
'로컬 방에서 파일 재생 중 복구 창의 버튼을 누른 뒤'(`Resume attempts: 1 | … dialog:1 …`, `Deadline fires: 0 (1 races watched)`, `Recovery dialog
requests: 1 | play:0 return:1 …`), 창 2 '같은 탭 새로고침 다음 페이지'(내비게이션 종류 reload, 맨 아래 `Previous page: this tab sessionStorage |
app=9.0.34 | resume attempts:1 deadline fires:0 clock wait totalMs:0 maxMs:0 dialog requests:1`), 창 3 '기한이 넘었을 때'(시험용으로 `resume()`이
풀리지 않게 바꿔 1 s 제스처 비행이 넘음: `Deadline fires: 1 | gestureFlow1s:1 (1 races watched)`), 그리고 데스크톱의 'playbackStats가 없는
브라우저'(그 속성만 지운 크롬: `Chrome output underruns: none (not reported by this browser)`). 승인한 모형 아래에 실제 창을 둔 나란히 비교가
`compare-phone.png`, `compare-desktop.png`, `compare-desktop-none.png`다. 창 아래 안내는 두 크기 모두 'tap edge / ESC to close | RAM + tab storage |
copied once'이고 휴대폰은 승인 모형처럼 두 줄로 접힌다. 방 코드는 찍기 전에 000000으로 가렸고 창 글자에는 방 코드가 없었다. 로컬 밖으로 가는 요청은
막고 적게 했는데 0건이었다. 이 로컬 크롬의 끊김 수는 0이었다.

**되돌리기 메모:** 7A-1은 이 갈래의 맨 위라, 그 두 커밋(`b50b000d`, `dd758372`)의 역패치가 7A 머지 상태에 그대로 붙는다. 되돌리면 `/debug sync`의
새 줄과 창 아래 안내가 지금으로 돌아가고 소리·화면은 그대로다. 되돌린 빌드는 키를 읽지 않으므로 이미 쓴 `mxqr-prev-audio-recovery` 값은 그 탭이
닫힐 때까지 남았다가 사라진다(아무도 읽지 않음). 7B가 머지된 뒤에는 7B가 이 숫자 자리를 쓰므로 앞으로 되돌린다(아래 '되돌리기').

## T0 표와 중립 증명

- **바뀌지 않은 파일:** T0 첫 PR의 파일 아홉(`e2e/audio-lab/` 둘, `playwright.audio-lab.config.ts`, `__helpers__/audio-output-owners.ts`, 주인 표 셋,
  `media-session-lock-screen-pause.test.ts`, `vitest.critical.config.ts`)과 `src/audio/__tests__/__helpers__/` 전체, `e2e/` 전체는
  `git diff origin/main agent/p7-7a`가 비었다. T0 둘째 PR의 두 파일(`engine-youtube-audio-handoff.test.ts`, `setup-start-native-resume.test.ts`)과
  `setup-start.test.ts`, `sync-flight-recorder.test.ts`는 `git diff agent/p7-t1 agent/p7-7a`가 비었다. 하네스 `audio-context-ownership.test.ts`는
  7A-3의 `fallbackEligible: false` 다섯 줄 삭제만 있다.
- **통과:** 코드 끝 `dd758372`에서 표 열넷이 271 / 271 통과했다(QA 라운드 5): 주인 표 `boundary` 19, `holding` 11, `parity` 34, 잠금 화면 일시정지 3,
  하네스 65, 엔진 YouTube 오디오 넘김 15, 시작 탭 native resume 5, `setup-start` 3, 7A-2 준비 상태 14, 7A-1 숫자 40과 잎 20, `/debug sync` 줄 22,
  비행 기록기 17, 창 3. 가드 자체 시험 111, `context-health` 25, `context-recovery` 42도 단위 전체 안에서 모두 통과했다.
- **알려진 빈 곳 목록:** 작업 노트의 `t0-known-gaps-2026-11-02.md`는 아홉 항목(창이 떠 있는 동안 다른 것이 먼저 깨운 오디오를 창 버튼이 못 켬,
  UI 사운드를 켠 채 천천히 누른 버튼, 복귀 창의 아주 짧은 두 번 뜸, 두 lease 겹침, YouTube 전환 0.25초 안의 끊김, YouTube 시계 정체 뒤 탭 기다림,
  잠금 화면 일시정지 뒤 재생 등)을 오늘 동작으로 적는다. 그 행을 고정한 시험이 모두 바이트 그대로 통과하므로 열린 것도 닫힌 것도 없다. 파일 자체도
  그대로다(sha256 `f14dc7ce…ab13`, 수정 시각 2026-11-02 10:46 KST, 이 열차 전후 같음).
- **브라우저(로컬 Chromium):** 바탕과 코드 커밋 다섯(7A-2, 7A-3, 7A-4, 7A-6, 7A-1)마다 `background-resume`과 `demo-output-recovery` 4 / 4,
  `back-navigation.test.ts`의 복구 창 행 1 / 1, 오디오 lab 17 / 17이 통과했고, lab의 `[audio-lab]` 관찰 줄(요약 객체와 op 순서, 시각을 지운 것)이
  바탕과 같았다. 코드 끝 `dd758372`에서 다시 같았다(QA 라운드 5).
- **커버리지(핵심 레인):** 바탕 4,501 / 4,501, 코드 끝 4,504 / 4,504(110 files). `context-recovery.ts` 90.99 / 88.66 / 88.57 / 93.37 →
  91.30 / 89.66 / 88.88 / 93.47(문장 / 갈래 / 함수 / 줄, 문턱 89 / 87 / 87 / 92), `context.ts` 89.53 / 84.36 / 95.52 / 91.68 → 89.52 / 84.48 / 95.65 /
  91.86(문턱 88 / 83 / 94 / 90). `context-recovery.ts`의 함수 여유는 1.88점이다(깔때기와 등록한 질의로 함수가 늘었어도 함수 비율이 올랐다).

## 계획과 달라진 것

1. **시간 집이 `src/audio/constants.ts`가 아니라 새 잎 `src/audio/context-protocol.ts`다(E1과 다름).** `context.ts`는 eager `toast` 청크에,
   `constants.ts`는 eager `engine` 청크에 있다. `context.ts`가 `constants.ts`를 가져오면 오디오 상수 모듈 전체가 `toast` 청크로 옮겨 가고
   `engine`이 이름 서른셋쯤을 그쪽에서 가져오게 돼 eager JS gzip이 +170 B였다(시제품, 버림). 잎은 −54 B이고 청크 이름이 그대로다. 새 모듈의
   근거는 `docs/design/source-complexity-ratchet.md`의 '여러 운영 소비자의 계약'(`context.ts`, `context-recovery.ts`, `app.ts`)과 청크 경계다.
   registry RO-01이 그 까닭을 적는다.
2. **갈래 안 순서:** 계획의 열차 안 머지 순서는 7A-1 → 7A-2 → 7A-3 → 7A-4 → 7A-6 → 7A-5다. 이 갈래는 중립 증분을 먼저 쌓고 7A-1을 맨 위에
   올렸다(계획이 허락한 '답이 온 뒤 맞춘다'). 7A PR은 squash로 하나가 되므로 main은 같고, 7A-1이 맨 위라 혼자 되돌리기가 쉽다.
3. **기한 넘김 이름은 열셋이다.** 계획은 열둘(`context.ts` 7, `context-recovery.ts` 3, `app.ts` 2)로 셌다. 만든 것은 `context-recovery.ts`도
   `context.ts`처럼 정지 감시(750 ms)를 따로 세어 넷이다.
4. **7A-1 바이트가 증분 상한을 넘는다.** 아래 '번들 크기'와 '오너에게'.
5. **T0 둘째 PR의 기준선(계획 §4.3 5, PRE-02)과 'T0 첫 PR 시험이 6D 코드에서 통과'는 하지 않았다.** 6D 기록 main이 아직 없어서다. 6D 기록 뒤
   옮길 때 한다(아래 '머지 전에 할 일').

## 정확한 개수 가드

| 검사 | 바탕 `432d4ae7` | `agent/p7-t1` 끝 `56d4e2dd` | `agent/p7-7a` 코드 끝 `dd758372` | 바꾼 증분 |
| --- | --- | --- | --- | --- |
| CHECK 6 native resume·suspend(파일별) | 11 | 11 | 11 | 없음 |
| 간접 재개 래칫 `ensureRunning` / `restartAudioContextFromGesture` / `probeAudioContextHealth` | 없음 | 4 / 2 / 5(T1이 새로 둠) | 4 / 2 / 5 | 없음 |
| `initAudio` 쓰임(보고만) | 없음 | 12 | 12 | 없음 |
| CHECK 5 RO-01 계약 | 파일 둘, 집 없음 | 같음 | 집 `context-protocol.ts`, 파일 넷 | 7A-2 |
| 보고만 하는 같은 값 짝 | 45 | 45 | 38 | 7A-2 |
| dead-exports(test-only / self-only) | 20 / 76 | 20 / 76 | 20 / 76 | 없음(새 export는 모두 운영에서 씀) |
| bus-pairing | 202 / 202 | 202 / 202 | 202 / 202 | 없음 |
| import-graph 순환 | 0 | 0 | 0 | 없음 |

## 번들 크기

운영 빌드(`npm run build`, `measureInitialTransfer`)의 eager 전송이다. 바탕과 두 끝은 QA 라운드 5가 잰 값이고, 증분 값은 옮기기 전 SHA에서
쟀다(런타임 입력이 같다). 진입 청크와 eager 청크 이름 목록은 모든 단계에서 같다(해시만 바뀜).

| 단계 | eager JS gzip | 부모 대비 | eager total gzip | 진입 `main-*.js` raw |
| --- | --- | --- | --- | --- |
| 바탕 `432d4ae7`(깨끗한 빌드, `agent/p7-t1` 끝도 같음) | 465,434 | | 543,709 | 859,737(`main-DVz17rkE.js`, 운영 9.0.34의 진입과 같음) |
| 7A-2 | 465,380 | −54 | | |
| 7A-3 | 465,260 | −120 | | |
| 7A-4 | 465,259 | −1 | | |
| 7A-6 | 465,245 | −14 | 543,519 | 859,554 |
| 7A-1 = 코드 끝 `dd758372`(`build:checked`의 빌드) | 466,148 | +903 | 544,422 | 859,661(`main-Dgobudm6.js`, 옮기기 전 7A-1 빌드와 같은 이름) |
| 7A 합 | | **+714** | +713 | |

`guard:initial-transfer-budget`은 코드 끝에서 eager JS 455.2 KiB gzip, eager total 531.7 KiB gzip로 통과했다(5 % 여유 유지).

- **상한:** 로드맵 상한은 증분 +300 B, Phase 순증 +200 B다. 7A-1이 증분 상한을 603 B 넘는다. 계획의 줄이는 차례대로 재 봤다(같은 빌드 방식,
  변이 갈래는 버림): 출력 글자와 이름표는 처음부터 지연 청크에만 있고, 직전 페이지 저장(Q4)을 빼면 −239 B(465,909), 탭 기다림 중 UI 사운드 셈을
  빼면 −29 B(466,119), lease 수 최대를 빼면 −39 B(466,109), 셋을 다 빼면 −323 B(465,825)다. 셋을 다 빼도 7A-6 대비 +580 B라 상한 안으로 들어가지
  않는다. 남는 약 580 B는 깔때기 둘, 세는 자리 마흔쯤, 잎의 경주 도우미와 칸 번호다. 그래서 계획대로 잰 숫자로 오너가 정한다(Phase 6 Q29 선례,
  '오너에게'). 답 전에는 승인한 그대로 둔다.
- **Phase 7 누적:** T0 첫 PR, T0 둘째 PR, T1은 0 B(시험·가드·문서). 7A까지 +714 B(eager JS gzip). Phase 순증 +200 B는 마지막 열차(7C) 뒤에
  판정한다(계획 §4.2-5). 줄어드는 쪽은 7B(제자리 I11·I12)와 7C(I6, 하위 단계 export 정리)에 있다. 7B의 −0.5 ~ −0.8 KB는 두 lease가 한 파일에 모인
  뒤를 어림한 설계 값이라 제자리 I11에서 다시 재야 한다[추론]. 셈법은 이 Phase의 증분 차의 합이고 Phase 밖 열차(공개 페이지 글꼴, 6D)는 뺀다.

## 혼합 버전

방 안 통신, PRO 요청, 서버 계약, IndexedDB·localStorage 모양은 바뀌지 않는다(`git diff 432d4ae7..agent/p7-7a -- cloudflare/ src/network/protocol.ts
src/core/constants.ts`는 비었다. `src/types/index.ts`는 버스 사건 구역의 복구 사유 한 줄뿐). 숫자와 상수는 기기 안이다. 바뀌는 저장은 Q4의
sessionStorage 키 하나다. 업데이트를 적용하는 새로고침에서 9.0.34 이하 빌드는 키를 쓰지 않으므로 새 빌드는 직전 페이지 줄이 없고, 뒤 열차(7B, 7C)가
칸이나 이름표를 바꾸면 `AUDIO_RECOVERY_LABEL_SET`을 올려 옛 값을 버린다. 같은 판의 다른 빌드 값은 그 빌드 번호로 따로 보인다. 바닥은 795 그대로이고
올리지 않는다.

## 되돌리기

- 새 경계가 없다(표지, D1, 저장 모양, 바닥 그대로). 실패 자동 복구의 checkpoint App은 바로 앞 App(예상 6D, 795 이상)이라 `lower`가 필요 없다.
- 7A는 7B가 머지되기 전까지만 혼자 되돌릴 수 있다(7B가 7A의 시간 집과 숫자 자리를 씀). 그 뒤에는 7A부터 가장 최근 열차까지 앞으로 되돌린다
  (새 `agent/` 갈래, 커밋 역순 되돌림, 다음 SemVer·epoch, 전체 게이트, App 릴리스, 기록). 앞으로 되돌리기와 앞으로 고치기는 각각 업데이트 창 하나를
  Phase 7의 셋 밖으로 더한다.
- 7A-1만 되돌리기는 위 '되돌리기 메모'. 중립 증분 하나만 되돌리는 것도 각 두 커밋의 역패치로 되지만 7A-1이 7A-2의 시간 집과 7A-3 뒤의 결과 모양
  위에 있으므로 7A-1을 먼저 되돌린다.
- 배포 몇 분 뒤 낮은 epoch로 가는 App 손 되돌리기의 규칙은 아직 정해지지 않았다(release-record §1 서두). 그 전에는 `docs/hotfix-procedure.md`를 따른다.

## 열린 항목

release-record는 이 갈래에서 고치지 않았다. 7A-5(버전 올리기 앞의 기록 커밋)가 §2에 이 열차 항목(배포 전)을 더하고, '의존성·호환' 칸의 '저장 키
변경'에 sessionStorage 키 `mxqr-prev-audio-recovery` 하나를 적는다. 계획이 7A에 걸어 둔 기존 열린 항목은 8.11.12 R 뒤로가기('오디오가 잠시 멈췄어요'는
뒤로가기로 닫히지 않음)의 자동 근거 하나이고, `back-navigation.test.ts`의 그 행이 7A-3 앞뒤와 코드 끝에서 통과했다. 기기 근거가 없으므로 어느 항목도
지우지 않는다.

## 머지 전에 할 일 (릴리스 담당)

1. **시작 조건:** 6D가 머지·배포·기록되고, 6D의 머지 뒤 Full E2E 수동 실행과 배포 뒤 smoke가 통과한다(계획 §1.5). 오너가 본 순서대로 공개 페이지
   글꼴 업데이트가 먼저 나가면 그 열차의 같은 조건도 지난다.
2. **6D 기록 main 위로 옮기기:** `git rebase --update-refs`로 두 갈래를 함께 옮긴다. 충돌이 예상되는 곳은 6D가 고친 `scripts/check-resource-ownership.mts`
   (CHECK 5 계약 목록, CHECK 11·12), 그 자체 시험 `resource-ownership-guard.test.ts`(RO-02 상태 글자), registry, `docs/README.md` 증거 목록 맨 위다.
   옮긴 뒤 다시 돌릴 것: 6D-4가 PRO 관문을 읽는 방식을 바꾸므로 T0 둘째 PR의 `engine-youtube-audio-handoff.test.ts`(계약 (b) parity)와 `player.ts`의
   관문 처리기 다시 읽기, 가드 자체 시험, T0 둘째 PR의 기준선(PRE-02: 단위 수, eager, `test:e2e:critical`, `demo-output-recovery`·`background-resume`
   3회, 핵심 커버리지, 가드·mock 수, CI 시간)과 'T0 첫 PR 시험이 6D 코드에서 통과', 이 보고서의 전체 로컬 관문.
3. **PR 나누기:** T0 둘째 PR(`c95ddd6b`, `835475d2`)과 T1(`b100bd35` ~ `56d4e2dd`)은 릴리스 없는 PR(하나로 묶어도 됨, 보고서 없음)로 먼저 넣고, 7A PR은
   그 위에서 연다. 열차 창(머지부터 기록까지) 안에는 어떤 PR도 넣지 않는다.
4. **바이트 결정:** '오너에게'의 질문 하나에 답을 받는다(답 전에는 승인한 그대로).
5. **7A-5:** 버전 거울 여섯과 `index.html` 캐시 쿼리를 다음 패치·epoch로 올리고(예상 9.0.37 / v810, bump 직전 origin/main을 다시 봄), release-record §2
   항목을 더한 뒤 버전 올리기 머리에서 전체 로컬 관문을 다시 돌린다. `raise_app_build_floor` false, Developer API D1 false.

## 배포 뒤 확인 (블라인드, 게이트 아님)

- 어느 기기든 `/debug sync`를 한 번 열어 'AUDIO RECOVERY' 여덟 줄이 머리 열 줄 다음에 있고 셋째 줄 버전이 새 빌드인지, 같은 탭 새로고침 뒤
  'Previous page' 줄이 한 번 보이는지 본다.
- 이 빌드에서 계획 §7의 D1 ~ D9, D13, D14를 한 번 돌린 기록이 7B의 '전' 세트다(약 2시간 25분[추론], Q16에 따라 6단계 몫과 한 번에). 단계마다
  `/debug sync`(숫자 줄 포함)와 `/debug console`을 복사한다. 판정 기준은 확인하는 사람에게 주지 않는다. 7B는 이것을 기다리지 않는다.

## 사용자가 알아챌 변화

- 업데이트 창 한 번(나중에·적용하기, 모양 그대로). Phase 7의 셋 가운데 첫째다.
- `/debug sync`를 여는 사람만: 새 줄 여덟(같은 탭 새로고침 뒤 아홉)과 창 아래 안내의 'RAM + tab storage'. 그 밖의 화면과 소리는 그대로다.
- 서버로 보내는 것은 없다. 탭에 남기는 것은 숫자와 빌드 번호뿐이다(방 코드, 이름, 파일 이름 없음).

## 기록과 레지스트리

- registry: RO-01(시간 집, 깔때기와 관측 잎, `Resource owner: RO-01` 머리, 이 기록 커밋에서 Status의 'Phase 0d의 앱 몫을 7A-2가 넘겨받음'과
  기기 안 숫자), RO-23(pagehide 콜백), 가드 절 5번·6번, 배포 묶음 문단(Phase 7 = App 업데이트 셋, Q2, 이 기록 커밋). RO-36·RO-37·RO-44는 7A에서
  바뀌지 않는다. 색인 행은 RO-02 선례처럼 그대로 둔다.
- `docs/qa-domains.md` QA026 진입점에 7A-1의 숫자 시험과 `/debug sync` 줄 시험(이 기록 커밋).
- `docs/README.md` 증거 목록에 이 보고서(이 기록 커밋). 결정 기록 [AudioContext ownership](audio-context-ownership.md)은 mock 함정 문장만
  고쳤고(7A-2) Proposed 그대로다.
- release-record와 release-history는 고치지 않았다(7A-5와 배포 뒤 기록 PR의 몫).

## 오너에게

- **[화면 바뀜: `/debug sync` 창 줄, 승인하신 그대로 둘지] 첫 로딩 크기.** 승인하신 `/debug sync` 줄을 그대로 만들었더니 앱 첫 로딩이 압축 기준
  903바이트 늘어, 계획이 한 단계에 둔 한도 300바이트를 넘었습니다. 줄일 수 있는 것을 모두 빼도(새로고침 전 숫자 남기기 239바이트, 탭을 기다리는 동안
  효과음 셈 29바이트, 동시에 걸린 정지 수 39바이트) 580바이트 늘어 한도 안으로 들어가지 않습니다. 승인하신 그대로 둘까요?
  - 권장: 그대로 둠. 이유: 빼도 한도를 맞추지 못하고, 빼면 승인하신 'Previous page' 줄이 없어지고 창 아래 안내가 'RAM only'로 돌아갑니다. Phase 7
    전체 한도(+200바이트)는 마지막 업데이트 뒤에 따지고, 둘째·셋째 업데이트가 줄일 쪽입니다(얼마나 줄지는 아직 재지 않음).
  - 다른 답: 새로고침 전 숫자 남기기만 빼기(+664바이트, 'Previous page' 줄 없음, 안내 'RAM only' 그대로), 셋 다 빼기(+580바이트, 그 줄과 효과음 셈과
    정지 수 없음).
  - 사용자에게: 첫 로딩이 약 0.9 KB 늘어납니다(지금 첫 로딩 JS는 압축 기준 약 455 KB).

## SHA 대응

옮기기(`cd8eaf47` 위 → `432d4ae7` 위)는 `git rebase --update-refs`로 했고 `git range-diff`가 열여섯 모두 '='(같은 패치)였다. 트리 차는 main의 문서 일곱
파일뿐이다. 그 뒤 7A-1 코드 커밋에 주석 한 줄(`src/core/navigation-contract.ts`, 남기는 값은 '다섯 합'이 아니라 '모든 칸')을 고쳐 넣었다(`b3651ab1`
→ `dd758372`, 빌드 결과 같음: QA 라운드 5의 진입 청크 이름과 eager 바이트가 옮기기 전 7A-1 빌드와 같음).

| 커밋 | 옮기기 전 | 옮긴 뒤 |
| --- | --- | --- |
| T0 둘째 PR: 엔진 YouTube 오디오 넘김, 계약 (a)(b) | `e529e5d4` | `c95ddd6b` |
| T0 둘째 PR: 시작 탭 native resume (c)(c′) | `b2610f9b` | `835475d2` |
| T1 가드 시험 먼저 | `c34bf2d3` | `b100bd35` |
| T1 간접 재개 래칫 | `450482b8` | `8ea13eea` |
| T1 결정 기록 시작 | `b19abbb3` | `4837a8e2` |
| T1 RO-01, QA025·QA026 | `47d7845a` | `56d4e2dd` |
| 7A-2 시험 → 코드 | `802f5214` → `43513524` | `e22f7910` → `d336f13c` |
| 7A-3 시험 → 코드 | `14833f98` → `30874071` | `7ea79f15` → `f7e0f685` |
| 7A-4 시험 → 코드 | `eb7785d7` → `bad87990` | `43b18d7e` → `00370096` |
| 7A-6 시험 → 코드 | `9d1113b8` → `b6c2ce77` | `f7040c85` → `5a56c387` |
| 7A-1 시험 → 코드 | `9a5d4d79` → `5775ccf1` | `b50b000d` → `b3651ab1` → `dd758372`(주석) |

## QA 라운드

환경은 모두 Windows 11, Node 24.22.2, npm 12.0.2, vitest 5.0.3(`--maxWorkers=4`), Playwright Chromium(lock의 판, 153) headless, 포트 5591·5592,
trace 끔, 재시도 0이다. 로그는 저장소 밖 `mxq-wt/p7-7a-logs`(오너 PC)에 있다.

### 1. T0 둘째 PR과 T1 (옮기기 전 `e529e5d4` ~ `47d7845a`, `cd8eaf47` 위, 2026-11-02 22:45 ~ 23:36 KST)

- T1 테스트 먼저: 가드 자체 시험의 새 다섯 행이 부모에서 5 / 5 실패(나머지 103행은 건너뜀), 코드 커밋에서 108 / 108.
- T0 둘째 PR: 새 행이 모두 오늘 코드에서 통과하고(계약 (b) 14 순서, (c′) 다섯 갈래), 변이 넷에서 실패했다(엔진이 pending pause를 무시하면 관문
  14행 중 7, `applySettings`가 `audio:apply-youtube-volume`을 내면 (a), `ensureRunning` 앞의 await는 탭 행 3, emit 앞의 prime은 (c) 단언). 결정성:
  그냥 두 번과 shuffle seed 7, 31, 4242, 20261102에서 23 / 23씩.
- typecheck, lint, format:check 통과. `npm run build`와 guard 37 통과(`guard:sw-cache-version` PASS: 시험·스크립트·문서만이라 v807이 덮음),
  `check-resource-ownership`과 `--report` 통과.
- 단위 전체: 754 files / 18,030 중 18,024 통과, 6 시간 초과는 모두 `sw-cache-version-guard.test.ts`(git 고정물, 15 s, 전체 부하). 그 파일 혼자
  `--maxWorkers=1`로 53 / 53.

### 2. 7A 중립 증분 (옮기기 전 `802f5214` ~ `b6c2ce77`, 2026-11-02 23:41 ~ 11-03 02:24 KST)

- 증분마다 테스트 먼저를 부모에서(위 '증분 한눈에'). 이름 붙인 묶음(`src/audio`, `src/player`, `setup-start` 둘, 가드 자체 시험,
  `system-audio-receive`, `context.ts`를 factory로 mock하는 40 파일, 98 files)이 2,504 ~ 2,506 모두 통과, 빌드와 guard 37과 ownership이 모두 통과
  (`guard:sw-cache-version`만 실패, 버전 올리기 전이라), 바이트(위 '번들 크기').
- 로컬 Chromium: 바탕 `47d7845a`와 코드 커밋 넷에서 `background-resume`+`demo-output-recovery` 4 / 4, 복구 창 뒤로가기 행 1 / 1, 오디오 lab 17 / 17,
  lab 관찰 줄 바탕과 같음, 끝난 뒤 5591·5592 리스너 0.
- 핵심 커버리지: 바탕 4,501 / 4,501, `b6c2ce77` 4,503 / 4,503. 단위 전체(`b6c2ce77`): 18,049 중 18,040 통과, 9 시간 초과(git 고정물:
  `sw-cache-version-guard` 8, `release-deployment-state` 1). 각 파일 혼자 53 / 53, 105 / 105. typecheck(모든 프로젝트), lint, format:check 통과.

### 3. 7A-1 (옮기기 전 `9a5d4d79`, `5775ccf1`. 검사 일부는 앱 빌드 입력이 같은 앞 판 `ecb2c1d4`, 2026-11-03 02:36 ~ 03:57 KST)

- 테스트 먼저: 부모 `b6c2ce77` 코드에서 새 파일 셋 불러오기 실패와 6행 실패, `typecheck:tests` 19 오류.
- 이름 붙인 묶음(위 98 files와 새 파일들) 100 files / 2,566 통과. 빌드, guard 37, ownership 통과(`guard:sw-cache-version`만 실패). typecheck, lint,
  format:check 통과. 핵심 커버리지 4,504 / 4,504.
- 단위 전체(`ecb2c1d4`): 18,135 중 3 실패. `page-navigation-harness-parity`(고정 글자를 시험 커밋으로 옮겨 `5775ccf1`에서 고침)와 git 고정물 시간 초과
  둘(혼자 105 / 105, 53 / 53). `5775ccf1`에서 `src/core/__tests__`와 새 파일, diagnostics, chat(고정물 두 파일 빼고) 178 files / 3,763 통과.
- 로컬 Chromium 4 / 4, 1 / 1, 17 / 17, lab 관찰 줄 바탕과 같음. 바이트 변이 넷(위 '번들 크기'). 첫 실제 창 사진(데스크톱, QA 라운드 6이 다시 찍음).

### 4. main `432d4ae7` 위로 옮김 (2026-11-03 04:01 KST)

- `git rebase --update-refs origin/main`, 충돌 없음. range-diff 열여섯 모두 '='. 옮기기 전 끝 `5775ccf1`과 옮긴 끝 `b3651ab1`의 트리 차는 main의
  문서 일곱 파일뿐.
- 주석 고침을 7A-1 코드 커밋에 넣음(`dd758372`, `prettier --check` 통과). 빌드가 바뀌지 않음은 QA 라운드 5가 보였다.

### 5. 전체 로컬 관문 (`432d4ae7` 깨끗한 빌드, `agent/p7-t1` 끝 `56d4e2dd`, `agent/p7-7a` 코드 끝 `dd758372`, 2026-11-03 04:05 ~ 04:51 KST)

- **바탕 `432d4ae7`:** `dist`를 지우고 `npm run build`. eager JS gzip 465,434, eager total gzip 543,709, 진입 `main-DVz17rkE.js` 859,737 B.
- **`agent/p7-t1` 끝 `56d4e2dd`(정적 묶음):** typecheck(모든 프로젝트), lint, format:check 통과. `build:checked`의 단계 스물다섯을 하나씩 모두 통과
  (`guard:sw-cache-version` PASS 포함, 런타임 변경 없음), eager는 바탕과 같음. guard 37 모두 통과, `check-resource-ownership`과 `--report` 통과. 가드
  자체 시험과 T0 둘째 PR 파일, `setup-start` 4 files / 131 통과.
- **`agent/p7-7a` 코드 끝 `dd758372`:**
  - typecheck(모든 프로젝트: `typecheck:tests`, Worker, browser-classic, node-scripts, e2e 포함), lint, format:check 통과.
  - `build:checked`의 단계 스물다섯을 하나씩: `guard:sw-cache-version`만 실패(위 'Version'), 나머지 스물넷 통과(빌드, `guard:initial-transfer-budget`,
    `guard:prod-hooks`, `guard:prod-security`, `guard:sw-app-shell` 포함).
  - `test:e2e:candidate`를 그 `build:checked` 출력 그대로: 19 / 19(55 s).
  - guard 37: `guard:sw-cache-version`만 실패. dead-exports 20 / 76(413 files, 2,239 exported bindings), bus-pairing 202 / 202, import-graph 413 files
    0 SCC, source-complexity 통과. `check-resource-ownership`과 `--report` 통과(49 records, 460 production files, native 11, 간접 4 / 2 / 5,
    `initAudio` 12, 같은 값 짝 38).
  - `test:coverage:critical` 110 files / 4,504 통과(위 커버리지), `test:coverage:workers` 69 files / 3,325 통과.
  - 단위 전체 `vitest run --maxWorkers=4`: 759 files / 18,135 중 18,134 통과, 1 실패: `release-deployment-state.test.ts` 'blocks an unselected app when
    a localized build input changes'(34.4 s, git 고정물 시간 초과, QA 라운드 2·3과 같은 종류). 그 파일 혼자(`--maxWorkers=1`) 105 / 105.
  - 단위 표 14 files / 271 통과(위 'T0 표와 중립 증명').
  - `test:e2e:critical`(그 안의 `build:e2e` 뒤) 101 / 101(6.1분). `background-resume`+`demo-output-recovery` 4 / 4, 복구 창 뒤로가기 행 1 / 1, 오디오
    lab 17 / 17(3.2분), lab 관찰 줄(시각 지움)이 바탕과 같음.
  - 로컬 부분 릴리스 판정(위 'Deploy target'). 계약 동결(`cloudflare/`, `protocol.ts`, `core/constants.ts`) 빈 차이.
  - 끝난 뒤 5591·5592 리스너 0, `git status` 깨끗함.

### 6. 실제 창 사진 (`dd758372`, 2026-11-03 04:52 ~ 04:54 KST)

- `build:e2e` 뒤 보통 장면(휴대폰·데스크톱의 창 1과 창 2, playbackStats 없는 데스크톱)과 기한 넘김 장면(휴대폰·데스크톱)을 찍고 승인 모형과 나란히
  묶었다(위 '실제 창 사진'). 로컬 밖 요청 0, 끝난 뒤 5591·5592 리스너 0.

### 7. 이 기록 커밋의 문서 확인 (2026-11-03)

- 이 보고서, `docs/README.md`, registry RO-01 Status와 배포 묶음 문단, `docs/qa-domains.md` QA026을 고친 기록 커밋에서 다시 돌림: (진행 중)

## 하지 않은 것과 확인하지 않은 것

- 버전 올리기, release-record·release-history 기록, push, PR, GitHub CI, 자동 코드 리뷰, Full E2E(머지 뒤 `e2e.yml` 수동 실행), 배포, 운영 확인은
  하지 않았다(릴리스 단계 몫).
- 6D 기록 main 위의 다시 돌림과 T0 둘째 PR의 기준선(PRE-02, CI 시간 포함)은 하지 않았다(6D가 아직 main에 없음).
- 기기 확인은 없다. 얼어붙은 시계는 기기와 브라우저에서 일부러 만들 수 없고, 이 열차의 근거는 하네스, T0 표, 로컬 Chromium lab이다. 로컬 Playwright
  WebKit(Windows)에는 AudioContext가 없어 브라우저 근거는 Chromium뿐이다(T0가 확인).
- 크롬 끊김 수 줄이 실제 기기에서 숫자를 보이는지는 로컬 Playwright Chromium에서만 봤다(0). 'none' 줄은 그 속성을 지운 크롬으로 흉내 냈다.
  사파리·파이어폭스 실기는 보지 않았다.
- `app.ts`의 복구 창 몫(창 요청 셈, 1 s 비행 기한, 5 s 요구 대기)은 단위 이음새가 없어 실제 창 사진과 lab으로만 봤다. 5 s 요구 대기가 실제로 넘는
  장면은 브라우저에서 만들지 않았다(세는 자리는 읽음).
- 바이트 상한은 오너 답을 기다린다('오너에게').
