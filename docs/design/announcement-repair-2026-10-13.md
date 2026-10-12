# 공지 철회·관리자 편집·전체보기 수정 — 2026-10-13

## 범위와 기준선

- 오너 요청: 공지 전수 감사에서 확인한 결함 수정과 전체보기 UI 이미지 제공.
- 기준 checkout: `main`, `967db779aa6c667202242b6892ce2ca51375b48f` 위의 로컬 미커밋 수정.
  아래 검증은 이 수정본 대상이며 기준 SHA 자체나 exact-main CI 성공을 뜻하지 않는다.
- 검증 소스 스냅샷 SHA-256:
  `add3b8a78b45e529d0beaba85fdb6a5424074b49944350f762d9a7ae3a4e2d2d`.
  변경된 제품·테스트·설정 25파일을 경로 순서로 정렬하여 경로+NUL+파일 바이트+NUL을
  해시했다. 문서 변경은 제외했다. 로컬 파일 목록은 `scratch/notice-code-snapshot.json`.
- 운영 기준선은 App 8.10.3 / cache v662, 배포 SHA `8d0d310c` 그대로다.
  이번 작업에서 게시된 공지·점검 상태·프로덕션·버전·캐시를 변경하지 않았다.
- 앞선 [전체 감사](announcement-full-audit-2026-10-13.md)의 A01–A08을 다룬다.
  방 공지와 서비스 공지는 기존처럼 가장 최근 한 건만 고정한다. PRO 방장 공지의
  중도 참여 복원은 별도 정책이며 이번 수정에 포함하지 않는다.

## 수정한 동작

1. **철회와 장애를 구분한다.** 유효한 `enabled:false` 응답만 현재 서비스 공지를
   지운다. 방장 공지·다른 ID의 최신 공지에는 영향이 없다. HTTP 오류·잘못된 JSON은
   기존 공지를 유지한다. canonical 조회 불가와 저장 진행 중의 공개 API는
   `503` / `no-store`를 반환하며 정상 비활성 응답과 구별된다.
2. **오래된 캐시가 최신 공지를 지우지 못한다.** 공개 활성·비활성 응답에 기존
   canonical `revision`을 추가했다. 클라이언트는 더 낮은 revision을 무시하고,
   숫자 revision을 본 뒤에는 무버전 응답으로 되돌아가지 않는다. 동일 revision의
   만료 철회는 허용하지만 다시 활성화하지 않는다. 방 재입장에서도 이 경계와
   기존 알림 중복 억제를 유지한다. 내부 30초 캐시를 가진 두 binding identity가
   같은 DO를 공유하는 회귀로 `active rev1 → stale disabled rev0`를 재현했다.
3. **첫 성공 조회는 무음이다.** 초기 요청이 실패하고 interval/foreground 재시도로
   처음 성공해도 초기 접속과 동일하게 알림음·토스트 없이 표시한다. 이후 새 공지는
   기존 정책대로 알린다. 만료는 기기 시계로 추정하지 않고 서버 판정과 기존
   5분 주기·foreground 조회로 반영한다.
4. **관리자 초안을 보존한다.** 늦은 초기 analytics 뒤 중복 공지 조회를 생략한다.
   자동 조회 중 입력한 초안과 명시적 Refresh를 누른 뒤 새로 입력한 초안을
   응답이 덮어쓰지 않는다. Refresh 클릭 당시 기존 초안 교체는 유지하며,
   초안을 보존할 때 기존 revision 충돌 방지도 유지한다.
5. **만료 입력을 정확하게 처리한다.** 불가능한 날짜·시간·시간대 오프셋을 native
   Date 정규화 전에 거부한다. 만료 필드를 편집하지 않은 저장은 기존 초·밀리초를
   보존한다. 만료된 공지는 끌 수 있지만 과거 만료 시각으로 다시 켤 수 없다.
   성공 여부가 불확실한 동일 요청의 멱등 재시도는 만료 후에도 유지된다.
6. **전체보기와 배너 닫기를 분리한다.** 본문 버튼은 기존 공통 다이얼로그의 읽기
   레이아웃을 연다. 전체 문구·줄바꿈·복사·자동 텍스트 방향·키보드 접근을 유지하고,
   짧은 화면에서는 본문만 커스텀 스크롤바로 스크롤한다. 닫기 버튼은 남는다.
   창 닫기는 배너를 유지하고, 배너 ×는 공지를 닫는다. 교체·철회 시 해당 공지의
   대기/활성 다이얼로그만 취소하며 다른 다이얼로그는 닫지 않는다. 본문은 HTML로
   해석하지 않는다.

## 검증

환경: Windows, Node 24.20.0, Vitest 5, Chromium 기반 Codex 브라우저.
관리자 날짜 회귀는 Asia/Seoul과 America/New_York에서 확인했다.

- 표적 검사: 클라이언트 34, 실제 notice renderer 10, chat 132, dialog 53,
  관리자 46건 통과. 전체 검사와 중복 합산하지 않는다.
- 백엔드 최초 표적 4파일 428건 통과 뒤 공개 revision·교차 캐시 회귀를 추가했다.
  최종 통합 결과는 아래에 기록한다.
- 로컬 실제 렌더: 현재 `index.html`의 배너·다이얼로그 마크업, 앱 CSS/폰트,
  `chat-render.ts`와 `dialog.ts`를 그대로 사용하는 fixture. 운영 서비스나
  실제 고객방을 가장한 화면이 아니다. 본문 열기 → 창 닫기 후 배너 유지 →
  배너 ×로 철회를 UI로 확인했다. 짧은 화면에서 본문 overflow와 End 스크롤,
  별도 커스텀 스크롤바 및 닫기 버튼 노출을 확인했다.
- 로컬 이미지: `scratch/announcement-full-view-desktop.jpg`,
  `scratch/announcement-full-view-small.jpg`, `scratch/announcement-full-view-mobile.jpg`.
  360×780 세로 화면에서 312px 패널·332px 본문이 잘리지 않는 것도 확인했다.
  미리보기 파일·이미지는 Git 제외 대상이다.

초기 전체 검사는 12,440 pass / 5 fail / 1 skip이었다. 실패는 새 parser의
배포 영향 목록·Worker coverage 등록 누락 2건, 제품 코드에서 실제로 사용하기
시작한 `destroyCustomScrollbar`로 test-only export가 21→20으로 줄어든 데 따른
기준 갱신 1건, 다른 전체 검사와 병렬 실행한 Git fixture의 시간 초과 2건이었다.
등록을 추가하고 export 기준을 20으로 강화했다. 타임아웃·검사 기준을 늘리거나
제외하지 않았다. jq 검사는 이미 설치된 WinGet 실행 파일을 명시해 재실행했다.

`npm run typecheck`, `npm run lint`, 최종 `npm run build:checked`는 통과했다.
후속 메타데이터 수정 파일의 ESLint·포맷·diff 검사도 통과했다.

최종 전체 단위 검사:

- 명령: `node node_modules/vitest/vitest.mjs run --maxWorkers=4`.
- `MXQR_TEST_JQ_PATH`는 이미 설치된 WinGet `jqlang.jq` 실행 파일을 가리켰다.
- 2026-10-13 02:55:20 KST 시작, 345.39초.
- **552파일 / 12,446 pass / 0 fail / 0 skip**.
- 로그: `scratch/notice-repair-unit-final.log`. 이전 실패 로그는
  `scratch/notice-repair-unit.log`에 보존했다. 앱 런타임·검사 타임아웃·격리 설정을
  완화하지 않고 병렬 worker 수만 제한했다. 로그의 가상 emergency deployment는
  테스트 fixture이며 실제 배포가 아니다.

## 한계와 후속 릴리스

- 공개 production 공지를 다시 켜거나 실서비스 5분 철회를 반복하지 않았다.
  기존 설치 PWA·iPhone Safari/VoiceOver·Android/TalkBack 실기 검증은 남는다.
- full E2E, 원격 CI, exact-main 후보, 배포 smoke를 실행한 것으로 간주하지 않는다.
- 새 의존성·D1 스키마·비밀·바인딩·데이터 마이그레이션은 없다. 새 parser는 기존
  API와 DO가 공유한다. 관리자 classic 스크립트는 import할 수 없어 현지 날짜
  파서를 별도로 갖고, 양쪽 회귀로 검증한다.
- API의 명시적 ISO timestamp 형식을 검증한다. `expiresAt` 키의 필수성은 이전과
  동일하고 `null` / 빈 문자열은 유지한다. 모호한 native Date 문자열은 거부한다.
- **후속 배포에는 App과 PRO Worker가 모두 필요하다.** Service Control DO의
  실제 소유 Worker가 PRO이므로 App-only 배포로 완료 처리하면 안 된다. 새 공통
  parser를 두 Worker의 배포 영향 목록과 Worker coverage 대상에 등록했다.
- 추가 revision 필드는 구 클라이언트에 호환된다. 갱신 전 클라이언트에는 철회와
  전체보기 수정이 적용되지 않는다. 롤백은 공지 결함을 되돌리지만 데이터 변환은 없다.
  revision을 보내지 않는 이전 App Worker로 롤백하면 새 클라이언트의 하향 응답
  차단이 적용되므로, 이미 새 코드를 연 탭은 새로고침해야 이전 공지 조회로 돌아간다.
- 정식 배포 전 버전/캐시 bump, PR 리뷰와 exact-main CI 및 정상 릴리스 절차가 필요하다.

## 정식 릴리스 준비 — 2026-10-13

- 오너가 전체보기 미리보기를 확인한 뒤 이번 수정의 배포를 승인했다.
- 제품 버전 `8.10.4`, 캐시 `v663`으로 올리고 package/lock, 관리자 자산/스크립트,
  bootstrap cache query를 함께 맞췄다. 위 전체 단위 검사는 버전 bump 직전의
  동일 동작 코드이며, 커밋 뒤 빌드와 원격 CI 결과는 따로 기록한다.
- 독립적인 백엔드·클라이언트 최종 읽기 전용 리뷰에서 추가 차단 결함은 없었다.
- 배포 대상은 App과 Service Control DO 소유 PRO Worker다. 현재 workflow에는
  두 대상의 묶음 선택이 없으므로 `target=all`, `apply_developer_api_d1=false`를
  사용한다. 나머지 Worker도 같은 SHA로 배포·smoke를 거치며 동작 변경은 없다.
- 공개 공지는 비활성 상태를 유지하고 점검 모드를 바꾸지 않는다. 이 문단은
  배포 계획이며 PR CI·exact-main CI·Production Release 성공을 대체하지 않는다.
