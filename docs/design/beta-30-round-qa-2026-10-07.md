# 베타 독립 프로젝트 QA — 30라운드 / 2026-10-07

| Field             | Value                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Status            | Dated evidence — 발견 후 재분석, 제품 수정 없음                                                                              |
| Applies to        | `mxqr_beta` 독립 QA. main 비교·승격 검증 아님                                                                                |
| Tested SHA        | `9afc36b4d8bccc575a923b0dfaadd103145ba09f`                                                                                   |
| Frozen main       | `35759e8b07f1ee0b272afbd0af03c770a858889e`                                                                                   |
| Date / execution  | 2026-10-07, 에이전트 3개씩 10세트, `gpt-6-astra` / `ultra`                                                                   |
| Environment       | Windows, Node 24.20.0, npm 12.0.2, Vitest, Chromium, 일부 Windows WebKit, 로컬 PeerJS·Worker·SQLite                          |
| Related documents | [QA 도메인](../qa-domains.md), [현재 배포 준비 기록](../beta-release-readiness-archive-2026-10-10.md), [허용된 경계](../known-accepted.md) |

## 결과와 판정 원칙

요청한 **30/30라운드**를 마친 뒤, 수집한 **16개 항목**을 원인·공개 경로·대조군·현재 계약 기준으로 재분석했다. 최종 확정은 **12건: P1 1건, P2 8건, P3 3건**이다. 나머지는 **미확정 2건, 결함 제외 2건**이다. npm의 경고 패키지 3개는 같은 advisory의 전파이므로 1건으로 센다.

확정 항목은 모두 미수정이다. 사용자 요청에 따라 제품 코드·유지 테스트·설정·의존성·버전·캐시는 변경하지 않았다. 추적 변경은 이 보고서, 현재 상태, 문서 인덱스와 QA 범위 문서의 4개 문서뿐이다. main 병합·PR·프로덕션 배포·운영 감사 재활성화는 수행하지 않았다.

발견 라운드의 실패 횟수를 결함 수로 세지 않았다. 모든 발견이 끝난 다음 세 명의 독립 검증 에이전트가 UI·시간/재생·복구 후보를 나누어 확인하고, root가 원본·현재 소스·재현의 가정을 읽고 최종 판정했다. root는 URL·진단 후보를 새 Chromium 실행으로 확인하고 보안 감사를 다시 수행했다. 이 검증은 추가 발견 라운드로 세지 않는다.

**확정은 아래 명시한 조건에서 코드 결함이 입증됐다는 뜻이다.** 모의 시계나 iframe 경계의 결과를 물리적 기기·실제 YouTube·프로덕션 사고로 확대하지 않는다. P1은 이번 베타 수정 우선순위이며 곧바로 운영 서비스의 치명적 침해를 뜻하지 않는다.

## 확정 결함 12건

| ID      | 우선순위 | 결함과 입증된 영향                                                                                                 | 대표 소스                                                                     |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| R01-C01 | P2       | 큰 YouTube 하위 목록에 포커스가 있을 때 연속 큐 갱신이 복원 예약을 지워 키보드 포커스를 잃는다.                    | [playlist-view.ts](../../src/ui/playlist-view.ts)                             |
| R02-C01 | P2       | 호스트 파일 PLAY가 오디오 준비를 기다리는 동안 전달된 MediaSession PAUSE가 무시되고 이전 PLAY가 실행된다.          | [media-session.ts](../../src/player/media-session.ts)                         |
| R05-C01 | P2       | 게스트 디코딩 중 벽시계가 뒤로 바뀌면 이미 지나간 시작 시점을 미래 예약으로 잘못 계산해 재생을 더 기다린다.        | [file-play-timing.ts](../../src/player/file-play-timing.ts)                   |
| R05-C02 | P2       | 1초 벽시계 보정 뒤 과거 최저 RTT 표본이 남아, 정상 정렬된 파일 출력을 동기화 코드가 1초 틀어진 위치로 옮긴다.      | [shared-clock.ts](../../src/network/shared-clock.ts)                          |
| R11-C01 | P2       | 12자 YouTube 영상 ID를 앞 11자로 잘라 다른 ID의 영상을 큐에 추가한다.                                              | [search.ts](../../src/youtube/search.ts)                                      |
| R22-C01 | P1       | 고정된 개발 의존성 `sharp@0.35.4`의 새 보안 공지 때문에 필수 보안 검사가 실패한다.                                 | [package.json](../../package.json), [CI](../../.github/workflows/ci.yml)      |
| R23-C01 | P2       | 수동 싱크 값을 Enter로 확정하면 포커스가 BODY로 빠져 바로 누른 Esc로 창을 닫을 수 없다.                            | [manual-sync-overlay-runtime.ts](../../src/ui/manual-sync-overlay-runtime.ts) |
| R24-C01 | P2       | 언어 JS의 일시 로드 실패 후 온라인 복귀·언어 재선택으로 복구되지 않고 영어가 남는다.                               | [i18n/index.ts](../../src/i18n/index.ts)                                      |
| R24-C02 | P3       | 선택 언어의 폰트 CSS가 한 번 실패하면 이후 렌더 재시도로 선호 폰트가 복구되지 않는다. 기본 폰트로 조작은 가능하다. | [locale-fonts.ts](../../src/i18n/locale-fonts.ts)                             |
| R24-C03 | P2       | 처음부터 RTL 언어로 연 데스크톱 채팅에서 전송 후 내용이 가로로 밀려 메시지가 패널 밖으로 잘린다.                   | [chat.ts](../../src/ui/chat.ts), [style.css](../../css/style.css)             |
| R26-C01 | P3       | 같은 세대 업데이트를 동시에 받은 두 탭이 정상 localStorage 환경에서도 둘 다 업데이트 창을 유지한다.                | [sw-register.ts](../../src/sw-register.ts)                                    |
| R29-C01 | P3       | 실제 활성 Standard 방의 싱크 진단이 `room:"none"`, `host/idle` 또는 `guest/idle`로 내보내진다.                     | [sync-flight-recorder.ts](../../src/diagnostics/sync-flight-recorder.ts)      |

### R01-C01 — 연속 큐 렌더와 포커스 복원

YouTube 하위 목록 뒤쪽 항목에 키보드 포커스를 둔 상태에서 구조 갱신이 두 번 이어지면, 첫 렌더의 점진적 DOM 생성이 끝나기 전에 둘째 렌더가 `clearProgressiveFocusRestore()`를 호출한다(`playlist-view.ts:334`). 아직 대상 노드가 없어서 BODY로 옮겨진 포커스에서 원래 대상을 다시 얻지 못한다. 큐 항목 수 제한을 넘긴 사례가 아니다. 원본은 하위 항목 1,200개, 재검증은 허용 범위 안의 500개를 사용했다.

단일 갱신은 원래 항목에 복원되고, 목록 바깥으로 의도적으로 옮긴 포커스는 탈취하지 않는 대조군이 통과한다. 최종 공개 경로 재현은 호스트가 허용 범위의 하위 항목 5,000개 중 마지막에 포커스를 둔 동안 관리자 게스트가 정상 WAV 두 개를 **파일 선택 한 번으로** 올리는 방식이다. 제품의 순차 업로드 완료→호스트 append가 두 차례 렌더를 만들며, 최종 큐 3개·하위 행 5,000개는 정상이지만 포커스는 BODY/null이 된다. 갱신 이벤트나 지연 타이머를 주입하지 않은 실제 RTC 업로드이며 초기 큐와 playlist manifest는 fixture로 고정했다. 500개/25ms 간격의 별도 스트레스 재현, 약 250ms 간격에서 실패하지 않은 대조도 보존했다. 일상 조작의 발생 빈도는 측정하지 않았다. 사용자에게는 키보드 탐색 위치 손실이며 큐 데이터 손실은 아니다. 목록 항목을 다시 선택하면 조작할 수 있다. 원본 `round-01`, 후속 `reanalysis/ui/uplink-browser.json` 등에 실패·대조군을 보존했다.

### R02-C01 — 준비 중 PLAY보다 뒤의 PAUSE가 져버림

호스트가 일시정지한 파일에 MediaSession PLAY를 전달하고 첫 `AudioContext.resume()` 완료를 늦춘 다음 PAUSE를 전달한다. PAUSE 분기는 현재 재생 상태가 아직 paused라서 취소를 전달하지 않는다(`media-session.ts:362`). 이후 준비가 끝나면 이전 PLAY가 source를 시작하고 PLAY를 방송한다. 같은 준비 중 STOP은 취소하고, PLAY만 전달하면 정상 시작한다.

실제 등록된 콜백·브라우저 디코드·Web Audio 경로를 사용했으며 첫 준비 완료만 제어했다. 특정 헤드셋/잠금 화면에서 이 순서의 PAUSE를 보낼 수 있는지는 실기 미확인이다. 토글형 버튼은 이 상태에서 PLAY를 보낼 수도 있으므로 모든 OS 버튼의 재현이라고 주장하지 않는다. 명시적 PAUSE가 전달된 경우의 순서 결함으로 한정한다. 다시 정지/일시정지하면 복구된다. 증거: `round-02`, `reanalysis/timing`.

### R05-C01 — 디코드 대기와 벽시계 변경

PLAY 수신 때 기록한 `setAt`은 로컬 벽시계다. 디코드 완료 후 바뀐 `Date.now()`와 빼서 새 monotonic 예약으로 바꾸므로, 뒤로 5초 보정하면 실제로는 시작해야 할 파일에 약 4.6초의 추가 대기를 만든다(`file-play-timing.ts:56`). 정상 PONG이 시계를 다시 보정해도 파일이 예약 시작 중이라는 가드 때문에 즉시 교정되지 않는다.

원본 native Chromium에서 1초 관측 후에도 약 3.9초의 예약이 남았고 세 차례 PONG이 예약 가드에 걸렸다. 무보정 대조군은 통과한다. Windows 시간을 변경한 것이 아니라 API 시계 보정과 디코드 완료 지연을 제어했다. 음향 첫 소리는 측정하지 않았다. 잘못된 예약 만료나 새 재생 명령으로 회복하며 영구 정지라는 뜻은 아니다. 증거: `round-05`, `reanalysis/timing`.

### R05-C02 — 작은 시계 보정 후 잘못된 초기 동기화

기존 RTT 4ms 표본 세 개 뒤에 벽시계를 ±1,000ms 보정하고 정상 RTT 8ms PONG을 받으면, 2,000ms 이상의 불연속만 비우는 필터가 과거 offset을 유지한다(`shared-clock.ts:175`). 실제 protocol·clock·transport 경로에서 정렬된 위치 11.308초가 초기 동기화 결정에 의해 10.308초 또는 12.308초로 바뀐다. 단순히 표본을 즉시 버리지 않았다는 주장과 구분한다.

이 필터는 큐 지연이 거짓 시계 보정을 만들지 않도록 설계된 의도적 방어다. 다만 이번 낮은 RTT의 실제 벽시계 보정 조건은 약 6ms의 불확실성을 크게 넘는 1초 출력 오차를 만든다. 20개의 올바른 후속 PONG 뒤에도 오차가 유지됐다. 표본 만료로 자연 회복되며, 1Hz 실험에서는 60번째 PONG에 시계가, 62번째에 출력이 회복됐다. 즉 첫 잘못된 교정부터 약 61초이며 영구 불일치가 아니다. 강제 재동기화 대조군은 다음 PONG에 회복한다.

원인은 R05-C01의 디코드 시점 저장과 다르다. 실제 소스에 결정적 시계/오디오 경계 모형을 사용했으며 이 항목 자체의 native 브라우저·OS·음향 재현은 하지 않았다. 증거: `round-05/probe-final.json`, `reanalysis/timing`.

### R11-C01 — 잘못된 영상 주소를 다른 영상으로 해석

채팅에 `https://youtu.be/dQw4w9WgXcQx`를 보내 카드의 추가 버튼을 누르면 `dQw4w9WgXcQ`가 큐에 들어간다. 정규식이 정확한 ID 종료 경계를 검사하지 않는다(`search.ts:96`). 같은 oEmbed 404 조건의 정상 11자 주소는 정상 추가된다. root의 새 브라우저 실행에서도 정상 대조군 통과, 잘못된 주소 거부 기대 실패를 확인했다.

URL을 거부하거나 사용자가 준 ID를 그대로 취급해야 하며, 다른 영상 ID로 조용히 치환하는 것이 결함이다. 잘못 추가된 항목을 지우고 정상 주소로 다시 추가할 수 있다. 보안 취약점이나 실제 YouTube 재생 확인으로 분류하지 않는다. 증거: `round-11`, `reanalysis/root/browser.json`.

### R22-C01 — 새 sharp 공지와 개발 보안 gate

현재 사슬은 `Wrangler 4.130.0 → Miniflare 5.20260908.0-alpha → sharp 0.35.4`다. [공식 GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)는 sharp 0.35.5 미만을 영향 버전으로, 0.35.5와 librsvg 2.63.2를 수정 버전으로 명시한다. 특정 glibc Linux 조건에서 가능한 RCE를 설명하지만 이번 Windows QA에서 exploit이나 서비스 공격 경로를 입증하지 않았다.

10월 7일 발견 실행과 root 재감사 모두 전체 감사가 high 3패키지로 exit1, `--omit=dev`는 0건/exit0이다. 원본의 정확한 `npm run security:audit`도 exit1이고 CI가 이 명령을 호출한다. 세 패키지는 **한 advisory의 하위·상위 전파**다. 검토한 App 소스에서 images binding/`cf.image` 처리 경로를 찾지 못했다. 영향은 개발 의존성 및 필수 보안 검사 실패로 한정한다.

검토 데이터베이스의 게시·검토 시각은 2026-10-06T13:43:57Z, upstream 공지일은 9월 30일이다. 이전 보고서의 10월 6일 감사 0건은 당시 사실로 보존한다. 개발 의존성 수정과 호환성 재검증이 남지만 이번에는 변경하지 않았다. 증거: `round-22/advisory-response.json`, `security-gate.stdout.log`, `reanalysis/root/audit.json`, `audit-prod.json`.

### R23-C01 — 수동 싱크 Enter 뒤 Esc

파일의 수동 싱크 입력에 값을 넣고 Enter를 누르면 `completeEdit()`가 `editor.blur()`만 수행한다(`manual-sync-overlay-runtime.ts:217`). BODY에 포커스가 있으므로 overlay에 연결된 Esc/Tab 처리가 즉시 닿지 않는다. 값은 반영되고 창은 계속 열린다.

새 Chromium 실행으로 재현했다. Tab으로 overlay 안에 돌아온 뒤 Esc를 누르면 닫히고 원래 Sync 버튼에 포커스가 복원된다. 일반 Tab→Esc 대조군도 통과한다. 파일 경로로 독립 확인했으며 초기 YouTube heartbeat 준비를 잘못 기다린 실패는 제외했다. 증거: `round-23`, `reanalysis/ui`.

### R24-C01 / R24-C02 — 번역 JS와 폰트 CSS의 서로 다른 복구 실패

R24-C01은 첫 일본어 JS 요청을 일시적으로 실패시킨 뒤 실제 네트워크 복귀 이벤트와 영어→일본어 재선택을 실행한 경우다. 같은 URL을 다시 fetch하면 200이지만 동일 문서의 import가 실패하여 저장된 선택은 일본어인데 표시 언어는 영어로 남는다. 소스가 명시한 online/재선택 복구 계약(`index.ts:480–487`)을 충족하지 못한다. production artifact에서 정상 선택과 reload 복구는 통과한다. 영어 fallback 자체는 정상 설계다.

R24-C02는 아랍어 CSS 첫 로드 실패 후 실제 언어 picker/영어→아랍어 렌더를 반복해도 Noto Sans Arabic face가 생기지 않는 경우다. `locale-fonts.ts:102–103`은 실패 뒤 렌더 재시도를 명시하지만, 빌드된 Vite preloader의 실패한 CSS 표시/link와 애플리케이션 캐시 정리가 맞지 않는다. 같은 CSS fetch는 200이고 reload하면 font face가 복구된다. 시스템 fallback으로 읽고 조작할 수 있으므로 선호 폰트 복구 문제인 P3로 한정한다.

두 항목은 실패한 JS module URL과 CSS dependency preloader라는 다른 상태를 사용하고 독립적으로 재현되므로 별도 원인으로 센다. 5초 재선택 관측 범위이며 영구 실패라고 단정하지 않는다. 제품 파일을 바꾸지 않은 production 로컬 브라우저, 정상 요청·reload·서비스 워커 대조군의 증거는 `round-24`, `reanalysis/recovery`에 있다.

### R24-C03 — RTL 채팅의 가로 이동과 잘림

1280×720의 실제 Standard host/guest에서 처음 채팅하기 전에 히브리어를 선택하고 보통 메시지를 전송한다. 짧은 평문으로 줄인 후속 재현에서도 drawer의 `scrollLeft=-153`과 입력창의 153px 이동이 생겼다. 한 재검증에서 패널 오른쪽은 840px인데 전송한 글자는 845–963px에 놓여 전체가 잘렸다. 긴 문자열만의 줄바꿈 문제가 아니다. 아랍어는 메시지 내용에 포함했으며 모든 RTL 언어의 초기 화면을 검증했다는 뜻은 아니다.

영어로 처음 열면 정상이고 같은 방에서 언어를 바꿨다가 돌아오면 가로 위치가 복구된다. 실제 focus 함수를 그대로 호출하며 관측한 trace는 `chat.ts:1288`의 화면 밖 IME dummy focus가 scrollLeft를 0→-9983으로, 이어진 입력창 focus가 -153으로 바꾸는 것을 보였다. RTL에서 이 포커스 이동과 숨겨진 overflow가 상호작용한다. 기존 iOS IME 초기화 의도까지 보존하는 수정은 아직 하지 않았다. 증거: `round-24`, `reanalysis/ui`의 screenshot/geometry/포커스 관측.

### R26-C01 — 동시 탭의 업데이트 창 중복

두 탭이 같은 신규 SW 세대를 동시에 관측하면 [sw-update-coordination.ts](../../src/sw-update-coordination.ts):196–214의 localStorage lease 읽기→쓰기→확인 사이에 경합이 가능하다. 각 탭이 자신을 소유자로 판단한 뒤 저장소 소유자가 하나로 수렴해도 이미 열린 두 창은 남는다. 저장소가 막혔을 때의 의도적 fail-open과 다르다.

후속 Chromium 재검증은 v631에서 3회 재현했으며, 저장소 함수를 감싸지 않은 native 실행도 포함했다. 순차적으로 두 번째 탭을 알리는 대조군은 창 하나만 연다. 실제 두 창에 응답하면 각 탭은 한 번씩 reload되고 최신 세대 ready로 수렴한다. 검증자의 P2 권고를 root가 이 제한된 UI 영향에 맞춰 P3로 낮췄다. 데이터 손실·무한 reload·활성 방 강제 종료를 주장하지 않는다. production artifact와 native SW를 사용하되 SW epoch만 로컬 응답에서 바꾼 업그레이드 모형이다. 증거: `round-26`, `reanalysis/recovery`.

### R29-C01 — 진단의 Standard 방 분류 오류

Standard 권한은 실제로 `network.appRole`, 세션 코드/연결, 시작 상태를 사용하지만 recorder는 `room.context.roomId`만 본다(`sync-flight-recorder.ts:289`). 실제 Standard UI의 context는 roomId null/role idle로 남아 있어, 활성 host와 재생 중 guest도 `room:none`으로 표시된다. PRO context 대조군은 정상이다.

root가 새 방의 정상 setup→`/debug sync`로 독립 재현했고 파일 재생·익명화·로컬 복사 대조군은 통과했다. 수치 drift나 음향의 오류는 입증되지 않았다. 지원용 진단의 분류 정확성 문제로 P3이며, 원본 후보의 P2에서 낮췄다. 현재는 함께 기록된 역할·연결 상태를 보고 수동 해석해야 한다. 증거: `round-29`, `reanalysis/root/candidate-host-state.json`, `candidate-host-flight.txt`.

## 확정에 넣지 않은 4개 항목

| ID      | 최종 판정 | 이유와 남은 확인                                                                                                                                                                                                                                                |
| ------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R06-C01 | 결함 제외 | 권한 철회→재부여 사이에 이벤트가 없던 drag는 권한 복구 뒤 새 pointermove에서만 바뀐다. 정지 상태의 release는 값을 재발행하지 않고, 권한 없는 동안 움직이면 실제로 취소된다. 취소된 의도의 부활·무권한 쓰기를 입증하지 못했다.                                   |
| R08-C01 | 미확정    | 특이한 authenticated-host 입력 뒤의 복구 관측은 있지만 정상 native 송신자가 이를 만드는 경로가 입증되지 않았다. 부분 Standard schema 검증의 허용 범위도 고려해야 한다. 자동 보안 필터 중단 후 독립 동적 재검증은 하지 않았다.                                   |
| R11-C02 | 결함 제외 | 원래 iframe 모형은 cue/load 호출 뒤에도 이전 A 정보를 남겼다. 실제 공식 YouTube facade는 명령을 보내기 전에 `playerInfo` 캐시를 동기적으로 비운다. 모형이 이 동작을 빠뜨린 상태의 FIFO 실패는 실제 제품 결함 증거가 아니다. 이를 반영한 대조를 별도로 보존한다. |
| R25-C01 | 미확정    | 응답 유실→reload 후 같은 초안에 새 UUID가 생기고 실제 Worker/SQLite 조합에서 같은 문구 두 건이 저장됨은 관측했다. 현재 보장된 재시도는 동일 메모리 객체/계정이며 reload 이후 durable idempotency 계약은 명시되지 않았다. 제품 요구 결정이 남는다.               |

R11-C02의 기각 근거는 10월 7일 읽기 전용으로 받은 [공식 YouTube widget API](https://www.youtube.com/s/player/1b3be681/www-widgetapi.vflset/www-widgetapi.js)의 cue/load 분기다. 저장한 원문 SHA256은 `c2dcf46501a48a87a7859596834012e81569a181f7b80bda4d91b04798f84751`이다. 실제 facade의 동기적 캐시 무효화를 반영한 대조에서는 cue B 뒤 cue A가 전달되고 최종 A가 선택·재생됐다. 원래 FIFO 실패와 잘못된 후속 fake-infoDelivery 실험도 버리지 않고 기각 근거와 함께 보존했다. 실제 영상 재생 요청은 하지 않았다.

R25의 순위 기반 pagination에서 투표 변경 중 누락/중복이 보인 탐색도 확정하지 않았다. 현재 목록은 live ranking이고 snapshot 보장이 없으며, 새로고침하면 22개가 모두 돌아왔다. QA 목록의 강한 표현만으로 새 계약을 만들지 않았다.

QA082의 일일 BOT 비용 한계 문구는 현행 계약과 달라 계획 문서만 바로잡았다. 현재 실제 제한은 인증 토큰별 분당 3회와 방별 기준 시점부터 1시간당 100회다. `pro-room-worker.ts:971–974,6063–6080`과 원래 회귀 검사로 확인했다. 제품 결함 12건에 포함하지 않는다.

## 10세트 / 30라운드 실행 범위

아래 단위 수는 **각 라운드의 최종 기존 검사 통과 수**다. 라운드 간 겹치므로 합산하지 않는다. 신규 프로브의 실패는 후보 재현 및 잘못된 fixture/oracle을 포함하며, 각각 원본 JSON/로그와 판정을 보존했다.

| 세트 | 라운드 | 범위                      | 기존 단위 pass | 수집 항목       |
| ---- | ------ | ------------------------- | -------------: | --------------- |
| 1    | 01     | QA001–002 큐              |            254 | R01-C01         |
| 1    | 02     | QA003–007 재생 제어       |            636 | R02-C01         |
| 1    | 03     | QA008–011 입력·디코드     |            195 | 0               |
| 2    | 04     | QA012–016 대용량 스트리밍 |            274 | 0               |
| 2    | 05     | QA017–019 공유 시계·싱크  |            226 | R05-C01/C02     |
| 2    | 06     | QA020–028 음향 효과       |            276 | R06-C01         |
| 3    | 07     | QA029–031 RAM             |            878 | 0               |
| 3    | 08     | QA032–036 P2P·프리로드    |            368 | R08-C01         |
| 3    | 09     | QA037–042 Standard 방     |            722 | 0               |
| 4    | 10     | QA043–046 시스템 오디오   |            355 | 0               |
| 4    | 11     | QA047–055 YouTube         |          1,034 | R11-C01/C02     |
| 4    | 12     | QA056–058 데모            |            127 | 0               |
| 5    | 13     | QA059–067 PRO             |          1,467 | 0               |
| 5    | 14     | QA068–072 계정            |            270 | 0               |
| 5    | 15     | QA073–076 Developer API   |            532 | 0               |
| 6    | 16     | QA077–082 채팅·BOT        |            653 | 0, QA 문구 교정 |
| 6    | 17     | QA083–085 Remote Share    |            256 | 0               |
| 6    | 18     | QA086–089 관리자          |          1,207 | 0               |
| 7    | 19     | QA090–091 방 세대·권한    |            633 | 0               |
| 7    | 20     | QA092–093 DB              |             72 | 0               |
| 7    | 21     | QA094 ingress             |            275 | 0               |
| 8    | 22     | QA095 의존성              |             29 | R22-C01         |
| 8    | 23     | QA096–104 UI·키보드       |            395 | R23-C01         |
| 8    | 24     | QA105–107 언어·폰트·RTL   |            274 | R24-C01/C02/C03 |
| 9    | 25     | QA108–110 번역 기여       |            131 | R25-C01         |
| 9    | 26     | QA111–115 PWA·복구        |            234 | R26-C01         |
| 9    | 27     | QA116 공개 페이지         |            259 | 0               |
| 10   | 28     | QA117–118 수명·정리       |            172 | 0               |
| 10   | 29     | QA119 진단                |            145 | R29-C01         |
| 10   | 30     | QA120–122 빌드·운영 계약  |            264 | 0               |

기존 Vitest JSON을 소스 경로와 전체 테스트 이름으로 중복 제거한 결과는 **365파일 / 8,716개 고유 실행 / 최종 pass 8,716, fail 0**이다. 원래 timeout을 유지한 명시적 재실행에서 해소된 첫 도구 로딩 timeout은 원본에 남겼다. 공유 산출물을 쓰는 기존 테스트 1개는 의도적으로 제외했다. 이름 필터의 제외 항목을 실행 완료로 세지 않았다. **전체 unit·coverage gate 완료라는 주장은 아니다.**

도메인 122개 중 120개는 해당 라운드의 제한된 자동/브라우저/소스 실험을 수행했다. QA055 실제 첫 소리·Bluetooth·실기 음향은 미실행, QA122 실제 운영 상태·배포·rollback·키 회전은 소스와 모형만 검토했다. '120개 수행'은 각 도메인의 모든 실기 항목을 통과했다는 뜻이 아니다.

production/E2E 빌드를 각각 생성했고, 고정된 복사본을 사용했다. 30라운드의 artifact guard 8개, Worker dry-run 6개가 통과했다. production 파일 742개와 공유 E2E 파일 741개를 분리했고, 1,931개 추적 소스의 QA 전후 hash 및 공유 E2E hash가 같았다. 일부 WebKit은 Windows 엔진 검사이며 실제 Safari/iOS 보증이 아니다.

## 사후 재분석의 실행 근거

| 검증 묶음          | 새 실행 결과                                                                             | 판정에 사용한 범위                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI                 | Chromium 16회: 11 pass / 5 fail                                                          | 큐 3회, 싱크 창 1회, RTL 1회 실패. slider 취소·정상/복구 대조 통과. 실행 횟수이며 고유 결함은 3건.                                                                 |
| 시간·재생          | 기존 단위 90 pass, 소스 프로브 36 pass / 5 fail                                          | MediaSession 준비 창 2개와 시계 조건 3개 실패가 3원인에 해당.                                                                                                      |
| 시간·재생 브라우저 | 최초 담당 7회 4 pass / 3 fail, 복구 3회 2 pass / 1 fail, 최종 YouTube facade 대조 1 pass | 최초·복구의 YouTube 실패는 잘못된 모형으로 기각. 담당 밖으로 잘못 선택된 기존 chat 2회와 잘못된 metadata 후속 실험 1 fail은 따로 보존하고 이 판정에 합산하지 않음. |
| 복구               | 기존 단위 89 pass, production Chromium 9회 2 pass / 7 fail                               | 언어 2회·폰트 2회·동시 탭 3회 재현. 내장 reload·세대 수렴 대조 모두 통과. 3원인.                                                                                   |
| root               | Chromium 4회 2 pass / 2 fail, 전체 감사 exit1 / prod-only exit0                          | URL·진단 재현과 정상 대조, 단일 보안 공지 확인. 번역·P2P는 원본과 소스 재분석만 수행.                                                                              |

이 실패들은 수정 전 재현으로 남아 있다. 같은 결함의 변형·회복·반복 실행을 새 결함으로 더하지 않았고, 지나간 라운드의 raw 결과를 녹색으로 바꾸지 않았다.

## 증거 위치와 재현 조건

원본은 로컬 ignored `scratch/qa-30round-2026-10-07/` 아래에 보존했다. Git에는 대용량 trace·빌드·설치 복사본을 싣지 않는다.

- `ledger.json`: 3×10 배정, 모델/effort, 도메인과 시작 기록. 30개 `round-NN/report.json` 및 `report.md`: 명령·pass/fail/skip·제한·소스·원본 로그.
- `validate-reports.mjs`: 모든 30개 보고서의 SHA·모델·QA ID·참조 파일·raw reporter 수를 검사해 오류 0개.
- `maintained-coverage.json`: 위 고유 기존 단위 수의 source/fullName별 원본 실행 기록. `evidence-inventory.json`: 전체 수집 항목.
- `reanalysis/{ui,timing,recovery,root}/`: 독립 검증 프로브·원본 출력·최종 권고. root의 최종 판정은 이 문서와 일치한다.
- 각 실패의 trace/screenshot과 정상·회복 대조군은 해당 원본 디렉터리에 있으며, 수정된 실험 fixture는 원본 실패 파일을 덮어쓰지 않았다.

로컬 재현은 고정 Node `scratch/beta-upgrade-2026-09-09/node-v24.20.0-win-x64/node.exe`, 저장된 browser runtime, 기존 네트워크 가드, worker1/retry0를 사용했다. 서비스 포트는 발견 4601–4630/9401–9430, 재검증 4640–4643/9440–9443이었다. 자세한 명령은 각 report JSON을 따르며 공유 dist를 다시 쓰는 hook은 실행하지 않았다.

최종 원본과 판정을 연결한 파일 목록·SHA256은 로컬 `final-evidence-manifest.json`에 기록한다. 날짜가 있는 과거 QA의 0건/수정 완료 결과는 그대로 보존하고, 이번 새 발견을 이전 시점의 결과에 소급 적용하지 않는다.

## 한계와 남은 작업

확정 12건의 수정·회귀 확인은 아직 하지 않았다. 수정 시 각 원인을 독립적으로 다루고 원래 실패 재현과 정상/복구 대조군을 함께 통과시켜야 한다. 특히 보안 공지는 의존성 범위와 Linux 실행 조건을 구분하고 호환성을 확인해야 한다. 미확정 두 항목은 위의 적용성·제품 계약 근거가 추가되기 전에는 확정 수에 합치지 않는다.

물리적 iOS/Android/TV, Bluetooth·스피커 음향, 실제 OS MediaSession 입력, 실제 YouTube iframe 순서, 장시간/실제 WAN, live OAuth·Cloudflare D1/DO/R2·BOT provider·관리자 운영은 이번 QA로 완료되지 않았다. 로컬 SQLite와 Worker 모형 결과가 분산 서비스 운영 증거를 대신하지 않는다.

8라운드의 비정상 전송 입력 실험은 자동 보안 필터가 중단했다. 이후 같은 작업을 다른 에이전트·도구로 재구성하거나 우회 실행하지 않았고, 기존 자료와 소스 검토만으로 미확정 처리했다.

대회 동결, `8.6.61`/`v630`, 누적 release `all`/Developer API D1 `false`, schema/secrets/bindings와 복구 절차는 그대로다. 새 코드·의존성 배포가 없으므로 이번 QA 자체가 rollback 대상 배포를 만들지 않는다. 승격 전 버전/cache-history, 최종 main SHA의 CI candidate, 운영 상태와 실기 확인은 별도로 남는다.
