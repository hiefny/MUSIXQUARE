# YouTube 팝업 초기 포커스 경합 수정 — 2026-10-13

## 현재 상태와 범위

**원인 확인·수정 완료, 전체 검증·배포 대기.** Windows 자연 실패 3건의 타이머·
포커스·키 이벤트 순서를 수집해 원인을 확인하고 수정했다. 관련 단위 파일과 수정
뒤 원격 Ubuntu·Windows 각 30회 반복은 통과했다. 로컬·원격 전체 검증과
exact-main CI 후보·배포는 아직 완료되지 않았다. 진행 중인 결과를 통과로 간주하지 않는다.

- E2E 진입 순서 수정: `1771b0c5e0a4a0c6a5b4d23ff537c3f2956e5cd2`.
- 제품 수정·관련 단위 회귀 코드: `594fbc5dc9ca5f43e9f4a302cc0a420a81e9fa6a`.
- 원격 전체검증 source `c2495f66`은 위 제품·테스트 코드와 같고 임시 진단
  workflow를 원본 Full E2E로 복원한 커밋이다.
- App `8.10.8` / SW cache `v669`, 예정 배포 범위 `app`, Developer API D1 `false`.
  새 의존성·스키마·비밀·바인딩·프로토콜·복구 floor 변경은 없다.
- 사용자 요청은 진입 순서 수정과 Windows 후반 실패의 원인 확인·수정,
  로컬·원격 검증 통과 후 제품 변경 배포다. 원인이 불명확하면 중단하고 배포하지
  않는 조건이었다. 원인 확인 뒤에도 남은 검증이 끝날 때까지 배포하지 않는다.
- 이전 A/B와 그 당시의 미확정 판단은
  [원격 진단 보고서](youtube-focus-linux-diagnostic-2026-10-13.md)에 보존한다.
  이 문서는 뒤이어 확보한 인과 증거와 수정 결과다.

## 자연 실패에서 확인한 원인

첫 문제는 미디어 선택 팝업의 준비·초기 포커스를 확인하지 않고 YouTube 버튼에
직접 focus·Enter를 보낸 검사 절차였다. `1771b0c5`는 팝업 active·visible과 최초
local-file focus를 확인한 뒤 실제 Tab으로 YouTube 버튼으로 이동한다. 기존 Enter,
입력·삭제 안내 및 양방향 Tab 순환 assertion은 유지했다.

이 절차에서도 남았던 Windows 후반 실패를
[계측 실행 38355671404](https://github.com/hiefny/MUSIXQUARE/actions/runs/38355671404)에서
다시 관측했다. 제품 수정 전 같은 검사를 OS별 30회, Chromium headless,
`workers=1`, `retries=0`으로 실행했다. GitHub-hosted Ubuntu는 30 pass / 0 fail,
Windows는 27 pass / 3 fail이며 둘 다 skip·flaky는 0이었다. Windows JSON report
소요는 118,910.365ms다. 로컬 Windows의 계측 baseline은 30회 모두 통과했으므로
사용자 PC와 GitHub-hosted Windows 결과를 같은 환경으로 보지 않는다.

계측은 원래 타이머·focus 호출을 실행하면서 호출 stack과 `performance.now()` 시각,
`focusin/out`, `keydown/up`을 기록했다. 의도적인 지연이나 강제 타이머 발화 없이
발생한 실패 6·20·23에서 모두 다음 순서를 확인했다.

1. 앞선 Tab 순환으로 Cancel에 focus가 있었고 해당 assertion도 통과했다.
2. 팝업을 열 때 예약한 100ms 타이머가 실행됐다. 그 stack에서 무조건 실행한
   `input.focus()`가 사용자 focus를 Cancel에서 입력창으로 되돌렸다.
3. 마지막 Tab은 이미 입력창이 활성화된 상태에서 발생했다. modal Tab 순환은
   현재 activeElement를 기준으로 다음 Cancel로 이동했다.
4. 검사는 입력창을 기대했지만 Cancel이 활성 상태로 남아 실패했다.

각 행은 독립된 페이지의 `performance.now()` 기준 ms이며 서로 절대 시각을
비교하지 않는다.

| 실패 | Cancel 상태의 timer-fire | 타이머의 input.focus 호출 | 입력창에서 마지막 Tab keydown | Tab의 Cancel focus 호출 |
| --- | --- | --- | --- | --- |
| 6 | 1569.7 | 1569.8 | 1572.0 | 1572.2 |
| 20 | 1528.2 | 1528.2 | 1529.4 | 1529.5 |
| 23 | 1494.5 | 1494.6 | 1496.6 | 1496.7 |

이 세 실패의 원인은 초기 modal focus와 별개로 남아 있던 지연 초기 focus가
사용자의 후속 Tab 이동을 덮어쓴 경합이다. 이전 보고서에서는 명령 시각만 있어
후보였지만, 이번에는 타이머 발화·focus 호출 stack·후속 키 이벤트로 연결했다.
OS 자체를 결함 원인으로 단정하거나 모든 포커스 문제의 원인을 일반화하지 않는다.

## 수정과 회귀 범위

`src/ui/player-controls.ts`의 `yt-url-focus`는 100ms 초기 fallback을 유지하되,
입력이 DOM에 연결돼 있고 overlay가 active이며 inert 영역이 아닐 때만 진행한다.
현재 focus가 없거나 body·overlay 자체에 남아 있을 때만
`input.focus({ preventScroll: true })`한다. 이미 입력창이나 Cancel 등 다른 곳으로
이동한 focus를 덮어쓰지 않는다. 기존 닫기 시 timer 취소와 opener 복원도 유지한다.

신규 단위 회귀 4개는 다음 경계를 확인한다.

- 초기 입력 focus → 50ms에 Tab으로 Cancel 이동 → 100ms 타이머 뒤에도 Cancel
  유지 → 다음 Tab으로 입력창 복귀.
- body에 focus가 남은 포인터 진입에서 초기 입력 focus 복구.
- overlay 자체에 focus가 남은 진입에서 초기 입력 focus 복구.
- 100ms 전에 닫았을 때 opener focus가 이후에도 유지됨.

제품 수정 전 새 4개는 1 fail / 3 pass로 경합을 재현했다. 수정 후
`src/ui/__tests__/player-controls.test.ts` 전체는 197 pass / 0 fail이다.
독립 읽기 전용 리뷰에서 추가 finding은 없었다. 이 결과는 전체 unit·브라우저
검증이나 exact-main 배포 후보를 대신하지 않는다.

## 검증 결과와 남은 단계

| 범위 | 코드·환경 | 결과 |
| --- | --- | --- |
| 수정 전 자연 실패 계측 | 진입 수정 `1771b0c5`, GitHub-hosted Ubuntu·Windows, OS별 30회 | Ubuntu 30 pass / 0 fail, Windows 27 pass / 3 fail; 세 실패 인과 확인 |
| 수정 전 로컬 계측 baseline | 사용자 Windows PC, 30회 | 30 pass; 원격 실패를 부정하는 근거가 아님 |
| 새 단위 회귀의 수정 전 실행 | 로컬 Windows, 4개 | 1 fail / 3 pass |
| 수정 후 관련 단위 파일 | `594fbc5d`, 로컬 Windows | 197 pass / 0 fail |
| 수정 후 원격 반복 | `594fbc5d`, Ubuntu·Windows, OS별 30회; [38356696388](https://github.com/hiefny/MUSIXQUARE/actions/runs/38356696388) | 최종 success; 각 30 pass / 0 fail / 0 skip / 0 flaky / 0 retry |
| 로컬 정적 검사 | 수정 후 코드, Windows | typecheck·lint·format 통과 |
| 로컬 전체 unit | 수정 후 코드, Windows, 2 workers | 실행 중, pending |
| 원격 Full E2E | `c2495f66`; [38356792927](https://github.com/hiefny/MUSIXQUARE/actions/runs/38356792927) | WebKit·운영 R2 job 성공, 전체 Chromium 진행 중; workflow 최종 결과 pending |
| 나머지 로컬 전체검증·PR CI | 최종 코드 | pending |
| exact-main 후보·Production Release | App `8.10.8` / `v669` | pending, 아직 배포하지 않음 |

원격은 Node `24.20.0`·저장소 lockfile과 Playwright Chromium을 사용한다. 수정 후
반복도 동일 SHA를 checkout한 임시 runner에서 계측을 추가했으며, 제품 동작·기존
assertion·timeout·retry 기준을 완화하지 않는다. 최종 전체검증은 별도 결과로
기록하고, 실패·skip을 통과 수에 합치지 않는다. 실기기·물리 키보드나 실제 YouTube
서비스의 검증을 이번 자동화 결과로 주장하지 않는다.

수정 후 원격 반복 JSON 소요는 Ubuntu 61,503ms, Windows 69,670ms다. 운영 R2
smoke는 현재 배포를 검사하므로 새 제품 코드의 검증을 대신하지 않는다. WebKit·R2
job 성공을 전체 Chromium이나 workflow 전체 통과로 확장하지 않는다.

## 증거와 복구

- 자연 실패 원본: `scratch/focus-linux-audit/windows-timeline/failure-6.json`,
  `failure-20.json`, `failure-23.json`; 같은 폴더의 `focus-results.json`과 HTML report.
- Ubuntu 원본: `scratch/focus-linux-audit/linux-timeline/focus-results.json`.
- 로컬 baseline: `scratch/focus-linux-audit/local-timeline.log`와 timeline JSON.
- 단위 파일 결과: `scratch/focus-linux-audit/unit-fixed.log`.
- 수정 후 반복 workflow 사본: `scratch/focus-linux-audit/workflow-fixed.yml`.
- 수정 후 원격 반복 원본: `scratch/focus-linux-audit/linux-fixed/focus-results.json`,
  `scratch/focus-linux-audit/windows-fixed/focus-results.json`.
- 현재 운영 배포·복구 기준선은 [릴리스 기록 §1](../release-record.md#1-현재-운영-상태)을
  유지한다. 변경은 App UI 초기 focus에 한정된다. 이전 호환 App으로 복구하면
  지연 초기 focus가 사용자 Tab 이동을 덮어쓰는 문제가 돌아온다. 데이터·서버
  계약 변경이나 down migration은 없다.
