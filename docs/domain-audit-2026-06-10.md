# 22차 도메인 오디트 — 2026-06-10 (멀티에이전트 전도메인 스윕)

> **방법론**: 사용자 지정 15개 관점(방 암호·역할 간 오해·UI 렌더·채팅/스케일·원격/로컬 혼재·YT/파일 혼재·비효율 경로·언어/테마/스펙트럼·효과 충돌·카피 불일치·QR/초대코드·기기 수·연결탭 비밀번호·데모 복구·보안)을 7개 도메인으로 묶어 **Fable 5 에이전트 7기 병렬 투입**. 각 에이전트가 담당 도메인 소스를 전수 정독 후 발견/통과를 보고. 이후 픽스 대상 20건(🟠+🟡)에 **건당 1명 적대적 검증자**를 재투입해 실재 확인(워크플로우 wf_efea3c77).
>
> **집계**: 🔴 0 / 🟠 1 / 🟡 19 / 🔵 17 — 총 37건 (+P4 관찰 다수). **보안 도메인은 신규 발견 0건 클린 패스.**
>
> 21차(시나리오 오디트, `scenario-audit-2026-06-10.md`)와 같은 날 진행. SA-01~13과 ID 체계 독립.

## 검증(페이즈 ①) + 픽스 결과 — 같은 날 완료

- **적대적 검증 20건**: confirmed 18 / partial 2 / refuted 0. partial 2건은 ① UI-1 — 증상 실재하나 rAF 분기가 정식 진입 경로에서 죽어 있어 `state:playback.mode` 리스너(진입 zeroing + 파일 복귀 duration repaint)가 진짜 픽스 ② UI-2 — 해당 설정탭 기기 목록이 전 플랫폼 `display:none`(죽은 UI 속 잠복 결함, P4 강등, 소스만 교정).
- **검증자가 차단한 원안 함정 4건**: ROLE-1 스냅샷 재전송에 VOLUME 포함 금지(게스트 개인 볼륨 스톰프) / HET-1 대안픽스(원격경로 localSessionId 기록)는 복구 churn 루프 유발 — same-file 단락만 안전 / HET-3 게스트측 가드는 기존 핀 테스트와 모순(descriptor 단발성) — 호스트측만 / DEMO-1(b) SYNC_PONG 가드는 demo-스코프 필수(글로벌이면 원격 첫 로드 부트스트랩 회귀).
- **수정 30건 / 기록만 5건**(CONN-2·ROLE-4·SEC-1·SEC-2·UI-10 — 자가치유/이론상/카피후속). 페이즈 ④(대규모 리팩터링) 해당 없음.
- **검증**: 1061 tests(+10 신규 핀: HET-1 ×2, CHAT-1 ×3, CONN-1 ×2, DEMO-1/4 ×3) / typecheck / lint / bus-pairing 149:149(신규 `effects:resync-peer` 포함) 전부 그린. 1051개 기존 테스트 무손상.

## 픽스 그룹 계획

| 그룹 | 대상 | 성격 |
|---|---|---|
| **A. UI/i18n/시각화** | UI-1~10 | 대부분 1~5줄 픽스, 저위험 |
| **B. 역할/연결/채팅 정합성** | CONN-1, ROLE-1~4, CHAT-1~2 | 프로토콜·UI 동기화 |
| **C. 혼재 세션 (R2 cancel-parity)** | HET-1~6, CATCH-2 | 원격 게스트 모듈로컬 상태 가시화 |
| **D. 데모 복구 경로** | DEMO-1~4, CATCH-3, PERF-2 | 스냅샷 불변식 + 큐잉 |
| **E. 시스템/성능** | CATCH-1, PERF-1 | SW 정책 + 구독자 스톰 |
| **기록만 (최종 확정)** | CONN-2, ROLE-4, SEC-1~2 | 자가치유/이론상 — ROLE-5(ratchet)·ROLE-6(배선)·HET-5는 검토 후 수정으로 승격, UI-10은 후속 62f21211(16로케일 폴리시)에서 해소 |

---

## 1. 연결/인증 (CONN) — 방 암호·QR·초대코드·기기 수

### CONN-1 🟡 — max-guests 축소가 "인원 수"가 아니라 "슬롯 인덱스"로 강퇴
- **시나리오**: max=4, 게스트 4명(슬롯 1~4) → 슬롯 2 게스트 퇴장(희소 슬롯: 1,3,4) → 호스트가 4→3으로 축소. UI 가드(`connect.ts:136-142`)는 `새값 < peers.length`만 검사라 통과 → enforcement(`host.ts:511-528`)는 슬롯 배열을 길이로 자르며 **슬롯 4 게스트를 강퇴** (3명 ≤ 3인데도).
- **원인**: 가드는 count 기반, 집행은 slot-index 기반 — 두 기준 불일치.
- **픽스 방향**: 축소 전 점유 슬롯을 최저 인덱스로 압축(remap) 후 자르기 (불변식: "점유 슬롯은 항상 1..count").
- 상태: ✅ 수정 완료

### CONN-2 🔵 — 암호 해제 직전에 진입한 게스트에게 혼란스러운 추가 암호 프롬프트 1회
- pending 인증 중 호스트가 암호 해제 → 게스트의 auth가 INVALID/REQUIRED로 실패, 8자리 프롬프트 재표시. **다음 제출 시 새 소켓으로 무암호 입장되므로 자가치유.** UX 흠집뿐, 보안 영향 없음.
- 상태: 기록만 (자가치유)

### CHECKED & SOLID (연결/인증)
- max-device 입장 race 없음 (host 핸들러 동기 구간에서 카운트+추가, 이벤트루프 직렬화). 슬롯 수학 off-by-one 없음(0번 호스트 예약, 1..max).
- 동일 peerId 재접속은 sticky slot 재사용, 한도에서 신규만 SESSION_FULL. 거절 동시조인 슬롯 누수는 기수정 확인.
- **암호는 서버(DO worker) 집행** — 클라 신뢰 없음. 8자리 포맷이 전 레이어 일관(`/^\d{8}$/`). 시그널링 블립에도 최신값 재전송(latest-write-wins). 게스트의 암호 토글 3중 차단.
- QR/초대링크/클립보드에 암호 미포함 (6자리 코드만). 만료 코드는 HOST_NOT_AVAILABLE, 60초 release grace 후 메타 소거, 호스트 리로드 시 새 코드(hostSecret 휘발). QR 생성 race는 generation 카운터로 방어.
- worker pending-guest 슬롯은 alarm sweep으로 회수. rename은 서버측 전체 검증(트림/20자/예약어/욕설/중복).
- 참고: worker 자체에는 기기 수 상한 없음(호스트측 집행 + IP당 120/min WS rate limit로 수용) / 암호 비교 non-constant-time + 평문 저장은 위협모델상 무시 가능.

---

## 2. 역할/오디오 효과 (ROLE) — host·op·게스트 상호 오해

### ROLE-1 🟡 — 낙관적 로컬 적용 + 무응답 거절 = 강등된 OP의 이펙트 영구 desync
- **시나리오**: ⓐ OP가 리버브 슬라이더 드래그 중(preview는 실제 오디오 상태에 적용) 호스트가 권한 회수 → 릴리즈 시 `_isGuestLocked`로 차단되어 전송도 롤백도 없음. ⓑ OP가 VBass 클릭 → 로컬 적용 후 REQUEST_SETTING 전송(`effects.ts:343-395→309-323`) → 호스트는 이미 revoke 처리 → `verifyOperator` 실패로 **무응답 드랍**(`playlist.ts:1043-1053`, NACK 없음) → 게스트만 ON.
- **원인**: 요청/응답에 NACK 부재 + revoke가 설정 재베이스라인을 트리거하지 않음. repeat/shuffle도 같은 패밀리.
- **픽스 방향**: 호스트가 OPERATOR_REVOKE 시(또는 거절 시) 기존 설정 부트스트랩 블록(`effects.ts:427-477`, 완전한 스냅샷 직렬화기)을 해당 conn에 재전송.
- 상태: ✅ 수정 완료

### ROLE-2 🟡 — OP의 REQUEST_SETTING 적용 시 호스트 자신의 설정 UI가 stale + surround 죽은 클릭
- **시나리오**: OP가 Surround ON → 호스트 적용+브로드캐스트 → 게스트들은 `ui:sync-surround`로 동기화되는데 **호스트 본인 UI는 아무것도 안 함**(`handleRequestSetting`은 setter만 호출, `playlist.ts:1085-1147`). 호스트가 칩 OFF 상태로 Surround 클릭 → `setSurroundOn`이 멱등 early-return(`settings.ts:476-478`)을 **칩 갱신 전에** 타서 완전 무반응. 리버브 5종/VBass/Exciter 슬라이더·칩 동일 staleness.
- **증거**: eq·REVERB_TYPE 경로는 setter가 emit해서 정상 — 누락이 의도 아님.
- **픽스 방향**: `handleRequestSetting`에서 게스트 핸들러와 동일한 `ui:sync-*` emit (또는 emit을 setter로 이동) + 칩 갱신을 early-return 앞으로.
- 상태: ✅ 수정 완료

### ROLE-3 🔵 — 게스트 입장마다 "호스트가 설정을 변경했어요" 허위 토스트 1회
- 부트스트랩 ~13프레임 중 VOLUME만 `_bootstrap: true`로 토스트 억제, 나머지 12개가 `_notifyHostChanged()` 디바운스 토스트 발화. 픽스: 전 부트스트랩 전송에 `_bootstrap` 플래그 + 게이트.
- 상태: ✅ 수정 완료

### ROLE-4 🔵 — OP의 변경이 모두에게 "호스트가 변경"으로 표기 + 본인에게 셀프 토스트
- 브로드캐스트 에코가 암묵 ACK 역할(제거 금지). origin 라벨/`_echo` 플래그로 발신자 토스트 억제·문구 보정.
- 상태: 기록만 (게스트 자기-ID 식별 경로 미검증 — requesterId 설계가 선행돼야 함, 🔵 토스트 문구 nit)

### ROLE-5 🔵 — `network.isOperator` 리셋이 leaveSession에만 존재 (현재는 전 경로 풀리로드라 도달 불가)
- 미래에 in-place 재접속이 생기면 stale OP UI가 영구화. ratchet: `handleWelcome`에서 false 리셋(호스트가 GRANT로 재부여하므로 안전) 또는 DEVICE_LIST_UPDATE의 자기 entry `isOp` 동기화.
- 상태: ✅ handleWelcome 리셋 ratchet 적용

### ROLE-6 🔵 — `SYNC_PONG.trackIndex` dead field
- 생성(`sync.ts:223`)만 있고 reader 없음. **DEMO-1 픽스(b)가 이 필드를 사용하므로 그쪽에서 자연 해소.**
- 상태: ✅ DEMO-1(b)에서 배선됨 (handleSyncPong demo-스코프 trackIndex 비교)

### CHECKED & SOLID (역할/효과)
- 역할 게이팅 양면 완비: 호스트측 전 REQUEST_* 핸들러 `verifyOperator`/demo subset 검증, 클라측 pre-gate 일치. 14개 이펙트 브로드캐스트 핸들러 전부 `isHostBroadcast` 가드 — 게스트의 호스트 오디오 오염/위장 불가.
- 호스트+OP 동시 변경은 절대값 wire + 호스트 단일 직렬화 + 에코로 수렴, ping-pong 루프 없음.
- validator 범위 = UI 범위 정확 일치(정당한 슬라이더 값이 드랍될 일 없음). audio:ready 이전 설정은 setState 경유라 안전(전체 재적용).
- control/bulk 채널 모두 ordered+reliable, 역할·설정 메시지는 control 고정 → GRANT/REVOKE와 후속 설정의 FIFO 보장.
- GRANT/REVOKE는 채널 open+send 성공 확인 후 상태 변경. rate limit는 정당한 커밋 버스트(데모 토글 7프레임)에 여유.
- P4 관찰: PREAMP REQUEST_SETTING 허용은 dead allowance(클라 발신 없음) / 데모 버튼 낙관 플립은 자가치유 / OP repeat·shuffle 이중 토스트.

---

## 3. UI/i18n/테마/시각화 (UI)

### UI-1 🟡 — 시스템오디오 진입 시 총 재생시간이 안 지워짐 (죽은 ID `time-total`)
- `seekbar.ts:115`의 zeroing 분기가 `getElementById('time-total')`을 쓰는데 실제 id는 `time-dur`(index.html). 다른 writer는 전부 `time-dur`. 공유 내내 `0:00 / 이전곡길이` 표시.
- **픽스**: `'time-total'`→`'time-dur'` 1줄 (+모드 진입 시 1회 zeroing 고려).
- 상태: ✅ 수정 완료

### UI-2 🟡 — 언어 전환이 설정 탭 기기 목록을 비움 (잘못된 상태 소스)
- `settings.ts:1007-1012`의 `i18n:changed` 핸들러가 `network.connectedPeers`(호스트 전용 raw, 게스트에선 빈 배열, 호스트 자신 row 없음)로 재렌더. 정본은 `network.lastKnownDeviceList`. connect.ts는 `_lastDeviceList` 캐시로 올바르게 처리 — settings.ts만 버그.
- **픽스**: `lastKnownDeviceList`로 소스 교체 1줄.
- 상태: ✅ 수정 완료

### UI-3 🟡 — SESSION_FULL이 호스트 로케일로 번역되어 전송 (교차 로케일 누출 + 청자 오류 카피)
- `host.ts`가 `message: t('network.session_full_detail')` 전송 → 게스트가 그대로 렌더. 한국어 호스트+영어 게스트 = 혼합 언어 다이얼로그. EN 카피는 거절당한 게스트에게 "Connect 탭에서 한도 설정" 안내(게스트에겐 그 컨트롤이 없음).
- **픽스**: wire에 `i18nKey` 실어 수신측 `t()` (기존 패턴 재사용) + EN 카피 "호스트에게 요청" 프레이밍으로 수정.
- 상태: ✅ 수정 완료

### UI-4 🟡 — 시각화 rAF 루프에 paused/idle 종료 없음 — 3개 진입점이 영구 공회전 (배터리)
- 드로 루프는 YT 모드/토큰/에러로만 종료. 우회 진입점: ① resize(정지 프레임도 파괴 — `_isHoldingPauseFrame` 클리어) ② `ui:visualizer-check`(idle은 `isPlaybackPaused()` false라 시작 분기) ③ `visualizer:set-type`(무조건 start). 활동 게이트는 `scopePlaybackModeActivity` 구독자에만 존재.
- **픽스**: `startVisualizer`를 activity==='playing'으로 게이트 + resize-while-held는 보존 프레임 재드로.
- 상태: ✅ 수정 완료

### UI-5 🟡 — 단수형 기기 수 타이틀이 영어 전용 분기 — 7개 로케일의 단수형이 dead
- `connect.ts:362-367` `count===1 && lang==='en'`일 때만 `device_list_one`. fr/de/es/it/pl/pt-br/ru의 문법적 단수형이 사용 불가(프랑스어 UI에서 `1 appareils connectés`).
- **픽스**: `'en'` 체크 삭제 — count===1이면 무조건 단수 키 (전 로케일 키 존재 스크립트 검증됨).
- 상태: ✅ 수정 완료

### UI-6 🔵 — 뮤트 placeholder가 언어 전환 시 일반 placeholder로 덮임
- `data-i18n-data-placeholder`가 일반 키로 남아있어 재번역 시 덮어씀. 픽스: 뮤트 시 속성도 스왑(player-controls.ts:1026-1033의 기존 패턴) 또는 `i18n:changed`에서 뮤트 상태 재적용.
- 상태: ✅ 수정 완료

### UI-7 🔵 — YouTube URL 입력·다이얼로그 입력에 "type-then-delete 후 placeholder 실종" 동일 버그
- 채팅에서 8d00a174로 고친 contentEditable `<br>` 잔재 버그의 형제. `player-controls.ts:811-834`, `dialog.ts:243-270`에 정규화 부재. 픽스: 채팅 정규화를 공용 헬퍼로 추출해 양쪽 적용.
- 상태: ✅ 수정 완료

### UI-8 🔵 — `system_audio.stopped` 토스트가 "재생목록 재개"를 약속하지만 재개 안 되는 경로에서도 발화
- `system-capture.ts:338` 무조건 emit: force-stop 전환 경로(복원 금지가 21차 확정 의미론), 스냅샷 없음 경로, 그리고 happy path도 **paused 복원**. 픽스: 토스트를 명시적 stop+복원 분기로 이동 또는 카피 완화.
- 상태: ✅ 수정 완료

### UI-9 🔵 — idle/paused 중 테마 전환 시 시각화 캔버스 미갱신
- `data-theme` MutationObserver가 `refreshThemeCache()`만 호출, 재드로 없음 — 스펙트럼 그리드(화이트/블랙 0.06α)가 뒤집힌 배경에 어긋남. 픽스: observer에서 idle이면 resting frame 재드로.
- 상태: ✅ 수정 완료

### UI-10 🔵 — "Windows/Mac Chrome 전용" 카피 vs 실제 게이트(모든 데스크톱 Chromium)
- Edge/Opera/Brave/Linux Chrome도 기능 동작하는데 카피가 불가 안내. 보수적 방향(기능>광고)이라 cosmetic. 픽스: "Chrome 계열 데스크톱 브라우저"로 카피 수정.
- 상태: ✅ 후속 커밋 62f21211에서 16로케일 일괄 수정 (UI-3 잔여 로케일 + 전 파일 번역 폴리시 동반)

### CHECKED & SOLID (UI/i18n/테마)
- **로케일 구조 무결성 스크립트 검증**: 16개 로케일 × 537키 완전 일치(누락/잉여 0), `{{placeholder}}` 세트 불일치 0, index.html의 185개 `data-i18n*` 키 전부 해석됨. t() 폴백 체인 + wire 메시지 raw-key 폴백 방어적.
- 카피 수치 주장 전수 일치: 200MB·2시간 SFU·닉 20자·32슬롯·3초·8자리 암호·6자리 코드·대형 방 임계값.
- YT 모드 설정 잠금 = 카피 정확(`#youtube-settings-disabled-wrap` 범위와 help 텍스트 일치). 시스템오디오 호스트 채널 잠금도 일치.
- 언어 전환 재렌더 커버리지(UI-2/6 외): connect 기기목록·데모 카피·재생목록·트랙타이틀·미디어버튼·QR placeholder 전부 정상 패턴.
- 테마: bootstrap.js 프리플라이트로 FOUC 없음, theme-color/color-scheme 메타 동기화(데모 변형 포함), QR 테마 인식.
- 오버레이/z-order(LIFO 모달 스택·inert 포커스 트랩), 토스트/로더(ref-count·grapheme 절단), 시크바 anti-jitter 가드 전부 건전.
- 의도적 비수정: 역할 배지 영문 라벨(컨벤션), ko `enter_link_desc_html`의 "재생목록" 누락(한 단어 카피 보강 후보일 뿐).

---

## 4. 채팅/스케일 (CHAT)

### CHAT-1 🟡 — 필터 OFF(기본값) 시 호스트가 **절단 전 원문**을 전체 릴레이 (wire 증폭)
- `chat/protocol.ts:199-206` 절단을 로컬 변수에만 적용, `data.text` write-back이 `filterEnabled` 분기 안에만 존재 → `:243` broadcast-except가 원본 크기 그대로 N-1 게스트에 fan-out. validator(`network/protocol.ts:231`)에 길이 캡 없음. 렌더러 재절단으로 시각 캡은 유지 — 문제는 호스트 업스트림 증폭. whisper 핸들러는 write-back 하는 비대칭.
- **픽스**: `data.text = text`를 필터 분기 밖으로 (1줄) + validator 길이 캡(OPERATOR_TOAST의 300캡 미러).
- 상태: ✅ 수정 완료

### CHAT-2 🔵 — zero-width/RTL/제어문자로 표시명 위장 가능 (XSS 아님)
- `HOST​` 류가 예약어/중복 검사(raw lowercase 동등성) 통과. crown 배지는 서버 파생이라 위장 불가, 렌더는 createTextNode — 순수 시각 사칭. **픽스**: `handleRequestRename`에서 제어/zero-width/bidi 문자 strip (+NFKC 고려).
- 상태: ✅ 수정 완료

### CHECKED & SOLID (채팅)
- **XSS 전 sink 클린**: parseMessageContent 전 분기 escape(텍스트 escapeHtml, 속성 escapeAttr), 발신자/시스템/귓속말/공지 전부 textContent 계열. i18n 파라미터 주입 불가(naive replaceAll, no HTML).
- 배지 스푸핑 차단(호스트가 정본에서 identity 필드 덮어씀 — CHAT·WHISPER 동일). 관리 명령 권한(게스트측 isFromHost, 호스트측 hostConn-null 거부, OP는 REQUEST_CHAT_COMMAND 서버 검증).
- 2중 토큰버킷(일반 60/20s + 채팅 10/1s, disconnect 시 정리), DOM 200노드 캡, dedup 50캡, dedup 키는 인증된 conn.peer 파생(포이즈닝 불가).
- 욕설 필터 ReDoS 없음(모듈 로드 시 1회 빌드, ≤500자 입력). 슬래시 명령 엣지 양성. 개행 유입 불가(paste strip + beforeinput 차단).

---

## 5. 혼재 세션 (HET) — 원격×로컬 게스트, YT×파일 모드

> **교차 패턴**: HET 6건 중 4건이 같은 모양 — *R2/원격 서브시스템이 모듈 로컬 상태(`_activeDownload`, `_activeUploads`, descriptor 캐시, 미기록 `transfer.localSessionId`)로 수명주기를 관리해서, `transfer.state`/lifecycle 중심으로 지어진 모드 전환·복구 기계가 못 본다.* → 사각 ⑧(cancel 매트릭스)·⑨(모드 형제 패리티)에 "remote-share 모듈 상태" 열 추가 필요.

### HET-1 🟡 — 원격→로컬 승급 시 이미 로드된 트랙의 오디오를 죽이고 전체 재전송
- 초기 ICE 오분류된 LAN 게스트가 R2로 현재 곡 재생 중 → 30초 fallback recheck가 local 승급 → 호스트가 현재 파일 unicast → 게스트 `handleFileStart`가 `incomingSid > localSessionId(=0, 원격 경로는 이 필드를 안 씀)` → 허위 new-session → **same-file 체크 전에 파괴적 clear** → 재생 중 음악 컷 + 이미 가진 파일 전체 재다운로드. 승급 가드 `shouldAcceptLocalDirectFileStart`는 mid-download(AWAITING_PRELOAD)만 커버.
- **픽스**: handleFileStart에서 isNewSession clear 전에 현재 blob+meta vs 헤더 비교 short-circuit(`replayLoadedSameFile` 미러) 또는 원격 경로가 descriptor sessionId를 localSessionId에 기록.
- 상태: ✅ 수정 완료

### HET-2 🟡 — OS 미디어키 STOP(YT 중)이 YOUTUBE_STOP을 영영 브로드캐스트 안 함 → 방 전체 hard desync
- `stopPlayback` YT 분기(`transport.ts:808-819`)가 ENDED race 억제를 위해 `setPlaybackIdle()`을 **먼저** 호출 → `stopYouTubeMode`의 `wasInYouTube`가 false → 브로드캐스트 스킵. 게스트 전원 YT 모드 고착: 이후 파일 트랙 전부 무시(FILE_PREPARE YT-owner 가드) + REQUEST_CURRENT_FILE 스팸 + 호스트 재unicast 낭비. 형제(handleEndOfPlaylist/stopAllMedia)는 idle 전에 캡처해서 정상 — 이 1개만 발산 (사각 ⑨).
- **픽스**: stopPlayback에서 idle 전에 `wasInYouTube` 캡처 후 전달/명시 브로드캐스트.
- 상태: ✅ 수정 완료

### HET-3 🟡 — 파일→YT(/시스템오디오) 전환이 업로드 중 R2 descriptor를 **stale 상태로 브로드캐스트**
- playTrack YT 분기가 `files.currentFileBlob`을 안 지우고 업로드도 취소 안 함(`cancelInFlightUpload`은 **호출자 0의 dead code**) → 업로드 완료 시 `isHostActiveFile` blob-identity 분기 통과 → 방은 YT 재생 중인데 트랙 A descriptor 브로드캐스트. 원격 게스트의 `handleRemoteFileShare`엔 external-owner 가드 없음(handleFilePrepare와 대조) → currentTrackIndex 스톰프 + YT 재생 중 타이틀 UI 플립 + 모바일 데이터로 전체 다운로드 후 activation에서 폐기.
- **픽스**: 호스트 — `isHostActiveFile`에 `!isExternalOwner()` 게이트(또는 모드 전환 시 업로드 취소: dead code 배선). 게스트 — handleRemoteFileShare 상단 external-owner 가드.
- 상태: ✅ 수정 완료

### HET-4 🟡 — 진행 중 R2 다운로드가 모드 전환 시 취소 안 됨 (LTE 낭비 + 새 모드 위 로더 잔류)
- YOUTUBE_PLAY의 `cancelInFlightTransfer`와 SYSTEM_AUDIO_START의 `cancelIncomingFileTransfer`(SA-08) 모두 `transfer.state` RECEIVING 키드 — 원격 경로는 그 상태를 안 씀. `cancelRemoteShareWait` 호출자 3곳에 모드 전환 없음. `_activeDownload` 계속 스트리밍 + 로더 repaint + 5분15초 타이머 잔존. **사각 ⑧의 R2 변종.**
- **픽스**: `cancelActiveRemoteDownload(reason)` 래퍼 export → 양쪽 cancel 블록에서 호출.
- 상태: ✅ 수정 완료

### HET-5 🔵 — `handlePlayPreloaded`에 원격 게스트 분기 부재 — FSM safety-promotion이 우회로로 지탱
- PLAY_PRELOADED엔 isRemoteGuest 분기가 없는 유일한 "트랙 변경" 메시지. R2 구성 환경에선 descriptor가 자가치유(현 배포 = musixquare.com은 R2 있음 → 🔵). R2 미구성 배포에선 로더 영구 고착(REQUEST_DATA_RECOVERY를 호스트가 무응답 드랍 — `unicastFile` transport 가드가 FILE_WAIT 없이 return).
- **픽스**: handlePlayPreloaded fallback 상단에 handlePlayMsg 미러 분기 + unicastFile 원격 스킵 시 FILE_WAIT 응답.
- 상태: ✅ 수정 완료

### HET-6 🟡 — 원격 게스트 실패 경로가 전부 terminal (재시도·호스트 신호 0)
- ⓐ 디코드 실패: guest가 REQUEST_CURRENT_FILE 전송(원격 분기 없음) → 호스트 unicastFile이 원격 타깃을 **무응답 스킵**(blob을 찾았으니 FILE_WAIT도 없음) → FAILED 고착, 트랙 끝까지 무음. ⓑ 다운로드 실패: toast+status만, 재시도/lifecycle 전이 없음 → 5분 타임아웃까지 대기. 로컬 파이프라인의 3-retry backoff와 비대칭.
- **픽스**: 호스트 — requester가 remote/unknown이면 `shareRemoteFileIfNeeded`(descriptor 재전송/재업로드)로 라우팅. 게스트 — non-abort 실패 1회 bounded retry.
- 상태: ✅ 수정 완료

### CHECKED & SOLID (혼재 세션)
- 헤드라인 race "원격 게스트 준비 전 PLAY" 완전 처리(lifecycle defer + pendingPlayTime 나이 보정 + SYNC_PONG 부트스트랩).
- 혼합 청중 트랙 변경 정상(로컬 chunk + 원격 descriptor, 순서 역전 멱등 흡수, 빠른 A→B 플립 objectId-비교 abort). 원격 게스트 조인 mid-transfer, 승급 mid-download(테스트 존재), preloadedIndexes 혼합 부기, PRELOAD_ABORT 타깃팅 전부 건전.
- YT↔파일 빠른 교차: FIFO로 YOUTUBE_STOP이 FILE_PREPARE 선행 보장, YT→파일 경계 preload 정상 작동, 셔플/반복이 YT에 착지 시 캐시 클리어(SA-01 계약 보존).
- P4 관찰 3건: 전환 후 구 파일 broadcast 루프 잔류(대역폭만), 유일 원격 피어 disconnect 시 업로드 완주(무해), cancelInFlightUpload dead code(HET-3에서 배선).

---

## 6. 보안 (SEC) — 클린 패스

**신규 🔴/🟠/🟡 0건.** 6개 위협 표면 전수 추적: XSS 전 sink escape/textContent 확인, 권한은 정본 재파생(verifyOperator + isHostBroadcast 40+ 핸들러), 크립토(파일당 AES-256-GCM 새 키+새 IV, 키는 WebRTC로만, R2엔 암호문만), DoS(토큰버킷 2중 + chunk는 isHostBroadcast 1차 가드라 증폭 불가 + 수치 validator NaN/Infinity 거부), 시그널링(hostSecret 24바이트 CSPRNG 서버 검증), 정찰(__health 부활 없음). **선행 audit fix 전부 intact** (role-badge XSS·lastJoinCode·title 이중디코드·DATA_RELAY 제거).

### SEC-1 🔵 — chat YT 버튼 DOM id에 Math.random (비보안 용도, 이론상 충돌 시 oEmbed 타이틀이 다른 메시지에 기입)
- textContent 기입이라 XSS 아님. 기록만.
### SEC-2 🔵 — peer id 부재 시 rate-limit fail-open (`allowInboundFromPeer`/`allowChatFromPeer`)
- 현 transport에서 conn.peer 항상 존재 → 도달 불가. 미래 transport 대비 방어 노트. 기록만.

---

## 7. 데모 복구 + 캐치올 + 성능 (DEMO/CATCH/PERF)

> **헤드라인 답변**: 데모의 **시간축 desync는 복구 경로 완비**(1초 SYNC_PING→PONG drift>2s 보정, no-buffer 부트스트랩, background resume force-resync). **트랙 정체성 desync는 복구 경로 없음** — DEMO-1/3/4가 그 구멍.

### DEMO-4 🟠 — 데모 중 입장한 게스트가 데모 종료 후 영구 무음 (이번 오디트 유일 ORANGE)
- ① 1회성 orchestrator 파일 부트스트랩이 데모 게이트(`playback.ts:962`)에 먹혀 소실 ② 종료 후 첫 PLAY는 index-mismatch 분기가 "부트스트랩이 올 것"으로 가정하고 return ③ 다음 PLAY의 SA-03 복구 요청은 **호스트 `transfer.meta`가 아직 데모 트랙 메타**(스냅샷이 meta를 저장/복원 안 함 — `loadDemoFile`이 덮어씀)라 `findMatchingBlob` 양쪽 실패 → **FILE_WAIT 무한**. 트랙 변경까지 무음. `(currentFileBlob, transfer.meta)` 원자 페어 불변식(decode.ts:205-211 주석) 위반이 근본.
- **픽스**: 데모 스냅샷에 transfer.meta 포함(페어 불변식 복원 — 이것만으로 2번째 PLAY에서 SA-03 경유 복구) + 이상적으로는 데모 종료 시 파일 없는 isDataTarget 피어에 bootstrapLocalPeerFile 재실행.
- 상태: ✅ 수정 완료

### DEMO-1 🟡 — 로딩 중 게스트가 호스트의 트랙 전진을 silent drop → 엉뚱한 트랙을 호스트 타임라인에 동기화
- `enterDemoMode` 첫 줄 `demo.loading` early-return이 DEMO_ENTER(n+1)을 버림 → pending도 index 불일치로 no-op → 재트리거 없음 → 1초 내 SYNC_PONG 부트스트랩이 **트랙 n 오디오를 n+1 위치로 재생**. PONG payload의 trackIndex(ROLE-6의 dead field)를 수신측이 비교 안 함.
- **픽스**: ⓐ loading 중 요청 인덱스 큐잉 → load finally 후 re-dispatch ⓑ 방어: handleSyncPong에서 trackIndex 유한+불일치 시 부트스트랩 스킵.
- 상태: ✅ 수정 완료

### DEMO-3 🟡 — 데모 트랙 전진 fetch 실패 시 in-demo 재시도 없음 → 플레이 버튼이 방을 쪼갬
- index 전진+브로드캐스트가 load **앞**이라 실패 시 호스트만 버퍼 null. 플레이 탭 → DEMO_PLAY 먼저 브로드캐스트 → 게스트들 재생, 호스트 무음("재생목록 비어있음" 무관 토스트). 재탭은 same-index 가드로 refetch 안 됨. exit+재진입만 복구.
- **픽스**: toggleDemoPlay/startDemoPlayback에서 `demo.active && !buffer`면 `loadDemoTrack(_demoTrackIndex, autoplay)` 또는 catch에서 retry.
- 상태: ✅ 수정 완료

### DEMO-2 🔵 — 빠른 exit→재진입(~340ms) 시 구 restore가 새 데모 중간에 발화 → 원래 설정 영구 소실 가능
- active fast path가 구 커튼 애니메이션을 안 멈춰서 구 `afterCovered`(restoreSnapshot)가 새 데모 위에서 실행, 새 스냅샷엔 데모 설정이 캡처됨. SA-11(entry측, 의도적 미수정)의 exit측 형제 — 별개 항목.
- **픽스**: active fast path에서 `stopDemoCurtainAnimation()` + pending afterCovered 동기 실행 후 신규 캡처.
- 상태: ✅ 수정 완료

### CATCH-1 🟡 — SW controllerchange가 **다른 탭의 라이브 세션을 무프롬프트 hard-reload**
- 탭 B에서 업데이트 수락 → SKIP_WAITING → 전 controlled 클라이언트 controllerchange → 탭 A(호스트 세션 중) 즉사(`markIntentionalNav`가 beforeunload 프롬프트까지 억제). 30초 쿨다운 분기는 두 번째 배포를 **무다이얼로그** SKIP_WAITING. co-located 멀티탭 테스트가 흔한 제품 특성상 실사용 타격.
- **픽스**: controllerchange에서 `network.appRole !== 'idle'`이면 자동 리로드 대신 "업데이트 준비됨" 토스트로 연기, idle 탭만 자동 리로드.
- 상태: ✅ 수정 완료

### CATCH-2 🟡 — 원격 트랙 전환마다 object URL 1개 누수 (복호화 blob 전체 핀)
- 완료 시 `download.blobUrl` 저장 → 다음 descriptor의 fetch-start가 **revoke 없이 null 덮어씀** → 이후 revoke는 null 읽음. 원격 게스트 모바일에서 트랙당 5-50MB 누적. **`blobUrl` 소비자 grep 0** — createObjectURL 호출 자체 삭제가 최선.
- 상태: ✅ 수정 완료

### CATCH-3 🔵 — 데모 exit 폴백 타이머가 커튼 애니메이션 미취소 → afterCovered(스냅샷 복원) 2회 실행 가능
- hidden 중 exit(잠금화면 host-drop) 시 920ms 폴백이 #1 실행, visibility 복귀 시 onfinish가 #2. 현재 거의 멱등이라 UI blip뿐. **픽스**: 폴백 타이머 본문에 `stopDemoCurtainAnimation()` 1줄.
- 상태: ✅ 수정 완료

### PERF-1 🟡 — 게스트 SYNC_PING(초당 1×N)마다 connectedPeers setState → **숨겨진 데모 QR을 초당 N회 재생성**
- liveness 업데이트가 매 핑 전체 배열 재생성 setState → 유일 구독자가 `syncDemoSessionCopy`(demo.active 게이트 없음, same-code dedup 없음) → QRCode.toString SVG + innerHTML을 데모 안 연 호스트에서 세션 내내. 배터리 + 미래 구독자 지뢰.
- **픽스**: ① lastHeartbeat를 모듈 Map으로(상태 제거 — 유일 reader가 heartbeat 모니터) ② syncDemoSessionCopy에 `!demo.active` early-return ③ QR same-code 캐시. ①+②권장.
- 상태: ✅ 수정 완료

### PERF-2 🔵 — 데모 이펙트 토글 1회가 3중 전송 + 게스트당 enterDemoMode 재실행 + synthetic resize 5회 폭풍
- 오디오 SETTING(베이스=7메시지) + 정보상 잉여인 DEMO_ENTER 재브로드캐스트(게스트는 설정에서 플래그 자가 파생) → 게스트마다 setDemoDomActive 풀 경로(~5 resize). 4토글 = 게스트당 ~20 relayout.
- **픽스**: DEMO_ENTER는 부트스트랩/트랙변경 전용으로, 플래그 변경은 무전송(자가 파생) 또는 경량 메시지. same-index active 시 setDemoDomActive 스킵.
- 상태: ✅ 수정 완료

### (무ID 메모) guest enterDemoMode active 분기 try/finally에 catch 부재
- 실패 시 unhandledrejection 노이즈(자가치유는 됨). DEMO-1 작업 시 catch 1개 추가.

### CHECKED & SOLID (데모/캐치올)
- 데모 시간축 동기 복구 전 경로 검증 작동(상단 헤드라인). 데모 중 게스트 조인 부트스트랩 정상 + 일반 재생 부트스트랩의 데모 게이트 적절(충돌 PLAY 없음 — 구멍은 post-exit인 DEMO-4뿐).
- 선행 데모 fix 전부 보존(11차 H-3, 12차 re-check, SA-13, 13차 QR 토큰, load-token). 타이머/페이지 수명주기/AudioContext statechange/blob-manager/버스 페어링 148 전부 건전.
- 스토리지는 RAM-only 확인(navigator.storage 쓰기 0 — OPFS 표면 소멸), ramstore 무결성 게이트·backpressure 정상. 데모 메모리 피크 ~200MB(iOS 예산 내, 스냅샷이 pre-demo 버퍼 핀하는 건 인지 사항).

---

## 외부 리뷰 후속 (같은 날, 커밋 78a60487)

사용자가 가져온 외부 AI 리뷰 2건 검증 — 13차 패턴 재현(외부 정독이 멀티에이전트 스윕의 잔여를 잡음):

### EXT-1 🟡(P2) — preload index-mismatch 클리어를 캡처된 로컬이 우회 (선재 버그, 22차와 무관)
- `handleFilePrepare`가 mismatch 시 preload **상태**는 클리어하지만 매치 판정 로컬(`nextFileBlob`/`hasPreloadedByName`)은 클리어 **전에** 캡처됨 → 동명·타 index 트랙(중복 파일명, 같은 곡 2회 추가 포함)이 name-match로 preload-match 분기 진입. 리뷰 주장과 달리 stale blob 디코드는 아니고(консумер가 상태에서 null을 읽음) **유령 preload 대기 + 진짜 전송 드랍**(skip 게이트)으로 워치독 복구까지 정체.
- 픽스: 분기에 `!isMismatch` 게이트 1줄 (index-match와 mismatch는 상호배타 — name-match 진입만 차단, index 부재 폴백 보존·핀).
- 상태: ✅ 수정 완료

### EXT-2 🔵(P4) — CONN-1 relocation의 `ConnectedPeer.slot` 미동기화 (위생)
- 지적 3건 중 1건만 유효: slot 필드 stale은 사실(프로덕션 reader 0이라 기능 영향 없음, 위생 픽스 적용). 라벨/joinOrder 유지와 re-broadcast 부재는 **의도적 수용** — 라벨=입장 시점 정체성(rename 의미론), joinOrder=입장 순서, device list는 slot을 노출하지 않아 relocation으로 바뀌는 가시 데이터가 0.
- 상태: ✅ slot 동기화 적용 + 테스트 assert 확장

### 신규 사각 후보 ⑭ — 캡처된 로컬 vs 상태 클리어
같은 스코프에서 "상태를 읽어 로컬에 캡처 → 조건부 상태 클리어 → 캡처본으로 분기"가 있으면 클리어가 무력화된다. 상태 클리어 가드를 추가/리뷰할 때 **선행 캡처본이 클리어를 우회하는지** 확인 의무화. (22차가 놓친 이유: 검증자들은 변경 코드에, 도메인 에이전트는 모듈 간 플로우에 집중 — 한 함수 안 20줄 거리의 시간차 비일관성은 양쪽 렌즈 모두의 사각)

## 실기기 테스트 발견 (같은 날, 커밋 7adf11c6)

사용자 실기기 테스트가 잡은 2건 — 조사 에이전트 1:1 추적 후 수정:

### DV-1 🔴(P1) — 신규 전송 전체에서 호스트 재생 시작 시 게스트 다운로드 0% 리셋 (SA-03 유발 회귀)
- **메커니즘**: handleFilePrepare fresh 분기가 DOWNLOADING 전이 **한 버스홉 뒤에** `storage:clear-previous-track`를 emit → clearPreviousTrackState의 setPlaybackIdle이 방금 쓴 lifecycle을 IDLE로 클로버 → **모든 신규 게스트 다운로드에서 FSM이 조용히 해제된 채 진행** → PLAY의 DOWNLOADING defer 게이트 무발동 → 어제 넣은 SA-03 no-buffer 분기가 전송 중 REQUEST_CURRENT_FILE 발사 → 호스트 unicast-from-0 응답(같은 sid의 FILE_START)을 handleFileStart가 "복구 재전송 = 0부터"로 처리 → 부분 다운로드 폐기. SA-03 주석의 "FILE_START가 1 RTT 내 DOWNLOADING 전이" 가정은 HEAD에서 거짓이었음(handleFileStart는 transition을 안 함) — PLAY마다 반복 리셋.
- **픽스**: ① clearPreviousTrackState가 `isFilePipelineBusyForPlay()` 중에는 idle 금지(근본) ② SA-03에 transfer.state RECEIVING/PROCESSING 억제 벨트(웨지는 12초 chunkWatchdog의 resume 복구가 커버). +동반 최적화: FILE_PREPARE에 size 추가, name+size 일치 시 프리로드 blob을 재인덱싱해 재다운로드 생략(중복 파일명/prev 복귀).
- **후속 (517f4a60, 사용자 재질문이 잡은 형제 갭)**: 재사용 기계가 2곳(프리로드 슬롯 / 현재 로드 파일)인데 promote를 프리로드에만 배선했었음 — **재생 중인 바로 그 파일**의 중복 항목을 다른 index로 클릭해도 재다운로드. same-file 분기에 name+size 매칭 추가, index/meta 재포인팅 후 기존 replay-current 경로. (사각 ⑤: 픽스 자체도 형제 스윕 대상)
- 상태: ✅ (+핀 4+2)

### DV-2 🟠(P2) — 원격 게스트의 remote-wait가 수동적 막다른 길 (사각 ⑤ 재발)
- **메커니즘**: bare PLAY(데모 종료 후 재개 등)로 remote-wait에 진입하면 호스트에 **아무것도 안 보냄** — local 형제 분기는 REQUEST_CURRENT_FILE을 보내는데 remote는 passive. 정당화였던 "호스트가 원격 요청을 드랍"은 HET-6 라우팅으로 obsolete됐는데 형제 분기 미갱신. 재개 경로엔 descriptor 재공유가 없고, 5분 타이머도 토스트만(lifecycle 영구 AWAITING_PRELOAD → 이후 PLAY 전부 defer, SYNC 부트스트랩 스킵, 플레이 버튼 busy 차단).
- **픽스**: ① 양쪽 remote-wait 분기가 NEW wait일 때 REQUEST_CURRENT_FILE(reason: remote_share_wait) 발사 → 호스트의 기존 원격 라우팅이 캐시 descriptor 재전송(컨트롤 플레인만) ② REMOTE_WAIT_TIMER 타임아웃 시 AWAITING_PRELOAD→FAILED 전이로 게이트 해제.
- 상태: ✅ (+핀 3+1)

### 후속 관찰 (DV-1 조사 중 발견, 미수정)
FILE_END가 control 채널로 bulk 청크(~512KB)를 추월 → 조기 shortfall 복구 + backoff 콜백에 완료-확인 부재 → finalize된 슬롯에 무의미한 FILE_RESUME/INTEGRITY_FAIL 노이즈 가능(자가치유, wire 낭비만). 다음 라운드 후보.

### 사각 ⑭ 보강
DV-1은 ⑭("캡처된 로컬 vs 상태 클리어")의 형제 모양: **"전이 직후의 클린업이 방금 쓴 상태를 클로버"**. 전이 추가/리뷰 시 같은 플로우 안에서 뒤따르는 클린업(stop-all-media, clear-previous-track)이 그 전이를 덮지 않는지 확인.

## 외부 리뷰 2차 (2026-06-11)

### EXT-3 🟡(P2~P3) — reuse fast-path가 고아 chunkWatchdog을 남김 (사각 ⑤가 DV-1/517f4a60 픽스 자신에 재적중)
- **메커니즘**: handleFilePrepare의 new-session 리셋이 chunkWatchdog 장전 + receivedCount=0 → 직후 reuse fast-path(preload promote / same-content replay)로 빠지면 청크가 영영 안 오는데 해제 코드가 없음. replay는 decode를 안 타서 decode 완료 해제(decode.ts)도 안 옴 → 12초 뒤 발화 → `sendRecoveryRequest`의 로컬 게스트 경로는 lifecycle 게이트가 없어 `REQUEST_DATA_RECOVERY(nextChunk=0)` 발사 → **호스트가 파일 전체를 로컬 게스트 수만큼 unicast 재스트리밍**. FILE_START의 HET-1 단락이 받아서 버리므로 재생 끊김·0% 리셋은 없음 — 증상이 "조용한 풀파일 재전송 낭비"라 실기기에서 안 보였음.
- **범위 보정**: 원격 게스트 무관(장전 이전에 return). preload promote는 decode 완료가 12초 내면 자가치유 — 대용량 decode 엣지만 잔존. 중복 항목 reuse(같은 날 넣은 517f4a60 경로)는 100% 재현.
- **픽스**: 두 reuse return 직전에 `clearManagedTimer('chunkWatchdog')` + 방어적 `prepareWatchdog`. "청크가 올 일 없는 경로 = 청크 안전망 해제" 의미론. startChunkWatchdog 장전 자체를 뒤로 미루는 대안은 preload-waiting 분기의 백업 벨트 의미를 바꿔서 기각.
- 상태: ✅ (+핀 2: 장전→해제 호출 순서 assert, 1075 tests)
- **교훈**: 사각 ⑤ 3연속 — 517f4a60에서 "픽스 자신에게 sibling sweep"을 기록하고도, reuse fast-path 신설 시 **몇 줄 위에서 방금 장전한 안전망**은 안 봤다. fast-path/short-circuit return을 추가하면 그 함수가 진입 시점에 장전한 타이머/가드/카운터를 전수 확인할 것.

## 메타 — 이번 오디트가 추가한 사각 후보

1. **⑪ 모듈 로컬 상태 vs 전역 기계** (HET 패턴): 서브시스템이 자기 수명주기를 모듈 변수로 관리하면 cancel/parity 스윕(⑧⑨)이 못 본다. 신규 서브시스템 추가 시 "이 모듈의 in-flight 작업을 외부 기계가 취소/관찰할 수 있는가" 체크 의무화.
2. **⑫ 송신측 번역 금지** (UI-3): wire에 번역된 문자열을 싣는 순간 교차 로케일 누출. i18nKey 패턴 강제 — `t(` 결과를 send/broadcast payload에 넣는 정적 가드 후보.
3. **⑬ 낙관적 적용의 거절 경로** (ROLE-1): request-grant 프로토콜에서 "거절되면 로컬 상태는 누가 되돌리나"를 설계 시점에 답해야 함. NACK 또는 재베이스라인.
4. **idle-vs-paused 구분 누락** (UI-4): `isPlaybackPaused()`가 idle을 cover하지 않는다는 사실이 분기 버그를 만듦 — activity 3분법(idle/paused/playing) 전수 매칭 습관.
