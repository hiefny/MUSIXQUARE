# YouTube 입력 안내 통일 — 2026-10-13

## 변경 범위

- 기준 main: `4854e392ce8cc020114ae20864ed047c0959ebac`.
- 수정 코드: `694fea1d0100239be4a9e8a15c91eb9c1b282e63`.
- 최종 PR head: `c9f3a45089c95aa94d17e76cfa882ee781de62e7`, PR
  [#316](https://github.com/hiefny/MUSIXQUARE/pull/316).
- 배포·exact-main 검증 SHA: `6b15966714a2aca1a66d7e6315815ccd7049303f`.
- 오너가 모든 언어의 내부 힌트를 URL 예시로 바꾸고 아래 안내를 링크·검색어로
  통일하며, 입력을 지운 뒤에도 같은 안내를 표시하고 배포하도록 승인했다.
- App `8.10.7` / SW cache `v668`, 배포 대상 `app`, Developer API D1 application
  `false`. 새 의존성·스키마·비밀·바인딩·프로토콜·복구 floor 변경 없음.

## 원인과 수정

1. 42개 locale의 내부 힌트를 `https://youtube.com/…`로 통일했다. 기존 화면 아래
   안내는 링크와 검색어 순서로 정리했다. 대부분 기존 toast 번역을 재사용하고,
   이탈리아어·폴란드어·러시아어는 prompt의 순서만 정리했다.
2. 입력을 지운 `fetchYouTubePreview`의 empty 분기가 링크만 안내하던 키 대신,
   최초 열기·초기화·취소와 같은 `youtube.enter_link_prompt`를 쓴다.
3. 접근성 이름은 계속 링크와 검색을 모두 설명한다. `aria-describedby`, polite
   live region, 검색 중·오류·결과 선택 상태, contenteditable/RTL 처리와 검색 동작은
   유지한다. HTML 기본 영어 문구도 번역 키의 의미와 맞춘다.
4. 기존 단위·브라우저 검사에 입력 → 전체 삭제 → 최초 안내 복원을 포함했다.
   브라우저 검사는 복원 후 키보드 Tab 순환도 계속 확인한다.

## 검증

- 타입·전체 lint·format·Worker 문법/Developer API/D1/ops source guard 통과.
- Chromium YouTube search interactions: 8 pass / 0 fail / 0 skip (최초 코드
  `1b875a92`, 이후 변경은 bootstrap cache URL 정렬뿐). 기존 키보드 순환,
  검색 로딩·빠른 추가·실패 복구에 URL 힌트와 입력 삭제 복원을 함께 확인했다.
- 42개 locale 소스와 빌드된 42개 언어 HTML의 URL 힌트 일치 확인.
- 최초 로컬 단위 실행은 다른 검사와 무제한 병렬로 겹쳐 553파일만 실행,
  12,185 pass / 25 fail / 5 worker-start errors였다. 시간초과 다수와 Miniflare 내부
  Fetch bad-port가 포함됐다. 이 결과를 통과로 간주하지 않는다.
- 첫 실행에서 발견한 실제 준비 누락은 index.html의 bootstrap cache URL(v667)이었다.
  canonical cache(v668)와 맞춰 수정했다. 최초 build:checked도 그 이전 HTML을 읽어
  app-shell 검사에서 실패했으므로 최종 커밋의 새 빌드를 별도로 요구한다.
- 최종 코드 `694fea1d`, `npm test -- --maxWorkers=4`: 558파일 모두 실행,
  12,575 pass / 1 fail / 0 skip. 남은 실패는 release-deployment-state의 localized
  build input 반복검사 30초 제한 초과(41.097초)였다. 그 파일을 단독으로
  `--maxWorkers=1` 재실행해 101 pass / 0 fail / 0 skip을 확인했다. 시간 제한과
  assertion은 바꾸지 않았다. 전체 실행 자체가 0 fail이었다고 주장하지 않는다.
- 최초 실행의 PRO presence churn(45.934초) 실패는 heartbeat 없는 실시간 fixture가
  presence TTL(45초)을 넘는 경로와 부합한다. 응답 body가 없어 당시 409의 세부
  코드는 확정하지 못했다. Miniflare bad-port는 내부 Fetch의 제품 핸들러 이전
  오류다. 이 PC 동적 TCP 1024–15000 범위에 Fetch 금지 포트가 포함되지만 당시
  포트 번호는 로그에 없다. 두 항목 및 worker 시작 실패는 4-worker 전체 재실행에서
  재현되지 않았다. OS 설정이나 제품 입장 정책은 바꾸지 않았다.
- 최종 PR CI [38335861259](https://github.com/hiefny/MUSIXQUARE/actions/runs/38335861259)
  (head `c9f3a450`)와 exact-main CI
  [38336374232](https://github.com/hiefny/MUSIXQUARE/actions/runs/38336374232)
  (`6b159667`)는 각각 11 job 성공. 각각 558파일 / 12,575 pass / 0 fail / 1 skip
  (Windows 전용 경로, 로컬 통과), 후보 browser 17 + critical 24 pass, coverage
  4종 통과. Production Release는 exact-main 성공 후보를 재사용했다.
- 로컬 committed build:checked (`02cf7e15`, runtime `694fea1d`) 통과. app-shell
  94 assets 검증, bootstrap cache URL v668 일치.

로컬 실행은 Windows,
Node `24.13.1` / npm `11.8.0`이며 CI의 고정 Node `24.20.0`과 다르다.

독립 읽기 전용 리뷰에서 추가 수정 권고는 없었다. 전체 42 locale 키와 diff를
검사했다. 실기기 음향·YouTube 외부 서비스·현재 코드 전체 serial E2E 실행을 이
문구 수정의 검증으로 주장하지 않는다. 로컬 결과는 exact-main CI 후보를 대체하지 않는다.

## 기존 Full E2E의 미확정 관찰

- 변경 전 main `4854e392`의 Full E2E
  [38328670967](https://github.com/hiefny/MUSIXQUARE/actions/runs/38328670967)는
  2026-10-13 10:46:21 KST 완료됐으며 serial 626 pass / 1 fail이었다.
  `e2e/youtube-search-interactions.test.ts:80`의 최초 input focus 확인에서 실패해
  입력·삭제 조작까지 도달하지 않았다. WebKit·large R2 job은 성공했지만 이 문서에서
  smoke 범위 산출물을 상세 검증하지 않았다. 전체 Full E2E가 통과한 것은 아니다.
- source popup의 비동기 View Transition 및 0ms 최초 action focus와 검사의 즉시
  programmatic focus/Enter 사이의 경쟁을 의심한다. 확정 원인이나 수정은 아니다.
- 현재 `6b159667`에서 동일 키보드 검사(입력 삭제 뒤 안내 복원·Tab 순환 포함)를
  로컬 Chromium으로 5회 반복해 5 pass / 0 fail을 확인했다. 간헐 실패 해결이나
  현재 코드의 전체 Full E2E 성공을 증명하지 않으므로 릴리스 기록 §2에 남긴다.
- 로컬 근거: `scratch/youtube-copy-prior-full-e2e-failure.log`,
  `scratch/youtube-copy-focus-recheck.log`.

## 배포와 복구

- [Release 38336912131](https://github.com/hiefny/MUSIXQUARE/actions/runs/38336912131)
  attempt 1은 2026-10-13 11:29:05 KST 성공했다. `target=app`, Developer API D1
  `false`, App `8.10.7` / `v668`, source `6b159667`이다.
- App version `434ad128-8f40-44cb-a1f7-8325eb16796b`, deployment
  `6a182693-ba52-4e85-a22c-5f5cd65e2a77`이 100% 제공된다. 11:28:59.960 KST
  최종 소유권을 확인하고 11:29:00 KST coherent production marker를 영속화했다.
  미선택 Worker 5종은 `08df0606`을 유지하며 부분 배포 호환성을 재검증했다.
- 선택된 운영 smoke 4종(App generation, 익명 계정 경계, PRO 공개 경로,
  Standard HTTPS signaling) 성공, 범위 밖 6종 skip. 기존 App/admin/auth
  기준선은 멱등 적용·검증했으며 새 스키마·의존성·비밀·바인딩·프로토콜·floor는 없다.
- 공개 en·ko·ar·it·pl·ru 응답은 모두 HTTP 200으로 URL 힌트·올바른 아래 안내와
  v668을 확인했다. SW HTTP 200/v668, 공개 공지 HTTP 200
  `enabled:false, revision:8`도 확인했다. 점검 모드나 운영 공지 상태는 변경하지 않았다.
- 배포 후 Operations Drift Audit
  [38337144261](https://github.com/hiefny/MUSIXQUARE/actions/runs/38337144261)는
  11:30:30 KST 성공(source `6b159667`). 11:30:09.445 KST report.json의 checks는
  31 pass / 0 fail / 5 manual-only이며 수동 5항목을 통과로 간주하지 않는다.
- 복구는 사용하지 않았고 실패 복구 job은 skip됐다. 불변 checkpoint는 변경 전
  App `f0ea308b`, version `2b4d2b20-bf09-46b3-a60a-8aafb4765da8`, deployment
  `d0754fbd-b17d-4658-9f3c-83612374aee3`을 보존한다. 배포 전 checkpoint와 최종
  `app-before.json`의 SHA-256은 모두
  `80d52e5fdc00008a779f074768598079d7d0f9d89e3777277b453ff54b52b554`다.
  이 기준선으로 복구하면 중복·역순 힌트와 빈 입력의 링크 전용 안내가 돌아온다.
  checkpoint는 사용자 데이터 백업이 아니며 저장 데이터·서버 계약 변경이나 down
  migration은 없다.
- 로컬 증거: `scratch/youtube-copy-release-artifacts/`의 최종 소유권·부분 배포
  호환성·App 상태·checkpoint, `scratch/youtube-copy-drift/report.json`,
  `scratch/youtube-copy-public-verification.json`. 위 Actions 실행에 배포·감사
  산출물이 보존된다. 후속 문서 기록만으로 추가 App 릴리스를 하지 않는다.
