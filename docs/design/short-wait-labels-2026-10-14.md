# 입장 대기·장황 버튼 라벨 축약 — 2026-10-14

| 항목      | 값                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 상태      | 구현·로컬 검증 완료, 병합·배포 대기. 제품 `8.10.15` / 서비스 워커 캐시 `v681`, Production Release `target=app` 예정                                                                                                          |
| 검증 코드 | 코드 커밋 `3dd5bf81ba7b47128319ae4984bcfee1497a7206` (branch `agent/short-wait-labels-8.10.13`, base main `f4ccf602`; 이후 main의 #331(8.10.14/v680, 공유 액션 모션)을 병합하고 8.10.15/v681로 재bump, 최종 커밋 `a6f6724f`) |
| 환경      | Windows 11, Node 24.13.1, Vitest 5, Prettier. 로컬 실행이며 exact-main CI 후보가 아니다                                                                                                                                      |
| 범위      | `src/i18n/*.ts`의 버튼·칩 라벨 값 250건(31키, 40개 로케일)과 릴리스 식별자. 런타임 로직·Worker·D1·시크릿 변경 없음                                                                                                           |
| 근거      | 2026-10-13 오너 관찰("잠시만요"가 다른 언어에서 "살롱에 입장 중…"처럼 길다)과 같은 날 버튼 길이 조사(100키×42로케일 grapheme 측정, 장황 후보 25키). 오너 지시 2026-10-14 "25키도 같이 처리해줘"                              |

## 1. 기준

버튼 길이 조사의 컨테이너별 기준을 그대로 썼다. 칩(2열 그리드)과 다이얼로그 2버튼 행은
grapheme 14자 이하, 전폭 셋업·액션 버튼은 22자 이하. 각 로케일의 기존 말줄임·대소문자
형식은 유지했고, 뜻은 같은 의미의 짧은 관용구로 바꿨다. 한국어·영어는 이미 가장 짧은
편이라 영어 한 키(`pro.claim_choose_account_button`)만 바꿨다. 기준 안에 있던 값은 손대지
않았다.

## 2. 무엇을 바꿨나

| 묶음                      | 키                                                                                                                                                                                                                                     | 건수 | 예                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 입장 대기(설정 확인 버튼) | `common.wait`, `setup.joining`                                                                                                                                                                                                         |   28 | fr "Veuillez patienter…"→"Un instant…", fr "Connexion au salon…"→"Connexion…", ja "しばらくお待ちください..."→"お待ちください...", ur 23자→14자                                                                                       |
| 다이얼로그 2버튼 행       | `common.retry`·`connect.signaling_retry`(같은 문구), `dialog.reconnect`·`connect.signaling_recover_action`(같은 문구), `dialog.audio_recovery_action`, `dialog.session_lost_btn`, `account.logout`, `common.reset`, `pro.use_this_tab` |   61 | de "Erneut versuchen"→"Wiederholen", da "Opret forbindelse igen"→"Forbind igen", bg "Възстановяване на звука"→"Включи звука", fi "Käynnistä uudelleen"→"Aloita alusta", uk "Вийти з облікового запису"→"Вийти"                        |
| 계정 선택 버튼            | `pro.claim_choose_account_button`                                                                                                                                                                                                      |   23 | 영어 "Choose another account"→"Another account"처럼 각 로케일의 `pro.activation_account_switch`(오너 결정으로 짧게 둔 값)를 그대로 재사용. uk는 두 키 모두 "Інший акаунт", el "Άλλος λογαριασμός"(17자)는 그리스어 특성상 예외로 허용 |
| 전폭 계정 버튼            | `account.delete_account`, `account.google_continue`                                                                                                                                                                                    |    8 | uk "Видалити обліковий запис"→"Видалити акаунт", fil "Magpatuloy gamit ang Google"→"Magpatuloy sa Google"                                                                                                                             |
| 옵션 칩                   | `demo.treble_boost`, `demo.bass_boost`, `role.center/left/right`, `settings.eq_advanced`, `settings.rvb_advanced`, `settings.virtual_effect_surround`, `settings.rvb_arena`                                                            |   89 | bg "Усилване на високите честоти"→"Повече високи", pl "Wzmocnienie wysokich tonów"→"Mocne soprany", it "Altoparlante centrale"→"Centrale", el "Προηγμένες ρυθμίσεις"→"Προηγμένο"                                                      |
| 전폭 셋업·액션 버튼       | `connect.copy_invite_link`, `player.play_start`, `help.load_local`, `demo.step_finish`, `settings.leave_session`, `demo.exit`, `demo.track_info`                                                                                       |   41 | fil "Kopyahin ang link ng imbitasyon"→"Kopyahin ang link", de "Zur Warteschlange hinzufügen"→"Zur Wiedergabeliste", uk "Завантажити локальний файл"→"Локальний файл"                                                                  |

스피커 역할 칩은 14자를 넘는 로케일에서 "스피커" 명사를 빼고 위치만 남겼다(es "Central",
de "Links"). 칩에는 아이콘이 함께 있고 한국어·영어는 그대로다.

## 3. 보류·제외

- `setup.guest_button`(nl·cs·bg 23자, 기준 22): 이 버튼명은 `setup.how_to_connect_html`
  도움말이 인용하므로 같이 바꿔야 한다. 1자 초과라 이번에는 두었다.
- `common.off`·`settings.eq_off`·`settings.rvb_off`(fi 13, es 11)와 `setup.demo_button`·
  `demo.prompt_cta`·`demo.step_role`(≤22)은 기준 안이라 그대로다.
- 하단 내비·서브탭과 `connect.permission_*`·`chat.start` 같은 설명형 행 버튼은 조사 때부터
  제외 대상이다.

## 4. 검증

| 명령                                                                                                          | 결과                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx vitest run src/i18n/__tests__ src/ui/__tests__`                                                          | 97 files, 1,950 passed (핀 충돌 0)                                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run typecheck` / `npm run lint` / `npm run format:check`                                                 | pass                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm test`                                                                                                    | 560 files, 12,638 passed / 2 failed. 실패 2건(`release-deployment-state`, `sw-cache-version-guard`)은 동시 실행 플레이크로 단독 재실행 141/141 통과                                                                                                                                                                                                                                                                      |
| `npm run build:checked`                                                                                       | pass (8.10.13, v679 — main 병합 전 1차, eager gzip 합계 530.6 KiB, prod-security·font·sw-app-shell 가드 통과)                                                                                                                                                                                                                                                                                                            |
| e2e `adaptive-actions`·`dialog-locale-layout`·`rtl-settings-layout`·`demo-session-layout` (chromium, 새 빌드) | 17 passed, 0 failed. `demo-session-layout`는 테스트 훅이 필요해 `build:e2e` 산출물로 실행(3 passed), 나머지 14는 production 산출물                                                                                                                                                                                                                                                                                       |
| main 병합(#331) 뒤 재검증, 코드 커밋 `a6f6724f`                                                               | `npx vitest run src/i18n/__tests__ src/ui/__tests__` 99 files 1,970 passed; `npm run build:checked` pass(8.10.15, v681, eager gzip 합계 531.8 KiB, main이 올린 예산 기준); e2e `adaptive-actions`·`dialog-locale-layout`·`rtl-settings-layout` 19 passed + `demo-session-layout` 3 passed(build:e2e); typecheck·lint·format은 CI 후보에서 확인. 전체 `npm test`는 병합 전 트리에서만 돌렸고 main 쪽은 #331 CI가 검증했다 |

한계: 실기 화면 확인은 하지 않았다. 짧아진 문구는 LLM 작성이며 원어민 검수가 아니다.
2026-09-06 감사 방식의 42언어×4폭 자동 레이아웃 재측정은 하지 않았고, 짧아진 값은 기존
값보다 항상 짧아 잘림 위험이 늘지 않는다.

## 5. 복구

번역 값과 릴리스 식별자만 바뀌었다. 문제가 있으면 직전 App(8.10.12, `d9364cd9`)으로
되돌린다. 이 릴리스에는 main에 먼저 병합된 #331(공유 액션 모션, 8.10.14)도 함께 실린다. 새 floor 없음.
