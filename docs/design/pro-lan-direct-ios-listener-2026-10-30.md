# PRO 시스템 오디오 LAN-direct: iPhone 청취자의 쌍 판정과 진단 줄 (2026-10-30)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 구현과 로컬 검사 완료, PR 전. 미병합·미배포이고 버전 올리기(bump)와 SW 캐시 epoch도 아직 없다(`guard:sw-cache-version`만 그 때문에 실패한다). 머지 SHA, Release ID, 배포 뒤 확인은 그 열차의 보고서와 배포 기록이 채운다                                                                                                                                                                         |
| Base               | main `cbbc56d9`(#534, App 9.0.26 / v799, 2026-10-30 13:08 KST 배포). 9.0.26의 배포 기록(배포 뒤 확인과 이 문제의 열린 항목)은 이 변경을 만들 때 아직 main에 없었다                                                                                                                                                                                                                             |
| Version            | 미정. 9.0.26 / v799가 운영에 있으므로 다음 App 패치와 SW 캐시 epoch(업데이트 창)를 열차의 bump 커밋이 올린다                                                                                                                                                                                                                                                                                  |
| Scope              | App 런타임 다섯 파일: 새 잎 모듈 `src/network/ice-selected-pair.ts`, `src/network/peer-state.ts`(동작 그대로 옮김), `src/network/pro-system-audio-direct.ts`, `src/network/pro-system-audio-sfu.ts`, `src/pro-room/system-audio-service.ts`. 화면은 그대로이고(오너 결정 [화면 그대로]) `?mxqrLog=info`에서 보이는 콘솔 줄만 는다. 서버 계약, 신호 프레임 모양, Worker, 저장 데이터는 바꾸지 않는다 |
| Deploy target      | `app`                                                                                                                                                                                                                                                                                                                                                                                       |
| Operations         | 운영 요청 없음. 원인 관찰은 9.0.26 배포 직후 확인(오너 방, Windows Edge 공유와 iPhone Safari 청취, 같은 Wi-Fi)이다                                                                                                                                                                                                                                                                             |
| Resource ownership | 새 흐름, 타이머, 재시도, 폴링이 없어 새 레코드는 없다. Standard 방의 선택 쌍 정제(refinement) 검사를 새 잎 모듈로 그대로 옮겨 두 규칙이 한 벌을 쓴다(사본 없음). RO-20 'Deadline owner'에 정제를 기다리는 쌍도 기존 증명 창 안에서 기다린다는 한 문장을 더했다. 시간 상수는 모두 제자리다                                                                                                         |

## 원인

9.0.26 배포 직후 확인(공유 세 번, 0 ~ 2)에서 Edge 공유자는 매번 0.82 ~ 0.94초에 응답을 받고 자기 쪽 쌍을 증명했지만,
iPhone Safari 청취자는 증명을 시작한 지 약 0.5초에 자기 쌍을 non-local로 판정했다(`Receiver LAN pair not proven
(non-local after 541 ms)`, 이어 `receiver-locality-unproven`). 공유자는 `receiver-fallback`으로 그 경로를 닫고 공유는
모두 SFU로 소리가 났다. 같은 두 기기의 Standard 방은 local로 붙는다.

원인 조사(이 저장소 밖의 작업 노트, WebKit과 그 안의 libwebrtc 소스 읽기와 Chromium 재현, 기기 측정 아님):

- iOS Safari는 LAN-direct의 응답자라서 ICE-controlled다. 공유자의 연결 확인(STUN check)이 Safari가 공유자의 mDNS
  이름을 풀기 전에 도착하면 libwebrtc는 그 상대 후보를 peer-reflexive(prflx)로 만든다. 이름이 풀리면 같은 연결의 상대
  후보를 그 자리에서 host로 바꾸지만(`Connection::MaybeUpdatePeerReflexiveCandidate`, 주소·포트·프로토콜·ufrag·세대가
  같아야 함) 선택 쌍 바뀜 알림은 없다. WebKit의 `getSelectedCandidatePair()`는 경로 바뀜 때만 새로 고치는 사본이라
  host→prflx로 남고, `getStats()`는 host→host를 보인다. Chromium도 같은 사본을 남긴다.
- PRO 규칙(`selectedPairLocality`)은 host가 아닌 형을 첫 연결 판독에서 바로 non-local로 돌려 끝냈다. Standard 방의
  `detectConnectionType`은 이 경우를 정제된 통계 쌍으로 확인한다.
- Windows의 Playwright WebKit에는 `RTCPeerConnection`이 없어 WebKit 재현은 못 했다. Playwright Chromium 153에서 같은
  libwebrtc 모양(공유자 후보가 1.5초 늦게 도착)을 재현했다: 받는 쪽 원래 쌍은 끝까지 `host/mdns → prflx/redacted`이고
  통계는 후보 추가 약 60 ms 뒤 host→host가 됐으며, 옛 규칙은 첫 판독에서 non-local, 새 규칙은 정제 뒤 증명이었다.
- 같은 증상을 내는 다른 원인 둘은 이 변경의 진단 줄로 가린다. (1) 공유자가 mDNS 후보를 보내지 않음: 출처가 카메라나
  마이크 권한을 가지면 Chromium은 숫자 주소 후보를 모으고(시작 화면 QR 스캐너가 카메라를 씀), PRO 후보 규칙은 그것을
  모두 버린다. (2) iPhone이 이름을 늦게 풀거나 못 품. 소스로 배제한 것: Safari가 mDNS host 후보를 숫자 주소로 보고(이름을
  유지하고 통계는 주소를 지움), 원장 키 불일치(그때는 non-local이 아니라 pending).

## 오너 결정

2026-10-30, 배포 직후 확인 다음: 다음 App 업데이트에서 청취자의 판정을 고치고 진단 줄(청취자 선택 쌍의 종류, IP 없이,
그리고 SFU 구독 단계 시간)을 넣는다. 화면은 바꾸지 않는다([화면 그대로]).

## 바뀐 것

1. 공유 정제 검사(`src/network/ice-selected-pair.ts`, import 없는 잎 모듈). Standard의 `getRefinedHostPair`와 그 도우미를
   동작 그대로 옮겼다(`findRefinedHostPair`, `nativePairIdentity`, `getIceEndpoint`, `visibleIceAddress`). 원래 쌍의
   host→prflx를 대신할 수 있는 것은 transport가 하나만 고른, 성공한 host→host 통계 쌍뿐이고, 두 끝점의 포트·프로토콜과
   양쪽이 보이는 주소, 보이는 ufrag(ICE 세대), 로컬 foundation이 같아야 한다. 지명(nominated)이나 성공만 한 쌍은 안
   된다. `peer-state.ts`가 이것을 부르고 Standard 시험 32행은 그대로 통과한다. E2E 관찰 도구
   (`e2e/helpers/production-ice-observation.ts`)는 Playwright가 그 함수만 직렬화하므로 자기 사본을 그대로 둔다.
2. PRO 규칙. 공유자의 협상, 수신자의 증명, 활성화 재증명, live 재증명이 모두 한 함수(`readSelectedPair`)를 쓰므로 두
   끝이 같은 규칙이다. 바뀌는 것은 (로컬 host, 상대 prflx) 원래 쌍뿐이다.
   - 원래 쌍이 보이는 주소는 host 규칙을 이미 지켜야 한다: 로컬은 사설(RFC1918, ULA, link-local) 숫자나 UUID mDNS,
     prflx 상대는 많아야 사설 숫자. 아니면 바로 non-local(`native-address`).
   - 그다음 통계를 읽고, 그동안 ICE transport 객체와 원래 쌍의 끝점·세대 필드가 그대로인지 다시 본다(바뀌면 그 판독은
     pending, `snapshot-changed`). 정제된 통계 쌍이 있으면 바뀌지 않은 통계 host 규칙을 적용한다: UDP, 이 경로와 협상에
     더한 엄격한 mDNS 후보의 foundation:port, 보이면 사설·mDNS 로컬과 mDNS 상대. 결과는 `refined-host`(증명),
     `refined-key-pending`(pending), `refined-address`(non-local).
   - 정제 전에는 pending(`prflx-unrefined`)이고 non-local이 아니다. 그래서 기존 증명 창(수신자 2초, 공유자 응답 뒤 1초)이
     정제를 볼 수 있다. 정제되지 않은 prflx는 끝내 증명되지 않고 그 창이 끝낸다. 원래 쌍이 없고 통계만 host→prflx를
     고른 경우도 같이 기다린다.
   - 그대로인 것: 다른 모든 비 host 형(로컬 prflx, srflx, relay, 상대 srflx·relay)은 첫 판독에서 non-local, 원래
     host→host 규칙, 후보 규칙(mDNS UDP host만, 경로당 2개), `iceServers: []`(TURN·STUN 없음), 모든 시한과 상수.
3. 쌍 확인 줄(info). 한 끝의 증명이 끝날 때 한 줄:
   - 수신자: `[ProSysAudioDirect] Receiver pair check <proven|non-local|deadline|disconnected|closed> after <ms> ms by
     <규칙> (connected at <ms> ms | never connected; native <형>/<주소 종류> to <형>/<주소 종류>; stats …; candidates
     sent <n>, refused <n>, added <n>)`. 공유자의 시한이 먼저 경로를 닫은 `closed`도 남긴다.
   - 공유자: `[ProSysAudioDirect] Publisher pair check to <id 끝 4자> …`, 그 경로의 결과 줄(`LAN route to …`) 바로 앞.
     단계 시한이 증명을 끊으면 `deadline`이다.
   - 공유자의 활성화·live 재증명이 실패하면: `[ProSysAudioDirect] Publisher pair reproof to <id 끝 4자>
     <non-local|pending> by <규칙> (native …; stats …; candidates …)`.
   - 형: host, srflx, prflx, relay, other, none. 주소 종류: mdns, private-ipv4, private-ipv6, link-local, public,
     other(UUID가 아닌 이름), none(없음, 빈 값, `redacted-*.invalid`, `0.0.0.0`, `::`). 규칙: native-host,
     native-key-pending, native-type, native-address, refined-host, refined-key-pending, refined-address,
     prflx-unrefined, snapshot-changed, stats-host, stats-key-pending, stats-type, stats-address, stats-ambiguous,
     stats-missing, unavailable, read-deadline(재증명 판독이 2초 안에 안 끝남), not-connected, no-reading.
   - sent는 이 끝이 신호로 보낸 mDNS UDP host 후보, refused는 이 끝이 모았지만 LAN 규칙이 버린 UDP 후보(새 경로별
     세기), added는 이 경로에 더한 상대 mDNS 후보(경로가 닫혀도 남는 세기)다.
   - IP 주소, 포트, foundation, ufrag, mDNS 이름, 방 코드, 참가자 id 전체는 어느 줄에도 없다(시험이 고정).
   - 기존 줄 `LAN route to …`, `Receiver LAN pair proven/not proven …`, `Receiver route ended before live (…)`는
     글자 그대로다.
4. SFU 구독 단계 줄(청취자, info). 구독마다 한 줄:
   `[ProSysAudioSFU] Subscription to generation <g> ready <ms> ms after the share notice (start a, config b, session c,
   tracks d, offer e, track f, answer g, subscribed h)`. 실패를 알리는 시도는 `… failed at <단계> <ms> ms after the
   share notice (<오류 이름>; <그때까지의 표시>)`. 표시는 구독이 이미 기다리는 단계에서 `Date.now()`를 읽을 뿐이다(TURN
   설정과 그 안의 capability 발급, Realtime new-session, tracks-new, 원격 제안 적용, 첫 원격 오디오 트랙, 응답 적용,
   renegotiate). 새 타이머나 재시도는 없다. 오류 이름은 닫힌 목록(TimeoutError, AbortError, InvalidStateError,
   InvalidAccessError, OperationError, NotSupportedError, SyntaxError, TypeError, ControlResponseTooLargeError,
   capability-cancelled, 그 밖은 Error)이고 메시지는 남기지 않는다(id가 들 수 있음). 멈춘 시도와 다른 시도에 밀린
   시도는 아무것도 남기지 않는다. 공유 알림 시각은 서비스가 새 SFU 발행의 수신을 시작한 때(`system-audio-start`의
   자리)이고, `subscribeProSystemAudioSfu(descriptor, { noticeAt })`의 새 선택 인자로 넘긴다. 같은 발행의 재시도는 같은
   시각을 써서 start가 기다린 시간을 보인다. 기존 `Received stereo track`과 `Subscribed to generation` 줄, 증거 고정의
   경로 줄 패턴은 그대로다.

## 위협과 지킨 것

- 정제되지 않은 host→prflx는 어떤 출발 주소에서 온 것이든 증명되지 않는다. LAN 밖의 주소가 보낸 확인도 같다.
- 정제된 host→host라도 상대 foundation:port가 이 경로와 협상에 더한 엄격한 UUID mDNS UDP 후보가 아니면 pending이다.
  숫자, SDP에 실린, TCP, 더하지 않은 후보로는 증명할 수 없다.
- 원래 쌍과 같은 연결이 아닌 통계 쌍(다른 포트·프로토콜, 양쪽이 보이는데 다른 주소, 다른 ufrag, 다른 로컬
  foundation)은 정제로 보지 않는다. transport 선택이 없거나 둘인 것, 성공하지 않은 것, transportId 역참조가 없거나 다른
  것, 후보 보고서 형이 뒤바뀐 것, 포트나 프로토콜이 없는 것도 같다.
- 원래 쌍이 공인·CGNAT·루프백 같은 비사설 로컬 주소나 비사설 prflx 주소를 보이면 바로 non-local이다. 정제된 통계가
  공인 로컬 주소를 보이면 non-local(`refined-address`)이다.
- 통계를 읽는 동안 원래 쌍이나 ICE transport가 바뀌면 그 판독은 pending이다. 두 객체의 근거를 섞지 않는다.
- 공유자도 같은 함수를 쓰므로 수신자가 거절할 것을 받아들이지 않는다. live 5초 재증명과 연결 바뀜 재증명은 정제가
  사라지거나 풀린 경로를 예전처럼 SFU로 승격한다.
- 범위 밖(오너 결정 거리): 포트만 맞는 정제되지 않은 prflx를 받아들이는 것. 받는 쪽은 prflx 주소를 볼 수 없어(원래 쌍은
  가리고 WebKit 통계는 지움) LAN 밖에서 온 것인지 가를 수 없으므로 문서화된 불변식을 깬다.

## 시간과 섞인 버전

- 정제가 제때 오면 청취자는 그때 증명하고, 공유자의 수신자 증명 시한(응답 + 1초, `DIRECT_PAIR_PROOF_TIMEOUT_MS`)은
  그대로다. 9.0.26 공유 1에서 청취자가 연결된 쌍을 처음 본 것은 그 시한보다 약 0.45초 앞이었다. 정제가 더 늦으면 여전히
  SFU로 가고, 이제 청취자의 `closed … by prflx-unrefined` 줄이 근거가 된다. 이 상수를 바꾸는 것은 RO-20 시한 주인의 오너
  결정이라 여기서 바꾸지 않는다.
- 정제되지 않는 청취자는 이제 `receiver-fallback`으로 약 0.4초 일찍 끝나는 대신 공유자의 시한(응답 + 1초)에 끝난다.
  문서화된 한 경로 최대 3초 안이다.
- 섞인 버전: 신호 모양과 서버 계약이 같아 9.0.26과 이 빌드 사이에도 경로가 생긴다. 고쳐지는 쪽은 청취자의 판정이라
  9.0.26 공유자와 새 청취자도 LAN-direct가 될 수 있다(9.0.26 현장처럼 공유자가 자기 쌍을 증명할 때). 9.0.26
  청취자는 예전처럼 SFU다. 바닥을 올리지 않는다(SFU가 이미 안전한 끝이다).
- 되돌리기: App만 9.0.26으로 되돌리면 청취자는 예전처럼 거절하고 SFU로 소리가 난다. 서버 쪽 되돌림은 없다.

## QA 라운드

### 1. 로컬(2026-10-30, 브랜치 `agent/lan-ios-listener`, main `cbbc56d9` 위)

Node 24.22.2 / npm 12.0.2(저장소 고정 버전), Windows.

- 테스트 먼저 `6eb40a04`(시험만): 부모 `cbbc56d9`의 런타임으로 돌리면 바꾼 시험 파일 넷에서 52행이 실패하고(170 통과), 새
  `ice-selected-pair.test.ts`(29행)는 모듈이 없어 불러오지 못한다. 실패한 행: 직접 경로의 새 행 36(청취자의 정제 증명과
  기다림, 위협 거절, 주소 종류 표 16, 공유자 셋, 사생활 행)과 전체 info 목록을 고정한 기존 행 다섯, SFU 단계 줄 새 행
  다섯, 서비스의 새 행 하나와 구독 인자를 고정한 기존 행 셋, 청취자 증거 고정 둘. SFU의 '멈춘 시도는 아무것도 남기지
  않음' 행은 부모에도 줄이 없으므로 부모에서도 통과한다.
- 구현: `dc704605`(공유 정제 모듈, PRO 규칙, 쌍 확인 줄), `f4ac3bf2`(SFU 구독 단계 줄과 서비스의 공유 알림 시각).
  바꾼 시험 다섯과 Standard 정제 32행, PRO 수신 슬롯 전송 계약, 공유자 증거 고정이 모두 통과(8 files / 336 tests).
- 검사: 아래 '검사 결과'.
- 확인하지 않은 것: 실기기(Edge 공유와 iPhone Safari 청취, 같은 Wi-Fi). Windows에서는 WebKit 재현이 안 되고 브라우저
  시험(E2E)에는 PRO LAN-direct 행이 없다. 실제 iOS가 정제를 증명 창 안에 마치는지, 원인 (1)·(2)가 아닌지는 배포 뒤
  줄로만 안다.

### 검사 결과(`f4ac3bf2`의 런타임, 문서 커밋 위)

- 전체 단위 시험(`vitest run --maxWorkers=6`): 707 files / 16,839 tests 가운데 16,838 통과. 실패 하나는
  `sw-cache-version-guard.test.ts`의 git 저장소를 만드는 행이 15초 시한에 걸린 것이고, 그 파일만 다시 돌리면(문서를 읽는
  시험 17 파일과 함께) 18 files / 1,296 tests 모두 통과했다. 이 변경과 관계없는 시간 초과다.
- `npm run typecheck`(앱, 시험, Worker, 도구 전부), `npm run lint`, `npm run format:check` 통과.
- 가드: `guard:` 스크립트 37개 가운데 `guard:sw-cache-version` 하나만 실패했다. 버전 올리기가 없어서이고, v799(`cbbc56d9`)
  보다 새 PWA 런타임 변경으로 이 변경의 다섯 파일만 든다. `guard:release-identity`는 'MUSIXQUARE 9.0.26; service-worker
  cache epoch v799'로 통과. `guard:dead-exports`(새 export 넷은 모두 운영 코드가 씀, 기준치 그대로), `guard:import-graph`
  (새 잎 모듈, 순환 없음), `npm run build` 뒤의 dist 가드(`guard:initial-transfer-budget` 포함) 통과.
- `node scripts/check-resource-ownership.mts`: 49 registry records / 449 production files로 통과(새 모듈만큼 파일 하나
  늘고 기준치는 그대로).
- `npm run test:e2e:critical`: 100 passed(4.7 min). PRO 시스템 오디오 E2E 묶음은 없다. Standard 정제를 옮겼으므로
  Standard 시스템 오디오 E2E `e2e/system-audio-controls.test.ts`도 돌려 5 passed.

## 배포 뒤 확인(제안, 게이트 아님)

같은 구성(Edge 공유, iPhone Safari 청취, 같은 Wi-Fi), 두 기기 모두 `?mxqrLog=info`의 `/debug console`에서 공유마다
공유자의 `Publisher pair check to …`와 `LAN route to …`, 청취자의 `Receiver pair check …`와 (SFU로 갔다면)
`Subscription to generation …` 줄을 모은다. 통과: 청취자 `Receiver pair check proven … by refined-host`(또는
`native-host`)와 공유자 `LAN route to … proven`, 그리고 소리. 아니면 줄이 원인을 가린다:

| 청취자 줄                                                    | 공유자 줄                                        | 읽는 법                                               |
| ------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| `proven … by refined-host (native host/mdns to prflx/none …)` | `LAN route … proven`                             | 고쳐짐(원인 확인)                                     |
| `closed … by prflx-unrefined … added 1`                      | `not proven at receiver-proof … (deadline …)`    | 정제가 공유자 시한보다 늦음(시한은 오너 결정)         |
| `… by prflx-unrefined … added 0`                             | `… candidates sent 0, refused 1 이상 …`          | 공유자가 mDNS 후보를 안 보냄(카메라·마이크 권한 의심) |
| `non-local … by native-address` 또는 `native-type`           |                                                  | 종류와 형이 다른 원인을 말함                          |
