# 소리 복구 주인 파일의 이름 맞추기: 다음 App 열차에 얹을 증분 (2026-11-11)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 증분 보고서: 초안 PR, 미병합·미배포. 버전 올림이 일부러 없다. 다음 App 열차가 자기 버전 올림 앞에 이 커밋들을 얹고, 그 열차의 보고서가 이 문서를 그 증분의 절로 쓴다(§9)                                                                                                                                                                                                                                    |
| Base               | main `c4a3d6f0`(#584, App 9.0.43 / v818의 배포 기록, 문서만). App 런타임은 운영 9.0.43 / v818의 머지 `3b8ec6e3`(#583)과 같다                                                                                                                                                                                                                                                                                |
| Version            | 없음. 이 PR은 SemVer와 서비스 워커 캐시 epoch를 올리지 않는다. 그래서 `guard:sw-cache-version`과 그것을 도는 PR 검사는 이 PR에서 통과하지 않는다(런타임 소스가 바뀌었는데 epoch가 그대로). 얹는 열차의 버전 올림이 덮는다                                                                                                                                                                                   |
| Scope              | 의도한 동작 변경 없음, [화면 그대로]. AudioContext 복구의 한 주인 `src/audio/context-recovery.ts`의 이름 가운데 기계가 둘이던 때의 말을 지금 기록이 쓰는 말로 맞췄다(맨 위 이름 139개 가운데 50개 바꿈, 3개 합침, 86개 그대로). 같은 말이 주인 파일 밖으로 이어진 이름 넷도 따로 커밋으로 맞췄다. 이름, 주석, 문서뿐이다                                                                                    |
| Deploy target      | 실릴 열차에서 `app`. 운영(App `3b8ec6e3`)과 견준 런타임 경로 변경은 App 6(`src/app.ts`, `src/audio/context-recovery.ts`, `src/audio/output-health.ts`, `src/player/media-session.ts`, `src/player/transport.ts`, `src/types/index.ts`)이고 다른 다섯 Worker는 0이다(그 다섯의 런타임 경로 목록에 이 파일들이 없음, `scripts/release-deployment-state.mts`). 바닥, D1, 비밀, 바인딩, 계약 표지에 닿지 않는다 |
| Operations         | 로컬 git, 로컬 단위 시험, 로컬 빌드, 로컬 Playwright(E2E 미리보기와 로컬 PeerJS)뿐이다. 배포, 운영 요청, 운영 방 만들기, 운영 PRO 시험, 비밀값 입력은 없다                                                                                                                                                                                                                                                  |
| Resource ownership | 새 레코드 없음, 주인 변경 없음. 복구, 재시도, 시간 한도, 감시, 수명 흐름을 더하거나 바꾸지 않는다. 등록부의 RO-01, RO-10, RO-36과 [AudioContext 소유 결정](audio-context-ownership.md), [재생 동시성 불변식](playback-concurrency-invariants.md)의 이름 인용을 새 이름으로 고쳤고, 가드(`scripts/check-resource-ownership.mts`)의 기준선은 그대로다                                                         |
| Release record     | 고치지 않았다. 병합되지 않은 초안 PR은 운영 상태, 열린 항목, 복구 조건을 바꾸지 않는다. 얹는 열차가 자기 '배포 전' 절에 이 증분을 적는다(§9)                                                                                                                                                                                                                                                                |
| Owner question     | 없음. 오너가 2026-11-11에 '지금 단독으로 배포하지 않고 다음 App 업데이트에 얹는다'를 골랐다(§1)                                                                                                                                                                                                                                                                                                             |

이 문서는 이 증분의 범위, 바뀐 이름의 대조표, 합치지 못한 것과 그 까닭, 이름만 바뀌었다는 근거(전후 같은 시험과 번들 크기), 얹는 쪽이 할
일을 적는다. '재생 요청 범위'(play-request)는 화면으로 돌아온 뒤의 로컬 파일 재생이 멈춘 시계를 만났을 때 세우는 복구이고, '재생
범위'(playback-scope)는 재생 중에 끊기거나 시계가 멈췄을 때의 복구다(자원 소유 등록부 RO-01,
[AudioContext 소유 결정](audio-context-ownership.md)). '시험용 통로'는 주인이 시험에만 내주는 `ownerSubStepsForTests`다.

## 1. 오너 결정

오너의 말은 옮기지 않고 뜻만 적는다.

- **2026-11-10, 범위:** Phase 7 7C(App 9.0.41)는 '옮기기만, 동작 그대로'라 이름을 줄이거나 함수를 없애지 않았다. 남은 이름을 정리하되 길이를
  줄이려고 바꾸지 않고, 프로젝트 전체의 긴 이름은 그대로 둔다(뜻이 이름에 있고 검색이 정확한 길고 유일한 이름은 이점이고, 진짜
  단점은 낡은 말과 서로 닮은 이름이라고 봄). 소리 복구 주인 파일에서만 (1) 기계가 둘이던 때의 말을 지금 기록이 쓰는 말로 맞추고, (2) 한
  번만 쓰는 비공개 함수는 부르는 곳에 합쳐 이름을 없애고, (3) 시험용 통로는 걷을 수 있는 만큼 걷는다. 25차 오디트 전에 한다.
- **2026-11-11, 진행:** 이름 표의 승인을 기다리지 않고 진행한다.
- **주인 파일 밖의 이름 넷(이 일을 맡긴 쪽의 결정, 오너에게 알림):** 재생 요청 시도의 표와 확정 함수가 알림 이벤트를 타고 이웃 세 파일로
  건너가는데 거기서도 같은 옛 말을 썼다. 같은 것을 가리키는 말이 주인 파일 안팎에서 달라지지 않도록 그 넷까지 맞추고, 주인 파일 안만
  원하면 되돌리기 쉽게 따로 커밋으로 둔다. 범위는 그 넷까지다.
- **2026-11-11, 내보내기:** 지금 단독으로 배포하지 않는다(단독이면 보이는 변화 없이 업데이트 창이 한 번 더 뜸). 다음 App 업데이트에 얹는다.
  그때까지 초안 PR로 둔다.

## 2. 증분 한눈에

| 증분                                     | 종류                  | 커밋       | 시험                                                                 |
| ---------------------------------------- | --------------------- | ---------- | -------------------------------------------------------------------- |
| 주인 파일의 이름 50개와 합친 이름 셋(§3) | 이름만, [화면 그대로] | `87f5677f` | 시험은 이름만 다시 가리킴(제목·기대값 변경 없음). 전후 같은 결과(§5) |
| 주인 파일 밖의 이름 넷(§3.6)             | 이름만, [화면 그대로] | `6ba64b4f` | 위와 같음                                                            |
| 검토 반영(§5.5)                          | 이름·주석·문서        | `3de521ff` | 위와 같음                                                            |
| 버전 올리기                              | 없음                  | 없음       | 얹는 열차의 몫(§9)                                                   |

커밋 SHA는 이 PR의 갈래 `agent/recovery-names`의 것이다. 얹는 쪽이 갈래를 옮기면 SHA가 바뀌므로 커밋 제목으로 찾는다(§12).

## 3. 무엇이 바뀌었나

### 3.1 낡은 말

AudioContext 복구는 Phase 7 7C까지 기계가 둘이었다: `context.ts`의 '앞으로 돌아온 뒤 다시 시작'(foreground restart)과
`context-recovery.ts`의 '끊김 복구'(interruption recovery). 7C가 둘을 한 주인 `context-recovery.ts`로 옮겼고 7C-5가 두 기계의 시도를 한
형 `RecoveryAttempt`로 합쳐 범위로 가르게 했다(`PlayRequestAttempt`, `PlaybackScopeAttempt`). 그러나 함수와 변수 이름에는 옛 기계의 말이
남았다: 재생 요청 쪽은 `ForegroundAudioContextRestart…`, 재생 범위 쪽은 `PendingAudioContextInterruption…`과 `…Recovery`(옛 형
`PendingContextRecovery`의 말). 뒤쪽은 두 범위가 같이 쓰는 `RecoveryAttempt`, `retireAudioContextRecoveryAttempt`와 섞여, 이름만 보면 두
범위를 다 다루는 것처럼 읽혔다(예: 재생 범위 시도만 물리는 `retireRecovery`).

### 3.2 숫자

- 주인 파일의 맨 위 이름(함수, 형, 모듈 변수) 139개: 50개 바꿈(밖으로 내보내던 함수 11개 포함), 3개 합쳐 없앰, 86개 그대로.
- 대화상자 탭 선택자의 칸 하나: `AudioOutputGestureSelector.foregroundRestartAttemptToken` → `playRequestAttemptToken`.
- 주인 파일 밖의 이름 넷(§3.6).
- 바뀐 파일: 운영 소스 6(`src/app.ts`, `src/audio/context-recovery.ts`, `src/audio/output-health.ts`, `src/player/media-session.ts`,
  `src/player/transport.ts`, `src/types/index.ts`), 시험 10(도우미 하나 포함), 실험실 명세의 주석 하나, 문서 셋(등록부, 결정 문서, 동시성 불변식).
- 가장 긴 이름 다섯이 61, 54, 51, 51, 49자에서 48, 45, 43, 42, 41자가 됐다. 길이를 줄이려고 바꾼 이름은 없고, 범위를 밝히느라 더 길어진
  이름도 있다(`retireRecovery` 14자 → `retirePlaybackScopeAttempt` 26자).

### 3.3 새 말의 꼴

- 시도 하나를 다루는 이름은 7C-5의 형 이름을 쓴다: `…PlayRequestAttempt…`, `…PlaybackScopeAttempt…`.
- 기록이 "play-request restart"라고 부르는 준비·소유·재개는 `…PlayRequestRestart…`다(`preparePlayRequestRestart`,
  `isPlayRequestRestartOwned`, `resumePreparedPlayRequestRestartFromGesture`, 형 `PlayRequestRestartPreparation`).
- 기록이 "play-request clock requirement"라고 부르는 것은 `…PlayRequestClockRequirement…`다.
- 범위 자체의 것은 `playRequest…` / `playbackScope…`다(`playRequestGeneration`, `playRequestHolding`, 짝 `playbackScopeHolding`).

### 3.4 옛 이름과 새 이름

날짜가 붙은 옛 보고서(Phase 7 7A, 7B, 7C, App 9.0.42 열차)는 옛 이름을 그대로 둔다. 그 보고서의 이름을 지금 코드에서 찾을 때 이 표를 쓴다.
'내보냄'은 주인 파일 밖에서 부르는 이름, '통로'는 시험용 통로의 멤버다.

#### 재생 요청 쪽 (28개): `Foreground(AudioContext)Restart` → `PlayRequest…`

| 옛 이름                                                         | 새 이름                                       | 비고   |
| --------------------------------------------------------------- | --------------------------------------------- | ------ |
| `pendingForegroundRestartAttempt`                               | `pendingPlayRequestAttempt`                   |        |
| `foregroundRestartGeneration`                                   | `playRequestGeneration`                       |        |
| `ForegroundRestartReprepare`                                    | `PlayRequestAttemptReprepare`                 |        |
| `ForegroundRestartEnd`                                          | `PlayRequestAttemptEnd`                       |        |
| `ForegroundRestartRequirementOutcome`                           | `PlayRequestClockRequirementOutcome`          |        |
| `ForegroundRestartRequirementWait`                              | `PlayRequestClockRequirementWait`             |        |
| `ForegroundAudioContextRestartPreparation`                      | `PlayRequestRestartPreparation`               |        |
| `ForegroundAudioContextRestartResumeResult`                     | `PlayRequestResumeResult`                     |        |
| `ForegroundAudioContextRestartClockHealthRequirement`           | `PlayRequestClockRequirement`                 |        |
| `parkForegroundRestart`                                         | `parkPlayRequestAttempt`                      |        |
| `startFreshForegroundSuspend`                                   | `startFreshPlayRequestSuspend`                |        |
| `reparkForegroundRestart`                                       | `reparkPlayRequestAttempt`                    |        |
| `retireForegroundRestartAttempt`                                | `retirePlayRequestAttempt`                    |        |
| `createForegroundRestartAttempt`                                | `createPlayRequestAttempt`                    |        |
| `isForegroundAudioContextRestartOwned`                          | `isPlayRequestRestartOwned`                   | 내보냄 |
| `isForegroundAudioContextRestartHolding`                        | `playRequestHolding`                          |        |
| `claimForegroundAudioContextRestartForDialog`                   | `claimPlayRequestAttemptForDialog`            | 내보냄 |
| `prepareForegroundAudioContextRestart`                          | `preparePlayRequestRestart`                   | 통로   |
| `prepareForegroundAudioContextRestartAfterClockStall`           | `preparePlayRequestRestartAfterClockStall`    | 통로   |
| `reparkForegroundAudioContextRestartAfterResume`                | `reparkPlayRequestAttemptAfterResume`         |        |
| `whenForegroundAudioContextRestartReprepared`                   | `whenPlayRequestAttemptReprepared`            | 내보냄 |
| `resumePreparedForegroundAudioContextRestartFromGesture`        | `resumePreparedPlayRequestRestartFromGesture` | 통로   |
| `whenForegroundAudioContextRestartClockRequirement`             | `whenPlayRequestClockRequirement`             | 통로   |
| `getPendingForegroundAudioContextRestartClockHealthRequirement` | `getPlayRequestClockRequirement`              | 통로   |
| `confirmForegroundAudioContextRestartHealth`                    | `confirmPlayRequestAttemptHealth`             | 내보냄 |
| `waitForForegroundRestartClockRequirement`                      | `waitForPlayRequestClockRequirement`          |        |
| `retireForegroundRestartForNextPlay`                            | `retirePlayRequestAttemptForNextPlay`         |        |
| `recoverForegroundRestartFromGesture`                           | `recoverPlayRequestFromGesture`               |        |

#### 재생 범위 쪽 (22개): `Pending…Interruption`, `…Recovery` → `PlaybackScope…`

| 옛 이름                                             | 새 이름                                      | 비고   |
| --------------------------------------------------- | -------------------------------------------- | ------ |
| `pendingRecovery`                                   | `pendingPlaybackScopeAttempt`                |        |
| `activeRecoveryAttempt`                             | `activePlaybackScopeAttempt`                 |        |
| `recoveryGeneration`                                | `playbackScopeGeneration`                    |        |
| `AudioContextRecoveryEscalationResult`              | `PlaybackScopeEscalationResult`              |        |
| `PendingInterruptionGestureCaller`                  | `PlaybackScopeGestureCaller`                 |        |
| `PendingInterruptionGestureOutcome`                 | `PlaybackScopeGestureOutcome`                |        |
| `retireRecovery`                                    | `retirePlaybackScopeAttempt`                 |        |
| `createRecovery`                                    | `createPlaybackScopeAttempt`                 |        |
| `prepareStalledRecovery`                            | `prepareStalledPlaybackScopeAttempt`         |        |
| `completeRunningRecovery`                           | `completeRunningPlaybackScopeAttempt`        |        |
| `recoveryCanAcceptGesture`                          | `playbackScopeAttemptCanAcceptGesture`       |        |
| `hasPendingAudioContextInterruption`                | `hasPendingPlaybackScopeAttempt`             | 내보냄 |
| `getPendingAudioContextInterruptionAttempt`         | `getPendingPlaybackScopeAttemptForGesture`   | 내보냄 |
| `getPendingAudioContextRecoveryAttemptForHealth`    | `getPendingPlaybackScopeAttemptForHealth`    | 내보냄 |
| `isAudioContextInterruptionAttemptCurrent`          | `isPlaybackScopeAttemptCurrent`              | 내보냄 |
| `beginPendingInterruptionRecoveryFromGesture`       | `beginPlaybackScopeRecoveryFromGesture`      | 내보냄 |
| `confirmPendingAudioContextRecoveryHealth`          | `confirmPlaybackScopeAttemptHealth`          |        |
| `retireStalePendingAudioContextRecovery`            | `retireStalePlaybackScopeAttempt`            |        |
| `escalatePendingAudioContextRecoveryToClockStalled` | `escalatePlaybackScopeAttemptToClockStalled` |        |
| `finishPendingInterruptionRecoveryFromGesture`      | `finishPlaybackScopeRecoveryFromGesture`     | 내보냄 |
| `recoverPendingInterruptionFromGesture`             | `recoverPlaybackScopeFromGesture`            |        |
| `armPendingAudioContextRecoveryFromBackground`      | `armPlaybackScopeAttemptFromBackground`      | 내보냄 |

### 3.5 합쳐서 없앤 이름 셋

| 옛 이름                              | 어디로                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ForegroundRestartPreparation`       | 같은 모양의 인터페이스 하나로. 그 인터페이스 `PlayRequestRestartPreparation`(옛 `ForegroundAudioContextRestartPreparation`)을 밖으로 내보낸다 |
| `finishPendingInterruptionForDialog` | 부르는 한 곳인 `recoverPlaybackScopeFromGesture`의 `finish` 안으로                                                                            |
| `cancelPendingInterruptionForTap`    | 부르는 한 곳인 `recoverUnownedContextFromGesture` 안으로                                                                                      |

`finishPendingInterruptionForDialog`를 합칠 때 둘째 단계의 약속을 `await`하지 않고 `.then`으로 이어 돌려준다. 원래 코드는 `async` 도우미가
돌려준 약속을 그대로 돌려줬고, 여기서 `await`로 바꾸면 `finish`가 마이크로태스크 한두 차례 일찍 풀린다. `.then`으로 이으면 대화상자가 답을
듣는 차례가 원래와 같다(검토가 Node에서 열네 경우를 재어 확인, §5.5).

### 3.6 주인 파일 밖의 이름 넷 (따로 커밋 `6ba64b4f`)

| 옛 이름                            | 새 이름                             | 있는 곳                                                                                                   |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `foregroundRestartAttemptToken`    | `playRequestAttemptToken`           | `audio:output-recovery-needed` 이벤트의 칸(`src/types/index.ts`), `src/app.ts`, `src/player/transport.ts` |
| `confirmForegroundRestart`         | `confirmPlayRequestAttempt`         | 같은 세 파일                                                                                              |
| `enqueuePreparedForegroundRestart` | `enqueuePreparedPlayRequestRestart` | `src/app.ts`                                                                                              |
| `foregroundRestartConfirmed`       | `playRequestAttemptConfirmed`       | `src/player/transport.ts`                                                                                 |

그 이벤트는 한 페이지 안의 버스 사건이고 보내는 쪽(`transport.ts`)과 받는 쪽(`app.ts`)이 한 빌드에 실린다. 저장하거나 방 안으로 보내는
모양이 아니라서 섞인 버전에 닿지 않는다. 사건 이름 `audio:output-recovery-needed`는 그대로다.

### 3.7 그대로 둔 이름 86개

- 앞으로 돌아온 뒤의 시계 점검 13개: 기록이 지금도 "foreground clock check", "clock-health incident"라고 부른다.
- 두 범위가 같이 쓰는 시도 형과 규칙 11개(7C-5), 일시정지 장부와 상태 변화 배차 27개(7B-4), 복구 재개 12개(7B-5), 대화상자 탭 10개(7C-2):
  한 주인이 되는 동안 지은 이름이거나 기록의 말 그대로다.
- 재생 범위의 그 밖 10개: 옛 기계의 말이 없다(원인, 정체, 시계 확인을 가리키는 말).
- 검토 뒤 그대로 두기로 한 셋(§5.5): `bindAudioContextInterruptionRecovery`, `emitPreparedRecovery`, `emitUnhealthyRecovery`.
- 함수 안의 지역 변수(`recovery`, `attempt`, `restart`)는 처음부터 범위 밖이라 그대로다.

## 4. 합치지 못한 것과 시험용 통로

- **61자 이름:** `getPendingForegroundAudioContextRestartClockHealthRequirement`는 운영 호출이 한 곳이지만 합치지 못했다. 시험 코드 12곳이
  "탭 뒤 시계 확인 요구가 지금 있는가"를 이 함수로 바로 읽고, 그중 한 곳은 주인 표 시험이 같이 쓰는 드라이버라 표 10행이 더 거쳐 간다.
  공개 진입점(대화상자 탭의 `finish`)은 그 값을 보여 주지 않고 곧바로 시계 점검과 확정까지 한다. 합치면 그 시험들이 읽을 길이 없어지므로
  이름만 `getPlayRequestClockRequirement`(30자)로 맞췄다. 돌려주는 형도 51자에서 27자가 됐다.
- **한 번만 쓰는 비공개 함수 23개 가운데 둘만 합쳤다(§3.5).** 나머지 21개 가운데 19개는 기록이 이름으로 부르거나 그 단계의 약속을 주석으로
  지닌 단계다(일시정지 장부의 여섯, 재생 요청 시도를 만드는 함수, 늦게 닿은 재개의 두 규칙, 대화상자 탭의 세 갈래 등). 합치면 부르는 쪽이
  100줄을 넘거나 순서를 읽기 어려워진다. 둘은 시험이 직접 부르는 통로 멤버다.
- **시험용 통로는 멤버 7개가 모두 남았다.** 그 통로를 쓰는 행은 하위 단계의 답이나 정확한 장면을 재고, 공개 진입점은 같은 답을 내지
  않는다(7C-4가 2026-11-08에 정한 까닭 그대로). 기대값을 바꾸지 않는 것이 이 증분의 조건이라 통로는 두고 멤버 이름만 따라 바꿨다.

| 멤버                                                     | 시험 사용  | 공개 진입점으로 못 바꾸는 까닭                                                                                                              |
| -------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `armForegroundAudioContextClockHealthCheck`(이름 그대로) | 22곳 5파일 | 공개 길은 엔진 묶기와 화면 숨김·복귀인데, 묶기가 자리 잡으면 주인 없는 일시정지를 스스로 깨워 '재개를 부르지 않음'을 재는 행이 달라진다     |
| `preparePlayRequestRestart`                              | 23곳 5파일 | 공개 길(파일 재생 전 시계 점검)은 시계를 두 번 재고 나서야 준비해, ms까지 적힌 시간표가 밀리고 '시계는 건강한데 준비'인 장면을 만들 수 없다 |
| `preparePlayRequestRestartAfterClockStall`               | 5곳 1파일  | 공개 길(대화상자 일반 갈래)은 먼저 재개를 한 번 부르고 수를 세어, '재개를 부르지 않음'을 재는 행과 어긋난다                                 |
| `resumePreparedPlayRequestRestartFromGesture`            | 19곳 5파일 | 이 단계의 답(돌고 있는가, 시계 확인이 필요한가)을 공개 탭 진입점은 돌려주지 않는다                                                          |
| `getPlayRequestClockRequirement`                         | 12곳 4파일 | 위 61자 이름의 까닭과 같다                                                                                                                  |
| `whenPlayRequestClockRequirement`                        | 2곳 2파일  | 주인의 네 가지 답(올라감, 물러남, 취소, 밀려남)을 공개 길은 '멈춤' 하나로 뭉친다                                                            |
| `requestRetiredAudioContextSuspendCleanup`(이름 그대로)  | 3곳 2파일  | 공개 길은 시도를 물리는 것뿐인데, 그러면 단계 변화와 다른 수가 같이 세어져 '정리 한 번에 수 하나'를 재는 행이 달라진다                      |

## 5. 이름만 바뀌었다는 근거

전후 비교는 고치기 전의 main `2d95d49e`(App 9.0.42 / v815) 위에서 했다. 그때의 커밋(`f6eeeb44`, `869210f4`, `d0c5c634`)은 푸시하지 않았고,
이 PR의 세 커밋은 그것을 main `3b8ec6e3`과 그 뒤 기록 위로 옮긴 것이다(패치가 같음). 옮긴 뒤의 결과는 §10.2다.

### 5.1 되돌려 비교

새 이름을 모두 옛 이름으로 되돌린 뒤 같은 서식으로 맞춰 바탕과 견줬다(대응 54쌍과 선택자 칸 하나). 운영 소스와 시험, 실험실 명세 17파일
가운데 11파일이 바탕과 글자까지 같고, 남은 6파일의 차이는 다음뿐이다: 주인 파일의 세 합침과 주석 셋, `src/app.ts`의 형 이름 하나(별칭이
인터페이스로), `src/audio/output-health.ts`의 가져오기 두 줄 순서, 시험 한 파일 안의 모의 손잡이 이름 하나(`output-health.test.ts`), 시험 두
파일의 줄바꿈.

### 5.2 단위 시험 전후

| 단계         | 코드                           | 결과                                                                                                                  |
| ------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 바탕         | main `2d95d49e`                | 786 파일, 18,843 통과                                                                                                 |
| 이름 바꿈 뒤 | 그 위의 첫 두 커밋(`869210f4`) | 786 파일, 18,843 통과. 시험별 비교(파일과 제목 전체로 맞춤): 바탕에만 있는 것 0, 뒤에만 있는 것 0, 결과가 달라진 것 0 |
| 검토 반영 뒤 | 그 위의 셋째 커밋(`d0c5c634`)  | 소리·재생 쪽과 가드 시험 98 파일 2,360 통과(전체는 옮긴 뒤에 다시 돌림, §10.2)                                        |

### 5.3 브라우저 시험과 실험실 전후

| 대상                                                                                                                               | 바탕 `2d95d49e` | 이름 바꿈 뒤 `869210f4` | 검토 반영 뒤 `d0c5c634` |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------- | ----------------------- |
| 소리 복구 CI 명세 셋(`e2e/demo-output-recovery.test.ts`, `e2e/background-resume.test.ts`, `e2e/back-navigation.test.ts`), Chromium | 15 / 15         | 15 / 15, 같은 행        | 15 / 15                 |
| 소리 복구 실험실(`e2e/audio-lab/`, `playwright.audio-lab.config.ts`, CI에 없음)                                                    | 26 / 26         | 26 / 26, 같은 행        | 옮긴 뒤 26 / 26(§10.2)  |

### 5.4 시험 행

시험은 이름만 다시 가리킨다. 바뀐 시험·도우미·실험실 파일의 제목 283개와 글자 값(문자열, 수, 정규식, 참거짓)이 순서까지 같다(검토의 대조).
이름을 다시 가리킨 것 말고 바뀐 한 곳은 `src/audio/__tests__/output-health.test.ts` 안의 모의 손잡이 이름 `isForegroundRestartOwned` →
`isPlayRequestRestartOwned`이고, 제목과 기대값은 그대로다. 주인의 선택자를 흉내 낸 시험 드라이버의 칸
(`__helpers__/audio-output-owners.ts`의 `DialogSelector`)도 주인의 칸을 따라 `playRequestAttemptToken`으로 맞췄다(형이 모양으로만 맞아서, 안
맞추면 형 검사를 통과한 채 표가 버려진다).

### 5.5 검토

만든 쪽과 따로, 바뀐 부분만 읽는 검토를 한 번 했다(2026-11-11, 첫 두 커밋). 동작 변화는 찾지 못했고, 합친 두 함수가 원래와 같다고
판정했다(`finish`의 약속 차례는 Node에서 열네 경우를 재어, 도우미와 `.then`은 모두 같고 `await`만 이른 것을 확인). 지적과 처분:

- 문서 두 문장이 과거를 지금 이름으로 말함 → 결정 문서는 그때의 이름을 적고, 등록부는 '옛 이름으로'를 더함.
- `docs/design/playback-concurrency-invariants.md`의 `app.ts` 줄 인용 둘이 두 줄 어긋남(첫 커밋이 한 호출을 한 줄로 접음) → 고침.
- `bindPlaybackScopeRecovery`는 하는 일보다 좁게 말함(두 범위를 다 섬기는 묶기) → 원래 이름 `bindAudioContextInterruptionRecovery`로 둠.
- `emitPreparedPlaybackScopeAttempt`, `emitUnhealthyPlaybackScopeAttempt`는 시도를 내보내는 것처럼 읽힘(내보내는 것은 '복구 필요' 알림) →
  원래 이름으로 둠.
- 형 이름 셋이 기대는 함수와 말이 다름 → `PlayRequestAttemptReprepare`, `PlayRequestClockRequirementWait`,
  `PlayRequestClockRequirementOutcome`.
- 합친 자리의 주석이 없어진 도우미를 말함 → 지금 말로 고침.
- 받아 두고 고치지 않은 것: 한 시도의 이어지는 단계가 세 꼴을 쓰고(§3.3, 기록의 말을 따름), 두 범위의 짝 이름이 가운데만 다르며(형 이름이
  그렇다), 지역 변수에 옛 말이 남았다(범위 밖).

## 6. 첫 로딩 크기

같은 버전 글자(9.0.42 / v815)로 지은 운영 빌드(`npm run build`)를 바탕과 이름 바꿈 뒤로 견줬다. 함수와 변수 이름은 빌드가 줄이므로 차이가
없고, 줄어든 것은 빌드가 줄이지 않는 칸 이름과 합친 두 함수다.

| 단계                    | JS 파일 | 전체 raw    | 전체 gzip   | eager JS gzip | eager total raw / gzip |
| ----------------------- | ------- | ----------- | ----------- | ------------- | ---------------------- |
| 바탕 `2d95d49e`         | 118     | 6,882,300 B | 1,979,593 B | 456.8 KiB     | 2008.9 KiB / 533.7 KiB |
| 이름 바꿈 뒤 `869210f4` | 118     | 6,882,151 B | 1,979,586 B | 456.8 KiB     | 2008.7 KiB / 533.7 KiB |
| 검토 반영 뒤 `d0c5c634` | 118     | 6,882,151 B | 1,979,586 B | 456.8 KiB     | 2008.7 KiB / 533.7 KiB |

- 차이는 raw 149 B, gzip 7 B 줄어든 것이다. raw 크기가 바뀐 묶음은 셋뿐이다: 진입 `main-*.js` 860,084 → 860,017 B(-67), 주인이 든 묶음
  63,436 → 63,359 B(-77), 재생 묶음 73,778 → 73,773 B(-5).
- 검토 반영 뒤의 빌드는 주인이 든 묶음의 파일 이름(내용 해시)까지 그 앞과 같다: 그 커밋이 바꾼 것은 빌드에 남지 않는 이름과 주석이다.
- 9.0.43 위로 옮긴 뒤의 크기는 재지 않았다(버전 올림 없이는 `build:checked`가 서지 않음). 얹는 열차가 자기 첫 로딩 표에서 잰다.

## 7. 바뀌지 않는 것과 혼합 버전

- 소리 복구의 동작과 순서, 대화상자와 알림, 문구, 시간 값, `/debug sync`의 숫자와 그 이름, 기록 문자열(`[Audio] …`), 버스 사건 이름.
- 서버, Worker, 저장 데이터 모양과 키, 신호와 중계 프레임, 의존성, 최소 앱 빌드 795.
- 섞인 버전: 방 안 통신, PRO 요청, 서버 계약, 저장 모양이 같아 앞 버전 탭과 같은 방에서 그대로 함께 쓴다[추론: 섞인 방을 따로 시험하지
  않음].

## 8. 되돌리기

새 경계는 없다(계약 표지, D1, 저장 모양, 바닥을 바꾸지 않음). 실린 열차의 되돌리기는 그 열차의 보고서가 정한다. 이 증분만 빼려면 세 커밋의
변경을 되돌리면 되고, 주인 파일 밖의 이름 넷만 빼려면 둘째 커밋(`6ba64b4f`)의 변경만 되돌리면 된다(이름뿐이라 순서와 무관).

## 9. 다음 App 열차를 만드는 쪽이 할 일

1. **옮기기:** 갈래 `agent/recovery-names`의 세 커밋(주인 파일, 이웃 이름 넷, 검토 반영)과 이 문서 커밋을 가장 최근 main 위로 옮겨 열차의
   버전 올림 **앞**에 둔다. 버전 올림이 마지막 런타임 커밋이어야 `guard:sw-cache-version`이 통과한다.
2. **충돌 나기 쉬운 파일:** `src/audio/context-recovery.ts`(이름이 파일 전체에 퍼져 있어 그 파일을 고치는 다른 증분과 거의 반드시 겹친다),
   `src/app.ts`의 복구 대화상자 부분, `src/player/transport.ts`의 실패한 PLAY 알림 부분, `src/player/media-session.ts`,
   `src/audio/output-health.ts`, 소리 복구 시험 파일들, 등록부(RO-01), 결정 문서. 겹치면 손으로 합치지 말고 다시 만드는 편이 안전하다: 이
   증분을 뺀 채 다른 증분을 먼저 놓고, §3.4 ~ §3.6의 대응대로 이름을 다시 바꾼다(TypeScript 언어 서비스의 이름 바꾸기, 그 뒤 옛 이름을 통째
   낱말로 찾기).
3. **언어 서비스가 따라가지 못하는 곳(옛 이름을 통째 낱말로 찾아 확인):** 시험에서 풀어 받은 별칭(`const { x } = recovery`), `vi.mock` 공장의
   키, 주인의 선택자를 흉내 낸 시험 드라이버의 칸(`DialogSelector`), 주석과 문서. `recoveryGeneration`은 `src/player/transport.ts`와
   `src/pro-room/runtime.ts`의 다른 것이라 글자 치환에서 뺀다.
4. **다시 돌릴 점검:** `npm run typecheck`, `npm run lint`, `npm run format:check`, 가드(`node scripts/check-resource-ownership.mts`,
   `guard:dead-exports` 포함), 단위 전체, `npm run build:checked`(버전 올림 뒤), `npm run test:e2e:critical`, 소리 복구 명세
   `e2e/demo-output-recovery.test.ts`, 그리고 손으로 도는 실험실(`playwright.audio-lab.config.ts`). 다른 증분이 주인 파일을 고쳤다면 전후
   비교(§5)는 그 증분의 것과 섞이므로 이 문서의 숫자를 그대로 옮기지 말고 그 열차의 관문 결과를 적는다.
5. **가드 기준선:** 바뀌지 않는다. 자원 소유 가드의 파일별 수(네이티브 `resume()`·`suspend()`, `ensureRunning` 같은 호출 수)와 안 쓰는
   내보내기 가드의 수는 이 증분 전후가 같다(내보내는 값 19개와 형 1개 그대로).
6. **문서에서 같이 고칠 곳:** 열차 보고서에 이 문서를 그 증분의 절로 넣거나 링크한다. `docs/README.md`의 이 문서 항목을 열차 항목 아래로
   옮기거나 합친다. release-record §2의 그 열차 '배포 전' 절에 이 증분을 적는다(범위: 이름만, App 런타임 경로 6, 다른 Worker 0, 계약 경로
   가운데 `src/types/index.ts`의 한 페이지 안 버스 사건 칸 이름 둘). 등록부의 `Last source review` 줄은 이 증분이 고치지 않았다: 열차가
   RO-01의 이름 인용을 그 코드와 다시 맞춰 보고 고친다.
7. **옛 이름으로 적힌 것:** 날짜가 붙은 옛 보고서는 그대로 둔다. release-record §2의 9.0.41, 9.0.42 절처럼 현재 상태 문서에 옛 이름이 인용돼
   있으면(배포 뒤 기록의 근거 문장) 그 절은 그때의 기록이므로 고치지 않고, 이 문서의 대조표(§3.4)를 가리킨다.

## 10. QA 라운드

환경: Windows 11 Pro, Node 24.22.2, npm 12.0.2, Playwright(Chromium), vitest `--maxWorkers=4`. 로컬 결과는 exact-main-SHA 후보를 대신하지
않는다.

### 10.1 전후 비교 라운드 (2026-11-11 14:01 ~ 15:21 KST, main `2d95d49e` 위)

§5와 §6의 표가 이 라운드다: 고치기 전에 재고(단위 전체, 소리 복구 CI 명세 셋, 실험실, 운영 빌드의 크기), 같은 바탕 위의 커밋으로 고친 뒤를
쟀다. 첫 커밋에서 `npm run typecheck`, `npm run lint`, `npm run format:check`, 가드 넷(`check-resource-ownership`, `guard:dead-exports`,
`guard:import-graph`, `guard:bus-pairing`)이 통과했다.

### 10.2 옮긴 뒤 (main `3b8ec6e3` 위의 `544fa678`, 2026-11-11 15:21 ~ 15:44 KST)

이 PR의 세 커밋과 패치가 같은, 9.0.43 / v818 위로 옮긴 갈래 머리에서 돌렸다. 실패, 건너뜀, 재시도는 없었다.

- `npm run typecheck`(모든 프로젝트), `npm run lint`, `npm run format:check` 통과.
- 가드 넷(`check-resource-ownership`, `guard:dead-exports`, `guard:import-graph`, `guard:bus-pairing`) 통과.
- 단위 전체 786 파일 18,848 통과(두 묶음: 8,526과 10,322. 9.0.43이 더한 다섯 행 포함).
- `npm run test:e2e:critical`의 여덟 명세 101 / 101(E2E 빌드, 두 번에 나눠 돌림: 25와 76), `e2e/demo-output-recovery.test.ts` 3 / 3.
- 소리 복구 실험실 26 / 26.
- 돌리지 않은 것: `npm run build:checked`(버전 올림이 없어 `guard:sw-cache-version`에서 섬. 그 앞의 가드 열둘은 옮기기 전 라운드에서 통과),
  `npm run test:e2e:candidate`, `build:checked` 밖의 나머지 가드, `npm run check:workers`, `npm run test:coverage:critical`, WebKit 레인,
  전체 E2E. 얹는 열차의 최종 관문이 돈다.

### 10.3 9.0.43의 기록 위로 옮긴 뒤 (main `c4a3d6f0` 위의 `3de521ff`, 2026-11-11 16:54 ~ 17:06 KST)

9.0.43의 배포 기록(#584, 문서만)이 병합된 뒤 한 번 더 옮긴 이 PR의 머리다. 바탕에서 달라진 것은 문서뿐이고, 세 커밋의 패치는 §10.2의 것과
같다.

- 가드 넷(`check-resource-ownership`, `guard:dead-exports`, `guard:import-graph`, `guard:bus-pairing`), `npm run lint`, `npm run typecheck` 통과.
- 단위 전체 786 파일 18,848 통과(두 묶음: 8,526과 10,322).
- 이 문서와 `docs/README.md`의 항목을 더한 뒤 `npm run format:check` 통과.

## 11. 하지 않은 것과 확인하지 않은 것

- 기기와 브라우저에서 소리 복구를 따로 확인하지 않았다. 멈춘 시계는 일부러 만들 수 없다는 한계([결정 문서](audio-context-ownership.md)의
  'Limits of the evidence')는 그대로이고, 이 증분은 그 경로의 동작을 바꾸지 않는다.
- 섞인 버전의 방은 따로 시험하지 않았다(§7).
- 함수 안 지역 변수의 옛 말과 이웃 파일 주석의 산문(`foreground restart`라는 말)은 고치지 않았다. `src/app.ts`의 기록 문자열
  `'foreground restart preparation'`은 실행 중에 쓰는 글자라 그대로다.
- 프로젝트 전체의 다른 긴 이름은 범위 밖이다.
- PR 검사 가운데 서비스 워커 캐시 버전 가드를 도는 것은 이 PR에서 통과하지 않는다(버전 올림이 일부러 없음).

## 12. 커밋 대응

| 이 PR의 커밋 | 옮기기 전(푸시하지 않음) | 제목                                                                            | 무엇                                                                                    |
| ------------ | ------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `87f5677f`   | `f6eeeb44`               | refactor(audio): the recovery owner's names say play request and playback scope | 주인 파일의 이름, 합친 이름 셋, 부르는 운영 파일과 시험, 등록부와 결정 문서의 이름 인용 |
| `6ba64b4f`   | `869210f4`               | refactor(audio): the play-request attempt keeps one name outside its owner too  | 주인 파일 밖의 이름 넷과 그 인용                                                        |
| `3de521ff`   | `d0c5c634`               | refactor(audio): review follow-ups on the recovery owner's names                | 검토 반영: 이름 셋을 원래대로, 형 이름 셋, 주석과 문서 문장                             |
| 이 문서 커밋 | 없음                     | docs: the recovery-names increment report                                       | 이 문서와 `docs/README.md`의 항목                                                       |
