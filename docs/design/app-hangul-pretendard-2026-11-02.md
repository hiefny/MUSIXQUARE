# 앱 한글을 다시 Pretendard로 (2026-11-02)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 구현과 로컬 QA 끝, 배포 전. 브랜치 `agent/hangul-pretendard`(main `7d60f134` 위). 커밋(§5): `16dc2716`, `ec1b7aa8`, `9864386f`, `21f4b84b`, `3ad033c0`, 그리고 이 보고서 커밋. 버전 올리기, 릴리스 기록, PR, 머지, exact-main CI, 배포는 아직이다(§10). 로컬과 브랜치 결과는 exact-main-SHA 후보를 대신하지 않는다                                                                                                                                       |
| Base               | main `7d60f134`(#558, App 9.0.32 / v805 배포 기록)                                                                                                                                                                                                                                                                                                                                                                                                       |
| Version            | 예정 9.0.33 / v806(App 빌드 806). 이 브랜치에는 아직 버전 올리기가 없어 `guard:sw-cache-version`만 실패한다(§6). 조립 때 마지막 런타임 커밋으로 버전과 SW 캐시 epoch를 함께 올린다                                                                                                                                                                                                                                                                       |
| Scope              | 앱만: 새 한글 글꼴 파일 87개(`fonts/app/hangul/`)와 그 기록 `fonts/hangul-faces.json`, 새 시트 `css/fonts/app/font-hangul.css`, KR·JP·SC·TC 시트의 범위, 구운 KR 사본 67개 삭제와 `fonts/app-faces.json`, `css/style.css`의 글꼴 스택, `src/i18n/`의 글꼴 계약·로더·미리 받기 표·`font-metrics.ts`, 생성기·가드·시험·문서. 공개 페이지(블로그, History, 디자인 시스템, 소개와 그 형제 페이지, `account-complete.html`)와 공유 그림(OG)은 그대로다(§7 12) |
| Deploy target      | `app`(업데이트 창이 뜨는 배포). 바뀐 런타임 경로는 App의 정적 자산과 CSS, `src/i18n`뿐이고 다른 Worker는 없다. 릴리스 판정은 조립 뒤 다시 한다                                                                                                                                                                                                                                                                                                           |
| Operations         | 없음. GitHub 쓰기, push, 운영 요청, 내려받기 없이 로컬에서만 만들고 시험했다                                                                                                                                                                                                                                                                                                                                                                             |
| Resource ownership | 복구, 재시도, 시한, 수명 흐름을 더하지 않았다(생성기, 가드, 정적 파일, CSS, 이미 있는 로더에 시트 하나). 등록부 기록이 필요 없다                                                                                                                                                                                                                                                                                                                         |
| Third-party assets | 새 내려받기 없음. 새 파일은 저장소에 2026-02-23부터 있던 `fonts/PretendardVariable.woff2`(Pretendard Variable 1.309, 길형진, SIL OFL 1.1, Reserved Font Name Pretendard)의 부분 집합이다. Reserved Font Name 때문에 이름을 MUSIXQUARE Hangul로 바꿨고, 저작권과 라이선스 이름 기록은 원본 그대로다(§2.3)                                                                                                                                                 |
| Release record     | 이 브랜치에서는 고치지 않았다. 조립 때 §2 맨 위에 이 열차 절과 §4 되돌리기 항목을 더한다(§10)                                                                                                                                                                                                                                                                                                                                                            |

9.0.29부터 앱은 한글을 Noto Sans KR로 그렸다([보고서](app-font-inter-noto-2026-10-31.md)). 이 열차는 한글만 다시 Pretendard로
그린다. 라틴 글자와 숫자는 Inter, 한자·가나·중국어와 Pretendard에 없는 한글은 Noto 그대로다. 줄 상자, 라틴과 한자의 크기, 탭
제목 자리는 9.0.32와 같다(§4).

## 1. 오너 결정 (2026-11-02 08:10 KST쯤)

- 앱의 한글을 다시 Pretendard로 그린다. 이유: Pretendard 한글의 글자 사이 간격이 더 낫고, 굵기 500·600·700의 차이도 Noto Sans
  KR보다 더 벌어진다.
- 그림 비교 없이 바로 구현하고 배포한다. 9.0.29 전까지 Pretendard가 앱을 그렸으니 오너가 이미 그 모양을 안다.
- 한국어와 영어 화면은 같은 내용을 같게 그린다(오너 규칙, 9.0.29부터). 그래서 Pretendard 한글은 모든 UI 언어의 모든 글꼴 스택에
  들어간다.

[화면 바뀜] 모든 한글 글자의 모양이 Pretendard로 바뀐다. 줄 높이, 라틴과 한자의 크기, 탭 제목 자리는 그대로다. 전후 화면
그림(휴대폰 402 × 874와 데스크톱 1440 × 900, 시작 화면, 한글 제목이 든 재생목록, 채팅, 설정, 탭 머리, 그리고 영어 화면의 같은
재생목록)은 오너에게 따로 전했고 저장소에는 넣지 않았다.

## 2. 무엇을 바꿨나

### 2.1 계획 단계에서 정한 것

- **D0, 굵기 범위.** 저장소 파일의 `fvar`는 wght 45-930(기본 400)이다. 공개 페이지의 `css/pretendard.css`가 적는 45 920은 원작자
  CSS의 값이다. 생성기는 파일의 `fvar`를 읽어 `font-weight: 45 930`을 적는다. 앱은 400·500·600·700만 그리고 `bolder`도 900까지라
  굵기를 흉내 내는 일이 없다.
- **D1, 이름.** Pretendard는 Reserved Font Name이고, 부분 집합은 OFL이 말하는 Modified Version이다(조건 3: 주 이름으로 RFN을 쓰면
  안 됨). 그래서 남긴 이름 기록에서 "Pretendard Variable"을 "MUSIXQUARE Hangul"로, "PretendardVariable"을 "MUSIXQUAREHangul"로
  바꿨다(ID 1, 3, 4, 6과 축·인스턴스 이름 256-273). 저작권(ID 0, 영어와 한국어), 라이선스 설명(13), 라이선스 URL(14)은 원본
  기록 그대로다. 그래서 "앱의 스타일시트와 `src`는 Pretendard를 이름으로 부르지 않는다"는 가드와, 요청 주소에 `pretendard`가
  없어야 한다는 e2e 확인이 그대로 의미가 있다. 원작자의 서면 허락이 있으면 이름을 되살릴 수 있다(§9 1).
- **D2, 무엇을 가져가나.** 파일이 그리는 한글 전부, 블록이나 Unicode Script로: 음절 AC00-D7A3(11,172), 호환 자모 3131-3164와
  318D, ㈜(321C), 반각 자모(FFA1-FFDC 중 51자). 모두 11,277자다. 파일에는 첫가끝 자모(1100-11FF, 확장 A·B), 옛 호환 자모
  (3165-318C, 318E), ㈜ 말고 괄호·원 한글이 없어, 그 98자(U+3165-318C, U+318E, U+3200-321B, U+3260-327B, U+327E)는 Noto Sans
  KR에 남는다.
- **D3, 조각 번호.** Noto Sans KR v40의 번호 조각을 그대로 따른다: 조각 N은 KR #N이 선언하는 한글이다(#2-#65, #94, #95,
  #100-#119, 86개). 어느 KR 조각도 선언하지 않는 반각 자모는 #0에 둔다(가장 드문 번호). 모두 87개다. Google이 빈도로 묶은 조각을
  그대로 쓰므로 자주 쓰는 음절이 한 파일에 모인다.

### 2.2 원본 파일

- `fonts/PretendardVariable.woff2`: 2,057,688 B, sha256 `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4`.
  `public/designsystem/fonts/PretendardVariable.woff2`와 같은 바이트이고, `e337f99c`(2026-02-23)부터 저장소에 있다.
- 이름 ID 5 "Version 1.309;Glyphs 3.2 (3225)"(Pretendard 1.3.9), ID 0 "Copyright © 2023 Kil Hyung-jin"(영어)과 "… 길형진"(한국어).
- 2048 units/em. `hhea`와 OS/2 typo가 1950 / 494 / 0이고 `USE_TYPO_METRICS`가 켜져 있으며 win은 1950 / 494다. MVAR와 HVAR가 없다.
  이 값이 9.0.29부터 모든 앱 면의 기준인 줄 상자이고, 이제 `src/i18n/font-metrics.ts`의 `HANGUL_LINE_BOX`다(Inter와 CJK의 기술자와
  구운 값은 여기서 계산한다. 값은 그대로).
- 한글 글자 폭은 1770 / 2048 = 0.8643 em이다. 9.0.32의 Noto KR 한글은 920 / 1000 × 0.94 = 0.8648 em이라, 한국어 줄 길이가 0.06%
  줄어든다(15px로 30음절 줄에서 약 0.24px).
- 한글에 닿는 GSUB·GPOS 조회가 없다. 그래서 조각에는 레이아웃 기능이 하나도 남지 않고(`locl`도 없음), `html lang`이 한글 모양을
  바꿀 수 없다.

### 2.3 생성기와 기록

`scripts/fonts/build-hangul-faces.mts`(`npm run generate:hangul-faces`, `--record`, `--check`)가 조각마다:

1. KR #N의 Google `unicode-range` ∩ 원본 cmap ∩ 한글(블록이나 Script)을 고른다. 남는 것은 #0.
2. subset-font(harfbuzzjs)로 원본을 그 글자만 남겨 자른다. `wght` 축 전체를 남기고, 이름 ID 0-6, 13, 14, 256-273을 남긴다.
3. 이름 표를 다시 쓴다(`scripts/fonts/sfnt-names.mts`, 새 도우미): 남긴 기록의 RFN을 바꾸고, ID 0·13·14는 원본의 모든 언어
   기록으로 바꾼다(subsetter는 영어만 남김). 표는 태그 순서, 4바이트 정렬, 표 체크섬과 `head.checkSumAdjustment`를 다시 계산한다.
4. wawoff2로 WOFF2를 만들고 다시 푼다.
5. 하나라도 어긋나면 아무것도 쓰지 않는다: glyf·loca(WOFF2 변환이 글리프마다 4바이트로 다시 깔아 바이트가 바뀜)와
   checkSumAdjustment 말고 모든 표가 같음, 푼 것을 다시 인코딩하면 같은 WOFF2 바이트, cmap이 조각의 글자와 같고 한글만,
   **모든 글자의 윤곽과 폭이 기본 인스턴스와 wght 400·500·600·700에서 원본과 같음**, 줄 상자 1950 / 494 / 0(`hhea`와 typo,
   `USE_TYPO_METRICS`), win 1950 / 494, MVAR 없음, `fvar` wght 45-930, 레이아웃 기능 없음, 체크섬 맞음, 어떤 이름 기록에도
   Pretendard 없음, ID 1이 MUSIXQUARE Hangul, ID 0·13·14가 원본과 같음.
6. 기본 방식은 기록과 원본, 도구 버전, 커밋된 파일이 맞는 조각을 건너뛴다(0.2초). 같은 원본과 글자로 다시 자른 조각이 기록과 다른
   바이트를 내면(도구가 바뀌었든 아니든) 아무것도 쓰지 않고 멈추며, `--record`만 받아들인다. `--check`는 87개를 메모리에서 다시
   자르고 비교한다(18 ~ 24초).

`fonts/hangul-faces.json`이 원본(파일, 버전 "1.309 (name ID 5)", sha256, 크기, 라이선스, wght [45, 930]), 도구(subset-font
2.9.0, harfbuzzjs 1.6.3, fontverter 2.0.0, wawoff2 2.0.1), 나누기 규칙, 이름, 줄 상자, 조각마다 번호·파일·글자·digest를 적는다.
`verifyHangulFaces`(`scripts/fonts/font-files.mts`)가 다시 자르지 않고 그 기록을 검사하고, `guard:font-assets`와
`generate:font-sheets -- --check`가 그것을 부른다. `verifyAppFaces`는 `fonts/app/hangul/`을 그 검사에 맡긴다.
`package.json`의 subset-font는 `^2.9.0`이지만 lockfile이 2.9.0에 고정한다.

결과: 87개, 11,277자, 2,506,376 B. #2-#64는 25,612 ~ 41,664 B, #65 6,256 B, #94 4,364 B, #95 1,484 B, #100-#118은 11,796 ~
22,836 B, #119 3,368 B(가고기다로리사스시이인지하), #0 7,088 B.

### 2.4 시트, 스택, 불러오기

- 시트: `css/fonts/app/font-hangul.css`(87면). 각 면은 `font-family: 'MUSIXQUARE Hangul'`, `font-weight: 45 930`, `font-display:
swap`, 파일 하나, `unicode-range`는 그 면의 cmap이고, `size-adjust`와 덮어쓰기 셋이 없다(파일 자체가 줄 상자를 지님).
- 범위 정리(`scripts/fonts/build-font-sheets.mts`): Noto Sans KR은 MUSIXQUARE Hangul이 그리는 한글을 내놓고 98자만 남긴다. 한글만
  들어 있던 KR 조각 67개가 시트에서 빠져 120면이 53면이 되고, 그 구운 사본 67개(1,417,048 B)도 지웠다. JP·SC·TC는 두 가족이 그리는
  한글을 모두 내놓는다(JP #2·#3은 반각 자모 51자, TC #6은 U+FFB9를 잃음, SC는 범위가 같음).
- 스택(`css/style.css`): `--font-hangul: 'MUSIXQUARE Hangul'`을 `--font-sans-ui`, `--font-sans-ja`, `--font-sans-cjk-sc`,
  `--font-sans-cjk-tc`의 Inter 바로 뒤에 넣었다. 그래서 모든 UI, 모든 한자 순서에서 Inter, MUSIXQUARE Hangul, CJK 넷, 글자별
  Noto, 시스템 글꼴 순이다. 인도·아랍·히브리 UI는 자기 글자 면이 맨 앞이고 그 뒤가 같다. 한국어와 영어 화면은 계속 한 스택이다.
- 불러오기(`src/i18n/locale-fonts.ts`, `app-font-contract.ts`): 시트가 17개가 됐다. 한국어 UI의 자기 글자 시트가
  `font-hangul`이고, 일본어·중국어가 아닌 모든 UI의 phase A가 Inter, MUSIXQUARE Hangul, Noto Sans KR(Inter에 없는 ※ → 같은 기호와
  한자)을 선언한다. 한국어와 영어 화면은 같은 시트를 같은 순서로 선언한다. 한국어 미리 받기(phase C)는 MUSIXQUARE Hangul
  #119-#100, 20면, 360,288 B다(9.0.32는 Noto Sans KR #119-#100, 393,260 B).
- 가드(`scripts/check-app-font.mts`): 한글 면은 기술자가 없어야 하고, 모든 스택이 Inter, MUSIXQUARE Hangul, CJK 순이어야 하며
  (`stackOrderProblems`, `scripts/lib/app-font-guard.mts`), MUSIXQUARE Hangul이 그리는 한글은 그 가족에서만, 나머지 한글은 Noto
  Sans KR에서만 와야 하고, 빌드의 한글 면은 `fonts/app/hangul/`과 같은 바이트여야 한다. 커버리지 목록(빈칸 1270개)은 그대로다.
- 미리 받기 표, 줄 상자 기준(`HANGUL_LINE_BOX`), 문서(`fonts/README.md`)를 같은 증분에서 바꿨다.

## 3. 바뀌어 보이는 것 [화면 바뀜]

- 모든 한글 글자가 Pretendard 모양이 된다. 음절 폭은 0.06% 좁아진다.
- 줄 상자: Pretendard 파일 자체가 9.0.29부터의 기준 상자라, Chromium과 Firefox에서는 0.5px 단위 크기 8 ~ 48px 모두 9.0.32의 한글
  상자와 같다(계획 단계 모델. 0.01px 단위로는 19.43px과 20.48px만 1px 다름).
- Safari 17 이후: 한글 면에 무시할 덮어쓰기가 없으니 Chromium과 같은 상자를 그린다. 9.0.32의 구운 Noto와 비교하면 한글만 있는 줄은
  0.5px 단위 크기 가운데 14.5px과 43.5px에서만 바뀐다(14.5px 18 → 17, 계획 단계 모델. 14.5px은 §4.1에서 쟀다). 9.0.31 보고서 §3이 적은 14.5px 한글 1px 예외가 사라진다.
- Safari 15·16(`size-adjust`를 모름): 한글 줄이 구운 Noto의 1.27 em에서 출시 상자 1.193 em으로 온다(15px 줄 19 → 18).
- 한자와 가나는 9.0.31의 구운 Noto 그대로다. 한 줄에 Pretendard 한글과 Noto 한자가 함께 있으면: Pretendard '한'의 잉크는 위 0.788 em,
  높이 0.849 em, 94%의 Noto 한자 '漢'은 0.785 / 0.853, 9.0.32의 94% Noto KR '가'는 0.767 / 0.830이었다(계획 단계 측정). 한글이 9.0.32보다
  한자 크기에 더 가까워진다.

## 4. 측정

### 4.1 줄 상자

`e2e/font-line-boxes.test.ts`(Chromium, 한국어 화면, 390 × 844 @2x, 어두운 테마). 높이 | 기준선(px), 굵기 400과 700 같음.

| 줄                                     | 13px     | 14.5px   | 15px     | 28px     | 그리는 면                   |
| -------------------------------------- | -------- | -------- | -------- | -------- | --------------------------- |
| 출시 그대로, 모든 글자                 | 15 \| 12 | 17 \| 14 | 18 \| 14 | 34 \| 27 | -                           |
| 덮어쓰기 뺌(Safari 모델), 라틴         | 15 \| 12 | 17 \| 14 | 18 \| 14 | 34 \| 27 | Inter                       |
| 덮어쓰기 뺌, 한글과 섞인 줄            | 15 \| 12 | 17 \| 14 | 18 \| 14 | 34 \| 27 | Inter, MUSIXQUARE Hangul    |
| 덮어쓰기 뺌, 가나 / 한자               | 15 \| 12 | 18 \| 14 | 18 \| 14 | 34 \| 27 | Noto Sans JP / Noto Sans KR |
| 부모 9.0.32, 덮어쓰기 뺌, 한글·섞인 줄 | 15 \| 12 | 18 \| 14 | 18 \| 14 | 34 \| 27 | Inter, Noto Sans KR         |

- 출시 시트는 14.5px에서도 모든 글자가 17 | 14다(부모도 같음). 덮어쓰기를 빼면 가나와 한자만 구운 Noto의 내림(4px)으로 18이 되고(9.0.31의
  기록된 예외 그대로), 한글은 이제 17이다. 마지막 행은 이 시험을 부모 빌드에서 돌린 결과다(§5.1).
- 한글 시트는 두 맥락 모두에서 덮어쓰기와 `size-adjust` 없이 도착한다(시험이 확인). 그래서 Safari가 읽는 것과 Chromium이 따르는 것이
  같다.
- WebKit(Playwright의 WebKit, Windows, 한 면만 둔 쪽): MUSIXQUARE Hangul `#119`는 13 / 14.5 / 15 / 28px에서 15 | 12, 17 | 14,
  18 | 14, 34 | 27. 9.0.32의 구운 KR `#119`를 94%로 덮어쓰기 없이 두면 15 | 12, **18 | 14**, 18 | 14, 34 | 27. Chromium도 같은 숫자다.
- 표 검사: 87개 면 모두 `hhea`와 typo가 1950 / 494 / 0, `USE_TYPO_METRICS`, win 1950 / 494(CoreText는 `hhea`, DirectWrite는 typo를
  읽고 둘이 같음, `hangul-faces.test.ts`).

### 4.2 탭 제목

`e2e/tab-header-title-alignment.test.ts`(휴대폰 402 × 874, 데스크톱 1440 × 900, 재생목록 여럿·두 번째·하나). 머리 위에서 기준선까지(px):

| 화면                             | 9.0.32 휴대폰 / 데스크톱 | 이 열차 휴대폰 / 데스크톱 |
| -------------------------------- | ------------------------ | ------------------------- |
| 한국어, 영어, 일본어             | 60 / 58                  | 60 / 58                   |
| 간체 중국어                      | 재지 않음                | 60 / 58                   |
| 아랍어, 태국어, 힌디어, 칸나다어 | 재지 않음                | 70, 62, 59, 59 / 58       |
| 더 큰 줄(시험이 만듦), 한국어    | 65 / 60                  | 66 / 60                   |
| 더 큰 줄, 일본어                 | 65 / 60                  | 65 / 60                   |

- 실제 화면(위 세 행)은 9.0.32에서 잰 언어(한국어, 영어, 일본어)가 9.0.32와 같고, 모든 언어에서 모든 탭 제목이 한 기준선이다.
- '더 큰 줄'은 시험이 모든 면에 `ascent-override: 120%`, `descent-override: 30%`를 씌워 36px 행보다 큰 제목 줄을 만드는 경우다.
  덮어쓰기 값은 `size-adjust`로 곱해지므로, 94%였던 Noto KR 대신 100%인 MUSIXQUARE Hangul에 씌우면 한국어 제목 줄이 그만큼
  더 커져 기준선이 1px 내려간다. 실제 글꼴 값이 아니고, 시험의 주장(모든 탭 제목이 한 기준선)은 그대로 통과한다.
- `font-line-boxes`의 탭 제목 시험도 덮어쓰기를 빼든 안 빼든 네 탭 제목이 같은 자리, 한 기준선이다(390 × 844).

### 4.3 한국어와 영어 화면이 같게 그림

- `e2e/font-identity.test.ts`: 한국어 우선과 일본어 우선 브라우저 각각에서 새 한국어 화면과 새 영어 화면이 채팅 고정 글(한국어, 일본어,
  중국어, 한자, 러시아어·그리스어, 태국어, 아랍어, ※ ― ‥ ‰ ‼ ⁉, 화살표와 기호, ㈜ ㉠, 줄바꿈, 이모지)과 NFD 파일 이름 트랙을
  같은 면, 같은 폭, 같은 픽셀로 그린다. CDP가 보고한 면: 한글은 MUSIXQUARE Hangul(기록에 있는 글자), ㉠은 Noto Sans KR, 라틴은
  Inter, 가나는 Noto Sans JP.
- 단위 시험과 가드: 모든 UI, 모든 한자 순서에서 스택이 하나이고 한국어와 영어가 같으며(`font-stack-identity`), 한국어와 영어 화면이
  같은 phase A 시트를 같은 순서로 선언하고(`locale-fonts`), 한글 면에 레이아웃 기능이 없다(`hangul-faces`).

### 4.4 내려받는 바이트

`font-identity`의 요청 기록(서비스 워커 막음, 한국어 우선 브라우저):

| 항목                                                          | 9.0.32                     | 이 열차                    |
| ------------------------------------------------------------- | -------------------------- | -------------------------- |
| 영어 시작 화면 글꼴                                           | 1개, 72,844 B              | 1개, 72,844 B              |
| 한국어 시작 화면 글꼴                                         | 12개, 249,124 B            | 12개, 289,888 B(+16.4%)    |
| 한국어 phase C 미리 받기                                      | 9개, 216,980 B             | 9개, 143,244 B             |
| 한국어 phase C까지 합계                                       | 466,104 B                  | 433,132 B(−7.1%)           |
| 한국어·영어 화면에서 받은 Noto Sans KR 조각(시작과 미리 받기) | 한국어 20개                | 0개                        |
| 시트 전송 `font-hangul` / `font-noto-kr`                      | - / 23,658 B               | 10,649 / 13,138 B          |
| 시트 전송 JP / SC / TC                                        | 31,398 / 29,824 / 28,775 B | 31,371 / 29,824 / 28,772 B |

- 한국어 시작 화면이 더 무거운 까닭은 Pretendard 변수 윤곽이 같은 글자에서 Noto KR보다 약 1.5배 크기 때문이다(굵기 축 전체를
  남겼다. §9 2). 미리 받기까지는 한글 조각에 한자와 기호가 없어 오히려 가볍다.
- 첫 화면 예산(`guard:initial-transfer-budget`, 운영 빌드): 진입 JS 861,056 B 그대로 / gzip 253,682 B(−1), 즉시 JS gzip
  465,413 B(+10, 해시 이름), 즉시 전체 2,049,037 B(+114) / gzip 543,693 B(+43, 주로 `--font-hangul`과 `var()` 넷), 즉시 글꼴 0.
- 빌드 시트(raw): `font-hangul` 37,423 B(gzip 10,612) 새로, KR 88,272 → 45,761 B, JP 107,208 → 107,141 B, SC 98,939 B 그대로,
  TC 97,351 → 97,344 B, Inter 2,325 B 그대로. `locale-fonts` 덩이 14,423 → 14,637 B(게으름, 서비스 워커가 설치).
- dist: WOFF2 787개 34,602,000 B → 807개 35,691,328 B(+20개, +1,089,328 B: 한글 87개 2,506,376 B 더하고 KR 67개 1,417,048 B
  뺌). 전체 1,253개 67,826,248 B → 1,274개 68,910,742 B.
- 저장소: `fonts/app/hangul` +2,506,376 B, `fonts/app/noto-sans-kr` −1,417,048 B, `fonts/app-faces.json` 184,008 → 156,808 B,
  `fonts/hangul-faces.json` 43,899 B 새로. 원본 시트: `font-hangul.css` 44,113 B 새로, KR 102,804 → 53,631 B.
- 한국어 카탈로그 전체 글자를 그리는 데 드는 파일(계획 단계 모의): 18개 385,556 B → 19개 424,296 B. 영어 카탈로그와
  `index.html`은 그대로.
- 남는 KR 53면은 2,007,988 B이고 그 파일들 안에는 이제 쓰지 않는 한글 글리프가 남아 있다(한자가 섞인 한국어 글에서 받는 바이트.
  §7 9).

## 5. 증분과 커밋 (테스트 먼저)

| #   | 증분                                                                                                                | 커밋       | 부모 `7d60f134`에서 실패한 것                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| C1  | `sfnt-names.mts`: 이름 표 읽기, 바꾸기, 다시 쓰기와 그 시험                                                         | `16dc2716` | `sfnt-names.test.ts` 전체(모듈 없음)                                                                                  |
| C2  | 한글 면 생성기, 기록, 87개 파일, `HANGUL_LINE_BOX`, `verifyHangulFaces`(가드), `hangul-faces.test.ts`               | `ec1b7aa8` | `hangul-faces.test.ts` 전체(모듈과 기록 없음)                                                                         |
| C3  | 전환: 계약, 시트 생성기와 결과, KR 사본 67개 삭제, 스택, 로더, 미리 받기, 가드, 단위 시험 기대값, `fonts/README.md` | `9864386f` | 단위 8개 파일 47행(아래)                                                                                              |
| C4  | e2e: 줄 상자 14.5px 행과 한글 시트 확인, 글꼴 정체성, adaptive-actions, 구운 픽셀 주석                              | `21f4b84b` | `font-line-boxes`: 한글 시트 없음, 한글과 섞인 줄 14.5px이 덮어쓰기 없이 18 \| 14(17 \| 14여야 함), 면이 Noto Sans KR |
| C5  | 굵기 역할 계약이 한글 면의 굵기 축(45 930)을 앎                                                                     | `3ad033c0` | 전체 단위 실행이 C3의 빈틈으로 찾음(§6)                                                                               |
| D   | 이 보고서와 `docs/README.md`                                                                                        | 이 커밋    | 해당 없음                                                                                                             |

### 5.1 부모에서의 실패

부모 `7d60f134`를 이 작업 폴더 안의 임시 checkout으로 꺼내 C1 ~ C4의 시험 파일만 넣고 돌렸다(그 뒤 지움).

- 단위(12개 파일 251개): 50개 실패, 11개 파일. `sfnt-names`와 `hangul-faces`는 불러오기 실패. `stackOrderProblems` 두 행(내보내기
  없음), phase A 목록 16행과 phase C·이름 데우기·재시도 행 16개(모두 `locale-fonts` 32행)(`font-hangul` 없음, 가족이 Noto Sans KR), 미리 받기 가족과 합계,
  KR 면 수와 한글 소유 행(`font-sheets` 넷), 스택 순서와 한글 소유(`font-stack-identity` 셋), `HANGUL_LINE_BOX`와 기술자 집계
  (`font-metrics` 둘), 첫 페인트 스택(`locale-surfaces`), 구운 KR 면 수(`font-baked-metrics` 둘). `app-face-metrics` 세 행은 그
  임시 checkout에 `node_modules`가 없어서 실패한 것으로 동작과 상관없다.
- e2e(부모의 `build:e2e`): `font-line-boxes`가 한글 시트 확인에서 실패했고, 그 확인을 끄고 다시 돌리면 덮어쓰기 없는 한글·섞인 줄
  14.5px이 18 | 14(§4.1 마지막 행)이고 면이 Noto Sans KR이라 실패했다.

## 6. QA 라운드

환경: Windows 11, Node 24.22.2 / npm 12.0.2, Playwright Chromium(로컬, 재시도 없음, 포트 5291·5292, 추적 끔), `CI=true`,
`TZ=Etc/UTC`, `vitest --maxWorkers=6`.

- **라운드 1 — 런타임 `9864386f`(e2e 시험 `21f4b84b`, 시험 고침 `3ad033c0`), 2026-11-02.**
  - 기준선(부모 `7d60f134`, 같은 날 계획 단계): `guard:font-assets` 통과, `generate:font-sheets -- --check` 통과, 글꼴 단위 10개
    파일 256 / 256, 전체 단위 741개 파일 17,727개(git 고정 시험 시간 초과 하나는 따로 돌려 통과), 운영 빌드와 첫 화면 예산,
    `guard:font-build`, 글꼴 e2e 넷 18 / 18.
  - 생성기 검사: `generate:hangul-faces -- --check`(87개를 다시 잘라 같음, 17.8초), `generate:font-sheets -- --check`,
    `generate:app-faces -- --check`(373개를 다시 구워 같음, 58.8초) 통과.
  - 단위: 글꼴과 i18n(`src/i18n` 전체와 `app-font-guard`, `initial-transfer-budget`, `service-worker-cache`) 50개 파일 894개 통과.
    전체 `vitest run --maxWorkers=6`을 `21f4b84b`에서 한 번: 743개 파일 17,747개 가운데 2개 실패. `release-deployment-state`의 git
    고정 시험 시간 초과(따로 돌려 통과, 기준선에도 있던 종류)와 `weight-role-contract`(한글 시트의 `font-weight: 45 930`을 몰랐음,
    C5 `3ad033c0`에서 고침, 그 파일과 `max-font-weight` 13 / 13 통과). `3ad033c0`에서 전체를 다시 돌린 결과는 §6.1.
  - typecheck(tsc 프로젝트 19개와 그 가드), lint(앱과 도구, 경고 0), format:check 통과(`21f4b84b`).
  - 가드 37개(`guard:*` 모두, 운영 빌드 뒤): `guard:sw-cache-version`만 버전 올리기 없음으로 실패('committed PWA runtime changes
    are newer than v805', 목록은 바뀐 시트, `css/style.css`, `fonts/app/hangul` 등). 나머지 36개 통과(`guard:font-assets`: 44개
    스택, 빈칸 1270개, `guard:font-build`: 빌드 시트와 한글 면, `guard:initial-transfer-budget`, `guard:dead-exports` 포함).
  - E2E(`build:e2e`, `21f4b84b`): `font-baked-pixels`, `font-identity`, `font-line-boxes`, `tab-header-title-alignment`과 재생목록 명세
    여덟(`playlist*.test.ts`) 12개 파일 51 / 51(5.8분). `test:e2e:critical`의 여덟 파일 101 / 101(5.2분). 그 전 실행: 탭 머리,
    구운 픽셀, adaptive-actions 57 / 57, 줄 상자와 정체성 5개 가운데 시작 화면 기대값 하나가 옛 값이라 실패해 고친 뒤 통과.
  - WebKit 탐침(§4.1)은 저장소 밖 임시 쪽이다.
  - 한계: Windows의 Chromium과 Playwright WebKit만 봤다. 실제 iPhone Safari, macOS Safari, Firefox, Android, Linux CI, 운영은 보지
    않았다. 줄 상자 Safari 모델은 Chromium에서 덮어쓰기를 뺀 것이다. 0.5px 단위 전체 크기 비교는 계획 단계의 계산 모델이다.

### 6.1 `3ad033c0`의 전체 단위 실행

`vitest run --maxWorkers=6` 한 번(7.5분 안팎): 743개 파일 17,747개 가운데 17,744개 통과, 3개가 시간 초과로 실패했다. git 고정
저장소를 만드는 시험 둘(`release-deployment-state`의 'blocks an unselected app when a localized build input changes'와
`sw-cache-version-guard`의 'allows removing retired promo studies …')과 tooling ESLint 프로필 시험 하나다. 세 파일만 다시
돌리면 같은 종류의 시간 초과가 둘(앞의 첫째와 `sw-cache-version-guard`의 다른 git 시험) 나왔고, 넷을 하나씩 돌리면 모두
통과했다(20.3초, 10.0초, 4.7초, 1.5초. 첫째의 한도는 30초). git 시험 셋은 합성 고정 저장소를 쓰고, ESLint 시험은 이 변경이
건드리지 않은 `browser/classic-runtime/admin.ts`를 읽는다. 그래서 이 변경과 상관없고, 기준선에서도 같은 종류
(`sw-cache-version-guard`)가 한 번 났다. 기계 부하에 따라 흔들리는 시험이다.

## 7. 위험

1. **OFL RFN(D1).** 이름을 바꿔 피했다. 이름을 되살리려면 원작자의 서면 허락이 필요하다(§9 1).
2. **한국어 첫 화면 바이트 +16%.** 디자인을 그대로 가져오는 값으로 받아들였다. 굵기 축을 자르는 다른 안은 윤곽을 바꾼다(§9 2).
3. **한 줄의 Pretendard 한글과 Noto 한자.** 같은 기준선, 같은 줄 상자이고 잉크 크기는 9.0.32보다 가깝다(§3). 한자 폭은 0.94 em,
   한글은 0.864 em 그대로.
4. **Pretendard의 가나, 라틴, 문장 부호는 쓰지 않는다.** 범위가 한글뿐이고 시험이 지킨다. 가나는 Noto JP 그대로.
5. **굵기 45-930 대 공개 페이지의 45 920(D0).** 흉내 굵기 없음.
6. **9.0.31 구운 상자 시험.** 한글 면은 굽지 않는다. `verifyAppFaces`가 `fonts/app/hangul`을 건너뛰고, KR 기록이 53면으로 줄었고,
   `font-baked-pixels`는 영향이 없다(한글 면은 두 맥락에서 같은 파일).
7. **NFD 첫가끝 자모(1100-11FF)는 Noto KR이 그린다**(파일에 없음). 트랙 제목은 NFC로 맞추지만(`src/player/track-display.ts`) 채팅은
   아니다. 그 글은 9.0.32처럼 Noto KR 모양이다.
8. **불러오는 동안** 한글은 이전처럼 기기 글꼴에서 바뀐다(`font-display: swap`). 음절에 Noto KR을 거쳐 가는 일은 없다.
9. **한자가 섞인 한국어 글**은 아직 한글 글리프가 든 KR 조각을 받는다(쓰지 않는 바이트). 다음 선택지: KR 입력을 한글 없이 다시
   자르기(지금은 하지 않음).
10. **다시 쓴 이름 표를 OTS와 CoreText가 받아들이나.** Chromium e2e와 Playwright WebKit에서 면이 불렀고 CDP가 MUSIXQUARE Hangul로
    보고했다. 실제 iPhone은 배포 뒤 확인(§8).
11. **critical의 adaptive-actions**가 옛 가족을 기다리지 않도록 바꿨다(C4).
12. **공개 페이지.** 블로그, History, 디자인 시스템, 소개와 그 형제 페이지, `account-complete.html`은 계속 Pretendard 전체
    (`css/pretendard.css`, 디자인 시스템 사본)를 그린다. 그래서 앱과 한글 디자인이 다시 같아진다. 미뤄 둔 공개 페이지 글꼴 열차는
    이제 Noto KR 한글이 아니라 Inter + MUSIXQUARE Hangul 조각 + Noto로 옮겨야 하고, 그 열차의 줄 상자 오너 질문도 바뀐다. 공유 그림
    (`og-pretendard-bold.ttf`)은 그대로다.
13. **구버전 탭.** 배포 뒤에도 9.0.32에 남은 탭은 이전 KR 시트를 그대로 쓰는데, 한글만 들었던 KR 사본 67개는 새 배포에 없다. 그 탭이
    아직 받지 않은 조각의 한글은 새로 고칠 때까지 기기 글꼴로 그린다. 남은 53개 KR 사본은 같은 바이트라 주소가 그대로다. 오너
    정책(구버전 무시)과 업데이트 창이 다룬다(9.0.31과 같은 종류, 릴리스 메모 한 줄은 §10).

## 8. 배포 뒤 기기 확인

1. 오너 iPhone(Safari)에서 한국어 화면: 한글이 Pretendard 모양인지, 15px 줄 높이와 재생목록이 여럿일 때 네 탭 제목 높이가 9.0.32와
   같은지(같은 사진 구도).
2. Android Chrome과 데스크톱 Chrome에서 같은 화면.
3. 영어 화면에서 한글 제목과 채팅이 한국어 화면과 같게 보이는지.
4. 한자가 섞인 제목(예: '첫눈 오는 날 漢字')에서 한글과 한자의 높이가 어색하지 않은지.

## 9. 오너 질문

1. **이름.** 기본은 MUSIXQUARE Hangul이다(화면은 그대로, 글꼴 파일 안의 이름만). 파일 안의 이름을 Pretendard로 두려면 원작자의 서면
   허락이 필요하다. 지금 그대로 둘까? [화면 그대로]
2. **바이트 선택지.** 굵기 축을 400-700으로 자르면 87개가 2,506,376 B에서 1,784,316 B(−29%)로 줄고 한국어 첫 화면도 가벼워지지만,
   표본 372개 중 279개 글자의 400·500·600·700 윤곽이 원본과 달라진다(보간 범위가 바뀜). 기본은 하지 않음. [화면 바뀜: 해볼 경우
   한글 획이 조금 달라질 수 있음]
3. **공개 페이지 글꼴 열차.** 그 열차를 할 때 공개 페이지도 앱과 같이 Inter + MUSIXQUARE Hangul + Noto로 옮길까(§7 12)? [화면
   그대로: 지금 공개 페이지 한글이 이미 Pretendard]

## 10. 릴리스 담당이 할 일

- 조립: 마지막 런타임 커밋으로 App 9.0.33 / v806 버전 올리기(거울 파일 모두, `docs/release-versioning.md`), 그 뒤
  `guard:sw-cache-version`과 `guard:release-identity` 통과 확인, 전체 관문(`docs/hotfix-procedure.md`). 대상 `app`, 업데이트 창,
  `raise_app_build_floor` false, Developer API D1 false.
- 릴리스 기록(`docs/release-record.md`): §2 맨 위에 "App 9.0.33 앱 한글 Pretendard(9.0.33 / v806) 배포 뒤 확인" 절(범위와 오너
  결정, [화면 바뀜], D1, §8 기기 확인, 공개 페이지 열차 범위 변경, 다음 되돌리기 번호, 이 보고서 링크), §4에 되돌리기 항목. 배포 뒤
  기록 PR이 §1과 `Last source review`를 덮어쓰고 `release-history.md`에 한 행을 더한다.
- 되돌리기: 앞으로 되돌리기(이 열차 커밋을 되돌리는 커밋과 더 높은 버전·SW 캐시 epoch, 9.0.33이 나간 뒤로는 9.0.34 / v807 이상)가
  기본이다. 되돌리면 KR 시트가 120면이 되고 생성기가 KR 입력(`fonts/noto/noto-sans-kr`, 저장소에 그대로)에서 67개 사본을 다시 굽는다
  (또는 되돌리는 커밋이 그 파일을 되살림). 내려받기, 데이터, 바닥, Durable Object, D1, 다른 Worker는 상관없다.
- 릴리스 메모 한 줄: 배포 뒤에도 9.0.32에 남은 탭은 아직 받지 않은 한글 조각을 받지 못해 그 글자를 새로 고칠 때까지 기기 글꼴로
  그린다(§7 13).
- 오너 질문 §9 1 ~ 3의 답을 받으면 그에 따른 증분을 테스트 먼저로 더한다.
