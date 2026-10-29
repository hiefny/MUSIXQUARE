# 휴대폰·태블릿 채팅 시트의 닫기(X) 삭제 (2026-10-30)

| Field              | Value                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 구현됨, 미병합·미배포. 브랜치 `agent/chat-x-removal`은 main `b8ae59e7` 위 세 커밋이다: 테스트 `d5c83195` → 구현 `d4f11e1d` → 이 문서. 버전 올리기는 없다                                                                                                   |
| Base               | main `b8ae59e7`(#532, 9.0.25 / v798). 지운 닫기는 9.0.20(#516, squash `226219c5`, 2026-10-29 05:52 KST 배포)이 넣었다                                                                                                                                      |
| Version            | 올리지 않았다. 릴리스 담당이 다음 App 릴리스에서 앱 SemVer와 SW 캐시를 다른 오너 결정과 묶어 올린다. 그래서 이 브랜치에서 `guard:sw-cache-version`은 그 이유로만 실패한다(`guard:release-identity`는 9.0.25 / v798로 통과)                                 |
| Scope              | 채팅 시트의 보이는 닫기(`#btn-chat-close`, 이름 `chat.close`) 삭제와 그 시험·가드                                                                                                                                                                          |
| Deploy target      | `app`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`와 Worker별 런타임 경로로 `b8ae59e7..d4f11e1d`를 본 로컬 판정에서 App 46개(`index.html`, `css/style.css`, `css/desktop.css`, `src/ui/chat.ts`, `src/i18n` 42), 다른 다섯 Worker 0개다 |
| Operations         | 운영 요청은 없었다. 배포 뒤 오너 단계 하나: 관리자 Translations의 All 필터에서 `chat.close`의 남은 제안 줄을 거절한다([운영 문서](../account-auth-operations.md)의 키 삭제 규칙)                                                                           |
| Resource ownership | 새 복구·재시도·시간 제한·감시·생명주기 흐름이 없다. 지운 것은 닫기의 클릭 리스너 하나다. `d4f11e1d`에서 `node scripts/check-resource-ownership.mts`가 49 records / 448 files로 통과했고 기준치는 바뀌지 않았다                                             |

이 문서는 2026-10-30 오너 결정 하나를 구현한 증분을 기록한다. 실패하는 테스트를 먼저 커밋했고(부모 코드에서 실패),
그다음 구현을 커밋했다. 전후 사진(390x844 라이트·다크)과 측정 값은 저장소 밖에 두고 오너에게 건넨다. 릴리스 담당이
이 증분을 다음 App 릴리스 열차에 묶을 때 이 문서를 그 열차의 보고서로 키우거나 열차 보고서에서 이 문서를 가리킨다.

## 오너 결정 (2026-10-30)

- [9.0.20](ui-followup-920-2026-10-29.md)은 대화상자 나가기 조사의 F12(2026-10-28 오너 결정: 휴대폰 채팅 시트는
  시트라서 바깥 터치 닫기를 두고 왼쪽 위에 보이는 닫기를 더한다)로 휴대폰·태블릿 채팅 시트의 손잡이 줄 시작 쪽에 36px
  닫기 버튼(20px X 아이콘)을 넣었다. 오너가 2026-10-30 기기에서 그 X를 보고 지워 달라고 했다.
- 시트는 9.0.20 전처럼 닫힌다: 바깥(배경) 탭, 손잡이 탭과 아래로 쓸기, 포커스한 손잡이의 Enter·Space, Esc,
  뒤로가기. 다른 보이는 글, 배치, 동작은 바꾸지 않는다.
- 9.0.20 보고서의 오너 기기 확인 목록 4(휴대폰 채팅 시트의 왼쪽 위 닫기)는 이 결정으로 답했다.

## 바꾼 것 (구현 `d4f11e1d`)

- `index.html`: `#btn-chat-close`와 그 주석을 지웠다. 시트의 첫 요소는 다시 손잡이 줄(`.chat-drawer-header`)이다.
- `css/style.css`: `.chat-drawer-close` 규칙 넷(기본 버튼, `:active`, 아이콘, 시트에서 손잡이 줄 시작을 덮던 36px
  겹침)을 지웠다. 시트에서 서랍 제목을 숨기는 규칙은 그대로다. `css/desktop.css`의 모바일 요소 숨김 규칙에서
  `#btn-chat-close`를 뺐다(`#chat-preview-btn`은 그대로 숨김).
- `src/ui/chat.ts`: 닫기의 클릭 연결을 지웠다. 손잡이의 역할(세로 휴대폰과 태블릿은 separator, 짧은 가로 휴대폰은
  button), 이름('채팅'), 단축키는 그대로이고, 손잡이가 다시 시트의 Tab 순환을 시작한다. 그 밖에는 주석만 바꿨다.
- `chat.close`('채팅 닫기')를 42개 언어에서 지웠다. 다른 데서 쓰지 않는다. 쓰지 않는 카탈로그 키를 막는 가드는
  없지만, 9.0.20 V1이 지운 칸의 키를 42개 언어에서 지운 것과 같이 지웠다. 이름·힌트 문구 정책 시험은 쓰지 않는
  등록을 막으므로 그 등록도 지웠다(테스트 커밋).
- 닫기는 높이를 차지하지 않고 손잡이 줄 위에 겹쳐 있었으므로 다른 것은 움직이지 않는다(아래 측정).

## 시험과 가드 (테스트 `d5c83195`)

- `src/ui/__tests__/chat-sheet-close.test.ts`가 삭제를 고정한다: 손잡이 줄이 시트의 첫 요소이고 안에 컨트롤이
  없다. `index.html`에 `btn-chat-close`, `chat-drawer-close`, `chat.close`가 없고, 앱 스타일시트 넷(`css/app.css`가
  가져오는 파일)에 둘을 부르는 규칙이 없으며, `chat.ts`에 연결이 없고, 42개 언어에 `'chat.close'`가 없다.
- `chat.test.ts`: `index.html`의 실제 `#chat-backdrop`과 `#chat-drawer`를 붙인 새 시험이다. 키보드로 열면 손잡이에
  포커스가 있고, Shift+Tab은 마지막 컨트롤인 보내기로, 보내기에서 Tab은 손잡이로 돈다. Enter, Space, 손잡이 클릭, 배경
  클릭, Esc가 각각 시트를 닫는다. 합성 마크업의 모달 시험은 9.0.20 전 기대(보내기에서 Tab이 손잡이로)로 돌아갔고,
  뒤로가기 정착 시험은 닫기 대신 손잡이와 배경으로 닫는다.
- `window-exit-guard.test.ts`: 채팅 시트의 나가기는 손잡이다(새 `handle` 항목과 그 이유). 가드는 손잡이가 시트의 첫
  요소이고 컨트롤을 품지 않으며, 시트의 어떤 버튼도 나가기 라벨을 쓰지 않는지 본다. 닫기를 다시 넣으면 markup
  나가기로 이름 붙이라며 실패한다. `chat.close`는 창 나가기 라벨 목록에서 빠졌고, 바깥 탭 예외의 이유는 닫기 대신
  손잡이를 말한다. 머리 주석은 채팅 시트가 버튼 대신 손잡이로 나가는 유일한 창이라고 적는다.
- `control-name-copy-policy.test.ts`의 등록에서 `chat.close`를, `button-label-contract.test.ts`의 버튼 분류에서
  `chat-drawer-close`를 지웠다.
- E2E `e2e/ui-comprehensive.test.ts`: 배경 시험은 닫기를 기대하지 않는다. 새 시험(390x844)은 '채팅 닫기'(Close chat)
  버튼이 없고, 36px 손잡이 줄이 시트 맨 위에 있으며 그 시작 쪽(닫기 자리)도 손잡이이고, 첫 Tab이 손잡이에 가며,
  손잡이의 Enter, 손잡이 탭, Esc가 시트를 닫는지 본다.

## 테스트 먼저와 검증 (QA 라운드 1, 2026-10-30)

환경: 로컬 Windows 11, Node 24.22.2, npm 12.0.2, Playwright 1.63.0 Chromium. 로컬과 브랜치 결과는 exact-main 후보를
대신하지 않는다.

- 테스트 먼저: 테스트 커밋 `d5c83195`(런타임은 부모 `b8ae59e7`과 같음)에서 바꾼 단위 파일 다섯은 6 failed, 184
  passed다. chat-sheet-close 2, chat 1(실제 마크업에서 Shift+Tab이 닫기로 감), window-exit-guard 1(손잡이가 시트의
  맨 위가 아님), button-label-contract 1(분류되지 않은 `chat-drawer-close`), control-name-copy-policy 1(등록되지 않은
  `chat.close`). 뒤로가기 정착 시험의 손잡이와 배경 경우는 부모에서도 통과한다. `b8ae59e7`의 e2e 빌드에서 새 E2E는
  닫기 수(기대 0, 실제 1)에서 실패하고 배경 E2E는 통과한다.
- 구현 `d4f11e1d`: 전체 단위 706 files / 16,750 통과와 1 건너뜀(`--maxWorkers=4`, 573초), `typecheck`(모든 tsc
  프로젝트와 그 안의 가드), `lint`, `format:check`. 정적 가드 developer-api-boundaries, d1-migrations,
  ops-drift-contract, import-graph, dead-exports, bus-pairing(202 / 202), source-complexity, standard-room-hot-path,
  room-authority-boundaries, navigation-sinks, chunk-pump, lifecycle-writes, transport-health, resource-ownership가
  통과했고 기준치는 하나도 바뀌지 않았다. `build:checked`의 단계를 하나씩 돌려 운영 `build`와 그 뒤 가드(legacy-tv-build,
  service-worker-build, ui-kit-build, initial-transfer-budget, prod-hooks, prod-security, font-build, sw-app-shell 94
  assets)까지 통과했다. `guard:release-identity`는 9.0.25 / v798로 통과하고, `guard:sw-cache-version`만 v798보다 새
  PWA 런타임 변경 46개를 들어 실패한다(버전 올리기 없음). E2E(`build:e2e`, 로컬 Chromium): `test:e2e:critical` 100 /
  100, `ui-comprehensive.test.ts` 23 / 23과 `e2e/chat.test.ts` 6 / 6.
- 측정(e2e 빌드, Chromium 390x844, 장치 픽셀 비 3, 라이트·다크, 열린 시트는 반 높이): 시트(위 422px)와 손잡이 줄(36px,
  가운데 36x4px 막대)의 자리는 전후 같다. 전후 사진은 두 테마 모두 X 글리프의 12x12px 칸(x 20 ~ 32, y 434 ~ 446)
  안의 544 장치 픽셀만 다르다. 접근성 트리는 전에는 `dialog "Chat"` 아래 `button "Close chat"`, `separator "Chat"`
  순이었고 뒤에는 `separator "Chat"`부터다. 렌더된 Tab 후보는 닫기, 손잡이, 입력, 보내기에서 손잡이, 입력, 보내기가
  됐다. 바깥 탭은 두 빌드 모두 시트를 닫는다.
- 다른 화면(구현 빌드만): 844x390 가로 휴대폰(손잡이는 button 'Chat'), 768x1024와 1024x768(separator 'Chat'),
  1440x900 데스크톱 패널(region)에서 닫기는 0개다. 세 시트 모두 손잡이 줄이 시트 맨 위에 있고 그 시작 쪽도
  손잡이다.

## 발견한 것 (바꾸지 않음)

- 실제 Chromium에서 고정 공지가 없는 열린 시트(구현 빌드)의 Tab을 눌러 봤다. 첫 Tab은 손잡이로 가지만 다음 Tab은
  손잡이에 머물고, Shift+Tab은 보내기, 입력으로 간 뒤 입력에 머문다. `getChatDrawerFocusableElements`가 숨은 고정
  공지(`#chat-pinned-notice[hidden]`) 안의 두 버튼을 후보에 남기고, 그 버튼은 포커스를 받지 못하기 때문이다. 코드로
  보면 9.0.20(닫기에서 Tab이 손잡이로 간 뒤 멈춤)과 그 전에도 같다(9.0.20 빌드로는 돌리지 않았다). jsdom은 숨은
  버튼에도 포커스를 주므로 단위 시험은 이것을 잡지 못한다. 키보드로 닫기는 Esc와 손잡이의 Enter·Space로 된다. 이
  결정의 범위 밖이라 고치지 않았다(후속 후보: 후보를 렌더된 요소로 거르기).

## 사용자가 알아챌 변화

- 휴대폰과 태블릿에서 채팅 시트 왼쪽 위의 X가 없다. 바깥 탭, 손잡이 탭과 쓸기, Esc, 뒤로가기로 닫는 것은
  그대로다. 데스크톱 채팅 패널은 그대로다(닫기를 보인 적이 없음).
- 화면 낭독기: 시트 안에 '채팅 닫기' 버튼이 없고, 시트의 첫 정지점은 손잡이 '채팅'(separator, 짧은 가로 휴대폰은
  button)이다. 손잡이에서 Enter·Space, 시트 어디서나 Esc로 닫는다(9.0.20 전과 같음).

## 섞인 버전과 되돌리기

- App 화면만 바뀌고 저장 데이터, 통신, 다른 Worker는 그대로라 섞인 버전 문제가 없다. 열린 탭은 업데이트 경로로 새
  코드를 받을 때까지 X를 보인다.
- 되돌리면 X와 `chat.close`가 돌아온다(9.0.20 ~ 9.0.25의 화면).

## 기록

- [9.0.20 보고서](ui-followup-920-2026-10-29.md)(F12, 오너 결정 줄, 오너 기기 확인 목록 4)는 그때의 기록이라 고치지
  않았다. [9.0.23 보고서](ui-owner-923-2026-10-29.md)가 데모 머리글 나가기를 지울 때와 같은 방식이다.
- 대화상자 나가기를 따로 적은 정책 문서는 없다. 정책은 9.0.20 보고서와 `window-exit-guard.test.ts`(머리 주석과
  목록)에 있고, 가드 쪽을 이 변경에서 고쳤다. [뒤로가기 문서](back-closes-top-window-2026-10-17.md)는 시트의 닫기를
  말하지 않아 그대로다.
- [릴리스 기록](../release-record.md) §2에 이 배포 전 항목을, [문서 목록](../README.md)의 근거 절에 이 문서를 더했다.

## 확인하지 않은 것

- 실기기(iPhone, Android), iOS Safari와 WebKit, 화면 낭독기(VoiceOver, TalkBack, NVDA), Chromium 79 TV.
- PR CI, exact-main CI, Linux 글꼴, 전체 직렬 E2E. 위 E2E 파일만 로컬 Chromium에서 돌렸다.

## 오너 기기 확인 목록

1. 휴대폰에서 채팅 시트를 열어 왼쪽 위 X가 없고, 바깥 탭, 손잡이 탭, 아래로 쓸기로 닫히는지.
2. 태블릿(세로·가로)과 가로 휴대폰에서도 같은지.
