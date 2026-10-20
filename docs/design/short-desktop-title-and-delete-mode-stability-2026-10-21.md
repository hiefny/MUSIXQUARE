# 낮은 데스크톱 제목 여백·삭제 모드 흔들림 수정·재생목록 편집 모드 개편 8.11.33 (2026-10-21)

- Status: 8.11.33 UI 수정·검증 기록이다. 배포 결과의 정본은 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이다.
- 계기: 8.11.32 배포 직후 오너가 운영 화면에서 두 가지를 짚었다.
  - 헤더 축소 데스크톱(가로 1280 px 이상, 높이 720~899 px)에서 재생목록과 설정 제목 위 여백이 거의 없다.
  - 삭제 모드에 들어가고 나올 때 재생목록 위치가 흔들린다. 삭제 모드가 아닐 때를 기준으로 고정한다.
- 같은 날 오너가 이어서 재생목록 편집 모드 개편과 도움말 탭 체험 버튼 색 복원을 요청했다(3·4절).
- 커밋: `01a3ce24`(제목 여백, 8.11.33), `fd5c7ba4`(삭제 모드 흔들림), `33b2781d`(서비스 워커 캐시 v745),
  `eda4d83b`(체험 버튼), `16d98a32`(편집 모드 개편), 마지막 서비스 워커 캐시 v746 커밋.

## 1. 낮은 데스크톱 제목 여백

- 원인: 8.11.32에서 이 구간의 재생목록·설정 칸을 화면 맨 위부터 쓰게 하면서, 제목을 왼쪽 로고 높이에 맞추려고 제목
  행의 위 여백을 32 px에서 12 px로 줄였다.
- 변경: 그 덮어쓰기를 지웠다. 칸이 화면 위에서 시작하므로 안전 영역(`--safe-top`)만 칸이 직접 비우고, 제목 행은 일반
  데스크톱과 같은 32 px 여백을 쓴다.
- 측정(Playwright Chromium, 빌드 결과): 1366×768에서 칸 위 0 px → 제목 32 px, 1440×900(일반 데스크톱)에서 칸 위 60 px →
  제목 92 px로 둘 다 32 px다. `e2e/desktop-height-layout.test.ts`가 낮은 데스크톱의 제목 위치를 일반 데스크톱 값과 비교한다.

## 2. 삭제 모드 들어갈 때·나올 때 흔들림

- 원인: 삭제 모드 헤더는 "N개 선택됨" 제목과 "전체 선택" 글자 버튼을 같은 글자 기준선에 둔다. 버튼의 44 px 터치 상자가
  기준선 아래로 내려가 데스크톱 헤더가 84 → 87 px로 3 px 커졌고, 휴대폰에서는 평소 행 높이를 정하던 아이콘 버튼(36 px)이
  숨으면서 헤더가 80 → 78 px로 2 px 줄었다(첫 수정 뒤 측정). 그만큼 목록이 위아래로 움직였다.
- 변경(`css/style.css`):
  - 전체 선택 버튼은 44 px 터치 상자를 유지하되 여백 상자를 16 px로 줄여(`margin: -14px 0 -14px 16px`) 제목 행보다 커지지
    않는다.
  - "N개 선택됨" 제목은 숨은 아이콘 버튼이 평소 만들던 36 px 행 높이(`line-height: 36px`)를 쓰고 글자는 그 가운데에 둔다.
  - 삭제·취소 묶음 pill이 아래 빈 공간을 차지해(`margin-bottom: auto`) 목록 몸통의 스크롤 높이가 모드와 상관없이 같다.
- 측정(빌드 결과, 목록 등장 움직임이 끝난 뒤): 휴대폰 390×844, 데스크톱 1440×900, 낮은 데스크톱 1366×768 모두 들어가기 전·
  삭제 모드·나온 뒤의 헤더 높이(80 / 84 / 84 px), 목록 위치(148 / 144 / 84 px), 스크롤 위치가 같다. 새 브라우저 테스트
  `e2e/playlist-delete-mode-layout.test.ts`가 세 화면에서 이 값을 고정한다.

## 3. 재생목록 편집 모드 개편

- 행의 X 대신 제목 오른쪽(X 자리)에 선택 동그라미를 둔다. 아무 행의 동그라미를 누르면 편집 모드(이전 삭제 모드)가 열리고 그
  행이 선택된다. 선택 전은 `--text-muted` 테두리 원, 선택 후는 `--primary-filled`로 채운 원에 흰 체크다. 체크 모양은 언어
  목록·대화상자 선택지의 체크 경로(`M5 12.5l4.2 4.2L19 6.9`)를 원 안에 줄여 그대로 쓴다. 저장소에 원형 체크 아이콘은 따로
  없어서 테두리 원만 새로 그렸다. 접근성 이름·`title`은 기존 `playlist.select_for_deletion`/`deselect_for_deletion`(42개 언어),
  상태는 `aria-pressed`다. 편집 권한(`queue.mutate`)이 있고 시스템 오디오가 아닐 때만 보인다.
- 선택한 행은 반투명 파란 바탕(`--control-active`: 라이트 0.11, 다크 0.13, 대비 강화 0.28)으로 칠한다. 홀로 선택된 행은
  pill, 이어진 행들은 한 덩어리다. 첫 행은 pill과 같은 위 모서리(행 높이의 절반, 28 px), 마지막 행은 같은 아래 모서리, 그
  사이와 8 px 행 간격은 각진 채로 이어진다(오너 정정: 20 px 둥근 사각형이 아니라 pill 반지름). 예: 1·2·4 선택 → 1–2는 한
  덩어리, 4는 따로 pill.
  - 구현: 행(`.playlist-entry`)의 `::before`가 바탕을 칠한다. 앞 행도 선택이면 바로 위 간격까지 올라가고(`top: -8px`), 시작·
    중간·끝은 형제 선택자와 `:has(+ …)`로 브라우저가 정한다. 그래서 선택이 바뀌거나 목록을 다시 그려도 JS 계산 없이 모양이
    따라오고, 위·아래 모서리만 다르므로 RTL도 그대로다. 바탕은 색만 0.16초 바뀐다(움직임 줄이기 설정에서는 즉시).
  - 한계: `:has()`가 없는 브라우저(Chromium 105 미만, 예: 오래된 TV)는 이어진 덩어리의 첫 행 아래 모서리가 둥글게 남는다.
    선택 동그라미는 그대로라 기능에는 지장이 없다. 강제 색상 모드에서는 선택 버튼이 Highlight가 되고, 선택 행 바탕은 옅은
    Highlight(투명도 0.35)다.
- 편집 모드 동안 YouTube 재생목록 항목은 하위 목록과 펼치기 화살표를 숨긴다(CSS `has-removal-selection`). 펼침 상태 자체는
  건드리지 않아 모드가 끝나면 각 항목이 원래대로 펼쳐지거나 접힌다.
- 여러 행 한 번에 고르기(`src/ui/playlist-selection-gestures.ts`, 시작 후 따로 불러옴):
  - 동그라미 열을 누른 채 위아래로 끌면 지나간 행이 모두 첫 행의 반대 상태가 된다(선택 안 된 행에서 시작하면 선택, 선택된 행에서
    시작하면 해제). 되돌아가면 제스처가 바꾼 행만 원래대로 돌아간다. 마우스·펜·터치가 같은 Pointer Events를 쓰고, 동그라미는
    `touch-action: none`이라 그 열에서는 스크롤이 시작되지 않는다. 8 px 넘게 움직여야 끌기가 되고, 그보다 짧으면 일반 탭(토글)이다.
    끌기 뒤의 클릭은 0.4초 동안 목록 안에서 막아 재생이나 토글이 따라 일어나지 않는다.
  - 터치 화면에서 두 손가락으로 목록을 위아래로 밀면 시작 행부터 현재 행까지 선택한다(필요하면 편집 모드 진입). 두 손가락이
    닿아 있는 동안 기본 스크롤을 막고, 손가락 간격이 48 px 넘게 바뀌면 핀치로 보고 놓는다. 이미 네이티브 스크롤이 시작돼
    취소할 수 없는 경우에도 놓는다. 한 손가락 스크롤·탭 재생·길게 눌러 순서 바꾸기는 그대로다(앱은 이미 확대를 막는다).
  - 끝 근처에 머물면 목록이 저절로 스크롤된다. 영역·속도 규칙은 순서 바꾸기(`playlist-reorder.ts`)와 같지만 코드는 옮겨
    적었다. 지연 모듈이 즉시 로드 모듈을 import하면 Vite가 공유 청크를 다시 나눠 초기 전송량이 늘기 때문이다(측정 약 +470 B gzip).
  - 선택이 비어 모드가 끝나는 일이 없도록 제스처는 추가를 먼저, 해제를 나중에 적용한다.
- 아래 묶음 pill은 그대로(surface-1, `--glass-border` 테두리, 마지막 곡 뒤, 넘치면 떠 있음, 끝날 때 내려가며 사라짐) 두고 안의
  글자 pill 두 개를 54 px 원형 아이콘 버튼으로 바꿨다. 삭제는 `--danger-filled` 바탕의 흰 휴지통, 취소는 `--surface-2` 바탕의
  `--text-main` X다. 이름·툴팁은 `common.delete`/`common.cancel`. 휴지통은 저장소에 없어 Material Icons의 `delete` 경로를 썼다
  (Apache 2.0, THIRD-PARTY-NOTICES 5절 범위). 버튼 높이가 그대로라 토스트 위치 보정(98 px)도 그대로다.
- 그대로 둔 것: 헤더의 선택 개수와 전체 선택 버튼(높이 고정), 바깥 탭·탭 전환·전체 해제로 끝나기, Escape, 즉시 삭제와
  "N개 삭제됨" 토스트, 남은 행 미끄러짐, 원격 삭제의 낙관적 숨김, 편집 모드 중 순서 바꾸기 끄기.
- 디자인 시스템 페이지(`/designsystem`)의 재생목록 예시도 선택 동그라미, 1–2행 선택 덩어리, 아이콘 버튼 묶음으로 바꿨다.

## 4. 도움말 탭 체험 버튼

- "앱 체험하기"(`#btn-demo-media`, `#btn-demo-media-mobile`)를 8.11.32 이전의 파란 강조 버튼(`accent-action-btn`)으로 되돌렸다.
  아래 "화면 보호기 켜기"도 그대로 파란색이다. 다른 사용처가 없는 `neutral-action-btn` 규칙은 지웠다.

## 검증 (1·2절)

- 로컬 Windows, Node 24.20.0 / npm 12.0.2, 코드 `33b2781d`: `npm run typecheck`·린트·포맷 통과, unit 603 files / 13,581
  pass / 0 fail / 0 skip, committed `build:checked`(release identity 8.11.33 / v745) 통과.
- Chromium e2e 25개 통과: 새 삭제 모드 레이아웃 3개와 `playlist`, `playlist-touch-reorder`, `playlist-desktop-reorder`,
  `desktop-height-layout`, `visualizer-layout`, `design-system-page`.
- 로컬 결과는 exact-main CI 후보를 대신하지 않는다. 실기기는 확인하지 않았다.

## 검증 (3·4절)

- 로컬 Windows, Node 24.20.0 / npm 12.0.2, 코드 `16d98a32` + 캐시 v746: `npm run typecheck`·`lint`·`format:check`,
  `guard:bus-pairing`·`guard:dead-exports`·`guard:import-graph`·`guard:room-authority-boundaries` 통과(핸들러 모양이 바뀌지 않아
  지문 갱신 없음). unit 604 files / 13,592 pass / 0 fail / 0 skip(새 `playlist-selection-gestures.test.ts` 8개 포함).
- committed `build:checked`(release identity 8.11.33 / v746) 통과. 초기 전송량: 즉시 로드 JS gzip 491,457 B(상한 491,568 B,
  기준 491,202 B에서 +255 B), 전체 gzip 568,986 B(상한 570,570 B), 진입 스크립트 444,040 B raw / 131,709 B gzip. 제스처
  모듈(5.1 KB raw / 2.0 KB gzip)은 즉시 로드에 들지 않는다. 즉시 로드 JS 여유가 111 B뿐이라 다음 변경은 다른 곳을 줄여야 한다.
- Chromium e2e 225개 통과, 0 실패(코드 변경 뒤 마지막 빌드로 `playlist-edit-mode`·`playlist-delete-mode-layout`·`playlist-touch-reorder` 8개 재실행): 새 `playlist-edit-mode` 4개(동그라미로 진입·1/2/4 선택 모양·아이콘 버튼, 마우스 끌기 선택/
  해제와 삭제, YouTube 접기와 복원, CDP 한 손가락 동그라미 열 끌기와 두 손가락 범위 선택), `playlist-delete-mode-layout` 3개,
  `playlist`, `playlist-touch-reorder`, `playlist-desktop-reorder`, `desktop-height-layout`, `design-system-page`,
  `component-cascade`, `critical-browser`, `release-smoke`, `screensaver`, 그리고 선택자를 바꾼 `chaos-scenarios`(1·2),
  `complex-scenarios`, `edge-cases`, `luna-session-sequences`, `youtube-sync`, `visualizer-layout`.
- 스크린숏(390×844·1440×900, 라이트·다크)으로 평소 목록, 1·2·4 선택 덩어리와 따로 선 pill, 접힌 YouTube 항목, 아이콘 묶음,
  도움말 버튼을 눈으로 확인했다.
- 한계: CDP 합성 터치는 움직이는 채로 손을 떼면 fling으로 읽혀 다음 탭이 클릭되지 않는다(빈 페이지에서도 재현). 테스트는 손을 떼기
  전에 멈춘다. 실기기(iOS Safari, Android Chrome)의 두 손가락 선택·동그라미 열 끌기·자동 스크롤, `:has()` 미지원 브라우저의
  모양은 확인하지 않았다. 로컬 결과는 exact-main CI 후보를 대신하지 않는다.

## 최종 통합 검증 (8.11.33)

편집 모드 개편, [Worker redirect 수정과 하이브리드 기기 마우스 올림](worker-redirect-mode-2026-10-21.md)을 합친 코드
`75826be4`(8.11.33 / v748), 로컬 Windows, Node 24.20.0: 타입·린트·포맷·가드 통과, unit 604+ files / 13,595 pass / 0 fail /
0 skip, committed `build:checked`(초기 전송 예산 eager JS 491,520 / 491,568 B gzip) 통과, Chromium e2e 229 pass(이번 묶음이
바꾼 e2e 전체와 critical-browser, release-smoke, background-resume, back-navigation, adaptive-actions). 초기 JS 예산 여유가
48 B라 다음 초기 로딩 코드 추가 전에 다른 곳을 줄여야 한다. 로컬 결과는 exact-main CI 후보를 대신하지 않는다.

## 선택 아이콘을 마이너스와 언어 선택 체크로 (오너 지시)

새 컴포넌트를 만들지 않도록, 선택 전 아이콘은 동그라미 대신 "−"(예전 삭제 X와 비슷한 약 9 px 폭, 획 1.9)로, 선택 후는 언어 선택 창의 체크 표시(`M5 12.5l4.2
4.2L19 6.9`, 굵기 2.4, 둥근 끝)를 그대로 쓴다. 두 아이콘은 같은 획 스타일이고 선택되면 파란색이다. 프로젝트에 마이너스 아이콘은
없어 같은 획 스타일의 가로선으로 그렸다. 디자인시스템 페이지 예시도 맞췄다.

마이너스와 오른쪽 꺽쇄는 터치 영역(각 44 px)이 여백 없이 붙어 있고 아이콘은 각 영역 가운데에 있다(보이는 간격 약 34 px,
예전 X와 같다). 오너가 이 간격을 그대로 두기로 했다.

## 편집 모드에서 행 누르기 (오너 지시)

편집 모드(한 곡 이상 선택)에서는 곡 제목 등 행의 나머지 부분을 눌러도 재생하지 않고 그 행을 선택하거나 해제한다. 마지막 선택을
풀면 편집 모드가 끝나고 제목은 다시 재생한다. 편집 모드가 아닐 때 길게 누르기는 지금처럼 순서 바꾸기다. e2e
`playlist-edit-mode`에 검사를 더했다.
