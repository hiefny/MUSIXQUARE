# 에디토리얼 헤더 버튼과 리딤 코드 힌트 정렬 (2026-10-20)

- Status: 8.11.30 UI 수정과 검증 기록이다. 배포 결과의 정본은 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이다.
- 계기: 오너 요청(2026-10-20) 두 가지.
  - 에디토리얼 페이지 상단 오른쪽 버튼이 페이지에 따라 "Try it now"와 "Open app"으로 달랐다. 오너는 달라진 이유를
    추론하고, 맞춰도 괜찮으면 모두 "Try it now"로 통일하라고 했다. About 페이지의 다른 언어 번역은 제외했다.
  - 이벤트 페이지의 리딤 코드 입력칸에서 힌트(`MXQ-…`)가 상자 가운데보다 아래로 치우쳐 보였다. 힌트 값은 그대로
    둔다. 리딤 코드를 나눠 주므로 형식은 어차피 알려진다는 오너 판단이다.
- 커밋: `768eb167`(헤더 버튼), `1774b01a`(`AGENTS.md` 공개 저장소 규칙, 문서만), `20a6d8d2`(리딤 힌트), 릴리스
  식별자 `3563cf85`(8.11.30 / v739).

## 1. 에디토리얼 헤더 버튼

### 조사

- 헤더 버튼(`.lp-try`)이 있는 곳은 About(`.workshop/landing`, 영어 문구는 `landing-i18n.ts`의 `header.try`), Blog,
  History, Design System, App Worker가 그리는 Soro 글 페이지다. "Open app"(보조 기술 이름 "Open MUSIXQUARE")은
  History 한 곳이었고, 나머지는 모두 "Try it now"(보조 기술 이름 "Try MUSIXQUARE now")였다.
- 언제: 2026-08-23 21:18 KST 커밋 `0dad740a`("refresh editorial design and contrast")부터다. 이 커밋이 History
  페이지를 통째로 다시 쓰면서(736줄) 헤더 버튼이 "Try it now"에서 "Open app"으로 바뀌었다. 같은 커밋에서 다시 쓴
  Design System 페이지는 "Try it now"를 그대로 뒀다. 2026-09-01 `6c92e3ed`는 단위 테스트 픽스처에 같은 "Open app"
  마크업을 넣었을 뿐 페이지는 바꾸지 않았다.
- 왜: 커밋 메시지(본문 없음), 문서, 테스트 어디에도 이유가 없다. 페이지를 새로 짜는 과정에서 생긴 차이로 판단한다.
  "History는 이미 앱을 아는 사람이 보는 페이지"라는 의도였을 수는 있지만, 같은 탭 메뉴(About · Blog · History)를
  쓰는 페이지끼리 버튼만 다를 근거는 되지 않는다.

### 변경

- `public/history/index.html`의 헤더 버튼을 "Try it now", `aria-label="Try MUSIXQUARE now"`로 바꿨다. 링크 주소와
  스타일은 그대로다. History에는 `.lp-try` 전용 규칙이 없어 다른 페이지와 같은 `editorial-design.css` 규칙을 쓴다.
- 새 계약 테스트 `src/ui/__tests__/editorial-header-cta.test.ts`가 Blog·History·Design System 헤더, Soro 글 헤더,
  About 영어 사전의 버튼 문구와 보조 기술 이름을 고정한다. About의 다른 언어 번역은 검사하지 않는다.
- `classic-runtime-assets.test.ts`의 언어 링크 테스트 픽스처 문구도 "Try it now"로 맞췄다. 이 테스트는 링크 경로를
  확인하므로 검사 내용은 같다.

### 검증

- 새 계약 테스트는 수정 전 History 마크업에서 실패하고(History 1건) 수정 후 통과한다.
- 로컬 Vite 개발 서버에서 History와 Blog 헤더 버튼을 비교했다. 375×812에서 둘 다 "Try it now" 한 줄, 79×29px,
  오른쪽 여백 24px, 로고와의 간격 116px, 글자 11px·700으로 같다. 1024 폭의 History도 한 줄 79×29px이다. 개발
  서버에서는 에디토리얼 로딩 화면이 걷히지 않아 화면 캡처 대신 배치 값을 쟀다.

## 2. 리딤 코드 힌트 가운데 정렬

### 원인

입력한 코드는 `clamp(17px, 5.2vw, 21px)`·700으로, 힌트는 15px·600으로 그린다. Chromium은 placeholder를 입력
글자의 기준선에 맞춰 그리기 때문에 작은 힌트가 큰 글자의 기준선에 앉아 상자 가운데보다 아래로 내려간다. 입력 글자가
클수록, 즉 화면이 넓을수록 더 내려간다. WebKit은 placeholder를 따로 가운데에 두어 이 차이가 없었다.

### 변경

- `public/events/event.css`에 `.redeem-input:placeholder-shown`을 더해, 비어 있는 입력칸의 글자 크기·굵기·자간을
  힌트와 같게(15px·600·0.02em) 했다. 코드를 입력하면 지금처럼 17~21px·700으로 돌아간다. 힌트 문구와 색, 입력칸
  높이(58px)는 그대로다. 비어 있을 때 깜빡이는 입력 커서는 15px 글자에 맞춰 조금 짧아진다.
- 새 계약 테스트 `src/ui/__tests__/event-redeem-input.test.ts`가 비어 있는 입력칸의 글자 크기·굵기·자간이 힌트와
  같은지 확인한다. 수정 전 CSS에서는 실패하고 수정 후 통과한다.

### 검증

빌드한 앱(`npm run build`)의 이벤트 페이지를 Playwright Chromium·WebKit으로 열고(이벤트 스크립트와 API 요청은
막고 리딤 단계만 표시), 어두운 테마·1배율로 입력칸을 캡처해 글자 픽셀이 상자 세로 가운데에서 얼마나 벗어났는지
쟀다. 양수는 아래쪽이다. 캡처가 1배율이라 ±0.5px는 반올림 범위다.

| 화면 폭 | Chromium 힌트 전 → 후 | WebKit 힌트 전 → 후 | 입력한 코드(두 엔진, 전후 같음) |
| --- | --- | --- | --- |
| 360, 390 | +1.5 → −0.5 | −0.5 → −0.5 | 0 ~ +0.5 |
| 430, 768, 1280 | +2.5 → −0.5 | −0.5 → −0.5 | +1 |

입력칸 크기는 모든 폭에서 전후가 같다(높이 58px).

## 로컬 검사

- 로컬 Windows, Node 24.20.0, 릴리스 식별자 커밋 `3563cf85`: `npm run typecheck`·린트·포맷·committed
  `build:checked`(release identity 8.11.30 / v739, sw-cache-version 통과) 통과, unit 600 files / 13,477 pass / 0 fail /
  0 skip(새 계약 테스트 파일 2개), 소스 가드 bus-pairing·dead-exports·import-graph·chunk-pump·lifecycle-writes 통과.
  로컬 결과는 exact-main CI 후보를 대신하지 않는다.

## 한계

- About 다른 언어의 헤더 문구는 범위 밖이다.
- 실기 휴대폰(Android Chrome, iPhone Safari)은 확인하지 않았다. 리딤 힌트 측정은 Playwright 엔진 기준이며, 다른
  Chromium 계열 브라우저도 같은 방식으로 그린다고 보고 있다.
- 운영 페이지 확인은 배포 뒤에 한다.
