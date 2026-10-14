# 점검 안내 번역 14건·숨은 YouTube 패널 접근성 수정 — 2026-10-14

| 항목      | 값                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 상태      | 구현·로컬 검증 완료, 병합·배포 대기. 제품 `8.10.12` / 서비스 워커 캐시 `v678`, Production Release `target=all` 예정                                                                                                                                     |
| 검증 코드 | 코드 커밋 `3d2d206fa75713d140afba183e23a1c886b86405`(1차, v676) → `65a28e09`(리뷰 반영, v677) → `125628f93b447b3c62afad62e72269bebee77db4`(aria-hidden 제거·예산 통과, v678, 최종) (branch `agent/maintenance-copy-a11y-8.10.12`, base main `14f72b77`) |
| 환경      | Windows 11, Node 24.13.1, Vitest 5, Prettier, TypeScript. 로컬 실행이며 exact-main CI 후보가 아니다                                                                                                                                                     |
| 범위      | `cloudflare/service-maintenance.ts`(Worker 6종 공유 모듈) 점검 안내 14개 로케일 문구, `src/player/video.ts` 주차된 YouTube 래퍼 `inert`, 테스트 핀 4곳과 단위 테스트 1개 추가, 릴리스 식별자. D1·스키마·시크릿·바인딩·프로토콜 변경 없음                |
| 근거      | 2026-10-13 번역 전수 조사의 점검 안내 제안 14건([보고서 §3](i18n-quality-update-2026-10-14.md)), release-record §2 접근성 항목(8.7.8 이전부터 존재)                                                                                                     |

## 1. 점검 안내 문구

`service-maintenance.ts`의 `localizedDescriptions` 14개 로케일을 조사 제안대로 바꿨다. 42개
로케일 중 나머지 28개는 제안이 없어 그대로다. 방향은 "서비스를 확인/검사 중"이라는 직역을
각 언어의 점검 안내 관용구(유지보수 중)로 바꾸는 것이다.

| 로케일                                  | 변경                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| en                                      | "We’re carrying out a service check." → "We’re carrying out maintenance to keep the service safe." |
| ko                                      | "안전한 서비스 점검을 진행 중이에요." → "안전한 서비스를 위해 점검을 진행 중이에요."               |
| bg                                      | 존댓말 "Опитайте" → 앱 전체의 반말 "Опитай"                                                        |
| fi·hu·it·nb·sv·tr·pt-br·zh-hans·zh-hant | 검사(check) → 유지보수(maintenance) 관용구                                                         |
| ms                                      | "sebentar lagi" 중복 → 앱 전체 표현 "sebentar nanti"                                               |
| th                                      | 어색한 연어 "ตรวจสอบบริการ" → "ตรวจสอบระบบ" 관용구                                                 |

이 모듈은 app·signaling·pro-room·remote-share·developer-api·developer-api-facade Worker가 모두
번들하므로 App만 배포하면 Worker 응답의 점검 문구가 어긋난다. 그래서 Production Release는
`target=all`이다. 핀 테스트는 ko(`app-maintenance-admin`, `service-maintenance`, e2e
`maintenance-inline-logo`), pt-br, nb의 문구만 새 값으로 바꿨고 검사하는 동작은 그대로다.

## 2. 숨은 YouTube 패널 접근성

YouTube 모드를 벗어나면 `updateBodyModeClass`가 iframe이 남은 `.video-wrapper`를
`display:flex` + `position:fixed; left:-9999px`로 화면 밖에 주차한다(iframe을 `display:none`으로
떼면 iOS 제스처 unlock이 풀리기 때문에 의도된 설계). 그 결과 래퍼 안의 전체화면 버튼이 DOM에
남아 Shift+Tab 역방향 포커스를 받았다. 수정: 모드가 YouTube가 아니면 래퍼에 `inert`를 주고 YouTube 모드가
되면 제거한다. `inert`는 HTML 규격상 하위 트리를 접근성 API에서도 제외하므로 별도
`aria-hidden`은 두지 않았다(초기 전송 예산 여유가 수십 바이트라 중복 속성도 뺐다). `inert`는 렌더링을 유지하고
플레이어 postMessage API를 막지 않으므로 보존된 iframe과 iOS prime 흐름에는 영향이 없다고
판단한다. 로딩 오버레이가 `#youtube-player-container`에 거는 `inert`와는 다른 요소라 충돌하지
않는다.

단위 테스트 `video.test.ts`에 "주차된 래퍼는 inert, YouTube 모드 복귀 시 해제"를 핀했다.

Codex 리뷰(P2) 반영: iOS에서는 `precreateYouTubePlayer`가 재생 모드가 `null`인 설정 단계에서
`hideYouTubeContainerResident`로 래퍼를 주차하므로 모드 리스너만으로는 그 래퍼에 속성이
붙지 않았다. 속성 적용을 `setYouTubeWrapperParked` 헬퍼로 빼서 주차 헬퍼에서도 호출하고,
`stale-async-guards.test.ts`의 사전 생성 테스트에 `inert`를 핀했다. 캐시 v677 재bump 뒤
초기 전송 예산 가드가 eager gzip 합계 543,401 B > 543,400 B(유지 상한, 1 B 초과)로 실패해
중복 `aria-hidden`을 제거하고 v678로 다시 bump했다. 예산 한도를 넓히지 않았다.

## 3. 검증

| 명령                                                                                                                                                  | 결과                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 영향받은 테스트 6파일(`video`, `player-controls`, `service-maintenance`, `app-maintenance-admin`, `auxiliary-service-maintenance`, `locale-surfaces`) | 317 passed, 0 failed                                                                                                                                                 |
| `npm run typecheck`                                                                                                                                   | pass                                                                                                                                                                 |
| `npm run lint`                                                                                                                                        | pass                                                                                                                                                                 |
| `npm run format:check`                                                                                                                                | pass                                                                                                                                                                 |
| `npm test`                                                                                                                                            | 560 files, 12,638 passed / 2 failed. 실패 2건(`release-deployment-state`, `tooling-eslint-config`)은 typecheck·lint와 동시 실행 중 발생했고 단독 재실행 119/119 통과 |
| `npm run build:checked`                                                                                                                               | 1차 pass(v676) → 리뷰 반영 뒤 초기 전송 예산 1 B 초과로 fail(v677) → 최종 pass(8.10.12, v678, eager gzip 합계 530.6 KiB, prod-security·font·sw-app-shell 가드 통과)  |
| e2e `maintenance-inline-logo` + `adaptive-actions` (chromium, 새 빌드)                                                                                | 8 passed, 0 failed (19.0s)                                                                                                                                           |

한계: 역방향 포커스는 jsdom 단위 테스트로 속성만 핀했고 실제 브라우저의 Tab 순서는 e2e
`adaptive-actions`·`rtl-player-layout`의 기존 포커스 검사에 기댄다. iOS에서 `inert` 래퍼가
prime 흐름에 영향이 없는지는 기존 iOS 실기 항목과 함께 본다.

## 4. 복구

번역 문구·접근성 속성·릴리스 식별자만 바뀌었다. Worker 6종이 같은 SHA로 배포되며 새 floor는
없다. 문제가 있으면 직전 App·Worker(8.10.11, `7be28951`)로 되돌린다.
