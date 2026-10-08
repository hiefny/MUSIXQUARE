# 베타 승격 후 2차 독립 QA — 30라운드 / 2026-10-09

| Field | Value |
| --- | --- |
| Status | Dated evidence — 감사 및 후보 재판정, 제품 수정 없음 |
| Applies to | 베타 승격 후 현재 main을 하나의 프로젝트로 본 2차 QA |
| Tested SHA | `e7c5529a3273c7132880dd0ad4572b2463405c87` |
| Execution | 2026-10-08~09 KST, `gpt-6-astra` / `ultra`, 3개 에이전트씩 10세트 |
| Environment | Windows x64, Node 24.20.0, npm 12.0.2, Vitest 5.0.0, Playwright 1.63.0, 로컬 Chromium·WebKit·PeerJS·Worker·SQLite |
| Related documents | [QA 범위](../beta-qa-domains.md), [현재 배포 기록](../beta-release-readiness.md), [이전 발견](beta-30-round-qa-2026-10-07.md), [이전 수정](beta-30-round-repair-2026-10-07.md) |

## 결과와 판정 기준

후속 상태: 사용자가 미확정 두 건의 기대 동작을 선택하고 15건 수정을 승인했다.
발견 당시 수치·실행 한계는 이 문서에 보존하며 현재 수정 결과는
[2026-10-09 후속 수정 기록](beta-30-round-repair-2026-10-09.md)을 따른다.

30/30라운드의 보고서를 수집해 원인·지원되는 사용자 경로·대조군·현재 계약을 다시 검토했다.
현재 확정 **13건(P1 0건 / P2 9건 / P3 4건)**, 미확정 **2건**, 결함 제외 **8건**이다.
실패한 테스트 개수나 같은 원인의 변형을 별도 결함으로 세지 않았다. 이 문서의 ID는 **2차 감사 내 ID**이며,
2026-10-07 보고서에서 같은 ID를 사용한 다른 발견과 구분한다. 이전 확정 12건의 수정은 회귀 대상으로 검토했다.
제외 수는 조사한 후보 항목 수다. R28-H01과 R29-H01처럼 같은 준비 오류가 다른 검사에서 반복된 경우도 있으며,
서로 다른 제품 결함 수를 뜻하지 않는다.

에이전트가 후보를 제출하면 root가 소스·원본 결과·실험 가정을 읽고, 확정 후보는 별도 입력/순서/포트의 재현 또는
독립 검증으로 확인했다. 30라운드 수집 완료 후 전체 판정·중복·증거 연결을 다시 점검했다.
계약 자체가 명확하지 않은 관측은 재현됐더라도 미확정으로 남겼다. P2는 기능·정합성·접근성 수정 대상,
P3는 제한된 표시·선호 설정 동작의 수정 대상이며, 실제 운영 피해나 모든 기기에서의 발생률을 뜻하지 않는다.

제품 코드·유지 테스트·설정·의존성·버전·캐시를 수정하지 않았다. 새 프로브와 원본 실패는 ignored
`scratch/qa-30round-2026-10-08/`에 보관했다. 최종 추적 변경은 이 보고서·현재 배포 준비 기록·문서 인덱스뿐이다.
PR·커밋·main 병합·배포·워크플로 변경은 수행하지 않았다. 현재 main에서 감사했으며 이미 종료된 대회 동결이나
옛 mxqr_beta 브랜치를 다시 적용하지 않았다.

## 확정 결함

| ID | 우선순위 | 확인한 결함 | 대표 소스 |
| --- | --- | --- | --- |
| R02-C01 | P2 | 파일 디코딩 중 PAUSE 뒤 자동 재생 | [src/player/playlist.ts](../../src/player/playlist.ts):1453 |
| R05-C01 | P2 | 호스트의 작은 시계 변경 뒤 방 타임라인 불일치 | [src/player/transport.ts](../../src/player/transport.ts):239 |
| R06-C01 | P2 | 권한 회수로 취소한 효과 드래그의 부활 | [src/ui/range-drag.ts](../../src/ui/range-drag.ts):111 |
| R07-C01 | P2 | 진행 중 직접 파일 전송의 경로 판단 불일치 | [src/storage/transfer-receive.ts](../../src/storage/transfer-receive.ts):467 |
| R07-C02 | P2 | 프리로드 데이터가 START보다 먼저 도착하면 시작 메시지 누락 | [src/network/protocol.ts](../../src/network/protocol.ts):1344 |
| R10-C01 | P2 | 도메인에 대문자가 있는 정상 YouTube 주소 거부 | [src/youtube/search.ts](../../src/youtube/search.ts):96 |
| R13-C01 | P3 | 닉네임 변경 뒤 늦은 재접속 응답이 이전 이름을 복원 | [src/pro-room/session-controller.ts](../../src/pro-room/session-controller.ts):303 |
| R16-C01 | P2 | 로그인 신원 반영 지연으로 같은 계정의 통계 중복 집계 | [src/account/activity-stats.ts](../../src/account/activity-stats.ts):183 |
| R16-C02 | P3 | 계정 전환 뒤 새 계정 통계가 빈칸으로 남음 | [src/app.ts](../../src/app.ts):1102 |
| R22-C01 | P2 | YouTube 입력창이 키보드 포커스 순환에서 빠짐 | [src/ui/player-controls.ts](../../src/ui/player-controls.ts):528 |
| R22-C02 | P2 | 동작 줄이기 설정에서 싱크 창 포커스·첫 Escape 실패 | [src/ui/manual-sync-overlay-runtime.ts](../../src/ui/manual-sync-overlay-runtime.ts):335 |
| R23-C01 | P3 | 알림음을 끈 뒤 대기하던 미리듣기가 재생 예약됨 | [src/ui/settings.ts](../../src/ui/settings.ts):969 |
| R30-C01 | P3 | 진단의 최근 30분 기록에 오래된 이벤트가 포함됨 | [src/ui/onboarding-diagnostics.ts](../../src/ui/onboarding-diagnostics.ts):126 |

### R02-C01 — 파일 디코딩 중 PAUSE 뒤 자동 재생

호스트의 파일 디코딩을 기다리는 동안 실제 등록된 MediaSession PAUSE가 들어와도, 디코딩 완료 후 목록의 자동 시작이 새 PLAY를 만든다. transport의 시작 취소와 playlist의 load intent 수명이 연결되지 않은 경계다. 별도 두 파일 선택을 사용한 root의 native Chromium에서도 STOP 대조군은 통과하고 PAUSE 뒤 실제 AudioBufferSource가 시작됐다. OS·헤드셋 버튼 전달 자체는 실기 미확인이다.

소스: [src/player/playlist.ts](../../src/player/playlist.ts):1453, [src/player/transport.ts](../../src/player/transport.ts):1834, [src/player/media-session.ts](../../src/player/media-session.ts):368.

독립 근거: [independent/host-pause.test.ts](../../scratch/qa-30round-2026-10-08/independent/host-pause.test.ts), [independent/host-pause.json](../../scratch/qa-30round-2026-10-08/independent/host-pause.json), [independent/host-pause.log](../../scratch/qa-30round-2026-10-08/independent/host-pause.log), [independent/host-pause-command.json](../../scratch/qa-30round-2026-10-08/independent/host-pause-command.json).

### R05-C01 — 호스트의 작은 시계 변경 뒤 방 타임라인 불일치

정상 출력 중 호스트 벽시계가 앞으로 250ms 초과·2초 이하 이동하면, 물리 출력 재기준화와 큰 시계 변경 감지 사이의 빈 구간에 들어간다. 실제 오디오는 계속 정상인데 공유 위치·PONG·종료 판단이 앞당겨진다. root의 +400/+1500ms 변형은 실패하고 +2200ms 대조는 통과했다. auditor의 native +1000ms 재현에서는 늦게 들어온 게스트가 약 0.984초 앞선 위치로 시작했다. 실제 OS 시계 변경 빈도나 스피커 음향은 측정하지 않았다.

소스: [src/player/transport.ts](../../src/player/transport.ts):239, [src/player/transport.ts](../../src/player/transport.ts):241, [src/player/transport.ts](../../src/player/transport.ts):255.

독립 근거: [independent/clock.test.ts](../../scratch/qa-30round-2026-10-08/independent/clock.test.ts), [independent/clock.json](../../scratch/qa-30round-2026-10-08/independent/clock.json), [independent/clock-command.json](../../scratch/qa-30round-2026-10-08/independent/clock-command.json), [round-05/browser-native-final.json](../../scratch/qa-30round-2026-10-08/round-05/browser-native-final.json).

### R06-C01 — 권한 회수로 취소한 효과 드래그의 부활

효과 슬라이더를 누른 상태에서 권한을 회수했다가 다음 pointer 이벤트 전에 재부여하면, 새 pointerdown 없이 이전 드래그가 값을 바꾼다. 권한 표시가 disabled로 바뀌어도 range-drag의 포인터 소유권이 즉시 정리되지 않는다. root의 별도 포트 native 재검증에서 decay 6→8.5 변경을 확인했고 새 제스처 대조는 통과했다. 변경은 권한이 돌아온 뒤 발생하므로 권한 없는 쓰기 우회로 분류하지 않는다.

소스: [src/ui/range-drag.ts](../../src/ui/range-drag.ts):111, [src/ui/settings.ts](../../src/ui/settings.ts):147.

독립 근거: [independent/authority.json](../../scratch/qa-30round-2026-10-08/independent/authority.json), [independent/authority.log](../../scratch/qa-30round-2026-10-08/independent/authority.log), [independent/authority-command.json](../../scratch/qa-30round-2026-10-08/independent/authority-command.json), [round-06/native-boundaries.spec.ts](../../scratch/qa-30round-2026-10-08/round-06/native-boundaries.spec.ts).

### R07-C01 — 진행 중 직접 파일 전송의 경로 판단 불일치

직접 전송을 시작한 같은 연결이 이후 remote로 재분류되면, 송신자는 기존 세션의 direct 할당을 유지하지만 수신자는 현재 분류를 보고 남은 정상 청크를 버린다. 일반 파일과 프리로드가 같은 원인의 영향을 받는다. root가 정상 송신자·코덱·프로토콜과 다른 파일 크기로 재현했고 stable-local 대조는 완료됐다. 해당 고정 할당에는 R2 인계도 생기지 않았다. 실제 ICE 경로 변경 발생률은 측정하지 않았다.

소스: [src/storage/transfer-receive.ts](../../src/storage/transfer-receive.ts):467, [src/storage/preload.ts](../../src/storage/preload.ts):1569, [src/storage/preload.ts](../../src/storage/preload.ts):1909, [src/share/file-delivery-policy.ts](../../src/share/file-delivery-policy.ts):274.

독립 근거: [independent/transfer.test.ts](../../scratch/qa-30round-2026-10-08/independent/transfer.test.ts), [independent/transfer.json](../../scratch/qa-30round-2026-10-08/independent/transfer.json), [independent/transfer-command.json](../../scratch/qa-30round-2026-10-08/independent/transfer-command.json), [round-07/valid-transfer-probes.test.ts](../../scratch/qa-30round-2026-10-08/round-07/valid-transfer-probes.test.ts).

### R07-C02 — 프리로드 데이터가 START보다 먼저 도착하면 시작 메시지 누락

서로 독립적인 control/bulk 채널에서 정상 프리로드 bulk가 START보다 먼저 도착할 수 있다. 아직 세션이 승인되지 않아 정상 청크가 일반 메시지 버킷을 소진하고, 뒤늦은 START 자체가 차단된다. root의 64청크·4MiB 변형도 실패했고 header-first 대조는 완료됐다. auditor는 모든 바이트가 보존된 상태에서도 세션·복구 watchdog이 생기지 않으며, 같은 START를 나중에 다시 전달하면 조립됨을 확인했다. 정상 송신자 출력만 사용했으며 과거 차단된 비정상 프레임 실험은 재구성하지 않았다.

소스: [src/network/protocol.ts](../../src/network/protocol.ts):1344, [src/storage/preload.ts](../../src/storage/preload.ts):1544, [src/network/transport/cloudflare-signaling.ts](../../src/network/transport/cloudflare-signaling.ts):847.

독립 근거: [independent/preload-order.test.ts](../../scratch/qa-30round-2026-10-08/independent/preload-order.test.ts), [independent/preload-order.json](../../scratch/qa-30round-2026-10-08/independent/preload-order.json), [independent/preload-order-command.json](../../scratch/qa-30round-2026-10-08/independent/preload-order-command.json), [round-07/valid-transfer-probes.test.ts](../../scratch/qa-30round-2026-10-08/round-07/valid-transfer-probes.test.ts).

### R10-C01 — 도메인에 대문자가 있는 정상 YouTube 주소 거부

YouTube 주소의 호스트명이 대문자 또는 대소문자 혼합이면 원문 정규식이 이를 거부한다. native URL이 같은 호스트로 정규화하는 정상 주소인데도 미리보기에서 잘못된 링크로 판단해 추가 버튼이 비활성화된다. root는 다른 영상 ID의 watch/short/live 세 변형과 양성·음성 대조를 확인했다. 실제 앱에서도 소문자 주소는 추가되고 대문자 주소는 15초간 거부됐다. 공급자 호출 전에 발생하므로 실제 YouTube 서비스 장애와 무관한 입력 처리 결함이다.

소스: [src/youtube/search.ts](../../src/youtube/search.ts):96, [src/youtube/search.ts](../../src/youtube/search.ts):134, [src/youtube/search.ts](../../src/youtube/search.ts):811.

독립 근거: [independent/youtube-hostcase.test.ts](../../scratch/qa-30round-2026-10-08/independent/youtube-hostcase.test.ts), [independent/youtube-hostcase.json](../../scratch/qa-30round-2026-10-08/independent/youtube-hostcase.json), [independent/youtube-hostcase-command.json](../../scratch/qa-30round-2026-10-08/independent/youtube-hostcase-command.json), [round-10/browser-first.json](../../scratch/qa-30round-2026-10-08/round-10/browser-first.json).

### R13-C01 — 닉네임 변경 뒤 늦은 재접속 응답이 이전 이름을 복원

같은 계정·같은 멤버가 닉네임을 바꾼 뒤, 이전 snapshot을 보관한 재접속 요청이 더 늦게 발급된 유효 티켓으로 완료되면 로컬 이름과 채팅 자기 표시를 이전 이름으로 덮어쓴다. root의 다른 이름·revision 변형에서 정상·오래된 sequence 대조는 통과하고 새로 발급된 sequence의 늦은 응답은 실패했다. 일반 heartbeat로 약 15초 후 회복됐다. 서버 멤버 교체·권한 우회·원격 채팅 위조는 입증되지 않은 P3 표시 일관성 문제다.

소스: [src/pro-room/session-controller.ts](../../src/pro-room/session-controller.ts):303, [src/pro-room/session-controller.ts](../../src/pro-room/session-controller.ts):326, [src/pro-room/network-bridge.ts](../../src/pro-room/network-bridge.ts):488, [src/ui/chat.ts](../../src/ui/chat.ts):1231.

독립 근거: [independent/runtime-label.test.ts](../../scratch/qa-30round-2026-10-08/independent/runtime-label.test.ts), [independent/runtime-label.json](../../scratch/qa-30round-2026-10-08/independent/runtime-label.json), [independent/runtime-label-command.json](../../scratch/qa-30round-2026-10-08/independent/runtime-label-command.json), [independent/runtime-label-detail.log](../../scratch/qa-30round-2026-10-08/independent/runtime-label-detail.log).

### R16-C01 — 로그인 신원 반영 지연으로 같은 계정의 통계 중복 집계

먼저 들어온 동일 계정 기기가 있는 방에서 나중 기기가 익명으로 참여한 뒤 로그인한다. 계정 로그인과 방의 인증된 멤버 반영 사이가 1초를 넘으면, 통계 수집기가 아직 익명인 상태에서 자신을 집계 기기로 확정한다. 이후 같은 계정임이 반영돼도 결정을 고치지 않아 청취 시간·곡 수를 계속 중복 집계한다. root의 500ms 대조는 통과했고 1600/3200ms 뒤 신원 반영 변형은 추가 16초 동안 중복 delta를 냈다. 나갔다 다시 들어오면 회복된다. 실제 여러 물리 기기의 발생률은 측정하지 않았다.

소스: [src/account/activity-stats.ts](../../src/account/activity-stats.ts):183, [src/account/activity-stats.ts](../../src/account/activity-stats.ts):681, [src/account/activity-stats.ts](../../src/account/activity-stats.ts):694.

독립 근거: [independent/account-counting.test.ts](../../scratch/qa-30round-2026-10-08/independent/account-counting.test.ts), [independent/account-counting.test.ts.provenance.json](../../scratch/qa-30round-2026-10-08/independent/account-counting.test.ts.provenance.json), [independent/account-counting.json](../../scratch/qa-30round-2026-10-08/independent/account-counting.json), [independent/account-counting-command.json](../../scratch/qa-30round-2026-10-08/independent/account-counting-command.json).

### R16-C02 — 계정 전환 뒤 새 계정 통계가 빈칸으로 남음

이전 계정의 미전송 활동이 남아 있는 상태에서 열린 계정 창을 새 계정으로 전환하면, UI 구독자가 통계 수집기의 계정 전환 처리보다 먼저 조회를 시작한다. 이전 flush가 uncertain으로 끝난 뒤 새 계정 GET을 하지 않아 제목만 새 계정으로 바뀌고 통계는 '-'로 남는다. root의 별도 native 실행에서 다른 이름·숫자로 재현했고 창을 닫았다 열면 회복됐다. 이전 활동을 먼저 flush한 대조군은 즉시 표시됐다. 서버 scope 검사는 정상이라 다른 계정에 잘못 쓰는 문제는 아니다.

소스: [src/app.ts](../../src/app.ts):1102, [src/ui/account.ts](../../src/ui/account.ts):421, [src/ui/account.ts](../../src/ui/account.ts):424, [src/account/activity-stats.ts](../../src/account/activity-stats.ts):440.

독립 근거: [independent/account-display.browser.spec.ts](../../scratch/qa-30round-2026-10-08/independent/account-display.browser.spec.ts), [independent/account-display.browser.spec.ts.provenance.json](../../scratch/qa-30round-2026-10-08/independent/account-display.browser.spec.ts.provenance.json), [independent/account-display.json](../../scratch/qa-30round-2026-10-08/independent/account-display.json), [independent/account-display-parsed.json](../../scratch/qa-30round-2026-10-08/independent/account-display-parsed.json).

### R22-C01 — YouTube 입력창이 키보드 포커스 순환에서 빠짐

빈 YouTube 입력창에서 Tab으로 취소 버튼에 간 뒤 Tab 또는 Shift+Tab을 눌러도 입력창으로 돌아오지 않는다. contenteditable을 선택하는 코드가 tabIndex가 음수인 요소를 다시 제외하는데, 실제 입력창에는 명시적 tabindex가 없다. root의 별도 native 키보드 재현에서도 역방향 이동이 실패했고 일반 미디어 선택창 순환과 Escape 복귀는 통과했다. Chromium DOM·키보드 근거이며 실물 스크린리더 검증은 아니다.

소스: [src/ui/player-controls.ts](../../src/ui/player-controls.ts):528, [index.html](../../index.html):3855.

독립 근거: [independent/ui-boundaries.browser.spec.ts](../../scratch/qa-30round-2026-10-08/independent/ui-boundaries.browser.spec.ts), [independent/ui-boundaries.json](../../scratch/qa-30round-2026-10-08/independent/ui-boundaries.json), [independent/ui-boundaries.raw.log](../../scratch/qa-30round-2026-10-08/independent/ui-boundaries.raw.log), [independent/ui-boundaries-command.json](../../scratch/qa-30round-2026-10-08/independent/ui-boundaries-command.json).

### R22-C02 — 동작 줄이기 설정에서 싱크 창 포커스·첫 Escape 실패

동작 줄이기를 켠 데스크톱에서 싱크 창을 열면 창은 보이지만 포커스는 BODY에 남고 첫 Escape도 닫지 못한다. root는 고대비 없이 Space로 여는 다른 재현에서 확인했다. 일반 모션 대조는 정상이고 Tab으로 입력창에 들어간 뒤 Escape를 누르면 회복된다. 즉시 focus 처리와 매우 짧은 visibility transition 사이의 타이밍 문제로 추정되지만 정확한 CSS 실행 순서는 완전히 입증하지 않았다. 사용자 동작 실패 자체는 독립 확인됐다.

소스: [src/ui/manual-sync-overlay-runtime.ts](../../src/ui/manual-sync-overlay-runtime.ts):335, [src/ui/manual-sync-overlay-runtime.ts](../../src/ui/manual-sync-overlay-runtime.ts):346, [css/style.css](../../css/style.css):8231, [css/style.css](../../css/style.css):9966.

독립 근거: [independent/reduced-focus.browser.spec.ts](../../scratch/qa-30round-2026-10-08/independent/reduced-focus.browser.spec.ts), [independent/reduced-focus.json](../../scratch/qa-30round-2026-10-08/independent/reduced-focus.json), [independent/reduced-focus.raw.log](../../scratch/qa-30round-2026-10-08/independent/reduced-focus.raw.log), [independent/reduced-focus-command.json](../../scratch/qa-30round-2026-10-08/independent/reduced-focus-command.json).

### R23-C01 — 알림음을 끈 뒤 대기하던 미리듣기가 재생 예약됨

알림음 ON 미리듣기가 AudioContext.resume을 기다릴 때 OFF로 바꿔도, resume 완료 뒤 55ms 미리듣기 한 번이 예약된다. 설정에서 force:true로 요청한 미리듣기가 비동기 대기 뒤 새 OFF 선택을 다시 적용하지 않는다. root의 실제 키보드 ON→OFF 변형에서도 재현됐고 ON 유지 대조는 정상이다. 실제 오디오 소스 예약을 확인했으며 스피커 소리나 OS에서의 발생 빈도까지 측정한 것은 아니다.

소스: [src/ui/settings.ts](../../src/ui/settings.ts):969, [src/audio/ui-sounds.ts](../../src/audio/ui-sounds.ts):60, [src/audio/ui-sounds.ts](../../src/audio/ui-sounds.ts):146.

독립 근거: [independent/sound-preview.browser.spec.ts](../../scratch/qa-30round-2026-10-08/independent/sound-preview.browser.spec.ts), [independent/sound-preview-provenance.json](../../scratch/qa-30round-2026-10-08/independent/sound-preview-provenance.json), [independent/ui-boundaries.json](../../scratch/qa-30round-2026-10-08/independent/ui-boundaries.json), [independent/ui-boundaries.raw.log](../../scratch/qa-30round-2026-10-08/independent/ui-boundaries.raw.log).

### R30-C01 — 진단의 최근 30분 기록에 오래된 이벤트가 포함됨

페이지를 오래 열어두면 진단 화면의 최근 30분 타임라인에 그보다 오래된 이벤트가 남는다. 시간 제한은 초기 저장 기록 복원 때만 적용되고 새 이벤트 기록·snapshot 생성 시에는 80개 수량 제한만 적용된다. root는 실제 초기화·진단창 열기와 다른 시간 경계를 사용해 29분17초 대조는 통과하고 31분17초의 이전 offline 이벤트는 잘못 남는 것을 확인했다. 같은 저장 기록을 새 페이지처럼 복원하면 오래된 항목이 제거된다. 제어된 시계와 JSDOM DOM 근거이며, 무한 메모리 증가나 보안 노출을 주장하지 않는 P3 진단 정확성 문제다.

소스: [src/ui/onboarding-diagnostics.ts](../../src/ui/onboarding-diagnostics.ts):126, [src/ui/onboarding-diagnostics.ts](../../src/ui/onboarding-diagnostics.ts):385, [src/ui/onboarding-diagnostics.ts](../../src/ui/onboarding-diagnostics.ts):91.

독립 근거: [independent/diagnostic-window.test.ts](../../scratch/qa-30round-2026-10-08/independent/diagnostic-window.test.ts), [independent/diagnostic-window.json](../../scratch/qa-30round-2026-10-08/independent/diagnostic-window.json), [independent/diagnostic-window.log](../../scratch/qa-30round-2026-10-08/independent/diagnostic-window.log), [independent/diagnostic-window-command.json](../../scratch/qa-30round-2026-10-08/independent/diagnostic-window-command.json).

## 미확정과 제외

**미확정은 결함 수에 포함하지 않는다.** 이상 동작을 관측했지만 현재 요구사항 위반 여부 또는 독립 입증이 부족한
상태다. 문제가 없다고 확정한 것도 아니다. 아래 항목은 먼저 요구를 정한 뒤 그 요구에 맞는 수정·검증 여부를 결정한다.

### R17-C01 — 요청 접수 후 키 회수·만료의 적용 시점

기존 실험에서 인증을 통과했지만 본문이 아직 도착하지 않은 요청은 키 회수·만료 뒤에도 완료될 수 있었고, 새 요청은 거부됐다. 이 동작은 관측됐으나, 제품 계약이 인증 시점을 요청 접수로 볼지 실제 변경 직전으로 볼지 명시하지 않는다. QA 가이드의 더 엄격한 기대만으로 확정하지 않았다. root의 별도 변형에는 내부 숫자 enum과 공개 문자열을 비교한 관측기 오류도 있어 깨끗한 독립 검증으로 세지 않는다. Daybreak 제한 확인 뒤 추가 보안 재현은 중단했다.

소스: [cloudflare/developer-api-worker.ts](../../cloudflare/developer-api-worker.ts):2362, [cloudflare/developer-api-worker.ts](../../cloudflare/developer-api-worker.ts):2445, [cloudflare/developer-api-worker.ts](../../cloudflare/developer-api-worker.ts):645, [scripts/developer-api-key.mts](../../scripts/developer-api-key.mts):399, [cloudflare/pro-room-worker.ts](../../cloudflare/pro-room-worker.ts):6430. 근거: [round-17/boundaries-final.json](../../scratch/qa-30round-2026-10-08/round-17/boundaries-final.json), [round-17/boundaries.test.ts](../../scratch/qa-30round-2026-10-08/round-17/boundaries.test.ts), [round-17/report.md](../../scratch/qa-30round-2026-10-08/round-17/report.md).

### R20-C01 — 공지 만료 뒤 관리자 상태 문구의 갱신 기준

공지 만료 시 탭의 활성 표시만 사라지고 본문의 Active 문구는 Refresh 전까지 남는다. native 브라우저와 root의 다른 만료 시간으로 동작은 재현됐다. 다만 마지막 조회 시각·명시적 Refresh·만료 시각이 함께 표시되므로 본문이 조회 시점의 snapshot일 가능성이 있다. 실시간 문구 갱신 요구가 명확하지 않고 공개 공지 전달·저장·운영 조작 오류도 입증되지 않아, P3 표시 개선 또는 요구사항 확인 항목으로 남겼다.

소스: [browser/classic-runtime/admin.ts](../../browser/classic-runtime/admin.ts):5891, [browser/classic-runtime/admin.ts](../../browser/classic-runtime/admin.ts):5931. 근거: [independent/admin-expiry.test.ts](../../scratch/qa-30round-2026-10-08/independent/admin-expiry.test.ts), [independent/admin-expiry.json](../../scratch/qa-30round-2026-10-08/independent/admin-expiry.json), [independent/admin-expiry-command.json](../../scratch/qa-30round-2026-10-08/independent/admin-expiry-command.json).

| 제외 ID | 이유 |
| --- | --- |
| R03-X1 | 일반 확인창은 dismissible을 명시한 경우에만 Escape로 닫힌다. 기본값은 닫히지 않도록 소스와 유지 테스트가 명시하며 실제 Cancel과 후속 입력은 정상이라 결함에서 제외했다. |
| R18-X01 | 만료 예약은 재등장 방지를 위한 quiet 기간 동안 tombstone으로 보존하며, 그동안 용량 과금에는 포함하지 않는다. 실제 바이트 삭제·다음 sweep·quiet 기간 후 제거는 정상이라 즉시 빈 map을 기대한 검사 오류로 제외했다. |
| R24-H01 | 공개 페이지 언어 메뉴는 opacity 0과 pointer-events none으로 닫히지만 Playwright 가시성 판정은 opacity 0을 숨김으로 보지 않는다. root는 CSS와 ARIA·tabIndex 정리를 확인했고, 네 언어의 별도 후속 검사에서 초점 복귀·Tab 제외·ARIA 숨김이 통과했다. 원본 네 실패는 보존하되 제품 결함에서는 제외했다. |
| R26-X01 | 원본 오프라인 실패는 precache 요청에는 없던 Origin이 모듈 요청에 들어가 Vite의 Vary: Origin 응답과 다른 캐시 항목으로 판단된 결과다. 제품 배포의 정적 헤더는 CORS가 없음을 명시한다. 실제 헤더 계약에 맞춘 preview.cors=false에서 동일한 첫 오프라인 검사가 통과했고, 원래 미리보기에서도 추가 온라인 reload로 Origin 변형을 채우면 통과했다. 설치 실패나 제품 캐시 결함으로 세지 않는다. |
| R26-X02 | v636 안내가 열린 채 v637이 도착하면 다른 탭이 v637 안내를 열 수 있다. 현재 보장하는 것은 같은 세대의 단일 안내이며, 이미 열린 안내의 선택을 최신 대기 Worker에 적용하는 동작은 유지 검사에 명시돼 있다. 원래 안내에서 Refresh를 누르면 최신 v637에 SKIP_WAITING 한 번만 보내고, 다른 탭도 자신의 선택 뒤 한 번만 다시 열린다. 잘못된 세대 활성화·중복 조작·갱신 실패가 없어 전 세대에 걸친 단일 안내를 기대한 검사 오류로 제외했다. |
| R28-H01 | 첫 파일 업로드는 준비 뒤 사용자 Play를 기다리도록 명시돼 있다. 두 데모 검사에서 그 조작 없이 playing 상태를 기대해 실패했다. root가 해당 소스와 유지 helper를 확인했고, 같은 WAV·같은 15초 제한에서 준비→실제 Play 후 원래 데모·소스 복원 검사가 통과했다. 제품 디코딩 결함으로 세지 않으며 원본 두 실패는 보존했다. |
| R29-H01 | 여러 게스트 검사도 첫 파일 업로드 뒤 사용자 Play를 생략하고 모든 기기의 playing 상태를 기다렸다. 첫 파일 수동 시작 계약에 맞춘 준비→Play 뒤에는 게스트 8개와 여섯 차례 곡 교체가 통과했다. 누락된 큐 준비 대기와 원본 실패도 함께 보존했다. |
| R29-H02 | 초기 스크립트에 등록한 pagehide 관측기가 앱의 종료 처리보다 먼저 실행됐다. 그 순간 재생 자원이 남아 있는 것을 종료 후 누수로 해석할 수 없다. root가 이벤트 등록 순서와 실제 Leave의 페이지 이동 경로를 확인했고, 저장된 마지막 기록에서 새 문서 9개 모두 파일·프리로드·큐·연결·출력 상태가 비워졌음을 확인했다. 다만 이전 문서의 실제 메모리 회수까지 측정하지 않았고 최종 브라우저 결과는 1 pass/1 관측기 fail 그대로 남긴다. |

## 10세트 / 30라운드 범위

각 라운드의 소스 검토·실험·원본 실패·대조군·정확한 명령과 시간은 아래 로컬 보고서에 남겼다.
보고서 사이에 같은 유지 테스트가 겹치므로 라운드 통과 수를 합산하지 않는다.
QA 상태는 tested=제한을 명시한 실제 실행, reviewed=소스/기존 증거 검토,
blocked=필요한 실행 제한, not-run=이번 미실행을 뜻한다. tested도 해당 도메인의 모든 환경 통과를 뜻하지 않는다.

| 세트 | 라운드 | 담당 범위 | QA ID | 후보 최종 판정 | 상세 근거 |
| --- | --- | --- | --- | --- | --- |
| 1 | 01 | 큐·목록 | QA001, QA002 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-01/report.md) |
| 1 | 02 | 재생 명령·상태 | QA003, QA004, QA005, QA006, QA007 | R02-C01 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-02/report.md) |
| 1 | 03 | 파일 입력·기본 디코딩 | QA008, QA009, QA010, QA011 | R03-X1 excluded | [보고서](../../scratch/qa-30round-2026-10-08/round-03/report.md) |
| 2 | 04 | 대용량 엔진 | QA012, QA013, QA014, QA015, QA016 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-04/report.md) |
| 2 | 05 | 공유 시계·파일 싱크 | QA017, QA018, QA019 | R05-C01 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-05/report.md) |
| 2 | 06 | DSP·출력 장치 | QA020, QA021, QA022, QA023, QA024, QA025, QA026, QA027, QA028 | R06-C01 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-06/report.md) |
| 3 | 07 | P2P 전송·프리로드 | QA032, QA033, QA034, QA035, QA036 | R07-C01 confirmed; R07-C02 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-07/report.md) |
| 3 | 08 | Standard 방·시그널링 | QA037, QA038, QA039, QA040, QA041, QA042 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-08/report.md) |
| 3 | 09 | RAM·자원 정리 | QA029, QA030, QA117, QA118 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-09/report.md) |
| 4 | 10 | YouTube 입력·iframe | QA047, QA048, QA049, QA050, QA052 | R10-C01 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-10/report.md) |
| 4 | 11 | YouTube 동기화 | QA051, QA053, QA054, QA055 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-11/report.md) |
| 4 | 12 | 시스템 오디오 공유 | QA043, QA044, QA045, QA046 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-12/report.md) |
| 5 | 13 | PRO 입장·권한 | QA059, QA060, QA061, QA062 | R13-C01 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-13/report.md) |
| 5 | 14 | PRO 재생·상태 수렴 | QA063, QA064, QA065, QA067 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-14/report.md) |
| 5 | 15 | 방 세대·DB | QA090, QA091, QA092, QA093 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-15/report.md) |
| 6 | 16 | 계정·인증·탈퇴 | QA068, QA069, QA070, QA071, QA072 | R16-C01 confirmed; R16-C02 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-16/report.md) |
| 6 | 17 | Developer API | QA073, QA074, QA075, QA076 | R17-C01 provisional | [보고서](../../scratch/qa-30round-2026-10-08/round-17/report.md) |
| 6 | 18 | Remote Share·PRO 저장 미디어 | QA066, QA083, QA084, QA085 | R18-X01 excluded | [보고서](../../scratch/qa-30round-2026-10-08/round-18/report.md) |
| 7 | 19 | 채팅·명령·BOT | QA077, QA078, QA079, QA080, QA081, QA082 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-19/report.md) |
| 7 | 20 | 관리자·서비스 정책 | QA086, QA087, QA088, QA089 | R20-C01 provisional | [보고서](../../scratch/qa-30round-2026-10-08/round-20/report.md) |
| 7 | 21 | 공개 요청 보안 | QA094 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-21/report.md) |
| 8 | 22 | 제어 UI·접근성 | QA096, QA097, QA098, QA099, QA101 | R22-C01 confirmed; R22-C02 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-22/report.md) |
| 8 | 23 | 모바일·시각 요소 | QA100, QA102, QA103, QA104 | R23-C01 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-23/report.md) |
| 8 | 24 | 다국어·공개 페이지 | QA105, QA106, QA107, QA116 | R24-H01 excluded | [보고서](../../scratch/qa-30round-2026-10-08/round-24/report.md) |
| 9 | 25 | 번역 기여 | QA108, QA109, QA110 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-25/report.md) |
| 9 | 26 | PWA·업데이트 복구 | QA111, QA112, QA113, QA114, QA115 | R26-X01 excluded; R26-X02 excluded | [보고서](../../scratch/qa-30round-2026-10-08/round-26/report.md) |
| 9 | 27 | 의존성·프로덕션 산출물 | QA095, QA121 | 새 후보 없음 | [보고서](../../scratch/qa-30round-2026-10-08/round-27/report.md) |
| 10 | 28 | 데모·소스 전환 종합 | QA056, QA057, QA058 | R28-H01 excluded | [보고서](../../scratch/qa-30round-2026-10-08/round-28/report.md) |
| 10 | 29 | 장시간·다중 참가자 | QA031 | R29-H01 excluded; R29-H02 excluded | [보고서](../../scratch/qa-30round-2026-10-08/round-29/report.md) |
| 10 | 30 | 진단·QA·운영 계약 | QA119, QA120, QA122 | R30-C01 confirmed | [보고서](../../scratch/qa-30round-2026-10-08/round-30/report.md) |

서로 다른 기본 QA ID **122/122개**. 기본 배정 기준 상태 집계: tested 120, reviewed 2.
다른 라운드가 교차 검토한 추가 coverage 행은 기본 ID 집계에 중복 산입하지 않았다.
개별 제한은 [통합 JSON](../../scratch/qa-30round-2026-10-08/consolidated.json)의 coverage 및 각 라운드 보고서에 기록했다.
QA094 ingress는 이번 재개에서 소스 검토만 수행했고, 그 이전 공통 Worker 검사 결과를 새로운 보안 재현으로 세지 않았다.
QA109의 보안 심화 실행과 OS/물리 기기·실제 음향·운영 환경도 허용 범위 안의 관측과 구분한다.

## 공통 검증

다음은 같은 코드와 불변 빌드로 실행한 전체/프로필 검사다. 새 발견 프로브의 실패는 이 표와 별도로 보존했다.
기존 스위트가 모두 통과해도 새로운 경계 조건의 결함이 없다는 뜻은 아니다.

| 검사 | 결과 | 범위·한계 |
| --- | --- | --- |
| 전체 unit | 519파일, 10,810 pass / fail·skip·todo 0 | 실제 파일 수; describe suite 수와 구분 |
| critical coverage | 55파일, 1,877 pass | 전체 unit과 일부 중복 |
| tooling coverage | 13파일, 342 pass | 별도 프로필 |
| Worker coverage | 27파일, 1,752 pass | 로컬 Worker/DB 계약, 운영 실험 아님 |
| 전체 Chromium | 581 pass / fail·skip·flaky·retry 0 | 불변 E2E 산출물 |
| WebKit | 66 pass / 기존 desktop-only 3 skip | 실패·flaky·retry 0; 실제 iOS 기기 아님 |
| production 산출물 | 17 pass / fail·skip·flaky·retry 0 | 로컬 candidate smoke; 원격 exact-main-SHA CI 후보 아님 |
| 정적 검사 | 14명령 pass | 타입·lint·서식, 소스 guard 10개, Worker 6개 dry-run bundle을 실행한 명령 1개 |
| 빌드 | E2E 및 production build:checked pass | production 산출물 guard 포함 |
| 의존성 메타데이터 | 전체/prod-only 감사 0건, registry 서명 486·attestation 103 검증 | Round 27의 새 조회; 새 설치나 보안 심화 실행 아님 |

| Coverage 프로필 | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| unit | 86.54% | 80.28% | 91.08% | 90.2% |
| critical | 81.61% | 76.13% | 87.64% | 85.77% |
| tooling | 78.27% | 73.87% | 87.09% | 80.14% |
| workers | 84.32% | 80.84% | 92.76% | 88.97% |

4종 gate 모두 통과했다. WebKit의 기존 skip은 데스크톱 입장 cascade, carousel wrap,
desktop hover suspension 세 가지다. 검사·빌드 정확한 시각과 인자는
[공통 검증 기록](../../scratch/qa-30round-2026-10-08/common-verification.json)을 따른다.

## 최초 실패 보존과 실행 제한

- 새 프로브의 첫 실패를 지우거나 timeout/기대를 느슨하게 바꿔 통과 처리하지 않았다. 파일 선택·초기 재생 준비·
  fixture 응답 모양·opacity 판정·native iframe 캐시 등의 가정 오류는 원본과 별도 교정 실행을 함께 남겼다.
- Round 22의 초기 Playwright 선택은 오래된 scratch 사본 15개를 추가 실행했다. 원본 25 pass/4 fail 중 의도된
  10 pass/4 fail과 추가 15 pass를 분리했다. 추가 복제본은 고유 검증 수로 세지 않았다.
- Round 01도 초기 브라우저 raw 18개 중 의도된 8개와 이전 scratch 사본 10개를 분리했다.
  초기 Vitest mergeConfig의 include 확장 실행은 중단·교정한 기록을 보존했고, 이를 독립 탐사 통과 수로 더하지 않았다.
  수집 전용 --list의 skipped 표시는 실행한 검사나 제품 skip으로 세지 않았다.
- Round 27의 최초 56 pass/3 fail은 Sharp의 미공개 메타데이터 경로와 추측한 SW/라이선스 경로를 조회한 검사 오류다.
  실제 경로를 쓰는 신규 19개 재검증이 통과했다. 해당 라운드 고유 결과는 기존 40+신규 19=59 pass이며 중복 합산하지 않는다.
  기존 보조 산출물 검사가 ignored e2e/report-viewer.js를 재생성했지만 추적 파일·불변 빌드는 동일했다.
- Round 28은 초기 6 pass/2 fail 뒤 첫 Play 조작을 추가한 두 대상 검사만 2 pass로 확인했다.
  Round 29는 첫 준비 실패를 보존한 뒤 호스트+게스트 8개의 여섯 곡 교체·재참가와 다음 곡을 관찰했다.
  최종 native 실행은 1 pass/1 관측기 fail 그대로이며, 마지막 실패는 앱 pagehide 정리보다 먼저 읽은 snapshot이다.
  새 문서 9개의 파일/프리로드/큐/연결/출력 상태가 비워지고 교체 중 구독 수가 일정함은 별도 원본 분석으로 확인했다.
  이전 문서 메모리 회수와 실제 여러 기기의 다시간 재생은 미검증이다. 이를 모두 통과한 장시간 soak로 표현하지 않는다.
- 두 차례 중단의 실제 오류는 보안 심화 작업에 필요한 Daybreak 접근 조건이었다. 계정의 Advanced Account
  Security와 호환 FIDO2 하드웨어 보안 키 등록이 필요했다. 차단된 보안 재현을 우회·재구성하지 않았고,
  재개 후 해당 범위는 방어적 소스/설정 검토와 명시된 blocked로 남겼다. 따라서 전체 보안 심화 실행 완료를 주장하지 않는다.
- 과거 authenticated-host 비정상 파일 프레임 실험은 재구성하지 않았다. 일반 유효 전송의 순서·호환성 실험은
  별도 근거이며, 운영 R2 원인 추적도 재개하지 않았다.
- 물리 스피커 정렬·실제 OS MediaSession 전달·화면 공유 선택기·모바일 소프트 키보드·실제 여러 기기와
  공급자 장애/운영 배포는 이번 로컬 근거로 입증하지 않는다. 기존 배포 상태는 readiness 기록에서 인용한 것이며
  이번에 새 운영 쓰기나 배포 검증을 한 결과가 아니다.
- 이전 R26의 legacy 승인 뒤 reload 미관측 1회는 별도 미해결 관측으로 계속 보존한다. 이번 정상 실행만으로
  과거 원인을 설명하거나 이번 새 결함 수에 중복 산입하지 않는다. 최종 Round 26 결과의 추적 범위를 함께 읽는다.

## 동일성·후속 작업

문서 변경 직전 원본 추적 파일 1956개의 SHA256을 비교했다.
비문서 제품 입력 변경 없이 감사했고, 불변 E2E/production 산출물 1563개도
[최종 산출물 비교](../../scratch/qa-30round-2026-10-08/artifacts-latest-check.json)에 기록했다. 원본 추적 파일 비교는
[코드 동일성 기록](../../scratch/qa-30round-2026-10-08/source-latest-check.json)을 따른다.
문서 세 파일 변경 후에는 그 차이만 허용한 마지막 검사를 별도 보존한다.

확정 결함 수정은 이번 요청 범위에 포함하지 않는다. 향후 수정한다면 관련 대조·새 경계 회귀를 유지하며,
미확정 2건은 기대 동작을 먼저 정한다. 별도 허용이 필요한 보안 심화와 실제 기기 검증, 과거 PWA 갱신 정지 원인,
운영 R2 미확정 기록은 각 한계 그대로 남긴다. App/Worker 변경을 배포할 때는 새 버전·캐시·정확한 main SHA CI
candidate와 [정식 릴리스 절차](../hotfix-procedure.md)를 따르며, 이 로컬 감사 자체를 배포 후보로 삼지 않는다.

원본 JSON·trace·영상·임시 프로브는 로컬 ignored scratch 자료다. 위 링크는 이 작업공간에서 열 수 있으며,
원격에 게시된 증거로 주장하지 않는다. 핵심 조건·결과·판정은 이 날짜 문서에 보존한다.

마지막 별도 교차 검토에서도 30라운드·122개 기본 ID·후보 판정과 원본 수치가 일치했다.
[최종 증거 검토](../../scratch/qa-30round-2026-10-08/round-30/final-review.md)와
[문서 변경 후 코드 동일성 검사](../../scratch/qa-30round-2026-10-08/source-post-doc-check.json)를 함께 보존한다.
