# YouTube 입력 안내 통일 — 2026-10-13

## 변경 범위

- 기준 main: `4854e392ce8cc020114ae20864ed047c0959ebac`.
- 수정 코드: `694fea1d0100239be4a9e8a15c91eb9c1b282e63`.
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
- PR CI [38334816076](https://github.com/hiefny/MUSIXQUARE/actions/runs/38334816076),
  head `02cf7e15`: 11 job 성공. 558파일 / 12,575 pass / 0 fail / 1 skip(Windows
  전용 경로, 로컬 통과), 후보 browser 17 + critical 24 pass, coverage 4종 통과.
  이 실행은 exact-main 후보가 아니다.
- 최종 committed build:checked (`02cf7e15`, runtime `694fea1d`) 통과. app-shell
  94 assets 검증, bootstrap cache URL v668 일치.

로컬 실행은 Windows,
Node `24.13.1` / npm `11.8.0`이며 CI의 고정 Node `24.20.0`과 다르다.

독립 읽기 전용 리뷰에서 추가 수정 권고는 없었다. 전체 42 locale 키와 diff를
검사했다. 실기기 음향·YouTube 외부 서비스·전체 serial E2E 실행을 이 문구 수정의
검증으로 주장하지 않는다. 로컬 결과는 exact-main CI 후보를 대체하지 않는다.

## 배포와 복구

배포 전이다. 정상 PR 및 exact-main 성공 후보를 확보한 뒤 Production Release를
실행한다. 기존 호환 App 기준선으로 복구하면 중복·역순 힌트와 빈 입력의 링크 전용
안내가 돌아온다. 저장 데이터나 서버 계약은 바뀌지 않으며 down migration은 없다.
