# PRO 시작 시계와 관측 경로 수정 — 2026-10-12

## 범위와 상태

오너 요청: 토론에서 합의한 수정과 검증을 진행하고 **로컬 커밋만** 남긴다.
푸시, PR, main 병합, 원격 검사, 배포는 하지 않았다.

- 기준 코드: `eb51ed73ab9561a4b30583127213471ba82bd88f`.
- 시계·학습 수정 검증 코드: `098b74dc93e5cea052afd1f6eed10945762ea063`.
- 직접 재생 관측 보완까지 포함한 코드: `9127561431d6b78dd3ceb65e2a9dee7357575787`.
- 소켓 단절 중 확정된 시작 보존 후속 코드: `a81bf42d00df179f8531269fe2830979cff4d750`.
- 환경: Windows, Node 24.20.0, Vitest 5.0.3, 로컬 Chromium.
- 운영은 App 8.10.0 / v659 그대로다. 이 수정은 운영에 반영되지 않았다.
- UI, 번역, 권한, 서버 프로토콜, DB, 비밀, 바인딩, 의존성은 바꾸지 않았다.
- [원인 후보 분석](pro-start-sync-candidate-validation-2026-10-12.md)은 수정 전
  코드의 재현과 토론을 보존한다. 현장에서 관찰한 특정 기기의 지연 원인이 이번
  코드 경로였다고 소급 확정하지 않는다.

## 구현

### C2·C4: 작업이 사용할 시계와 다음 작업의 후보 분리

시계 응답을 불변 snapshot으로 만든다. 각 snapshot에는 소켓 세대, 표본 ID,
오프셋, RTT, 수신 시각, 라운드, 출처가 있다. 해당 bridge가 발급했고 현재 연결
세대에 속한 객체인지 검사한다. 같은 숫자를 가진 외부 객체로 대체할 수 없다.

READY에서 선택한 snapshot을 transition에 보관한다. 같은 transition의 COMMIT은
이를 계속 사용한다. 30초 갱신이나 다른 작업의 새 보정이 이미 예약하려는 작업의
오프셋을 바꾸지 않는다. 5초 신선도는 새 작업이 값을 고를 때 적용하며, 진행 중인
작업의 snapshot을 5초가 지났다는 이유로 폐기하지 않는다. 재연결·퇴장은 별개로
세대를 무효화한다.

후보 저장은 현재 소켓의 최대 16개 / 60초 표본으로 제한한다. 성공한 READY
라운드의 늦은 응답은 추가 5초 안에서 다음 선택의 후보로 받을 수 있다. 취소되거나
실패한 라운드의 pending 응답은 폐기한다. 늦은 후보로 이미 확정한 READY를 다시
쓰지 않으며, 이미 실행한 재생을 소급 교정한다고 주장하지 않는다.

### C10(a): 재생 COMMIT의 미보정 fallback 제거

playing COMMIT은 작업 snapshot 또는 유효한 시계를 확보해야 실행한다. READY를
놓친 COMMIT과 직접 COMMIT도 기존 소켓 요청의 응답을 최대 700ms 기다린다.
확보 후 `executeAt − serverNow`의 부호로 미래 예약과 따라잡기를 구분한다.
수신한 프레임의 서버 시각을 현재 시각인 것처럼 사용하는 fallback은 playing에서
허용하지 않는다. paused/idle은 이미 확정된 위치를 적용하므로 시계 확보가 필요 없다.

미디어 실패와 시계 부재를 구분한다. 시계 부재로 미디어 디코딩·catch-up을 반복하지
않고, 적용되지 않은 이전 렌더러를 정리하며 해당 revision을 적용 완료로 기록하지
않는다. 같은 revision당 250ms 뒤 조기 heartbeat 한 번을 요청하고, 이후에는 기존
주기적 복구 경로를 따른다. 새 요청·퇴장·재연결에서 AbortController와 세대 검사를
함께 사용한다. 새 pause/stop은 오래된 700ms 대기를 끝내고 진행한다.

코드 검토 중 추가로 확인한 경계: PREPARE를 받았어도 서버의 frozen cohort 밖인
늦은 참가자는 READY 완료 전에 COMMIT을 받을 수 있다. 미디어 준비 promise와
READY 시계 결과를 분리해 COMMIT이 남은 PREPARE 예산 최대 3초를 먼저 기다리는
일을 막았다. COMMIT은 완료된 READY snapshot을 재사용하거나 자체 700ms 예산으로
시계를 얻는다. 이미 COMMIT을 받은 transition의 늦은 READY 보고도 억제한다.

명시적 Sync와 snapshot 복원도 작업별 snapshot을 넘긴다. 이미 적용된 playing에
대한 `unchanged Play`는 유효 snapshot이 없으면 안전하게 실패하며, 그 경로 자체에
새 시계 대기를 추가하지 않았다. 일반 복구·명시적 Sync의 확보 경로가 남는다.

### C11: callback 지연을 학습값에서 분리

릴리스 callback의 실제 지연과 이미 위치에 반영한 따라잡기 양을 따로 기록한다.
학습 입력은 `관측 drift + max(0, 실제 callback 지연 − 적용한 따라잡기)`다.
drift는 여기서 로컬 위치에서 canonical 위치를 뺀 값이다. 따라서 일회성 30ms
지연만으로 다음 곡 lead를 배우지 않으면서 별도로 남은 미디어 진행 지연은 관측한다.

40ms 이하에서 seek하지 않는 동작, Android 15ms 학습 갱신 기준, 기존 platform
lead, zero-start 구분은 유지했다. 별도 timer EMA나 lead 자동 감쇠는 추가하지 않았다.

### 현장 관측

참가자 메모리에 최대 512개 / 20분의 PRO 시작 관측을 보관하고 기존 flight recorder
복사에 포함한다. 영속 저장, 서버 전송, 추가 콘솔 출력은 없다. 허용한 고정 필드와
분류 문자열만 수집하며 방 코드·회원 ID·곡 ID·URL·임의 메시지는 제외한다. 세션
경계에서 비운다.

- 시계 요청/응답의 벽시각·단조시각, 오프셋, RTT, 세대, 라운드, 실제 선택값.
- 선택 표본과 후보의 RTT, 편차 기반 오차 하한, 두 RTT 구간의 겹침 여부.
  구간 비교 여유 5ms와 이중 시계 차이 관측 여유 50ms를 값과 함께 기록한다.
  후자는 거친 브라우저 시각을 고려한 진단 기준이며 벽시계 스텝 확정이나 자동
  시계 수정 조건이 아니다. 같은 시계 상태·정확한 stamp라는 전제도 필요하다.
- COMMIT의 부호 있는 남은 시간과 실제로 적용한 대기 시간.
- YouTube 릴리스 호출, PLAYING 응답 관측, 0.8초·2초 표본의 실제 시각, 위치,
  잔차, 적격 여부와 제외 사유. scheduled-control은 관측만 하고 학습하지 않는다.
  준비 작업 없이 실행하는 직접 playing 명령도 같은 위치 표본을 남긴다. 이 경로의
  PLAYING 응답 시각은 `null`이며 `playVideo()` 반환을 응답으로 오인하지 않는다.
  직접 명령 표본은 zero-start 학습에 들어가지 않는다.
- 렌더러의 `originalCanonicalExecuteAtMs`는 PLAYING/수동 hold로 재기준화하기 전
  로컬 단조시계 anchor다. 이미 따라잡기 처리된 COMMIT에서는 원본 서버 timestamp가
  아니며 독립적인 시계 정확도 기준도 아니다. PLAYING 역시 실제 첫 음 측정이 아니다.

## 검증

| 검사 | 결과·범위 |
| --- | --- |
| 전체 Vitest, 코드 `098b74dc` | 546파일 **11,787 pass / 0 fail / 0 skip**, 250.01초. 기존 로컬 jq 실행 파일을 `MXQR_TEST_JQ_PATH`로 지정해 jq 계약 검사도 실행 |
| 직접 재생 계측 보완, 코드 `91275614` | YouTube·진단 전체 43파일 **1,097 pass / 0 fail / 0 skip**. 새 직접 재생 6케이스: 늦은 release, 음수 offset/긴 hold, 실제 표본 시각, 미재생·잘못된 위치·offset 변경, 새 pause 취소. App·테스트 타입, 변경 파일 lint·포맷, 프로덕션 빌드·hook 검사 통과 |
| 최종 시계 통합 회귀 | 실제 bridge + controller 12개, network bridge 56개, native preparation 취소 7개: 75/75. 전체 검사에도 포함 |
| TypeScript | App `tsc --noEmit`, 테스트 `tsc -p tsconfig.test.json --noEmit` 통과 |
| ESLint·Prettier | 전체 `src/` lint와 App 포맷 검사 통과 |
| 로컬 Chromium, 코드 `098b74dc` | `playback-sync`, `youtube-sync`: **10/10**, 49.4초 |
| 선행 Chromium | 위 두 파일 + `youtube-manual-zero-start`: **20/20**, 6.5분. 후속 변경은 PRO READY/COMMIT 대기 분리였으며, 이후 두 재생 파일 10개를 위 코드에서 재검사 |
| 프로덕션 빌드, 코드 `098b74dc` | `npm run build`와 production hook/static-header 검사 통과 |
| 선행 `build:checked` | 코드 커밋 전 작업 트리에서 통과. 후속 PREPARE 대기 분리는 위 최종 빌드로 재검사. 캐시 guard는 커밋 이력을 검사하므로 이 결과를 버전 미갱신 최종 커밋의 배포 승인으로 쓰지 않는다 |
| 코드 검토 | 시계·컨트롤러, YouTube 지연 부호·관측 경계, 진단 유한성·개인정보 경계를 분리 검토. 조기 COMMIT의 READY 대기를 추가 수정하고 재현 회귀를 고정 |

첫 전체 실행은 fixture 정비와 겹쳐 71 fail / 5 unhandled / 1 skip이었다.
기존 wall-clock/고정 서버 epoch 혼용, 제거한 bool 시계 API의 mock, 미보정 즉시
재생 가정, 비사용 export ratchet을 정리했다. 새 재연결 fixture는 실제 bridge에
clock 응답을 보내며 늦은 이전 세션 응답의 거부 assertion은 유지한다. 수정 중인
작업 트리의 실행을 최종 결과로 간주하지 않고 위 고정 SHA에서 전체 재실행했다.

로그는 로컬 `scratch/pro-start-final-full-unit.log`,
`scratch/pro-start-final-browser.log`, `scratch/pro-start-e2e.log`,
`scratch/pro-start-final-production-build.log`, `scratch/pro-start-build-checked.log`,
`scratch/pro-start-final-lint.log`, `scratch/pro-start-format.log`에 있다.
GitHub CI와 실기 음향 측정은 이번 요청 범위에서 실행하지 않았다.
직접 재생 계측만 추가한 `91275614`에서는 전체 Vitest와 브라우저 스위트를 다시
반복하지 않고, 위 43파일의 전체 관련 테스트와 타입·빌드로 변경 범위를 검증했다.
`91275614`의 빌드 로그는 `scratch/pro-start-observation-production-build.log`다.

## 2026-10-12 리뷰 후속: COMMIT 후 예기치 않은 소켓 종료

리뷰의 실질적 지적을 수정 전 코드 `bb2680486e17464cd54cbc7ae8026b54612f7567`에서
재현했다. `isClockSnapshotCurrent()`가 연결 여부까지 요구해, 소켓 세대와 발급
토큰이 그대로인 자연 close에도 이미 받은 COMMIT의 작업 시계를 거절했다.

- 파일: COMMIT 후 `initAudio()`를 기다리는 동안 close하면, 준비 완료 뒤 실제
  `AudioBufferSourceNode` 생성·예약을 취소했다. COMMIT +50ms에 close, +200ms에
  초기화 완료, +700ms가 시작 시각인 모형으로 재현했다. 반면 **이미 native 소스를
  예약한 뒤의 close는 수정 전에도 재생을 취소하지 않았다**.
- YouTube: READY 뒤 700ms 미래 COMMIT을 받고 +100ms에 close한 모형에서 arm은
  예약 시각에 `playVideo()`를 호출했다. 이후 COMMIT 결과 검증이 lease를 거절해
  적용 기록이 남지 않고 renderer 무효화로 다시 멈췄다. 예약 callback 자체가
  실행되지 않는 문제로 해석하지 않는다.

수정은 lease 유효성에서 연결 조건만 제거한다. 현재 세대와 해당 bridge의 발급
토큰은 계속 검사하고, 새 capture/acquire는 단절 상태에서 거절한다. 명시적 퇴장과
**소켓 교체 시작**은 세대를 올려 기존 lease를 폐기한다. 교체 handshake 성공까지
기다리지 않으며, 실패한 교체 시도도 같다. 이 보장은 자연 close와 교체 사이의
구간에 한정된다. 재연결 이후에는 기존 snapshot 복원·따라잡기 경로를 사용한다.
미보정 `serverNowMs`가 로컬 벽시각이라는 주석도 추가했다. 반환형·동작은 그대로다.

추가 회귀는 bridge 2개, 실제 파일 transport 통합 7개, 실제 YouTube arm과 controller
통합 1개다. 소켓·오디오 장치·iframe 표면은 모사하지만 검사 대상 bridge, controller,
파일 재생 및 YouTube 적용 코드는 실제 모듈이다. YouTube는 런타임의 control-channel
recovery 호출도 포함한다. 파일 검사는 자동 heartbeat 재접속을 모사하지 않는다.

수정 전 bridge 2개와 파일 초기화 1개가 실패했고, YouTube는 적용 기록·renderer
무효화·재생 상태 검사가 실패했다. 수정 후 해당 검사들이 통과했다. 파일의 명시적
disconnect, 소켓 교체, 새 paused revision, 방 초기화는 계속 시작을 취소한다.
리뷰가 권고한 다른 두 핀은 기존 `playback-clock-safety.test.ts`에 이미 있다.
새 pause/stop이 오래된 시계 대기를 즉시 끝내는 검사와, 조기 COMMIT이 별도 예산에서
후보를 사용하고 늦은 READY 보고를 억제하는 검사를 다시 실행했다.

후속 검증은 위 `a81bf42d` 코드와 Windows / Node 24.20.0 / Vitest 5.0.3 기준이다.

| 후속 검사 | 결과·범위 |
| --- | --- |
| PRO room·player·YouTube·diagnostics 전체 Vitest | 186파일 **4,393 pass / 0 fail / 0 skip**, 53.88초. 위 신규 회귀·기존 핀을 모두 포함 |
| TypeScript | App와 테스트 전체 타입 검사 통과 |
| ESLint·Prettier | 변경한 4개 소스/테스트 파일 통과 |
| 프로덕션 빌드 | `npm run build`와 production hook/static-header 검사 통과. 버전 미갱신 로컬 변경의 배포 승인은 아님 |

기기·Bluetooth 실측, 브라우저 E2E, 원격 CI, 전체 프로젝트 Vitest는 이 작은 후속
수정에서 다시 실행하지 않았다. 기존 전체 검사 결과를 이 코드의 전체 통과로
대체 표기하지 않는다. 독립 읽기 전용 검토에서 추가 actionable finding은 없었다.

재현 로그: `scratch/pro-clock-close-bridge-red.log`,
`scratch/pro-clock-close-file-red-with-controls.log`,
`scratch/yt-start-audit-2026-10-12/socket-lease-red.log`.
신규 회귀와 기존 핀을 포함한 개별 검사 합계는 **114 pass / 0 fail / 0 skip**이다.
YouTube 전체 파일 첫 실행에서 새 테스트의 mock 구현 복원이 빠져 기존 테스트
1개가 실패했으며, fixture를 명시적으로 복원한 뒤 37개 전체가 통과했다.
이는 제품 변경을 요구한 실패가 아니며 위 최종 관련 검사에도 포함했다.
최종 로그: `scratch/pro-clock-close-related-green.log`,
`scratch/pro-clock-close-app-types.log`, `scratch/pro-clock-close-test-types.log`,
`scratch/pro-clock-close-lint.log`, `scratch/pro-clock-close-format.log`,
`scratch/pro-clock-close-build.log`.

## 남은 한계와 다음 배포

Android 250ms를 모든 경로에 확대하지 않았다. C1/C7 출력·재개 지연은 기기별
독립 녹음 측정이 필요하다. C13 감지 휴리스틱, OS 시계 불연속·슬립 자동 복구,
타이머 편향 모델은 이번 범위에 넣지 않았다. 단위/브라우저 모형은 실제 Bluetooth,
YouTube 내부 디코더, 장치별 첫 음 정렬을 입증하지 않는다.

릴리스하려면 후속 토론 후 App/SW 버전을 올리고 정상 PR·exact-main CI·Production
Release 절차를 수행해야 한다. 이 로컬 검증은 그 후보가 아니며, 현재 App/SW
버전을 유지한 로컬 커밋을 바로 운영에 배포해서는 안 된다.
