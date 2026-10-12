# 공지 전체 경로 감사 — 2026-10-13

| 항목 | 값 |
| --- | --- |
| 상태 | 조사 완료, 제품 수정·커밋·푸시·배포 없음 |
| 검토·로컬 검증 SHA | `967db779aa6c667202242b6892ce2ca51375b48f` |
| 운영 런타임 | `8d0d310c6ee8114722d199b5c8d9834088979ec5`, App 8.10.3 / cache v662 |
| 환경 | Windows, Node 24.20.0, Vitest 5.0.3, JSDOM, 로컬 Worker/DO mock |
| 범위 | 운영 공지의 게시·수정·철회·만료·이력·오류·동시 요청, 관리자 폼, 일반/PRO/데모 초기화와 조회 수명, 고정 배너 및 방장 공지 경계 |
| 운영 변경 | 앞선 오너 요청으로 공지는 Disabled 상태. 이번 전수조사에서는 추가 변경 없음 |

앞선 [운영 일반방 철회 실험](standard-announcement-bootstrap-2026-10-13.md#follow-up-withdrawing-an-already-displayed-notice--2026-10-13)을
출발점으로 서버·관리자·클라이언트를 병렬 조사하고, 재현 결과와 관련 소스를
다시 확인했다. 조사용 코드는 무시되는 `scratch/`에만 만들었다. 통과한
characterization test는 **현재의 잘못된 동작을 재현하는 검사도 포함**하므로,
결함이 수정됐다는 의미가 아니다.

## 1. 확정 기능 결함 6개

### A01 — 게시된 운영 공지를 내려도 기존 배너가 남음 (P2)

- `src/ui/announcement.ts:103–105`: 응답이 `enabled:false`이면 아무 이벤트도
  내보내지 않고 반환한다. 서버 만료도 동일한 응답이므로 같은 문제다.
- 운영 일반방에서 01:12:01 KST 비활성화, 01:17:21 KST에도 배너 잔존.
  공개 GET은 HTTP 200 `{"enabled":false}`였다. 페이지 새로고침·재입장·배너
  닫기·타이머 가속 없이 관찰했다.
- 당시 실제 poll의 네트워크 시각은 캡처하지 않았다. 5분 interval 실행은
  소스 및 로컬 테스트로 확인했으며, 운영 관찰과 구분한다.
- 일반/PRO의 공통 소비 코드라 양쪽에 적용된다. 이번 운영 관찰은 일반방만이다.
- 수정 시 운영 공지의 ID/출처를 구분해 해당 배너만 철회해야 한다. 방장 공지나
  더 새 공지를 함께 지우면 안 된다. A02와 함께 수정해야 한다.

### A02 — 조회 불가를 정상적인 ‘공지 없음’으로 응답 (P2)

- `cloudflare/app-worker.ts:11648–11655`: canonical state가 없으면 빈 레코드로
  대체하여 HTTP 200 `enabled:false`, `Cache-Control: public, max-age=30`을 반환한다.
- 실제 저장 실패뿐 아니라 정상 게시/수정 도중 같은 isolate에서 발생할 수 있다.
  `service-maintenance.ts:1628–1633`은 mutation 동안 조회 캐시를 비우고,
  `:1573–1574`는 그 창의 읽기를 unavailable로 돌려준다.
- 실제 Worker/DO 코드를 사용하는 로컬 검사에서 정상 저장을 잠깐 보류하자
  public GET은 위 응답, admin GET은 503이었다. 저장을 풀면 새 공지로 회복했다.
- 기존 배너는 A01 때문에 현재 지워지지 않지만, 처음 들어온 기기는 공지를
  못 받고 다음 조회까지 기다릴 수 있다. A01만 고치면 저장/일시 장애가
  기존 공지를 철회하는 더 큰 표시 회귀가 된다.
- 개선 방향: authoritative absence와 unavailable을 API/클라이언트에서 구분.
  30초 헤더가 실제 모든 Cloudflare POP에서 캐시됨을 실측한 것은 아니다.

### A03 — 관리자 초기 조회가 작성 중 초안을 덮어씀 (P2)

- `browser/classic-runtime/admin.ts:6210`: 초기 metrics가 끝난 뒤 공지를 다시
  읽는다. `:5959–5962`의 렌더가 편집 중인 폼 값도 무조건 덮어쓴다.
- 재현: metrics 응답 지연 → Announcements 탭 진입/공지 조회 완료 → 초안 작성
  → metrics 완료 → 두 번째 공지 GET 응답. 초안이 기존 게시 문구로 돌아갔다.
- 관측: GET 2회, POST 0회. 서버 저장 유실이 아니라 **저장 전 초안 유실**이다.
- 개선 방향: 초기 로딩 중복을 피하고, dirty 폼은 명시적 새로고침/저장 응답과
  배경 조회 응답을 구분해서 갱신한다. 기존 revision·로그아웃 펜스는 유지한다.

### A04 — ISO/초 포함 만료 입력은 불가능한 날짜를 다른 날로 저장 (P2)

- `browser/classic-runtime/admin.ts:2165–2168`: 표시 형식은 엄격 검증하지만
  fallback `new Date(text)`에는 같은 달력 검증이 없다.
- `2031-02-29T12:00:00Z` → `2031-03-01T12:00:00.000Z`.
- `2031-04-31T12:00:00+09:00` → `2031-05-01T03:00:00.000Z`.
- `2031-02-29 12:00:00`도 같은 정규화 경로에 들어간다.
- ISO는 기존 테스트에서도 허용하는 입력이다. 세 입력은 한 원인의 변형이며
  결함 3개로 중복 집계하지 않는다. 일반 `YYYY-MM-DD HH:MM` 검증은 정상이다.
- API 입력도 `cloudflare/app-worker.ts:11574–11586`에서 native Date로 정규화한다.
  지원 형식의 달력 검증은 폼과 API 경계를 함께 검토해야 한다. 위 재현은
  관리자 폼에서 서버로 보낼 payload를 확인한 결과다.

### A05 — 만료 시각의 초가 폼 왕복에서 사라짐 (P3)

- `browser/classic-runtime/admin.ts:2133–2135`: 받아온 시각은 분까지만 표시한다.
  문구만 수정해도 그 표시 값을 다시 파싱하여 저장한다.
- `2031-05-01T10:30:59Z` 저장 → KST `19:30`으로 표시 → 문구만 수정/저장
  → `10:30:00Z`. 만료가 59초 앞당겨졌다.
- 현재 분의 아직 유효한 만료(예: now `00:00:30`, expiry `00:00:59`)는
  `00:00:00`으로 바뀌어, 만료 전인데도 문구 수정이 거절됐다.
- 개선 방향: 편집하지 않은 만료 원본을 보존하거나, 지원 정밀도를 폼과
  입력 계약에서 일치시킨다.

### A06 — 이미 만료된 공지를 Active 토글로 끌 수 없음 (P3)

- `browser/classic-runtime/admin.ts:6095`는 disabled 저장도 미래 날짜를 요구한다.
- 실제 DO의 `cloudflare/service-control-object.ts:1276`도 같은 조건을 적용한다.
- 만료된 기존 공지에서 Active를 해제해 Save → 미래 날짜 오류, POST 0회.
  UI를 거치지 않은 DO 검사도 `400 EXPIRES_AT_IN_PAST`였다.
- 메시지/만료를 보존한 비활성화가 안 되는 문제다. 만료 값을 비우거나 Clear를
  쓰면 가능하며, 이미 만료된 공지가 서버에서 활성으로 반환된다는 뜻은 아니다.
- UI와 서버는 한 결함으로 집계한다. 비활성화 계약을 양쪽에서 일치시켜야 한다.

## 2. 별도로 확인한 표시·알림 UX

### A07 — 긴 공지의 뒷부분을 앱 안에서 펼쳐 읽을 수 없음

- `css/style.css:8161–8170`은 본문을 3줄 clamp + `overflow:hidden`으로 제한한다.
- `src/ui/chat-render.ts:590–600`은 고정 배너에만 본문을 넣고 채팅 사본을 만들지
  않는다. `src/ui/chat.ts:1873–1878`에서 탭/Enter/Space는 전체보기가 아니라 닫기다.
- 따라서 허용된 280자 안에서도 3줄을 넘는 문구는 화면에서 뒷부분이 잘리고,
  통상적인 앱 조작으로 전체 내용을 확인할 수 없다. 일반/PRO, 서비스/방 공지의
  공통 표시 경로다. 기존 renderer 테스트도 채팅 사본이 없음을 명시한다.
- **소스로 확인한 UX 결함**이다. 실제 CSS/renderer를 연결한 로컬 브라우저
  fixture를 준비했지만 브라우저 도구의 탐색/연결 timeout으로 화면 재현은
  완료하지 못했다. 특정 폭에서 정확히 어느 단어가 잘렸다는 실측은 주장하지 않는다.
- 전체보기 또는 별도의 읽기 경로를 마련하되, 배너 전체를 탭해 닫는 기존 UX와
  어떻게 조합할지는 수정 설계에서 결정한다.

### A08 — 첫 조회 실패 뒤 첫 성공이 알림음을 울릴 수 있음 (경미)

- 최초 공지는 조용히 보여 준다는 기존 계약과 달리, 초기 요청 실패 후 첫
  5분 interval 성공은 toast와 sound를 호출한다. 반면 foreground 복귀를 통한
  첫 성공은 조용하다.
- `src/ui/announcement.ts:120`은 `initialCheckPending`을 보지만 `:125`의
  interval은 기본 `notify:true`로 호출한다. 로컬 타이머 검사로 재현했다.
- 내용 유실이나 동기화 장애는 아니다. 최초 성공 조회의 정책을 두 경로에서
  일치시킬지 정리하면 된다.

## 3. 결함으로 중복 집계하지 않은 경계

- **서비스 공지와 방장 공지는 최신 한 개가 서로 교체한다.** `8216b13c`는
  newer notice replaces it을 의도로 명시했고, `0483a000`은 같은 pinned 채널을
  사람 공지와 MUSIXQUARE 공지에 사용한다고 명시했다. 단일 슬롯 자체는 새 결함이
  아니다. 철회할 때 다른 출처의 배너를 지우지 않는 것이 A01 수정의 필수 조건이다.
- **PRO 방장 공지의 늦은 입장 복원 부재**: Standard는
  `src/network/host.ts:694`에서 최신 방 공지를 새 연결에 전송한다. PRO는
  `src/chat/commands.ts:447–452`에서 발신 탭에만 기억하고,
  `cloudflare/signaling-worker.ts:7626–7639`에서 현재 참여자에게만 relay한다.
  입장 snapshot에는 frozen/filter/slowmode/muted만 있다(`:4041–4047`, `:6312–6322`).
  로컬 FakeDO/FakeSocket 검사에서 늦은 입장 및 DO 재생성 뒤 입장 모두 notice를
  받지 않았다. Standard의 복원은 `e2c164e4`와 `e2e/late-join.test.ts:464`로
  명시돼 있지만 PRO까지 같은 정책이라는 근거는 못 찾았다. **서비스 공지 결함과
  분리한 모드 차이/정책 확인 항목**으로 남긴다.
- malformed `enabled:"false"`, object message는 클라이언트 truthiness 검사에
  통과하지만 현재 canonical 서버의 유효 응답으로 생성되는 경로는 못 찾았다.
  방어 검증 보강 후보이며 확인된 운영 취약점으로 집계하지 않는다.
- 동일 ID 재사용, init 중복, 페이지 내 seen-ID 잔존은 mock으로 만들 수 있으나
  정상 서버 ID 생성, bootstrap 단일 초기화, 정상 방 나가기의 hard reload를
  확인했다. 이를 새 운영 결함으로 집계하지 않는다.
- 배너의 접근성 이름이 닫기 동작 위주인 점은 실기 VoiceOver/TalkBack 확인
  대상이다. 실제 스크린리더 판독 장애를 재현했다는 주장은 하지 않는다.

## 4. 검증 결과와 한계

기존 선택 테스트는 **383 pass / 0 fail / 0 skip**:

| 검사 | 결과 |
| --- | --- |
| `src/pro-room/__tests__/service-control.test.ts`, `src/core/__tests__/service-maintenance.test.ts` | 127 pass |
| `src/core/__tests__/admin-maintenance-ui.test.ts`, `admin-read-ordering.test.ts` | 31 pass |
| `src/ui/__tests__/announcement.test.ts` | 4 pass |
| `src/ui/__tests__/chat.test.ts`, `src/chat/__tests__/protocol.test.ts`, `commands.test.ts`, `src/network/__tests__/room-control.test.ts` | 221 pass |

추가 로컬 탐사:

- `scratch/notice-audit-backend.test.ts`: **6 pass**, 실제 Worker/DO 코드 + 로컬
  storage/binding mock. A02·A06, 저장 실패 후 보존/재시도/재시작, 만료 재검사,
  CSRF/public POST 거부, 중복/이전 request ID 충돌을 검증했다.
- `scratch/notice-audit-client-2026-10-13/lifecycle.test.ts`: **23 pass**.
  18 lifecycle 사례와 5 bootstrap 사례다. 실제 polling 모듈과 추출한 변경 없는
  bootstrap 코드를 사용하며 network/import는 통제했다. 숨김·복귀·이전 방 응답·
  중첩 요청·10초 제한·HTTP 실패·잘못된 JSON·64KiB 제한·stalled body를 포함한다.
- 관리자 원본을 transpile한 `scratch/notice-audit-admin.mjs`: A03–A06 재현.
  KST→UTC, 같은 request ID 재시도, 저장 중 중복 요청 차단, logout 응답 펜스,
  history/preview의 텍스트 처리 등 **6개 정상 경계 대조 검사**도 통과했다.
  원본 제품 파일은 변경하지 않았다. 재현 변형 수를 독립 결함 수로 세지 않는다.
- `scratch/notice-audit-client-2026-10-13/pro-late-notice.test.ts`: 실제 signaling
  코드 + FakeDO/FakeSocket **1 pass**.
  기존 멤버에게만 전달되고 새 입장자에게 복원되지 않는 현재 동작을 고정했다.
- root가 backend/client 탐사(29개), 관리자 harness를 다시 실행했고 동일 결과였다.
  root의 채팅 관련 221개 검사도 모두 통과했다. 반복 실행 결과를 합산하지 않는다.
- 확인한 CSRF·권한·텍스트 렌더·revision·재시도 경계에서 추가 위반은 발견하지
  못했다. 모든 보안 위험이 없다는 증명은 아니다.
- Service Worker는 `cache:no-store` 요청과 `/api/` 경로를 캐시 대상에서 제외한다
  (`browser/service-worker.ts`). 철회 누락을 SW 캐시 문제로 판단할 근거는 없다.

주요 로컬 로그:

- `scratch/notice-audit-backend-root-rerun.log`
- `scratch/notice-audit-client-root-rerun.log`
- `scratch/notice-audit-admin-root-rerun.log`
- `scratch/notice-audit-chat-root.log`
- `scratch/notice-audit-client-2026-10-13/pro-late-notice-recheck.log`

초기 탐사 harness에서 짧은 테스트 암호로 인증 fixture가 실패한 1건은 테스트
전용 암호 길이를 맞춘 뒤 6/6으로 확인했다. client scratch의 esbuild/JSDOM
TextEncoder realm 문제는 실행 전 harness 문제였고, transpiler를 바꾼 뒤 23/23이었다.
이 둘은 제품 결함이나 통과한 회귀 검사로 둔갑시키지 않는다. 먼저 실행한
이름 필터 검사는 23 pass / 376 filtered skip이었으나 위 full-file 검사와 중복이므로
집계에 더하지 않았다. 로컬 표시용 Vite/브라우저 fixture 탐색 실패도 A07의
시각 검증 한계로 남겼으며 시험 서버는 종료했다.
추가 PRO harness는 첫 실행의 없는 저장값 assertion을 `undefined` 검사로
바로잡은 뒤 통과했다. Standard 기존 공지 보존 검사 1 pass / 필터 제외 27 skip도
위 protocol full-file 결과와 중복이므로 더하지 않았다.

운영 일반방의 철회 관찰 외에는 프로덕션 저장/장애 주입/실제 고객방에 접근하지
않았다. 전체 프로젝트 full E2E, 원격 CI, 여러 Cloudflare POP 캐시, iPhone PWA와
Android 실기 접근성 검증은 이번 조사 범위에서 실행하지 않았다. 로컬 결과는
exact-main 배포 후보를 대신하지 않는다.

## 5. 권장 수정 순서

1. A01+A02를 한 계약으로 수정: 정상 철회와 조회 장애 구분, 공지 출처/ID 소유권,
   만료 시각 처리, 사용자가 닫은 공지의 재표시 정책. 5분 조회·복귀 즉시 조회와
   취소 펜스는 유지한다.
2. A03의 초안 보호와 A04–A06의 만료 입력/저장 왕복을 정리한다.
3. A07 전체 읽기 UX와 A08 최초 성공 알림 정책을 맞춘다.
4. PRO 방장 공지의 늦은 입장 복원은 별도 정책/범위로 확정한다.

기능 수정 시 위 재현을 정식 회귀 테스트로 바꿔야 한다. 이번에는 조사 결과만
기록했으며, 배포 기록 §1과 release-history에는 새 릴리스 행을 만들지 않는다.
