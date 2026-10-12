# PRO 시작 시계와 관측 경로 수정 — 2026-10-12

## 범위와 상태

오너 요청: 토론에서 합의한 수정과 검증을 진행하고 **로컬 커밋만** 남긴다.
푸시, PR, main 병합, 원격 검사, 배포는 하지 않았다.

- 기준 코드: `eb51ed73ab9561a4b30583127213471ba82bd88f`.
- 시계·학습 수정 검증 코드: `098b74dc93e5cea052afd1f6eed10945762ea063`.
- 직접 재생 관측 보완까지 포함한 코드: `9127561431d6b78dd3ceb65e2a9dee7357575787`.
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
최종 코드의 빌드 로그는 `scratch/pro-start-observation-production-build.log`다.

## 남은 한계와 다음 배포

Android 250ms를 모든 경로에 확대하지 않았다. C1/C7 출력·재개 지연은 기기별
독립 녹음 측정이 필요하다. C13 감지 휴리스틱, OS 시계 불연속·슬립 자동 복구,
타이머 편향 모델은 이번 범위에 넣지 않았다. 단위/브라우저 모형은 실제 Bluetooth,
YouTube 내부 디코더, 장치별 첫 음 정렬을 입증하지 않는다.

릴리스하려면 후속 토론 후 App/SW 버전을 올리고 정상 PR·exact-main CI·Production
Release 절차를 수행해야 한다. 이 로컬 검증은 그 후보가 아니며, 현재 App/SW
버전을 유지한 로컬 커밋을 바로 운영에 배포해서는 안 된다.
