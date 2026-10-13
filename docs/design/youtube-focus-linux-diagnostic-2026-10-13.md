# YouTube 키보드 포커스 원격 반복 진단 — 2026-10-13

## 상태와 범위

**진단 완료, 관찰 유지:** A는 두 OS에서 최초 진입 실패를 총 39회 재현했다.
B는 최초 진입 60회를 모두 통과했지만 Windows의 후반 Tab 순환에서 3회 실패해
전체 57 pass / 3 fail이다. 원래 검사의 진입 절차가 불충분하다는 근거와 별도로
후반 포커스 문제가 남아 있다. B 전체 통과나 완전한 수정으로 간주하지 않는다.

- 사용자가 같은 코드를 Linux에서 반복 검사하도록 승인했다.
- 고정 checkout: `4ca74b2433efa2d350015f63ede656f1d8728f99`.
- 대상: `e2e/youtube-search-interactions.test.ts`의
  `keeps the empty editable input in both directions of the modal Tab cycle`.
- GitHub-hosted Ubuntu·Windows에서 OS별 30회, Chromium headless,
  `workers=1`, `retries=0`, Node `24.20.0`, Playwright `1.63.0`으로 반복했다.
  GitHub-hosted Windows와 사용자의 Windows PC는 동일한 환경이 아니다.
- A의 두 OS는 Chrome `153.0.8010.12` / Playwright Chromium `1243`으로 같았다.
  Ubuntu image는 `20261004.327.1`, Windows는 `windows-2025-vs2026` image
  `20260925.250.1`이었다.
- 제품 코드는 바꾸지 않는다. 진단 workflow는 임시 실행용이며 이 보고서는
  프로덕션 변경이나 새로운 배포를 기록하지 않는다. 운영 상태·복구 기준선은
  [현재 릴리스 기록](../release-record.md)을 따른다.
- 제품 수정·배포는 하지 않았고 main의 원래 테스트도 그대로다. 비교용 변경은
  임시 runner에서만 적용했으며, 결과 문서만 PR로 남기고 실제 수정 여부는
  다음 사용자 결정으로 남긴다. 두 실행 종료·산출물 다운로드 후 진단 브랜치
  `agent/youtube-focus-diagnostic`는 로컬·원격 모두 삭제했다. 문서 기록 브랜치만
  남아 있으며 A/B workflow 사본은 아래 증거 경로에 보존했다.

## 기존 실패에서 확인한 것

원본 Full E2E [38328670967](https://github.com/hiefny/MUSIXQUARE/actions/runs/38328670967)는
변경 전 main `4854e392ce8cc020114ae20864ed047c0959ebac`에서 serial 626 pass /
1 fail / 0 skip이었다. 2026-10-13 10:46:21 KST 완료됐다.

실패 test는 위 키보드 검사이며, 원본 코드 90행의 `expect(input).toBeFocused()`가
15초 뒤 실패했다(retry 0). HTML report의 단계별 UTC 시각은 다음과 같다.

| 단계 | 시작(UTC) | 소요 |
| --- | --- | --- |
| opener에 programmatic focus | 01:44:34.416 | 5ms |
| Enter | 01:44:34.421 | 3ms |
| YouTube source 버튼에 programmatic focus | 01:44:34.425 | 4ms |
| Enter | 01:44:34.429 | 2ms |
| YouTube input focus 확인 | 01:44:34.432 | 15,001ms 뒤 실패 |

실패 snapshot에는 `Select media to play` 대화상자와 Load local file·YouTube·
System Audio·Close가 남아 있었다. YouTube 입력창 진입 전 미디어 선택 팝업에
머물렀다는 증거이며, 입력·삭제·Tab 순환 검사는 실행하지 못했다. input locator는
34회 inactive로 보고됐다. 원본은 `activeElement`와 키 이벤트 대상을 수집하지
않았고 해당 실패 폴더에는 error-context만 있어 trace·PNG·video도 없다. 원본의
실제 포커스 대상이나 어느 단계가 경합했는지는 이 증거만으로 확정할 수 없다.

이 검사는 2026-10-09 `0fc46bad`에 도입됐다. 10월 7일 원격 581 pass 실행에는
없었으며, 정규 CI의 critical browser subset에도 포함되지 않는다. 따라서 이전
Full E2E 통과나 이번 릴리스 CI 통과를 이 검사 자체의 반복 안정성 근거로 쓰지 않는다.
사용자 PC의 `6b159667` 로컬 5회 통과도 환경을 바꾼 이번 결과와 구분한다.

## A/B 진단 설계와 결과

A [38338822645](https://github.com/hiefny/MUSIXQUARE/actions/runs/38338822645)는
workflow `97deb0cd`에서 고정 checkout을 검사한다. 제품 코드와 원래 테스트 단계·
assertion을 유지하며, 실패한 뒤에만 `activeElement`·DOM·PNG를 수집하는 hook을
추가했다. 실패 직전 동작을 바꾸거나 timeout을 완화하지 않았다.

B [38339571035](https://github.com/hiefny/MUSIXQUARE/actions/runs/38339571035)는
workflow `3355365c`에서 같은 checkout을 검사한다. 임시 runner의 테스트에서
`youtubeButton.focus()` 한 단계만 다음 순서로 대체한다.

1. 미디어 선택 팝업의 active·visible과 최초 local-file 버튼 focus를 확인한다.
2. 실제 Tab 키를 누르고 YouTube source 버튼 focus를 확인한다.
3. 기존 Enter·YouTube 입력창 focus·입력 삭제 후 안내·양방향 Tab 순환 검사를 유지한다.

최초 opener의 programmatic focus는 A/B 동일하다. 임의 sleep, timeout 완화,
View Transition 조작, 제품 코드 변경은 없다. 최초 local-file focus는 modal stack
동기화에서도 설정할 수 있으므로, 그 확인만으로 0ms 초기 focus 타이머가 끝났다고
단정하지 않는다. Tab 뒤 YouTube 버튼 focus assertion도 유지한다.

| 실험 | 환경 | 반복 실행 | pass | fail | skip | retry | 상태 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A: 기존 진입 절차 | Ubuntu hosted | 30회 | 9 | 21 | 0 | 0 | 결과 확인 |
| A: 기존 진입 절차 | Windows hosted | 30회 | 12 | 18 | 0 | 0 | 결과 확인 |
| B: 준비 확인 후 실제 Tab | Ubuntu hosted | 30회 | 30 | 0 | 0 | 0 | 결과 확인 |
| B: 준비 확인 후 실제 Tab | Windows hosted | 30회 | 27 | 3 | 0 | 0 | 결과 확인 |

A는 workflow 전체 failure로 완료됐다. Ubuntu 21회·Windows 18회, 총 39회 실패는
모두 최초 input focus 확인에서 발생했다(진단 hook 삽입 뒤 104행). 실패 후 채집된
`activeElement.id`는 모두 `btn-local-file`, YouTube overlay의 `display`는 모두
`none`이었다. 두 OS 모두 retry·flaky는 0이다. 현재 코드에서도 앞단 미디어 선택
팝업에 남는 실패를 반복 재현했으며, Linux에만 발생한다는 설명은 반증됐다.
이것만으로 제품 포커스 결함·검사 절차 문제 중 하나나 구체적인 경합 원인을
확정할 수 없다.

B Ubuntu는 30 pass / 0 fail, Windows는 27 pass / 3 fail이었다. 두 OS 모두
skip·flaky·retry는 0이며 JSON report 소요는 각각 65,393.415ms·130,787.751ms다.
최초 진입 및 최초 input focus는 60회 모두 통과했다. 준비 상태 확인과 실제 Tab
진입이 원래 검사의 진입 절차 부족을 보완한다는 근거지만, 숨겨진 버튼의
programmatic focus 실패와 뒤늦은 0ms 초기 focus 덮어쓰기 중 어떤 경합인지
이 비교만으로 구분하지는 못했다.

Windows의 3회 실패는 모두 입력·전체 삭제 및 앞선 Tab 왕복을 통과한 뒤 마지막
Tab의 input focus assertion에서 발생했다(원래 코드 106행, 진단 코드 125행).
실패 후 `activeElement.id`는 `btn-yt-cancel`, YouTube overlay의 `display`는
`flex`였다. 원래 A의 진입 전 실패와 달리 YouTube 입력창이 열린 상태에서 생긴
후반 실패다. B 전체 결과는 57 pass / 3 fail이며 workflow도 failure로 완료됐다.

후반 실패의 강한 후보는 초기 modal focus(`src/ui/dom.ts:513`)와 별도로 동작하는
100ms 뒤 무조건 input focus(`src/ui/player-controls.ts:714`)다. 후자는 입력·Tab에서
취소되지 않고 close(835행)에서 취소된다. 실패 3건의 최초 input focus 검사 완료부터
마지막 Tab 명령 시작까지는 117ms·103ms·76ms였고, 마지막 건의 Tab 자체는 15ms였다.
`cycleFocusWithin`은 keydown 당시 activeElement로 다음 대상을 정하므로(dom.ts:27–36),
cancel 확인 뒤 타이머가 input으로 돌려놓고 마지막 Tab이 다시 cancel로 가는 흐름은
관측과 일치한다. 다만 step 시각은 검사·명령 시각이며 타이머 발화·focusin 로그가
없어 이 타이머를 세 실패의 원인으로 확정하지 않는다.

## 결론과 남은 확인

- A/B 두 진단 실행은 완료됐다. 초기 진입 실패는 Linux 전용이 아니며, 팝업 준비
  확인과 실제 Tab 진입을 넣은 B에서는 재현되지 않았다. 준비 확인과 이동 방식을
  함께 바꾸므로 특정 타이머 하나를 원인으로 확정하지 않는다.
- B Windows의 후반 Tab 실패 3회는 열린 문제로 남긴다. 초기 진입 절차 개선만으로
  전체 키보드 검사가 안정화됐다는 증거는 없고 제품 포커스 처리의 원인도 미확정이다.
- 이번 결과는 물리 키보드·실기기·전체 Full E2E를 대신하지 않는다. 제품이나 main
  테스트의 수정·추가 배포는 하지 않았다. 실제 수정 여부는 다음 사용자 결정으로
  남기며 [릴리스 기록 §2](../release-record.md#2-열린-확인-항목)의 관찰을 유지한다.

## 증거 위치

- 원본 실패: `scratch/focus-linux-audit/original/report.json`,
  `original/bbf6494bea821758acc3.json`의 HTML report steps,
  `original/playwright-report/data/f917f5466517d75ef9472580761529d1404ff548.md`.
- A Ubuntu: `scratch/focus-linux-audit/linux-repeat/focus-results.json`,
  `scratch/focus-linux-audit/linux-repeat-summary.json`,
  `linux-repeat/playwright-report/`의 실패 DOM·PNG.
- A Windows: `scratch/focus-linux-audit/windows-repeat/focus-results.json`,
  `scratch/focus-linux-audit/windows-repeat-summary.json`. A 전체 실행 로그는
  `scratch/focus-linux-audit/original-repeat.log`.
- B Ubuntu: `scratch/focus-linux-audit/linux-ready/focus-results.json`.
- B Windows: `scratch/focus-linux-audit/windows-ready/focus-results.json`,
  `scratch/focus-linux-audit/windows-ready-summary.json`. B 전체 실행 로그는
  `scratch/focus-linux-audit/ready-repeat.log`.
- 임시 workflow 사본: `scratch/focus-linux-audit/workflow-original.yml`,
  `scratch/focus-linux-audit/workflow-ready.yml`.
- A/B의 Actions 실행 링크는 위 표 앞에 명시했다. 두 실행 모두 실패를 포함한
  완료 결과로 보존하며 통과한 반복만 따로 전체 결과로 제시하지 않는다.
