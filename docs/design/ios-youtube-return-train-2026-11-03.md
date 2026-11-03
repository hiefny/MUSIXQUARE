# 아이폰 YouTube 복귀 순간의 브라우저 멈춤 (2026-11-03)

| Field | Value |
| --- | --- |
| Status | 미배포. 브랜치 `agent/ios-yt-return`, main `88550bc4`(App 9.0.35 / v808) 위. 버전 번호와 배포 순서는 릴리스 준비에서 정한다 |
| Tested code | `e4319843e` (이 보고서가 다루는 런타임 코드와 시험의 마지막 커밋) |
| Environment | Windows 11, Node 24.22.2, Vitest(jsdom), Playwright Chromium(가짜 YouTube 플레이어, 실제 PeerJS). 실제 아이폰과 WebKit은 아직 |
| Registry | [RO-05](resource-ownership-registry.md#ro-05-guest-youtube-re-align-retry-chains)(주인), [RO-51](resource-ownership-registry.md#ro-51-return-from-background-dialog)(가드의 복귀 판독) |
| Owner question | 아래 "오너 질문" 한 개, 답 대기 |

## 보고

오너의 실기 확인(2026-11-03 21:40 KST 무렵, 요약): 일반 방에서 YouTube 트랙을 다 같이 재생하는 중,
게스트인 아이폰(Safari)이 홈 화면에 가거나 화면을 끄면 iOS 정책으로 YouTube가 멈춘다. 이는
정상이고, 평소에는 다시 돌아오면 자동으로 맞춰 재생된다. 그런데 멈추는 바로 그 순간에 돌아오면
멈춘 채로 남고, YouTube 화면 안의 재생 버튼이나 동기화 버튼을 눌러야 다시 맞춰진다.

## 원인

두 틈이 만났다.

1. 백그라운드 복귀 가드(`src/core/background-resume-guard.ts`)는 1초
   (`DEFAULT_RECOVER_THRESHOLD_MS`)보다 짧게 숨겨진 기간을 복귀로 보지 않는다. 멈추는 순간에
   돌아오면 대개 1초 안이라 복귀 Sync(RO-05의 게스트 맞춤 체인)가 돌지 않았다.
2. 네이티브 제어 경로(`src/youtube/native-control-authority.ts`)는 앱이 부르지 않은 iframe
   PAUSE를 참가자가 직접 멈춘 것으로 기록했다. 숨겨진 동안 처리되면 로컬 일시정지 비트만,
   보이게 된 뒤 처리되면 일시정지 의도까지 냈다. 비트가 서 있으면 방장 하트비트가 재생 보정을
   건너뛰어, 재생 탭(로컬 재합류)이나 동기화 버튼 말고는 다시 재생할 길이 없었다.

## 증분

| 커밋 | 내용 | 시험한 코드 |
| --- | --- | --- |
| `570f47229` | 시험 먼저: 교차 흐름 열 행, Chromium 열 행. 이 커밋 위에서 각각 4행 실패(멈춘 채로, 비트 true, 복귀 맞춤 0번). e2e 명세가 가드 상수를 읽어 dead-export self-only 기준선 76→75도 여기서 | `570f47229` 트리 |
| `a86ad57bb` | 첫 고침: 숨겨진 동안이나 돌아온 뒤 1초 안의 PAUSE를 브라우저 멈춤으로 보고 복귀 체인에 넘김, 1초 미만 복귀는 체인이 맞춤 | 리뷰 전 |
| `e4319843e` | 리뷰 반영: 아이폰·아이패드에서만(`IS_IOS`), 돌아온 뒤 iframe에 초점이 들어가면 1초 창을 닫음, 넘긴 멈춤은 로컬 일시정지 비트를 내림, 숨겨진 기간은 가드가 한 번만 잰다(`getLastObservedBackgroundReturn`) | 아래 시험 전부 |

리뷰가 찾은 것: 1초 창이 모든 기기에서 열려 컴퓨터·안드로이드에서 게스트가 직접 누른 일시정지를
덮었고(돌아온 지 0.5초 뒤 누른 일시정지, 쿨다운 기다리는 복귀 중 누른 일시정지), 브라우저 멈춤이
비트를 세워 둔 채라 두 번 연달아 홈에 다녀오면 두 번째 멈춤을 맞춤 랑데부가 삼켜 다시 멈춘 채로
남았고, 경로가 숨겨진 기간을 가드와 따로 재 1초 경계에서 두 체인이 다 돌거나 하나도 안 돌 수
있었다.

## 바뀐 동작

- 아이폰·아이패드의 일반 방 게스트(재생 권한 없음)에서, 숨겨진 동안 처리된 iframe PAUSE와 돌아온
  뒤 `BACKGROUND_STOP_RETURN_GRACE_MS`(1초) 안에, iframe에 초점이 들어가기 전에 처리된 PAUSE는
  브라우저 멈춤이다. 일시정지 의도를 내지 않고, 보이게 되면 로컬 일시정지 비트를 내리고 복귀
  체인에 넘긴다(복귀마다 한 번). 가드가 복구하지 않은 복귀(1초 미만)면 같은 게스트 맞춤 체인이
  돌고, 복구한 복귀면 그 복귀의 Sync가 맞춘다.
- 넘기는 동안 다시 숨겨지면 그 멈춤은 다음 복귀로 가고(그동안 비트는 다시 선다), 일시정지 의도나
  YouTube 모드 종료는 넘기는 중인 멈춤을 취소한다.
- 아이폰의 평소 복귀(1초 이상)도 복귀 뒤 비트가 내려가 있어, 하트비트의 재생·드리프트 보정이 다시
  켜진다. 전에는 다음 방장 명령이나 동기화 전까지 꺼져 있었다.
- 그대로: 방장, PRO 방, 재생 권한이 있는 게스트(그 멈춤은 여전히 방장에게 일시정지 요청),
  컴퓨터·안드로이드 휴대폰, 돌아온 지 1초가 지난 뒤 처리된 PAUSE.

## 시험

| 묶음 | 환경 | 결과 | 한계 |
| --- | --- | --- | --- |
| 교차 흐름(`local-output-realign-cross-flow.test.ts` "iOS: return at the moment WebKit stops the hidden iframe") | Vitest jsdom, 실제 sync·가드·복귀 체인·네이티브 제어, 가짜 iframe | 아이폰 멈춤 열 행, 가드 경계 두 행(999·1000 ms, 체인 정확히 한 번), 두 번 연달아 다녀오기, 돌아온 뒤 누른 일시정지 다섯 행 모두 통과. `a86ad57bb` 위에서는 두 번 다녀오기와 "일시정지 유지" 네 행이 실패 | 가짜 시계라 두 측정이 1 ms 어긋나는 경우는 재현할 수 없다. 이제 측정이 하나라 그 경우가 없다는 것을 가드 판독 행이 고정 |
| 단위(`native-control-authority`, `background-return-sync`, `background-resume-guard`, `dead-exports` 등) | Vitest | 손댄 파일 155개 시험 통과. `src/youtube`·`player`·`core`·`network`·`pro-room`·`ui` 598개 파일 15,150개 중 `sw-cache-version-guard.test.ts` 2개가 부하 속 15초 시간 초과, 혼자 다시 돌려 53개 모두 통과 | `src/` 중 audio·account·demo 등 나머지 디렉터리는 돌리지 않음 |
| Chromium e2e `e2e/youtube-background-stop-return.test.ts` | Playwright Chromium, 포트 5397/5398, trace off, retries 0, 게스트 페이지 아이폰 user agent(데스크톱 화면 크기) / 데스크톱 | 13개 통과(5.4분). 아이폰 멈춤 행은 돌아온 뒤 1.54~1.87초에 다시 재생, 방장과 11 ms 안. 두 번 다녀오기는 두 번째 복귀 뒤 4.1초(하트비트 보정), +1 ms. 데스크톱 탭 두 행은 멈춘 채 유지 | Chromium은 숨긴 iframe을 멈추지 않아 페이지가 멈춤을 연기한다. iframe 초점 신호는 가짜 플레이어에 iframe이 없어 e2e에 없음(단위 행만) |
| 주변 e2e(`background-resume`, `youtube*` 10개 명세) | 위와 같음 | 54개 통과(12.1분), 실패·불안정 0 | |
| 빌드와 첫 로딩 예산 | `npm run build:checked` | `guard:sw-cache-version`은 버전 올림이 없어 예상대로 실패("newer than v808"), 그 뒤 단계는 하나씩 돌려 모두 통과. 첫 로딩: eager JS 455.5 KiB gzip, entry 248.7 KiB gzip, eager total 531.9 KiB gzip. 같은 기계에서 main `88550bc4`는 455.0 / 248.2 / 531.4(eager JS +0.5 KiB gzip) | |
| 가드 | `check-resource-ownership`, `guard:dead-exports`, `guard:import-graph`, `guard:bus-pairing`, `guard:lifecycle-writes`, `guard:source-complexity`, `guard:standard-room-hot-path`, `guard:room-authority-boundaries`, `guard:chunk-pump` | 모두 exit 0. 자원 소유 개수와 dead-export 개수(20/75)는 그대로 | |

시험은 모두 로컬 브랜치 시험이다. 정확한 main SHA의 릴리스 후보가 아니다.

리뷰 반영 중 한 번 먼저 돌린 e2e(같은 명세, 반영 도중의 트리)에서는 데스크톱 쿨다운 탭 행이 돌아온 지
300 ms 뒤 누르게 되어 있어 실패했다(돌아온 뒤 1835 ms에 재생). 실제 앱에서는 복귀가 Sync 쿨다운 끝나기
약 300 ms 전에 오고 기다리던 체인이 그 10 ms 뒤 랑데부를 시작해, 300 ms 탭은 그 랑데부와 겹친다.
랑데부가 iframe을 가진 동안의 PAUSE를 무시하는 것은 main과 같다. 그래서 e2e는 150 ms로 바꿨고, 시계가
정확한 단위 행은 300 ms 그대로다.

## 오너 질문

[화면 그대로] 아이폰에서 돌아온 직후 1초 안에 게스트가 YouTube 화면의 일시정지를 누르면, 그 누름이
YouTube 화면 안으로 초점을 옮기지 못한 경우 브라우저가 멈춘 것으로 보고 다시 맞춰 재생한다.
자동 맞춤이 진행 중인 약 2초 동안 누른 일시정지가 무시되는 것은 전에도 같았다. 이대로 둘지, 아니면
돌아온 뒤 들어온 멈춤은 모두 게스트가 누른 것으로 볼지(1초 창을 없애고 숨겨진 동안의 멈춤만 고침,
그러면 멈춤 신호가 돌아온 직후에 오는 경우는 지금처럼 멈춘 채로 남음) 정해 주시면 된다.

## 못 막는 경우

- 멈춤 신호가 돌아온 지 1초보다 늦게 처리되면 게스트가 누른 일시정지와 구분할 수 없어 지금처럼
  멈춘 채로 남는다(재생 버튼이나 동기화 버튼으로 풀림).
- 1초는 WebKit이 멈춤 신호를 언제 보내는지에 대한 가정이고, 아직 기기에서 잰 값이 아니다.
- 아이폰에서 탭이 iframe으로 초점을 옮기는지(창 blur, `document.activeElement`가 iframe)는 기기에서
  확인하지 않았다. 옮기지 않으면 위 오너 질문의 경우가 그대로 남는다.

## 기기 확인 (오너가 시험할 때)

게스트를 `?mxqrLog=debug`로 열고 "멈추는 순간 다시 열기"를 되풀이한 뒤 콘솔의 다음 줄을 본다.

- `[YouTube Native Control] Took the PAUSE for a browser stop of the hidden iframe`: 멈춤을 브라우저
  것으로 알아봄. 이어서 `[BackgroundReturnSync] guest-youtube-rendezvous after a browser stop`(1초 미만
  복귀) 또는 `[BackgroundReturnSync] guest-youtube-rendezvous`(1초 이상), 그 뒤 `[Rendezvous]` 줄.
- 그래도 멈춘 채면: 첫 줄이 없는지(신호가 1초보다 늦게 옴), 대신 `Applied endpoint-local pause`가
  있는지 본다.
- 돌아온 직후 YouTube 화면의 일시정지를 눌러 보고 `[YouTube Native Control] The iframe took focus after
  the return`이 찍히는지 본다(초점 신호가 아이폰에서 오는지).
