# 두 열 시작 화면의 로고 윗변 맞춤 (2026-10-20)

- Status: 8.11.28 UI 수정·검증·배포 기록이다. 배포 결과의 정본은 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이다.
- 계기: 오너 관찰(2026-10-20). 휴대폰 가로에서 시작 화면 로고가 그 자리를 이어받는 "안녕하세요!"보다 커 보였다.
  오너는 착시일 수 있다며 크기 조정은 보류하고 원인 조사를 요청했고, 조사 결과를 본 뒤 가로·태블릿의 로고 위치를
  세로·데스크톱처럼 맞추도록 지시했다.
- 커밋: `72daffeb`(수정)와 릴리스 식별자 `a2d47ffc`(8.11.28 / v737).

## 조사

e2e 빌드에서 임시 Playwright 측정(커밋하지 않음, 근거는 `scratch/greeting-size-illusion-2026-10-20/`)으로
ko-KR, 밝은·어두운 테마, 11가지 화면 크기에서 로고와 인사말 글자의 실제 잉크(보이는 픽셀) 범위를 쟀다.

- 크기는 모든 화면에서 같은 관계다. 로고 글자 높이는 인사말 글자보다 5~12% 크고(세로 23.5 / 22px, 가로
  844×390 19 / 18px, 태블릿 28 / 25px, 데스크톱 1440 30.5 / 28.5px), 폭은 인사말 글자의 약 1.8배(지구본
  아이콘 포함 1.4~1.5배), 잉크 면적은 약 2배다. 로고 높이와 제목 글자 크기 비율은 어디서나 약 0.9다(세로
  22 / 24, 가로 18 / 20, 데스크톱 29 / 32). 이 차이는 가로에만 있는 것이 아니다.
- 다른 점은 위치였다. 세로 휴대폰(`translateY(3px)`)과 데스크톱(`--setup-logo-mt` 3~5px)은 로고를 내려서 로고
  윗변이 인사말 윗변과 같거나 1~1.5px 아래에 오고 남는 높이는 아래로 간다. 폭 720~1279px의 두 열
  레이아웃(휴대폰 가로·태블릿)은 `--setup-logo-mt: 0px`라 로고 윗변이 인사말보다 2~3px 위로 튀어나왔다.
  로고가 인사말로 바뀔 때 윗선이 내려가며 줄어드는 것처럼 보였을 가능성이 크다(지각 설명은 추론이다).
- 폭 720px 미만의 가로 화면(667×375 등)은 세로와 같은 한 열 레이아웃이라 이미 맞춰져 있었다.

## 변경

`css/style.css`의 두 열 토큰에서 `--setup-logo-mt`를 `0px` 대신 세로 휴대폰과 같은 `3px`로 바꿨다. 로고와
인사말 크기, 세로·데스크톱 보정은 그대로다. 처음에는 로고 높이의 1/6(18px 로고 3px, 26px 로고 4.3px)으로
비례시켰는데, 오너가 태블릿에서 로고가 너무 내려갔다고 지적했다. 측정에서도 26px 태블릿 로고의 윗변이 1.3px
아래, 아랫변이 3.8px 아래로 모든 화면 중 가장 많이 내려가서 고정 3px로 바꿨다. 3px이면 18~26px 로고의 윗변이
인사말 윗변과 0~1px 안에서 맞는다.

## 검증

- 같은 측정의 수정 전/후, 로고 윗변이 인사말 윗변보다 아래에 있는 거리(px, 음수는 위로 튀어나옴):

  | 화면 | 수정 전 | 수정 후 |
  | --- | --- | --- |
  | 세로 360·390·430 | 1.0 | 1.0 |
  | 가로 667×375(한 열) | 1.0 | 1.0 |
  | 가로 844×390 | −2.5 | 0.5 |
  | 가로 932×430 | −2.0 | 1.0 |
  | 태블릿 768×1024·1024×768 | −3.0 | 0.0 |
  | 데스크톱 1280×800 | 1.0 | 1.0 |
  | 데스크톱 1440×900·1920×1080 | 1.5 | 1.5 |

  로고 상자 크기는 모든 화면에서 전후가 같다. 로고와 인사말의 중심 차이(로고가 아래)는 수정 뒤 두 열 레이아웃이
  1.0~1.5px로 세로(1.75px)·데스크톱(1.75~2.5px)과 비슷해졌다. 1/6 비례 시도와 고정 3px의 겹친 비교 이미지와
  측정값은 근거 폴더에 있다.
- 단위: `setup-carousel-motion.test.ts`에 세 레이아웃의 로고 보정(세로 3px, 데스크톱 clamp, 두 열 고정
  3px이고 `0px`이 아님)을 확인하는 검사를 더했다. 수정 전 CSS에서는 실패하고 수정 후 통과한다.
- 로컬 Windows, Node 24.20.0, 릴리스 식별자 커밋 `a2d47ffc`: `npm run typecheck`·린트·포맷·committed
  `build:checked` 통과, unit 597 files / 13,440 pass / 0 fail / 0 skip(새 계약 테스트 1개 추가), 소스 가드
  bus-pairing·dead-exports·import-graph·sw-cache-version·brand-capitalization 통과. 로컬 결과는 exact-main CI
  후보를 대신하지 않는다.

## Release and recovery

- PR [#420](https://github.com/hiefny/MUSIXQUARE/pull/420) squash merge → main `19552573`. PR head `291c2792`의 CI 39327088593
  11 jobs 통과. Codex 지적 1건(검증 항목의 두 열 보정 설명이 1/6로 남은 문구)은 반영했다. main 트리는 PR head와
  같다.
- Exact-main push CI [39370438116](https://github.com/hiefny/MUSIXQUARE/actions/runs/39370438116) 11 jobs 통과: unit 597 files /
  13,439 pass / 0 fail / 1 Windows-only skip, candidate browser 17 + critical browser 55 pass. 후보 artifact
  12240513735.
- 첫 두 배포 실행 [39371044098](https://github.com/hiefny/MUSIXQUARE/actions/runs/39371044098)(13:43 KST)·[39371530082](https://github.com/hiefny/MUSIXQUARE/actions/runs/39371530082)(13:48 KST)은
  App 배포(새 version `73e939bf`, `467e34f2`) 뒤 Standard HTTPS signaling smoke가
  `/api/standard-signaling/v1/bridge/open`에서 HTTP 502를 받아 실패했다(첫 번째는 방장 열기, 두 번째는 방장 열기 성공 뒤 게스트 열기). 502는 App Worker가 시그널링 Worker의
  Durable Object를 5초 안에 열지 못하거나 응답이 JSON이 아닐 때 나온다. 이번 변경은 CSS 한 줄이라 이 경로와
  무관하다. 두 번 모두 자동 복구가 App을 8.11.27 version `87ff6e7e`로 되돌리고(deployment `f69978da`,
  `57b295ca`) 소유권·floor·R2를 검증했으며, 직후 Drift Audit 39371361020도 31 / 0 / 5였다. Cloudflare 상태 페이지의
  진행 중 장애(Zero Trust 연결, Gateway DLP, WARP 위치)와 PHL 점검(14:00 KST 시작)은 이 경로와 직접 관련이
  없어 보였다.
- 진단: 오너 승인 뒤 두 Worker에 `wrangler tail`을 켜고 14:16 KST에 운영 8.11.27에서 같은 smoke를 한 번 돌렸다.
  통과했고 브리지 열기는 방장 1.17초·게스트 0.55초였다. 같은 로그를 켠 채 세 번째 실행을 했다.
- [Production Release 39374155277](https://github.com/hiefny/MUSIXQUARE/actions/runs/39374155277) attempt 1 성공, target=app, Developer API D1=false.
  2026-10-20 14:20:31 KST deploy job 완료. App version `9a932633-a36e-4198-b5f5-6d520ddaa96f` / deployment
  `ebe88791-7d43-4a18-b7ff-4aef96bfa63a`, 최종 소유권 14:20:26.797 KST verified, 부분 릴리스 recheck compatible,
  smoke 4/4(시그널링 브리지 열기는 Cloudflare ORD 경유 방장 1.23초·게스트 0.30초, 예외 없음), 기존 App D1 계약
  7단계 apply/verify 성공.
- 14:21 KST 공개 8 GET 모두 HTTP 200, exact-main 후보와 크기·SHA 일치(서비스 워커 v737). 14:22 KST 운영 페이지를
  844×390으로 열어 두 열 레이아웃에서 `--setup-logo-mt: 3px`, 18px 로고의 `translateY(3px)`를 확인했다. 배포 직후
  Drift Audit 39374443622: 31 pass / 0 fail / 5 manual-only.
- 복구: 14:19:12.929 KST checkpoint 12242468001이 App 8.11.27/v736(`eaf8734e`, version `87ff6e7e` / deployment
  `57b295ca`)을 보존한다. provenance는 verified-release-ancestor다. 성공한 실행의 롤백은 미실행이다. 롤백하면
  새로고침한 클라이언트는 두 열 시작 화면에서 로고 윗변이 다시 2~3px 위로 튀어나오고, 저장 데이터 마이그레이션은
  없다.
- 남은 관찰: 실패 시점의 502가 Durable Object 지연인지 다른 오류인지는 로그를 켜기 전이라 확인하지 못했다. 같은
  smoke가 다시 502로 실패하면 이번처럼 로그를 켜고 원인을 잡는다.

## 한계

실기 휴대폰·태블릿은 확인하지 않았다. 크기 차이에서 오는 인상(로고가 더 넓고 두꺼움)은 그대로이고, 오너가
크기 조정은 보류했다.
