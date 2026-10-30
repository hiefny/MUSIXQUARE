# PRO 시스템 오디오 LAN-direct: iPhone 청취자의 쌍 판정과 진단 줄 (2026-10-30)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 구현, 리뷰 반영(라운드 2), 로컬 검사 완료, PR 전. 미병합·미배포이고 버전 올리기(bump)와 SW 캐시 epoch도 아직 없다(`guard:sw-cache-version`만 그 때문에 실패한다). 머지 SHA, Release ID, 배포 뒤 확인은 그 열차의 보고서와 배포 기록이 채운다                                                                                                                                                        |
| Base               | main `cbbc56d9`(#534, App 9.0.26 / v799, 2026-10-30 13:08 KST 배포). 9.0.26의 배포 기록(배포 뒤 확인과 이 문제의 열린 항목)은 이 변경을 만들 때 아직 main에 없었다                                                                                                                                                                                                                                  |
| Version            | 미정. 9.0.26 / v799가 운영에 있으므로 다음 App 패치와 SW 캐시 epoch(업데이트 창)를 열차의 bump 커밋이 올린다                                                                                                                                                                                                                                                                                        |
| Scope              | App 런타임 다섯 파일: 새 잎 모듈 `src/network/ice-selected-pair.ts`, `src/network/peer-state.ts`(동작 그대로 옮김), `src/network/pro-system-audio-direct.ts`, `src/network/pro-system-audio-sfu.ts`, `src/pro-room/system-audio-service.ts`. 화면은 그대로이고(오너 결정 [화면 그대로]) `?mxqrLog=info`에서 보이는 콘솔 줄만 는다. 서버 계약, 신호 프레임 모양, Worker, 저장 데이터는 바꾸지 않는다 |
| Deploy target      | `app`                                                                                                                                                                                                                                                                                                                                                                                               |
| Operations         | 운영 요청 없음. 원인 관찰은 9.0.26 배포 직후 확인(오너 방, Windows Edge 공유와 iPhone Safari 청취, 같은 Wi-Fi)이다                                                                                                                                                                                                                                                                                  |
| Resource ownership | 새 흐름, 타이머, 재시도, 폴링이 없어 새 레코드는 없다. Standard 방의 선택 쌍 정제(refinement) 검사를 새 잎 모듈로 그대로 옮겨 두 규칙이 한 벌을 쓴다(사본 없음, PRO만 켜는 선택 인자 하나). RO-20 'Deadline owner'에 정제를 기다리는 쌍도 기존 증명 창 안에서 기다린다는 한 문장을 더했다. 시간 상수는 모두 제자리다. 서비스의 진단 전용 상태 `coordinatorShareNoticeAt` 하나가 늘었다(아래 4)      |

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
  모두 버린다. (2) iPhone이 이름을 늦게 풀거나 못 품. 소스 읽기로 낮게 본 것(측정 아님): Safari가 mDNS host 후보를 숫자
  주소로 보고(libwebrtc는 이름을 유지하고 WebKit 통계는 주소를 지움), 원장 키 불일치(그때는 non-local이 아니라 pending).
  이 둘과 다른 남은 원인은 고치지 않고 줄로만 가른다('위협과 지킨 것'의 남은 위험).

## 오너 결정

2026-10-30, 배포 직후 확인 다음: 다음 App 업데이트에서 청취자의 판정을 고치고 진단 줄(청취자 선택 쌍의 종류, IP 없이,
그리고 SFU 구독 단계 시간)을 넣는다. 화면은 바꾸지 않는다([화면 그대로]).

## 바뀐 것

1. 공유 정제 검사(`src/network/ice-selected-pair.ts`, import 없는 잎 모듈). Standard의 `getRefinedHostPair`와 그 도우미를
   동작 그대로 옮겼다(`findRefinedHostPair`, `nativePairIdentity`, `getIceEndpoint`, `visibleIceAddress`). 원래 쌍의
   host→prflx를 대신할 수 있는 것은 transport가 하나만 고른, 성공한 host→host 통계 쌍뿐이다. 맞춤은 간접적이다: 두
   끝점의 포트·프로토콜이 같아야 하고, 주소·ufrag(ICE 세대)·로컬 foundation은 양쪽이 다 보일 때만 비교한다. 원래 쌍의
   prflx 주소는 늘 가려져 있어 비교하지 않으므로 상대 쪽은 포트·프로토콜과 (보이면) ufrag에 기댄다. 지명(nominated)이나
   성공만 한 쌍은 안 된다. PRO만 켜는 선택 인자(`allowAnsweredInProgress`)가 하나 있고 기본값은 그대로다.
   `peer-state.ts`가 이것을 부르고 Standard 시험 32행은 그대로 통과한다. E2E 관찰 도구
   (`e2e/helpers/production-ice-observation.ts`)는 Playwright가 그 함수만 직렬화하므로 자기 사본을 그대로 둔다.
2. PRO 규칙. 공유자의 협상, 수신자의 증명, 활성화 재증명, live 재증명이 모두 한 함수(`readSelectedPair`)를 쓰므로 두
   끝이 같은 규칙이다. 바뀌는 것은 (로컬 host, 상대 prflx) 원래 쌍뿐이다.
   - 원래 쌍이 보이는 주소는 host 규칙을 이미 지켜야 한다: 로컬은 사설(RFC1918, ULA, link-local) 숫자나 UUID mDNS,
     prflx 상대는 많아야 사설 숫자. 아니면 바로 non-local(`native-address`). 정제 맞춤이 상대 주소를 비교하지 않으므로
     이 검사가 무게를 진다.
   - 그다음 통계를 읽고, 그동안 ICE transport 객체와 원래 쌍의 끝점·세대 필드가 그대로인지 다시 본다(바뀌면 그 판독은
     pending, `snapshot-changed`). 정제된 통계 쌍이 있으면 바뀌지 않은 통계 host 규칙을 적용한다: UDP, 이 경로와 협상에
     더한 엄격한 mDNS 후보의 foundation:port, 보이면 사설·mDNS 로컬과 mDNS 상대. 결과는 `refined-host`(증명),
     `refined-key-pending`(pending), `refined-address`(non-local).
   - 리뷰 반영(라운드 2): 통계가 쌍을 둘 이상 고르면 통계 전용 경로처럼 바로 non-local(`stats-ambiguous`). 같은 로컬
     후보에서 원래 쌍의 상대 포트로 가는 prflx 연결이 통계에 아직 있으면 pending(`prflx-still-listed`): 제자리 정제는
     그 prflx를 목록에서 없애므로, 남아 있으면 원래 쌍이 정제된 연결이 아니라 그 prflx일 수 있다. 정제된 선택 쌍은
     성공(succeeded)이어야 하고, 확인 응답을 한 번 이상 받은(`responsesReceived` > 0) 'in-progress'도 받는다:
     libwebrtc는 선택 연결의 consent 확인(약 2.5초마다)마다 한 왕복 동안 in-progress로 표시하므로, 5초 live 재증명과
     활성화 재증명이 그 순간을 만나 공유 도중 SFU로 승격하던 것을 막는다. 응답이 없는 in-progress는 여전히 증명이 아니다.
     WebKit 통계에 `responsesReceived`가 없으면 succeeded만 받는다.
   - 정제 전에는 pending(`prflx-unrefined`)이고 non-local이 아니다. 그래서 기존 증명 창(수신자 2초, 공유자 응답 뒤 1초)이
     정제를 볼 수 있다. 정제되지 않은 prflx는 끝내 증명되지 않고 그 창이 끝낸다. 원래 쌍이 없고 통계만 host→prflx를
     고른 경우도 같이 기다린다.
   - 그대로인 것: 다른 모든 비 host 형(로컬 prflx, srflx, relay, 상대 srflx·relay)은 첫 판독에서 non-local, 원래
     host→host 규칙, 후보 규칙(mDNS UDP host만, 경로당 2개), `iceServers: []`(TURN·STUN 없음), 모든 시한과 상수.
3. 쌍 확인 줄(info). 한 끝의 증명이 끝날 때 한 줄:
   - 수신자: `[ProSysAudioDirect] Receiver pair check <proven|non-local|deadline|disconnected|closed> after <ms> ms by
<규칙> (connected at <ms> ms | never connected; native <형>/<주소 종류> to <형>/<주소 종류>; stats …; candidates
sent <n>, refused <n>, received <n>, added <n>[, first at <ms> ms])`. 공유자의 시한이 먼저 경로를 닫은 `closed`도
     남긴다. 닫힘과 겹친 판독(닫힌 transport와 지운 원장을 본 것)은 버리고 경로가 살아 있을 때의 마지막 판독을 남긴다.
   - 공유자: `[ProSysAudioDirect] Publisher pair check to <id 끝 4자> …`, 그 경로의 결과 줄(`LAN route to …`) 바로 앞.
     단계 시한이 증명을 끊으면 `deadline`이다.
   - 공유자의 활성화·live 재증명이 실패하면: `[ProSysAudioDirect] Publisher pair reproof to <id 끝 4자>
<non-local|pending> by <규칙> (native …; stats …; candidates …)`.
   - 형: host, srflx, prflx, relay, other, none. 주소 종류: mdns, private-ipv4, private-ipv6, link-local, public,
     other(UUID가 아닌 이름), none(없음, 빈 값, `redacted-*.invalid`, `0.0.0.0`, `::`). 규칙: native-host,
     native-key-pending, native-type, native-address, refined-host, refined-key-pending, refined-address,
     prflx-unrefined, prflx-still-listed, snapshot-changed, stats-host, stats-key-pending, stats-type, stats-address,
     stats-ambiguous, stats-missing, unavailable, read-deadline(재증명 판독이 2초 안에 안 끝남), not-connected,
     no-reading.
   - sent는 이 끝이 신호로 보낸 mDNS UDP host 후보, refused는 이 끝이 모았지만 LAN 규칙이 버린 UDP 후보(새 경로별
     세기), received는 상대가 보낸 것 가운데 LAN 규칙을 지킨 서로 다른 후보(아직 더하지 못한 것과 원격 설명 전에 줄 선
     것 포함), added는 이 경로에 더한 상대 mDNS 후보(경로가 닫혀도 남는 세기)다. first at은 첫 상대 후보를 더한 때를 그
     증명의 시작 기준으로 잰 것(앞서면 음수)이고, 정제는 그 뒤에만 올 수 있으므로 끝 시각과의 차가 정제를 기다린 시간이다.
     재증명 줄에는 first at이 없다.
   - IP 주소, 포트, foundation, ufrag, mDNS 이름, 방 코드, 참가자 id 전체는 어느 줄에도 없다(시험이 고정).
   - 기존 줄 `LAN route to …`, `Receiver LAN pair proven/not proven …`, `Receiver route ended before live (…)`는
     글자 그대로다.
4. SFU 구독 단계 줄(청취자, info). 구독마다 한 줄:
   `[ProSysAudioSFU] Subscription to generation <g> ready <ms> ms after the share notice (start a, config b, session c,
tracks d, offer e, track f, answer g, subscribed h)`. 실패를 알리는 시도는 `… failed at <단계> <ms> ms after the
share notice (<오류 이름>; <그때까지의 표시>)`이고, 시도 도중 구독 연결이 failed가 되면(그때 멈춤이 시도의 거절을
   조용히 만든다) 그 자리에서 같은 줄을 `connection-failed`로 남긴다. 구독이 끝난 뒤의 연결 실패는 줄을 남기지 않는다.
   시작 전에 거절된 구독(잘못된 서술자, 로컬 시계로 만료, 낡거나 충돌하는 세대)은 `[ProSysAudioSFU] Subscription [to
generation <g>] failed before start (<invalid|expired|stale-generation|conflicting-generation>)` 한 줄이다(id 없음).
   표시는 구독이 이미 기다리는 단계에서 `Date.now()`를 읽을 뿐이다(TURN
   설정과 그 안의 capability 발급, Realtime new-session, tracks-new, 원격 제안 적용, 첫 원격 오디오 트랙, 응답 적용,
   renegotiate). 새 타이머나 재시도는 없다. 오류 이름은 닫힌 목록(TimeoutError, AbortError, InvalidStateError,
   InvalidAccessError, OperationError, NotSupportedError, SyntaxError, TypeError, ControlResponseTooLargeError,
   capability-cancelled, 그 밖은 Error)이고 메시지는 남기지 않는다(id가 들 수 있음). 멈춘 시도와 다른 시도에 밀린
   시도는 아무것도 남기지 않는다. 공유 알림 시각은 서비스가 새 SFU 발행의 수신을 시작한 때(`system-audio-start`의
   자리)이고, `subscribeProSystemAudioSfu(descriptor, { noticeAt })`의 새 선택 인자로 넘긴다. 같은 발행의 재시도는 첫
   구독이 성공할 때까지 같은 시각을 써서 start가 기다린 시간을 보인다. 성공한 뒤의 재구독(몇 분 뒤 연결 실패 등)은 공유
   알림 시각 없이 자기 호출부터 세고 줄도 `after the subscribe call`이라 쓴다(알림 시각이 없거나 미래인 호출도 같다).
   그 시각은 서비스의 진단 전용 상태 `coordinatorShareNoticeAt`이다: SFU 갈래가 발행 키를 정할 때만 정하고, 그 발행이
   구독되면 비우고, 키를 비우는 정리(`cleanupCoordinatorGraph`)에서 같이 비운다. 어떤 동작도 이것을 읽지 않으며, 어긋나도
   줄의 기준이 호출 시각으로 옮겨 갈 뿐이다. 기존 `Received stereo track`과 `Subscribed to generation` 줄, 증거 고정의
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
- 같은 로컬 후보에서 원래 쌍의 상대 포트로 가는 prflx 연결이 통계에 남아 있으면 정제로 보지 않는다(`prflx-still-listed`).
  같은 소켓에서 다른 주소로 같은 포트·ufrag를 쓰는 두 연결을 통계와 원래 쌍이 서로 다르게 보이는 경쟁을 닫는다. 통제
  측 공유자가 증명 뒤 다른 쌍으로 재지명하는 것은 여전히 수신자가 다시 증명하지 않는 기존 한계다(수신자 증명은 한 번).
- 응답을 받은 적 없는 'in-progress' 선택 쌍은 증명이 아니다. 응답을 받은 쌍의 in-progress만 consent 확인 중으로 본다.
- 범위 밖(오너 결정 거리): 포트만 맞는 정제되지 않은 prflx를 받아들이는 것. 받는 쪽은 prflx 주소를 볼 수 없어(원래 쌍은
  가리고 WebKit 통계는 지움) LAN 밖에서 온 것인지 가를 수 없으므로 문서화된 불변식을 깬다.

### 남은 위험과 한계(리뷰 라운드 2, 고치지 않음)

- mDNS 전제(물려받음): 자바스크립트는 mDNS 이름이 푼 주소를 볼 수 없다. 통계가 주소를 가리면 증명은 원장의 엄격한 mDNS
  후보에만 기댄다. LAN 안의 적대적이거나 잘못 설정된 mDNS 응답자(mDNS는 인증 없음), 또는 전역 주소로 답하는 이중 연결
  공유자가 있으면 원장과 맞는 host 쌍이 인터넷을 지날 수 있다. LAN 안의 당사자가 필요해 원격으로 강제할 수 없다. 통계가
  보이는 숫자 로컬 주소는 여전히 사설·link-local이어야 하고, 주소가 가려질 때 same-subnet으로 보는 규칙을 다른 경로로
  넓히지 않는다. `pro-room-server-authority.md`에 수용한 남은 위험으로 적었다.
- 소스 읽기로 낮게 본 원인(Safari가 mDNS 상대를 숫자 주소로 보임)은 고치지 않았다: WebKit이 푼 사설 주소를 내보이면 줄은 `non-local … by native-address
(native host/… to host/private-ipv4 …)` 또는 `by refined-address`다. 그때의 좁은 후속은 상대 foundation:port가 원장에
  있을 때 이름 대신 RFC1918·ULA·link-local 숫자 상대를 받는 것이고(공인·CGNAT·루프백은 계속 거절), 공유자도 같은
  규칙을 써야 한다.
- 청취자 자신의 로컬 주소: WebKit이 자기 host 후보를 libwebrtc 밖에서 가리면 원래 쌍과 통계가 iPhone의 숫자 주소를
  보이고, IPv6 Wi-Fi에서는 전역(GUA) 쌍이 고를 수 있다. 로컬 규칙은 사설·link-local·mDNS만 받으므로 첫 판독에서
  거절한다(`non-local … by native-address (native host/public to host/mdns …)`, 공유자는 증명). 고치려면 원장과 맞는
  mDNS 상대일 때만 GUA 로컬을 받는 오너 수준의 불변식 변경이고, 공유자도 같이 바꿔야 한다.
- WebKit 통계 필드: 정제 증명은 `transport`의 `selectedCandidatePairId` 하나, `transportId`로 이어진 candidate-pair,
  상대 후보의 `foundation`·`port`를 읽는다. Windows에서는 WebKit을 돌릴 수 없어 시험의 WebKit 모양 통계는 본뜬 것이다.
  어떤 iOS가 상대 foundation을 빼면 정제 뒤에도 `refined-key-pending … added 1`, transportId를 빼면 `prflx-unrefined`로
  시한까지 남는다.

## 시간과 섞인 버전

- 정제가 제때 오면 청취자는 그때 증명하고, 공유자의 수신자 증명 시한(응답 + 1초, `DIRECT_PAIR_PROOF_TIMEOUT_MS`)은
  그대로다. 9.0.26 공유 1에서 청취자가 연결된 쌍을 처음 본 것(옛 규칙은 거기서 거절했다)은 공유자 시계로 약 1.5초,
  그 시한(응답 0.89초 + 1초, 약 1.89초)보다 약 0.4초 앞이었다. 두 시계는 그 거절과 공유자의 `receiver-fallback`
  수신(1,509 ms)을 맞춰 정렬한 추정이라 실제로는 신호가 건너간 시간만큼 조금 더 이르다. 정제가 더 늦으면 여전히 SFU로
  가고, 이제 청취자의 `closed … by prflx-unrefined` 줄이 근거가 된다. 이 상수를 바꾸는 것은 RO-20 시한 주인의 오너
  결정이라 여기서 바꾸지 않는다.
- 그래서 이 증분은 진단과 조건부 수정이다. 고쳐지는 것은 iOS가 공유자의 이름을 풀고 연결이 정제된 것이 공유자의 수신자
  증명 시한 안일 때뿐이다. 9.0.26 공유 1에서 첫 연결 판독(공유자 시계로 약 1.5초, 청취자가 증명을 시작한 약 0.97초의
  541 ms 뒤)은 아직 prflx로 보였고 시한까지 약 0.4초가 남았다. Wi-Fi 멀티캐스트 손실로 mDNS 재전송이 한 번 필요하거나
  (약 1초 간격) Windows 방화벽이 Edge의 mDNS 응답(UDP 5353)을 막으면 정제는 시한 뒤거나 오지 않는다. iPhone 열린 항목은 기기 줄이 `proven … by refined-host`를 보일
  때까지 열려 있다. 줄이 시한에 `prflx-unrefined … added 1, first at <ms> ms`를 보이면 다음은 규칙 변경이 아니라 수신자
  증명 창(`DIRECT_PAIR_PROOF_TIMEOUT_MS`)에 대한 RO-20 오너 결정이다.
- 정제되지 않는 청취자는 이제 첫 연결 판독에서 `receiver-fallback`으로 끝나는 대신 공유자의 시한(응답 + 1초)에 끝난다.
  늦어지는 만큼은 첫 연결 판독부터 그 시한까지라 최대 약 1초다(연결이 응답 직후에 되면 거의 1초, 늦게 연결된 9.0.26 공유
  1이라면 약 0.4초). 문서화된 한 경로 최대 3초 안이다. 정제되지 않는 prflx는 역할과 브라우저에 관계없이 모두 이 느린
  쪽이다: 공유자 자신의 쌍도, Firefox(nICEr는 prflx를 제자리 정제하지 않고 transport 통계가 없어 통계 전용 경로)와 이름을
  풀지 못하는 iPhone도, 한쪽이 상대의 mDNS 이름을 풀지 못하는 LAN도 그렇다. 공유는 모든 경로의 증명을 기다리므로
  기다리는 한 경로가 그 시도의 모든 청취자의 SFU 대체를 늦춘다. 이 지연이 SFU 구독(약 5초) 앞에 붙는 것을 받아들일지는
  오너 확인 거리다([화면 그대로]는 화면만 정했다). 열차 보고서가 이 질문을 열린 오너 질문으로 들고 머지 전에 오너에게
  보인다. 오너는 2026-10-31에 답했다: 9.0.27은 이 기다림을 그대로 두고 LAN 후보 없이 수집을 끝낸 경로만 바로
  끝내며(`no-lan-candidate`), 9.0.28이 SFU 발행을 LAN-direct 시도와 나란히 미리 시작한다(열차 보고서 '오너 결정').
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

### 2. 리뷰 반영(2026-10-30, 같은 브랜치, `8e4ac4e6` 위)

독립 리뷰의 지적 17건(중간 3, 낮음 14)을 코드에 대어 보고 반영했다. 중간 셋: live·활성화 재증명이 consent 확인 중인
정제 쌍('in-progress')을 만나 공유 도중 SFU로 승격함, 닫힘과 겹친 판독이 쌍 확인 줄의 마지막 판독을 덮음, 그리고 수정이
iOS의 정제 시점에 달린 조건부라는 점(문서와 `first at` 진단으로 반영).

- 테스트 먼저 `10431823`(시험만): 새 행 24 가운데 10과 형식이 바뀐 기존 행 16, 모두 26행이 부모 `8e4ac4e6`에서 실패한다.
  부모에서도 통과하는 새 행 14는 이미 맞는 동작을 고정한다: 공유 정제의 기본값이 in-progress를 거절하는 6행, 숫자 주소
  통계를 종류로만 쓰는 사생활 6행, 응답 없는 in-progress를 증명하지 않는 행, 구독이 끝난 뒤의 연결 실패에 줄이 없는 행.
- 구현: `85a29f03`(정제 쌍의 응답 받은 in-progress 허용, `prflx-still-listed`, 정제 경로의 `stats-ambiguous`, 닫힘 뒤
  판독 버림, received와 first at), `70cdb078`(SFU 연결 실패와 시작 전 거절 줄, 구독 뒤 재구독의 기준), `9f013814`(형
  우회 없이 응답 수 읽기: `type-escape-holdouts` 시험이 잡음).
- 받아들이지 않은 것: 재증명을 기한 안에서 반복 폴링하는 안(정제되지 않은 prflx로 바뀐 live 경로에 최대 2초 동안 소리를
  계속 보내게 되므로 좁은 in-progress 허용을 골랐다), 판독 중 원래 쌍이 바뀌면 다시 읽는 안(재시도를 더하고, live 경로의
  쌍 바뀜은 드물며 SFU 승격이 문서화된 대응이다), 정제를 두 번 연속 같은 쌍 id로 확인하는 안(지연만 늘림), 원장이 찼고
  prflx 포트와 맞는 키가 없으면 일찍 non-local로 끝내는 안(창 안의 지연은 문서화된 3초 한도 안), 서비스 상태를 없애고
  콘솔 시각으로 맞추는 안(오너가 공유 알림부터의 단계 시간을 요청했다; 상태의 수명을 위 4에 적었다), 타이머 수를 세는 시험
  (만료·폴 타이머가 섞여 깨지기 쉬움; 단계 표시는 동기 `Date.now()` 읽기다).
- 다시 돌린 검사(`9f013814` 런타임, 문서 반영 전): 바꾼 시험 다섯과 Standard 정제, 증거 고정(8 files / 322 tests) 통과.
  전체 단위 시험 707 files / 16,863 tests 모두 통과(첫 실행에서 `type-escape-holdouts`가 `9f013814`로 고친 이중 단언을
  잡았고, 고친 뒤 전체를 다시 돌렸다). `npm run typecheck`, `npm run lint`, `npm run format:check` 통과.
  `node scripts/check-resource-ownership.mts` 49 records / 449 files 통과(기준치 그대로). `guard:dead-exports`,
  `guard:import-graph`, `guard:release-identity` 통과, `guard:sw-cache-version`만 버전 올리기가 없어 실패(예상대로).
  문서 반영 뒤 `docs/`를 읽는 시험 10 files / 1,060 tests와 `format:check`를 다시 돌려 통과. 빌드와 E2E는 이 라운드에서
  다시 돌리지 않았다.
- 확인하지 않은 것: 실기기. libwebrtc가 consent 확인 동안 선택 쌍을 in-progress로 표시한다는 것은 소스 읽기이고 여기서
  측정하지 않았다.

## 배포 뒤 확인(제안, 게이트 아님)

같은 구성(Edge 공유, iPhone Safari 청취, 같은 Wi-Fi), 두 기기 모두 `?mxqrLog=info`의 `/debug console`에서 공유마다
공유자의 `Publisher pair check to …`와 `LAN route to …`, 청취자의 `Receiver pair check …`와 (SFU로 갔다면)
`Subscription to generation …` 줄을 모은다. iPhone의 iOS 버전도 같이 적는다(통계 필드가 버전마다 다르다). 통과: 청취자
`Receiver pair check proven … by refined-host`(또는 `native-host`, 원래 쌍을 보지 못한 통계 전용 경로의 `stats-host`)와
공유자 `LAN route to … proven`, 그리고 소리. 아니면 줄이 원인을 가린다. 청취자의 `added`는 공유자의 `sent`와, 청취자의
`received`와 늘 맞춰 읽는다:

| 청취자 줄                                                                                                                                    | 공유자 줄                                                                                                                                                  | 읽는 법                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `proven … by refined-host (native host/mdns to prflx/none …)`                                                                                | `LAN route … proven`                                                                                                                                       | 고쳐짐(원인 확인)                                                                                                  |
| `closed … by prflx-unrefined … added 1`                                                                                                      | `not proven at receiver-proof … (deadline …)`                                                                                                              | 정제가 공유자 시한보다 늦음(시한은 오너 결정)                                                                      |
| 줄 없음, 또는 `closed … received 0, added 0`                                                                                                 | `Publisher gathering to … ended with no LAN candidate (candidates sent 0, refused <n>, …)`과 `LAN route to … not proven at answer … (no-lan-candidate; …)` | 공유자가 mDNS 후보를 안 보냄. 수집이 끝난 때 바로 SFU로 감(refused 1 이상이면 공유 기기의 카메라·마이크 권한 의심) |
| `Receiver gathering ended with no LAN candidate (candidates sent 0, refused <n>, …)`과 `Receiver route ended before live (no-lan-candidate)` | `LAN route to … not proven at <answer 또는 pair> … (receiver-fallback; …)`                                                                                 | 청취자가 mDNS 후보를 안 보냄. 응답 무렵 바로 SFU로 감(refused 1 이상이면 청취 기기의 권한 의심)                    |
| `… by prflx-unrefined … received 1, added 0`                                                                                                 | `… candidates sent 1 …`                                                                                                                                    | 후보는 왔지만 더하기(addIceCandidate)가 안 끝남                                                                    |
| `… by refined-key-pending … added 1`                                                                                                         |                                                                                                                                                            | 통계에 상대 foundation이 없음(iOS 버전 확인)                                                                       |
| `… by prflx-still-listed …`                                                                                                                  |                                                                                                                                                            | 같은 소켓·포트의 prflx 연결이 남음(이중 연결 기기)                                                                 |
| `non-local … by native-address (native host/public to …)`                                                                                    | `LAN route … proven` 또는 `… proven`                                                                                                                       | 청취자의 로컬이 전역 IPv6(남은 한계, 오너 결정 거리)                                                               |
| `non-local … by native-address (… to host/private-ipv4 …)`                                                                                   |                                                                                                                                                            | WebKit이 mDNS 상대를 숫자 주소로 보임(남은 한계)                                                                   |
| `non-local … by native-type` 또는 다른 `native-address`                                                                                      |                                                                                                                                                            | 종류와 형이 다른 원인을 말함                                                                                       |

수집 끝 줄 둘(`… gathering … ended with no LAN candidate`)과 이유 `no-lan-candidate`는 2026-10-31 오너 답으로 App 9.0.27
열차가 더했다: 한 끝이 LAN 후보를 하나도 보내지 않은 채 ICE 수집을 끝내면 상대가 그 쌍을 증명할 수 없으므로 그 경로를
증명 창까지 기다리지 않고 그때 끝낸다([열차 보고서](app-9-0-27-train-2026-10-30.md)의 '5. 오너 답과 no-lan-candidate').
