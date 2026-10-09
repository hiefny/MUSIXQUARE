# 3차 QA 후속 수정·예방 보강 — 2026-10-09

| Field | Value |
| --- | --- |
| Status | 구현·로컬 회귀 완료, PR #273 검토·CI 및 정식 배포 대기 |
| Applies to | QA3 확정 9건과 사용자 승인 예방 보강 3건 |
| Last source review | 2026-10-09 |
| Executable sources | `src/player`, `src/youtube`, `src/pro-room`, `src/ui`, `src/i18n`, `browser/service-worker.ts`, `cloudflare/account-auth.ts`와 유지 회귀 검사 |
| Related documents | [발견 당시 감사](beta-30-round-qa3-2026-10-09.md), [현재 배포 기록](../beta-release-readiness.md), [정식 릴리스 절차](../hotfix-procedure.md) |

## 범위와 판정

기준은 main `bf4912b203d07c7e48ba34d0dbf38da528257c98`, 운영 참고는
`ff7766ccc0c83ab1eee15bc030347e9067764ee6` / App `8.7.6` / `v640`이다.
사용자는 확정 9건과 미확정 3건의 권고 방향을 승인하고, 수정 전 재검증·문서·주석·배포까지 요청했다.
임시 브랜치 `agent/qa3-remediation`에서 기존 QA 문서를 보존하며 작업한다.
예정 제품 버전은 `8.7.7`, PWA cache epoch는 `v642`이다.

미확정 3건은 자연스러운 실제 provider/브라우저 발생 조건을 입증한 것으로 승격하지 않는다.
명시적인 동작 기준을 정하고 **예방 보강**으로 처리한다. 합성 조건의 재실행 통과는
실제 YouTube 이벤트 순서나 네이티브 탭 지연의 빈도·도달성을 증명하지 않는다.

| ID | 재검증과 수정 기준 |
| --- | --- |
| A3-R13-C01 | 자연 종료 후 idle 대기 중에도 명시 STOP은 다음 곡·반복 예약을 취소한다. 등록된 MediaSession 콜백과 실제 playlist 타이머를 연결한 수정 전 검사에서 2실패/3대조 통과를 다시 확인했다. |
| A3-R16-C01 | 1,000곡 상한에서 YouTube 입력을 소비하지 않고 기존 queue-full 안내를 표시한다. |
| A3-R18-C01 | 로컬 경과 시간·대기는 단조 시계로 측정하고, 호스트와 공유하는 시각은 기존 동기화 시계 계약을 유지한다. |
| A3-R20-C01 | Standard 채팅·귓속말의 즉시 전송 거절은 초안을 유지하고 성공 말풍선을 만들지 않는다. 배달 확인 프로토콜을 새로 보장하는 변경은 아니다. |
| A3-R21-C01 | 짧은 화면에서도 PIN 모달 전체를 스크롤해 등록·취소 조작에 도달할 수 있어야 한다. 물리 모바일 키보드 검증과 구분한다. |
| A3-R22-C01 | 번역 템플릿을 한 번만 보간하며, 삽입 값 안의 placeholder 모양 문자열은 그대로 보존한다. |
| A3-R22-C02 | 열린 닉네임창의 번역 소유 문구는 언어 변경에 맞춰 갱신하며 사용자 입력은 보존한다. 호출자가 제공한 일반 literal 문구는 자동 번역하지 않는다. |
| A3-R23-C01 | 캐시된 stable asset의 백그라운드 재검증을 응답 헤더·본문 포함 5초로 제한한다. 캐시 응답은 즉시 제공하고 timeout 뒤 늦은 응답으로 캐시를 덮지 않는다. 수정 전 실제 Chromium에서 12초 지연→해제 후 갱신을 다시 관측했다. |
| A3-R26-C01 | 저장하기 전 정규화한 경로를 다시 해석해도 origin이 같아야 한다. callback도 저장된 이전 flow의 경로를 재검증한다. 수정 전 확인은 기존 실행 원본과 현재 소스 대조로 한정했다. |
| A3-R04-C01 — 예방 | 탭 인계 알림은 현재 접속을 서버에 재확인하는 신호다. 서버의 현재 접속 판정에 따라 처리하며 이전 비동기 결과가 새 입장·이동을 종료하지 않도록 한다. |
| A3-R17-C01 — 예방 | 새 플레이어는 제한 시간 내 준비 또는 실패로 끝나야 한다. 생성 예외·준비 누락·늦은 callback을 정리하되 이미 준비된 iframe 재사용에는 새 onReady를 요구하지 않는다. |
| A3-R17-C02 — 예방 | 이전 영상의 상태·metadata를 새 재생목록 항목의 상태로 전송하지 않는다. 같은 영상의 별도 occurrence, 반복과 playlist/Mix 이동을 대조한다. |

## 검증 근거와 한계

환경: Windows, 고정 Node `24.20.0`, 저장소의 Vitest/Playwright.
원본 실행·최초 실패·최종 결과는 로컬
`scratch/qa3-repair-2026-10-09/{root,youtube,ui,handoff}/`에 보존한다.
scratch는 Git에 포함되지 않으며 아래 결과를 정식 main CI 후보로 대체하지 않는다.
제품 코드 최종 로컬 빌드 SHA는 `20eb6d07b6d7c0e38f7cd28f39d80092a9b7322a`다.
PR·정식 배포 결과는 완료 시 이 문서와 living record에 함께 기록한다.

| 검증 | 결과·해석 |
| --- | --- |
| 수정 전 필요성 | 확정8건과 예방3건은 기존 조건·정상 대조를 다시 실행. OAuth1건은 기존 원본+현재 소스 재검토로 한정. 원래 실패·관측형 pass를 보존했다. |
| 전체 단위 후 최종 영향 파일 치환 | 530파일 **10,990 pass / 기존1 skip / 최종fail0**. `unit-adjudicated.json`에 파일별 채택 원본 기록. 최초 전체 실행10,988pass/2fail/1skip는 bootstrap cache URL 누락과 실행 도중 보완된 YouTube proof 순서였고, 최종 관련 파일 재실행으로 모두 해소. 단일 최종 SHA 전체 실행이라고 표현하지 않는다. |
| YouTube 최종 전체 | 41파일1,065pass/fail·skip0. 늦은 pause, 동일 영상 occurrence, PL/RD 이동·실제 UI auto-subindex, 새 ready 누락·throw, 준비된 iframe 재사용, authority가 소비한 CUED의15초 초과 대조 포함. |
| PRO 인계 | 유지 고유184pass, 새 회귀12 포함. 강제 stale 알림 기존 실패→통과; 정상 superseded·expired·통신 실패·기존 heartbeat 중 알림·늦은 정리/이동 대조. |
| UI | 유지10파일391pass·실제 목록 보간3pass, 해당 담당자 Chromium4pass. 부모 최종 산출물 검증은 아래 별도. |
| 부모 통합 Chromium | native 파일 종료/STOP5pass; 채팅·모달·YouTube·파일/백그라운드17pass; 최종 YouTube/critical13pass(앞선 파일과 중복, 합산하지 않음). |
| production 산출물 | candidate Chromium17pass, 실제 SW 갱신2pass, WebKit SW fallback1pass. UI는 아래 fixture 진단 뒤 Chromium3+WebKit3=6pass/fail·skip·retry0로 확인했다. dist782파일을 사용했으며 정식 CI candidate와 구분한다. |
| 정적·번들 | 최종 전체 typecheck·lint·format 통과, 별도 source/policy guard12종 통과. committed `20eb6d07` build:checked·Worker6종 dry-run 통과. |
| 독립 검토 | OAuth 성공 callback의 저장 경로 재검증 누락, no-store 응답의 본문 지연 시 cache 회수 유지, authority가 소비한 CUED의 proof 해제 순서를 보완하고 재검토. 기존 QA 발견 수를 이 구현 중간 수정 수와 합산하지 않는다. |

첫 SW 테스트2건은 추가 AbortSignal을 반영하지 않은 호출 인자 기대값이었다. 결과·cache 정책
assertion은 유지했다. lint의 async fixture/미처리 promise2곳과 bootstrap cache URL 누락,
후속 runtime commit을 덮지 못한 cache history guard 실패도 로그에 보존했다. 최종 covering
epoch `v642`와 동기화된 초기 스크립트 주소로 build:checked가 통과했다.

추가 WebKit PIN2건의 첫 실패는 레이아웃 결함이나 claim 유실이 아니었다. Service Worker를
허용한 UI fixture에서 bootstrap 요청이 Playwright context route를 거치지 않아 로컬 preview의
503을 받았다. 같은 v640 baseline도 동일하게 실패했다. SW를 차단한 대조에서는 실제 account와
bootstrap 요청이 각각200으로 fixture에 도달하고 정상 account 선택→PIN→320×280 스크롤 조작이
통과했다. 해당 UI 검사는 네트워크 fixture를 고립하도록 `serviceWorkers: 'block'`을 명시한다.
실제 SW 활성화·갱신·오프라인 동작은 SW를 허용한 위 별도 Chromium/WebKit 검사로 유지한다.
이 진단은 과거 단발 dev claim-missing의 원인을 소급 설명하지 않는다.

핵심 재실행 명령(고정 Node24.20.0을 PATH에 사용):

```sh
npm run typecheck
npm run lint
npm run format:check
node node_modules/vitest/vitest.mjs run --maxWorkers 4
node node_modules/vitest/vitest.mjs run src/youtube --maxWorkers 2
npm run build:checked
npm run check:worker-bundles
npm run test:e2e:candidate
node node_modules/@playwright/test/cli.js test --config playwright.webkit-service-worker.config.ts
```

새 fixture 회귀는 `e2e/dialog-locale-layout.test.ts`·`e2e/chat.test.ts`와 유지 단위 검사에
포함했다. 원본 명령·환경 변수·단계별 JSON은 각 scratch 담당자 `repair-notes.md`와 부모 로그에 있다.

R26에서 이전 자동 안전 검토가 중단한 심화 실행은 반복하거나 다른 세션으로 넘기지 않았다.
기존 원본과 방어적 코드 검토를 이용하며, 수정 후 정상 OAuth 복귀와 기존 유지 회귀를 검증한다.
이 경로의 독립 심화 재현·실제 외부 이동·live OAuth까지 완료했다고 기록하지 않는다.

PWA 수정은 **수정된 worker가 활성화된 이후의 재검증**에 적용된다. 이미 실행 중인
v640 worker의 끝나지 않은 요청을 새 배포가 소급 취소하지 못한다. 최초 갱신이 기존 요청에
묶인 경우 요청 종료 또는 열린 앱 탭 종료 후 재진입이 필요할 수 있다. 이전 단발 legacy
갱신 정지의 원인이 이번 결함과 같았다고 결론내리지 않는다.

실기 iOS/Safari, 하드웨어 media key, 물리 키보드, 실음향, 실제 provider 사건 순서는
로컬 합성·headless 통과와 별개다. 과거 개발 claim-missing·운영 R2 관측 한계도 유지한다.

## 배포·복구 계약

변경은 App 브라우저 입력과 App Worker의 계정 복귀 처리다. D1 schema, secrets,
service bindings, wire protocol, 의존성 변경은 없다. 정상 절차상 배포 대상은 `app`,
`apply_developer_api_d1=false`다. App의 통상 idempotent D1 baseline 처리는 유지한다.

PR 검토 후 병합한 정확한 main SHA의 성공 CI candidate를 Production Release에서 사용한다.
브랜치 검사나 기존 v640 후보를 배포 증거로 대체하지 않는다. 실패 시 워크플로의
소유권·호환성 검증과 복구 checkpoint를 따르며, 구버전 앱을 재배포할 때도 새로운
단조 cache epoch가 필요하다. 배포 종료 후 임시 브랜치를 정리하고 main으로 복귀한다.
