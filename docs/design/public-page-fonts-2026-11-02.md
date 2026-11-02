# 모든 공개 페이지를 앱 글꼴 체계로, 디자인 시스템 Typography 절 (2026-11-02)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 준비됨, 배포 전. 갈래 `agent/public-page-fonts`(main `cd8eaf47` 위, push 안 함)의 증분 I1 ~ I9와 이 문서 커밋이다(§4). 버전 올리기(I12), PR, 머지, 릴리스는 릴리스 담당의 몫이다(§11). 로컬과 브랜치 결과는 exact-main-SHA 후보를 대신하지 않는다                                                                                                                                                                                       |
| Base               | main `cd8eaf47`(#563, App 9.0.34 / v807 머지, 2026-11-02 21:20 KST 배포). 그 뒤 main에 9.0.34의 배포 기록 `432d4ae7`(#564, 문서만)이 들어왔고, 이 갈래는 아직 그 위로 옮기지 않았다(§11). 그래서 바탕의 App 런타임은 운영 9.0.34와 같다                                                                                                                                                                                                 |
| Version            | 9.0.35 / v808 예정(App 빌드 808). 버전 올리기가 마지막 런타임 커밋이 되고, 그 앞은 9.0.34 / v807 그대로라 `guard:sw-cache-version`만 실패한다(§8). 앞으로 되돌리기는 9.0.36 / v809다(§10)                                                                                                                                                                                                                                               |
| Scope              | 앱 밖의 모든 공개 페이지(소개와 42개 사본, 개인정보·약관·FAQ·개발자·번역·사이트맵, 블로그 목록, App Worker가 그리는 블로그 글과 관리자 페이지, 히스토리, 디자인 시스템과 미리보기 21개·UI 키트, 이벤트, 404)의 글꼴, 디자인 시스템 Typography 절, 은퇴한 글꼴 파일, 가드·시험·문서. 앱 쪽 변경은 로그인 완료 창(`public/account-complete.css`)의 글꼴 하나다(§2.4). 앱 소스 그래프는 그대로다(§5)                                       |
| Deploy target      | `app`(업데이트 창이 뜨는 배포). 운영 9.0.34(`cd8eaf47`)와 견준 런타임 경로 변경은 버전 올리기 앞 App 85, 나머지 다섯 Worker 0, App 런타임 의존성 차이 없음(로컬 `changedRuntimePaths`와 `changedAppRuntimeDependencies`, §8). D1, 비밀, 바인딩, Wrangler 설정, CORS, 계약 표지, 바닥, 저장 데이터와 키, 신호와 중계 프레임 모양은 바뀌지 않았다                                                                                         |
| Operations         | 운영에 닿지 않았다. GitHub 쓰기, push, 운영 요청, 방 만들기, 내려받기 없이 로컬(Windows 11)에서만 만들고 시험했다. 로컬 서버는 포트 5491·5492만 썼고 모두 닫았다                                                                                                                                                                                                                                                                        |
| Resource ownership | 복구, 재시도, 시한, 감시, 수명 흐름을 더하지 않았다. 공개 페이지는 `<link>`로만 글꼴 시트를 받고, `/han-order.js`는 문서 뿌리에 속성 하나를 한 번 적는다. 등록부가 적지 않았던 글꼴 시트의 두 번째 기계 둘(소개의 `ensureFont`·`ensurePickerFonts`, 사이트맵의 `static-page-fonts.ts`와 그 재시도 시트)을 지워 `retryable-stylesheet.ts`의 가져오는 쪽은 앱 글꼴 주인 하나다. 등록부와 `check-resource-ownership.mts` 기준치는 그대로다 |
| Third-party assets | 새 내려받기 없음. 공개 페이지는 앱이 이미 쓰는 Inter, MUSIXQUARE Hangul, Noto 파일을 그대로 쓴다. 지운 것: 배포되던 Pretendard 사본, Pretendard 시트 둘, Google의 Noto Sans Cyrillic·Greek 시트와 파일 셋, 생성기 입력 시트의 번호 없는 면 14개(§2.6). `fonts/PretendardVariable.woff2`(MUSIXQUARE Hangul의 원본), 공유 그림의 Bold 파일과 그 부분 집합, 라이선스 파일은 그대로다                                                       |
| Release record     | 이 문서 커밋이 §2의 공개 페이지 글꼴 열차를 기다리던 항목을 고쳤다(9.0.29 절의 뒤 열차 항목, 9.0.33 절의 오너 질문 3과 '사본만' 문장, 9.0.31 절과 9.0.29 절의 JP·SC·TC 수용 문장). 어느 것도 닫지 않았다(닫는 근거는 이 열차의 배포 기록). §1과 이 열차의 배포 전 절은 릴리스 담당이 더한다                                                                                                                                             |

9.0.29부터 앱은 Inter와 Noto로, 9.0.33부터 한글은 MUSIXQUARE Hangul(저장소의 Pretendard에서 자른 면)로 그린다. 앱 밖의 공개
페이지는 지금까지 Pretendard 전체 파일(2,057,688 B)과 Google의 원래 Noto 시트를 따로 받았다. 이 열차는 공개 페이지를 앱과 같은
면, 같은 스택, 같은 파일로 옮기고, 그동안 공개 페이지만 쓰던 파일을 지우며, 디자인 시스템 페이지에 Typography 절을 더한다.

## 1. 오너 결정 (2026-11-02 저녁)

- 모든 공개 페이지에 앱의 글꼴 체계를 쓴다.
- 공개 페이지는 부차적이라 오너의 사진 확인이 필요 없다. 확인할 것은 앱뿐이고, 앱은 바뀌지 않아야 한다.
- 따로, 디자인 시스템의 Typography 절을 넣는다(시안의 'Music 음악 音楽 おんがく'와 '야간 드라이브' 견본 포함).

이 결정은 9.0.33 보고서 §9의 질문 3(공개 페이지 글꼴 열차의 방향)에 대한 답이다. 질문 1과 2는 답이 없어 기본값 그대로다.

## 2. 무엇을 바꿨나

### 2.1 전달: `/web-fonts/`

| URL                     | 만드는 곳                                                                                                                                  | 크기(raw / gzip -9 / brotli 11) |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `/web-fonts/first.css`  | 앱의 처리된 시트 `font-inter`, `font-hangul`, `font-noto-kr`를 빌드가 이어 붙임(`scripts/public-font-sheets.mts`, `vite.config.ts`에 등록) | 92,904 / 24,554 / 14,533 B      |
| `/web-fonts/rest.css`   | 나머지 14개 앱 시트를 `APP_FONT_SHEETS` 순서로 이어 붙임                                                                                   | 306,865 / 91,140 / 50,583 B     |
| `/web-fonts/stacks.css` | `public/web-fonts/stacks.css`(앱 스택의 거울, 한자 순서 규칙 포함)                                                                         | 4,281 / 1,138 / 1,026 B         |
| `/han-order.js`         | `browser/classic-runtime/han-order.ts`(브라우저 언어로 앱의 한자 순서를 문서 뿌리에 적음)                                                  | 477 / 292 / 220 B               |

- 공개 페이지는 앱과 같은 `/assets/*.woff2`를 받는다. 기술자(`size-adjust`, 줄 상자 덮어쓰기), 구운 줄 상자(9.0.31), 한글 면
  (9.0.33), `unicode-range`가 앱과 같고 HTTP 캐시도 함께 쓴다. 앞으로 앱 글꼴이 바뀌면 공개 페이지는 고치지 않아도 따라간다.
- 묶음은 `src/i18n/public-font-contract.ts`가 정한다(앱은 이 모듈을 가져오지 않음). `first`가 앱의 단계 A(한국어와 영어 UI)와 같다는
  것은 앱 로더를 직접 돌리는 시험(`public-font-contract.test.ts`)이 붙잡는다. URL은 가져오는 것이 없는 잎 모듈
  `src/i18n/public-font-urls.ts`이고 App Worker와 가드가 읽는다.
- 이름이 해시 없는 고정 별칭이라, `public/` HTML과 Worker가 그리는 페이지도 걸 수 있다. Worker는 `/web-fonts/`를 공개 페이지 캐시
  정책(`max-age=300`, `s-maxage=86400`, `stale-while-revalidate=604800`, `nosniff`)으로 보낸다. 서비스 워커는 바꾸지 않았고 글꼴
  시트를 설치하지 않는다.

### 2.2 페이지마다 거는 방법

- 머리에 `/han-order.js`(막는 classic 스크립트, `first.css` 앞), `first.css`, `stacks.css`를 페이지 자신의 시트보다 먼저 건다.
  `rest.css`는 마지막 본문 스크립트 뒤에 건다. 자기 글자가 `rest`에 있는 소개 사본 17개(ja, zh-hans, zh-hant, th, ar, fa, ur, he,
  인도 글자 9개)는 `rest.css`를 머리에 건다(`restFontSheetInHead`, `SCRIPT_FONT_SHEET_BY_LANGUAGE`에서 유도).
- 이벤트 페이지(PRO 로그인)는 `first.css`와 `stacks.css`만 걸고 `rest.css`는 걸지 않는다(A7: 미룬 스크립트와 모듈 스크립트는 파서가 그
  앞에 더한 시트를 기다림). 그래서 그 페이지의 Thai, 아랍 문자 등은 기기 글꼴로 그린다.
- 페이지 CSS는 면을 선언하지 않고 스택 속성을 정하지 않는다. 글자는 `var(--font-sans, …시스템 글꼴)`을 읽고, 언어 고르기 이름과
  사이트맵 이름은 앱의 고르기가 그 언어에 주는 스택을 읽는다. 글꼴 이름을 직접 쓰는 곳은 코드의 기기 고정폭과 Google 로그인 단추
  (`'Google Sans', Arial, var(--font-sans, system)`) 뿐이다. 양식 요소는 `font-family: inherit`을 받는다.
- 한국어와 영어 페이지를 가르는 규칙은 번역된 문구의 크기, 줄 높이, `keep-all`에만 있고(`PUBLIC_KOREAN_ENGLISH_COPY_RULES`에 이유와
  함께 기록) 자간은 가르지 않는다(A11, 9.0.29부터 앱이 한국어와 영어를 같게 그림). 그래서 소개의 한국어 제목 자간 −0.025em을 뺐다.
- 소개의 닫힌 언어 메뉴는 `display: none`이고 열릴 때 `display: grid`로 `@starting-style` 페이드를 한다(Q7). 닫힌 메뉴는 이름의
  면을 받지 않는다(§7).
- App Worker가 그리는 관리자 페이지와 블로그 글(빌드된 블로그 페이지가 없을 때의 대체)도 같은 URL을 같은 순서로 건다. 점검 중
  우회는 세 시트와 `/han-order.js`를 들인다. 점검 페이지 자체는 기기 글꼴 그대로다(D3, 모든 Worker가 싣는 모듈).

### 2.3 한자 순서 (A11)

공개 페이지도 앱처럼 한자 순서를 정한다: 페이지 언어가 ja·zh면 그 언어(`stacks.css`의 `html:lang()` 규칙), 아니면 브라우저 언어의
첫 CJK 언어, 없으면 한국어다. 앱 코드는 바꾸지 않았다. `resolveHanOrder`(`src/i18n/startup-han-order.ts`)의 사본을 classic 스크립트
`/han-order.js`로 따로 컴파일했고(앱 모듈을 공개 진입점에서 가져오면 번들러가 그 모듈을 앱의 `locale-fonts` 조각과 나눠 앱 바이트가
바뀜), `public-han-order.test.ts`가 그 사본을 원본과 30개 언어 목록과 `navigator.language` 대체로 붙잡는다. 스크립트가 없던 404도
이 스크립트 하나를 싣는다(예외로 두지 않음). 계획은 공개 페이지를 한국어 먼저로 두고 스크립트를 두지 않았지만 A11이 그것을 바꿨다.

### 2.4 앱 쪽 변경: 로그인 완료 창 (A1)

`public/account-complete.html`과 `account-complete.css`는 공개 페이지가 아니라 앱이다(`src/ui/account.ts`의
`ACCOUNT_COMPLETION_PATH`, 서비스 워커의 `APP_SHELL`, 레거시 TV 가드, 그 미룬 스크립트가 앱에 로그인이 끝났다고 알림). 그래서
공유 시트를 걸지 않고, CSS에서 Pretendard `@font-face`와 이름만 빼고 시스템 스택
`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`을 쓴다. 이 열차의 하나뿐인 앱 쪽 변경이다.

[화면 바뀜] 로그인 완료 창의 글자(완료 문장과 닫기 단추)가 Pretendard에서 기기 글꼴로 바뀐다. 그 창은 한 번에
2,057,688 B의 Pretendard 파일을 받았는데 이제 글꼴 파일을 받지 않는다.

- 전후 그림: 저장소 밖의 로컬 증거 폴더(`public-page-fonts-logs/account-complete/`)에 만들어 두었고 커밋하지 않았다. 바탕
  `cd8eaf47`과 I6 뒤 `a4de85d4`의 운영 빌드를 Playwright Chromium(Windows 11, 어두운 테마, 배율 2, 서비스 워커 막음)으로 열었다.
  경우: 데스크톱 로그인 팝업 520 × 720(`src/ui/account.ts`가 여는 크기)의 en, ko, ja와 휴대폰 같은 탭 390 × 844의 ko, en.
- 그린 면(이 Windows 기기): en은 Pretendard Variable에서 Segoe UI(문장은 Semibold)로, ko는 Malgun Gothic(마침표와 빈칸은 Segoe UI)로,
  ja는 Yu Gothic으로. Apple 기기에서는 San Francisco와 Apple SD Gothic Neo가 그린다.
- 카드, 줄바꿈 자리(영어 문장은 둘 다 'this' 뒤에서 꺾임), 단추는 같다. 어느 경우에도 콘솔 오류가 없다.
- 그 뒤 `account-complete.css`가 Pretendard 파일을 가리키지 않으므로 앱 파일 집합에서 그 파일이 빠졌다(§5).

### 2.5 디자인 시스템 Typography 절 (I8)

오너가 따로 요청한 절을 시안에서 가져와 실제 전달(`/web-fonts/`)에 묶었다. 시안의 `/css/fonts/` 링크 10개와 `src_ref/pretendard.css`
링크, 13개 토큰의 스택 사본, 견본의 `font-family` 규칙, `var(--font-ui)` 둘을 빼고, 감지된 언어 표지 규칙 셋(`.user-text-font-ja`,
`-zh-hans`, `-zh-hant`)만 남겼다. 절이 찍는 숫자(1950 / 494 / 2048, 97.2%, 94%, 87개 부분 집합, 7개 Inter 부분 집합, Noto Sans KR에
남는 한글 98자, 1,270개 빈칸, 인도 글자 8개, 줄 높이 15·17·18·34, 1.193 em, 행간 34 / 23.7 / 18.75)는 각각 집에서 읽는다
(`design-system-typography-numbers.test.ts`). 다듬기:

- 행간 머리선의 1x 위치는 고치기 전에 쟀다(Chromium과 WebKit, 1440과 390 px, 1/8 px 오프셋 여덟): 96 / 96 모두 글자 바로 아래 한
  줄의 또렷한 픽셀이라 CSS를 바꾸지 않았다(리뷰가 CSS만 보고 짐작한 1픽셀 어긋남은 재 보니 없었음). 실험 명세가 그것을 붙잡는다.
- 720 px 이하에서 견본 왼쪽 가장자리를 하나로: 계획은 Faces를 80 + 20 px로 옮기라 했지만 가장 넓은 면 글자 'ก ع א क'가 28 px에서
  91.3 px라 80에 들지 않아, Scale만 쓰는 `.spec`을 Faces의 96 + 16 px로 옮겼다.
- Scale 아래 간격을 블록 안 간격 `clamp(56px, 7vw, 96px)`로 줄였다. 죽은 규칙 `.display-glyph`와 바탕 `.weight-row .gl`을 지웠다.
- 견본 무게(약 1.29 MB, 계획 §3.3 7)는 받아들였고 이 열차에서 다시 재지 않았다.

### 2.6 은퇴 (I9)

지운 것(저장소 2,376,654 B):

- 배포되던 사본 `public/designsystem/fonts/PretendardVariable.woff2`(2,057,688 B), `css/pretendard.css`,
  `public/designsystem/src_ref/pretendard.css`(그 폴더의 마지막 파일).
- Google의 Noto Sans Cyrillic·Greek 시트(`css/fonts/noto-cyrillic.css`, `noto-greek.css`)와 파일 셋. Inter가 두 문자를 어디서나 그린다.
- 생성기 입력으로 남는 Google의 JP·SC·TC·Thai 시트가 적는 번호 없는 면 14개(라틴, 라틴 확장, 키릴, 베트남어, Thai의 라틴 둘).
  생성기는 번호 붙은 CJK 조각과 Thai 면만 읽는다.
- I4 ~ I5에서 이미 지운 것: 소개의 글꼴 로더(`ensureFont`, `ensurePickerFonts`), `vite.config.ts`의 About 묶기 플러그인,
  `src/i18n/static-page-fonts.ts`와 `locale-font-contract.ts`.

남긴 것: `fonts/PretendardVariable.woff2`(MUSIXQUARE Hangul 87면의 기록된 원본이자 `guard:font-assets`의 범위 기준, 배포 안 함, D6),
`fonts/Pretendard-Bold.ttf`와 그 부분 집합 `public/fonts/og-pretendard-bold.ttf`(공유 그림은 오프라인에서 만듦, D5), 라이선스 파일,
`cloudflare/service-maintenance.ts`의 글꼴 이름(D3).

`scripts/lib/font-retirement.mts`가 이것을 기록하고, 가드는 글꼴을 싣거나 이름 대는 곳만 본다(A3): `font-family`·`font`·글꼴 스택
값, `fontFamily` 속성, `@font-face`, `url()`, `<link>`, Pretendard 글꼴 파일이나 시트로 가는 경로. 그래서 Pretendard를 밝히는 보이는
글(Typography 절, README, SKILL, 라이선스 줄, 주석)은 남는다. 허용 목록은 둘이다: 점검 페이지 모듈과 지난 광고 렌더의 고정 기록
(`.workshop/promo/manifest.json`).

### 2.7 가드와 시험

- `guard:font-assets`: `stacks.css`가 모든 UI 언어와 한자 순서에서 앱처럼 `--font-sans`를 풀고 면을 선언하지 않음, 등록된 모든 공개
  페이지(`PUBLIC_FONT_PAGES`)의 링크·인라인 스타일·시트, 각 페이지가 앱과 같은 `--font-sans`를 읽음, 한국어·영어 규칙 기록의 양방향
  일치, Worker 페이지의 시트(`PUBLIC_WORKER_FONT_PAGES`), 은퇴(§2.6).
- `guard:font-build`: `dist/web-fonts/`는 정확히 세 파일이고 `first`·`rest`는 빌드된 앱 시트를 정확히 이어 붙인 것이며 그 모든 파일이
  빌드에 있음, `stacks.css`는 원본과 같음, 앱 문서(42개)는 `/web-fonts/`를 걸지 않음, 소개 사본 42개와 등록된 모든 빌드 페이지의 링크,
  빌드에 은퇴한 것 없음(공유 그림 부분 집합 말고 Pretendard 파일 없음, 은퇴한 폴더 없음, 은퇴했거나 생성기 입력인 시트의 빌드 사본
  없음, Pretendard를 글꼴로 싣거나 이름 대는 빌드 글 없음). 지운 검사: 'About bound to the original sheets', 'Pretendard deployed
  once'와 원본 대 공개 사본 바이트 비교.
- `publicFontSheets` 플러그인은 시트가 없거나 겹치거나 풀리지 않을 때, 앱 진입의 첫 CSS 그래프에 있을 때, 앱 문서가 없을 때, 앱 문서가
  `/web-fonts/`를 걸 때 빌드를 실패시킨다.
- 단위 시험(새것): `public-font-sheets`, `public-font-contract`, `public-font-stacks`, `public-font-pages`, `public-han-order`,
  `font-retirement`, `design-system-typography-{stacks,numbers,layout}`. 바뀐 것: `account-complete`, `locale-font-assets`,
  `static-language-picker`, `legacy-tv-compatibility`(우선순위 정하는 플러그인이 `rest.css`를 본문 스크립트 뒤에 둠),
  `classic-runtime-assets`, `not-found-page-contract`, `ui-kit-asset`, `app-worker-cors`, `service-worker-cache`,
  `developer-api-docs`, `title-tracking-contract`, `max-font-weight`. 지운 것: `static-page-fonts.test.ts`.
- e2e: `font-identity`에 '앱은 `/web-fonts/`를 요청하지 않음'을 더함(회귀 지킴이), `about-page-layout`에 메뉴 클릭과 Enter 뒤 초점
  (en, ko). 새 실험 명세 `e2e/public-fonts/design-system-typography.lab.ts`는 따로 켜는 설정 `playwright.public-fonts.config.ts`에만
  있고 Full E2E에 들지 않는다(A5).

## 3. 결정

| #   | 질문 또는 결정                                                                                            | 결정                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 404를 기기 글꼴에서 공유 면으로                                                                           | 예. 404는 `/han-order.js` 하나와 세 시트를 싣는다                                                                                                       |
| Q2  | 사이트맵과 번역 페이지는 보이는 이름의 면을 모두 받음(약 1.4 ~ 1.6 MB)                                    | 받아들임, 늦게 받기 없음(전의 Pretendard 2.06 MB보다 적음)                                                                                              |
| Q3  | 소개의 한국어 제목 자간 −0.025em                                                                          | 뺌(A11). 계획의 '유지'를 바꿨다. 한국어의 크기, 줄 높이, `keep-all`만 남는다                                                                            |
| Q4  | `/designsystem/fonts/PretendardVariable.woff2`가 더는 풀리지 않음                                         | 받아들임, 디자인 시스템 README의 고정 URL 약속을 지움                                                                                                   |
| Q5  | 공개 페이지의 한자 순서                                                                                   | 앱의 방식(A11, §2.3). 계획의 '한국어 먼저, 스크립트 없음'을 바꿨다                                                                                      |
| Q6  | 보이는 변화(Inter 라틴, 큰 제목의 opsz, 줄 수, 404, 디자인 시스템 단추 Arial → Inter, Google 단추의 한글) | 사진 없이 받아들임(오너 2026-11-02)                                                                                                                     |
| Q7  | 닫힌 소개 언어 메뉴                                                                                       | `display: none` / `grid`, `transition-behavior: allow-discrete`, `@starting-style`(D7). 열린 상태는 `display` 없는 자기 전환을 지녀 초점이 바로 옮겨 감 |
| D1  | 앱 소스                                                                                                   | 그대로. 공개 묶음은 앱이 가져오지 않는 새 모듈에 있고 로더를 돌리는 시험이 붙잡는다                                                                     |
| D2  | 서비스 워커 `APP_SHELL`                                                                                   | 그대로. `stacks.css`를 설치하지 않는다(로그인 완료 창은 이제 시스템 글꼴이라 잃는 것 없음)                                                              |
| D3  | 점검 페이지                                                                                               | 그대로(모든 Worker 모듈, 이름만, 바꾸면 대상이 `all`)                                                                                                   |
| D4  | `public/screensaver.html`                                                                                 | 앱 화면이라 그대로                                                                                                                                      |
| D5  | 공유 그림, Bold TTF, 부분 집합, PNG                                                                       | 그대로                                                                                                                                                  |
| D6  | `fonts/PretendardVariable.woff2`                                                                          | 남김. 배포 사본과 그 바이트 비교만 지움                                                                                                                 |
| D7  | 닫힌 메뉴의 꼴                                                                                            | 위 Q7                                                                                                                                                   |
| D8  | `/web-fonts/*`                                                                                            | 공개 페이지 캐시 정책의 고정 별칭                                                                                                                       |
| D9  | 디자인 시스템 다듬기                                                                                      | §2.5대로(재고 나서 정한 둘이 계획과 다름)                                                                                                               |
| D10 | 새 e2e                                                                                                    | A5로 바뀜: 면·견본·측정 명세는 따로 켜는 설정에만, 기본 묶음에는 넣지 않음                                                                              |

검토가 더한 조건(A1 ~ A11)이 계획보다 앞선다. 위에 적지 않은 것: A2(디자인 토큰 시트의 글꼴 블록 삭제와 양식 요소 규칙은 I4에서,
블로그·히스토리·디자인 시스템·Worker 글은 I6·I7까지 갈래 안에서만 대체 글꼴, 페이지 묶음별 되돌리기 주장은 뺌), A4(§5의 증명 방식),
A6(내보내기는 scripts, src, e2e, browser, .workshop이 실제로 읽는 것만, 첫 독자의 증분에서), A9(이전 갈래의 조각은 커밋 단위
`git diff <부모> <커밋>`으로, 가드만인 시험은 회귀 지킴이로 반드시 실패 규칙에서 뺌), A10(`publicFontSheets`는 About 묶기 플러그인이
있던 동안 그 뒤에 등록, I4가 그 플러그인을 지움).

## 4. 증분과 커밋 (테스트 먼저)

모든 커밋은 `cd8eaf47` 위의 이 갈래에 있다. 'T'는 부모에서 실패해야 하는 시험 커밋이고, 부모에서도 통과하는 행은 회귀
지킴이(A9)로 적었다. 실패 기록은 로컬 증거 폴더의 `*-T-fail*.log`다.

| 증분                                                               | 커밋                       | 부모에서 실패한 것                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 공개 시트 빌드                                                  | T `a6976e91`, I `e042ed21` | 시험 두 파일이 계약 모듈이 없어 불러오기 실패. `font-identity`의 `/web-fonts/` 행은 회귀 지킴이                                                                                                       |
| I2 공개 스택                                                       | T `a9bf58d8`, I `d8d5d8eb` | 4행 중 2행(시트 선택지를 무시, `stacks.css` 없음)                                                                                                                                                     |
| I3 계약 라이브러리와 가드                                          | T `374cf8ad`, I `68e683a0` | 라이브러리 모듈 없음. 가드: 한자 순서 규칙 하나를 깨면 39개, 빌드를 건드리면(파일 더함, 시트 고침, 글꼴 URL 없앰, 앱 문서가 `first.css`를 검) 각각 실패                                               |
| I4 소개와 42개 사본                                                | T `7adb558a`, I `b388ac17` | 6개 파일 174행 중 96행                                                                                                                                                                                |
| I4 닫힌 메뉴(Q7)                                                   | T `028f1ab7`, I `f7cfd83a` | 메뉴 행(닫힌 메뉴가 `grid`). e2e 초점 행은 부모에서도 9 / 9 통과, 회귀 지킴이                                                                                                                         |
| I4 한자 순서(A11)                                                  | T `ad5eb247`, I `80b0673e` | 3개 파일 145행 중 21행                                                                                                                                                                                |
| I5 문서·번역·사이트맵                                              | T `00598611`, I `b4bab623` | 2개 파일 92행 중 17행                                                                                                                                                                                 |
| I6 블로그·히스토리·디자인 시스템·UI 키트·이벤트·404·로그인 완료 창 | T `6e956c15`, I `1b6b78dc` | 4개 파일 242행 중 59행, `ui-kit-asset` 4행 중 2행. 회귀 지킴이: 'covers every design-system preview', 'leaves the sign-in completion page to the app'                                                 |
| I7 App Worker 페이지와 관리자                                      | T `ca6c03e0`, I `a4de85d4` | `app-worker-cors` 286행 중 5행, `public-font-pages`는 수집 단계에서 실패. 회귀 지킴이: 'keeps fonts same-origin'과 `service-worker-cache` 전부                                                        |
| I8 Typography 절                                                   | T `b7096a71`, I `d32c0bb3` | 2개 파일 11행 중 10행. 회귀 지킴이 하나(스택 행)                                                                                                                                                      |
| I8 다듬기                                                          | T `20da1a3d`, I `55d8e49c` | 12행 중 4행(휴대폰 가장자리, Scale 간격, 죽은 규칙, 자간 목록). 데스크톱 가장자리 행은 회귀 지킴이                                                                                                    |
| I8 실험 명세                                                       | `4642d38a`                 | 따로 켜는 명세라 커밋에서는 실패 규칙이 없고, 실패 증거를 따로 남겼다: `rest.css`를 끊으면 네 폭 모두 실패, 시안 그대로는 852개 글자 모두 기기 글꼴로 실패, 다듬기 전 CSS는 390·360에서 가장자리 실패 |
| I9 은퇴                                                            | T `a9d5b84a`, I `4eecf4c0` | 라이브러리 없이 두 파일 불러오기 실패. 라이브러리를 두고 지우기 전에는 6행 중 3행(찾은 Pretendard 참조 16개, 은퇴 경로가 있음, 번호 없는 면이 있음). 가드는 고친 원본과 고친 빌드에서 각각 실패       |
| 문서                                                               | 이 커밋                    | 해당 없음                                                                                                                                                                                             |

이전 갈래의 조각은 그 갈래의 커밋 단위 diff에서 가져왔고 갈래 끝 파일을 통째로 가져오지 않았다(A9). 이 갈래는 push 전에 몇 번 다시
짰다(P1의 형 단언 하나와 시험 형 하나, I6 가드의 정규식과 I7 시험의 정리, I9 가드의 문구 하나). 그 앞의 SHA는 어디에도 없다.

## 5. 앱이 바뀌지 않았다는 증명

바탕 B는 `cd8eaf47`(운영 9.0.34)다. H′는 버전 올리기 앞의 마지막 커밋, 곧 이 문서 커밋이고 그 코드는 `4eecf4c0`과 같다(문서만
더함). 모든 빌드는 Node 24.22.2와 `npm ci`로, 같은 방식으로 만들었다.

1. **소스.** `git diff cd8eaf47 H′`에 앱 소스 그래프의 경로가 없다: `index.html`, `css/style.css`, `css/rtl.css`, `css/app.css`,
   `css/fonts/app/`, `fonts/app/`, `fonts/inter/`, `fonts/noto/noto-sans-kr/`, `fonts/*.json`, `src/app.ts`, `app-font-contract.ts`,
   `locale-fonts.ts`, `startup-han-order.ts`, `font-metrics.ts`, `retryable-stylesheet.ts`, `browser/service-worker.ts`,
   `public/screensaver.html`, 매니페스트, 부트스트랩. `src/`의 운영 파일 변경은 앱이 가져오지 않는 넷뿐이다(새 `public-font-contract.ts`와
   `public-font-urls.ts`, 지운 `static-page-fonts.ts`와 `locale-font-contract.ts`). 나눠 쓰는 코드는 `vite.config.ts`의 빌드
   플러그인(새 `publicFontSheets`, 지운 About 묶기, 우선순위 플러그인의 앞보기)이고, 아래 빌드 비교로 증명한다. 앱 쪽 변경은
   `public/account-complete.css` 하나다(§2.4).
2. **빌드 바이트와 모듈(정규화 비교, A4).** 미리 적은 예상 앱 dist 차이대로 나왔다.
   - P1(`68e683a0`): 더한 파일 셋(`web-fonts/` 셋), 지운 것과 바뀐 것 0. 바탕의 1,274개 파일과 앱 파일 집합 737개가 바이트로 같다.
   - P2(`80b0673e`): 앱 파일 737개 바이트로 같음. 모듈은 앱 그래프와 빌드 전체에서 더함·지움·바뀜·옮김 0(조각 97 = 97).
   - P3(`b4bab623`): 예상한 하나뿐인 경계 이동이 일어났다. `static-page-fonts.ts`가 가면서 `retryable-stylesheet.ts`의 가져오는 쪽이
     하나가 되어 번들러가 그 공유 조각을 `locale-fonts` 조각에 접었다. 모듈 비교: 앱 그래프 더함 0, 지움 0, 코드 바뀜 0, 옮김 1(그
     모듈), 앱 조각 97 → 96. 앱 파일 집합 737 → 736, 해시와 미리 받기 목록을 뺀 정규화로 정확히 셋만 다르다:
     `retryable-stylesheet-HASH.js` 지움, `locale-fonts-HASH.js` 바뀜(접힌 모듈), `service-worker.js`의 `BUILD_ENTRY_ASSETS`가 그 항목
     하나를 잃음. 앱 글꼴 시트 17개와 WOFF2 파일은 모두 바이트로 같고, `index.html`과 사본 41개는 해시 참조만 다르다. 빌드 설정에
     바이트를 맞추려는 줄은 더하지 않았다(계획 §5 3). 동작은 `locale-fonts.test.ts`와 `retryable-stylesheet.test.ts`가 붙잡는다.
   - P4(`a4de85d4`): 앱 파일 집합 735. P3과 견주어 `account-complete.css`(§2.4)만 바뀌고, 그 CSS가 더는 가리키지 않는
     `designsystem/fonts/PretendardVariable.woff2`가 집합에서 빠졌다.
   - I8(`55d8e49c`의 빌드)과 H′(`4eecf4c0`의 빌드): 앱 파일 735개가 P4와 바이트로 같고 모듈 차이가 없다. H′의 빌드는 I8과 견주어
     지운 두 파일(`designsystem/fonts/PretendardVariable.woff2`, `designsystem/src_ref/pretendard.css`)과 바뀐 디자인 시스템
     README·SKILL 둘만 다르다.
   - dist 전체: 바탕 1,274개 파일 68,916,855 B에서 H′ 932개 52,829,161 B.
3. **첫 화면 크기.** `guard:initial-transfer-budget`: 진입 839.5 KiB raw / 247.7 KiB gzip(바탕 839.6 / 247.8, `i18n`과 `main`의
   미리 받기 목록이 한 항목 짧아짐), eager JS 454.5 KiB gzip, eager 합계 1,999.7 KiB raw / 530.9 KiB gzip(바탕 1,999.8 / 531.0),
   eager 글꼴 0. `guard:sw-app-shell` 95개 자산, 주입 41개(바탕 96 / 42, 접힌 조각).
4. **글꼴 요청(A4).** `build:e2e` 바탕과 H′ 코드에서, 시작 화면부터 단계 B와 단계 C 미리 받기(4초 조용함)까지, 경우 다섯(UI / 브라우저
   언어: en / en-US, ko / en-US, ja / en-US, en / ja-JP, ko / ko-KR): 글꼴 요청 목록(경로, 종류, 상태, 인코딩 크기)이 모두 같다(18,
   29, 40, 18, 29개). 한자 순서 표지도 같다(ja-JP에서만 ja). 전체 요청은 접힌 조각의 요청 하나와 문서의 인코딩 크기(32,923 대
   32,922 B, raw `index.html`은 둘 다 144,146 B)만 다르다. P3과 H′ 코드에서 각각 돌렸다.
5. **앱 e2e(A4).** H′ 코드의 `build:e2e`에서 그대로인 앱 명세가 통과했다: `font-identity`, `font-baked-pixels`, `font-line-boxes`,
   `tab-header-title-alignment`, 재생목록 명세 여덟(`playlist*.test.ts`), `about-page-layout`, 61 / 61(6.4분). P3에서도 61 / 61.
6. **하지 않은 것.** 계획 §5 7의 화면 픽셀 비교(B 대 H′의 여러 화면 PNG)와 §5 6의 WebKit 줄 상자 행은 따로 돌리지 않았다. 그 대신
   앱 파일 집합의 바이트 비교(위 2)가 P4부터 H′까지 같음을 보이고, P3의 차이는 모듈 코드가 같은 조각 경계 이동과 로그인 완료 창
   하나다. 실제 기기, Linux Playwright, WebKit에서는 돌리지 않았다.

## 6. 공개 페이지 확인 (오너 사진 없이)

- **정적 계약**(단위와 `guard:font-assets`): 등록된 모든 공개 HTML 입구의 링크와 인라인 스타일, 모든 공개 CSS 규칙, 42개 언어 스택
  일치, 글꼴 미리 받기 없음, 은퇴.
- **빌드**(`guard:font-build`): 소개 사본 42개와 등록된 모든 빌드 페이지, `/web-fonts/` 정확한 이어 붙이기, 은퇴한 것 없음.
- **불러오기 확인**(버리는 명세, 커밋 안 함, H′ 코드의 `build:e2e`): 소개 en·ko·ja·ar·hi, 개인정보, 약관, FAQ, 개발자, 번역, 사이트맵,
  블로그, 히스토리, 디자인 시스템과 미리보기 넷, 이벤트 ko·en, 404, 로그인 완료 창 ko·en, 23 / 23. 같은 출처 4xx 없음(로컬 미리보기에
  API가 없어 번역 페이지의 `/api/` 503은 뺌), 콘솔 오류 없음, 세 시트와 `/han-order.js`를 한 번씩(이벤트는 `rest.css` 없음), 은퇴한 것
  요청 없음, 오류 상태의 면 없음. 로그인 완료 창은 시트도 표지도 글꼴 파일도 요청하지 않는다. A5가 말하는 기본 Full E2E의 가벼운
  불러오기 명세(I10)는 이 갈래에 아직 없다(§11).
- **이미 있는 e2e**(H′ 코드의 `build:e2e`): `design-system-page`, `history-page`, `asamo-event`, `auxiliary-component-cascade`,
  `maintenance-inline-logo`, `not-found-page`, `release-smoke` 32 / 32.
- **Typography 실험 명세**(따로 켜는 설정, H′ 코드의 운영 빌드): 1440, 768, 390, 360 px 4 / 4. 폭마다 견본 31개, 글자 213개를 CDP
  `CSS.getPlatformFontsForNode`로 읽어 모두 이름표의 자체 호스팅 면 하나(Inter 154, MUSIXQUARE Hangul 32, Noto Sans JP 9, KR 3, SC 6,
  TC 5, Thai·Arabic·Hebrew·Devanagari 1씩). 가로 넘침 없음, 공유 가장자리, 줄 높이, 행간 1/32 px 안, opsz 비율 4% ~ 6.5%, 1x 머리선,
  네트워크 깨끗함.

## 7. 측정

- 소개 en(닫힌 메뉴): 글꼴 파일 2개 90,168 B(Inter 라틴과 `→`의 KR 조각). 메뉴를 열면 26개 1,581,984 B가 더해진다(닫힌 메뉴가 받은
  것이 없다는 증거). 소개 ko(닫힌 메뉴): 15개 341,956 B(MUSIXQUARE Hangul 조각 13개, Inter 라틴, KR 조각 하나). 전에는 소개를 열 때마다
  Pretendard 파일 2,057,688 B를 받았다.
- 다른 페이지가 받는 글꼴 파일 수(P4, 차가운 캐시): 블로그 1, 히스토리 1, 디자인 시스템 1, 이벤트 12, 404 2.
- 모든 공개 페이지가 머리에서 `first.css`와 `stacks.css`를 기다린다(brotli 약 15.6 KB). `rest.css`를 머리에 거는 소개 사본 17개는
  brotli 약 50.6 KB를 더 기다린다.
- 측정은 Windows Chromium의 것이고 실제 iPhone Safari와 Android에서는 재지 않았다. iOS 17은 닫힌 메뉴가 `display: none`이라 어느
  엔진도 이름 상자를 만들지 않으므로 닫힌 메뉴 값과 같다고 본다[추론]. 바꾸기 전 최악은 닫힌 메뉴와 열린 메뉴를 합친 값(약 1.67 MB, 90,168 + 1,581,984 B)이었다.

## 8. QA 라운드

환경: Windows 11, Node 24.22.2 / npm 12.0.2, Playwright Chromium(로컬, 재시도 0, 추적 끔, 포트 5491·5492), 운영 빌드는 `vite build`와
두 materialize 스크립트, e2e는 `build:e2e`. 실제 기기, Linux 컨테이너, WebKit 없음.

| 라운드   | 시험한 코드 SHA                        | 무엇                                                                                                                                                                                                                                       | 통과 / 실패 / 건너뜀과 한계                                                                                                                                                                                                    |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 (P1)   | `68e683a0`                             | 운영 빌드 비교, 가드 37개, typecheck, lint, format, 전체 단위 두 번, `font-identity` e2e 3 / 3                                                                                                                                             | 가드 36 통과, `guard:sw-cache-version` 실패(버전 올리기 없음, 예상). 전체 단위의 실패는 git과 workerd를 띄우는 시험의 부하 시간 초과뿐이고 따로 돌려 통과(하나는 자체 30초 한도로 따로 돌려도 한 번 시간 초과, 이 변경과 무관) |
| 2 (P2)   | `80b0673e`                             | 운영 빌드 비교, 가드, typecheck, lint, format, 자원 주인 검사                                                                                                                                                                              | 가드 36 통과, `sw-cache-version` 실패(예상)                                                                                                                                                                                    |
| 3 (P3)   | `b4bab623`                             | 운영과 e2e 빌드 비교, 모듈 비교, 앱 e2e 61, 글꼴 요청 다섯, 공개 페이지 불러오기 11, 전체 단위 18,152                                                                                                                                      | 앱 e2e 61 / 61, 불러오기 11 / 11, 단위 11개 실패는 모두 `sw-cache-version-guard`와 `release-deployment-state`의 부하 시간 초과(따로 120초 한도로 53 / 53, 104 / 105, 남은 하나는 자체 30초 한도)                               |
| 4 (P4)   | `a4de85d4`                             | 운영 빌드 비교, 가드, typecheck, lint, format, 이미 있는 공개 e2e 32, 불러오기 12, 로그인 완료 창 그림, 전체 단위 18,221                                                                                                                   | e2e 32 / 32, 불러오기 12 / 12, 단위 7개 실패는 같은 두 파일의 부하 시간 초과(따로 53 / 53, 105 / 105)                                                                                                                          |
| 5 (I8)   | `4642d38a`(빌드는 `55d8e49c`)          | Typography 단위, 실험 명세와 실패 증거, 1x 머리선 측정, 가드, typecheck, lint, format, 전체 단위 18,236                                                                                                                                    | 실험 4 / 4, 단위 4개 실패는 같은 두 파일의 부하 시간 초과(따로 53 / 53, 105 / 105)                                                                                                                                             |
| 6 (H′)   | `4eecf4c0`(H′의 코드)                  | 운영과 e2e 빌드 비교, 가드 37개 하나씩, 생성기 셋 `--check`, 앱 e2e 61, 공개 e2e 32, 글꼴 요청 다섯, 불러오기 23, 실험 4, 전체 단위, 로컬 `changedRuntimePaths`                                                                            | 아래                                                                                                                                                                                                                           |
| 7 (관문) | `592a8658`(H′ 머리, 코드는 `4eecf4c0`) | 전체 로컬 관문: typecheck, lint, format, `build:checked`와 그 나머지 사슬, 가드 37개 하나씩, 자원 주인 검사, 커버리지 둘, 전체 단위, `test:e2e:critical`, 앱 글꼴·화면 명세, 불러오기, 실험, `test:e2e:candidate`, A4 최종 증명, 배포 대상 | §8.2. 가드 36 통과, `sw-cache-version` 실패(예상). 단위 1개 부하 시간 초과(따로 105 / 105). A5의 기본 Full E2E용 불러오기 명세가 없어 버리는 명세로 대신함                                                                     |

라운드 6(H′의 코드):

- 운영 빌드: 앱 파일 735개가 P4와 바이트로 같음, 모듈 차이 없음(§5 2). `guard:font-build`는 그 빌드 그대로에서 통과했다.
- 가드 37개를 하나씩: 36개 통과, `guard:sw-cache-version`만 실패(버전 올리기 없음, 예상. 공개 파일, `vite.config.ts`, 지운 Noto 파일,
  새 `src/i18n` 두 모듈 등을 적음). `guard:dead-exports`: test-only 20 / 20, self-only 76 / 76, 완전히 죽은 것 0.
- `generate:font-sheets -- --check`, `generate:app-faces -- --check`(373면을 다시 구워 같음, 66.9초), `generate:hangul-faces -- --check`
  (87면을 다시 잘라 같음, 19.8초): 통과. 지운 번호 없는 면을 생성기가 읽지 않는다는 증거다.
- e2e: 앱 61 / 61(6.4분), 공개 32 / 32, 글꼴 요청 다섯 모두 같음, 불러오기 23 / 23, Typography 실험 4 / 4.
- 가드의 반드시 실패: 고친 원본(공개 CSS의 Pretendard, 되살린 `css/pretendard.css`, 배포 사본, 번호 없는 면 하나, 점검 모듈에서 이름을
  뺌)과 고친 빌드(`designsystem/fonts/`, `src_ref/`, 빌드된 `noto-jp` 시트, 빌드 CSS의 Pretendard, 404의 은퇴 링크)에서 각 항목이
  실패했다. 그 뒤 원본과 빌드를 되돌렸다.
- `npm run typecheck`(tsc 프로젝트 모두와 그 가드), `npm run lint`(앱과 도구, 경고 0), `npm run format:check`,
  `check-resource-ownership.mts`(기준치 그대로): 통과.
- 로컬 `changedRuntimePaths(cd8eaf47, 4eecf4c0)`: App 85, PRO room·remote-share·signaling·Developer API·facade 0,
  `changedAppRuntimeDependencies` 없음.
- 전체 단위: §8.1.

### 8.1 H′ 코드의 전체 단위 실행

`4eecf4c0`에서 `vitest run` 한 번(440초): 760개 파일 18,240개 가운데 6개 실패, 모두 git을 띄우는 두 파일의 부하 시간 초과다
(`sw-cache-version-guard` 넷, `release-deployment-state` 둘, P1 ~ I8과 같은 종류). 따로 120초 한도로 돌리면 `sw-cache-version-guard`
53 / 53이 통과하고, `release-deployment-state`는 105개 가운데 자체 30초 한도를 지닌 한 행('blocks an unselected app when a
localized build input changes', 가짜 git 저장소만 만들고 이 열차의 파일을 읽지 않음)만 그 한도에 걸린다. 릴리스 담당이 버전
올리기 머리에서 전체 관문을 다시 돈다.

### 8.2 라운드 7: H′ 머리의 전체 로컬 관문 (2026-11-03)

시험한 SHA는 `592a8658`(이 보고서를 처음 더한 H′ 커밋, 코드는 `4eecf4c0`)이다. 환경은 위와 같다(Windows 11, Node 24.22.2 / npm 12.0.2,
Playwright Chromium, 재시도 0, 추적 끔, 포트 5491·5492). 같은 기계에서 다른 작업의 시험이 함께 돌았다. 실제 기기, Linux 컨테이너,
WebKit 행은 없고, 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다.

- **정적 검사.** `npm run typecheck`(가드와 tsc 프로젝트 모두), `npm run lint`(경고 0), `npm run format:check`,
  `node scripts/check-resource-ownership.mts`(기준치 그대로): 통과.
- **`npm run build:checked`.** 앞의 가드 12개를 지나 `guard:sw-cache-version`에서 멈췄다(버전 올리기 없음, 예상. 적은 경로 83개는
  라운드 6과 같음). 나머지 사슬을 하나씩 돌렸다: `guard:profanity-patterns`, `guard:index-hreflang`, `guard:sitemap`, `build`,
  `guard:legacy-tv-build`, `guard:service-worker-build`, `guard:ui-kit-build`, `guard:initial-transfer-budget`, `guard:prod-hooks`,
  `guard:prod-security`, `guard:font-build`, `guard:sw-app-shell` 모두 통과. 그 dist(932개 파일)는 라운드 6의 운영 빌드와 바이트로 같다.
- **가드 37개를 하나씩**(그 dist 위에서): 36개 통과, `guard:sw-cache-version`만 실패(예상). `guard:dead-exports`: test-only 20 / 20,
  self-only 76 / 76, 완전히 죽은 것 0.
- **단위.** `vitest run --maxWorkers=4`(507초): 760개 파일 18,240개 가운데 1개 실패. `release-deployment-state`의 'blocks an
  unselected app when a localized build input changes'가 자체 30초 한도에 걸렸다(34.0초, 부하). 그 파일만 따로 돌리면 105 / 105
  통과. `test:coverage:critical`(110개 파일 4,501개)과 `test:coverage:workers`(69개 파일 3,329개)는 문턱을 채우고 통과.
- **e2e(`build:e2e`, 라운드 6의 e2e 빌드와 바이트로 같음).** `test:e2e:critical` 101 / 101(5.7분). 앱 글꼴·화면 명세 61 / 61(6.4분):
  `font-identity` 3, `font-baked-pixels` 3, `font-line-boxes` 3, `tab-header-title-alignment` 10, 재생목록 명세 여덟 33,
  `accessibility-contrast` 7, `design-system-page` 2.
- **공개 페이지 불러오기.** A5가 말하는 기본 Full E2E용 가벼운 불러오기 명세(I10)는 이 갈래에 없어 돌리지 못했다(§11 2). 대신 §6의
  버리는 명세를 같은 e2e 빌드에서 돌려 23 / 23: 4xx 없음(번역 페이지의 로컬 `/api/` 503은 뺌), 콘솔 오류 없음, 세 시트와
  `/han-order.js`를 한 번씩(이벤트는 `rest.css` 없음), 은퇴한 것 요청 없음, 오류 상태의 면 없음. 로그인 완료 창은 시트도 표지도 글꼴
  파일도 요청하지 않는다. App Worker가 그리는 글과 관리자 페이지, UI 키트, 나머지 미리보기 17개는 이 확인에 들지 않는다.
- **Typography 실험 명세**(따로 켜는 설정, `build:checked`의 dist를 그대로 띄움): 4 / 4.
- **`test:e2e:candidate`**(`build:checked`의 dist): 19 / 19.
- **A4 최종 증명.** 깨끗한 `cd8eaf47` 운영 빌드(1,274개 파일, 이 갈래를 시작할 때 만든 바탕 빌드와 바이트로 같음)와 H′ 머리의 운영
  빌드(932개, `build:checked`의 dist와 같음)를 견줬다.
  - 모듈: 앱 조각 97 → 96, 앱 그래프 더함 0, 지움 0, 코드 바뀜 0, 옮김 1(`retryable-stylesheet.ts`가 `locale-fonts` 조각으로). 빌드
    전체는 지움 2(`static-page-fonts.ts`, `locale-font-contract.ts`), 코드 바뀜 1(`.workshop/sitemap/main.ts`).
  - 앱 파일 집합 737 → 735. 해시와 미리 받기 목록을 뺀 정규화 차이는 다섯뿐이다: `retryable-stylesheet-HASH.js`와
    `designsystem/fonts/PretendardVariable.woff2`가 빠지고, `account-complete.css`(§2.4), `locale-fonts-HASH.js`(접힌 모듈),
    `service-worker.js`(`BUILD_ENTRY_ASSETS` 42 → 41, 그 조각 항목 하나)가 바뀐다. 머리 쪽 앱 집합의 글꼴 시트와 WOFF2 488개는
    바탕의 같은 경로와 바이트로 같다.
  - 첫 화면 크기: 바탕(바탕 자신의 가드) 진입 839.6 / 247.8 KiB, eager 합계 1,999.8 / 531.0 KiB, H′ 839.5 / 247.7, 1,999.7 / 530.9.
    eager JS는 둘 다 454.5 KiB gzip, eager 글꼴은 둘 다 0. `guard:sw-app-shell` 96 / 42 → 95 / 41.
  - 글꼴 요청(`build:e2e` 둘, 시작 화면부터 단계 C 미리 받기까지): en / en-US 18, en / ja-JP 18, ja / en-US 40, ko / en-US 29,
    ko / ko-KR 29개가 모두 같고 한자 순서 표지도 같다. 전체 요청은 접힌 조각의 요청 하나와 문서의 인코딩 크기(32,923 대 32,922 B)만
    다르다.
- **배포 대상.** `scripts/release-deployment-state.mts`의 `verifyPartialReleaseCompatibility('app', 592a8658…)`를, Wrangler 조회 대신
  main 릴리스 기록 §1의 배포 SHA(App `cd8eaf47`, PRO room `683074bc`, remote-share·signaling·Developer API·facade `71f5b96c`)를 주고
  돌렸다: compatible. `changedRuntimePaths`는 App 85(라운드 6 목록과 같음), 나머지 다섯 0, `changedAppRuntimeDependencies`는 없다.
  target은 `app`이다.

## 9. 위험

1. **나눠 쓰는 빌드 코드로 앱이 바뀜.** 막음: P1 ~ H′의 바이트와 모듈 비교, 요청 목록, 앱 e2e(§5). 남은 앱 쪽 차이는 조각 접기와 로그인
   완료 창뿐이다.
2. **모든 공개 페이지가 막는 시트 둘을 기다림**(brotli 약 15.6 KB), 소개 사본 17개는 `rest.css`(약 50.6 KB)도 머리에서 기다린다.
3. **본문 끝의 `rest.css`를 기다리는 미룬·모듈 스크립트(A7).** 소개의 진입과 분석, 사이트맵과 번역의 진입, `policy-accordion`, 블로그
   쪽 넘기기와 분석, 히스토리와 디자인 시스템의 분석, 관리자의 `clearable-editors.js`와 `admin.js`가 `rest.css`가 올 때까지 늦는다.
   이벤트 페이지는 그래서 `rest.css`를 걸지 않고 그 시트의 글자를 기기 글꼴로 그린다.
4. **`/han-order.js`.** 모든 공개 페이지가 막는 스크립트 하나(477 B)를 싣고, 404에도 스크립트가 생긴다. 일본어나 중국어를 먼저 둔
   브라우저에서 한국어·영어 페이지의 한자는 그 순서의 가족이 본문 끝 `rest.css`로 오므로 잠깐 대체 글꼴로 보일 수 있다(앱은 그
   시트를 단계 A에서 받음).
5. **Typography 절의 표지 없는 漢 칸.** 이름표가 Noto Sans KR인데, 일본어나 중국어를 먼저 둔 브라우저에서는 `/han-order.js`가 앱처럼
   기본 순서를 바꿔 그 칸이 브라우저의 순서로 그린다. 고정된 KR 스택은 앱에 없는 스택이라 두지 않았다.
6. **한국어 공개 페이지가 MUSIXQUARE Hangul 조각을 받음**(소개 ko 341,956 B). 전의 Pretendard 2.06 MB보다 적다.
7. **오래된 `/web-fonts/` 별칭**이 나중 릴리스가 지운 면 해시를 가리킬 때: 한 번의 페이지 보기가 그 면만 대체 글꼴로 그린다(300초 /
   7일 재확인). 이 열차는 면 바이트를 바꾸지 않는다.
8. **은퇴한 URL이 404**(`/designsystem/fonts/PretendardVariable.woff2`, 처리된 Pretendard와 원래 Noto 시트): 배포 때 열린 옛 공개 탭은 한
   번 기기 글꼴로 그린다(Q4, 구버전 정책).
9. **저장한 언어로 제자리에서 바뀐 `/about`**: 그 언어의 면이 본문 끝 `rest.css`로 와서 잠깐 기기 글꼴로 보인다. 언어별 URL은 머리에서
   받는다.
10. **로그인 완료 창의 글꼴이 기기마다 다름**(§2.4). 짧게 보이는 창이고 글자와 배치는 그대로다.
11. **보이는 공개 페이지 변화**(Inter 라틴 본문 1 ~ 2% 넓음, 큰 제목 3 ~ 6% 좁음, 휴대폰의 개인정보 페이지 길어짐, 히스토리 휴대폰 제목
    3 → 2줄, 번역 페이지 휴대폰 고아 글자, 디자인 시스템 단추 Arial → Inter, Google 단추 한글): 사진 없이 받아들였다(Q6).
12. **`@starting-style`이 없는 엔진의 메뉴**(Safari < 17.5, Chrome < 117, Firefox < 129): 페이드 없이 열고 닫는다. 초점 e2e가 클릭과
    Enter를 지킨다.
13. **새 명세가 Linux에서 돌지 않았음.** Typography 실험 명세는 따로 켜는 설정이라 Full E2E에 들지 않는다. 바뀐 기존 e2e(`font-identity`,
    `about-page-layout`)는 머지 뒤 Full E2E(Linux Chromium)에서 처음 Linux로 돈다.
14. **모든 앱 사용자가 업데이트 창을 봄.** `public/`의 경로는 App 런타임이라 앱 변경이 로그인 완료 창 하나뿐이어도 그렇다.
15. **main과 어긋남.** 이 갈래는 9.0.34의 배포 기록(`432d4ae7`) 앞에 있다. 옮길 때 `docs/README.md`와 `docs/release-record.md`가 겹친다(§11).

## 10. 되돌리기

- **릴리스 중:** 실패한 smoke는 워크플로의 복구로 변경 전 App checkpoint(9.0.34 / v807, `cd8eaf47`의 App)로 돌린다.
- **릴리스 뒤(기본): 앞으로 되돌리기.** main에서 이 열차의 squash 커밋을 되돌리고 9.0.36 / v809로 올린다(target `app`). 되돌리는 커밋이
  공개 Pretendard 사본(남은 원본과 같은 바이트, sha256 `9599f12f…`), Pretendard 시트, Noto Cyrillic·Greek 파일, 번호 없는 면, 공개 글꼴
  로더 둘과 옛 링크를 git에서 되살리므로 내려받기가 필요 없다. D1, Durable Object, 바닥, 다른 Worker는 상관없다. `/web-fonts/`가 있던
  동안 열린 페이지는 다시 불러올 때까지 기기 글꼴로 그린다.
- **일부만 되돌리기:** 페이지 묶음 하나만 되돌리는 길은 주장하지 않는다(A2). I9의 은퇴 가드와 지운 파일이 묶여 있어, 일부를 되돌리려면
  I9도 함께 되돌리고 전체 관문을 다시 돌아야 한다. 기본은 열차 전체의 앞으로 되돌리기다.
- **급할 때:** `docs/hotfix-procedure.md`대로 App Worker를 9.0.34 버전으로 CLI 되돌리기(명시적 검토, 낮은 epoch v807로 가므로 릴리스
  기록 §2 9.0.29 절의 '낮은 epoch로 가는 App 손 되돌리기의 규칙' 항목을 따름). 다른 배포처럼 §1, `Last source review`, 이력 한 행을
  기록하고 앞으로 고친다.

## 11. 릴리스 담당이 할 일

1. **main 위로 옮기기.** 이 갈래를 9.0.34의 배포 기록이 든 main(`432d4ae7` 이후) 위로 옮긴다. 코드 충돌은 없을 것이다(그 사이 main은
   문서만 바뀜)[추론]. `docs/README.md`(이 보고서 항목과 9.0.34 항목)와 `docs/release-record.md`(§2의 9.0.34 절이 배포 뒤 절이 되고,
   9.0.29 절의 뒤 열차 항목 문구가 바뀜)가 겹친다. 옮긴 뒤 main의 기록에만 있는 공개 페이지 글꼴 열차 언급(9.0.34 절의 혼자
   되돌리기 창과 '다음 단계'(2), §4 9.0.34 항목의 번호)도 이 열차에 맞춘다. 옮긴 뒤 SHA 대응표를 이 보고서에 더하고, §5의 비교와
   라운드 6을 옮긴 머리에서 다시 돈다.
2. **I10(남음).** A5의 기본 Full E2E용 가벼운 불러오기 명세(공개 페이지와 언어 견본마다 한 번, 4xx나 콘솔 오류만으로 실패)와, 계획
   §6의 면·측정 명세(따로 켜는 설정 `playwright.public-fonts.config.ts`에). 이번 확인은 버리는 명세로 했다(§6).
3. **I12 버전 올리기** 9.0.35 / v808: 9.0.34의 버전 올리기와 같은 거울 여섯 파일 일곱 줄. 그 뒤 `guard:sw-cache-version`과
   `guard:release-identity`가 통과하고, H의 dist는 H′와 버전을 지닌 파일만 다르다.
4. **배포 전 절.** §2 맨 위에 이 열차의 '배포 전' 절(범위, 오너 결정, Q1 ~ Q7과 D1 ~ D10 한 줄씩, 배포 조건, 되돌리기, 오너가 볼 것,
   이 보고서 링크)을 더한다. 오너가 볼 것: 업데이트 창 뒤의 앱(ko와 en 시작 화면, 재생목록, 채팅, 설정)이 9.0.34와 같다는 것, 그리고
   로그인 완료 창이 기기 글꼴로 바뀐 것(§2.4의 그림을 오너 메모에 붙임).
5. **새 명세를 Linux Playwright 컨테이너에서 한 번** 돌린다(계획 §8.1 11). 바뀐 `font-identity`와 `about-page-layout`이 Windows 글꼴에
   기대지 않는지 본다.
6. **머지 뒤:** `agent/public-page-fonts`(로컬과 원격)와 그 작업 폴더를 지우고, 이 열차에 접힌 로컬 갈래(이전 공개 페이지 글꼴 갈래와
   Typography 시안 갈래, 각 작업 폴더)를 거둔다.
