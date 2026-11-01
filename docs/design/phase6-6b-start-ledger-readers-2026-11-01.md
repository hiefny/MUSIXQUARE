# Phase 6 6B: YouTube 시작 장부와 그 독자 (2026-11-01)

| Field              | Value |
| ------------------ | ----- |
| Status             | 준비됨, 배포 전. 브랜치 `agent/p6-6b`(바탕 `9e72b7ce` 위 커밋 아홉: 계획 6B-1과 6B-2의 테스트 먼저·코드 커밋 넷, CHECK 12 후속의 테스트 먼저·가드 커밋 둘, 시험만 하나, 주석·레지스트리만 하나, 이 보고서의 기록 커밋 하나). 버전 올리기(계획 6B-3), release-record §2의 이 열차 항목, PR, 머지, 배포는 릴리스 담당이 한다. 마지막 검사(아래 QA 라운드 2)에서 `--sequence.shuffle` seed 7 하나가 `stale-async-guards.test.ts`의 두 행을 실패시켰다. 6B-2가 만든 시험 순서 의존이고(운영 영향 없음, 바탕은 통과), 고침은 시험만 커밋 하나다. 이 검사는 보고서와 PR 초안만 고칠 수 있어 고치지 않았고 머지 전에 해야 한다(아래 '머지 전에 할 일'). 로컬과 브랜치 결과는 exact-main-SHA 후보를 대신하지 않는다 |
| Base               | `9e72b7ce` = main `9c078f5c`(App 9.0.30 / v803의 배포 기록 #551) 위 T0b 시험만 커밋 일곱(`dff8d37a` ~ `9e72b7ce`). T0b는 아직 main에 없고 시험만 PR 두 개로 받아들이는 중이다. 운영 App 9.0.30(`3c098e9d`) 뒤 이 바탕까지 바뀐 것은 문서 다섯과 시험 파일뿐이라 바탕의 App 런타임은 운영과 같고, 같은 툴체인으로 만든 바탕 빌드의 진입 청크도 9.0.30 운영 smoke가 읽은 것과 이름·크기가 같다(`main-zzIxMfb3.js`, 860,802 B). T0b가 받아들여지며 시험이 바뀌면 릴리스 담당이 이 갈래를 옮긴다(아래 'T0b 파일') |
| Version            | 없음. 9.0.30 / v803 그대로다(`guard:release-identity` 'MUSIXQUARE 9.0.30; service-worker cache epoch v803'). App 런타임 경로가 바뀌므로 다음 App 패치와 SW epoch를 함께 올려야 하고(예상 9.0.31 / v804), 그 전에는 `guard:sw-cache-version`이 그 이유 하나로 실패한다: '[sw-cache-version] FAIL: committed PWA runtime changes are newer than v803 (3c098e9d).'와 아래 'Deploy target'의 App 11 파일, 'Bump CACHE_VERSION in scripts/service-worker-asset.ts after these changes, then commit the bump.'(QA 라운드 2). 올리면 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 둘째, 창 모양은 지금 그대로). 바닥(저장·유효 795)은 바꾸지 않는다 |
| Scope              | 계획 §4.7의 6B-1(C2-5, SS-04)과 6B-2(C2-7, SS-05), 모두 중립. 6B-1: 새 시작 장부 `src/youtube/start-ownership.ts`가 시작 주인들이 등록한 살아 있는 질의를 물을 때마다 읽어 독자에게 답한다. 6B-2: 모든 시작 소유 독자(여덟 모듈의 24곳)가 장부에 묻고, 합성 `isYouTubeZeroStartSyncOwned`(`src/youtube/zero-start-ownership.ts`)와 런타임 다리의 복구 훅 둘이 사라진다. 그 위에 계획에 없던 CHECK 12 후속(가드만), 독자 창 고정(시험만), 주석·레지스트리 한 커밋을 더했다. 와이어, 서버, 저장 모양, 계약 표지, 의존성, 타이머 이름, 로그 줄, 준비 이벤트, 화면, 소리는 바꾸지 않는다([화면 그대로]) |
| Deploy target      | `app`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`, `releaseTargetWorkers`로 `9e72b7ce..07a9f224`를 견준 로컬 git 판정: App 11(`src/network/sync.ts`, `src/player/background-return-sync.ts`, `src/ui/manual-sync-overlay-runtime.ts`, `src/ui/player-controls.ts`, `src/ui/seekbar.ts`, `src/youtube/`의 `iframe.ts`, `player-runtime-bridge.ts`, `player.ts`, 새 `start-ownership.ts`, `sync.ts`, 지운 `zero-start-ownership.ts`), PRO room 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음. 운영 App 9.0.30 `3c098e9d` 대비도 같은 App 11이고, 운영 PRO room `683074bc`와 나머지 넷 `71f5b96c` 대비 그 Worker들의 런타임 경로 차이는 0이다. 운영을 조회하지 않은 판정이라 릴리스의 부분 릴리스 검사를 대신하지 않는다. `raise_app_build_floor` false, Developer API D1 false(계획 RT-01). 계약 동결: `git diff --stat 9e72b7ce..07a9f224 -- cloudflare/ src/network/protocol.ts src/core/constants.ts src/types/index.ts package.json package-lock.json index.html scripts/service-worker-asset.ts browser/`가 비어 있다 |
| Operations         | 운영에 닿지 않았다(로컬 git, 로컬 시험·빌드·Playwright만). GitHub 쓰기, push, 배포, 운영 요청은 없다 |
| Resource ownership | 새 레코드 없음. 장부는 기존 자원 RO-02의 주인들을 독자에게 엮는 곳이고, 답·깃발·단계·스냅샷을 저장하지 않고 구독도 이벤트도 없이 살아 있는 질의만 읽으므로 같은 자원의 둘째 기계가 아니다(`AGENTS.md` Resource ownership, 계획 RT-11). 센 코드를 옮긴 커밋이 같은 커밋에서 레지스트리 RO-02, 가드 항목 12, 기준치를 고쳤다: CHECK 12에 시작 주인 파사드 쓰기 2(`player.ts`, 정확), 실행 스냅샷 읽기 8(`player.ts`, 정확), 장부 합성 1(`player.ts :: seekYouTubeFromApp`, 정확)과 실패 닫힘 규칙들을 더했다. CHECK 11 32, CHECK 12 읽기 11과 지우기 9, CHECK 5 1 / 1 / 45는 그대로다. `node scripts/check-resource-ownership.mts`: 49 records, 457 production files(바탕과 같음, 파일 하나 더하고 하나 지움) |

이 문서는 Phase 6 계획의 둘째 App 열차 6B의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의 Phase 6
계획(2026-10-30)과 그 영역 조사, 오너 답(2026-10-30)이고, SS, RT, C2 번호와 Q 번호는 그 노트의 번호다. 계획의 줄 번호는
`78ec56f5` 기준이라 6A와 T0b가 옮긴 위치를 모두 기호로 다시 찾았고, 이 문서의 줄 번호는 `07a9f224`의 것이다. 앞선 Phase 6 단계는
시험만인 T0a(#539, #541, #542), 가드만인 T1(#543), 첫 App 열차 6A(#550, 9.0.30 / v803, [보고서](phase6-6a-start-constants-owner-queries-2026-10-31.md))와
시험만인 T0b(바탕의 일곱 커밋)다. 이 보고서에서 '중립'은 T0a의 골든과 고정 행, T0b 참값표의 모든 칸이 바이트 그대로 통과하고, 와이어가
바뀌지 않고, 같은 프레임이 같은 시각에 나가며, 준비 이벤트가 출처마다 같은 순간에 나간다(모두에 마이크로태스크 합치기를 씌우지 않음)는 뜻이다.

## 오너 결정 (2026-10-30, 모두 권장)

- **Q1 넷:** Phase 6을 App 업데이트 넷(6A ~ 6D)으로 낸다. 6B는 둘째이고, 업데이트 창은 버전 올리기와 함께 한 번 뜬다.
- **Q18 결함마다 묻기:** 시험이 결함을 재현하면 오늘 동작으로 고정하고 결함마다 따로 묻는다. 6B의 새 행(장부 행, 가드 행, 독자 창
  행)은 모두 오늘 동작이나 새 규칙을 고정한 것이고 결함으로 적은 행은 없다. T0b가 찾아 2026-11-01에 따로 여쭌 결함 넷 가운데 넷째
  (방장 일시정지 신호가 두 번 가는 경우, 참값표 H10, H10a, H10c 행)는 권장대로면 6B의 마지막 증분에 실을 고침인데, 이 기록까지 답이
  없어 이 브랜치에 싣지 않았다(아래 '오너에게' 1). 나머지 셋은 6D 몫이다.
- **Q26 새 모듈:** `start-ownership.ts`의 근거는 `docs/design/source-complexity-ratchet.md`의 둘이다: 여러 운영 소비자의 공유 계약(독자
  24곳, 여덟 모듈)과 순환을 끊는 좁은 포트(주인들이 엮이는 `player.ts`는 `iframe.ts`와 `sync.ts`를 가져오므로 두 독자가 `player.ts`를
  가져오면 순환이 되고 `guard:import-graph`가 막는다. 장부는 아무것도 가져오지 않는 잎이다).
- **엔지니어링 기본값(계획 §9.3, §9.4, 권장대로):** 이 열차가 기댄 것은 Q7(소유자 질의는 주인 자기 타이머를 읽는다: 레거시 claim은
  `player.ts` 자기 `'yt-auto-sync'` 타이머), Q8(시작 소유를 native 보호 목록에 넣지 않는다, `native-control-authority.ts` 그대로), Q10과
  Q24(CHECK 12는 resource-ownership 가드 안에서 정확 개수), Q11(새 test-only export 없음, `guard:dead-exports` 시험 전용 20 그대로), Q28(이
  열차에 의존성 변경 없음), Q29(번들 상한을 넘으면 잰 숫자로 묻는다, 아래 '번들 크기'에서 해당 없음)다.
- **Q6 기준선:** 6A 보고서대로 Phase 6 앞의 기기 기준선은 재지 않았다(오너가 자리에 없음). 그래서 아래 '배포 뒤 확인'은 기준선과
  견주지 못하고 판정 기준과만 견준다.
- **릴리스 위임:** 6A 보고서가 적은 위임(2026-10-31 23:20 KST 무렵부터 약 40시간, 오너의 허락이 꼭 필요한 일만 묻기)이 이어지는 동안의
  배포 판단은 릴리스 담당의 몫이다. 이 브랜치는 그 판단에 쓸 근거만 적는다.

## 증분 한눈에

'부모에서'는 테스트 먼저 커밋을 그 트리 그대로(런타임은 부모의 것) 다시 돌린 결과(실패 / 그 실행의 행)이고, '코드 커밋에서'는 같은
파일들을 코드 커밋에서 돌린 결과다. 둘 다 이 검사가 임시 worktree에서 다시 돌렸다(QA 라운드 1). 실패한 행은 모두 그 테스트 먼저 커밋이
더하거나 바꾼 행이고, 함께 돌린 중립 고정(T0a·T0b 시험 30 파일)은 양쪽에서 모두 통과했다.

| 증분                         | 항목                    | 테스트 먼저 → 코드      | 부모에서                                                 | 코드 커밋에서        | 가드                                                                 |
| ---------------------------- | ----------------------- | ----------------------- | -------------------------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| 6B-1 C2-5 시작 장부          | SS-04                   | `a686284a` → `5300f565` | 17 / 1,809(32 files), 등가 시험 파일은 불러오기 실패     | 1,819 / 1,819        | 수 그대로                                                            |
| 6B-2 C2-7 독자 옮김          | SS-05                   | `44a85664` → `4d3ba199` | 27 / 2,068(36 files)                                     | 2,068 / 2,068        | 파사드 쓰기 2(새, 정확), 장부 합성 규칙(새)                          |
| CHECK 12 후속                | RO-02, 가드 항목 12     | `cc03ecd8` → `acc2e755` | 12 / 91                                                  | 91 / 91              | 스냅샷 읽기 8(새, 정확), 장부 합성 1(문장마다, 정확), 시작 타이머 규칙 |
| 독자 창 고정                 | 시험만                  | `b1db3cc7`              | 5 / 5 통과(6B 앞 바탕 `9e72b7ce`에서도 5 / 5)            | 해당 없음            | 없음                                                                 |
| 주석·레지스트리              | RO-02, 가드 머리 주석   | `07a9f224`              | 해당 없음                                                | 빌드 바이트 동일     | 없음                                                                 |
| 기록                         | 이 보고서, `docs/README.md` | 기록 커밋 하나      | 해당 없음                                                | 해당 없음            | 없음                                                                 |

## 증분

### 6B-1 C2-5 시작 장부 (SS-04)

새 `src/youtube/start-ownership.ts`(머리 `Resource owner: RO-02`)는 시작 주인들을 독자에게 엮는 장부다. 주인마다 자기 상태, 타이머,
수명을 그대로 갖고, 장부는 아무것도 갖지 않는다.

- **claim 종류와 살아 있는 질의:** `standard-run`(zero-start 실행: in flight, protocol active, hard-muted), `standard-recovery`(실행이
  포기한 시작을 이어받는 복구: active, pending), `legacy-rendezvous`(레거시 2단계 랑데부의 Stage-2 대기, 6B-2부터 등록), `pro-arm`(PRO
  arm의 hard-muted), `pro-direct`(PRO 직접 COMMIT의 로컬 대기, 읽는 파생 질의가 없어 등록하지 않음). 질의는 위치로 둔다(속성 이름은
  처음 받는 진입 청크에 실리기 때문).
- **등록:** 주인들이 엮이는 `player.ts`만 모듈 평가 끝에서 종류마다 한 번 `registerYouTubeStartClaim(kind, queries)`로 등록한다
  (`player.ts:4771-4781`). 다른 모듈의 질의는 클로저 뒤에 두어 부를 때 그 모듈의 살아 있는 바인딩을 읽는다. 등록은 질의를 읽지 않는다.
- **파생 질의:** 6B-1은 `isYouTubeStartSyncOwned`(실행의 protocol, 그다음 복구의 pending)와 `isYouTubeStartHardMuteOwned`(실행의
  hard-mute, 복구의 active, PRO arm)를 둔다. 묻는 순서와 단락은 바꾸는 합성의 피연산자 순서 그대로다. 파생 질의는 모든 종류를
  결정해야 하고(그 종류의 질의 하나나 never `0`), 종류를 더하고 claim 타입이나 어느 파생 질의의 결정을 빠뜨리면 컴파일되지 않는다.
- **독자:** 이 증분에서는 `player.ts`의 넷이 장부로 옮긴다: seek의 mid-sync 확인(`seekYouTubeFromApp`)과 늦은 합류 bootstrap 미룸은
  `isYouTubeStartSyncOwned`, `youtube:set-volume`과 PRO 일시정지 관문 정착의 unMute 가드 둘은 `isYouTubeStartHardMuteOwned`. 나머지
  독자는 6B-2까지 옛 합성을 읽는다.
- **지킨 것:** 9.0.8 방장 스피커 기준. `onPlaybackStarted`는 `getYouTubeZeroStartSnapshot()?.releaseLeadMs`를 읽어 방장 오프셋에서
  출시 앞섬만 뺀다(`player.ts:2431`, 로그 줄 `:2442`). 장부는 실행을 끝내거나 지우거나 바꿀 수 없고 `zero-start.ts`는 이 열차에서
  바뀌지 않아(`git diff 9e72b7ce..07a9f224 -- src/youtube/zero-start.ts` 비어 있음) 그 콜백 때 실행과 그 스냅샷이 전처럼 살아 있다.
  PRO arm의 `onPhaseChange`는 잇지 않았다(`iframe.ts` 인스턴스 그대로). 준비 이벤트와 sync-loading 이벤트를 내는 곳은 하나도 옮기지 않았다.
- **기록(같은 커밋):** 새 [설계 문서](youtube-start-ownership.md)(Accepted, `docs/README.md`의 설계 목록), `docs/qa-domains.md`의
  QA053(대표 구현이 지운 `zero-start-ownership.ts` 대신 장부와 설계 문서), 레지스트리 RO-02(상태는 `duplicated` 그대로), 핵심 커버리지
  (`vitest.critical.config.ts`에 장부 99 / 99 / 99 / 99와 `zero-start.ts` 84 / 83 / 96 / 88, 시험 파일 다섯).
- **시험(테스트 먼저 `a686284a`):** 새 `start-ownership.test.ts`가 운영 export만으로 장부를 몬다: claim 자리마다의 결정, 여덟 질의의 256
  조합 모두에서 읽는 순서와 단락, 부를 때 읽음, 등록 교체. 새 `start-ownership-equivalence.test.ts`(과도기)는 두 파생 질의를 바꾸는 합성과
  실제 Standard 게스트·PRO 참가자 실행의 모든 참값표 표본 시점에서 견준다(합성이 사라지는 6B-2에서 지움).
- **부모에서 17 / 1,809 실패:** `start-ownership.test.ts` 17행 모두 'Cannot find module …/start-ownership.ts'(모듈이 아직 없음),
  `start-ownership-equivalence.test.ts`는 import를 풀지 못해 불러오기 실패(0행). 함께 돌린 중립 고정 30 파일 1,792행(T0b 참값표 두 파일,
  T0a 골든 둘, 9.0.8 시험이 있는 `player.test.ts`와 `sync-integration.test.ts`, ZS-09 끝점 행의 `pro-start-kind-endpoint.test.ts` 등)은
  통과했다. `5300f565`에서 32 files, 1,819 / 1,819(새 행 27 = 17 + 10).

### 6B-2 C2-7 독자 옮김 (SS-05)

- **장부에 파생 질의 넷:** `isYouTubeStartTimelineHeld`(실행 in flight, 그다음 복구 pending: `sync.ts`의 작은 drift 표본, 게스트
  하트비트와 보조 상태 보류), `isYouTubeStartArmBusy`(실행 in flight: seek 막대의 문과 `iframe.ts`의 UI 루프),
  `isYouTubeStartRecoveryActive`(복구 active: `iframe.ts`의 상태 사건 분배), `isYouTubeStartRoomStateHeld`(실행 protocol, 그다음 레거시
  랑데부의 Stage-2 대기: `iframe.ts`의 보조 `YOUTUBE_STATE` 억제). `player.ts`가 레거시 랑데부 claim을 자기 `'yt-auto-sync'` 타이머로
  등록한다(`isYouTubeAutoSyncPendingOwned`, `player.ts:863`, 런타임 다리의 `isYouTubeAutoSyncPending`도 같은 질의로 답함).
- **독자 24곳, 여덟 모듈:** `sync.ts` 11(`:377`, `:610`, `:690`, `:712`, `:1055`, `:1143`, `:1764`, `:2336`은 `isYouTubeStartSyncOwned`,
  `:1222`, `:1431`, `:2371`은 `isYouTubeStartTimelineHeld`), `player.ts` 4(6B-1), `iframe.ts` 3(`:3114` recovery, `:3368` room state,
  `:3413` arm), `manual-sync-overlay-runtime.ts` 2(`:298`, `:363`), `src/network/sync.ts:150`, `src/ui/player-controls.ts:938`,
  `src/player/background-return-sync.ts:191`(모두 `isYouTubeStartSyncOwned`), `src/ui/seekbar.ts:45`(`isYouTubeStartArmBusy`). 조건마다
  장부 질의 하나다. 묻는 주인 질의와 순서와 단락은 바꾸기 전과 같다.
- **지움:** `src/youtube/zero-start-ownership.ts`(11줄), 런타임 다리의 복구 훅 둘(`isYouTubeZeroStartExternalFallbackActiveFromIframe`,
  `isYouTubeZeroStartExternalFallbackPendingFromSync`)과 그 설정 키 둘, `player.ts`의 그 다시 내보내기 하나. 계획 §4.10 끝 조건 2의
  'zero-start-ownership.ts 없음, isYouTubeZeroStartSyncOwned 없음'이 `src`(시험 밖)에서 참이 됐다.
- **준비 이벤트:** `youtube:zero-start-readiness-changed`는 내는 곳 17·듣는 곳 3, `youtube:sync-loading`은 내는 곳 16으로 바탕과 같고,
  두 이벤트를 내는 곳은 파일마다도 같다(합쳐서 `iframe.ts` 11, `sync.ts` 11, `player.ts` 5, `retained-player-controller.ts` 4,
  `standard-host-rendezvous.ts` 2). 실행의 단계 바뀜은 동기로, 복구 깃발 바뀜은 한 마이크로태스크 뒤로 그대로 낸다(`player.ts:2421-2423`,
  `:458-470`). 장부는 이벤트를 내지도 듣지도 않고 아무것도 합치지 않는다.
- **CHECK 12(같은 커밋):** `zero-start.ts` 밖의 파사드 쓰기는 실행 claim 등록의 둘(`player.ts`, 정확)뿐이어야 하고, 다른 곳의
  `isYouTubeZeroStart*` export, 한 조건에서 장부 질의 둘을 엮는 것, 장부 export를 넘기기, 순수하지 않은 장부, 둘째 등록자는 실패한다.
  레지스트리 RO-02와 가드 절, 설계 문서의 고침이 같은 커밋에 있다.
- **시험:** 과도기 등가 시험은 합성과 함께 지웠다(지우기 전 마지막 실행인 `5300f565`에서 10 / 10, 어느 표본도 어긋나지 않음). 지운 기호를
  가리키던 시험 이음새는 기대 배열과 강제 값을 바꾸지 않고 장부로 옮겼다: 참값표 표본기의 열 지도, 시작 하네스의 술어, `player.ts`를
  불러오지 않는 묶음이 대역이 답하는 claim을 등록하기. 도달 단언은 같은 claim을 장부 질의로 본다(아래 'T0b 파일').
- **시험(테스트 먼저 `44a85664`):** `start-ownership.test.ts`에 새 질의 넷의 행(claim 자리마다의 결정, 256 조합의 순서와 단락, 부를 때
  읽음, room-state 보류만 레거시 랑데부를 물음), `resource-ownership-guard.test.ts`에 장부 규칙을 심은 위반 행과 양성 대조.
- **부모에서 27 / 2,068 실패:** 장부 17(새 질의 넷이 아직 없어 'ledger.isYouTubeStart… is not a function'), 가드 10(규칙이 없어 오류 줄이
  비거나 'start-owner facade uses 2'가 없음). 중립 고정 30 파일과 이음새 넷(`host-local-rendezvous`, `native-control-owner-ports`,
  `standard-realign`, `youtube/sync`)은 통과했다. `4d3ba199`에서 36 files, 2,068 / 2,068.
- **변이 확인(QA 라운드 1, `07a9f224`에서 다시 함):** 새 질의의 claim 자리를 하나씩 틀리게 바꾸면 행이 실패한다. timelineHeld가 protocol을
  읽으면 12(장부 4, Standard 참값표 8), armBusy가 protocol을 읽으면 14(seek 막대 1, load-lifecycle 1, 장부 4, 참값표 8), recoveryActive가
  pending을 읽으면 13(장부 4, owner-boundary 3, 참값표 5, fallback-ownership 1), roomStateHeld가 레거시 claim을 빼면 12(장부 4,
  owner-boundary 1, 참값표 7). 11 파일 602행에서 잼, 파일은 끝에 되돌림.

### CHECK 12 후속: 문장마다 세는 시작 claim, 실행 스냅샷 읽기, 시작 타이머 (RO-02, 가드 항목 12)

6B-2의 CHECK 12는 설계 문서가 적은 것을 다 지키지 못했다: 장부 질의 둘을 `||`·`&&`·`??` 한 사슬에서만 잡아 비교, `Boolean()`, 배열,
`?:`, claim 자신의 공개 질의로 다시 엮을 수 있었고, 파사드만 세어 `getYouTubeZeroStartSnapshot`으로 소유 답을 다시 만들어도 보이지
않았으며, 장부 순수성 규칙이 모듈 수준 const·class의 저장된 답, claims Map 쓰기, 장부 자신의 등록을 놓쳤고, `player.ts` 함수 안의 등록과
`src/youtube/` 밖에서 이름을 부른 시작 타이머가 통과했다. 가드만 바꾼 `acc2e755`가 이를 닫는다.

- **장부 합성, `file :: function`마다:** 장부 밖에서 시작 claim 둘 이상을 묻는 문장(장부 질의, claim 자신의 공개 질의인 다리의
  `isYouTubeAutoSyncPending`과 `iframe.ts`의 `proYouTubeAuthorityOwnsHardMute`, `player.ts`가 등록한 질의, `'yt-auto-sync'`의
  `getManagedTimer()` 읽기). 가장 가까운 문장 단위로 센다. 정확한 항목은 seek의 mid-sync 확인 하나(`player.ts :: seekYouTubeFromApp`, 1:
  `isYouTubeStartSyncOwned`와 `'yt-auto-sync'` 읽기가 같은 문장, 방장 로컬 시작·끝 보류·수동 오프셋 거래 옆)다.
- **실행 스냅샷 읽기, 파일마다:** `zero-start.ts` 밖의 `getYouTubeZeroStartSnapshot`·`getYouTubeZeroStartPendingCanonicalPosition` 참조.
  정확: `player.ts` 8(실행 claim의 hard-mute 단계 `:114`, 9.0.8 방장 스피커 기준과 그 로그 줄 `:2431`, `:2442`, 게스트 복구의 들리는 앞섬과
  실행 확인 `:2452`, `:2533`, 피어 교체 대체 둘 `:3178`, `:3194`, `local-offset.ts`에 넘기는 예약 시작 읽기 `:2268`). 다시 내보내면 실패.
- **장부 순수성:** 모듈 수준 바인딩은 `START_CLAIM_KINDS`(문자열 상수 목록)와 `claims`(빈 `Map`) 둘, 모듈 수준 class·enum·namespace 없음,
  함수 지역 바인딩 밖의 쓰기 없음, `registerYouTubeStartClaim` 밖의 claims 바꿈 없음, 장부 자신의 등록 없음.
- **등록:** `player.ts`의 최상위 문장에서만.
- **시작 타이머:** `src/youtube/` 밖에서 이름이 시작 타이머로 풀리는 `getManagedTimer()`·`clearManagedTimer()`·`setManagedTimer()`는
  실패한다(지금 0, 기준치 없음).
- **기록(같은 커밋):** 레지스트리 RO-02(수, 항목과 이유, 시작 타이머 규칙), 가드 항목 12와 '아직 검사 안 함'(문장 사이에 변수나 지역
  도우미로 엮은 claim, `src/youtube/` 밖의 풀리지 않는 타이머 이름), 설계 문서, 장부 머리 주석(주석만이라 빌드 바이트 동일).
- **시험(테스트 먼저 `cc03ecd8`):** `resource-ownership-guard.test.ts`에 위 규칙마다 심은 위반과 허용 행 아홉(82 → 91행). 바뀐 행은 넷(합성
  오류 문구, 순수하지 않은 장부 행이 함수 지역 밖 쓰기도 기대, 넛지 행이 접힌 `'yt-auto-sync'` 읽기와 `isYouTubeAutoSyncPending`의 같은 문장
  합성을 기대, '`src/youtube` 밖 파일' 행이 시작 타이머가 아닌 이름과 풀리지 않는 이름을 읽음).
- **부모에서 12 / 91 실패**(새 행 아홉과 바뀐 행 셋: 가드에 규칙이 없거나 옛 합성 문구), 79 통과(바뀐 '`src/youtube` 밖' 행 포함).
  `acc2e755`에서 91 / 91.
- 지금 가드를 6B 앞 바탕 트리(`9e72b7ce`)에 돌리면 파사드 쓰기 7(`seekbar.ts` 1, `iframe.ts` 2, `sync.ts` 3, `zero-start-ownership.ts` 1)과
  파사드 export 넷(다리 훅 둘, `player.ts`의 다시 내보내기, 합성)으로 실패한다(QA 라운드 2). 그래서 이 규칙들은 6B-2가 옮긴 것을 지킨다.

### 독자 창 고정 (시험만, `b1db3cc7`)

6B-2가 옮긴 독자 가운데 여섯은 가까운 다른 질의와 가르는 행이 없었다(독자를 틀린 장부 질의로 옮겨도 모든 묶음이 통과). 두 질의가
갈리는 창은 Standard 게스트의 timeline 보정이다: zero-start가 PLAYING을 출시한 뒤 실행은 protocol active지만 in flight가 아니어서
`isYouTubeStartSyncOwned`는 참이고 `isYouTubeStartTimelineHeld`, `isYouTubeStartArmBusy`는 거짓이다.

- 새 `start-ownership-reader-windows.test.ts`(시작 하네스의 실제 게스트 all-ready 실행, 합성 방 코드 000001)가 그 창(출시 +1,422 ms 뒤 2 s,
  protocol active는 약 +4,180 ms까지)에서 독자 다섯의 오늘 결과를 고정한다: 게스트 하트비트 보류가 방장 하트비트를 통과시킴(PAUSED
  하트비트가 autoplay 의도를 지움), 게스트 보조 `YOUTUBE_STATE` 보류가 프레임을 통과시키고(제목 적용) 그 상태 동작은 현재가 아니라
  iframe에 명령이 없음, 수동 오프셋 적용이 랑데부와 토스트 없이 물러남, 수동 싱크 창이 쓸 수 없고 창이 끝나면 다시 쓸 수 있음.
- 변이 확인(QA 라운드 1, `07a9f224`에서 다시 함): 독자를 하나씩 다른 질의로 바꾸면 정확히 그 행이 실패한다(`sync.ts:1431`과 `:2371`
  TimelineHeld → SyncOwned, `:610` `isCurrentStateAction`과 `:1055` `isCurrentManualOffsetApply` SyncOwned → ArmBusy,
  `manual-sync-overlay-runtime.ts:298` SyncOwned → ArmBusy). 늦춘 랑데부 단계의 확인(`matchesRendezvousOccurrence`, `sync.ts:712`)은 바꿔도
  실패하는 행이 없다: 그 창에서는 뒤따르는 단계가 `guestRendezvousSync`를 거쳐 `isYouTubeStartSyncOwned`를 다시 묻고 랑데부를 시작하지
  않는다. 작은 drift 표본(`sync.ts:1222`)도 같은 조건이 `isGuestYouTubeTransitionPending`(→ `isYouTubeStartSyncOwned`)을 함께 물어 가를 수 없다.
- 다섯 행은 부모(`b1db3cc7`의 트리, 런타임은 `4d3ba199`와 같음)에서 5 / 5, 6B 앞 바탕 `9e72b7ce`(파일만 넣어 돌린 뒤 지움)에서도 5 / 5 통과한다.
  6B가 바꾸지 않은 오늘 동작을 고정한 것이고 결함으로 적은 행은 없다.

### 주석·레지스트리 (`07a9f224`)

CHECK 12는 claim의 공개 질의(`proYouTubeAuthorityOwnsHardMute`)를 장부 질의 옆에서 세지만, 같은 claim에 답하는 PRO arm의 `ownsHardMute()`를
`iframe.ts` 안에서 그 인스턴스에 부르는 것은 세지 않는다. 레지스트리 '아직 검사 안 함'과 가드 머리 주석에 적었다. 주석과 문서뿐이다.

## T0b 파일

T0b(받아들이는 중인 시험만 PR 둘)의 파일 19개 가운데 11개를 6B-2 코드 커밋 `4d3ba199` 하나가 고친다. 지운 모듈과 다리 훅을 mock하거나
가져오던 이음새라 6B-2에 꼭 필요했다(142줄 더함, 91줄 지움). 기대 배열과 강제 값은 바꾸지 않았고, 도달 단언은 같은 claim을 장부 질의로 본다
(복구의 pending claim은 따로 묻는 공개 질의가 없어 `isYouTubeStartTimelineHeld()`와 `!isYouTubeStartArmBusy()`로 본다). `player.test.ts`에서
지운 다시 내보내기가 다리 훅과 같은 함수임을 보던 단언 하나는 그 다시 내보내기와 함께 지웠다.

- `src/youtube/__tests__/__helpers__/start-ownership-sampler.ts`: 참값표 열 지도만(owned, inFlight, fallback, fallbackPending, auxHeld,
  beatHeld, unMuteHeld가 장부 질의를 읽음). 두 참값표(`youtube-start-ownership-table.test.ts` 37행, `-pro` 12행)의 기대 배열은 그대로다.
- `src/player/__tests__/background-return-sync.test.ts`: mock 대상을 지운 모듈에서 장부 질의로.
- `src/network/__tests__/sync.test.ts`, `src/ui/__tests__/player-controls.test.ts`, `src/ui/__tests__/seekbar.test.ts`,
  `src/youtube/__tests__/host-local-rendezvous.test.ts`, `standard-realign.test.ts`, `sync.test.ts`, `zero-start-heartbeat-ownership.test.ts`:
  `player.ts`를 불러오지 않으므로 대역이 답하는 claim을 등록.
- `src/youtube/__tests__/player.test.ts`, `sync-integration.test.ts`: 지운 다리 훅과 다시 내보내기 대신 장부 질의.

T0b 받아들임이 이 파일들을 바꾸면 옮길 때 충돌할 수 있다. 그때는 위 원칙(기대 배열 그대로, 이음새만 장부로)대로 다시 맞춘다. 다른 6B
커밋은 T0b 파일을 고치지 않는다. 아래 '머지 전에 할 일'의 고침도 T0b 파일(`stale-async-guards.test.ts`) 하나를 고쳐야 한다.

## 계획과 달라진 것

1. **줄 번호:** 계획 인용은 `78ec56f5` 기준이라 모든 위치를 기호로 다시 찾았다.
2. **보조 `YOUTUBE_STATE` 억제(계획의 `iframe.ts:3372`):** 계획은 파사드에 남기고 그 줄을 기준에 넣는 길도 열어 두었다. 6B-2는 장부 질의
   `isYouTubeStartRoomStateHeld`로 옮기고 레거시 랑데부 claim을 등록했다. 그래서 `zero-start.ts` 밖의 파사드 쓰기는 실행 claim 등록의 둘뿐이다.
3. **CHECK 12 규칙:** 계획은 '장부 밖 새 `isYouTubeZeroStart*` 합성이나 `getManagedTimer('yt-…')` 소유 질의 거절'이었다. 6B-2와 그 후속이
   파사드 쓰기(2), 실행 스냅샷 읽기(8), 문장마다 장부 합성(1), 장부 순수성, 등록 규칙, `src/youtube/` 밖 시작 타이머로 넓혔다(계획에 없던
   가드 후속 증분 하나, 테스트 먼저와 가드 두 커밋).
4. **남긴 합성과 claim 자신의 질의:** seek의 mid-sync 확인은 장부 질의와 `'yt-auto-sync'` 읽기를 한 문장에 둔다(다른 주인인 방장 로컬
   시작·끝 보류·수동 오프셋 거래 옆, 가드 항목 1). 레거시 Stage-2 대기를 묻는 독자 셋(`sync.ts` 하트비트 보류, `iframe.ts`의 서브 영상
   자동 넘김 확인, `native-control-authority.ts`)은 6A-1의 다리 질의 `isYouTubeAutoSyncPending`을 그대로 묻는다. 레거시 claim이 같은 살아 있는
   질의를 등록하므로 claim이 바뀌면 이 셋도 함께 옮겨진다.
5. **`pro-direct`:** 계획은 pro-arm·pro-direct claim이 `player.ts`의 transitionId 갈림을 따른다고 적었다. 읽는 파생 질의가 없고 그 2 s 로컬
   대기에 공개 주인이 없어 종류만 선언하고 등록하지 않았다(설계 문서 'Not covered yet', C2-13). T0a의 ZS-09 끝점 행
   (`pro-start-kind-endpoint.test.ts` 6 / 6)은 그대로 통과한다.
6. **T0b 파일:** 6B-2가 T0b 파일 11개를 고친다(위 'T0b 파일').
7. **추가한 시험:** 독자 창 고정(`b1db3cc7`)은 계획에 없었다. 6B-2가 옮긴 독자 가운데 다섯에 가르는 행을 준다.
8. **6B-3(버전 올리기·문서)은 이 브랜치에 없다:** 릴리스 담당이 T0b와 '머지 전에 할 일' 뒤에 더한다(아래 '배포 조건과 순서').

## 정확한 개수 가드

| 가드                                                    | 바탕 `9e72b7ce`                                         | 브랜치 끝 `07a9f224`                                                     |
| ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| CHECK 11 iframe 오디오 쓰기(RO-12)                      | 32                                                      | 32(줄만 옮겨짐)                                                          |
| CHECK 12 남의 시작 타이머 읽기 / 지우기(RO-02)          | 11 / 9                                                  | 11 / 9                                                                   |
| CHECK 12 시작 주인 파사드 쓰기(6B-2부터)                | 규칙 없음(지금 가드로는 7과 export 넷, 실패)            | 2, `player.ts`(실행 claim 등록)                                          |
| CHECK 12 실행 스냅샷 읽기(후속부터)                     | 규칙 없음                                               | 8, `player.ts`                                                           |
| CHECK 12 장부 합성(문장마다, 후속부터)                  | 규칙 없음                                               | 1, `player.ts :: seekYouTubeFromApp`                                     |
| CHECK 5 복사 / 의심 / 같은 값 쌍(보고만)                | 1 / 1 / 45                                              | 1 / 1 / 45                                                               |
| resource-ownership                                      | 49 records, 457 production files, `--report` 108줄      | 49 records, 457 production files, `--report` 119줄                       |
| dead-exports                                            | 410 prod files, 2,157 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76 | 410, 2,161, 0, 20, 76                                  |
| import-graph                                            | 410 files, 2,103 edges, 순환 0                          | 410 files, 2,101 edges, 순환 0                                           |
| bus-pairing                                             | 202 / 202                                               | 202 / 202                                                                |
| room-authority                                          | 79 / 22 / 13 / 0 / 0, 410 files                         | 같음                                                                     |

`--report`의 바뀐 줄은 새 사이트 열하나(파사드 쓰기 2, 스냅샷 읽기 8, 장부 합성 1)와 `player.ts`·`sync.ts` 사이트의 줄 번호뿐이다. 내린
기준치도 올린 기준치도 없고, 새 기준치는 그 규칙을 더한 커밋(`4d3ba199`, `acc2e755`)이 레지스트리 기록과 함께 더했다. source-complexity
(YouTube 파일은 목록에 없음)도 바뀐 기준치가 없다.

## 번들 크기

같은 툴체인(Node 24.22.2, vite 8.3.3)으로 커밋마다 `npm run build`를 하고 `scripts/check-initial-transfer-budget.mts`의
`measureInitialTransfer`로 바이트를 읽었다(QA 라운드 2, 임시 worktree). 브랜치 끝은 `build:checked`의 운영 빌드로도 쟀고 같았다.

| 커밋                             | 진입 청크          | 진입 raw / gzip   | eager JS gzip (부모 대비) | eager total raw / gzip (부모 대비) |
| -------------------------------- | ------------------ | ----------------- | ------------------------- | ---------------------------------- |
| 바탕 `9e72b7ce`(운영 9.0.30과 같음) | `main-zzIxMfb3.js` | 860,802 / 253,728 | 465,458                   | 2,048,366 / 543,651                |
| 6B-1 `5300f565`                  | `main-DQlXNnFP.js` | 861,172 / 253,860 | 465,587 (+129)            | 2,048,736 / 543,779 (+128)         |
| 6B-2 `4d3ba199`                  | `main-jdcp8EDh.js` | 861,056 / 253,678 | 465,405 (−182)            | 2,048,620 / 543,597 (−182)         |
| 브랜치 끝 `07a9f224`             | `main-jdcp8EDh.js` | 861,056 / 253,678 | 465,405 (0)               | 2,048,620 / 543,597 (0)            |

- 증분별(부모 대비 eager JS gzip): 6B-1 +129, 6B-2 −182. 둘 다 증분 상한 +300 B 안이다. 테스트 먼저 커밋(`a686284a`, `44a85664`)은 런타임이
  부모와 같고, 6B-2 뒤 커밋(`cc03ecd8` ~ `07a9f224`)은 시험, 가드, 문서와 장부 머리 주석만 바꾼다. `07a9f224`를 따로 빌드해 `4d3ba199`와 진입
  청크와 모든 값이 같음을 봤다.
- **6B 순증:** eager JS gzip −53 B, eager total gzip −54 B, 진입 raw +254 B, 진입 gzip −50 B. KiB로는 eager JS 454.5 KiB, eager total
  530.9 KiB gzip 그대로이고 `guard:initial-transfer-budget`을 통과한다(entry 840.9 KiB raw / 247.7 KiB gzip, eager total 2,000.6 KiB raw).
- **Phase 6 누계(계획 §4.2-6, 증분마다 부모 대비 잰 차의 합, 사이에 낀 Phase 6 밖 열차는 뺌):** 6A −149 B(그 보고서의 처음 바탕 위
  증분 차의 합) + 6B −53 B = **−202 B**로 Phase 상한 +200 B 안이다. 처음 받는 양이 운영 9.0.30보다 줄어 Q29의 멈춤 조건에 해당하지
  않는다(아래 '오너에게' 2).
- 6B-1의 +129 B는 장부 모듈과 등록, 6B-2의 −182 B는 지운 합성 모듈, 다리 훅 둘, 다시 내보내기와 독자 import의 줄어듦으로 본다[추론].

## 혼합 버전

계획 §4.7의 (a) ~ (c)와 §5의 6B 행이다. 근거는 기기 혼합 행이 아니라 T0a의 프레임·시각 골든과 T0b 참값표가 바이트 그대로 통과한
것이다(Phase 5의 P5-D9 C 선례). 와이어(`src/network/protocol.ts`, `src/types/index.ts`, `src/core/constants.ts`, `cloudflare/`)는 바탕과
바이트로 같다.

| 조합                                  | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) 6B 방장과 옛 게스트               | 방장 하트비트 보류(`sync.ts:377` `broadcastYouTubeSync`)는 `isYouTubeStartSyncOwned`로 옛 합성과 같은 주인 질의를 같은 순서로 묻는다(실행 protocol, 그다음 복구 pending). 실행이 protocol을 놓는 때는 `zero-start.ts:862-870`의 보정 창 끝이고 이 열차에서 바뀌지 않았다. 그래서 옛 게스트가 하트비트를 받는 시점이 같고 #14 틈은 넓어지지도 좁아지지도 않는다. T0b Standard 참값표의 beatHeld·owned 열과 T0a Standard 와이어·시각 골든이 그대로다 |
| (b) 옛 방장과 6B 게스트               | 옛 방장의 코호트 문 `canBeginHostTransition`(`zero-start.ts:510-523`)은 게스트가 지금 연결에서 광고했는지만 보고 저장한 `ready`·`platform`(`:500`)을 읽지 않는다. 첫 CAPABILITY는 `network:peer-connected`(`player.ts:4735-4740`)에서 나가고 `advertiseCapability`(`zero-start.ts:468-494`)는 (방장, 플랫폼, ready)가 같으면 다시 보내지 않는다. 6B는 준비 이벤트를 내는 곳(17)과 그 시점, 듣는 곳(`player.ts:3174`)과 광고 경로(`:2832-2836`)를 바꾸지 않고 장부는 이벤트를 내지도 합치지도 않으므로 CAPABILITY 시각이 같다. 미뤄진 경우(첫 광고가 준비 이벤트로 미뤄짐)도 T0a CAPABILITY 시각 골든이 그대로 고정한다 |
| (c) 6B 방장의 보조 `YOUTUBE_STATE`    | 억제 창(`iframe.ts:3368`)은 `isYouTubeStartRoomStateHeld`(실행 protocol, 그다음 레거시 Stage-2 대기)로 바꾸기 전의 `isYouTubeZeroStartProtocolActive() \|\| isYouTubeAutoSyncPending()`와 같은 질의를 같은 순서로 묻는다. 창이 같으므로 옛 게스트가 '방장 일시정지'로 읽을 새 프레임이 생기지 않는다. T0b 참값표의 auxHeld 열과 그 와이어 효과 행, T0a 골든이 그대로다 |
| PRO 방의 옛·새 기기                   | 장부는 PRO arm을 읽기만 하고 몰지 않는다. PREPARE·READY·COMMIT은 서버를 거치고 서버는 바뀌지 않으며, T0a PRO READY 시각 골든(10 / 10)과 T0b PRO 참값표(12 / 12)가 그대로다 |
| 바닥 795 아래의 열린 세션             | 바닥은 열린 세션을 닫지 않는다. 6B는 프레임을 얼려 그 위험을 더하거나 줄이지 않는다 |

결과가 다르더라도 '방이 zero-start 대신 레거시로 시작' 같은 품질 저하이고 재생이 멈추지는 않는다고 본다(계획 §5, 추론). (a)와 (c)는
[추론]이고 T0a·T0b 표가 같으면 생기지 않는다.

## D4 다시 재기 (Phase 4의 재정렬 사슬)

계획 §4.7 6B-2와 로드맵 부록 D4('Phase 6 re-baselines Phase 4')대로 다시 쟀다. 모두 그대로다.

- **`guestRendezvousSync` 허용 목록:** 가드가 아니라 레지스트리 문장(RO-05 'Allowed requesters', 'Single-shot callers')뿐이다. 운영
  호출자는 바탕과 브랜치 끝이 같다: `src/player/background-return-sync.ts:128`, `src/player/local-output-rejoin.ts:228`,
  `src/ui/manual-sync-overlay-runtime.ts:425`, `src/youtube/iframe.ts:2709`, `:3957`, `src/youtube/sync.ts` 일곱(`:899`, `:1020`, `:1077`,
  `:1084`, `:1126`, `:1369`, `:1474`, 바탕보다 2 ~ 3줄 위). 바뀐 것은 그 안의 소유 질의가 장부 질의 `isYouTubeStartSyncOwned`가 된 것뿐이다
  (`guestRendezvousSync` 첫 문 `sync.ts:1764`).
- **pause 규칙과 앵커:** 두 사슬은 그대로 `youtube:set-local-paused`에서 끝난다(`background-return-sync.ts:155`, `local-output-rejoin.ts:408`,
  두 파일의 그 줄은 바탕과 같음). RO-05의 앵커 시험과 교차 흐름 하네스(`local-output-realign-cross-flow.test.ts`, 정의 13, 실행 25,
  `sync.ts`를 mock하지 않음)가 25 / 25, `background-return-sync.test.ts` 38 / 38, `local-output-rejoin.test.ts` 164 / 164로 통과한다.
  `local-output-rejoin.test.ts`는 `sync.ts`를 통째 mock하므로 6B-2의 `sync.ts` 변화를 보지 못하고, 그 몫은 교차 흐름 하네스가 진다.
- **레지스트리:** RO-05와 RO-48은 바뀌지 않았다(`git diff 9e72b7ce..07a9f224 -- docs/design/resource-ownership-registry.md`가 그 두 기록에
  닿지 않음). 바꿀 것이 없으므로 이 열차에서 고치지 않는다(계획 RT-11).
- **장부를 불러오지 않는 묶음:** 교차 흐름 하네스는 `player.ts`를 불러오지 않아 claim이 없고, 그래서 모든 파생 질의가 거짓이다(6B 앞
  zero-start 파사드가 거짓이던 것과 같음). 이 하네스의 행은 사슬의 동작을 보이고 문의 엮음은 장부 시험, 참값표, 도달 행이 본다(설계 문서
  Verification).

## 되돌리기

기본은 더 높은 SemVer·epoch의 앞으로 고치기다. 새 되돌리기 경계는 없다: 계약 표지, D1, 저장 모양, 바닥을 바꾸지 않아 forward floor가
생기지 않는다.

- **실패 자동 복구:** target `app`의 실패 복구는 릴리스 안에서 checkpoint의 App(dispatch 때의 운영 App)으로 간다. 지금이면 9.0.30 / v803
  (6A, `3c098e9d`)이다. 바닥 795 이상이라 `lower`가 필요 없고, 와이어가 같아 되돌린 App과 6B가 섞인 방도 같은 프레임을 같은 시각에 보낸다.
- **손 되돌리기:** 배포 뒤 checkpoint App으로 가는 손 되돌리기는 6B를 받은 클라이언트에 낮은 epoch를 돌려주므로 release-record §2 9.0.29
  절의 열린 항목('낮은 epoch로 가는 App 손 되돌리기의 규칙', 결정 전)과 `docs/hotfix-procedure.md`를 따른다. 결정 전에는 6B만 빼는 다음
  번호의 코드 되돌리기가 기본이고, 급할 때만 명시적으로 검토한 CLI 되돌리기다.
- **혼자 되돌릴 수 있는 기간:** 6C가 머지되기 전까지다(계획 §4.7, 라운드 2b 계4: 6C-1 라우터가 6B-1 장부 claim으로 갈린다). 그 뒤에는
  6B부터 가장 최근 열차까지 앞으로 되돌린다: 새 `agent/` 갈래에서 그 열차들의 커밋을 거꾸로 되돌리고, 다음 SemVer·epoch(버전 거울 여섯과
  `index.html`의 bootstrap 캐시 쿼리), 전체 게이트, App 릴리스, 기록. 앞으로 되돌리기와 앞으로 고치기는 각각 업데이트 창 하나를 Q1의 넷
  밖으로 더한다.
- **되돌릴 때 가드와 시험:** 6B 커밋들이 CHECK 12 규칙·기준치와 레지스트리 RO-02를 같은 커밋에서 옮겼으므로 되돌리면 함께 돌아온다.
  CHECK 12 후속(`cc03ecd8`, `acc2e755`)만 남기고 6B-2를 되돌리면 파사드 쓰기 규칙이 바탕 트리처럼 실패하므로(위 '정확한 개수 가드') 후속도
  함께 되돌린다. 6B-2를 되돌리면 T0b 파일 11개의 이음새도 지운 모듈을 가리키던 바탕 모양으로 돌아간다(T0b가 main에 있으면 그 상태로).

## 머지 전에 할 일 (릴리스 담당)

1. **seed 7 순서 의존 고침(시험만, T0b 파일 하나):** `src/youtube/__tests__/stale-async-guards.test.ts`의 'zero-start iframe projection
   barrier' 묶음 두 행('projects the real release PLAYING once without emitting a second legacy release', 'keeps the legacy UI heartbeat
   and auto-advance loop inert while in-flight')이 `--sequence.shuffle` seed 7에서 실패한다. 원인: 이 파일은 `player.ts`를 행 안에서만
   늦게 가져오므로(정적 import 없음, 동적 import 49곳), 그 묶음이 `player.ts`를 가져온 행보다 먼저 돌면 장부에 claim이 없어 `iframe.ts`의
   보조 상태 억제(`isYouTubeStartRoomStateHeld`)와 UI 루프 문(`isYouTubeStartArmBusy`)이 mock한 zero-start 파사드를 묻지 않고 거짓으로
   답한다. 6B-2 앞에서는 `iframe.ts`가 그 파사드를 바로 읽어 순서와 무관했다. 그 묶음만 돌리면(`-t 'zero-start iframe projection barrier'`,
   9행) 브랜치 끝에서 같은 두 행이 실패하고 바탕에서는 9 / 9 통과한다. seed 7 단일 파일은 `9e72b7ce`와 `5300f565`에서 182 / 182, `4d3ba199`와
   `07a9f224`에서 2 실패다. 운영에는 영향이 없다: `src/app.ts:118`이 `player.ts`를 정적으로 가져와 시작 때 모듈 평가로 claim이 등록되고, 그
   앞에는 실행을 만드는 컨트롤러도 없어 옛 파사드도 거짓이었다. 권장 고침은 6B-2가 다른 이음새에 한 것과 같다: 그 파일의 `beforeEach`에서
   mock한 파사드에 답하는 `standard-run` claim(과 필요한 다른 claim)을 등록하거나 파일 첫머리에서 `player.ts`를 한 번 가져온다. 기대 배열과
   도달 단언(`isYouTubeZeroStartProtocolActive`·`isYouTubeZeroStartInFlight`가 불렸음)은 그대로 두고, 고친 뒤 seed 7, 31, 4242, 20261030과
   파일 순서, 위 `-t` 실행을 다시 돌린다. 버전 올리기 앞의 시험만 커밋이고 T0b 파일을 고친다.
2. T0b 시험만 PR 둘이 main에 들어온 뒤 이 갈래를 그 위로 옮기고(받아들임이 T0b 파일을 바꿨으면 위 'T0b 파일'대로 맞춤), 테스트 먼저 커밋을
   옮긴 부모에서 다시 돌려 같은 이름의 행만 실패하는지 본다.
3. 오너 답 '오너에게' 1(T0b 결함 넷째)을 확인한다. 예면 버전 올리기 앞에 의도 증분을 테스트 먼저부터 더하고(H10, H10a, H10c 행을 뒤집는
   실패 시험, 보고서 자기 절, 되돌리기 메모), 이 열차의 이름표가 '중립 + 마지막 의도 증분 하나'가 된다.

## 배포 조건과 순서 (릴리스 담당)

1. 위 '머지 전에 할 일' 1 ~ 3.
2. 한 번에 한 열차, main 런타임이 배포본과 같을 때만: 지금 main `9c078f5c`의 App 런타임은 운영 9.0.30(`3c098e9d`)과 같다. main이 다시
   움직이면 그 위로 옮기고 같은 재확인과 크기 측정을 한다. 이 배포까지 런타임 의존성 변경(Dependabot 포함)을 머지하지 않는다.
3. 버전 올리기 커밋(마지막 런타임 커밋, 계획 6B-3): 9.0.30 / v803 → 9.0.31 / v804(예상)를 9.0.30의 버전 올리기 `8d148fff`와 같은 거울 여섯
   파일 일곱 줄에 적는다(`package.json`, `package-lock.json` 두 곳, `ADMIN_SCRIPT_VERSION`, `ADMIN_ASSET_VERSION`,
   `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 캐시 쿼리). 그 뒤 `guard:sw-cache-version` PASS, `guard:release-identity` 새 버전,
   `build:checked` 전체. 계약 동결: 바탕 main..머리의 `cloudflare/` 차이가 `cloudflare/app-worker.ts`의 버전 한 줄뿐인지 본다.
4. 문서(계획 6B-3, RT-04, RT-15, §4.2-7): release-record §2에 이 열차의 '배포 전' 항목(이 보고서 링크, 오너 답, 배포 조건, 되돌리기, 배포 뒤
   확인)과 닿는 열린 항목의 연결. 레지스트리 RO-02의 장부·독자 문장, 설계 문서, QA053 링크는 이미 이 브랜치에 있다. known-accepted #14의
   확인 문장은 그대로다. 기기 근거 없이 열린 항목을 지우지 않는다.
5. PR CI, 자동 코드 리뷰, dispatch 직전 머지, exact-main CI success 뒤 Release target `app`, Developer API D1 false,
   `raise_app_build_floor` false. 기록 PR을 열차 PR 머지와 deploy job 시작 사이에 머지하지 않는다.
6. 배포 직후(게이트 아님): 공개 최소 빌드 상태와 Operations Drift Audit, 아래 '배포 뒤 확인'. 머지 뒤 main SHA에서 Full E2E를 한 번 돌려
   보고서의 QA 라운드에 적되 exact-main 후보로 쓰지 않는다(계획 §4.2-5).
7. 배포 기록 PR: release-record §1과 `Last source review` 덮어쓰기, `docs/release-history.md` 한 행, §2의 이 항목을 '배포 뒤 확인'으로.

## 배포 뒤 확인 (블라인드, 게이트 아님)

계획 §4.7의 기기 후보(QA053, QA054, 절차는 영역 조사 pro-and-iframe-audio §4.5)다. 확인하는 사람에게는 '절차'만 주고 기준은 주지 않으며,
받은 관찰값을 여기 기준과 견준다. Phase 6 앞의 기준선(Q6)은 재지 않았다. 옛·새 빌드를 섞어 시작하는 기기 행은 두지 않는다(혼합 버전
근거는 T0a 프레임·시각 골든, P5-D9 C, 계획 §4.7). 기기가 없는 단계는 건너뛰고 '기기 없음'으로 적는다.

**절차(확인하는 사람에게 주는 것, 약 25분):** 두 기기 모두 같은 앱 버전(앱 정보의 버전 번호를 적음)이고 주소 끝에 `?mxqrLog=debug`를 붙여
연다. 새로 고치거나 다시 들어갈 때도 다시 붙인다. 각 단계 뒤 채팅에 `/debug console`을 입력하고 `[YouTube`로 시작하는 줄을 시각과 함께
복사한다.

- **A. 시작 직후 동기화(약 10분):** (1) 데스크톱 Chrome을 방장으로 일반방을 만들고 Android Chrome을 게스트로 넣는다. 재생목록에 YouTube
  두 곡을 넣고 볼륨은 둘 다 50. (2) 방장이 첫 곡을 누른다. 게스트에서 소리가 난 직후(1 ~ 2초 안) 게스트가 동기화 버튼을 한 번 누르고, 뜬
  안내 문구를 그대로 적는다. 버튼이 흐린 모양이었는지도 적는다. (3) 5초 뒤 다시 한 번 누르고 무슨 일이 있었는지(소리 끊김, 위치 이동,
  안내) 적는다. (4) 다음 곡으로 (2) ~ (3)을 한 번 더 한다.
- **B. 시작 소유 줄(약 10분):** A의 각 시작에서 방장의 `[YouTube ZeroStart] prepare-host`, `armed-guest`, `Playback released` 줄과 게스트의
  `waiting-ready`, `timeline-0.8s`, `timeline-2.0s` 줄(값 `timelineDriftMs`, `estimatedAudibleErrorMs` 포함)을 복사한다. 시작이 들리는
  순간에 두 기기의 소리가 맞았는지(맞음, 조금 어긋남, 많이 어긋남) 적는다.
- **C. 시작 직후 seek와 볼륨(약 5분):** 방장이 곡을 시작하고 소리가 난 직후 1초 안에 재생 위치 막대를 곡 중간으로 옮긴다. 게스트가 따라오는지,
  끊김이 있었는지 적는다. 이어 방장이 다음 곡을 누르고 소리가 나기 전에 게스트가 볼륨을 0으로 내렸다가 2초 뒤 50으로 올린다. 예열 소리가
  샜는지, 소리가 돌아왔는지 적는다.

**통과 기준(주지 않음):**

- A: 첫 누름은 보정 창(시작 뒤 약 2.75초) 안이면 흐린 버튼과 '아직 준비 중이에요' 안내, 그 직후면 '방장의 재생 정보가 없어요' 안내가 뜰 수 있고
  저절로 다시 시도하지 않는다(known-accepted #14, 오늘과 같음). 둘째 누름은 보통 진행한다. 누르지 않았는데 소리가 튀지 않는다.
- B: 방장에 `prepare-host`, `armed-guest`, `Playback released`가 있고 게스트에 `timeline-0.8s`와 `timeline-2.0s`가 있으면 zero-start로
  풀린 것이다. 어느 기기에도 `[YouTube ZeroStart] audio-restore-timeout` 경고가 없다. `Falling back to legacy rendezvous`는 실패로 보지 않고
  적는다(느린 망에서 레거시가 이어받은 경우). 소리는 귀로 맞는다.
- C: 방장의 seek는 게스트에 전해져 게스트가 몇 초 안에 새 위치로 따라온다(오늘 동작). seek가 무시되거나 방이 멈추면 실패다. 볼륨을 바꾸는
  동안과 곡이 시작되기 전에 예열 소리가 새지 않고, 곡이 시작되면 마지막 설정(50)으로 들린다(hard-mute 주인이 있는 동안의 unMute 가드가 장부
  질의로 옮겼으므로 보는 단계).

**실패하면:** 일시적 네트워크로 설명되지 않는 어긋남이면 위 '되돌리기'대로 앞으로 고치기나, 급할 때만 명시적으로 검토한 CLI 되돌리기로
checkpoint App(9.0.30)을 정한다. '기기 없음'과 '미확인'은 실패가 아니다.

## 사용자가 알아챌 변화

없다. 버전 올리기와 함께 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 둘째, 창 모양은 지금 그대로). 처음 받는 코드는 gzip 기준 JS 53 B, 전체 54 B
줄어든다(운영 9.0.30과 런타임이 같은 바탕 대비, 버전 올리기 앞, 위 '번들 크기').

## 기록과 레지스트리

- 이 브랜치: 설계 문서 `docs/design/youtube-start-ownership.md`(Accepted, 6B-1, 6B-2와 후속에서 고침)와 `docs/README.md` 설계 목록, QA053,
  레지스트리 RO-02(장부, 허용 요청자가 장부 질의, CHECK 12 절)와 가드 항목 12, '아직 검사 안 함', 핵심 커버리지 등재, 이 보고서와
  `docs/README.md` 증거 목록. 모두 센 코드나 규칙을 옮긴 커밋과 같은 커밋이다(이 보고서만 기록 커밋).
- RO-05, RO-48은 그대로다(위 'D4 다시 재기'). RO-02의 상태는 `duplicated` 그대로다(레거시 복구와 교체 대체가 아직 주인 단계가 아님, 6C ·
  6D). 레지스트리 머리의 `Last source review`는 기록을 코드와 다시 맞추는 PR이 고친다.
- 릴리스 담당이 버전 올리기와 함께: release-record §2의 6B 항목, 그리고 배포 뒤 기록 PR(위 '배포 조건과 순서' 4, 7).

## 오너에게

1. **[화면 바뀜: 예일 때만, 참가자 YouTube 화면이 같은 자리로 다시 맞추는 횟수가 두 번에서 한 번으로] 방장 일시정지 신호가 두 번 가는
   경우를 6B에서 고칠까요?** 2026-11-01에 따로 여쭌 결함 넷 가운데 넷째예요. 일반방 방장이 YouTube 곡을 불러온 뒤의 첫 일시정지나 버퍼링 뒤의
   일시정지에서, 참가자 기기가 이미 멈춘 화면을 같은 자리로 한 번 더 맞춰요. 멈추는 때와 자리는 같아요. 이번 6B는 화면·소리를 바꾸지
   않는 정리만 담았고 이 고침은 넣지 않았어요(답을 아직 못 받음).
   - (가, 권장) 6B의 마지막 단계로 고친다: 업데이트 창은 늘지 않고, 6B를 되돌리면 이 고침도 함께 되돌아가요. 만들기 전에 짧은 화면 녹화나
     전후 시각 표를 먼저 보여 드려요.
   - (나) 지금은 기록만 하고 나중에 따로 낸다: 6B는 지금 그대로 나가요. 따로 낼 때 업데이트 창이 한 번 더 떠요.
2. **[화면 그대로] 첫 로딩 크기: 정하실 것은 없어요.** 6B는 앱을 처음 열 때 받는 양을 압축 기준 53바이트 줄여요. Phase 6 전체로는 6A와
   합쳐 202바이트 줄었고, 상한(늘어남 200바이트)과 멀어요.
3. **[화면 그대로] 6B를 언제 낼지: 권장은 '앞서 준비한 시험만 변경 둘이 들어가고, 자동 시험 하나가 순서에 따라 실패하는 문제를 시험만
   고쳐 1번 답과 함께 반영한 뒤, 자동 관문을 모두 통과하면 9.0.31로 낸다'예요.** 화면과 소리는 그대로이고 업데이트 창만 한 번 떠요(Phase 6
   넷 가운데 둘째). 자리를 비우신 동안 맡기신 대로 릴리스 담당이 정해요. 6B에 문제가 있어 되돌리면 9.0.30(6A)의 앱으로 돌아가요.

## QA 라운드

### 1. 증분별: 테스트 먼저 다시 돌림

2026-11-01 16:01 ~ 16:15 KST, Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, `--maxWorkers=4`. 바탕 `9e72b7ce`에서 만든 임시
detached worktree(이 갈래 worktree의 `node_modules`를 연결, 같은 툴체인)에서 커밋마다 detached로 바꿔 돌렸고, 끝난 뒤 그 worktree는
깨끗했다. 같은 때 같은 PC에서 아래 라운드 2의 shuffle과 typecheck·lint가 함께 돌았다.

- `a686284a` 17 / 1,809 실패(장부 17, 등가 시험 불러오기 실패) → `5300f565` 1,819 / 1,819. 둘 다 32 files(새 둘과 중립 고정 30).
- `44a85664` 27 / 2,068 실패(장부 17, 가드 10) → `4d3ba199` 2,068 / 2,068. 둘 다 36 files(새 둘, 중립 고정 30, 이음새 넷).
- `cc03ecd8` 12 / 91 실패 → `acc2e755` 91 / 91.
- `b1db3cc7` 5 / 5, 바탕 `9e72b7ce`에 그 파일만 넣어 5 / 5(돌린 뒤 지움).
- 중립 고정 30 파일: T0b 참값표 둘(37, 12), T0a 골든과 고정(`standard-start-wire-golden` 16, `pro-ready-timing-golden` 10,
  `youtube-start-owner-boundary` 24, `youtube-audio-restore-cadence` 58, `youtube-quoted-log-lines` 13, `youtube-room-switch-trace` 6,
  `youtube-timer-owner-queries` 49, `youtube-owner-visibility` 8, `standard-start-pause-teardown` 14, `start-timing-parity` 10,
  `pro-start-kind-endpoint` 6, `pro-late-prepare-reload` 7, `playback-late-cohort-join` 8), D4 셋(`local-output-realign-cross-flow` 25,
  `background-return-sync` 38, `local-output-rejoin` 164), 9.0.8 시험이 있는 `player.test.ts`와 `sync-integration.test.ts`, 그 밖
  `zero-start`, `zero-start-fallback-ownership`, `zero-start-heartbeat-ownership`, `stale-async-guards`, `load-lifecycle`, `authority-arm`,
  `player-controls`, `seekbar`, `network/sync`, `protocol`. 네 부모와 네 코드 커밋에서 모두 통과했다.
- 변이 확인(`07a9f224`, 임시 worktree에서 파일을 바꿔 돌리고 되돌림, 되돌린 뒤 깨끗함): 위 6B-2와 '독자 창 고정'의 결과.

### 2. 마지막 검사 (브랜치 끝 `07a9f224`)

2026-11-01 15:46 ~ 16:40 KST, 같은 환경(vite 8.3.3, TypeScript 6.0.3, ESLint 10.12.0, Prettier 3.9.9, Playwright 1.63.0 Chromium), 이 갈래의
worktree에서. 다른 worktree의 시험이 같은 PC에서 15:45 무렵과 16:17 무렵 몇 분씩 함께 돌았다. 앞뒤로 작업 트리는 깨끗했다.

- **단위 전체(파일 순서):** 739 files, 17,651 통과, 1 건너뜀, 실패 0(590 s). 건너뛴 하나는 jq가 없는 PC에서 건너뛰는 기존 행
  (`release-deployment-state.test.ts`의 'classifies the exact coherent commit marker only from a complete GitHub inventory')이다. git fixture
  행의 시간 초과는 없었다. 9.0.8 방장 스피커 시험('publishes the host speaker after a zero-start for …' 15 / 15, 늦은 미디어 시작 12 / 12),
  'host Sync and guest Sync parity' 1 / 1, 장부 34 / 34, 독자 창 5 / 5.
- **shuffle(`src/youtube`, `src/player`, `src/pro-room`, seed마다 한 번):** 239 files, 6,469행. seed 31, 4242, 20261030은 실패 0이다. **seed 7은
  `stale-async-guards.test.ts`의 두 행이 실패했다**(위 '머지 전에 할 일' 1). 그 파일 하나를 같은 seed로 돌려 같은 두 행이 실패함을 다시 봤고,
  임시 worktree에서 바탕 `9e72b7ce`와 `5300f565`는 182 / 182, `4d3ba199`와 `07a9f224`는 같은 두 행 실패였다. 바탕에는 없는 6B-2의 순서
  의존이다.
- **`npm run typecheck`**(전체 사슬, 139 s), **`npm run lint`**(app과 tooling, 249 s), **`npm run format:check`**(92 s): 모두 종료 코드 0.
- **`build:checked`의 25 단계를 하나씩:** `guard:sw-cache-version` 하나만 실패했다(위 'Version'의 글 그대로, App 11 파일). 버전을 올리지
  않았다는 것 말고는 이유가 없다. 나머지 24 단계는 통과했다: authored JS 둘(0 remaining, 107 retired; 0 inline), TypeScript project coverage
  1,563 files / 19 projects, classic runtime 15, auxiliary browser 2, service worker(v803), UI kit 10, release identity 'MUSIXQUARE 9.0.30;
  service-worker cache epoch v803', brand capitalization 1,034, declaration ownership 10, source complexity, room authority(79 / 22 / 13 / 0 / 0,
  410 files), profanity, hreflang 43, sitemap 93, `npm run build`, legacy TV(Chromium 79, `main-jdcp8EDh.js`), service worker build(v803, 바이트
  동일), UI kit build, initial transfer budget, prod hooks, prod security, 글꼴(Inter와 Noto, 44 stacks), SW 앱 셸 96 assets.
- **그 밖 `guard:*` 13개도 모두 통과**(`package.json`의 `guard:*` 37개 가운데 실패는 위 하나): bus-pairing 202 / 202, chunk-pump,
  transport-health(12 files), import-graph(410 files, 2,101 edges, 순환 0), lifecycle-writes, navigation-sinks, dead-exports(410 / 2,161 / 0 /
  20 / 76), font assets, standard-room hot path, Developer API boundaries, D1 migrations(19), ops drift contract, Playwright API.
- **`node scripts/check-resource-ownership.mts`와 `--report`:** 위 '정확한 개수 가드'(49 records, 457 production files, `--report` 119줄).
- **크기:** 위 '번들 크기'.
- **`npm run test:coverage:critical`:** 99 files / 4,022 통과, 전체 84.09 / 79.45 / 89.95 / 87.79(문턱 73 / 66 / 80 / 78), 파일별 문턱 오류
  없음(64 s). 6B-1이 등재한 장부는 lcov로 함수 20 / 20, 줄 18 / 18, 분기 3 / 3(문턱 99), `zero-start.ts`는 85.56 / 84.05 / 97.6 / 89.28(문턱
  84 / 83 / 96 / 88), `iframe-audio.ts`는 함수 7 / 7, 줄 24 / 24, 분기 19 / 19다.
- **`npm run test:coverage:workers`:** 69 files / 3,325 통과, 86.7 / 83.54 / 94.34 / 90.97(140 s).
- **`npm run build:e2e` 뒤 로컬 Playwright(Chromium, 포트 4693 / 9693):** `test:e2e:critical`의 여덟 파일 101 / 101(5.9분), YouTube spec 열 개
  (`e2e/youtube*.test.ts`) 53 / 53(12.7분). 그 가운데 계획 §4.2-3의 여덟(`youtube-sync` 6, `youtube-manual-zero-start` 10, `youtube-output-delay`
  3, `youtube-end-transition` 6, `youtube-native-operator` 2, `youtube-manual-repeat` 1, `youtube-pending-seek` 4, `youtube` 9)은 41 / 41로 6A의
  41과 같고, 나머지 둘(`youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8)은 12 / 12다. 실패, 다시 시도, 불안정 표시는 없다.
- **배포 대상과 계약 동결:** 위 'Deploy target'.

## 하지 않은 것과 확인하지 않은 것

- **버전 올리기, release-record 항목, PR, 머지, 배포:** 릴리스 담당의 몫이라 하지 않았다(위 '배포 조건과 순서'). GitHub에 닿지 않았다.
- **seed 7 고침:** 이 검사는 보고서와 PR 초안만 고칠 수 있어 고치지 않았다(위 '머지 전에 할 일' 1).
- **T0b 결함 넷째의 고침:** 오너 답 전이라 싣지 않았다(위 '오너에게' 1). 화면에 닿는 고침([화면 바뀜])은 묻지 않고 싣지 않는다.
- 실기기, iOS Safari, WebKit 레인(`setup-youtube-activation.test.ts` 포함, 계획 §4.2-4는 `iframe.ts`의 prime·활성화 경로를 건드린 6C·6D에만
  요구), 블루투스, 6B 런타임의 Full E2E와 CI. 기기 확인은 배포 뒤 블라인드로 하며 게이트가 아니다. Phase 6 앞의 기기 기준선(Q6)은 재지
  않았다.
- `check:workers`와 Worker 묶음 dry-run: `cloudflare/` 차이가 0이라 따로 돌리지 않았다. Worker의 타입 검사(`typecheck:workers`,
  `types:workers:check`)는 `npm run typecheck` 사슬 안에서 돌았고 Worker 단위 커버리지도 돌렸다.
- 가를 행이 없는 독자: 늦춘 랑데부 단계의 확인(`matchesRendezvousOccurrence`)과 작은 drift 표본의 timeline 보류(위 '독자 창 고정'), 그리고
  복구의 출시 확인 창(pending이지만 active가 아님)에서 `isYouTubeStartSyncOwned` 독자가 `isYouTubeStartArmBusy`와 갈리는 곳은 자기 독자
  행이 없다(설계 문서 'Not covered yet').
- CHECK 12가 보지 않는 것: 문장 사이에 변수나 지역 도우미로 엮은 claim(`sync.ts`의 작은 drift 표본이 timeline 보류를 `isCurrentStateAction`,
  `isGuestYouTubeTransitionPending` 옆에서 물음), 주인의 인스턴스에 부른 claim 질의(PRO arm의 `ownsHardMute()`), 세는 스냅샷 읽기가 무엇을
  끌어내는지, `src/youtube/` 밖의 풀리지 않는 타이머 이름. 리뷰로 본다.
- T0a 시험 `youtube-start-owner-boundary.test.ts`의 머리 주석(21 ~ 23줄)이 지운 합성과 다리 훅 이름을 아직 적는다. 표본은 시작 하네스를
  거쳐 장부를 읽으므로 동작과 행은 맞다. 주석만이라 다음 시험만 커밋에서 고친다.
- 참값표가 오늘 동작으로 고정한 틈(H4, H9·H3·H5·H6, H10, G8, P4)은 장부가 답을 바꾸지 않아 그대로다(설계 문서 'Not covered yet', T0b 결함 질문).
- 영역 조사의 대략적 기기 시간(약 25분)은 추정이다.
