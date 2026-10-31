# Phase 6 6A: YouTube 시작 시간 집, 시작 타이머 소유자 질의, 검증 복원 하나 (2026-10-31)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 준비됨, 배포 전(App 런타임 증분만). 계획의 6A-1 ~ 6A-4와 열차 리뷰 반영이 브랜치 `agent/p6-6a`에 있다: main `599465dd` 위 17커밋(테스트 먼저 5, 코드 6, 가드만 1, 시험만 4, 주석·레지스트리만 1)과 이 기록 커밋. 버전 올리기(SemVer, SW 캐시 epoch, `index.html`의 bootstrap 캐시 쿼리), release-record §2의 이 열차 항목, 레지스트리의 배포 묶음 문단, PR, 배포와 배포 기록은 이 브랜치에 없고 릴리스 담당이 조립할 때 더한다(아래 '배포 조건과 순서'). QA 라운드 1(테스트 먼저 커밋을 부모 런타임에서 다시 돌림)과 2(마지막 커밋 `b80485f3`의 전체 검사)를 2026-10-31 16:03 ~ 17:19 KST에 했다. 오너 질문 둘이 열려 있다(아래 '오너에게': 처음 받는 코드가 Phase 6 상한 +200 B를 넘음, 계획의 상태 이름 정리를 싣지 않음). 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다                                                                                                                                                               |
| Base               | main `599465dd`(Phase 6 T1 #543와 YouTube 시험 순서 #544 뒤). 운영 App 9.0.27 / v800(`23f29283`, 2026-10-31 04:31 KST 배포) 뒤 main에 들어온 것은 문서(#540), 시험만(#541, #542, #544), 가드만(#543)이라 바탕의 App 런타임 경로는 운영과 같다. 같은 툴체인으로 만든 바탕 빌드의 진입 청크도 9.0.27 운영 smoke가 읽은 것과 이름·크기가 같다(`main-BYFZlrrn.js`, 862,203 B). worktree `mxq-wt/p6-6a`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Version            | 이 브랜치는 SemVer와 SW 캐시를 바꾸지 않는다(`guard:release-identity` 'MUSIXQUARE 9.0.27; service-worker cache epoch v800'). App 런타임 경로 13개가 바뀌므로 내보내려면 다음 패치와 SW epoch를 함께 올려야 하고, `guard:sw-cache-version`이 바로 그 이유 하나로 실패한다(QA 라운드 2). 올리면 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 첫째, 창 모양은 지금 그대로). 바닥(저장·유효 795)은 바꾸지 않는다. 9.0.27 기록이 다음 App 업데이트 9.0.28에 SFU 추측 발행을 적었으므로 6A의 번호는 두 열차의 순서에 따라 릴리스 담당이 정한다                                                                                                                                                                                                                                                                                                                                                                                                          |
| Scope              | 계획 §4.5의 6A-1 ~ 6A-4, 모두 중립. 6A-1(H3, PRE-1, PRE-2, PA-15): 다른 모듈이 시작 타이머를 이름으로 읽지 않고 그 주인에게 묻는다. 6A-2(PRE-5): `resetYouTubeSyncState`가 되풀이하는 직접 지우기 하나와 아무도 걸지 않는 `'yt-mix-snapshot'` 지우기를 지운다. 6A-3(C2-1, PRE-10, PA-04 ~ PA-06, RT-02): YouTube 시작 시간 값을 `src/youtube/constants.ts` 한 집으로 모은다. 6A-4(C2-3, SS-01, PA-13): 여섯 오디오 복원 루프가 새 `src/youtube/iframe-audio.ts`의 검증 복원 하나를 쓴다. 와이어, 서버, 저장 모양, 계약 표지, 의존성, 타이머 이름, 로그 줄, 화면, 소리는 바꾸지 않는다([화면 그대로]). 계획의 6A-3 (가) 상태 열거와 6A-5(버전 올리기·문서)는 이 브랜치에 없다(아래 '계획과 달라진 것')                                                                                                                                                                                                                                        |
| Deploy target      | `app`(예상). `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`, `releaseTargetWorkers`로 `599465dd..b80485f3`을 견준 로컬 git 판정: App 13(`src/player/playlist.ts`, `src/pro-room/playback-authority-hooks.ts`, `src/pro-room/playback-controller.ts`, `src/youtube/`의 `authority-arm.ts`, `constants.ts`, `handlers.ts`, `iframe-audio.ts`, `iframe.ts`, `native-control-authority.ts`, `player-runtime-bridge.ts`, `player.ts`, `sync.ts`, `zero-start.ts`), PRO room 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음. 운영 App `23f29283` 대비도 같은 App 13이고, 운영 PRO room `683074bc`와 나머지 넷 `71f5b96c` 대비 그 Worker들의 런타임 경로 차이는 0이다. 운영을 조회하지 않은 판정이라 릴리스의 부분 릴리스 검사를 대신하지 않는다. `raise_app_build_floor` false, Developer API D1 false(계획 RT-01) |
| Operations         | 운영에 닿지 않았다. 로컬 git, 로컬 시험·빌드·Playwright만 했다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Resource ownership | 새 레코드 없음(새 흐름이 아니라 기존 자원 RO-02, RO-03, RO-12의 주인 이동). 센 코드를 옮긴 커밋이 같은 커밋에서 레지스트리 RO-02(H3 소유자 질의, 시간 집, 받는 쪽 parity 시험), RO-03(시간 집), RO-12(검증 복원, 새 파일 머리 `Resource owner: RO-12`)와 가드 항목 11·12, 기준치를 고쳤다: CHECK 11 44 → 32, CHECK 12 읽기 14 → 11과 지우기 10 → 9, CHECK 5 복사 2 → 1(아래 '정확한 개수 가드'). `node scripts/check-resource-ownership.mts`: 49 records, 450 → 451 production files                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

이 문서는 Phase 6 계획의 첫 App 열차 6A의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의
Phase 6 계획(2026-10-30)과 그 영역 조사, 오너 답(2026-10-30)이고, PRE, PA, RT, SS, C2 번호와 Q 번호는 그 노트의 번호다.
계획의 줄 번호는 `78ec56f5`, `d630269a`, `f8a30068` 기준이라 위치를 모두 기호로 다시 찾았다. 앞선 Phase 6 단계는 시험만인
T0a(#539, #541, #542)와 가드만인 T1(#543)이고, `AGENTS.md`대로 보고서가 없다. 이 보고서에서 '중립'은 T0a의 골든과 고정 행이
바이트 그대로 통과하고, 와이어가 바뀌지 않고, 같은 프레임이 같은 시각에 나간다는 뜻이다.

## 오너 결정 (2026-10-30, 모두 권장)

- **Q1 넷:** Phase 6을 App 업데이트 넷(6A ~ 6D)으로 낸다. 6A가 첫째이고, 업데이트 창은 버전 올리기와 함께 한 번 뜬다.
- **Q3 박자는 각자 그대로:** 소리를 되돌리는 박자 셋을 공용 코드로 옮기되 간격은 바꾸지 않는다. 6A-4가 '명령 → 120 ms → 확인'
  (`'settle-then-verify'`)과 '명령 → 확인 → 120 ms'(`'verify-then-settle'`)를 매개변수로 두고, 두 복구의 해제 앞 복원은 자기
  50 ms 폴을 그대로 쓴다.
- **Q4 C2-1은 첫 업데이트에:** 미뤄 둔 App 쪽 Phase 0d 상수 정리(C2-1)를 따로 내지 않고 6A-3에 실었다.
- **Q18 결함마다 묻기:** 시험이 결함을 재현하면 오늘 동작으로 고정하고 결함마다 따로 묻는다. 이 열차의 새 행은 모두 오늘 동작을
  고정한 것이고 결함으로 적은 행은 없다. PRO 늦은 합류 고정(#539)이 재현한 Q22의 (가) ~ (라)는 오늘 동작 그대로 초록이다.
- **Q6 기준선:** 시간이 될 때 9.0.27 운영에서, 6A 배포 전에 아래 '배포 뒤 확인'의 절차로 한 번 잰다. 게이트가 아니다.
- **엔지니어링 기본값(계획 §9.3 아홉, §9.4 열, 권장대로):** 이 열차가 기댄 것은 Q5(두 2.3 s는 따로 두고 순서 시험으로만 잇는다,
  7,700은 10,000 − 2,300으로 끌어낸다), Q7(소유자 질의는 처음에 소유자 자기 타이머를 읽는다), Q8(시작 소유를 native 보호 목록에
  넣지 않는다), Q9(PRO 넛지 이름 읽기는 남긴다, RO-13), Q10(CHECK 11·12는 resource-ownership 가드 안), Q11(새 test-only export
  없음), Q17(겹친 직접 지우기 하나와 죽은 지우기만 지운다), Q26(새 모듈 `iframe-audio.ts`), Q29(번들 상한을 넘으면 잰 숫자로
  묻는다, 아래 '오너에게' 1)다. Q24(정확 개수 가드)는 이미 정해진 규칙이다.

## 증분 한눈에

'부모에서'는 테스트 먼저 커밋을 그 트리 그대로(런타임은 부모의 것) 다시 돌린 결과(실패 / 그 실행의 행)이고, '코드 커밋에서'는 같은
파일과 코드 커밋이 고친 시험 파일을 코드 커밋에서 돌린 결과다. 둘 다 이 검사가 임시 worktree에서 다시 돌렸다(QA 라운드 1). 실패한
행은 모두 바꾼 행이고, 양쪽 통과를 뜻한 행은 부모에서도 통과했다.

| 증분                         | 항목                              | 테스트 먼저 → 코드                              | 부모에서                                   | 코드 커밋에서      | 가드                   |
| ---------------------------- | --------------------------------- | ----------------------------------------------- | ------------------------------------------ | ------------------ | ---------------------- |
| 6A-1 H3 소유자 질의          | PRE-1, PRE-2, PA-15               | `09a1bb8c` → `faffa69b`                         | 15 / 121(3 files)                          | 211 / 211(5 files) | CHECK 12 읽기 14 → 11  |
| 6A-2 겹친 직접 지우기        | PRE-5                             | `8cc9decc` → `d34b4478`                         | 3 / 112(2 files)                           | 293 / 293(3 files) | CHECK 12 지우기 10 → 9 |
| 6A-3 C2-1 시간 집            | PRE-10, PA-04 ~ PA-06, RT-02      | `d9bee96c` → `4c5ca5e9`                         | 8 / 82(3 files)                            | 438 / 438(9 files) | CHECK 5 복사 2 → 1     |
| 6A-4 C2-3 검증 복원          | SS-01, PA-13                      | `e1a1a4d3` → `5e3edd0c`, `0ec9e8e0`, `0cd720fc` | 1 / 67, 새 시험 파일은 불러오기 실패(27행) | 534 / 534(8 files) | CHECK 11 44 → 32       |
| 리뷰: CHECK 12를 이름마다 셈 | RO-02, 가드 항목 12               | `cd35aed8` → `4a1a7e89`                         | 4 / 68                                     | 68 / 68            | 수 그대로(11, 9)       |
| 리뷰: 오늘 동작 고정         | 시험만 넷                         | `a35e07b9`, `95b03762`, `21f1836a`, `b80485f3`  | 새 행 모두 통과(6A 앞 런타임에서도)        | 해당 없음          | 없음                   |
| 리뷰: 주석·레지스트리        | RO-02, RO-03, RO-12, 가드 항목 12 | `5a3d356b`                                      | 해당 없음                                  | 빌드 바이트 동일   | 없음                   |
| 기록                         | 이 보고서, `docs/README.md`       | 기록 커밋                                       | 해당 없음                                  | 해당 없음          | 없음                   |

## 증분

### 6A-1 H3 소유자 질의 (PRE-1, PRE-2, PA-15)

바탕에서는 `native-control-authority.ts`의 `hasProtectedTransitionOwner`가 일곱 이름(PRO 넛지, `'yt-auto-sync'`,
`'yt-clock-action'`, `'yt-seek-play'`, `'yt-rendezvous-buffer'`, `'yt-rendezvous-play'`, `'yt-rendezvous-calibrate'`)을, `sync.ts`의
수동 아닌 하트비트 보류와 `iframe.ts`의 보조 `YOUTUBE_STATE` 보류·서브 영상 자동 넘김 확인이 `'yt-auto-sync'`를 이름으로 읽었다.

- `player-runtime-bridge.ts`: 새 훅 `isYouTubeAutoSyncPending`. `player.ts`가 설정하기 전에는 false이고, `player.ts`는 자기
  `'yt-auto-sync'` 타이머로 답한다(Q7).
- `native-control-authority.ts`: 등록 포트 `registerYouTubeNativeControlSyncOwnerQuery`. 등록 전에는 false다. `sync.ts`가 이 모듈을
  가져오므로 거꾸로 가져올 수 없어, `sync.ts`가 모듈 끝에서 자기 타이머 다섯(두 상태 동작과 랑데부 세 단계)에 대한 질의를 등록한다.
  follow-up realign(`'yt-rendezvous-follow-up'`)은 옛 이름 목록처럼 넣지 않는다. `hasProtectedTransitionOwner`는 기존 질의 여섯을
  그대로 두고, PRO 넛지는 이름으로 계속 읽고(RO-13 owner-in-place), 이어 두 질의를 옛 목록의 순서로 묻는다.
- `sync.ts`의 하트비트 보류와 `iframe.ts`의 두 확인은 `isYouTubeAutoSyncPending`을 묻는다. 보조 `YOUTUBE_STATE` 보류의
  `isYouTubeZeroStartProtocolActive()` 절반은 계획대로 6B-2 몫이라 그대로다. `player.ts` 자기 읽기, 타이머 이름, 거는 곳은 그대로다.
- 훅 객체 전체를 넘기는 시험 셋에 새 필드를 더했다(`host-local-rendezvous.test.ts`의 대역은 자기가 거는 `'yt-auto-sync'`로 답하고,
  나머지 둘은 그 타이머가 없어 false).
- 가드 CHECK 12 읽기 14 → 11(`iframe.ts` 3 → 1, `sync.ts` 4 → 3, `native-control-authority.ts`는 넛지만 남아 1). import graph에
  간선 하나(`native-control-authority.ts` → `player-runtime-bridge.ts`)가 늘고 순환은 없다. 새 export 둘은 운영 코드가 가져간다.
- 시험(테스트 먼저 `09a1bb8c`): 새 `native-control-owner-ports.test.ts`가 `player.ts`와 `sync.ts`를 불러오지 않은 채 Standard 방장
  native PLAY의 보호 소유자 판정을 본다: 다리 질의가 pending이면 그 이름의 타이머가 없어도 보류, 여섯 이름 가운데 하나의 날
  타이머만 있고 주인이 아니라고 답하면 그대로 결정, `sync.ts`가 등록한 질의가 pending이면 보류. 대조 행과 PRO 넛지 행은 양쪽에서
  통과한다. `youtube-timer-owner-queries.test.ts`에 다리 질의가 2단계 대기 동안 pending이고 대기가 끝나거나 pause가 더 새 대기를
  거두면 아님을 보는 행 하나, `resource-ownership-guard.test.ts`의 운영 글을 고정한 CHECK 12 행 여섯.
- 부모에서 15 / 121 실패: owner-queries 1(`isYouTubeAutoSyncPending`이 없어 TypeError), owner-ports 8(이름을 읽는 부모는 질의를
  무시하거나 등록 포트가 없음), 가드 6(운영 글과 수가 아직 14와 10). T0a H3 진리표를 포함한 owner-queries의 나머지 45행과 owner-ports의
  대조·넛지 행 2는 통과했다. `faffa69b`에서 그 세 파일과 훅 필드를 더한 `host-local-rendezvous.test.ts`(70),
  `zero-start-heartbeat-ownership.test.ts`(20)까지 211 / 211 통과.

### 6A-2 겹친 직접 지우기 (PRE-5)

- `iframe.ts`의 `resetResidentYouTubeSync`가 `'yt-clock-action'`을 직접 지우지 않는다. 같은 동기 실행에서 바로 다음에 부르는
  `resetYouTubeSyncState`가 주인(`cancelClockAction`)으로 그 타이머, 세대, clock-action 로딩 표시를 거둔다. 그 사이에 타이머를
  읽는 코드가 없고 `clearManagedTimer()`는 다른 효과가 없다.
- `player.ts`의 `stopYouTubeMode`가 `'yt-mix-snapshot'`을 지우지 않는다. 그 이름의 타이머를 거는 코드가 없다. 시작 타이머가 아니라
  CHECK 12가 세지 않던 줄이다.
- 남긴 것(Q17): reset의 `'yt-seek-play'` 직접 지우기(아래 '계획과 달라진 것' 4), reset의 `'yt-auto-sync'` 지우기(`player.ts`의
  retire 없이 돎), `player.ts`의 상태 동작 지우기 여섯, `sync.ts`의 넛지 지우기, `leaveSession`의 이름 없는 `clearAllManagedTimers`.
- CHECK 12 지우기 10 → 9(`iframe.ts` 3 → 2). `src/youtube/`의 타이머 호출은 209 → 207(가드 항목 12).
- 시험(테스트 먼저 `8cc9decc`): owner-queries의 PRE-5 행이 `adoptResidentYouTubeOccurrence`가 대기 중인 게스트 clock action을 주인으로
  거두고(`'false clock-action'` 한 번, play 없음) 대기 중인 `'yt-seek-play'`를 지움(play 없음)을 고정한다. 부모와 코드 커밋 양쪽에서
  통과해야 하는 중립 고정이다. 가드 행 셋이 바뀐 운영 글(지우기 9, `iframe.ts` 기준 2)을 본다.
- 부모에서 3 / 112 실패(가드 셋). PRE-5 행을 포함한 owner-queries 47행은 통과했다. `d34b4478`에서
  `stale-async-guards.test.ts`(181)까지 293 / 293 통과.

### 6A-3 C2-1 시간 집 (PRE-10, PA-04 ~ PA-06, RT-02)

`src/youtube/constants.ts`에 새 export 여섯을 두고 Standard zero-start 컨트롤러, PRO arm, PRO 준비 이음새(`iframe.ts`), Standard
복구(`player.ts`), PRO 재생 컨트롤러가 각자의 사본 대신 그것을 읽는다. 숫자는 모두 그대로다.

- `YOUTUBE_ARM_TIMING`: hard-mute 폴 30 ms × 12, warm play 260 ms, pause·seek 간격 80 ms, 정착 폴 80 ms, 정착 허용치 0.12 s, 정착
  박자(연속 2표본, 여섯째 폴마다 다시 seek, 계획 (라)), 오디오 복원 120 ms × 8, 출시 확인 1.8 s, 따라잡기 허용치 40 ms.
  `YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC`는 40 / 1,000으로 끌어내며 옛 리터럴 0.04와 같은 double이다.
- `STANDARD_ZERO_START_BARRIER`: 게스트 대기 3,000, 게스트 결정 2,300, 시작 앞섬 700, 준비 예산 10,000, 늦은 대체 앞섬 800 ms.
  코호트에서 빠진 게스트가 받는 7.7 s는 준비 예산 − 게스트 결정으로 끌어낸다(Q5).
- PRO 준비 예산 둘(`PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS` 2,300, `PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS` 10,000)을
  `iframe.ts`에서 주석과 함께 옮겼다. 2.3 s는 Standard 게스트 결정과 값만 같은 다른 값이라 주석으로만 잇는다(Q5).
- `YOUTUBE_FRESH_START_MAX_SEC`(0.12, 계획 (나)): `handlers.ts` 둘, `player.ts` 둘, `native-control-authority.ts` 하나의 새 시작 문턱.
  같은 값의 정착 허용치와 이름을 나눴다.
- `zero-start.ts`는 자기만 쓰는 타임라인·보정 값만 남기고 머리 주석이 PRO를 섬긴다고 더 적지 않는다. `authority-arm.ts`는 `TIMING`
  사본을 지웠다. `player.ts`의 두 정리 루프의 120 ms·8회, 1.8 s, 초 단위 0.04 비교, 0.12 문턱이 집을 읽는다. 3 s 다리, 0.35 s 정착,
  50 ms 폴은 한 파일만 써서 남는다(계획 (다), 6D-1이 옮김). `playlist.ts`는 무장벽 예산을 집에서, `playback-controller.ts`는 자기
  40 ms 사본 대신 arm의 따라잡기 허용치를 가져온다. 3,000 ms `LATE_YOUTUBE_COMMIT_LEAD_MS`는 PA-06대로 비공개로 남는다.
- `playback-authority-hooks.ts`의 `prepareBudgetMs` 주석이 끝점이 그 값으로 하는 일(값은 읽지 않고 있었는지만 봄)을 적는다(주석만).
- 시험 사본: 늦은 합류 도우미 사본(`pro-late-youtube-join-timing.ts`)에서 40 ms와 1.8 s를 빼고 네 묶음이 `YOUTUBE_ARM_TIMING`을
  읽는다. `playlist.test.ts`는 무장벽 예산을 집에서 읽는다. 단언은 바뀌지 않았다. 레지스트리 RO-03 'Anchor tests'의 그 값 줄도 같이
  고쳤다.
- 가드: `constants.ts`가 RO-02/RO-03/RO-12 시간 계약 파일이 되고 arm 시간 복사 쌍이 없어졌다(CHECK 5 복사 2 → 1). 그 대신 기존
  `constants.ts` 스칼라와 `iframe.ts` 모듈 스칼라의 같은 값 쌍 18이 보고만 하는 목록에 더해졌다(27 → 45). 레지스트리 RO-02, RO-03,
  RO-12가 집과 parity 시험 이름을 적는다. `guard:import-graph`는 `src/pro-room` → `src/youtube/constants.ts` 간선을 더해도 순환 0이다.
- 시험(테스트 먼저 `d9bee96c`): 새 `start-timing-parity.test.ts`가 각 집을 옮기기 전 사본의 리터럴 값으로 고정하고(7.7 s와 0.04 double
  포함), 진짜 zero-start 컨트롤러를 보낼 수 있는 끝값까지 몰아 그 프레임을 받는 쪽(`registerHandler`, `handleData`)에 넣는다:
  PREPARE 창과 그 10 s 상한, Android 출력 지연 250 ms를 실은 ±600 ms ARMED 앞섬, ARMED 위치·볼륨·로드 비율·`preparedMs`, 100 peer
  코호트, TIMELINE 위치. 받는 쪽은 각 끝값을 받고 한 걸음 너머를 버린다. 이 시험은 `cloudflare/`를 가져오지 않는다.
  `pro-room-playback-timing.test.ts`에 2.3 s 장벽 예산이 3 s 장벽 안에 있고 700 ms를 READY 몫으로 남긴다는 순서 행 둘(COMMIT 앞섬과
  값만 같음), 가드 시험에 집 옆의 같은 이름 사본과 다시 적은 arm 시간 객체를 거절하는 CHECK 5 행 둘.
- 부모에서 8 / 82 실패: parity 4(집이 아직 없음), 순서 2, 가드 2. 컨트롤러 출력만 읽는 parity 6행은 부모에서도 통과했다(보내는
  쪽 끝값과 받는 쪽 경계는 오늘도 맞음). `4c5ca5e9`에서 `protocol.test.ts`(81), `playlist.test.ts`(125), PRO 늦은 합류 고정
  넷(`playback-late-cohort-join.test.ts` 8, `authority-arm.test.ts` 77, `pro-late-prepare-reload.test.ts` 7,
  `pro-manual-zero-start.test.ts` 58)까지 438 / 438 통과. 늦은 합류의 40 ms (d) 행, 1.8 s (b) 행, Android (d) 행이 옮기기 전후 그대로다.

### 6A-4 C2-3 검증 복원 (SS-01, PA-13)

새 `src/youtube/iframe-audio.ts`(머리 `Resource owner: RO-12`)는 복원 원시만 갖는다. 상태, 자기 타이머, 로그가 없다.

- `writeYouTubeAudio`: `setVolume` 뒤 `mute` 또는 `unMute`. `isYouTubeAudioRestored`: 같은 음소거 상태, 이어 볼륨 차이 1 이하.
  NaN 볼륨은 맞지 않는다.
- `restoreYouTubeAudioVerified(cadence, canWrite, write, verify, onDone, schedule, canVerify = canWrite)`: 최대
  `YOUTUBE_ARM_TIMING.audioRestoreMaxAttempts`번, `audioRestorePollMs` 간격, 첫 시도는 동기. 두 박자는 따로 남는다(Q3):
  `'settle-then-verify'`(쓰기, 기다림, 확인)와 `'verify-then-settle'`(쓰기와 확인, 그 뒤 기다림). 호출자의 울타리가 모든 쓰기 앞과
  settle-then-verify의 확인 앞에서 돈다. 던지는 쓰기는 그 시도의 확인을 건너뛰고, 던지는 확인은 복원 안 됨이다. 모든 기다림은
  호출자의 schedule로 간다. 그래서 타이머 키·슬롯과 그것을 지우는 곳이 호출자에 남는다.
- 여섯 루프가 박자, 울타리, 확인 술어, 결과, 타이머를 그대로 지킨다:
  - `zero-start.ts` 활성 복원(settle-then-verify): 쓰기와 확인마다 `#getPreparedPlayer` 울타리, `finiteOr`(NaN 볼륨을 복원으로 봄),
    `#markArmed` 또는 마지막 시도의 명령·읽기 오류를 실은 `#failLocalPrepare('audio-restore-timeout')`, 실행 타이머(`#later`).
    분리 복원(settle-then-verify): 세대와 같은 플레이어 울타리, 시도 수를 실은 `'audio-restore-complete'` debug 줄, `onError
'audio-restore-timeout'`, `#detachedAudioRestoreTimer`. 원하는 오디오가 바뀌면 여전히 취소한다.
  - `authority-arm.ts` 활성 복원(settle-then-verify): 쓰기마다 `#ensurePlayerCurrent`(확인 앞에는 없음, 오늘과 같음), 명령 오류는
    삼킴, `#markPrepared` 또는 `'audio-restore-timeout'`, `#later`. 분리 복원(verify-then-settle): 슬롯·세대·같은 플레이어 울타리,
    `#detachedRestoreTimers`. 원하는 오디오가 바뀌면 여전히 재지정한다. `#restoreCapturedAudio`, `#attemptAudioRestore`,
    `#attemptDetachedAudioRestore`와 복원의 attempt 필드가 없어졌다.
  - `player.ts`의 방장 레거시 복구와 게스트 로컬 대체의 검증 정리(verify-then-settle): 세대 울타리, 시도마다 pause와 seek 다시 냄,
    관리 타이머 `'yt-zero-start-host-fallback'`(`scheduleHostFallback`)과 `'yt-zero-start-external-fallback'`을 전처럼 `player.ts`가
    걸고 지운다(`/debug` 타이머 이름 동결, `cancelYtAutoSync`와 `clearAllManagedTimers`가 지우는 키 그대로). `restoreFallbackAudio`와
    `isFallbackAudioRestored`가 없어지고, 두 복구의 해제 앞 복원은 자기 50 ms 폴로 공용 쓰기·확인을 쓴다. 게스트 대체의 해제 쓰기와
    두 복구가 교체·취소된 iframe을 정리하는 쓰기(`cleanupExactPlayer`)도 `writeYouTubeAudio`로 쓴다.
- 호출 모양: 첫 코드 커밋 `5e3edd0c`은 옵션 객체였다. 다음 커밋 `0ec9e8e0`이 같은 복원을 위치 매개변수와 결과 콜백 하나
  (`onDone(restored, attempts)`)로 바꿨다. 이유는 크기다(아래 '번들 크기': `5e3edd0c`은 부모 대비 eager JS gzip +146 B, `0ec9e8e0` 뒤
  6A-4 전체는 −18 B). `0cd720fc`은 주석과 레지스트리 문장만 고쳐 빌드가 바이트로 같다(QA 라운드 2에서 진입 청크 이름과 크기가 같음).
- 가드·레지스트리·커버리지: CHECK 11 44 → 32(`zero-start.ts` 12 → 6, `authority-arm.ts` 10 → 4, `player.ts` 17 → 14, 새
  `iframe-audio.ts` 3, `iframe.ts` 3과 `retained-player-controller.ts` 2 그대로). `iframe-audio.ts`가 RO-02/RO-03/RO-12 시간 계약 파일에
  들고 자기 시간 상수는 없다(CHECK 5 그대로). 레지스트리 RO-12의 현재 주인, 목표 주인, 생명주기, 기한 주인(최대 8번 120 ms 간격,
  호출자 타이머로), 시간 집, 상태(여전히 `duplicated`: 원하는 상태와 hold는 뒤 열차의 C2-2), 가드 항목 11.
  `vitest.critical.config.ts`에 `iframe-audio.test.ts`와 `iframe-audio.ts`를 넣고 파일 문턱 99 / 99 / 99 / 99를 두었다.
- 시험(테스트 먼저 `e1a1a4d3`): 새 `iframe-audio.test.ts`(node 환경)가 쓰기, 확인, 루프의 두 박자와 단계 순서·시각, 8회 상한, 동기
  첫 시도, 울타리, 던지는 쓰기와 확인, 시도 수, 120 ms 기다림만 schedule에 묻는 것, 상태를 나누지 않는 겹친 두 루프를 고정한다.
  가드 `--report` 행이 `player.ts`의 `restoreFallbackAudio` 대신 `iframe-audio.ts`의 `writeYouTubeAudio`를 기대한다.
- 부모에서: 가드 1 / 67 실패, `iframe-audio.test.ts`는 모듈이 없어 불러오기 실패(27행이 모이지 않음). `5e3edd0c`에서 T0a 박자 표
  `youtube-audio-restore-cadence.test.ts`(51), PRO READY 시각 골든(10), 인용 로그 줄(13), `zero-start.test.ts`(155),
  `authority-arm.test.ts`(77), `player.test.ts`(134), `iframe-audio.test.ts`(27), 가드(67)까지 534 / 534 통과.

### 열차 리뷰 반영

중립성, 소유권·가드, 오디오 동작의 세 갈래로 리뷰했고, 그 반영은 시험만 커밋 넷, CHECK 12의 테스트 먼저와 가드 커밋, 주석·레지스트리
커밋이다. 런타임 동작은 바꾸지 않았다.

- `a35e07b9`(시험만): 두 활성 복원의 재지정, 확인 울타리, 정착 재-seek를 고정한다. `zero-start.test.ts`: WebKit이 첫 unMute를 무시하는
  게스트 활성 복원 60 ms에 볼륨을 바꾸면 +120 ms 시도가 `setVolume(55)`를 쓰고 +240 ms ARMED가 볼륨 55를 싣는다. 첫 쓰기 60 ms 뒤
  iframe이 교체되거나 영상이 바뀌면 +120 ms에 ARMED 없이 실패하고 어느 iframe에도 다시 쓰지 않는다. seek가 닿지 않는 게스트는 +820,
  +1300, +1780, +2260에 pause하고 80 ms 뒤 seek한다(여섯째 폴마다). `authority-arm.test.ts`: 같은 볼륨 변경(READY +240 ms, 볼륨 55),
  마지막 복원 기다림 안의 iframe 변경은 취소가 아니라 `'audio-restore-timeout'`으로 끝나고 어느 iframe에도 쓰지 않음, seek가 닿지
  않는 arm은 같은 네 시각에 pause·seek하고 2.3 s 예산에서 `'settle-timeout'`, 재시도 전에 iframe이 바뀐 분리 복원은 거기서 끝나
  `cancelAll()`이 거둘 것이 없고 iframe이 돌아오면 다음 준비가 그 iframe 자신의 볼륨을 잡는다.
- `95b03762`(시험만): 가짜 플레이어에 손잡이 `__unMuteThrowCount`(받아들인 unMute가 효과를 낸 뒤 던짐, 기본 꺼짐)를 더하고 T0a 박자 표에
  'unMute throws x1'을 더해 일곱 루프마다 행을 둔다: zero-start와 arm의 활성·분리 복원은 자기 쓰기에서 오류를 잡고 그 시도를 확인해
  첫 확인에 복원, 두 정리는 그 시도의 확인을 건너뛰고 120 ms 뒤 다시 씀, 게스트 해제 앞 복원은 50 ms 뒤 다시 폴. 기존 행과 배열은
  바뀌지 않았다.
- `21f1836a`(시험만): `player.test.ts`에 Standard 방장의 음수 시작 출시(`'yt-host-local-start'`)가 40 ms 늦으면 seek 없이 잡은 위치에서
  재생하고 늦음을 적용 오프셋(−9.789)과 자동 오프셋(0.21)에 넣으며, 41 ms 늦으면 먼저 0.041로 seek하고 둘을 지킨다(−9.749, 0.25)는
  행 둘. 초 단위 늦음과 ms 단위 허용치를 비교하는 실수(6A-3이 피해야 했던 것)를 잡는다. owner-queries에 follow-up realign만 남은
  동안 native PLAY(:213)와 PAUSE(:496)가 곧바로 결정된다는 행 둘(`sync.ts`의 등록 질의가 follow-up을 빼는 것).
- `cd35aed8` → `4a1a7e89`(테스트 먼저, 가드만): CHECK 12가 남의 시작 타이머 읽기·지우기를 호출마다 한 번이 아니라 그 호출이 가질 수
  있는 시작 타이머 이름마다 센다. 6A-1이 넛지 읽기의 이름 목록에서 지운 여섯 이름을 되넣으면 이제 'RATCHET REGRESSION ...
  native-control-authority.ts has 7, baseline 1'이다. 기준치는 그대로다(이 트리의 센 호출은 모두 이름 하나).
- `5a3d356b`(주석·레지스트리만): CHECK 11의 이유 글과 RO-12 문장이 `writeYouTubeAudio`의 모든 호출자를 적고, RO-02 기한 주인, RO-03
  시간 집, 가드 항목 12(`src/youtube/` 타이머 호출 205)를 6A-4에 맞췄다. `sync.ts`의 두 목록이 서로를 가리키고,
  `stale-async-guards.test.ts`의 한 주석이 6A-2가 지운 줄을 더 인용하지 않는다. 빌드는 바이트로 같다.
- `b80485f3`(시험만): `fake-yt-player.test.ts`가 새 손잡이를 고정한다(무시된 unMute는 던지지도 세지도 않음).
- 근거: 이 넷의 새 행은 모두 부모(6A 런타임)에서 통과하고, 6A 앞 런타임에서도 통과한다. 임시 worktree에서 `b80485f3`의 시험 위에
  `599465dd`의 런타임 13 파일을 되돌리고(`authority-arm.test.ts`가 가져오는 집 한 줄만 6A 앞 사본이 들던 리터럴 40과 1,800으로 바꿈)
  돌린 결과: `zero-start.test.ts` 159 / 159, `authority-arm.test.ts` 82 / 82, 박자 표 58 / 58, `player.test.ts` 136 / 136,
  `fake-yt-player.test.ts` 12 / 12, owner-queries 48 / 49, owner-ports 2 / 10. 실패 아홉은 모두 6A-1의 소유자 질의를 요구하는 6A-1
  테스트 먼저 행이다. 그래서 이 행들은 6A가 바꾸지 않은 오늘 동작을 고정한다.

## 계획과 달라진 것

1. **줄 번호:** 계획 인용은 옛 SHA 기준이라 모든 위치를 기호로 다시 찾았다.
2. **6A-3 (가) 상태 열거를 싣지 않음:** `YOUTUBE_PLAYER_STATE`가 없다. `zero-start.ts`의 `YOUTUBE_ZERO_START_PLAYER_STATE`와
   `authority-arm.ts`의 `PLAYER_STATE`가 비공개로 남고, `player.ts`의 플레이어 상태 읽기도 숫자 그대로다. 커밋에 이유가 적혀 있지 않다.
   이 브랜치를 만드는 동안 6A-3 코드 커밋(`4c5ca5e9`) 위에 (가)를 얹은 커밋하지 않은 빌드는 eager JS gzip 466,786 B로 그 커밋보다
   +50 B였다. 이 검사는 그 측정을 다시 하지 않았다(그 실험 패치는 6A-4 뒤의 `authority-arm.ts`와 충돌). 6A-3만으로 Phase 순증 상한을
   넘으므로(아래 '번들 크기') (가)는 그 위에 더 얹힌다. 동작과 와이어는 어느 쪽이든 같다(값 −1, 0, 1, 2, 3, 5). 계획의 Q4 대안 가운데
   '상태 열거를 각 파일 비공개 열거로 남김'과 같은 상태다. 오너에게 묻는다(아래 '오너에게' 2).
3. **6A-5(버전 올리기와 문서)가 없음:** 이 브랜치의 범위가 런타임 증분이라서다. 릴리스 담당이 더한다(아래 '배포 조건과 순서',
   '기록과 레지스트리').
4. **6A-2의 `'yt-seek-play'` 줄:** 계획은 `resetResidentYouTubeSync`의 겹친 두 줄을 지우게 했다. `'yt-seek-play'` 줄은 남겼다:
   `stale-async-guards.test.ts`의 YouTube → YouTube 재사용 회귀 행이 `sync.ts`와 `core/timers`를 mock하고 그 지우기를 단언한다. 그래서
   CHECK 12 지우기는 10 → 8이 아니라 10 → 9다.
5. **6A-4 호출 모양:** 옵션 객체 꼴이 부모 대비 +146 B여서 같은 동작을 위치 매개변수로 다시 썼다(위 6A-4).
6. **CHECK 12의 셈:** T1의 CHECK 12는 호출 하나를 이름이 몇이든 한 번 셌다. 그래서 6A-1이 지운 여섯 이름을 넛지 읽기의 이름 목록에
   되넣어도 수가 그대로였다(래칫이 6A-1을 지키지 못함). 리뷰 반영에서 이름마다 세도록 바꿨다. 같은 셈으로 바탕은 읽기 20(목록의 일곱이
   7), 지우기 10이다(QA 라운드 2에서 이 가드를 바탕 트리에 돌려 확인: `native-control-authority.ts` 7, `iframe.ts` 3, `sync.ts` 4). 주석과
   레지스트리의 호출 수(14와 10, 뒤 11과 9)는 그 설명과 함께 남겼다.
7. **핵심 커버리지 문턱:** 계획은 `iframe-audio.ts`와 그 시험을 넣으라고만 적었다. 파일 문턱을 99로 두었다.

## 정확한 개수 가드

| 가드                                           | 바탕 `599465dd`                                                                                                 | `b80485f3`                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CHECK 11 iframe 오디오 쓰기(RO-12)             | 44: `zero-start.ts` 12, `authority-arm.ts` 10, `player.ts` 17, `iframe.ts` 3, `retained-player-controller.ts` 2 | 32: `zero-start.ts` 6, `authority-arm.ts` 4, `player.ts` 14, `iframe-audio.ts` 3, `iframe.ts` 3, `retained-player-controller.ts` 2 |
| CHECK 12 남의 시작 타이머 읽기(RO-02, 호출 수) | 14                                                                                                              | 11, 모두 PRO 넛지(`iframe.ts` 1, `local-offset.ts` 2, `native-control-authority.ts` 1, `player.ts` 4, `sync.ts` 3)                 |
| 같은 읽기, 이름마다(`4a1a7e89`부터의 셈)       | 20(`native-control-authority.ts` 7)                                                                             | 11                                                                                                                                 |
| CHECK 12 남의 시작 타이머 지우기               | 10: `iframe.ts` 3, `player.ts` 6, `sync.ts` 1                                                                   | 9: `iframe.ts` 2, `player.ts` 6, `sync.ts` 1                                                                                       |
| CHECK 5 복사 / 의심 / 같은 값 쌍(보고만)       | 2 / 1 / 27                                                                                                      | 1 / 1 / 45                                                                                                                         |
| resource-ownership                             | 49 records, 450 production files                                                                                | 49 records, 451 production files                                                                                                   |
| `src/youtube/` 타이머 호출(가드 항목 12)       | 210                                                                                                             | 205                                                                                                                                |
| dead-exports                                   | 403 prod files, 2,114 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76                                    | 404, 2,124, 0, 20, 76                                                                                                              |
| import-graph                                   | 403 files, 2,087 edges, 순환 0                                                                                  | 404 files, 2,098 edges, 순환 0                                                                                                     |

room-authority(직접 읽기 79, 구독 22, 쓰기 13, PRO 읽기 0, 스냅샷 읽기 0, 404 files), bus-pairing 202 / 202, source-complexity(YouTube
파일은 목록에 없음)는 바뀐 기준치가 없다. 내린 기준치는 모두 센 코드를 옮긴 커밋에서 레지스트리 기록과 함께 내렸고, 올린 기준치는 없다.

## 번들 크기

같은 툴체인(Node 24.22.2, vite 8.3.3)으로 커밋마다 `npm run build`를 하고 `scripts/check-initial-transfer-budget.mts`의 측정을 바이트로
읽었다(QA 라운드 2). 시험만, 가드만 커밋은 빌드가 바로 앞 코드 커밋과 같다.

| 커밋                    | 진입 청크          | 진입 raw / gzip   | eager JS gzip (부모 대비) | eager total raw / gzip (부모 대비) |
| ----------------------- | ------------------ | ----------------- | ------------------------- | ---------------------------------- |
| 바탕 `599465dd`         | `main-BYFZlrrn.js` | 862,203 / 253,778 | 466,481                   | 2,059,004 / 545,725                |
| 6A-1 `faffa69b`         | `main-DqVfbBh5.js` | 862,353 / 253,814 | 466,521 (+40)             | 2,059,154 / 545,766 (+41)          |
| 6A-2 `d34b4478`         | `main-Bbwvxc8m.js` | 862,311 / 253,796 | 466,499 (−22)             | 2,059,112 / 545,741 (−25)          |
| 6A-3 `4c5ca5e9`         | `main-BSUmIIIe.js` | 862,106 / 253,742 | 466,736 (+237)            | 2,059,416 / 545,979 (+238)         |
| 6A-4 `5e3edd0c`         | `main-D3DxfJRk.js` | 861,653 / 253,879 | 466,882 (+146)            | 2,058,963 / 546,125 (+146)         |
| 6A-4 `0ec9e8e0`         | `main-DneD15-T.js` | 861,118 / 253,718 | 466,718 (−164)            | 2,058,428 / 545,959 (−166)         |
| `0cd720fc` ~ `b80485f3` | `main-DneD15-T.js` | 861,118 / 253,718 | 466,718 (0)               | 2,058,428 / 545,959 (0)            |

- 증분별(부모 대비 eager JS gzip): 6A-1 +40, 6A-2 −22, 6A-3 +237, 6A-4 −18(두 코드 커밋 합). 모두 증분 상한 +300 B 안이다.
- **Phase 순증은 +237 B로 상한 +200 B를 넘는다**(증분 차의 합 = 마지막 − 바탕, 사이에 낀 Phase 6 밖 열차 없음). eager total gzip은
  +234 B, 진입 청크는 raw −1,085 B, gzip −60 B다. KiB로는 eager JS 455.5 → 455.8 KiB, eager total 532.9 → 533.2 KiB gzip이고
  `guard:initial-transfer-budget`의 유지 상한 안이다. 계획 §4.2-6과 Q29는 이때 멈추고 잰 숫자로 오너가 정하게 한다(아래 '오너에게' 1).
- 주된 원인은 6A-3의 객체 모양 집이다. 크기 실험(커밋하지 않음, 임시 worktree): 마지막 트리에서 `YOUTUBE_ARM_TIMING`과
  `STANDARD_ZERO_START_BARRIER`를 같은 값의 스칼라 export로 바꾸고 읽는 다섯 파일을 그 이름으로 바꾸면 eager JS gzip 466,329 B(바탕 대비
  −152 B, 마지막 트리 대비 −389 B), eager total gzip 545,573 B(바탕 대비 −152 B), 진입 raw 860,403 B였다. 객체의 속성 이름은 minifier가
  남긴다. 이 실험은 크기만 쟀고 시험은 돌리지 않았다.

## 혼합 버전

| 조합                                                           | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 바닥 795 이상 옛 App 방장과 6A 게스트, 6A 방장과 옛 App 게스트 | 같은 프레임을 같은 시각에 보낸다. 와이어(`src/network/protocol.ts`, `src/types/index.ts`, `src/core/constants.ts`, `cloudflare/`)가 바탕과 바이트로 같고(`git diff --stat 599465dd..b80485f3` 비어 있음), H3는 진리표 그대로라 하트비트와 보조 `YOUTUBE_STATE` 시점이 같으며, C2-3은 두 박자를 지켜 ARMED 시점이 같고, C2-1은 숫자 그대로다. 근거는 기기 혼합 행이 아니라 T0a의 Standard 와이어·시각 골든과 H3 진리표가 바이트 그대로 통과한 것이다(Phase 5의 P5-D9 C 선례) |
| PRO 방의 옛·새 기기                                            | PREPARE와 COMMIT은 서버를 거치고 서버는 바뀌지 않는다. arm 활성 복원(2.3 s 준비 예산 안)과 분리 복원이 검증 복원을 쓰지만 T0a PRO READY 시각 골든이 그대로라 READY 시각, 곧 시작 시각이 같다. 박자를 합치는 것은 Q3의 대안이고 동작 변경이라 하지 않았다                                                                                                                                                                                                                    |
| 바닥 795 아래의 열린 세션                                      | 바닥은 열린 세션을 닫지 않는다. 6A는 프레임을 얼려 그 위험을 더하거나 줄이지 않는다                                                                                                                                                                                                                                                                                                                                                                                         |

결과가 다르더라도 '방이 zero-start 대신 레거시로 시작' 같은 품질 저하이고 재생이 멈추지는 않는다고 본다(계획 §5, 추론).

## 되돌리기

기본은 더 높은 SemVer·epoch의 앞으로 고치기다. 새 되돌리기 경계는 없다: 계약 표지, D1, 저장 모양, 바닥을 바꾸지 않아 forward floor가
생기지 않는다.

- **실패 자동 복구:** target `app`의 실패 복구는 checkpoint의 App(dispatch 때의 운영 App, 오늘은 9.0.27 / v800, 빌드 800)으로 간다. 바닥
  795 이상이라 `lower`가 필요 없다. 와이어가 같아 되돌린 App과 6A가 섞인 방도 같은 프레임을 같은 시각에 보낸다.
- **손 되돌리기:** 결함이 커밋 표지를 지났으면 App을 checkpoint 버전으로 되돌린다(App 하나, `lower` 없음). 출처 없는 버전의 다음 수리
  릴리스 판정은 `docs/hotfix-procedure.md`대로다. 손 되돌리기도 배포라 기록 PR과 이력 한 행을 낸다.
- **혼자 되돌릴 수 있는 기간:** 6B가 머지되기 전까지다. 6B 장부는 6A-1 소유자 질의와 6A-3 상수를, 6C-2는 6A-4의 `iframe-audio.ts`를,
  6D-1은 6A-3의 1,800 ms와 120 ms × 8을 쓴다(계획). 그 뒤에는 6A부터 가장 최근 열차까지 앞으로 되돌린다: 새 `agent/` 갈래에서 그
  열차들의 커밋을 거꾸로 되돌리고, 다음 SemVer·epoch(버전 거울 여섯과 `index.html`의 bootstrap 캐시 쿼리), 전체 게이트, App 릴리스,
  기록. 앞으로 되돌리기와 앞으로 고치기는 각각 업데이트 창 하나를 Q1의 넷 밖으로 더한다.
- **되돌릴 때 가드:** 6A 커밋들이 가드 기준치(CHECK 5, 11, 12)와 레지스트리를 같은 커밋에서 옮겼으므로 되돌리면 함께 돌아온다.
  `4a1a7e89`(이름마다 세는 CHECK 12)만 남기고 6A-1을 되돌리면 읽기가 이름마다 20이 되므로, 그 되돌리기가 기준치와 RO-02 기록을 함께
  올린다(`AGENTS.md` Resource ownership).

## 배포 조건과 순서 (릴리스 담당)

1. 오너 답: 아래 '오너에게' 1(첫 로딩 바이트)과 2(상태 이름 정리). 답이 '줄인 뒤 낸다'면 그 증분을 테스트 먼저부터 이 갈래에 더하고
   커밋마다 크기를 다시 잰다.
2. 한 번에 한 열차: main 런타임이 배포본과 같을 때만 낸다. 9.0.27 기록이 적은 9.0.28(SFU 추측 발행)과의 순서를 정하고, 먼저 나간 열차의
   기록 위로 이 갈래를 옮기면 테스트 먼저 커밋을 옮긴 부모에서 다시 돌린다. 이 배포까지 런타임 의존성 변경을 머지하지 않는다.
3. 버전 올리기 커밋(마지막 런타임 커밋): `package.json:3`, `package-lock.json:3`과 `:9`, `browser/classic-runtime/admin.ts`의
   `ADMIN_SCRIPT_VERSION`, `cloudflare/app-worker.ts`의 `ADMIN_ASSET_VERSION`, `scripts/service-worker-asset.ts`의 SW 캐시 epoch,
   `index.html`의 `/bootstrap.js?cache=` 쿼리. 그 뒤 `guard:sw-cache-version` PASS, `guard:release-identity`가 새 버전, `build:checked`
   전체 통과. 계약 동결: `git diff --stat 599465dd..HEAD -- cloudflare/ src/network/protocol.ts src/core/constants.ts src/types/index.ts`가
   `cloudflare/app-worker.ts`의 버전 한 줄만 보인다(오늘은 비어 있음).
4. 문서 증분(계획 6A-5): release-record §2에 이 열차의 '배포 전' 항목(이 보고서 링크, 오너 질문, 배포 뒤 확인, 혼합 버전), 9.0.22 항목의
   '2.3 s 준비 예산과 공유 시간 집의 순서 시험(Phase 0d C2-1)은 보지 않았다' 구절(순서 시험이 6A-3에서 생김), 'Android YouTube 출력
   정렬·혼합 버전' 항목의 혼합 버전 문장(Q21: 바닥 795를 근거로 닫고 출력 정렬 실측은 남김), 레지스트리 배포 묶음 문단에 Phase 6의
   App 업데이트 넷(Q1, 2026-10-30). 기기 근거 없이 열린 항목을 지우지 않는다.
5. PR CI, 자동 코드 리뷰, 머지, exact-main CI success 뒤 Release target `app`, Developer API D1 false, `raise_app_build_floor` false.
6. 배포 직후(게이트 아님): 아래 '배포 뒤 확인'. 머지 뒤 main SHA에서 Full E2E를 한 번 돌려 이 보고서의 QA 라운드에 적되 exact-main
   후보로 쓰지 않는다(계획 §4.2-5).
7. 배포 기록 PR: release-record §1과 `Last source review` 덮어쓰기, `docs/release-history.md` 한 행, §2의 이 항목을 '배포 뒤 확인'으로.

## 배포 뒤 확인 (블라인드, 게이트 아님)

계획 §4.5의 기기 후보다. 확인하는 사람에게는 '절차'만 주고 기준은 주지 않으며, 받은 관찰값을 여기 기준과 견준다. 기준선(Q6)이 있으면
그것과 견준다. 기기가 없는 단계는 건너뛰고 '기기 없음'으로 적는다.

**절차(확인하는 사람에게 주는 것):** 모든 기기에서 주소 끝에 `?mxqrLog=debug`를 붙여 연다. 새로 고치거나 다시 들어갈 때도 다시
붙인다. 각 단계 뒤 채팅에 `/debug console`을 입력하고 `[YouTube`와 `[PRO`로 시작하는 줄을 시각과 함께 복사한다. 모든 기기에서 앱
정보의 버전 번호를 적는다.

- **A. 일반방 예열 중 일시정지와 볼륨 0(약 35분):** (1) 데스크톱 Chrome을 방장으로 일반방을 만들고 iPhone Safari와 Android Chrome을
  게스트로 넣는다. 모든 기기의 볼륨을 50으로 두고 재생목록에 YouTube 두 곡을 넣는다. (2) 방장이 첫 곡을 누르고, 소리가 나기 전(1초 안)
  iPhone 게스트가 앱의 일시정지를 누르고 3초 뒤 재생을 누른다. 일시정지 동안 짧게 새는 소리가 있었는지, 재생 뒤 소리 크기(같음, 작음,
  큼, 없음)를 적는다. (3) (2)를 Android 게스트로 한 번 한다. (4) 방장이 다음 곡을 누르고 소리가 나기 전 iPhone 게스트가 볼륨을 0으로
  내렸다가 2초 뒤 50으로 올린다. 세 곡에 걸쳐 세 번 한다. (5) 방장을 iPhone Safari로 바꿔 (2)와 (4)를 방장 기기에서 한 번씩 한다.
  (6) Mac의 Safari를 방장이나 게스트로 넣어 (2)를 한 번 한다. (7) Android 게스트에 블루투스 이어폰을 연결하고 (2)를 한 번 한다.
- **B. PRO 준비 중 일시정지(약 10분):** 그 PRO 방의 모든 탭을 먼저 새로 고친다. iPhone과 Android를 같은 PRO 방에 넣고, 다른 기기가 다음
  YouTube 곡을 누른 뒤 소리가 나기 전 1초 안에 Android에서 이어폰 버튼(또는 알림의 미디어 컨트롤)으로 일시정지하고 5초 뒤 재생한다.
  모든 기기의 소리를 적고 `/debug sync`의 `youtube-release` 기록도 복사한다.
- **C. 시작 직후의 헤드셋·잠금 화면(H3, 약 25분):** (1) 데스크톱 Chrome 방장, 버튼 있는 이어폰을 낀 iPhone Safari 게스트. 방장이 곡
  중간에서 seek하고 2초 안에 게스트가 이어폰 버튼으로 일시정지, 5초 뒤 재생한다. (2) 방장이 수동 싱크 오프셋을 −5.000 s로 두고 곡을
  처음부터 시작하고, 게스트 소리가 나기 전 기다리는 동안 게스트가 잠금 화면에서 일시정지, 5초 뒤 재생한다. (3) iPhone을 방장으로
  바꿔(데스크톱 Chrome 게스트) (1)을 방장 기기에서 한다. 단계마다 게스트와 방장의 소리를 적는다.

**통과 기준(주지 않음):**

- A: 재생하거나 볼륨을 50으로 올리면 그 기기의 소리가 설정 볼륨으로 돌아오고, 일시정지와 볼륨 0 동안 예열 소리가 새지 않는다. 방장
  콘솔에 `[YouTube ZeroStart] prepare-host`와 `Playback released`가 있고 어느 기기에도 `[YouTube ZeroStart] audio-restore-timeout`
  경고가 없다. iOS 방장(5)과 Mac Safari(6)도 같다(방장 hard-mute와 활성 복원이 WebKit의 첫 unMute 무시를 지난다). `Falling back to
legacy rendezvous`는 실패로 보지 않고 적는다(예열 중 취소가 레거시로 넘어간 경우). 블루투스(7)는 첫 음이 잘리지 않고, 어긋남은
  기준선 대비 변화만 본다.
- B: 준비가 끝나도 소리가 새지 않고 일시정지가 이기며, 재생하면 방 시계에 맞춰 다시 붙는다.
- C: 게스트의 진짜 일시정지가 존중된다(게스트만 멈추고 재생하면 방 시계에 맞춰 붙는다). seek 직후나 기다리는 중이라는 이유로 무시되거나
  방 전체가 멈추지 않는다. (3)에서 방장의 일시정지는 방에 그대로 전해진다(오늘 동작). 어느 단계에서도 예열 소리가 새지 않는다.

**실패하면:** 일시적 네트워크로 설명되지 않는 어긋남이면 위 '되돌리기'대로 앞으로 고치기나 checkpoint App으로의 손 되돌리기를 정한다.
'기기 없음'과 '미확인'은 실패가 아니다.

## 사용자가 알아챌 변화

없다. 버전 올리기와 함께 업데이트 창이 한 번 뜬다(창 모양은 지금 그대로). 처음 받는 코드가 gzip 기준 237 B 늘어난다(지금 처음 받는
양 약 533 KiB의 0.04 %, 아래 '오너에게' 1).

## 기록과 레지스트리

- 이 브랜치: 레지스트리 RO-02, RO-03, RO-12와 가드 항목 11·12(센 코드를 옮긴 커밋에서), 이 보고서와 `docs/README.md` 증거 목록.
- 릴리스 담당이 더할 것: 위 '배포 조건과 순서' 3, 4, 7. 레지스트리 머리의 `Last source review`(2026-10-22)는 기록을 코드와 다시 맞추는
  PR이 고친다.
- Phase 5.5 날짜 보고서(`phase5-5-r1-train3-v2-accept-2026-10-29.md`의 C2-1 기다림 문장 셋, `phase5-5-r2-v2-send-2026-10-29.md`의 하나)는
  날짜 증거라 그대로 둔다. 그 기다림은 6A-3(`4c5ca5e9`)으로 닫혔다: App 쪽 시간 집과 2.3 s·3 s 순서 시험이 이 브랜치에 있다.

## 오너에게

1. **[화면 그대로] 첫 업데이트의 처음 받는 코드 크기(Q29).** 화면과 소리는 어느 답이든 같아요. 다른 것은 앱을 처음 열 때 받는 양뿐이에요.
   이번 업데이트는 그 양을 압축 기준 237바이트(지금 받는 양의 약 0.04 %) 늘려요. Phase 6 전체에 잡아 둔 상한 200바이트를 첫 업데이트에서
   넘었어요. 어떻게 할까요?
   - (가, 권장) 줄인 뒤 낸다: 새로 모은 시간 값을 묶음 대신 낱개 이름으로 바꿔요(값과 동작은 그대로). 크기만 잰 실험에서는 처음 받는
     양이 바탕보다 오히려 152바이트 줄었어요. 시험 먼저 커밋과 코드 커밋이 하나씩 더 들고, 업데이트가 그만큼 늦어져요.
   - (나) 이대로 내고, 다음 업데이트(6B)에서 같은 방법으로 되찾는다: Phase 6이 끝날 때 상한 안에 들면 돼요.
   - (다) 이대로 받아들이고 Phase 6 상한을 237바이트로 올린다.
   - 기다리는 동안: 이 열차를 배포하지 않는다. 나머지 준비(버전 올리기 앞까지)는 그대로 둔다.
2. **[화면 그대로] 플레이어 상태 이름 정리를 뒤로 미루기.** 계획에 있던 'YouTube 플레이어 상태 숫자(−1, 0, 1, 2, 3, 5)에 공용 이름 붙이기'를
   이번 업데이트에 넣지 않았어요. 코드 안 이름만 바뀌는 일이라 화면·소리는 어느 쪽이든 같아요. 만드는 중에 잰 값으로는 넣으면 처음
   받는 양이 약 50바이트 더 늘어요(1번과 겹침). 뒤 업데이트로 넘겨도 될까요?
   - (가, 권장) 뒤 열차로 넘긴다(시작 준비 단계를 함께 쓰게 만드는 6C에서 크기와 함께 다시 본다).
   - (나) 이번 업데이트에 넣는다(1번의 크기 결정과 함께).

## QA 라운드

### 1. 증분별: 테스트 먼저 다시 돌림

2026-10-31 16:44 ~ 16:49 KST, Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, `--maxWorkers=4`. `rec-main11`(=`599465dd`)에서
만든 임시 worktree(`npm ci`)에서 커밋마다 detached로 바꿔 돌렸고, 끝난 뒤 그 worktree는 깨끗했다. 결과는 위 '증분 한눈에'와 각 절이다.

- `09a1bb8c` 15 / 121 실패(가드 6, owner-ports 8, owner-queries 1) → `faffa69b` 211 / 211.
- `8cc9decc` 3 / 112 실패(가드 3) → `d34b4478` 293 / 293.
- `d9bee96c` 8 / 82 실패(가드 2, 순서 2, parity 4) → `4c5ca5e9` 438 / 438.
- `e1a1a4d3` 가드 1 / 67 실패와 `iframe-audio.test.ts` 불러오기 실패 → `5e3edd0c` 534 / 534.
- `cd35aed8` 4 / 68 실패 → `4a1a7e89` 68 / 68.
- 리뷰 반영 시험만 넷의 새 행: 6A 앞 런타임에서 모두 통과(위 '열차 리뷰 반영'의 근거).

### 2. 전체 검사

마지막 커밋 `b80485f3`, 2026-10-31 16:03 ~ 17:19 KST, 같은 환경(vite 8.3.3, Playwright 1.63 Chromium). 깨끗한 트리에서 돌렸다.

- 단위 전체(파일 순서): 727 files, 17,218 통과, 1 건너뜀, 실패 0(719 s). 건너뛴 하나는 jq가 없는 PC에서 건너뛰는 기존 행
  (`release-deployment-state.test.ts`의 `it.skipIf(!jqAvailable && !process.env.CI)`)이다. git fixture 행의 시간 초과는 없었다.
- `src/youtube`와 `src/pro-room`을 `--sequence.shuffle`로 seed 7, 31, 4242, 20261030: 174 files, 4,777행. `src/youtube`는 네 seed 모두
  실패 0이다. `src/pro-room`의 두 파일만 실패했다: seed 7은 `system-audio-service.test.ts` 32, seed 31은 그 파일 57과
  `runtime-preload.test.ts` 3, seed 4242는 50과 2, seed 20261030은 76과 1. 두 파일과 그 런타임은 이 브랜치가 건드리지 않았고, 바탕
  `599465dd`(171 files, 4,705행)에서 같은 명령과 seed로 실패한 행의 집합이 넷 모두 글자 그대로 같다(32, 60, 52, 77). 그래서 6A와
  무관한 기존 순서 의존이다(아래 '확인하지 않은 것').
- `npm run typecheck`(전체, `typecheck:tests`, `typecheck:browser-classic`, `typecheck:node-scripts` 포함), `npm run lint`(app과
  tooling), `npm run format:check`, `npm run check:workers` 모두 종료 코드 0.
- `build:checked`의 각 단계를 하나씩 돌렸다(`guard:sw-cache-version`이 실패하면 사슬이 멈추므로). `guard:sw-cache-version` 하나만
  실패했다: '[sw-cache-version] FAIL: committed PWA runtime changes are newer than v800 (23f29283).'와 위 'Deploy target'의 App 13 파일,
  'Bump CACHE_VERSION in scripts/service-worker-asset.ts after these changes, then commit the bump.' 버전을 올리지 않았다는 것 말고는
  이유가 없다. 나머지(authored JS 둘, TypeScript project coverage 1,537 files, classic runtime 16, auxiliary browser, service worker,
  UI kit, release identity, brand capitalization, declaration ownership, source complexity, room authority, profanity, hreflang 43,
  sitemap 93, `npm run build`, legacy TV(Chromium 79), service worker build(v800, 바이트 동일), UI kit build, initial transfer budget,
  prod hooks, prod security, 글꼴 2,009.5 KiB, SW 앱 셸 94 assets)는 모두 통과했다.
- 그 밖 `guard:*` 전부 통과: bus-pairing 202 / 202, chunk-pump, transport-health, import-graph(404 files, 2,098 edges, 순환 0),
  lifecycle-writes, navigation-sinks, dead-exports(404 / 2,124 / 0 / 20 / 76), font assets, standard-room hot path, Developer API
  boundaries, D1 migrations, ops drift contract, Playwright API.
- `node scripts/check-resource-ownership.mts`와 `--report`: 위 '정확한 개수 가드'. 이름마다 세는 지금 가드를 바탕 트리에 돌린 확인도 같다.
- 크기: 위 '번들 크기'(커밋마다 빌드, 마지막 트리는 이 worktree의 `build:checked` 단계 빌드와 바이트로 같음).
- `npm run test:coverage:critical`: 93 files / 3,726 통과, 전체 83.92 / 79.1 / 89.37 / 87.64(문턱 73 / 66 / 80 / 78), 파일별 문턱 오류
  없음(`iframe-audio.ts` 99 / 99 / 99 / 99 포함).
- `npm run test:coverage:workers`: 69 files / 3,325 통과, 86.72 / 83.55 / 94.41 / 90.98.
- `npm run build:e2e` 뒤 로컬 Playwright(Chromium, 포트 4648 / 9648): `test:e2e:critical` 100 / 100(5.7분), YouTube 여덟 spec(계획
  §4.2-3: `youtube-sync`, `youtube-manual-zero-start`, `youtube-output-delay`, `youtube-end-transition`, `youtube-native-operator`,
  `youtube-manual-repeat`, `youtube-pending-seek`, `youtube`) 41 / 41(12.0분).
- 계약 동결(계획 §4.2 Phase 6 검사 1): `git diff --stat 599465dd..b80485f3 -- cloudflare/ src/network/protocol.ts src/core/constants.ts
src/types/index.ts package.json package-lock.json index.html scripts/service-worker-asset.ts browser/`가 비어 있다.

## 확인하지 않은 것

- 실기기, iOS Safari, WebKit 레인(`setup-youtube-activation.test.ts` 포함), 블루투스, Full E2E. 기기 확인은 배포 뒤 블라인드로 하며
  게이트가 아니다. 기준선(Q6)은 아직 없다.
- PR CI, 자동 코드 리뷰, exact-main CI, 버전 올리기 뒤의 `guard:sw-cache-version`과 `build:checked` 사슬 전체.
- 상태 열거 (가)의 크기를 마지막 트리에서 다시 재지 않았다(위 '계획과 달라진 것' 2). 스칼라 집 실험은 크기만 쟀다.
- `src/pro-room`의 shuffle 순서 의존(`system-audio-service.test.ts`, `runtime-preload.test.ts`)은 바탕에도 있는 기존 문제라 고치지 않았다.
  파일 순서 실행과 CI는 영향이 없다. 뒤 시험만 PR 후보다.
- 영역 조사의 대략적 기기 시간(A 35분, B 10분, C 25분)은 추정이다.
