# YouTube 팝업 초기 포커스 경합 수정 — 2026-10-13

## 현재 상태와 범위

**원인 확인·수정·로컬·원격 검증 및 App 8.10.8 배포 완료.** Windows 자연 실패 3건의 타이머·
포커스·키 이벤트 순서를 수집해 원인을 확인하고 수정했다. 로컬 전체 unit·정적
검사·production candidate·Chromium·WebKit, 원격 두 OS 반복·Full E2E와 최종
PR CI, exact-main CI를 통과한 뒤 2026-10-13 16:51:42 KST에 App 배포 job을
완료했다. 운영 소유권·호환성·smoke와 배포 후 Drift Audit도 확인했다. 원격 반복의
100ms 경계 검증 한계와 기존 플랫폼 skip은 아래에 따로 기록한다.

- E2E 진입 순서 수정: `1771b0c5e0a4a0c6a5b4d23ff537c3f2956e5cd2`.
- 제품 수정·관련 단위 회귀 코드: `594fbc5dc9ca5f43e9f4a302cc0a420a81e9fa6a`.
- 원격 전체검증 source `c2495f66c22a7cc2bd3391fddefc44bf0494024a`는 위 제품·
  테스트 코드와 같고 임시 진단 workflow를 원본 Full E2E로 복원한 커밋이다.
- 로컬 Chromium 검증 App·테스트는 `834719b895e3667aa17e0b5f99bf78bccd47d41f`이며,
  실행 중 문서만 바꾼 `e8a22f2c`를 커밋했다. 뒤이은 WebKit 실행과 production SW
  재빌드는 `e8a22f2c`에서 진행했다. 제품·테스트 코드는 모두 `594fbc5d`와 같다.
- PR [#319](https://github.com/hiefny/MUSIXQUARE/pull/319)는 2026-10-13
  07:43:02 UTC(16:43:02 KST)에 main `dc69bda07ff2ffe614d0e34a9d0d5657da65676b`로
  병합됐고, 이 exact-main SHA의 CI 후보로 배포했다.
- App `8.10.8` / SW cache `v669`, 배포 범위 `app`, Developer API D1 `false`.
  새 의존성·스키마·비밀·바인딩·프로토콜·복구 floor 변경은 없다.
- 사용자 요청은 진입 순서 수정과 Windows 후반 실패의 원인 확인·수정,
  로컬·원격 검증 통과 후 제품 변경 배포다. 원인이 불명확하면 중단하고 배포하지
  않는 조건이었다. 자연 실패의 원인과 수정 효과를 확인하고 필요한 검증을 마친 뒤
  배포했다.
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

최초 계측 실행 [38355563510](https://github.com/hiefny/MUSIXQUARE/actions/runs/38355563510)은
8자리 SHA ref checkout에서 실패해 테스트를 실행하지 못했고, 40자리 SHA로 고정한
38355671404에서 실제 계측을 진행했다.

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

## 검증 결과와 한계

| 범위 | 코드·환경 | 결과 |
| --- | --- | --- |
| 수정 전 자연 실패 계측 | 진입 수정 `1771b0c5`, GitHub-hosted Ubuntu·Windows, OS별 30회 | Ubuntu 30 pass / 0 fail, Windows 27 pass / 3 fail; 세 실패 인과 확인 |
| 수정 전 로컬 계측 baseline | 사용자 Windows PC, 30회 | 30 pass; 원격 실패를 부정하는 근거가 아님 |
| 새 단위 회귀의 수정 전 실행 | 로컬 Windows, 4개 | 1 fail / 3 pass |
| 수정 후 관련 단위 파일 | `594fbc5d`, 로컬 Windows | 197 pass / 0 fail |
| 수정 후 원격 반복 | `594fbc5d`, Ubuntu·Windows, OS별 30회; [38356696388](https://github.com/hiefny/MUSIXQUARE/actions/runs/38356696388) | 최종 success; 각 30 pass / 0 fail / 0 skip / 0 flaky / 0 retry |
| 수정 후 로컬 반복 | 동일 제품 코드, Windows, 30회 | 30 pass / 0 fail, 56.5초 |
| 로컬 정적 검사·build | 수정 후 코드, Windows | typecheck·lint·format·guards·build:checked 통과 |
| 로컬 전체 unit | 동일 제품 코드, Windows, `maxWorkers=2`, jq 경로 명시 | 558파일 / 12,580 pass / 0 fail / 0 skip, 492.97초 |
| 로컬 production candidate browser | build:checked 산출물, Windows | 17 pass / 0 fail, 33.8초 |
| 로컬 전체 Chromium | `834719b8`, Windows | 627 pass / 0 fail / 0 skip, 54.0분 |
| 로컬 WebKit UI | `e8a22f2c`, 동일 제품·테스트 코드, Windows | 66 pass / 0 fail / 기존 플랫폼 3 skip, 2.6분 |
| 로컬 production WebKit SW | `e8a22f2c`, 동일 제품·테스트 코드, Windows | 1 pass / 0 fail, 9.1초 |
| 원격 Full E2E | `c2495f66`; [38356792927](https://github.com/hiefny/MUSIXQUARE/actions/runs/38356792927) | 최종 success; Chromium 627 pass / 0 fail / 0 skip(54.7분), WebKit UI 66 pass / 3 skip, SW 1 pass, 운영 R2 1 pass |
| 이전 PR CI 상세 근거 | head `834719b8`, PR merge checkout `2e968bf7`; [38357542283](https://github.com/hiefny/MUSIXQUARE/actions/runs/38357542283) | 11 jobs 성공; 아래 상세 집계 |
| 최종 PR CI | head `e8a22f2c`; [38363135227](https://github.com/hiefny/MUSIXQUARE/actions/runs/38363135227) | 11 jobs 성공; unit 12,579 pass / 0 fail / Windows 전용 1 skip |
| exact-main CI 후보 | `dc69bda0`; [38364448487](https://github.com/hiefny/MUSIXQUARE/actions/runs/38364448487) | 11 jobs 성공; unit 558파일 / 12,579 pass / 0 fail / Windows 전용 1 skip; candidate browser 17 pass, critical browser 24 pass |
| Production Release | `dc69bda0`, App `8.10.8` / `v669`; [38365146388](https://github.com/hiefny/MUSIXQUARE/actions/runs/38365146388) | attempt 1 성공, `app` / D1 `false`; 2026-10-13 16:51:42 KST 배포 job 완료 |

원격은 Node `24.20.0`·저장소 lockfile과 Playwright Chromium을 사용한다. 수정 후
반복도 동일 SHA를 checkout한 임시 runner에서 계측을 추가했으며, 제품 동작·기존
assertion·timeout·retry 기준을 완화하지 않는다. 최종 전체검증은 별도 결과로
기록하고, 실패·skip을 통과 수에 합치지 않는다. 실기기·물리 키보드나 실제 YouTube
서비스의 검증을 이번 자동화 결과로 주장하지 않는다.

수정 후 원격 반복 JSON 소요는 Ubuntu 61,503ms, Windows 69,670ms다. **이 60회는
모두 100ms 타이머가 발화하기 전에 Escape로 팝업을 닫았다**(Windows 67.9–97.0ms,
Ubuntu 62.4–93.2ms). 따라서 정상 진입·입력·Tab·닫기 흐름의 회귀 증거이며, 반복
통과만으로 100ms 시점의 focus 보호 분기가 실행됐다고 주장하지 않는다. 타이머
시점에 Cancel focus를 보존하는 경계는 수정 전 RED → 수정 후 GREEN인 단위
회귀가 직접 검증한다.

이전 PR CI 38357542283은 unit 두 shard의 5,976 + 6,603 pass를 합쳐 558파일 / 12,579 pass /
0 fail / 1 skip이다. skip은 `pro-grant-campaign-cli.test.ts`의
`rejects another drive before reading or creating an artifact`로 Windows 전용이며,
로컬 Windows 전체 실행에서는 포함돼 통과했다. production candidate browser는
17 pass, critical browser는 24 pass다. build:checked의 app-shell 94 assets와
v669, Worker 6종 번들도 통과했다. 이 PR 결과는 exact-main 후보가 아니다.
최종 PR CI와 exact-main CI도 11개 job을 모두 통과했으며, exact-main unit은 같은
5,976 + 6,603 pass와 Windows 전용 1 skip을 확인했다. exact-main의 candidate
17개와 critical browser 24개도 통과했다.

| CI 38357542283 coverage | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Broad | 86.97% | 81.01% | 91.54% | 90.56% |
| Critical | 82.01% | 77.02% | 88.06% | 86.09% |
| Worker | 85.45% | 82.25% | 93.42% | 89.89% |
| Tooling | 78.23% | 73.78% | 87.09% | 80.10% |

네 coverage gate 모두 통과했다. profile별 unit은 전체 unit과 겹치므로 통과 수에
더하지 않는다. 로컬·원격 WebKit의 기존 3 skip은 desktop entrance timing, 모바일에서
숨은 carousel 화살표, touch-only 환경의 hover 조건이다. SW lifecycle은 별도로
1 pass다. 운영 R2 smoke는 실행 당시 운영 배포를 검사했으므로 새 제품 코드의 검증을 대신하지
않는다. 전체 Chromium 627 pass는 별도 job 로그로 확인했으며 2026-10-13
07:23:07 UTC(16:23:07 KST)에 검사가 끝났다. 로컬 전체 검증 스크립트도 최종 성공했고
Chromium 627개와 WebKit UI·production SW 결과를 각 로그에서 확인했다.

로컬 최초 format·build의 `guard:index-hreflang` 실패는 버전 교체 스크립트가 파일을
CRLF로 다시 쓴 데서 발생했다. LF로 복원한 뒤 format과 build:checked를 통과했고
Git blob 내용 변화는 없었다. 확인한 원인은 작업 파일의 줄바꿈이며 추가 제품 결함으로
분류하지 않는다. 처음 실패한 실행을 통과로 바꾸지 않고 복원 후 결과를 구분한다.

## 프로덕션 배포와 복구

[Release 38365146388](https://github.com/hiefny/MUSIXQUARE/actions/runs/38365146388)은
exact-main `dc69bda07ff2ffe614d0e34a9d0d5657da65676b`의 성공 CI 후보를 사용했다.
App version은 `b790efb9-3c18-451b-b29b-9f437fe25f04`, deployment는
`2a9b03b7-b5b5-4eed-98e8-cbcf7af75dad`이며 단일 version 100%다.
16:51:38.697 KST에 App 최종 소유권을 확인했고, 16:51:39.409 KST에 coherent
production marker를 영속화했다. 미선택 Worker 5종은 `08df0606`을 유지하며
부분 배포 호환성 재검증을 통과했다.

운영 smoke는 App generation, 익명 계정 경계, PRO 공개 경로, Standard HTTPS
signaling 4종 성공 / 범위 밖 6종 skip이다. 공개 en·ko·ar·it·pl·ru와 SW는
HTTP 200 및 v669를 확인했고, 공지는 `enabled:false, revision:8`을 유지했다.
점검·공지를 변경하지 않았다. 배포 후
[Operations Drift Audit 38365435739](https://github.com/hiefny/MUSIXQUARE/actions/runs/38365435739)은
16:52:38 KST에 성공했다. 16:52:27.713 KST에 생성한 보고서의 checks는
31 pass / 0 fail / 5 manual-only다. 수동 항목은 자동 통과로 취급하지 않는다.

복구 job은 skip됐고 롤백하지 않았다. 변경 전 App `6b159667`, version
`434ad128-8f40-44cb-a1f7-8325eb16796b`, deployment
`6a182693-ba52-4e85-a22c-5f5cd65e2a77`를 불변 checkpoint에 보존했다.
checkpoint와 최종 산출물의 `app-before.json`은 SHA-256
`feb6586e54e28fd2b8d4e35c47261f90272f35d4f0aa19422d16db289fd5aca5`로 일치한다.
이 호환 App으로 복구하면 지연 초기 focus가 사용자 Tab 이동을 덮어쓰는 문제가
돌아온다. checkpoint는 사용자 데이터 백업이 아니며 새 의존성·스키마·비밀·바인딩·
프로토콜·복구 floor 변경이나 down migration은 없다. 현재 운영 기준은
[릴리스 기록 §1](../release-record.md#1-현재-운영-상태)에 반영했다.
후속 문서 기록 PR은 별도 App 배포를 요구하지 않는다.

## 증거

- 자연 실패 원본: `scratch/focus-linux-audit/windows-timeline/failure-6.json`,
  `failure-20.json`, `failure-23.json`; 같은 폴더의 `focus-results.json`과 HTML report.
- Ubuntu 원본: `scratch/focus-linux-audit/linux-timeline/focus-results.json`.
- 로컬 baseline: `scratch/focus-linux-audit/local-timeline.log`와 timeline JSON.
- 단위 파일 결과: `scratch/focus-linux-audit/unit-fixed.log`.
- 수정 후 반복 workflow 사본: `scratch/focus-linux-audit/workflow-fixed.yml`.
- 수정 후 원격 반복 원본: `scratch/focus-linux-audit/linux-fixed/focus-results.json`,
  `scratch/focus-linux-audit/windows-fixed/focus-results.json`.
- PR CI 원본: `scratch/focus-linux-audit/ci-unit-1.log`, `ci-unit-2.log`,
  `ci-browser.log`, `ci-candidate.log`, `ci-coverage-{broad,critical,workers,tooling}.log`.
- 원격 전체 Chromium 로그: `scratch/focus-linux-audit/remote-e2e-full.log`.
- 로컬 전체 브라우저 로그: `scratch/focus-linux-audit/local-e2e-full.log`,
  `local-webkit.log`, `local-webkit-sw.log`.
- 배포 원본: `scratch/focus-linux-audit/release-artifacts/deployments/app-state.json`,
  `final-verification-report.json`, `partial-release-compatibility-recheck.json`.
- 복구 기준선: `scratch/focus-linux-audit/checkpoint/app-before.json`과
  `scratch/focus-linux-audit/release-artifacts/deployments/app-before.json`.
- coherent marker: `scratch/focus-linux-audit/production-commit/production-committed.json`.
- 배포 후 점검: `scratch/focus-linux-audit/public-verification.json`,
  `scratch/focus-linux-audit/drift/report.json`.
