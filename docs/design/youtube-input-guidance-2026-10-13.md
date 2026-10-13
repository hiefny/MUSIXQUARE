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
- Chromium YouTube search interactions: 8 pass / 0 fail / 0 skip. 기존 키보드 순환,
  검색 로딩·빠른 추가·실패 복구에 URL 힌트와 입력 삭제 복원을 함께 확인했다.
- 42개 locale 소스와 빌드된 42개 언어 HTML의 URL 힌트 일치 확인.
- 최초 로컬 단위 실행은 다른 검사와 무제한 병렬로 겹쳐 553파일만 실행,
  12,185 pass / 25 fail / 5 worker-start errors였다. 시간초과 다수와 Miniflare 내부
  Fetch bad-port가 포함됐다. 이 결과를 통과로 간주하지 않는다.
- 첫 실행에서 발견한 실제 준비 누락은 index.html의 bootstrap cache URL(v667)이었다.
  canonical cache(v668)와 맞춰 수정했다. 최초 build:checked도 그 이전 HTML을 읽어
  app-shell 검사에서 실패했으므로 최종 커밋의 새 빌드를 별도로 요구한다.
- 동시 worker 수를 4개로 제한한 전체 단위 검증과 최종 빌드 결과는 진행 중이다.

로컬 실행은 Windows,
Node `24.13.1` / npm `11.8.0`이며 CI의 고정 Node `24.20.0`과 다르다.

독립 읽기 전용 리뷰에서 추가 수정 권고는 없었다. 전체 42 locale 키와 diff를
검사했다. 실기기 음향·YouTube 외부 서비스·전체 serial E2E 실행을 이 문구 수정의
검증으로 주장하지 않는다. 로컬 결과는 exact-main CI 후보를 대체하지 않는다.

## 배포와 복구

배포 전이다. 정상 PR 및 exact-main 성공 후보를 확보한 뒤 Production Release를
실행한다. 기존 호환 App 기준선으로 복구하면 중복·역순 힌트와 빈 입력의 링크 전용
안내가 돌아온다. 저장 데이터나 서버 계약은 바뀌지 않으며 down migration은 없다.
