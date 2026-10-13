# 42개 로케일 번역 품질 업데이트 — 2026-10-14

| 항목 | 값 |
| --- | --- |
| 상태 | 구현·로컬 검증 완료, 병합·배포 대기. 제품 `8.10.11` / 서비스 워커 캐시 `v674` 예정 |
| 검증 코드 | 코드 커밋 `818c87bca6c944859efb21bcb46c699d8695d576` (branch `agent/i18n-quality-update-2026-10`, base main `5eb25dc6`) |
| 환경 | Windows 11, Node 24.13.1, Vitest 5, Prettier, TypeScript. 로컬 실행이며 exact-main CI 후보가 아니다 |
| 범위 | App 범위만: `src/i18n/*.ts` 42개, `browser/classic-runtime/landing-i18n.ts`(About), `browser/classic-runtime/account-complete.ts`, `index.html`·`.workshop/landing/landing.html` 영어 폴백, i18n 테스트 3개, 번역 가이드. Worker·D1·스키마·시크릿 변경 없음 |
| 조사 근거 | 2026-10-13 전수 조사(42로케일 리뷰어 + 영어↔한국어 정합, 내부 폴더 `docs/private/i18n-quality-survey-2026-10-13/`, 저장소 밖 보관) |

## 1. 무엇을 바꿨나

조사에서 나온 제안 1,772건을 오너 결정(§2)으로 걸러 적용했다. base main 대비 최종
차이는 **app·About 사전 값 1,742건**(app 1,534·About 208; 영어 49·한국어 29)이며, 이 중
70건은 `...en` 스프레드 때문에 영어가 노출되던 PRO 활성화 키의 신규 번역이다. 사전
밖의 복수형 27건과 계정 완료 페이지 8건은 별도다.

| 경로 | 건수 | 비고 |
| --- | ---: | --- |
| `scripts/apply-translation-suggestions.mts`로 적용(app·About) | 1,689 | 2회 실행(1,000 + 689). 이후 승인 문구 고정 테스트와 충돌한 18건을 되돌림(§4) |
| `pro.activation_account_*` 6키 + `pro.activation_complete` 삽입 | 70 | `...en` 스프레드로 키가 없던 de·es·fr·id·ja·nl·pt-br·vi·zh-hans·zh-hant |
| 복수형 메시지 수정·추가 | 27 | 22건 교체 + hi·mr·ro·ur에 `one` 형태 5건 추가 |
| 계정 로그인 완료 페이지 | 8 | `account-complete.ts` 튜플 |
| `<bdi>` 태그 복구(`player.play_speakers_html`) | 3 | fr·ja·tr. 적용 도구가 마크업 변경을 거부해 AST로 직접 교체 |
| 토스트 50자 상한 보정(§6) | 14 | 12건 축약 재작성 + 2건 base 복원 |
| 영어 폴백 동기화 | index.html 12곳, landing.html 11곳 | `data-i18n`·`data-i18n-html`·aria-label 폴백이 사전과 같아야 하는 테스트 계약 |

주요 결과:
- 40개 로케일 전부에서 영어로 노출되던 PRO 활성화 7키가 번역됐다(280문자열).
- 영어 원문 49건, 한국어 원문 29건 수정(둘 다 오너가 쓴 원문; 영어는 40개 번역의 피벗이라 애매한 표현을 정리). 대표: `setup.how_to_connect_html`의 옛 버튼 인용을 실제 버튼명("방 만들기"/"방 참여하기", "Create a Room"/"Join a Room")으로, `remote.h2` "Not in the room?"→"Not in the same place?", `standin.caveat`의 "desktop Chromium"→컴퓨터 표현, `system_audio.receive_failed` 한국어 주체 오류.
- 글로서리 함정 재발 수정: Revoke=Cancel 동일어(he·mr·gu·fa), Peer=사회적 동등자(mr·ta·ms), 채팅 뮤트→오디오 뮤트 동사(ru·fr·id), 스피커=연사(bg 13문자열) 등.
- 로케일 내부 용어 통일(공지/관리자/방·세션/재생목록/새로고침/트랙), 슬래시 명령 괄호 인자 번역(hu·el·bg·ro·pa·cs), `chat.system_sender` 번역(el·bg·ro), 스페인어 중립화 47건(ordenador→computadora, vídeo→video, Pulsa→Toca, Introduce→Ingresa, 복합과거→단순과거).

## 2. 오너 결정 (2026-10-14)

1. 버튼·탭·라벨은 한/영 중 짧은 쪽. PRO 활성화 버튼은 영어 "Continue"/"Another account" 기준으로 40개 로케일 짧은 라벨, 한국어도 "계속하기"/"다른 계정". 문장은 뜻이 맞는 쪽(보통 한국어).
2. `setup.how_to_connect_html`은 실제 버튼명으로.
3. 영어·한국어의 줄바꿈 차이 3키는 그대로 둔다(테스트는 번역 로케일과 영어만 비교).
4. 소수점은 현지 표기 허용(`0,1 s`). 번역 가이드 §3 문구를 같이 고쳤다.
5. 어조는 로케일별 다수형으로 통일, 스페인어는 중립(국제) 스페인어.
6. `SYSTEM` 발신자 라벨과 슬래시 명령 괄호 인자는 번역(명령 이름은 유지).

## 3. 보류·제외

- 점검 안내(`cloudflare/service-maintenance.ts`) 14건: 6개 Worker가 공유하는 모듈이라 Worker 범위 후속으로 미룸.
- 승인 문구 고정 테스트와 충돌해 되돌린 18건(§4). 특히 `toast.settings_sync_admin_required`는 11개 로케일 제안이 "admins" 약어를 정식 명칭으로 바꾸자는 것이었으나 테스트가 현재 문구를 승인 문구로 고정하고 있어 유지했다. 바꾸려면 문구와 테스트를 함께 바꾸는 별도 결정이 필요하다.
- 버튼 길이 축소 25키(2026-10-13 길이 조사)는 이번에 넣지 않았다.
- 리뷰어 "Uncertain" 항목(로케일별 md)은 제안하지 않았으므로 반영되지 않았다.

## 4. 되돌린 18건

`en:dialog.audio_recovery_message`(신규 로케일 브랜드 토큰 패리티 테스트), `en`·de·es·fr·id·it·nl·pl·pt-br·ru·tr `toast.settings_sync_admin_required`(승인 문구 고정), `ko:connect.kick_message`(고정), `de:player.seek_unavailable_system_audio`(고정), `zh-hans`·`zh-hant` `setup.enter_host_code_alt`(초대 코드 용어 금지 계약), `ta:pro.claim_retry_message`(PRO 토큰 패리티), `vi:standin.caveat`("송신 기기" 용어 계약). 영어 복수형 `demo.session_body_connected#one`도 고정 문구라 되돌렸다.

## 5. 테스트 변경

문구를 고정한 핀만 새 번역에 맞췄고 테스트가 검사하는 동작은 그대로다.

- `plural.test.ts`: th `connect.device_list`, id `connect.administrator_list`, tr `playlist.delete_selected`의 문구 핀을 새 번역에 맞춤(폴백 동작 자체는 동일). ro `playlist.delete_selected` count 1은 새 `one` 형태를 기대.
- `factual-translation-contracts.test.ts`: 스페인어 "ordenadores"→"computadoras"(중립화).
- `translations.test.ts`: 한국어 `pro.pin_members_reenter_detail` 띄어쓰기 "한 번에".
- `dialog-locale.test.ts`: 같은 한국어 문구의 "한 번에".
- `connect-i18n.test.ts`: 한국어 `connect.kick_title` "강제퇴장시키기"(`chat.cmd_d_kick`과 동일 표기로 통일).
- `account-complete.test.ts`: nb "Innloggingen er fullført…", bg "Входът е завършен. Можеш да затвориш…"(bg 사전은 전부 반말 "можеш" 어조).

## 6. 토스트 50자 상한 검사

`src/ui/toast.ts`는 토스트 한 줄을 50자(코드포인트)로 자르고 "…"를 붙이며 전체 문구는
tooltip(`title`)로만 남긴다. 전체 테스트에서 영어 `transfer.host_busy`가 잘려 드러났기에,
`showToast`·`bus.emit('ui:show-toast')`에 직접·간접으로 닿는 키 194개를 모아 42개 로케일
전부를 base main과 비교했다(자리표시자는 실제 값으로 치환: `{{count}}`=4, `{{max}}`=500).

| 구분 | 건수 | 처리 |
| --- | ---: | --- |
| 이번 업데이트로 상한을 새로 넘긴 값 | 15 | 14건 수정(12건 축약 재작성: en 3·fr 2·nl·ms·ar 3·he·el·hu, 2건 base 복원: en `transfer.host_busy`, bg `toast.host_sync_requested`). uk `system_audio.device_limit_stopped` 1건은 자리표시자 치환 후 44자라 유지 |
| 업데이트 전부터 상한을 넘던 값 | 1,143 → 1,141 | 194키×42로케일 8,148개 중 14%. 설계상 잘림+tooltip으로 동작하며 이번 범위 밖. 축약은 2026-10-13 버튼 길이 조사와 함께 보류 |

bg `toast.host_sync_requested` 복원 근거: 리뷰어는 "синхрон"→"синхронизация"를 제안했지만 bg
사전은 "синхрон" 13회 대 "синхронизация" 3회로 짧은 형이 다수라 상한과 일관성 모두 base가
낫다.

## 7. 검증

| 명령 | 결과 |
| --- | --- |
| `npx vitest run src/i18n/__tests__` + 영향받은 UI 테스트 4파일 | 31 files, 581 passed, 0 failed, 0 skipped (토스트 보정 뒤 재실행) |
| `npm run typecheck` | pass |
| `npm run format:check` | pass |
| `npm run lint` | pass |
| `npm test` | 560 files, 12,637 passed / 2 failed. 실패 2건(`release-deployment-state`, `sw-cache-version-guard`)은 빌드와 동시 실행 중 발생했고 단독 재실행 141/141 통과. 그 전 실행의 `pro-room-burst` workerd `fetch failed` 1건도 단독 재실행 7/7 통과 |
| `npm run build:checked` | pass (8.10.11, v674, prod-security·font·sw-app-shell 가드 통과) |
| e2e 레이아웃 스펙 (`dialog-locale-layout`, `about-page-layout`, `rtl-player-layout`, `rtl-settings-layout`), chromium, 8.10.11 빌드 산출물 | 30 passed, 0 failed (24.4s) |

한계: 리뷰어는 LLM이며 원어민 인증이 아니다. 2026-09-06 감사 방식의 42언어×4폭 자동 레이아웃 재측정은 하지 않았다. 바뀐 긴 문자열은 대부분 다이얼로그·설명문이며 줄바꿈 가능한 컨테이너에 있다. 배포 뒤 실제 화면 확인 항목을 릴리스 기록에 남겼다.

## 8. 복구

번역·폴백·테스트와 릴리스 식별자(8.10.11/v674)만 바뀌었고 런타임 로직은 그대로다. 문제가 있으면 이전 App 버전으로 되돌리면 되고, 새 floor는 없다.
