# 번역 페이지 입구 열차 9.0.24: 언어 기본값, 방문 통계, 로그인 취소 안내 (2026-10-29)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 진행 중(2026-10-29 ~ 30). 세 증분의 테스트 먼저와 구현, 전체 검사(QA 라운드 2), 운영 빌드 브라우저 측정(QA 라운드 3), main `d3a9b66a`(#527, 9.0.23 기록) 위로 옮기기, README 숫자 고침, 버전 올리기와 `build:checked` 다시(QA 라운드 4), 두 리뷰(승인, 낮은 지적) 뒤 오너 후속 결정 다섯의 테스트 먼저와 구현, 버전 올리기 다시 만들기(QA 라운드 5), 전체 검사 다시(QA 라운드 6), 운영 빌드 측정 다시(QA 라운드 7)까지 끝났고 미병합·미배포다. 브랜치 `agent/translate-entry`는 main `d3a9b66a` 위 11커밋이다: 테스트 먼저 넷, 구현 넷, README 하나, 버전 올리기 `5b029d22`(마지막 런타임 커밋), 이 보고서와 릴리스 기록을 더한 문서 커밋. PR, PR CI, 자동 코드 리뷰, exact-main CI, 배포는 아직이다                       |
| Base               | 증분은 main `5a5afb0e`(#526, 9.0.23 / v796) 위에서 만들었고, 그 뒤 main에 9.0.23 배포 기록 `d3a9b66a`(#527, 문서만)가 들어와 충돌 없이 옮겼다. 옮긴 일곱 커밋은 `git patch-id --stable`이 모두 같고, 옮긴 뒤 문서 밖 트리는 옮기기 전과 같다('옮긴 뒤 SHA' 표). 운영은 9.0.23(App `dddfabe3`, 2026-10-29 21:22 KST 배포, 공개 `/service-worker.js` `v796`)이고 다른 다섯 Worker는 9.0.22 `71f5b96c`의 버전이다                                                                                                                                                                                                                                                                                                             |
| Version            | 9.0.24 / v797(앱 빌드 797). 마지막 런타임 커밋 `5b029d22`가 9.0.23의 `060dce82`와 같은 거울 여섯 파일 일곱 줄(`package.json`, `package-lock.json` 두 곳, App Worker의 `ADMIN_ASSET_VERSION`, 관리자 스크립트의 `ADMIN_SCRIPT_VERSION`, `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 쿼리)을 올렸다(앞선 `72f2015a`와 diff 줄이 같고, 후속 커밋 뒤로 다시 만듦). `guard:release-identity` 'MUSIXQUARE 9.0.24; service-worker cache epoch v797', `guard:sw-cache-version` PASS(QA 라운드 6). 앱 SemVer와 SW 캐시가 바뀌므로 업데이트 창이 뜬다(바닥 789 위 탭에는 '나중에'가 있는 보통 창)                                                                                                                       |
| Scope              | 2026-10-29 오너가 승인한 공개 `/translate` 세 가지: 1 언어 기본값(주소의 `?locale`, 아니면 App과 같은 방식으로 맞춘 브라우저 언어, 아니면 영어. `?phrase`, 언어와 문구를 주소와 로그인 복귀에 지킴, App 언어 창의 번역 참여 링크가 App 언어를 실음), 2 방문 통계(다른 단독 페이지와 같은 `/analytics-bootstrap.js` 로더), 3 로그인 취소·실패 안내(제출 상태 글 한 줄, 주소에서 `accountAuth` 지움). 같은 날 리뷰 뒤 오너 후속 결정: App 링크는 App 언어가 페이지가 브라우저에서 고를 언어와 다를 때만 `?locale`을 실어 대부분의 도착을 세고(로더 규칙은 그대로), Retry도 주소 문구를 고르고, 주소 문구가 있는 쪽으로 목록을 연다. 새 화면 글은 오너가 승인한 영어 두 줄뿐이다                                              |
| Deploy target      | 예상 `app`. main `d3a9b66a`(운영 9.0.23과 문서 밖 트리가 같음)와 `5b029d22`를 `scripts/release-deployment-state.mts`의 `changedRuntimePaths`와 Worker별 런타임 경로로 견준 로컬 git 판정: App 14(`.workshop/translate` 6, `src` 3(`i18n/index.ts`, 새 `i18n/language-match.ts`, `ui/settings.ts`), `tsconfig.workshop-landing.json`, 버전 올리기의 `browser/classic-runtime/admin.ts`, `cloudflare/app-worker.ts`, `index.html`, `scripts/service-worker-asset.ts`), PRO 방, signaling, remote-share, Developer API facade, Developer API는 0이다. `changedAppRuntimeDependencies`는 빈 목록이다. 릴리스의 부분 릴리스 판정이 운영을 읽어 다시 확인한다. Developer API D1과 `raise_app_build_floor`는 둘 다 false다        |
| Operations         | 이 열차는 운영에 아무것도 하지 않았다. 운영에 보낸 것은 인증 없는 GET뿐이다(`/translate`와 `/faq`의 응답 머리글, `/service-worker.js`, `/analytics-bootstrap.js`). 로그인, 제출, 관리자 화면은 쓰지 않았다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Resource ownership | 새 복구·재시도·시간 제한·감시·생명주기 흐름이 없어 레지스트리를 바꾸지 않았다. 번역 페이지의 주소 쓰기(`history.replaceState`)는 `main.ts`의 `writeAddress` 하나가 맡고(언어·문구 기억과 `accountAuth` 지우기가 모두 그 함수를 거침), 그 페이지의 유일한 주인이라 기록이 필요 없다. `.workshop`은 `check-resource-ownership.mts`와 `check-navigation-sinks.mts`의 범위 밖이고, App 쪽 `settings.ts`는 링크의 `href`만 바꾼다(가드가 세지 않는 앵커). 후속 2는 있던 Retry 버튼이 요청하는 문구만 바꿨고 새 재시도 흐름이 아니다. `node scripts/check-resource-ownership.mts`는 49 records / 448 production files로 통과했다(새 `src/i18n/language-match.ts`로 +1, history entry write 12 그대로, QA 라운드 6에서 다시 확인) |

이 문서는 9.0.23 다음 앱 업데이트로 묶는 9.0.24 / v797을 기록한다. 운영의 번역 제안은 0건이다(2026-10-29 21:45 KST 관리자
Translations 'No suggestions.', 같은 날 공개 목록 GET 42개 언어 모두 0건, [9.0.23 기록](../release-record.md)). 진단은 제출 경로가
돌아가고 입구에서 사람을 잃는다고 봤고, 오너가 같은 날 세 가지와 리뷰 뒤 후속 다섯을 정했다. 세 증분과 후속(코드가 바뀌는 후속
1 ~ 3) 모두 실패하는 테스트를 먼저 커밋했고, 그 테스트가 부모 코드에서 실패함을 확인했다. 증거 로그, 측정 스크립트, 사진은 저장소 밖 작업 노트에 있다. 시험의 방 코드는
없다(번역 페이지는 방을 쓰지 않음).

## 오너 결정 (2026-10-29)

- **1 언어 기본값.** 페이지는 `?locale=<code>`가 지원하는 언어 코드면 그 언어로, 아니면 방문자의 브라우저 언어를 App과 똑같이
  맞춰(`navigator.languages` 순서대로, 정확한 코드 다음 첫 부분 태그, 같은 별칭) 열고, 맞는 것이 없으면 영어로 연다.
  `?phrase=<surface>:<key>`가 그 카탈로그에 있으면 그 문구를 고르고, 없으면 지금의 첫 문구(`about:hero.h1`)를 둔다.
  방문자가 언어나 문구를 바꾸면 `history.replaceState`로 주소에 `locale`(와 `phrase`)를 지키고, 두 로그인 링크의 `returnTo`가
  지금 경로와 쿼리를 실어 Google 로그인 뒤 같은 언어와 문구로 돌아온다(`sanitizeReturnTo`의 바이트 상한 안, 필요하면
  `phrase`를 뺌). App 언어 창의 번역 참여 링크는 `/translate?locale=<App 언어>`를 열고 언어를 바꾸면 따라간다. 맞추는 함수는
  App과 페이지가 한 모듈을 함께 쓴다. 믿을 수 없는 쿼리 값은 알려진 코드와 카탈로그 id와 견주기만 하고 HTML로 그리지 않는다.
- **2 방문 통계.** 다른 단독 페이지(`/faq` 등)와 같은 지연 `/analytics-bootstrap.js` 로더를 `translate.html`에 더하고,
  `/translate` 응답 머리글(CSP)이 `/faq`와 똑같이 그것을 허락하는지 확인한다.
- **3 로그인 취소·실패.** `accountAuth=cancelled`면 'Sign-in was cancelled.', `accountAuth=error`면 "Couldn't sign in. Try
  again."을 기존 계정 또는 제출 상태 글에 보이고(새 컴포넌트, 배너, 토스트, 스타일 토큰 없음), `locale`과 `phrase`를 둔 채
  `replaceState`로 `accountAuth`를 지운다. `success`는 새로 보이는 것 없이 지운다. 이 영어 두 줄 밖의 화면 글은 바꾸지
  않는다(페이지 인터페이스는 영어만).

## 오너 후속 결정 (2026-10-29, 두 리뷰 승인 뒤)

두 리뷰는 낮은 지적만 남기고 승인했다. 릴리스 오너가 그 지적과 열린 질문을 다음처럼 정했다(오너에게 더 묻지 않음).

- **후속 1 방문 통계.** 로더는 쿼리가 있으면 닫히므로 App 언어 창에서 `/translate?locale=xx`로 온 방문은 세지 않는다. 로더의
  개인정보 규칙은 바꾸지 않는다. 대신 App의 번역 참여 링크는 App이 고른 언어가 페이지가 브라우저에서 고를 언어(공유 맞추기의
  `resolvePreferredLanguage`를 `navigator.languages`에)와 다를 때만 `?locale`을 싣고, 같으면 그냥 `/translate`다. 그래서
  대부분의 도착이 쿼리 없이 세어지고 페이지는 여전히 같은 언어로 열린다.
- **후속 2 Retry가 문구 유지.** 첫 카탈로그 불러오기가 실패한 뒤 Retry도 주소의 문구를 고른다(첫 `selectEntry`까지
  `pendingPhrase`).
- **후속 3 주소 문구 쪽.** 첫 불러오기가 주소의 문구를 고르면 목록을 그 문구가 있는 쪽으로 넘긴다(걸러진 목록에서의 순서를 쪽
  크기로 나눔).
- **후속 4 아포스트로피.** "Couldn’t sign in. Try again."의 둥근 따옴표는 페이지의 기존 글과 맞으므로 그대로 두고 보고서에
  적는다(묻지 않음).
- **후속 5 문서.** docs/README 항목은 취소·실패한 로그인이 `accountAuth`만 지우고 다른 매개변수와 조각을 둔다고 적는다.
  보고서는 prettier로 맞추고, 버전 올리기 트리에서 전체 단위 실행이 통과했음을 적는다.

후속 1 ~ 3은 테스트 먼저(부모에서 실패하는 시험만의 커밋, 그다음 코드)로 `6f916d9f` 뒤, 버전 올리기 앞에 넣었다. 그러려고
버전 올리기와 문서 커밋을 브랜치에서 빼고(내용은 보관) 새 커밋을 더한 뒤, 버전 올리기를 같은 파일과 줄로 다시 만들고 이 문서
커밋을 고쳐 다시 얹었다('옮긴 뒤 SHA' 표).

## 진단 사실

진단(2026-10-29 저녁, 운영에 인증 없는 GET만)과 이 열차의 확인:

- 제출 경로는 돌아간다: `/api/auth/session`은 `configured: true, authenticated: false`로 답하고, `/api/auth/google/start`는
  Google 인증 주소로 302를 준다. 42개 언어 카탈로그(언어마다 877 문구: App 803, About 74)는 모두 200이고 자리표시자·마크업
  검사가 통과한다.
- 언어: 운영 `main.ts`가 `requestedLocale = 'pt-br'`과 `selectedId = 'about:hero.h1'`을 박아 두고 주소와 브라우저 언어를
  읽지 않는다. 그래서 모든 방문자가 포르투갈어(브라질)로 시작하고, 로그인 링크가 `returnTo=/translate`라 로그인 뒤에도
  포르투갈어로 돌아온다. App 언어 창의 링크도 그냥 `/translate`다.
- 통계: 운영 `/translate` HTML에는 `/analytics-bootstrap.js`가 없다(FAQ, Privacy, Terms, Developers, Sitemap, About, Blog,
  History, Design System에는 있음). 그래서 이 페이지의 방문이 보이지 않는다. 운영 `/translate`와 `/faq`의 CSP는 글자까지 같고
  `script-src`에 `https://static.cloudflareinsights.com`, `connect-src`에 `https://cloudflareinsights.com`이 있다(2026-10-29
  23시대 KST GET). `/analytics-bootstrap.js`는 운영에서 200 `text/javascript`다.
- 로그인 결과: Worker의 OAuth 콜백은 `returnTo`에 `accountAuth=success|cancelled|error`를 붙여 303으로 돌려보내는데, 번역
  페이지는 그 표지를 읽지 않아 취소나 실패에 아무 말이 없고 표지가 주소에 남는다.

## 증분 한눈에

| 증분          | 테스트 먼저 | 구현       | 바뀐 것                                                                                                                                                                                                                                            |
| ------------- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 언어 기본값 | `2b12aba6`  | `bea4e56b` | 새 `src/i18n/language-match.ts`(App의 `_matchLanguage` 논리를 옮김, `index.ts`가 가져다 씀), 새 `.workshop/translate/address.ts`, `main.ts`, `community.ts`, `community-client.ts`, `src/ui/settings.ts`, `tsconfig.workshop-landing.json`, README |
| 2 방문 통계   | `3e6f26ec`  | `d57f27d8` | `translate.html`에 로더 세 줄(FAQ와 같은 주석 포함), README                                                                                                                                                                                        |
| 3 로그인 결과 | `c811efcc`  | `397c1cad` | `address.ts`의 `takeSignInResult`, `main.ts`, README                                                                                                                                                                                               |
| README 숫자   |             | `6f916d9f` | 언어마다 App 728 → 803 문구, 원천·검사 목록(README는 공개 workshop 경로라 버전 올리기 앞)                                                                                                                                                          |
| 후속 1 ~ 3    | `d7dad4fa`  | `08e96c1a` | `src/ui/settings.ts`(링크가 `?locale`을 실을 때), `main.ts`(`pendingPhrase`, 주소 문구 쪽), README. 시험: 설정, 번역 커뮤니티 UI, 애널리틱스                                                                                                       |
| 버전 올리기   |             | `5b029d22` | 9.0.24 / v797, 거울 여섯 파일 일곱 줄(앞선 `72f2015a`와 같은 줄)                                                                                                                                                                                   |

## 증분

### 1 언어 기본값

- `src/i18n/language-match.ts`가 App의 태그 맞추기(`matchLanguage`: 다듬기, `_` → `-`, 소문자, `zh-hans`/`zh-hant`와 `zh-*`
  지역, `pt`·`pt-*` → `pt-br`, `in`→`id`, `iw`→`he`, `no`→`nb`, `tl`→`fil`, 첫 부분 태그)와 순서대로 고르기
  (`resolvePreferredLanguage`: `languages`가 비면 `language`, 아무것도 안 맞으면 `en`)를 갖는다. 순수 함수이고 호출자가
  `navigator`를 넘긴다. App의 `index.ts`는 `_matchLanguage` 본문을 지우고 이 두 함수를 쓴다(동작 그대로, 기존
  `i18n-functions` 시험 통과). 시험만을 위한 export는 없고 dead-exports test-only 20 / self-only 76 그대로다.
- 페이지: `readTranslateAddress`가 `?locale`을 `LANGUAGE_OPTIONS`의 코드와 정확히 견주고(대문자, `pt-PT`, 빈 값, 마크업은
  무시), 아니면 `resolvePreferredLanguage(navigator)`를 쓴다. `?phrase`는 카탈로그를 불러온 뒤 그 카탈로그의 id와 같을 때만
  고르고, 아니면 `about:hero.h1`, 그것도 없으면 보이는 첫 문구다.
- 주소: 첫 화면은 주소를 바꾸지 않는다(애널리틱스 판단과 공유 링크를 그대로 둠). 방문자가 언어를 바꾸거나 문구를 누르면
  `writeAddress`가 `replaceState`로 `locale`과 `phrase`를 넣는다(다른 쿼리와 조각은 그대로, 기록 길이 그대로).
- 로그인 복귀: 두 로그인 링크(제안, 추천)의 `returnTo`는 보이는 언어 코드와 고른 카탈로그 id로 만든다
  (`/translate?locale=ko&phrase=about%3Ahero.h1` 꼴). 날 쿼리 글은 싣지 않는다. 그 길이가 Worker의 `returnTo` 상한
  1,024 UTF-8 바이트를 넘으면 `phrase`를 뺀다(지금 카탈로그의 가장 긴 id는 51자라 실제로는 넘지 않음). 그 상한은
  `cloudflare/account-auth.ts`의 `RETURN_TO_MAX_UTF8_BYTES` 사본이고 두 파일의 값을 견주는 시험이 고정한다.
- App: `settings.ts`의 `refreshLanguageControls`(설정 초기화와 `i18n:changed` 때 부름)가 언어 창의 번역 참여 링크 `href`를
  맞춘다. 이 증분에서는 늘 `/translate?locale=<getResolvedLanguage()>`였고, 후속 1(아래 4)부터는 App 언어가 브라우저 맞추기와
  같으면 `/translate`다. 정적 HTML의 `/translate`는 스크립트 전 대체로 그대로 두었다.

### 2 방문 통계

- `translate.html` 머리에 FAQ와 같은 `<!-- Cloudflare Web Analytics -->`, `<script defer src="/analytics-bootstrap.js"></script>`,
  끝 주석을 페이지 스크립트 앞에 넣었다. defer 스크립트와 모듈 스크립트는 문서 순서로 돌므로 로더는 페이지가 주소를 고치기
  전의 도착 주소로 판단한다(운영 빌드의 `dist/translate.html`에서도 로더가 모듈 스크립트 앞).
- 로더는 바꾸지 않았다. 운영 호스트, 쿼리·조각 없음, 방 코드 경로·쿼리 있는 referrer 아님일 때만 비컨을 붙인다.
- Worker는 바꾸지 않았다. `/translate`와 `/faq`는 같은 `serveStatic` 경로와 `SECURITY_HEADERS`를 쓴다(시험과 운영 GET 모두 같은
  CSP).

### 3 로그인 결과

- `takeSignInResult`가 처음 주소의 `accountAuth`를 읽고, 그 값을 알려진 셋(`success`, `cancelled`, `error`)과만 견주며, 그것을
  뺀 쿼리를 돌려준다. `main.ts`는 시작 때 그 쿼리로 `writeAddress`를 부르고(`locale`, `phrase`, 조각은 그대로), 첫 문구를 고른
  뒤 제출 상태 글(`#submit-status`, role=status)에 한 번 'Sign-in was cancelled.' 또는 'Couldn’t sign in. Try again.'을 쓴다.
  방문자가 고치거나 다른 문구를 고르면 기존 규칙대로 지워진다. `success`와 모르는 값은 아무것도 보이지 않는다.
- 문장의 아포스트로피는 이 페이지의 기존 글('Couldn’t load translations.', 'Couldn’t complete this action. Try again.')과
  같은 둥근 따옴표(U+2019)다. 오너가 승인한 문장은 곧은 따옴표로 적혀 있었고, 후속 4로 둥근 따옴표를 그대로 둔다.

### 4 오너 후속 결정 1 ~ 3

- **App 링크(후속 1).** `refreshLanguageControls`가 `getResolvedLanguage()`와 `resolvePreferredLanguage(navigator)`(페이지가
  `?locale` 없이 고를 언어, 같은 공유 모듈)를 견준다. 같으면 `href`는 `/translate`, 다르면 `/translate?locale=<App 언어>`다.
  시스템 언어를 쓰는 App은 늘 같으므로 그냥 `/translate`이고, 한국어 브라우저에서 App 언어를 한국어로 고른 경우도 같다. 링크는
  `target="_blank" rel="noopener noreferrer"`라 새 창에 referrer가 없고, 쿼리도 없으면 로더가 비컨을 붙인다. 로더
  (`browser/classic-runtime/analytics-bootstrap.ts`)와 그 시험은 바꾸지 않았다.
- **Retry(후속 2).** `main.ts`가 주소의 `phrase`를 `pendingPhrase`로 들고 있고, `loadCatalog`의 기본 요청 문구가
  `pendingPhrase ?? selectedId`다. `selectEntry`가 처음 불릴 때 `pendingPhrase`를 비운다. 첫 불러오기가 실패하면 문구를 고르지
  않으므로 Retry(`loadCatalog(requestedLocale)`)가 같은 주소 문구를 다시 요청한다. 값은 여전히 카탈로그 id와 견주기만 한다.
- **쪽(후속 3).** `loadCatalog`가 그 요청 문구가 `pendingPhrase`이고 걸러진 목록에 있으면 `page`를 그 순서를 쪽 크기(20)로 나눈
  몫으로 정한 뒤 고른다(Retry 포함). 주소에 문구가 없거나 카탈로그에 없으면 지금처럼 첫 쪽이고, 언어를 바꿀 때도 지금처럼 첫
  쪽이다.

### 옮긴 뒤 SHA

| 옮기기 전(`5a5afb0e` 위) | 옮긴 뒤(`d3a9b66a` 위)                                                                  | patch-id     |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------ |
| `f4e9e03d` 1 테스트 먼저 | `2b12aba6`                                                                              | 같음         |
| `9d1b6a9e` 1 구현        | `bea4e56b`                                                                              | 같음         |
| `877e6fed` 2 테스트 먼저 | `3e6f26ec`                                                                              | 같음         |
| `beb69716` 2 구현        | `d57f27d8`                                                                              | 같음         |
| `51697604` 3 테스트 먼저 | `c811efcc`                                                                              | 같음         |
| `4b7f6c66` 3 구현        | `397c1cad`                                                                              | 같음         |
| `a85add79` 버전 올리기   | `9c593600` → README `6f916d9f` 뒤로 다시 `72f2015a` → 후속 두 커밋 뒤로 다시 `5b029d22` | 같은 일곱 줄 |
| 문서 커밋                | `26bbc2b9` → 후속을 반영해 다시 얹음                                                    | 고친 내용    |

후속 반영으로 바뀐 브랜치(앞 SHA → 뒤 SHA): `6f916d9f`까지 그대로, 새 `d7dad4fa`(후속 테스트 먼저)와 `08e96c1a`(후속 구현),
`72f2015a` → `5b029d22`(버전 올리기, `git cherry-pick` 뒤 메시지만 후속 반영), `26bbc2b9` → 이 문서 커밋.

## 테스트 먼저

| 테스트 커밋                      | 부모                   | 실패한 줄                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2b12aba6`(옮기기 전 `f4e9e03d`) | `5a5afb0e`             | 18 실패 / 103 통과(세 파일)와 `language-match.test.ts` 불러오기 실패(`../language-match.ts` 없음). 브라우저 언어 여섯(ko-KR, ja, de-AT, zh-TW, sw-KE, sw-KE·fr-CA·ko가 모두 `pt-br`을 요청), `?locale=fr`, 무시할 `?locale` 다섯(xx, pt-PT, FR, 마크업, 빈 값에서 ko 대신 pt-br), `?phrase` 고르기, 주소와 로그인 복귀(주소에 `locale` 없음), 로그인 뒤 같은 언어·문구, 긴 문구 빼기, 상한 사본 시험(`address.ts` 없음), App 언어 창 링크(`/translate`이고 `/translate?locale=ko`가 아님). pt-PT 줄은 부모가 늘 `pt-br`을 열어 우연히 통과했다 |
| `3e6f26ec`(`877e6fed`)           | `bea4e56b`(`9d1b6a9e`) | 2 실패 / 25 통과: 단독 애널리틱스 페이지 목록(9개, 10개를 기대), 로더가 페이지 스크립트 앞(로더 없음, -1). 새 `/translate` 로더 판단 줄 셋(쿼리 없음은 붙고 `?locale=ko`·`?accountAuth=cancelled`는 안 붙음)과 `/translate`·`/faq` CSP 같음 시험은 부모에서도 통과하는 확인 시험이다                                                                                                                                                                                                                                                           |
| `c811efcc`(`51697604`)           | `d57f27d8`(`beb69716`) | 4 실패 / 39 통과: `accountAuth` cancelled·error·success 셋(주소에 `accountAuth`가 남음), 고치면 지워지고 모르는 값은 무시(주소가 `?accountAuth=cancelled`로 남음)                                                                                                                                                                                                                                                                                                                                                                              |
| `d7dad4fa`(후속 1 ~ 3)           | `6f916d9f`             | 9 실패 / 148 통과(세 파일). App 링크 일곱: 흐름 시험(ja-JP 브라우저에서 App 언어 system이 `/translate`가 아니고 `/translate?locale=ja`)과 표 여섯(ko-KR의 ko·system, sw-KE·de-AT의 de, zh-TW의 zh-hant, pt-PT의 pt-br, sw-KE의 system이 모두 `?locale`을 실음). Retry 뒤 문구(`play`가 아니고 `hero.h1`), 주소 문구 쪽(`2 / 3`이 아니고 `1 / 3`). `?locale`을 실어야 하는 링크 셋(ko-KR의 ja·en, sw-KE의 ko)과 쿼리 있는 `/translate` referrer에서 로더가 닫히는 줄은 부모에서도 통과하는 확인 시험이다                                        |

구현 커밋마다 그 시험이 통과했고, 첫 테스트 먼저 커밋은 구현 중에 한 번 고쳤다(처음에는 첫 화면의 로그인 복귀가
`/translate`이길 기대했으나, 날 쿼리 글을 싣지 않도록 보이는 언어와 문구로 만들기로 하고 부모에서 다시 돌려 같은 18줄 실패를
확인한 뒤 고친 시험을 커밋함).

## 사용자가 알아챌 변화

- 번역 페이지가 브라우저 언어(예: 한국어 브라우저는 한국어, 독일어(오스트리아)는 Deutsch, 대만 중국어는 繁體中文, 포르투갈
  포르투갈어는 Português (Brasil), 지원하지 않는 언어는 English)로 열린다. App 언어 창의 번역 참여는 App에서 보던 언어로 연다.
- 언어나 문구를 바꾸면 주소가 바뀌어 새로고침, 공유, Google 로그인 뒤에도 같은 언어와 문구로 돌아온다.
- 주소에 문구가 있으면 목록이 그 문구가 있는 쪽으로 열리고, 카탈로그를 못 불러와 Try again을 눌러도 같은 문구로 연다.
- 로그인을 취소하거나 실패하면 제출 버튼 아래에 한 줄이 보인다.
- 지금까지 포르투갈어로 쓴 로컬 초안은 그대로 있고, 언어를 Português (Brasil)로 바꾸면 다시 보인다(저장 키와 모양은 그대로).

## 바꾸지 않은 것과 통계에 안 잡히는 도착

- **통계에 안 잡히는 도착(후속 1, 개인정보 규칙 그대로).** 로더는 운영 호스트, 쿼리·조각 없음, referrer에 쿼리나 방 코드 경로
  없음일 때만 비컨을 붙이고, 이 규칙은 바꾸지 않았다. 세는 것: 쿼리 없는 `/translate`, 곧 App 언어가 브라우저 맞추기와 같을
  때의 App 언어 창 링크(시스템 언어를 쓰는 App과, 브라우저와 같은 언어를 고른 App), App 법적 고지 바닥글의 Translate 링크, 외부
  링크, 검색. 세지 않는 것: App 언어가 브라우저와 다를 때의 App 링크(`/translate?locale=…`), 로그인 복귀(`?locale=…&phrase=…`에
  Worker가 `accountAuth`를 붙임. 로더는 페이지가 주소를 고치기 전에 판단함), 방문자가 언어나 문구를 골라 주소에 쿼리가 생긴 뒤
  `/translate`에서 연 같은 출처 페이지(바닥글의 About, Privacy, Terms, FAQ, Developers, History, Design System.
  `Referrer-Policy: strict-origin-when-cross-origin`이라 같은 출처 referrer에 쿼리가 실려 그 페이지의 로더가 닫힘). 앞의 둘은
  (b) 로더가 `locale`을 허락하는 길로만 셀 수 있는데, 그것은 애널리틱스 개인정보 경계의 변경이라 오너가 고르지 않았다.
- **아포스트로피(후속 4).** 오류 문장 'Couldn’t sign in. Try again.'은 페이지의 기존 글('Couldn’t load translations.',
  'Couldn’t complete this action. Try again.')과 같은 둥근 따옴표(’)를 그대로 쓴다. 오너가 승인한 문장은 곧은 따옴표로 적혀
  있었다.
- **쪽은 주소 문구만 넘긴다(후속 3).** 주소에 문구가 없으면 기본 문구 `about:hero.h1`(운영 카탈로그 877개 중 814번째, 41쪽)을
  고른 채 목록 첫 쪽이 보이는 것은 그대로다. 로그인 복귀는 `phrase`를 싣기 때문에 그 문구의 쪽으로 열린다. 또 쪽을 넘겨도
  목록은 높이 320px의 자체 스크롤 영역이라(한 쪽 20줄 중 네 줄쯤 보임) 쪽 안의 다섯째 줄부터는 목록을 내려야 보인다(QA 라운드
  7: `player.volume`은 5쪽 17번째 줄, `hero.h1`은 41쪽 14번째 줄로 목록 스크롤 위치 0에서 가려짐). 오너가 정한 것은 쪽
  넘기기(순서 ÷ 쪽 크기)이고 목록 스크롤은 바꾸지 않았다.
- App 법적 고지 바닥글의 Translate 링크는 `/translate` 그대로다(브라우저 언어로 열림, 통계에 잡힘).
- 정적 페이지용 고전 런타임 `browser/classic-runtime/static-language.ts`(About 등)에는 자기 맞추기 함수가 따로 있다. 이 열차의
  공유 범위는 App과 번역 페이지이고 그것은 건드리지 않았다.
- Worker, 로그인 흐름, 제출 API, 관리자 화면, 카탈로그는 바꾸지 않았다.

## 섞인 버전과 되돌리기

### 섞인 버전

번역 페이지와 App 링크는 같은 정적 빌드로 나간다. 9.0.23 이하 App 탭의 언어 창 링크는 `/translate`라 9.0.24 페이지가 브라우저
언어로 열고, 9.0.24 App의 링크(`?locale`이 있든 없든)를 SW가 들고 있던 9.0.23 페이지가 받으면 쿼리를 무시하고 포르투갈어로
연다(지금과 같음). 통신 모양, API 요청·응답, 저장 데이터 모양, 저장 키, 계약 표지는 바뀌지 않았다.

### 되돌리기

기본은 더 높은 SemVer와 캐시 epoch의 코드 되돌리기(9.0.25 / v798 이상)다. App만 9.0.23으로 되돌리면 번역 페이지가 포르투갈어
고정과 로더 없음으로 돌아가고 다른 것은 같다. 9.0.23의 빌드 796은 저장 최소 빌드 789 이상이라 `lower`가 필요 없고, 순서와
바닥은 [릴리스 기록](../release-record.md) §4 머리의 현재 경계 줄을 따른다. 새 계약 표지와 forward floor가 없어 실패한 실행의
자동 복구(App을 checkpoint로)를 막지 않는다.

## 기록과 레지스트리

- 릴리스 기록 §2에 배포 전 항목을 더했다. §1, §4, `release-history.md`는 배포 기록 PR이 고친다.
- 자원 소유권 레지스트리, navigation-sinks, room-authority, lifecycle-writes 기준은 바꾸지 않았다(숫자는 QA 라운드 2와 6).
- 의존성, D1 스키마, 비밀, 바인딩, Wrangler 설정, CORS는 바뀌지 않았다.

## QA 라운드

모든 로컬 실행은 Windows, Node 24.22.2, npm 12.0.2, `vitest --maxWorkers=6`, Playwright Chromium이다. 로컬 결과는
exact-main-SHA 후보를 대신하지 않는다.

### 1. 테스트 먼저와 구현 (`5a5afb0e` 위, 2026-10-29 22:43 ~ 22:58 KST)

증분마다 시험을 먼저 커밋하고 부모에서 실패를 확인한 뒤 구현했다('테스트 먼저' 표). 구현마다 관련 파일(번역 커뮤니티 UI·클라이언트,
언어 맞추기, 설정, i18n 함수, 번역 링크, 애널리틱스, Worker 라우트)과 workshop·src·시험 typecheck, lint, dead-exports,
import-graph를 돌렸다.

### 2. 전체 검사 (`4b7f6c66`, 옮긴 뒤 `397c1cad`와 문서 밖 트리 같음, 2026-10-29 22:58 ~ 23:17 KST)

| 검사                                               | 결과                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security:audit`                                   | 0 vulnerabilities                                                                                                                                                                             |
| 전체 vitest                                        | 706 files / 16,765 tests 통과(318 s)                                                                                                                                                          |
| `typecheck`(모든 프로젝트), `lint`, `format:check` | 통과                                                                                                                                                                                          |
| `guard:dead-exports`                               | fully-dead 0, test-only 20(기준 20), self-only 76(기준 76)                                                                                                                                    |
| `guard:import-graph`                               | 401 files, 2,083 edges, SCC 0                                                                                                                                                                 |
| `guard:bus-pairing`                                | 203 / 203                                                                                                                                                                                     |
| `guard:lifecycle-writes`, `guard:transport-health` | 통과                                                                                                                                                                                          |
| `guard:navigation-sinks`                           | 통과(location 6, SKIP_WAITING 2, history traversal 2 그대로)                                                                                                                                  |
| `check-resource-ownership`                         | 49 records / 448 files, history entry write 12                                                                                                                                                |
| `guard:room-authority-boundaries`                  | 직접 읽기 79, 구독 22, 쓰기 13, PRO 0, 스냅샷 0                                                                                                                                               |
| `check:workers`                                    | 통과                                                                                                                                                                                          |
| 핵심 커버리지(`vitest.critical.config.ts`)         | 90 files / 3,515 tests 통과                                                                                                                                                                   |
| 릴리스 도구 커버리지(`vitest.tooling.config.ts`)   | 14 files / 433 tests 통과                                                                                                                                                                     |
| `build:checked`(버전 올리기 전)                    | `guard:sw-cache-version`에서 멈춤('committed PWA runtime changes are newer than v796'), 버전 올리기를 요구하는 기대한 실패                                                                    |
| `build:checked`(버전 올리기 `a85add79`)            | 통과. `guard:release-identity` 9.0.24 / v797, `guard:sw-cache-version` PASS v797, eager JS 456.6 KiB gzip, eager total 2,017.2 KiB raw / 534.1 KiB gzip, SW 앱 셸 94 자산(40 entry, 1 Worker) |
| Playwright `e2e/translation-retry.test.ts`         | 6 passed(Chromium, 기본 locale en-US라 영어로 열림)                                                                                                                                           |
| `test:e2e:critical`                                | 100 passed(4.8 분), 재시도 0                                                                                                                                                                  |

SW 앱 셸은 운영 9.0.23의 95에서 94다. 운영 `/service-worker.js`와 견주면 `locales` 청크 하나가 없어졌다: App과 번역 페이지가
함께 쓰는 `api` 청크에 `locales.ts`와 `language-match.ts`가 합쳐졌다(eager JS 456.6 KiB gzip은 9.0.23과 같음). 번역 페이지
스크립트는 `translate` 24.7 KB와 공유 `api` 12.8 KB(운영 23.1 KB와 8.1 KB)다.

### 3. 운영 빌드 브라우저 측정 (`4b7f6c66`의 `npm run build`, `vite preview --mode production`, 2026-10-29 23:11 KST)

Playwright Chromium, 1280×900, 맥락마다 `locale`과 `navigator.languages`를 정함. API는 로컬에 없어 계정 읽기가 실패한다(제출
버튼 'Retry sign-in').

| 열기                                    | 브라우저 언어 | 연 언어 | 요청한 카탈로그 | 고른 문구       | 결과                                                                   |
| --------------------------------------- | ------------- | ------- | --------------- | --------------- | ---------------------------------------------------------------------- |
| `/translate`                            | ko-KR, ko     | ko      | ko              | `hero.h1`       | 통과                                                                   |
| `/translate`                            | ja-JP, ja     | ja      | ja              | `hero.h1`       | 통과                                                                   |
| `/translate`                            | de-AT, de     | de      | de              | `hero.h1`       | 통과                                                                   |
| `/translate`                            | zh-TW, zh     | zh-hant | zh-hant         | `hero.h1`       | 통과                                                                   |
| `/translate`                            | pt-PT, pt     | pt-br   | pt-br           | `hero.h1`       | 통과                                                                   |
| `/translate`                            | sw-KE, sw     | en      | en              | `hero.h1`       | 통과                                                                   |
| `?locale=fr`                            | ko-KR         | fr      | fr              | `hero.h1`       | 통과                                                                   |
| `?locale=xx`                            | ko-KR         | ko      | ko              | `hero.h1`       | 통과(무시)                                                             |
| `?locale=%3Cimg%20src%3Dx%3E`           | ko-KR         | ko      | ko              | `hero.h1`       | 통과(무시, 그려지지 않음)                                              |
| `?locale=ja&phrase=app%3Aplayer.volume` | ko-KR         | ja      | ja              | `player.volume` | 통과                                                                   |
| `?locale=ja&phrase=app%3Anot.a.key`     | ko-KR         | ja      | ja              | `hero.h1`       | 통과                                                                   |
| `?…&accountAuth=cancelled`              | ko-KR         | ja      | ja              | `player.volume` | 'Sign-in was cancelled.', 주소 `?locale=ja&phrase=app%3Aplayer.volume` |
| `?…&accountAuth=error`                  | ko-KR         | ja      | ja              | `player.volume` | 'Couldn’t sign in. Try again.', 같은 주소                              |
| `?…&accountAuth=success`                | ko-KR         | ja      | ja              | `player.volume` | 글 없음, 같은 주소                                                     |

방문자 바꾸기: 한국어로 연 뒤 언어를 de로, 문구를 `player.volume`으로 고르면 주소가 `?locale=de&phrase=app%3Aplayer.volume`,
기록 길이 그대로, 로그인 링크가 `returnTo=/translate?locale=de&phrase=app%3Aplayer.volume`였다. 모든 열기에서 페이지 오류 0,
로더가 모듈 스크립트 앞, 비컨은 붙지 않음(로컬 호스트라 로더가 닫힘). 사진: 연 한국어와 繁體中文, 취소·실패 줄(작업 노트).

### 4. main 9.0.23 기록 위로 옮김, README, 버전 올리기 다시 (2026-10-29 23:18 ~ 23:20 KST)

main이 `d3a9b66a`(#527, 문서만)로 나아가 일곱 커밋을 옮겼다(patch-id 같음, 문서 밖 트리 같음). 옮긴 버전 올리기 `9c593600`에서
`build:checked`가 통과했다(`guard:sw-cache-version` PASS v797 (9c593600), 같은 예산과 셸). README의 문구 수가 낡아(728 → 803)
고쳤는데 README는 공개 workshop 경로라 SW 캐시 가드가 런타임 변경으로 세므로, 버전 올리기를 빼고 README 커밋 `6f916d9f` 뒤에
같은 일곱 줄로 다시 올렸다(`72f2015a`). `72f2015a`의 `build:checked`가 통과했다: `guard:release-identity` 'MUSIXQUARE 9.0.24;
service-worker cache epoch v797', `guard:sw-cache-version` 'PASS: v797 (72f2015a) covers all committed PWA runtime changes.',
`guard:legacy-tv-build` 통과, eager JS 456.6 KiB gzip, eager total 2,017.2 KiB raw / 534.1 KiB gzip, SW 앱 셸 94 자산.
`scripts/release-deployment-state.mts`의 `changedRuntimePaths`로 `d3a9b66a..72f2015a`를 보면 App 14, PRO 방·signaling·
remote-share·Developer API facade·Developer API 0, `changedAppRuntimeDependencies` 빈 목록이라 target `app`이다. README 커밋은
문서 글만 바꿔 라운드 2의 시험과 측정 결과에 영향이 없다.

### 5. 오너 후속 결정 1 ~ 3: 테스트 먼저, 구현, 버전 올리기 다시 (`6f916d9f` 위, 2026-10-29 23:36 ~ 23:43 KST)

버전 올리기 `72f2015a`와 문서 커밋 `26bbc2b9`를 브랜치에서 빼고(내용은 보관) `6f916d9f` 위에 시험만의 커밋 `d7dad4fa`를 올렸다.
부모 `6f916d9f`에서 세 파일(번역 커뮤니티 UI, 설정, 애널리틱스)이 9 실패 / 148 통과였다('테스트 먼저' 표). 구현 `08e96c1a` 뒤
관련 다섯 파일(위 셋과 언어 맞추기, 번역 링크)이 186 통과, `tsc --noEmit`, `guard:import-graph`(401 files, 2,084 edges, SCC 0,
`settings.ts` → `language-match.ts` 한 줄 더함), `guard:dead-exports` 통과였다. 그 뒤 `72f2015a`를 다시 얹고(`git cherry-pick`,
diff 줄 같음) 메시지만 후속에 맞춰 `5b029d22`로 만들었다. `scripts/release-deployment-state.mts`로 `d3a9b66a..5b029d22`를 보면
App 14(목록 그대로), 나머지 다섯 Worker 0, `changedAppRuntimeDependencies` 빈 목록이다.

### 6. 전체 검사 다시 (`5b029d22`, 2026-10-29 23:43 ~ 10-30 00:00 KST)

버전 올리기 트리(마지막 런타임 커밋)에서 돌렸다. E2E는 측정(라운드 7) 뒤 `build:e2e`로 다시 빌드해 돌렸다.

| 검사                                               | 결과                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security:audit`                                   | 0 vulnerabilities                                                                                                                                                                                                                                                                                                                                                                                                       |
| 전체 vitest(버전 올리기 트리)                      | 706 files / 16,777 tests 통과(346 s). 라운드 2보다 12 많음: 설정 9(흐름 시험 하나를 고치고 표 아홉 더함), 번역 커뮤니티 UI 2, 애널리틱스 1                                                                                                                                                                                                                                                                              |
| `typecheck`(모든 프로젝트), `lint`, `format:check` | 통과                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `guard:dead-exports`                               | fully-dead 0, test-only 20(기준 20), self-only 76(기준 76)                                                                                                                                                                                                                                                                                                                                                              |
| `guard:import-graph`                               | 401 files, 2,084 edges, SCC 0                                                                                                                                                                                                                                                                                                                                                                                           |
| `guard:bus-pairing`                                | 203 / 203                                                                                                                                                                                                                                                                                                                                                                                                               |
| `guard:lifecycle-writes`, `guard:transport-health` | 통과                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `guard:navigation-sinks`                           | 통과(location 6, SKIP_WAITING 2, history traversal 2 그대로)                                                                                                                                                                                                                                                                                                                                                            |
| `check-resource-ownership`                         | 49 records / 448 files, history entry write 12                                                                                                                                                                                                                                                                                                                                                                          |
| `guard:room-authority-boundaries`                  | 직접 읽기 79, 구독 22, 쓰기 13, PRO 0, 스냅샷 0                                                                                                                                                                                                                                                                                                                                                                         |
| `check:workers`                                    | 통과                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 핵심 커버리지(`vitest.critical.config.ts`)         | 90 files / 3,515 tests 통과                                                                                                                                                                                                                                                                                                                                                                                             |
| 릴리스 도구 커버리지(`vitest.tooling.config.ts`)   | 14 files / 433 tests 통과                                                                                                                                                                                                                                                                                                                                                                                               |
| `build:checked`                                    | 통과. `guard:release-identity` 'MUSIXQUARE 9.0.24; service-worker cache epoch v797', `guard:sw-cache-version` 'PASS: v797 (5b029d22) covers all committed PWA runtime changes.', `guard:legacy-tv-build` 통과, entry 842.1 KiB raw / 247.9 KiB gzip, eager JS 456.6 KiB gzip, eager total 2,017.2 KiB raw / 534.1 KiB gzip, SW 앱 셸 94 자산(40 entry, 1 Worker). 번역 페이지 `translate` 24.77 KB, 공유 `api` 12.81 KB |
| Playwright `e2e/translation-retry.test.ts`         | 6 passed(9.3 s, Chromium, `build:e2e` 산출물, 10-30 00:06 KST)                                                                                                                                                                                                                                                                                                                                                          |
| `test:e2e:critical`                                | 100 passed(5.0 분, 10-30 00:01 ~ 00:06 KST), 재시도 0                                                                                                                                                                                                                                                                                                                                                                   |

`settings.ts`가 `language-match.ts`를 직접 가져와도 그 모듈은 이미 eager `api` 청크에 있어 예산 숫자는 라운드 4와 같다.

### 7. 운영 빌드 측정 다시 (`5b029d22`의 `build:checked` 산출물, `vite preview --mode production`, 2026-10-30 00:00 KST)

Playwright Chromium, 1280×900, 맥락마다 `locale` ko-KR과 `navigator.languages`(ko-KR, ko)를 정함. App 언어는 시작 전
`musixquare-lang`에 넣었다(시스템 줄은 넣지 않음). App 줄은 시작 화면의 언어 버튼으로 언어 창을 열어 번역 참여 링크를 읽고 그
링크를 눌러 새 창을 열었다.

| 열기                    | App 언어               | 링크 `href`            | 새 창 주소·referrer         | 연 언어(카탈로그 요청) | 결과 |
| ----------------------- | ---------------------- | ---------------------- | --------------------------- | ---------------------- | ---- |
| App 언어 창 → 번역 참여 | ko(창 글 '번역 참여')  | `/translate`           | 쿼리 없음, referrer 없음    | ko(ko)                 | 통과 |
| App 언어 창 → 번역 참여 | 시스템(ko로 풀림)      | `/translate`           | 쿼리 없음, referrer 없음    | ko(ko)                 | 통과 |
| App 언어 창 → 번역 참여 | ja(창 글 '翻訳に協力') | `/translate?locale=ja` | `?locale=ja`, referrer 없음 | ja(ja)                 | 통과 |

| 열기                                       | 조건                                                                          | 고른 문구          | 목록 쪽 | `aria-current` 줄      | 결과                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ------------------ | ------- | ---------------------- | --------------------------------------- |
| `?locale=ja&phrase=app%3Aplayer.volume`    | 첫 카탈로그 응답 503 → 'Couldn’t load translations.', 편집기 숨김 → Try again | `player.volume`    | 5 / 44  | `app:player.volume`    | 통과(카탈로그 요청 ja, ja, 주소 그대로) |
| `?locale=ja&phrase=app%3Aplayer.volume`    | 보통                                                                          | `player.volume`    | 5 / 44  | `app:player.volume`    | 통과                                    |
| `?locale=ko&phrase=about%3Ahero.h1`        | 로그인 복귀와 같은 꼴                                                         | `hero.h1`          | 41 / 44 | `about:hero.h1`        | 통과                                    |
| `?locale=ko&phrase=app%3Aapp.search_title` | 첫 쪽 문구                                                                    | `app.search_title` | 1 / 44  | `app:app.search_title` | 통과                                    |
| `?locale=ko&phrase=app%3Anot.a.key`        | 없는 문구                                                                     | `hero.h1`          | 1 / 44  | 없음(첫 쪽에 없음)     | 통과                                    |
| `?locale=ko`                               | 문구 없음                                                                     | `hero.h1`          | 1 / 44  | 없음(첫 쪽에 없음)     | 통과                                    |

모든 열기에서 App과 페이지 오류 0이다. 목록 안에서의 위치도 쟀다: 목록은 높이 318px(스크롤 높이 약 1,520px)의 자체 스크롤
영역이고 스크롤 위치 0이라, 5쪽 17번째 줄 `player.volume`과 41쪽 14번째 줄 `hero.h1`은 쪽은 맞지만 목록을 내려야 보이고, 1쪽
2번째 줄은 보인다('바꾸지 않은 것과 통계에 안 잡히는 도착'). 사진: 한국어 App 언어 창, 링크로 연 한국어 페이지, Retry 뒤 화면,
5쪽 목록(작업 노트).

### 8. PR CI, 자동 리뷰, exact-main CI, 릴리스 (자리)

아직이다.

## 확인하지 않은 것

- 운영에서 실제 제안 제출(이 열차는 로그인하지 않았고, 로컬에는 계정·제안 API가 없음).
- Google OAuth 동의 화면의 게시 상태(테스트 모드면 시험 사용자만 로그인할 수 있어 입구에서 사람을 더 잃을 수 있음). 이 저장소와
  공개 응답으로는 알 수 없다.
- 배포 뒤 Cloudflare Web Analytics에 `/translate` 방문이 실제로 잡히는지(App 링크로 온 쿼리 없는 방문 포함. 로컬 측정은
  로컬 호스트라 로더가 닫혀 비컨을 볼 수 없고, 새 창의 주소와 referrer가 비었음만 확인함).
- 실제 Google 취소·실패 왕복(시험과 측정은 Worker가 붙이는 표지를 주소에 넣어 봄).
- Safari·WebKit·Firefox, 휴대폰, 화면 낭독기가 상태 줄을 읽는지, 운영 브라우저의 업데이트 창.
- PR CI, 자동 코드 리뷰, exact-main CI, 배포.
