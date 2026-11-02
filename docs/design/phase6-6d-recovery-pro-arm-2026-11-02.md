# Phase 6 6D: YouTube 시작 복구와 PRO 시작 토큰 (2026-11-02)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 준비됨, 배포 전. Phase 6의 넷째이자 마지막 App 열차다. 브랜치 `agent/p6-6d`(바탕 `bdb5759a` 위 커밋 열셋: 계획 6D-1 ~ 6D-4의 테스트 먼저·코드 커밋 여덟, 6D-5의 기록 커밋 둘(레지스트리·설계 문서 `a9ee6842`와 이 보고서 `cb2279ba`), 리뷰를 반영한 시험 커밋 `6e3bd6f5`와 주석·기록 고침 커밋 `5267e8b2`, 리뷰 뒤 마지막 검사를 적은 기록 커밋 하나). 계획의 6D-6(오너가 Q22 (가)로 고치기로 한, 늦게 합류하는 PRO 기기의 안내 두 번과 YouTube 화면 다시 만들기)은 만들지 않았다: 오너 답이 '만들기 전에 사진 먼저'라서 계획, 뒤집을 행, 양쪽에서 통과할 회귀 행만 준비했다(아래 '6D-6: 준비함, 만들지 않음, 오너를 기다림'). 6D-5는 버전 올리기 없이 기록과 가드 자체 시험만 한다. `a9ee6842`의 마지막 로컬 검사는 버전 올리기를 기다리는 `guard:sw-cache-version` 말고 모두 통과했다(QA 라운드 2). 리뷰 반영(시험 행 여섯, 주석 하나, 기록 고침)은 런타임 바이트를 바꾸지 않고, 닿는 검사를 다시 돌렸다(QA 라운드 3). 리뷰 뒤 끝 `5267e8b2`(그 뒤는 마지막 기록 커밋뿐)에서 마지막 검사 전체를 다시 돌려 같은 결과를 얻었다: `guard:sw-cache-version`만 같은 이유로 실패한다(QA 라운드 4). T0b가 찾은 결함 넷의 고침은 오너 답이 없어 싣지 않았다(결함 1과 2는 이 열차의 마지막 단계를 권했다). 6D-6(오너가 사진을 본 뒤), 버전 올리기, release-record §2의 이 열차 항목과 열린 항목 연결, PR, 머지, 배포는 릴리스 담당이 한다. 로컬과 브랜치 결과는 exact-main-SHA 후보를 대신하지 않는다 |
| Base               | `bdb5759a` = 6C 갈래 `agent/p6-6c`의 끝(그 [보고서](phase6-6c-router-iframe-audio-arm-steps-2026-11-02.md)의 기록 커밋). 그 App 런타임은 6C의 브랜치 끝 `6915ee9e`과 같다. 6C는 6B의 끝 `89e0b682` 위에, 6B는 main `dda3ee18` 위에 쌓였고 둘 다 아직 main에 없다. 6B와 6C가 차례로 나간 뒤 6D가 나가므로, 이 갈래는 그 main 위로 옮겨 다시 확인한다(아래 '머지 전에 할 일' 1). 같은 툴체인으로 만든 바탕 빌드의 진입 청크와 eager 바이트는 6C 보고서의 끝 값과 같다(`main-BDpc0SkS.js`, 859,737 B, eager JS gzip 465,439 B, 아래 '번들 크기')                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Version            | 없음. 9.0.30 / v803 그대로다(`guard:release-identity` 'MUSIXQUARE 9.0.30; service-worker cache epoch v803'). App 런타임 경로가 바뀌므로 다음 App 패치와 SW epoch를 함께 올려야 하고, 그 전에는 `guard:sw-cache-version`이 그 이유 하나로 실패한다: '[sw-cache-version] FAIL: committed PWA runtime changes are newer than v803 (3c098e9d).'와 App 18 파일(6B의 11, 6C가 더한 다섯, 6D가 더한 `src/youtube/constants.ts`와 `zero-start-recovery.ts`), 'Bump CACHE_VERSION in scripts/service-worker-asset.ts after these changes, then commit the bump.'(QA 라운드 2와 4). 6B와 6C가 먼저 나가고 6D는 그 뒤에 나가며, 번호는 릴리스 담당이 정한다. 올리면 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 넷째이자 마지막, 창 모양은 지금 그대로). 바닥(저장·유효 795)은 바꾸지 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Scope              | 계획 §4.9의 6D-1(C2-9, PA-09, SS-11), 6D-2(C2-11, PA-10), 6D-3(C2-12, SS-08), 6D-4(C2-13, PA-11, PA-01), 모두 중립, 그리고 6D-5(RT-09, RT-11: 기록과 가드 자체 시험, 버전 올리기 없음). 6D-1: Standard 게스트의 로컬 복구가 `player.ts`의 클로저에서 새 `src/youtube/zero-start-recovery.ts`의 클래스 `GuestZeroStartRecovery`가 되고, 두 복구의 0.35 s·50 ms·3 s가 `src/youtube/constants.ts`의 이름 셋이 된다. 6D-2: Standard 방장의 레거시 복구가 같은 파일의 단계 `HostZeroStartRecovery`가 된다. 6D-3: Standard 방장이 음수 오프셋으로 시작할 때 스피커를 잡아 두는 로컬 시작 대기가 `player.ts` 안의 원시 하나가 된다. 6D-4: PRO arm의 시작 종류가 PRO 재생의 합집합 타입 하나가 되고, PRO 시작 토큰 넷이 따로 이름 붙고 고정된다. 6D-5: 레지스트리 RO-02·RO-03·RO-12를 Phase 6 끝 상태로 적고(셋 다 `duplicated`), 계획 §4.10의 끝 조건을 코드와 대조한다. 와이어, 서버, 저장 모양, 계약 표지, 의존성, 타이머 이름, 로그 줄, 준비 이벤트, 화면, 소리는 바꾸지 않는다([화면 그대로]). 6D-6은 사진 계획과 행만 있다                                                                                                                                                                                                                                                                                                                                                                      |
| Deploy target      | `app`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`로 바탕 `bdb5759a`와 리뷰 뒤 끝 `5267e8b2`를 견준 로컬 git 판정(QA 라운드 4, `a9ee6842`에서도 같음): App 10(`src/youtube/`의 `authority-arm.ts`, `constants.ts`, `iframe-audio.ts`, `iframe.ts`, `local-offset.ts`, `player-runtime-bridge.ts`, `player.ts`, `start-ownership.ts`, `zero-start-recovery.ts`, `zero-start.ts`), PRO room 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음. 운영 App 9.0.30 `3c098e9d` 대비로는 6B·6C와 합쳐 App 18, 나머지 Worker 0, 의존성 차이 없음이다. 운영을 조회하지 않은 판정이라 릴리스의 부분 릴리스 검사를 대신하지 않는다. `raise_app_build_floor` false, Developer API D1 false(계획 RT-01). 계약 동결: `git diff --stat bdb5759a..5267e8b2 -- cloudflare/ src/network/protocol.ts src/core/constants.ts src/types/index.ts package.json package-lock.json index.html scripts/service-worker-asset.ts browser/ docs/release-record.md docs/release-history.md`가 비어 있다(6B의 바탕 `dda3ee18`부터도 비어 있음)                                                                                                                                                                                                                                                |
| Operations         | 운영에 닿지 않았다(로컬 git, 로컬 시험·빌드·Playwright만). GitHub 쓰기, push, 배포, 운영 요청은 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Resource ownership | 새 레코드 없음. 두 복구는 RO-02의 주인이고(게스트 복구는 예외 RO-33 그대로), 로컬 시작 대기는 RO-02, PRO 토큰은 RO-03이다. 센 코드를 옮긴 커밋이 같은 커밋에서 레지스트리와 기준치를 고쳤다: CHECK 11 20 그대로(`player.ts` 4 → 2(6D-1 `dc596f8d`) → 1(6D-2 `f6d7c1e1`), 새 항목 `zero-start-recovery.ts` 2 → 3), CHECK 5의 YouTube 시작 계약 파일에 `zero-start-recovery.ts`(수 1 / 1 / 45 그대로), CHECK 12 읽기 11·지우기 9, 파사드 쓰기 2, 실행 스냅샷 읽기 8(이유 문장만 바뀜), 장부 합성 1, 시작 타이머 설정 파일 그대로. `node scripts/check-resource-ownership.mts`: 49 records, 458 → 459 production files. 6D-5가 RO-02, RO-03, RO-12를 Phase 6 끝 상태로 적었다: 셋 다 독립 기계가 남아 `duplicated` 그대로다(아래 '6D-5')                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

이 문서는 Phase 6 계획의 넷째이자 마지막 App 열차 6D의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의
Phase 6 계획(2026-10-30)과 그 영역 조사, 오너 답(2026-10-30)이고, SS, PA, RT, C2 번호, Q 번호와 D 번호(이 열차의 구현 계획이 정한
엔지니어링 결정 D1 ~ D9)는 그 노트의 번호다. 계획의 줄 번호는 `78ec56f5` 기준이라 6A ~ 6C가 옮긴 위치를 모두 기호로 다시 찾았고, 이
문서의 줄 번호는 `a9ee6842`의 것이고 브랜치 끝 `5267e8b2`에서도 같다(`src` 런타임은 6D-4의 `051a0727`과 `player.ts`의 주석 두 줄만 다르고
줄 수가 같다). 앞선 Phase 6 단계는 시험만인 T0a(#539, #541, #542), 가드만인
T1(#543), 첫 App 열차 6A(#550, 9.0.30 / v803, [보고서](phase6-6a-start-constants-owner-queries-2026-10-31.md)), 시험만인
T0b(#552, #553), 둘째 App 열차 6B([보고서](phase6-6b-start-ledger-readers-2026-11-01.md), 배포 전), 셋째 App 열차 6C(이 갈래의 바탕, 배포 전,
[보고서](phase6-6c-router-iframe-audio-arm-steps-2026-11-02.md))다. 이 보고서에서 '중립'은 T0a의 골든과 고정 행, T0b 참값표의 모든
칸(U·P 행과 비동기 전달 변형 포함), 6B와 6C의 행이 바이트 그대로 통과하고, 와이어가 바뀌지 않고, 같은 프레임이 같은 시각에 나가며,
T0a PRO READY 시각 골든과 PRO 늦은 합류 고정 행이 초록이고, 관리 타이머 다섯(`'yt-zero-start-external-fallback'`,
`'yt-zero-start-host-fallback'`, `'yt-zero-start-replacement-fallback'`, `'yt-host-local-start'`, `'yt-auto-sync'`)이 이름 그대로
`player.ts`가 거는 관리 타이머로 남는다(복구 클래스에는 그 스케줄러를 넘긴다)는 뜻이다. 앞 단계 시험 파일을 바꾼 곳은 아래 'T0a·T0b·6B·6C
파일'에 따로 적는다.

## 오너 결정 (2026-10-30, 모두 권장)

- **Q1 넷:** Phase 6을 App 업데이트 넷(6A ~ 6D)으로 낸다. 6D는 넷째이자 마지막이고, 업데이트 창은 버전 올리기와 함께 한 번 뜬다.
- **Q22 (가)는 4차 업데이트에서 고침, 만들기 전 사진 먼저:** 늦게 합류하는 PRO 기기의 COMMIT 따라잡기가 'YouTube 함께보기' 안내를 두 번
  띄우고 불러오던 YouTube 화면을 지웠다 다시 만드는 것을 이 열차의 마지막 런타임 증분(6D-6)으로 고치기로 했다. 그래서 이 갈래는 6D-6을
  만들지 않고 계획과 행만 준비했다(아래 '6D-6'). 그때까지 PRO 늦은 합류 고정 행(#539, `pro-late-prepare-reload.test.ts`,
  `playback-late-cohort-join.test.ts`)은 오늘 동작 그대로 초록이고 6D에서도 그대로다. (나) ~ (라)는 기록만이다.
- **Q3 박자는 각자 그대로:** 두 복구가 출시 전에 소리를 되돌리는 셋째 박자(명령 → 확인 → 50 ms 폴, 게스트는 max(기한, 지금 + 1 s)까지)에
  이름 `YOUTUBE_RECOVERY_POLL_MS`를 주고(6D-1, RO-12) 검증 복원 `restoreYouTubeAudioVerified`에 접지 않았다. 폴마다 복구의 영상 확인과
  정착 확인을 다시 하므로 접으면 확인 순서가 바뀐다.
- **Q4 시작 시간 값은 1차 업데이트의 집으로:** 6A-3이 `src/youtube/constants.ts`를 시작 시간 값의 집으로 만들었고, 복구만 쓰던 0.35 s 정착
  허용치, 50 ms 폴, 3 s 다리는 '복구를 옮길 때까지 그 파일의 글자'로 남았다가 복구가 `player.ts`를 떠난 6D-1에서 그 집의 이름 셋이 됐다
  (계획 D2). 게스트의 출시 소리 최소 1,000 ms와 교체 대체의 1,500 ms는 쓰는 파일이 하나라 그 자리에 둔다.
- **Q18 결함마다 묻기:** 시험이 결함을 재현하면 오늘 동작으로 고정하고 결함마다 따로 묻는다. 6D의 새 행은 오늘 동작을 고정했고, 새로
  드러난 것은 하나다: 방장 레거시 복구가 방에 없던 영상을 0:00으로 옮겼는데 그 자리가 0.35초 넘게 어긋나면 다시 옮기지 않고 3초 다리가
  끝날 때까지 기다린다(6D-2 단위 행, 아래 '오너에게' 2, [화면 바뀜: 고치기로 하실 때만, 그 경우 그 시작이 0:00에서 멈추지 않고 이어짐],
  기록만 권함). T0b가 찾아 2026-11-01에 따로 여쭌 결함 넷은 답이 없어 싣지 않았다.
- **Q2(6C-3)는 6C의 것:** 0.5 % 아래 음소거 규칙 하나는 6C의 마지막 증분이고, 6D는 두 규칙을 바꾸지 않는다(6D-4가 PRO arm의 오디오 읽기를
  바꾸지 않은 이유 가운데 하나다).
- **엔지니어링 기본값(계획 §9.3, §9.4, 권장대로):** 이 열차가 기댄 것은 Q10·Q24(CHECK 11·12는 resource-ownership 가드 안에서 정확 개수),
  Q11(새 시험 전용 export 없음, `guard:dead-exports` 시험 전용 20 그대로), Q13(복구의 정착 기준 0.35 s·한 표본·50 ms 폴을 무장 단계의
  settle 0.12 s·두 표본·80 ms와 따로 둠), Q26(새 모듈 `zero-start-recovery.ts`: 소비자는 `player.ts` 하나지만 자기 세대, 타이머 포트, 기한,
  복원을 가진 '독립 상태와 시작·정지·복구 수명'), Q28(의존성 변경 없음), Q29(번들 상한을 넘으면 잰 숫자로 묻는다: 해당 없음, 아래 '번들
  크기')다. 계획이 이미 정한 C2-10 버림(RO-33)과 C2-13 지연 어댑터 버림(RO-34)도 그대로다.
- **이 열차의 엔지니어링 결정(D1 ~ D9, 화면·소리 그대로인 기본):** D1 PRO arm의 원하는 오디오는 지금처럼 밀어 넣는다(아래 6D-4의 멈춤
  S1). D2 복구 시간 값의 집(위 Q4). D3 복구 claim의 상태(깃발 둘과 한 microtask 뒤의 준비 이벤트)는 `player.ts`에 두고 클래스에 setter를
  넘긴다. D4 게스트 복구의 실행 스냅샷 읽기 둘(들리는 앞섬과 실행 확인)은 `player.ts`에 둔다(CHECK 12 기준 8 그대로, 새 모듈은
  `getYouTubeZeroStartSnapshot`을 가져오지 않음). D5 `prepareYouTubeAuthorityOccurrence`와 `waitForPendingYouTubePrimeBounce`를 `iframe.ts`
  밖으로 옮기지 않는다(제스처 증명 RO-34와 iOS prime 대기의 다른 독자가 있어, `playlist.test.ts`의 이름공간 spy 일곱이 그대로). D6 방장
  복구는 실행의 'recovering-host' 단계가 아니라 복구 주인의 단계다(실행의 파사드가 바뀌면 모든 장부 독자가 바뀜). D7 복구의 맨 `mute()`는
  코드와 함께 옮겨 CHECK 11의 새 파일 항목으로 센다. D8 'PRO YouTube 시작 중 동기화 누름' 고정 행은 선택이었고 더하지 않았다(아래 '계획과
  달라진 것'). D9 끝 조건 2의 `onFallbackRequired`는 `zero-start.ts`의 의존성 이름이라 남고, '`player.ts`에 복구 몸통 없음'과
  '`recoverZeroStartWithLegacyRendezvous` 없음'으로 읽는다. 이 읽기는 이 열차의 결정이고 계획과 오너 답에는 없다. 그래서 끝 조건 2는
  계획 문구대로는 아직 아니며 오너 확인을 기다린다(아래 'Phase 6 끝 조건' 2, '오너에게' 7).
- **Q6 기준선:** Phase 6 앞의 기기 기준선은 재지 않았다. 아래 '배포 뒤 확인'은 기준선과 견주지 못하고 판정 기준과만 견준다.

## 증분 한눈에

'부모에서'는 테스트 먼저 커밋을 그 트리 그대로(런타임은 부모의 것) 돌린 결과(실패 / 그 실행의 행)이고, '코드 커밋에서'는 같은 파일들을
코드 커밋에서 돌린 결과다. 둘 다 구현 때 잰 값이다(QA 라운드 1). 실패한 행은 모두 그 테스트 먼저 커밋이 더한, 아직 없는 코드를 읽는
행이고, 새 중립 고정(복구 골든, 토큰 행, 바꾼 Standard 방장 행, `sync-integration.test.ts`의 op 로그)은 부모에서 모두 통과했다. 이 갈래의
새·바꾼 고정을 바탕 런타임 `bdb5759a`에 한꺼번에 돌린 마지막 검사의 결과는 아래 'T0a·T0b·6B·6C 파일'에 있다.

| 증분                              | 항목         | 테스트 먼저 → 코드      | 부모에서                                                        | 코드 커밋에서      | 가드                                                                                     |
| --------------------------------- | ------------ | ----------------------- | --------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| 6D-1 C2-9 게스트 로컬 복구 클래스 | PA-09, SS-11 | `afdb49e2` → `dc596f8d` | 5 / 138(3 files), `zero-start-recovery.test.ts`는 불러오기 실패 | 163 / 163(4 files) | CHECK 11 `player.ts` 4 → 2, 새 항목 `zero-start-recovery.ts` 2(합 20), CHECK 5 계약 파일 |
| 6D-2 C2-11 방장 레거시 복구 단계  | PA-10        | `af3d0510` → `f6d7c1e1` | 30 / 438(4 files)                                               | 438 / 438          | CHECK 11 `player.ts` 2 → 1, `zero-start-recovery.ts` 2 → 3                               |
| 6D-3 C2-12 방장 로컬 시작 대기    | SS-08        | `a30e221e` → `17d15b9d` | 0 / 210(2 files), 새 행은 오늘 동작 고정                        | 210 / 210          | 수 그대로(가드 자체 시험 바늘의 들여쓰기만)                                              |
| 6D-4 C2-13 PRO 시작 토큰          | PA-11, PA-01 | `a0843dad` → `051a0727` | 0 / 9(2 files), `typecheck:tests` 통과                          | 9 / 9              | 수 그대로                                                                                |
| 6D-5 기록·가드 자체 시험          | RT-09, RT-11 | `a9ee6842`, 보고서 커밋 | 해당 없음                                                       | 빌드 바이트 동일   | 수 그대로                                                                                |

부모에서 실패한 이유는 모두 아직 없는 코드다: 6D-1 "Cannot find module '/src/youtube/zero-start-recovery.ts'"(단위 파일), 시간 집 셋이
undefined(`start-timing-parity.test.ts`의 첫 행), 가드 자체 시험 넷(모듈 소스가 없어 바늘을 찾지 못하거나 `--report`에 모듈 자리가 없음).
6D-2 방장 단위 28행 '**vi_import_2**.HostZeroStartRecovery is not a constructor'와 가드 자체 시험 둘. 6D-3과 6D-4는 새 코드를 읽는 행이 없다:
6D-3의 원시는 모듈 안 함수이고 시험 전용 export를 두지 않으며, 6D-4는 타입과 주석만 바꾼다. 6D-1과 6D-2의 테스트 먼저 커밋은 코드 커밋
앞에 한 번씩 고쳐(행을 더함) 고친 판을 부모에서 다시 돌렸고, 첫 판(`c3ab529f`, `5c940127`)도 같은 그림이었다. 리뷰 뒤의 시험만 커밋
`6e3bd6f5`(6D-1 ~ 6D-3의 행 여섯과 단언 하나)는 부모 `cb2279ba`에서 통과하고(`player.test.ts`의 것은 바탕 런타임에서도), 그 행이 고정하는
코드를 지우면 그 행이 실패한다(QA 라운드 3).

## 증분

### 6D-1 C2-9 게스트 로컬 복구 클래스 (PA-09, SS-11)

- **클래스:** 새 `src/youtube/zero-start-recovery.ts`의 `GuestZeroStartRecovery`(`:95`)가 Standard 게스트의 로컬 복구다. zero-start 실행이 이
  게스트의 시작을 놓으면(방장이 이 게스트 없이 COMMIT, 시계 보정 전, 준비 실패, 출시 확인 시간 넘김) 지금 iframe에서 혼자 시작을
  이어받는다. `clear(transfer)`(`:111`)는 옛 `clearZeroStartExternalFallback`이고 `start(...)`(`:138`)는 옛 클로저의 역할 확인과 지우기 뒤
  몸통이다. 옮긴 몸통을 스크립트로 견주면 문장마다 같고, 다른 것은 `player.ts`에 남은 앞부분과 울타리, 튜플 풀기, 줄 바꿈 하나, 그리고
  순서 하나다: 게스트 맥락(`youtube.currentSubIndex`를 읽음)을 이제 `guestRecovery.start`가 `resolveZeroStartDelay`를 부르기 전에
  만든다(전에는 그 뒤). 중립이다: 그 함수의 쓰기 둘(`sync.youtubeLocalOffset` 0과 `sync:display-update`)을 듣는 쪽은
  `youtube.currentSubIndex`를 쓰지 않고, 게스트 목표(`resolveZeroStartLocalTarget`의 게스트 갈래)는 subIndex를 읽지 않는다. 시도마다
  울타리 먼저, 코호트에서 빠진 게스트가 불러오기를 낸 경우 준비 예산의 남은 7.7 s를, 다른 경우 3 s 다리를 쓰고, 0.35 s 안의 정착을 50 ms
  폴로 보고, 소리를 명령 → 확인 → 폴로 되돌린 뒤 방 위치로 출시하고 1.8 s 안의 PLAYING으로 끝낸다. 실패하면 검증 복원
  ('verify-then-settle')으로 그 iframe을 정리한다.
- **`player.ts`에 남은 것(D3, D4):** 관리 타이머 `'yt-zero-start-external-fallback'`(클래스에는 그 걸기·지우기 클로저를 넘김,
  `src/youtube/player.ts:1992-1998`), claim 깃발 둘과 한 microtask 뒤의 준비 이벤트, 역할 읽기, 실행 스냅샷 읽기 둘(들리는 앞섬과 울타리
  `isCurrent`). `onFallbackRequired`(`:2305-2342`)는 이제 넘겨주기다: 역할 확인, 지우기, 들리는 앞섬, 울타리 클로저(역할, 방장 연결,
  YouTube 세션, 큐 항목, 실행과 영상), 그리고 `guestRecovery.start(...)`. 새 모듈은 타이머를 걸지 않고 실행 스냅샷을 읽지 않으며 `player.ts`,
  `iframe.ts`, `zero-start.ts`에서 값을 가져오지 않는다(`zero-start.ts`에서는 타입만).
- **시간 집(D2, Q3, Q4):** `YOUTUBE_RECOVERY_POLL_MS` 50(`src/youtube/constants.ts:230`, 셋째 박자의 폴), `YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC`
  0.35(`:232`), `YOUTUBE_RECOVERY_BRIDGE_MS` 3,000(`:237`). 무장 단계의 `YOUTUBE_ARM_*`와 이름을 따로 둔다. 방장 복구가 아직 `player.ts`에
  있던 6D-1에서는 그쪽 글자 셋도 이 이름을 읽었다.
- **바이트:** 이 빌드 대상에서 클래스 private 필드는 WeakMap 도우미로 낮춰진다. 닫힌 값 다섯을 필드로 둔 첫 코드 커밋(`c2d9542c`)은 eager
  JS gzip +221 B였고, 그 다섯을 private 위치 튜플 하나(`#ports`)에 넣어 +120 B가 됐다(장부 claim과 `restoreYouTubeAudioVerified`의 위치
  인자와 같은 꼴). 그 뒤 `587e95a8` → `dc596f8d`는 설정 주석의 커버리지 숫자 하나만 고쳤다.
- **가드와 기록(같은 커밋):** CHECK 5의 YouTube 시작 계약 파일에 `zero-start-recovery.ts`(객체 쌍 규칙에 걸리지 않음, 수 1 / 1 / 45 그대로),
  CHECK 11 `player.ts` 4 → 2와 새 항목 `zero-start-recovery.ts` 2(합 20 그대로), CHECK 12 스냅샷 읽기 8의 이유 문장(실행 확인이 이제
  `isCurrent` 안), 레지스트리 RO-02(주인, 기한, 시간 집, 앵커), RO-12(셋째 박자, CHECK 11 역사), RO-33(클래스와 근거), 가드 항목 5·11·12,
  설계 문서의 모듈 표와 claim 표, 핵심 커버리지에 `zero-start-recovery.ts`(문턱 98 / 96 / 99 / 99)와 두 시험 파일. production 파일 458 → 459.
- **시험(테스트 먼저 `afdb49e2`):** 새 `zero-start-recovery-golden.test.ts`(jsdom, 진짜 `initYouTube`, Standard 시작 하네스, 각본의 IFrame
  API, 가짜 시간 위의 진짜 `core/timers`)가 한 순서 흔적에 iframe 명령, 복구 타이머 셋의 걸기·지우기, 자동 재생 의도, 준비·로딩 이벤트,
  `[YouTube ZeroStart]` 경고, 프레임, 장부의 복구·소유·hard-mute 질의와 실행 파사드 둘을 적어 G1 ~ G13 26행으로 고정한다: 코호트에서 빠진
  게스트의 7,700 ms 창과 출시, 붙잡지 못한 복구의 3,000 ms 창과 120 ms × 8 정리, 0.35 s 경계(0.35는 받고 0.351은 거절, 영상 확인과 정착
  확인 모두), 기한 1 ms 앞의 시도, unMute를 무시하는 iframe과 −9.999 s의 max(기한, 지금 + 1 s), 복구 중 다시 만든 iframe, 던지는 출시
  `playVideo()`, 1.8 s 출시 확인 시간 넘김, 울타리 일곱(새 PREPARE(복구 명령 없이 넘김), 맞는 ABORT, 방장 연결 닫힘과 끊김, 새 YouTube 세션,
  다른 큐 항목, 실행 재설정(실행·영상 확인을 함께, 아래 '중립 메모' (d))), 복구 중 `youtube:set-volume`, 던지는 첫 예약, 복구가 claim을
  가진 동안 늘 false인 실행 파사드(비평 issue 3), 준비 이벤트의 수와 microtask 순서. 부모에서 26행 모두 통과한다. 새 `zero-start-recovery.test.ts`(node, 가짜로 클래스만, 25행),
  `start-timing-parity.test.ts`(T0a) 첫 행의 새 이름 셋, 가드 자체 시험 넷(모듈과 `player.ts` 사이의 시간 값 사본, `--report`의 모듈 mute
  둘, 모듈이 자기 타이머를 걸면 `START TIMER SET`, 모듈의 스냅샷 읽기). 리뷰 뒤 시험 커밋 `6e3bd6f5`(QA 라운드 3)가 단위 파일에 게스트
  토큰 행 넷을 더했다: `clear()` 뒤, 검증 정리 중인 포기 뒤, 확인된 출시 뒤로 빠져나간 시도와 `clear()` 뒤로 빠져나간 정리 재시도가 아무것도
  하지 않는다(게스트 29행). 그 전에는 게스트 토큰의 이동이나 확인 하나를 지워도 실패하는 행이 없었다(리뷰의 변이 확인).
- **그대로 통과(계획이 적은 것):** `player.test.ts`의 external fallback 묶음(9.0.8 행 포함)과 넘김 행, `zero-start-fallback-ownership.test.ts`
  9행, `sync-integration.test.ts`의 게스트 행, T0a의 7,700·3,000 고정과 로그 동결(`Recovered locally`, `Falling back locally`,
  `Local fallback failed:`), 로컬 Chromium `e2e/youtube-manual-zero-start.test.ts:157`(느린 게스트 복구 중 Sync).

### 6D-2 C2-11 방장 레거시 복구 단계 (PA-10)

- **단계:** 같은 파일의 `HostZeroStartRecovery`(`src/youtube/zero-start-recovery.ts:475`)가 Standard 방장의 레거시 복구다. 실행이 방장의
  시작을 시작한 뒤 놓으면(확인되지 않는 hard mute나 소리 복원, 보내지 못한 COMMIT, 준비 예산) 또는 `player.ts`의 교체 대체가 코호트
  게스트의 연결이 바뀐 것을 찾으면, 3 s 다리 안에 iframe을 0:00에 맞추고 소리를 되돌린 뒤 레거시 2단계 랑데부에 넘긴다. 자기 토큰
  (private `#generation`)과 위치 튜플 `#ports`(스케줄, 타이머 지우기, 복구 claim의 active 깃발 setter, 울타리, 플레이어, 소리 잡기,
  넘기기)를 갖는다. `cancel()`(`:492`)이 옛 '세대 올리고 타이머 지우기'를, `start(target, reason)`(`:501`)이 옛
  `recoverZeroStartWithLegacyRendezvous`의 몸통을 맡는다. 정규화한 diff로 다른 줄은 둘뿐이다: 첫 세대 올리기·지우기가 `this.cancel()`,
  `scheduleYtAutoSync` 호출이 `handOff(target)`.
- **`player.ts`에 남은 것:** 관리 타이머 `'yt-zero-start-host-fallback'`, 역할을 읽는 울타리 `isCurrentZeroStartLegacyTarget`, 소리 잡기,
  레거시 랑데부로의 넘기기(`scheduleYtAutoSync(0, { skipSeek, rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS })`,
  `src/youtube/player.ts:2035-2049`), 그리고 교체 대체 전부(기록, 자기 토큰 `replacementFallbackToken`, 1.5 s와 0 ms 타이머, 스냅샷 읽기
  둘). `invalidate`와 PREPARE 선택은 옛 순서 그대로 `hostRecovery.cancel()`을 부른다. 다시 들어감도 그대로다: 넘기기가
  `scheduleYtAutoSync` → invalidate로 이 단계를 먼저 물리고 그 뒤에 로그 줄이 나온다. `recoverZeroStartWithLegacyRendezvous`,
  `zeroStartHostFallbackGeneration`, 지역 타입 `ZeroStartLegacyTarget`은 지웠다(타입은 모듈의 `HostRecoveryTarget`, 바이트 0).
- **실행의 단계가 아님(D6):** 실행의 'recovering-host' 단계로 만들면 `isYouTubeZeroStartInFlight`·`isYouTubeZeroStartProtocolActive`가 바뀌고
  그것을 읽는 모든 장부 독자가 바뀐다(멈춤 S2). 단계는 게스트 복구와 같은 claim(active 깃발)을 쓰고, 그동안 실행의 파사드는 false다.
- **토큰 셋:** 게스트 복구의 세대, 방장 단계의 세대, 교체 대체의 토큰은 이름 붙은 셋으로 남고 합치지 않는다. 계획의 '장부 epoch는 claim
  전이에만'은 적용할 것이 없다: 6B부터 장부는 epoch 없이 살아 있는 질의만 읽는다(RO-02, 설계 문서).
- **가드와 기록(같은 커밋):** CHECK 11 `player.ts` 2 → 1(`stopYouTubeMode`가 플레이어를 부수기 전의 mute만), `zero-start-recovery.ts` 2 → 3(합
  20). CHECK 12와 시작 타이머 설정 파일은 그대로다(두 방장 키 모두 `player.ts`만 건다). RO-02(주인, 목표, 기한, 시간 집의 독자, 앵커, 상태),
  RO-12(두 정리 모두 모듈 안, CHECK 11 역사), RO-33(단계가 예외 옆), 가드 항목 5·11·12(`src/youtube`의 타이머 호출 수 192 → 187), 설계 문서의 Amended, 모듈
  표, claim 표, 'Not covered yet'.
- **시험(테스트 먼저 `af3d0510`, 첫 판 `5c940127`):** 골든에 방장 행 H1 ~ H9 12행(진짜 배선의 App 방장 하나, 레거시 Stage-2 타이머
  `'yt-auto-sync'`와 방 상태 프레임까지 그 행에서만 기록, 게스트 26행은 바이트 그대로): 준비 실패(hard-mute-timeout)의 Stage 1과 4 s 뒤
  Stage 2, 보내지 못한 COMMIT(무장된 상주 iframe을 다시 불러오지 않고 이어받음), 장벽 중 게스트 연결 교체(1.5 s 뒤)와 다시 연결(바로), 3 s
  다리 시간 넘김(로그, 로딩 끝, 시도마다 pause·seek하는 120 ms × 8 정리), 복구 중 다시 만든 iframe, 상주 위치 다시 잡기(prepare-timeout,
  다시 불러오지 않음), 방장 seek·로컬 pause·다른 큐 항목, 새 PREPARE, 해체 넘김. `sync-integration.test.ts`의 `'yt-zero-start-host-fallback'`
  이름 고정 14줄과 `'yt-zero-start-replacement-fallback'` 2줄 옆에 iframe op 로그 단언을 더했다(이름과 기대 값 그대로). 단위 28행(방장 단계),
  가드 자체 시험 둘(`--report`의 단계 mute, 단계가 자기 타이머를 걸면 `START TIMER SET`). 첫 판의 단위 행 하나는 다시 seek를 가정해 오늘
  동작으로 고쳤다(아래 '오너에게' 2). 리뷰 뒤 `6e3bd6f5`가 방장 단위 행 하나를 더했다: `cancel()` 뒤로 빠져나간 검증 정리 재시도가
  아무것도 하지 않는다(방장 29행, 검증 정리의 현재 확인을 고정).
- **그대로 통과:** T0a 와이어 골든의 방장 행, 시작 소유 경계와 정리 루프의 로컬 pause·방 나가기 행, 로그 동결 행, 복원 박자의 방장 루프,
  T0b의 H 행(H4, H4a 포함, 결함 1은 만들지 않음)과 비동기 변형, `sync-integration.test.ts`의 방장 행.

### 6D-3 C2-12 Standard 방장의 로컬 시작 대기 (SS-08)

- **원시 하나:** Standard 방장이 0:00보다 앞의 로컬 목표(음수 수동 오프셋)로 시작할 때 스피커를 그 자리에 잡아 두고 방 시간은 흐르게 하는
  대기가 `player.ts` 안의 원시가 됐다. `beginStandardHostLocalStart(player, canonicalTime, delayMs, isCurrent)`(`src/youtube/player.ts:672`)가
  시작 순간을 잡고 `local-offset.ts`에 읽기를 설치한 뒤 `'yt-host-local-start'`를 거는 무장 단계를 돌려주고,
  `retireStandardHostLocalStart()`(`:657`)가 그 타이머와 읽기를 함께 물린다. 레거시 랑데부의 물림 `retireYouTubeAutoSync`(`:710`)가
  `'yt-auto-sync'`를 지운 뒤 이것을 부른다. 시작 순서(읽기 → pauseVideo → 울타리 → seek → 울타리 → 자동 재생 의도 → 타이머)와 출시
  순서(울타리 → 0.04 s 넘으면 seek → 울타리 → 적용 오프셋 → 자동 오프셋 → 읽기 null → playVideo)는 그대로이고, 출시 몸통은 이름 셋만 바뀌어
  22줄이 같다.
- **장부와 술어:** 레거시 claim은 [stage2Pending] 그대로다(로컬 시작을 읽는 파생 질의가 없음). 대기 술어 `isStandardHostYouTubeLocalStartPending`는
  레거시 전용 그대로다(PA-15). 새 모듈은 없다(Q26이 허락한 넷 밖이다). PRO 직접 COMMIT의 약속 대기, 게스트 복구의 출시, 실행과 arm의 출시
  지연은 범위 밖이다.
- **가드와 기록:** 수는 그대로다. 타이머가 이제 무장 단계 안에서 걸려 `'yt-host-local-start'` 글자 줄의 들여쓰기가 8칸에서 6칸이 됐고,
  가드 자체 시험의 바늘을 같은 커밋에서 따라 고쳤다(그 행의 네 결과는 같음). `clearManagedTimer('yt-host-local-start')`는 여전히 하나다.
  RO-02(주인 문단, 앵커, 상태), RO-13(물림 포트 문장), 설계 문서.
- **시험(테스트 먼저 `a30e221e`):** `player.test.ts` 'Standard host own output compensation'이 이제 진짜 관리 타이머와 가짜 시간 위에서
  돌고, 명령마다 시각, 대기 술어, 적용 오프셋과 자동 오프셋을 적는 op 로그, YOUTUBE_STATE 프레임과 Stage 2로 고정한다. 타이머 이름으로
  콜백을 찾던 `mock.calls.find` 일곱과 `getManagedTimer` null 확인 둘을 지웠다. 울타리 행 셋을 더했다(대기의 pause, seek, 늦은 출시의 따라잡기
  seek 안에서 더 새 타임라인이 시작되면 거기서 멈춤). 이 셋은 시작의 두 울타리와 출시의 둘째 울타리(따라잡기 seek 뒤)를 고정한다. 출시의 첫
  울타리(따라잡기 seek 앞)는 리뷰 뒤 `6e3bd6f5`가 더한 행 'stops a late negative-start release whose YouTube session moved on before its
  catch-up seek'이 고정한다: YouTube에서 YouTube로의 불러오기는 세션만 옮기고 대기를 물리지 않아, 늦게 울린 출시를 그 울타리만 멈춘다. 같은
  커밋에서 수동 편집 행이 물림 뒤 `'yt-host-local-start'`가 null임을 다시 읽는다(op 로그로 바꾸며 빠졌던, 물림의 타이머 지우기의 고정).
  `host-local-rendezvous.test.ts`의 'hands a negative-start wait to a new manual offset
  %s'(4 cases)는 대역 타이머 쌍과 대역 취소 훅 대신 진짜 레거시 랑데부(수동 −9.999 s)를 몰고, 물림 포트로 진짜 대기를 물린다. 모두
  부모에서 통과한다(210 / 210, 울타리 행 전에 seed 4242와 7로 섞어도 207 / 207).
- **그대로 통과:** `standard-start-pause-teardown.test.ts`의 'never coexist' 행, 라우터 9행, `local-offset.test.ts` 31행, 타이머 주인 질의
  49행, 방 전환 T3, native control 행, T0b H3·H5·H6·H9, `sync-integration.test.ts`의 2단계 행. 로컬 Chromium 행(음수 수동 오프셋
  `youtube-manual-zero-start.test.ts:90`, `youtube-manual-repeat`, `youtube-output-delay`)도 통과했지만 6D-3의 근거로 들지 않는다: `:90`은
  다음 곡을 zero-start로 시작하고, 새 곡과 반복도 zero-start를 청한다. 이 원시를 시작하는 것은 레거시 랑데부뿐이다(곡 앞부분에서는 재생 중
  0:00으로 seek, 기준을 넘은 ⏮, 자동 재생과 트랙 넘김의 대체, 방장 복구의 넘기기 등). 그래서 6D-3의 근거는 위 단위 행이고, 기기 절차에 그
  길을 더했다(아래 '배포 뒤 확인' C(4)).

### 6D-4 C2-13 PRO 시작 토큰 (PA-11, PA-01)

- **합집합 하나:** `YouTubeAuthorityTimingMode`(`src/youtube/authority-arm.ts:49`)가 `ProPlaybackTimingMode`
  (`src/pro-room/playback-authority-hooks.ts:352`, 시간 집 `cloudflare/pro-room-playback-timing.ts`의 `ProRoomPlaybackTimingMode`)의 타입
  전용 별칭이 되고, `player.ts`의 인라인 합집합 둘도 같은 타입을 쓴다. 타입 전용 import라 런타임 간선이 없고 빌드 출력은 바이트로 같다.
- **토큰 넷, 합치지 않음:** 준비 세대(`src/youtube/iframe.ts:2023`), COMMIT 세대(`src/youtube/player.ts:933`), 로컬 pause 세대(`:934`, 울타리가
  아니라 사건 기록), 관문 토큰(`src/youtube/iframe-audio.ts:89`). arm 안의 둘(`#generation`, `#detachedRestoreGeneration`,
  `authority-arm.ts:245-246`)도 그대로다. 장부는 epoch를 두지 않고, `pro-direct`는 묻는 독자가 없어 등록하지 않으며, `iframe.ts`의 arm은
  `onPhaseChange`를 잇지 않는다. 주석, RO-03, 설계 문서의 새 절 'The PRO start tokens'이 무엇이 토큰마다 움직이고 무엇이 견주는지 적는다.
  로컬 pause 세대를 준비 세대와 합치면 직접 COMMIT 자신의 준비 취소를 로컬 pause로 읽어 그 기기가 소리 없이 남는다.
- **멈춘 것(S1, D1): PRO arm이 원하는 오디오와 관문을 복원 때 `iframe-audio.ts`에서 읽기.** 지금 arm은 준비 때 `readYouTubeAppAudio(true)`
  ('non-positive' 규칙)와 `isYouTubePauseGateHeld()`를 읽고, 그 뒤의 바뀜은 `player.ts`가 민다(`youtube:set-volume` 쓰기, 관문 pending,
  관문 settled, 'rounded' 규칙). 살아 있는 읽기로 바꾸면 0 < 마스터 볼륨 < 0.005에서 복원이 지금과 반대로 음소거하거나 unMute할 수 있고
  (iOS처럼 소프트웨어 볼륨을 무시하는 곳에서 들릴 수 있음), `youtube:set-volume`을 내지 않는 마스터 볼륨 쓰기(`src/audio/effects.ts`의 이른
  부팅·시험 대체)를 따르며, 6C 고정 `youtube-iframe-audio-order.test.ts`가 바이트로 고정한 'push pro …' 줄을 지운다. 그래서 중립이 아니다.
  뒤 후보는 6C-3의 규칙 하나가 들어간 뒤 그 고정을 같은 변경에서 고치는 것, 또는 Phase 7의 계약 (a) 아래다. RO-03, RO-12, 설계 문서에
  적었다.
- **옮기지 않음(D5):** 준비 이음새와 prime 대기는 `iframe.ts`에 남고, `playlist.test.ts`의 이름공간 spy 일곱(`:591`, `:638`, `:687`, `:735`,
  `:739`, `:806`, `:807`)과 그 파일이 그대로다.
- **시험(테스트 먼저 `a0843dad`):** 새 `pro-start-tokens.test.ts`(4행, `pro-arm-cancel-tokens.test.ts`의 하네스)가 관문을 잡은 채 직접 PRO
  COMMIT이 700 ms를 기다리는 동안 +200 ms에 사건 하나를 일으킨다. 준비 세대는 운영 getter `getProYouTubeAuthorityPreparationGeneration()`로,
  관문은 `isYouTubePauseGateHeld()`로, COMMIT 세대와 로컬 pause 세대는 기다리던 COMMIT이 하는 일(재생, 재생 없이 처리됨, 거절)로 읽는다:
  로컬 pause, 해체(같은 iframe이 같은 task에서 다시 현재가 되어도), 더 새 준비, 관문 자신의 정착. `pro-room-playback-timing.test.ts`의 기존 행
  'gives the Worker and the App one start-kind union'에 `expectTypeOf<YouTubeAuthorityTimingMode>().toEqualTypeOf<ProRoomPlaybackTimingMode>()`
  한 줄(제목과 행 수 그대로). 부모에서 9 / 9, `typecheck:tests` 통과, seed 1 ~ 8, 31, 4242, 20261030으로 섞어도 9 / 9.
- **변이 확인(구현 때, QA 라운드 1):** 해체가 COMMIT 세대를 움직이지 않으면 해체 행이, 로컬 pause가 COMMIT 세대도 움직이면 로컬 pause 행이,
  로컬 pause 세대를 준비 세대와 합치면 더 새 준비 행, 정착 행과 T0a 'applies a direct play COMMIT that follows a prepare cancel, rather than
  consuming it'이, arm의 합집합에 'pre-v2'를 더하면 `typecheck:tests`(TS2344)가 실패한다. 변이는 모두 되돌렸고 두 런타임 파일은 바이트
  그대로다.
- **그대로 통과:** `pro-arm-cancel-tokens.test.ts` 4행, `pro-manual-zero-start.test.ts` 58행, ZS-06·ZS-09 끝점 행, PRO READY 골든 10행,
  늦은 합류 고정 행(7, 8), `runtime-server-playback.test.ts` 144, `stale-async-guards.test.ts` 182, `playlist.test.ts` 125(spy 행 포함),
  `authority-arm.test.ts` 80, 음향 순서 19, T0b PRO 참값표 19, `player.test.ts`의 PRO 참가자 조작·볼륨 다리·관문 묶음. 로컬 WebKit
  `setup-youtube-activation` 4 / 4(`iframe.ts`의 주석을 건드려서, 계획 §4.2-4).

### 6D-5 기록과 가드 자체 시험 (RT-09, RT-11, 버전 올리기 없음)

- **레지스트리(`a9ee6842`):** 레지스트리 규칙은 `duplicated`를 마지막 독립 기계를 없애는 변경에서만 `owner-in-place`로 바꾸고 그 변경의
  시험을 인용하게 한다. RO-02, RO-03, RO-12는 셋 다 독립 기계가 남아 `duplicated` 그대로이고, 상태 문단에 남은 기계와 `owner-in-place`가 될
  변경을 적었다.
  - RO-02: 실행(`zero-start.ts`), 두 복구(`zero-start-recovery.ts`), 레거시 랑데부와 교체 대체(`player.ts`)가 저마다 자기 단계나 토큰과
    타이머를 갖고 서로 직접 물린다. 장부는 그 살아 있는 질의를 엮을 뿐이다. 복구 골든이 그 둘을 떼어 고정한다: G12는 복구가 claim을 가진
    동안 실행 파사드가 false이고, 방장 행은 단계가 레거시 랑데부에 넘긴 뒤 랑데부 자신의 Stage 1·2가 따름을 보인다. 게스트 복구는 예외
    RO-33으로 따로 남고, 레지스트리의 'Consolidation phases' 표에 이 레코드를 맡을 뒤 Phase는 없다.
  - RO-03: 두 컨트롤러가 검증 복원 둘레의 자기 복원 루프와 출시를 갖고(`youtube-audio-restore-cadence.test.ts`가 루프마다 고정), PRO arm은
    원하는 오디오를 밀려 받는다.
  - RO-12: 그 밀기(`youtube-iframe-audio-order.test.ts`가 하나씩 고정). 시작 기계가 이 모듈에서 읽게 하는 변경(단일 규칙 뒤 그 고정을 같은
    변경에서 고치거나, Phase 7의 `youtube:set-volume` 계약과 함께)이 `owner-in-place`를 만든다.
  - RO-33의 경로(6D-1·6D-2가 고침), RO-34(옮긴 함수 없음, D5), `Last source review`는 그대로다. 색인의 Consolidation 칸 셋은 `a9ee6842`가
    그대로 두었다가 리뷰 뒤 고쳤다: 용어 절의 `duplicated`는 '어느 Phase가 합치거나 오너 결정이 먼저'라서, Phase 6이 끝나도 남는 레코드의
    칸이 아직 Phase 6을 가리키면 안 된다(RO-26 '2 done; requests: decision'과 같은 꼴, 아래 '기록과 레지스트리').
- **가드 자체 시험:** 상태가 바뀌지 않아 'RO-02 duplicated' 글자를 쓰는 행(`src/core/__tests__/resource-ownership-guard.test.ts:101`,
  `:120-121`)과 `stopYouTubeMode`의 로더 바늘(`'    showLoader(false);'`, `:984`, `src/youtube/player.ts:1663`)은 그대로 맞는다. 고친 것은
  없고, 그 파일은 마지막 검사에서 104 / 104이며 seed 1 ~ 16으로 섞어도 104 / 104다(QA 라운드 2와 4).
- **문서:** 설계 문서 `youtube-start-ownership.md`의 'Applies to'에 6C-2와 6D-1 ~ 6D-4의 계획 단계, `docs/qa-domains.md` QA053의 대표 구현에
  `zero-start-recovery.ts`, 검사 진입점에 복구 골든을 더했다. 이 보고서와 `docs/README.md` 증거 목록.
- **계획 §4.10 끝 조건 대조:** 아래 'Phase 6 끝 조건'.

### 중립 메모

- **(a) 울타리의 스냅샷 읽기(6D-1):** 게스트 복구의 울타리 `isCurrent`는 세대가 맞을 때만 실행 스냅샷을 읽는다. 순수 읽기라 보이는 것은
  같다.
- **(b) 물림 포트의 로딩 끔(6D-3):** 진짜 물림 포트는 수동 편집의 로딩 true 바로 앞, 같은 task에서 `youtube:sync-loading` false(주인 없음)를
  낸다. 오늘의 `cancelYtAutoSync`이고 보이는 것은 같다.
- **(c) 넘김 순간의 준비 이벤트(6D-1):** 골든 G13은 넘김 순간 실행 자신의 동기 준비 이벤트를 고정한다(그 순간 복구 claim은 없음). 앞
  참값표가 이미 덮는 순간이다.
- **(d) 울타리의 실행·영상 확인(6D-1):** 게스트 복구 울타리의 실행 확인(`snapshot?.runId === event.runId`)과 영상 확인
  (`snapshot.videoId === event.videoId`)은 함께만 고정된다(G9 'the run is reset': 재설정은 둘 다 지움). 오늘은 어느 하나만으로도 같다:
  재설정은 어느 쪽에서도 걸리고, 새 게스트 실행은 실행이 바뀌기 전에 늘 복구를 먼저 지운다(`handlePrepare` → `onPrepareSelection` →
  `clear(true)`). 그래서 한쪽만 지워도 실패하는 시험은 없다(리뷰의 변이 확인). 계획 6D-1이 테스트 먼저로 든 runId 울타리는 이 뜻으로만
  고정돼 있고, RO-02의 게스트 복구 앵커에 같은 문장을 적었다.

## T0a·T0b·6B·6C 파일

6D가 바꾼 앞 단계 시험 파일은 T0a의 `start-timing-parity.test.ts` 하나다. 6D-1이 첫 행에 복구 시간 이름 셋을 더했다(import 셋, 기대 하나,
머리 주석 한 문장. 기존 기대는 그대로). 나머지 T0a 골든과 고정 행, T0b 참값표 둘(U·P 행과 비동기 전달 변형 포함)과 표본기, 6B 행, 6C 행,
시험 도우미(`__helpers__`)는 바탕과 바이트로 같다(`git diff bdb5759a..5267e8b2`에 없음).

- **바탕 시험 파일을 브랜치 끝 런타임에서(마지막 검사, QA 라운드 2의 `a9ee6842`와 라운드 4의 `5267e8b2`에서 같은 결과):** 6D가 고친 기존
  시험 파일 여섯(`start-timing-parity`, `player`, `host-local-rendezvous`, `sync-integration`, `pro-room-playback-timing`, 가드 자체 시험)을 바탕
  것으로 바꿔 끝의 런타임에서 돌리면 563행 가운데 562 통과다.
  실패 하나는 가드 자체 시험의 바늘 행('fails a raised count, a count that fell below its baseline and a start timer no file sets')이 8칸
  들여쓰기의 `'yt-host-local-start'` 글자 줄을 찾지 못한 것이다(6D-3이 그 줄을 6칸으로 옮기며 같은 커밋에서 바늘을 고침, 결과 그대로).
  바탕의 `player.test.ts` 137행(타이머 이름으로 콜백을 찾던 옛 행 포함), `host-local-rendezvous.test.ts` 70행(대역 행 포함),
  `sync-integration.test.ts` 243행, `start-timing-parity.test.ts` 10행, `pro-room-playback-timing.test.ts` 5행과 가드 자체 시험의 나머지 97행은 끝
  런타임에서도 통과한다.
- **새·바꾼 고정을 바탕 런타임에서(마지막 검사):** 6D가 바꾼 런타임 파일 열(`src/youtube/`)을 바탕 것으로 되돌리고(복구 모듈은 사라짐,
  바탕과의 런타임 차이 없음을 확인) 이 갈래의 새·바꾼 고정 여덟 파일을 돌리면 511행 가운데 510 통과다(QA 라운드 4. 리뷰 행 전인 라운드
  2에서는 510 가운데 509). 실패는 `start-timing-parity.test.ts`의
  첫 행(바탕에는 복구 시간 이름 셋이 없음) 하나이고, `zero-start-recovery.test.ts`는 모듈이 없어 불러오기에 실패한다(둘 다 6D-1의 부모 실행과
  같은 이유). 복구 골든 38행(게스트 26, 방장 12), `pro-start-tokens.test.ts` 4행, 6D-3이 바꾸고 리뷰가 한 행을 더한 `player.test.ts` 141행과
  `host-local-rendezvous.test.ts` 70행, op 로그를 더한 `sync-integration.test.ts` 243행, `pro-room-playback-timing.test.ts` 5행은 6C의 런타임에서도
  모두 통과한다. 곧 6D의 새 고정은 6C 런타임의 동작을 그대로 적은 것이다. `pro-room-playback-timing.test.ts`의 타입 한 줄은 vitest 실행이 아니라
  `typecheck:tests`가 보고, 6D-4의 부모에서 통과했다.
- 두 실행 모두 `git restore`로 파일을 바꿨다가 HEAD로 되돌렸고, 앞뒤로 작업 트리가 깨끗했다.

## 계획과 달라진 것

1. **줄 번호:** 계획 인용은 `78ec56f5` 기준이라 모든 위치를 기호로 다시 찾았다.
2. **6D-6은 만들지 않았다:** 오너 답(Q22)의 '만들기 전에 사진 먼저'대로 계획과 행만 준비했다. 계획의 머지 순서는 6D-1 → 6D-2 → 6D-3 →
   6D-4 → 6D-6 → 6D-5지만, 6D-5가 버전 올리기 없는 기록이 되어 이 갈래에서는 6D-5의 기록이 먼저다. 오너가 '예'면 6D-6이 그 뒤, 버전 올리기
   앞의 마지막 런타임 증분이 되고, 이 보고서의 6D-6 절이 그 '의도한 변경'이 된다(6C-3과 같은 꼴).
3. **6D-5에 버전 올리기가 없다:** 계획의 6D-5는 버전 거울 여섯과 `index.html`의 캐시 쿼리를 함께 고쳤지만, 이 열차에서는 릴리스 담당이
   더한다(아래 '배포 조건과 순서').
4. **6D-1:** 닫힌 값 다섯을 private 위치 튜플 하나(`#ports`)에 둔다(바이트, +221 → +120 B). `start()`는 잡은 값이 아니라 잡는 함수(`capture`)를
   받아, 소리를 잡는 문장이 예전처럼 로컬 지연을 푼 뒤에 남는다. 골든은 장부와 파사드 읽기를 사건마다가 아니라 값이 바뀔 때 'claims' 줄로
   적는다.
5. **6D-2:** 코드 커밋 제목이 '단계 둘'이 아니라 '게스트 복구 옆의 단계'다. 계획의 모양대로 교체 대체는 `player.ts`에 남는다. 모듈이
   `HostRecoveryTarget` 타입을 내보내 `player.ts`가 지역 타입 대신 쓴다(바이트 0). H7은 방장 seek, 로컬 pause, 다른 큐 항목이고 재생·일시정지
   버튼이 아니다: 멈춘 다시 불러오기 중 iframe은 UNSTARTED라 그 버튼은 새 zero-start 실행을 시작하고, 그 길은 H8이 덮는다. H2는 +700부터
   COMMIT 프레임을 거절하는 전송 흉내로 COMMIT 보내기 실패를 만든다. `sync-integration.test.ts`의 `:1211` 고정에서는 op 로그 단언이 그 행의 4 s
   진행 뒤에 있다.
6. **6D-3:** 글자 줄의 들여쓰기가 6칸이 되어 가드 자체 시험 바늘을 고쳤다(계획이 허락한 이음새, 결과 그대로). 늦은 출시 행은 늦게 부른
   콜백 대신 대기 자신의 seek 안에서 페이지를 막아(시작 순간 뒤, 타이머 무장 전) 늦게 만든다. 수동 편집 넘김 행은 앞으로 가는 가짜 iframe
   시계에서 돈다(멈춘 가짜 iframe에서는 편집 자신의 런타임이 여러 번 다시 seek하는 가짜의 흔적). `host-local-rendezvous.test.ts`는 대역 하나
   (복구 claim)를 남긴다. 계획에 없던 울타리 행 셋을 더했다. `player.test.ts` 'synchronized pause ownership'의 `'yt-auto-sync'` 이름 고정 셋은
   Stage-2 대기를 고정하므로 남겼다(계획의 목록 밖).
7. **6D-4:** 관문 자신의 정착을 넷째 토큰 행으로 더했다. 행은 새 파일에 두어 T0a 파일이 그대로다. COMMIT 세대와 로컬 pause 세대는 `player.ts`
   안에 있고 시험 전용 export가 없어, 기다리던 COMMIT이 하는 일로 읽는다. 해체 행은 기다림이 다시 돌기 전에 같은 iframe을 다시 현재로
   만들어(`stopYouTubeMode`의 주석이 적는 길) COMMIT 세대만 COMMIT을 거절하게 한다. 더 새 준비 행은 선택되지 않은 뒤 occurrence를 준비해
   이음새가 iframe에 닿지 않고 토큰만 움직인다. 주석은 계획 목록보다 조금 더 적었다(arm의 토큰 둘, `authority-arm.ts`의 밀기 메모, 기다림
   문서의 해체). D8 고정 행은 선택이었고, 오너가 T0b 질문 3에 답하지 않았으며 그 권장이 PRO 시작 코드를 옮길 때를 말하는데 6D-4는 옮기지
   않아 더하지 않았다.
8. **크기:** 6D-2의 +193 B는 계획의 클래스 모양(`#generation`과 위치 튜플)을 지킨 비용이다. 클로저 단계면 더 작았겠지만 계획과 게스트 클래스의
   모양을 벗어나 하지 않았다. Phase 상한 안이다(아래 '번들 크기').
9. **레지스트리 상태:** 계획은 '남은 독립 기계가 없으면 `owner-in-place` 후보'를 적었다. 셋 다 독립 기계가 남아 후보가 없다(위 6D-5).

## Phase 6 끝 조건 (계획 §4.10)

계획 §4.10의 여덟 조건을 `a9ee6842`의 코드와 기록에 대조했다. `git grep`은 따로 범위를 적지 않으면 `src`에서 `__tests__`와 `*.test.ts`를
빼고 돌렸다(`git grep -n <pattern> -- src ':(exclude)src/**/__tests__/**' ':(exclude)*.test.ts'`). 리뷰 뒤(QA 라운드 3) 같은 grep을 브랜치
끝에서 다시 돌려 같은 결과를 얻었고, 리뷰 뒤 끝 `5267e8b2`의 마지막 검사(QA 라운드 4)에서도 표의 `git ls-files`, `git grep`, `git diff`가 모두
같은 결과다(`onFallbackRequired`는 여전히 `src/youtube/player.ts:2305`, 3의 `git diff`는 `b8ae59e7..5267e8b2`도 비어 있음).

| 조건                                                | 판정                                | 근거                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 6A ~ 6D가 운영에 있고 각각 기록됨                | 아직 아님                           | 6A만 운영(9.0.30 / v803, #550). 6B, 6C, 6D는 준비됨·배포 전이고 각 보고서와 `docs/README.md` 증거 목록이 있다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2. 구조 삭제                                        | 아님(계획 문구대로), 오너 확인 대기 | `git ls-files src/youtube/zero-start-ownership.ts` 없음. `isYouTubeZeroStartSyncOwned`는 `src` 운영 코드에 없음(남은 것은 가드 주석 `scripts/check-resource-ownership.mts:1066`, 시험 주석, 문서의 역사 문장). `git grep -n TIMING -- src/youtube/authority-arm.ts` 없음(arm 값은 6A-3부터 `constants.ts`). `git grep -n 'Phase 0d C2-1 shares it' -- src scripts cloudflare` 없음(이 보고서의 인용뿐). `native-control-authority.ts`에 타이머 이름 배열 없음(남은 이름은 자기 `LOCAL_REJOIN_TIMER`(`:61`)와 RO-13 넛지 읽기 하나(`:165`)). `git grep -n -E "recoverZeroStartWithLegacyRendezvous\|attemptFallback\|attemptRecovery\|abandonFallback\|finishUnavailable" -- src/youtube/player.ts` 없음: 복구 몸통은 `zero-start-recovery.ts`에 있다. 그러나 계획이 적은 대로 `git grep -n onFallbackRequired -- src/youtube/player.ts`를 돌리면 `:2305`가 나온다: `player.ts`의 `onFallbackRequired`(`:2305-2342`)가 넘겨주기로 남고 역할 확인·지우기·들리는 앞섬 읽기(`:2310`)·울타리 `isCurrent`(`:2321-2332`, 실행 스냅샷 읽기)를 가진다. 복구 몸통 없음으로 읽는 D9는 이 열차의 결정이다(계획과 초안 로드맵 Exit는 '복구 클로저가 player.ts에서 사라짐'을 적음. 아래 '오너에게' 7). 다리 훅 `isProPlaybackPauseGatePendingFromIframe` 없음 |
| 3. 통신·서버 계약 무변경                            | 참                                  | `git diff --stat b8ae59e7..a9ee6842 -- src/core/constants.ts src/types/index.ts src/network/protocol.ts cloudflare/pro-room-playback-timing.ts`가 비어 있다(R3 머지 `b8ae59e7`, 기록 `f8a30068` 모두). R3 뒤 `cloudflare/` 전체의 차이는 9.0.30 버전 거울 한 줄(`cloudflare/app-worker.ts`의 `ADMIN_ASSET_VERSION`)과 Phase 6 밖 R4의 `cloudflare/pro-room-worker.ts`뿐이다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4. 레지스트리와 CHECK 11·12                         | 참                                  | 주인 머리: `start-ownership.ts:4` RO-02, `arm-steps.ts:6` RO-03, `iframe-audio.ts:6` RO-12. 시간 집 `src/youtube/constants.ts`(RO-02·RO-03·RO-12의 시간 집 칸). 상태 셋은 `duplicated`로 6D-5가 이유를 고침. RO-33은 `zero-start-recovery.ts`의 `GuestZeroStartRecovery`를 가리키고, RO-34는 옮긴 함수가 없어(D5) 그대로 맞다. CHECK 11 20, CHECK 12 11 / 9 / 2 / 8 / 1이 끝의 수이고 가드가 통과한다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5. 기기 절차와 확인하지 못한 것, known-accepted #14 | 참(게이트 아님)                     | 아래 '배포 뒤 확인'과 '하지 않은 것과 확인하지 않은 것'. `docs/known-accepted.md`는 2026-10-29(#524) 뒤 바뀌지 않았다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 6. 마지막 열차 배포 뒤 14일 무제보                  | 시작 전                             | 6D 배포 때부터 센다. Phase 7 시작·배포를 막지 않는다(Q25)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7. 번들 Phase 순증 +200 B 이하                      | 참                                  | 증분마다 부모 대비 eager JS gzip 차의 합 +123 B(6A −149, 6B −53, 6C +34, 6D +291), 같은 툴체인. 아래 '번들 크기'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8. 문서                                             | 참                                  | `docs/design/youtube-start-ownership.md`(Accepted, 6B-1)가 `docs/README.md:40`에 있다. `docs/qa-domains.md` QA053이 장부, 설계 문서, 복구 모듈을 가리킨다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 정확한 개수 가드

바탕 값은 6D를 시작할 때 `bdb5759a`에서 잰 것이고(QA 라운드 1), 브랜치 끝 값은 `a9ee6842`의 마지막 검사다(QA 라운드 2). 리뷰 뒤 끝
`5267e8b2`의 마지막 검사(QA 라운드 4)도 모두 같은 값이고, `--report`는 글자까지 같다(brand capitalization만 이 보고서를 더해 1,039).

| 가드                                                | 바탕 `bdb5759a`                                                                                                               | 브랜치 끝 `a9ee6842`                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHECK 11 iframe 오디오 쓰기(RO-12)                  | 20(`arm-steps.ts` 2, `zero-start.ts` 2, `player.ts` 4, `iframe-audio.ts` 7, `iframe.ts` 3, `retained-player-controller.ts` 2) | 20(`arm-steps.ts` 2, `zero-start.ts` 2, `player.ts` 1, `iframe-audio.ts` 7, `iframe.ts` 3, `retained-player-controller.ts` 2, `zero-start-recovery.ts` 3) |
| CHECK 12 남의 시작 타이머 읽기 / 지우기(RO-02)      | 11 / 9                                                                                                                        | 11 / 9                                                                                                                                                    |
| CHECK 12 파사드 쓰기 / 실행 스냅샷 읽기 / 장부 합성 | 2 / 8 / 1                                                                                                                     | 2 / 8 / 1(스냅샷 읽기 둘이 `onFallbackRequired`와 그 울타리 `isCurrent`, 합성은 같은 `player.ts :: seekYouTubeFromApp`)                                   |
| CHECK 12 시작 타이머 설정 파일과 주차 hold 등록     | 다섯 키는 `player.ts`만 건다, 등록은 `player.ts` 최상위 문장 하나                                                             | 같음(새 모듈은 타이머를 걸지 않음)                                                                                                                        |
| CHECK 5 복사 / 의심 / 같은 값 쌍(보고만)            | 1 / 1 / 45                                                                                                                    | 1 / 1 / 45(YouTube 시작 계약 파일에 `zero-start-recovery.ts`)                                                                                             |
| resource-ownership                                  | 49 records, 458 production files, `--report` 107줄                                                                            | 49 records, 459 production files, `--report` 107줄                                                                                                        |
| dead-exports                                        | 411 prod files, 2,173 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76                                                  | 412, 2,180, 0, 20, 76                                                                                                                                     |
| import-graph                                        | 411 files, 2,107 edges, 순환 0                                                                                                | 412 files, 2,114 edges, 순환 0                                                                                                                            |
| bus-pairing                                         | 202 / 202                                                                                                                     | 202 / 202                                                                                                                                                 |
| room-authority                                      | 79 / 22 / 13 / 0 / 0, 411 files                                                                                               | 79 / 22 / 13 / 0 / 0, 412 files                                                                                                                           |
| brand capitalization                                | 1,037 copy sources                                                                                                            | 1,038(`zero-start-recovery.ts`. 이 보고서를 더한 기록 커밋에서 1,039)                                                                                     |

`--report`는 107줄 그대로이고, CHECK 11 사이트 셋이 `player.ts`에서 `zero-start-recovery.ts`로 옮겼다(`:306`, `:370`의 게스트 복구,
`:603`의 방장 단계). 기준치는 센 코드를 옮긴 커밋(`dc596f8d`, `f6d7c1e1`)이 같은 커밋에서 고쳤고, 합을 내리거나 올리지 않았다(CHECK 11은 20
그대로, 파일 항목만 옮김). 새
binding 일곱(복구 클래스 둘, 그 대상 타입 하나, 시간 집 셋, 실행의 넘김 이벤트 타입 하나)은 모두 운영이 쓰고, import-graph의 새 간선
일곱(6D-1의 여섯: `player.ts` → 새 모듈과 새 모듈의 값 import 다섯, 6D-2의 하나: 새 모듈 → `core/events.ts`)은 순환을 만들지 않는다.
source-complexity(YouTube 파일은 목록에 없음)도 바뀐 기준치가 없다.

## 번들 크기

같은 툴체인(Node 24.22.2, npm 12.0.2, vite 8.3.3)으로 코드 커밋마다 `npm run build`를 하고 `scripts/check-initial-transfer-budget.mts`의
`measureInitialTransfer`로 바이트를 읽었다(QA 라운드 1). 테스트 먼저 커밋은 런타임이 부모와 같아(`git diff --name-only <부모>..<테스트 먼저> --
src ':(exclude)src/**/__tests__/**'`가 비어 있음) 따로 빌드하지 않았다. 바탕 빌드는 6C 보고서의 브랜치 끝 값과 바이트까지 같고(QA 라운드 4에서
다시 빌드해도 같음), 부모 빌드는 매번 앞 증분의 코드 커밋 값과 같았다.

| 커밋                                              | 진입 청크          | 진입 raw / gzip   | eager JS gzip (부모 대비) | eager total raw / gzip (부모 대비) |
| ------------------------------------------------- | ------------------ | ----------------- | ------------------------- | ---------------------------------- |
| 바탕 `bdb5759a`(6C 끝과 같음)                     | `main-BDpc0SkS.js` | 859,737 / 253,698 | 465,439                   | 2,047,344 / 543,629                |
| 6D-1 `dc596f8d`                                   | `main-C6T0Wc17.js` | 859,735 / 253,793 | 465,559 (+120)            | 2,047,374 / 543,750 (+30 / +121)   |
| 6D-2 `f6d7c1e1`                                   | `main-DHXpM-c8.js` | 859,878 / 253,983 | 465,752 (+193)            | 2,047,517 / 543,943 (+143 / +193)  |
| 6D-3 `17d15b9d`                                   | `main-ojgPFHeO.js` | 859,957 / 253,963 | 465,730 (−22)             | 2,047,596 / 543,922 (+79 / −21)    |
| 6D-4 `051a0727`                                   | `main-ojgPFHeO.js` | 859,957 / 253,963 | 465,730 (0)               | 2,047,596 / 543,922 (0 / 0)        |
| 6D-5 `a9ee6842`(`build:checked`의 운영 빌드)      | `main-ojgPFHeO.js` | 859,957 / 253,963 | 465,730 (0)               | 2,047,596 / 543,922 (0 / 0)        |
| 리뷰 뒤 끝 `5267e8b2`(라운드 4의 `build:checked`) | `main-ojgPFHeO.js` | 859,957 / 253,963 | 465,730 (0)               | 2,047,596 / 543,922 (0 / 0)        |

- **증분별(부모 대비 eager JS gzip):** 6D-1 +120, 6D-2 +193, 6D-3 −22, 6D-4 0, 6D-5 0. 모두 증분 상한 +300 B 안이다. 6D-4는 타입과 주석만
  바꿔 `dist/`의 .js, .mjs, .html, .css 276 파일이 부모 빌드와 SHA-256으로 같았고, 6D-5는 문서만 바꿔 `a9ee6842`의 `build:checked` 빌드에서
  같은 276 파일이 6D-4 코드 커밋의 빌드와 SHA-256으로 모두 같다. 리뷰 뒤 끝 `5267e8b2`(주석 하나)의 `build:checked` 빌드도 같은 276 파일이
  `a9ee6842`의 빌드와 SHA-256으로 모두 같다(QA 라운드 4).
- **6D 순증(바탕 대비):** eager JS gzip +291 B, eager total gzip +293 B, eager total raw +252 B, 진입 raw +220 B, 진입 gzip +265 B.
  `guard:initial-transfer-budget`을 통과한다(entry 839.8 KiB raw / 248.0 KiB gzip, eager JS 454.8 KiB gzip, eager total 1,999.6 KiB raw /
  531.2 KiB gzip, 모든 예산에 5 % 여유).
- **Phase 6 누계(계획 §4.2-6, 증분마다 부모 대비 잰 차의 합, 사이에 낀 Phase 6 밖 열차는 뺌):** 6A −149 B + 6B −53 B + 6C +34 B + 6D +291 B
  = **+123 B**로 Phase 상한 +200 B 안이다. 6D-6(그리고 6C-3)이 쓸 수 있는 남은 몫은 +77 B다. Q29의 멈춤 조건에 해당하지 않는다.
- 6D-1의 +120 B와 6D-2의 +193 B는 복구 클래스 둘의 private 필드를 낮춘 도우미와 생성자(6D-2는 `cancel()`도)이고, 6D-3의 −22 B는 대기를
  원시 하나로 모은 것으로 본다[추론].

## 혼합 버전

계획 §4.9의 혼합 버전과 §5의 6D 행이다. 근거는 기기 혼합 행이 아니라 T0a의 프레임·시각 골든과 T0b 참값표, 6D의 복구 골든이 바이트 그대로
통과한 것이다(Phase 5의 P5-D9 C 선례). 와이어(`src/network/protocol.ts`, `src/types/index.ts`, `src/core/constants.ts`, `cloudflare/`)는 바탕과
바이트로 같다.

| 조합                                             | 결과                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6D 방장과 옛 게스트: 방장 레거시 복구            | 단계가 레거시 랑데부에 넘기는 Stage 1 `YOUTUBE_STATE`와 4 s 뒤 Stage 2 `YOUTUBE_SYNC`의 모양과 시각이 같다(골든 방장 행이 바탕 런타임에서도 같음, T0a 와이어 골든 그대로). 옛 게스트는 같은 프레임을 같은 때 받는다 |
| 옛·새 게스트: 코호트에서 빠진 게스트의 로컬 복구 | 게스트 혼자의 일이다. 방장은 ARMED가 오지 않은 것만 안다. T0a의 7,700 / 3,000 고정과 골든 G 행이 그대로다                                                                                                           |
| 옛·새 방장: 음수 오프셋의 로컬 시작 대기         | 방장 기기 안의 일이다. 하트비트의 대기 술어는 레거시 전용 그대로(6C-1)라 옛 게스트가 받는 상태는 같다                                                                                                               |
| PRO 방의 옛·새 기기                              | PREPARE·READY·COMMIT은 서버를 거치고 서버는 바뀌지 않는다. 토큰과 합집합 타입은 앱 안이다. T0a PRO READY 시각 골든, T0b PRO 참값표, 늦은 합류 고정 행이 그대로다                                                    |
| 바닥 795 아래의 열린 세션                        | 바닥은 열린 세션을 닫지 않는다. 6D는 프레임을 얼려 그 위험을 더하거나 줄이지 않는다                                                                                                                                 |

결과가 다르더라도 '방이 zero-start 대신 레거시로 시작' 같은 품질 저하이고 재생이 멈추지는 않는다고 본다(계획 §5, 추론).

## 되돌리기

기본은 더 높은 SemVer·epoch의 앞으로 고치기다. 새 되돌리기 경계는 없다: 계약 표지, D1, 저장 모양, 바닥을 바꾸지 않아 forward floor가
생기지 않는다.

- **실패 자동 복구:** target `app`의 실패 복구는 릴리스 안에서 checkpoint의 App(dispatch 때의 운영 App)으로 간다. 6C가 먼저 나가면 6C의
  App이다. 바닥 795 이상이라 `lower`가 필요 없고, 와이어가 같아 되돌린 App과 6D가 섞인 방도 같은 프레임을 같은 시각에 보낸다.
- **손 되돌리기:** 배포 뒤 checkpoint App으로 가는 손 되돌리기는 6D를 받은 클라이언트에 낮은 epoch를 돌려주므로 release-record §2의 열린
  항목('낮은 epoch로 가는 App 손 되돌리기의 규칙', 결정 전)과 `docs/hotfix-procedure.md`를 따른다. 결정 전에는 6D만 빼는 다음 번호의 코드
  되돌리기가 기본이고, 급할 때만 명시적으로 검토한 CLI 되돌리기다.
- **혼자 되돌릴 수 있는 기간:** 6D는 Phase 6의 마지막 열차라, 뒤에 다른 App 열차가 쌓이기 전까지 혼자 되돌릴 수 있다. 6D는 6A-3의 시간
  집과 6A-4·6C-2의 `iframe-audio.ts`(검증 복원, 쓰기, hold) 위에 있어, 6D가 머지되면 6C만 되돌릴 수 없고 6C부터 6D까지 앞으로 되돌린다(계획
  §6): 새 `agent/` 갈래에서 그 열차들의 커밋을 거꾸로 되돌리고, 다음 SemVer·epoch(버전 거울 여섯과 `index.html`의 bootstrap 캐시 쿼리), 전체
  게이트, App 릴리스, 기록. 앞으로 되돌리기와 앞으로 고치기는 각각 업데이트 창 하나를 Q1의 넷 밖으로 더한다. 6D-6을 실으면 6D를 되돌릴 때
  함께 되돌아가 PRO 늦은 합류 (a) 행이 오늘 동작으로 돌아간다.
- **증분을 골라 되돌릴 때:** `a9ee6842`에서 코드 커밋마다 되돌린 결과를 `git merge-tree --write-tree --merge-base=<커밋> <끝> <커밋>^`으로
  만들어 봤다. 6D-1 `dc596f8d`만 되돌리면 `player.ts`, `zero-start-recovery.ts` 같은 런타임 파일이 충돌하므로 6D-1은 6D-2와 함께(거꾸로) 되돌린다.
  6D-2 `f6d7c1e1`, 6D-3 `17d15b9d`, 6D-4 `051a0727`은 런타임 파일 충돌 없이 혼자 되돌아가고 기록 문서(레지스트리, 설계 문서)만 손으로 맞춘다.
  리뷰 뒤 끝 `5267e8b2`에서 같은 계산을 다시 하면(QA 라운드 4) 6D-1과 6D-2, 6D-3은 위와 같고, 6D-4는 `player.ts`에서도 충돌한다: 리뷰 고침
  `5267e8b2`가 6D-4가 쓴 COMMIT 세대 주석 두 줄(`src/youtube/player.ts:925-926`)을 고쳐서다. 주석뿐이라 그 두 줄을 손으로 맞추거나
  `5267e8b2`의 그 부분과 함께 되돌린다(빌드 바이트는 어느 쪽이든 같음).
  6D-1·6D-2의 테스트 먼저 커밋은 함께 되돌린다(새 단위 행이 새 클래스를 요구). 6D-3·6D-4의 테스트 먼저 행은 부모 런타임에서도 통과하므로
  코드 커밋만 되돌려도 초록이다[추론: 부모 실행 근거]. 가드 기준치와 레지스트리는 센 코드를 옮긴 커밋과 함께 되돌아온다(6D-1·6D-2의 CHECK 11
  파일 항목, 6D-3의 바늘).

## 6D-6: 준비함, 만들지 않음, 오너를 기다림

계획 §4.9의 6D-6(Q22 (가), 'intended')이다. 오너가 2026-10-30에 '(가)는 4차 업데이트에서 고침, 만들기 전 사진 먼저'라고 답했으므로 만들지
않고 아래를 준비했다. 오너가 사진을 보고 '예'라고 하면 이 열차의 마지막 런타임 증분(버전 올리기 앞)으로 회귀 행과 실패 시험 먼저 만들고, 이
절을 그 '의도한 변경'의 자기 절로 바꾸며, 사진을 PR 설명과 이 절에 싣는다. '아니요'면 만들지 않고 행은 오늘 동작 그대로 초록이다.

- **언제:** PRO 방에서 YouTube 화면을 아직 갖지 않은 기기가 트랙 준비(PREPARE)를 받았는데, 그 기기의 YouTube 화면이 2.3 s 준비 예산 안에
  손잡기(onReady)를 끝내지 못해 READY가 실패하고 서버가 그 기기 없이 COMMIT할 때다. 그 기기는 COMMIT을 받고 3 s 뒤 방 위치로 따라
  들어온다. 드문 경우다.
- **지금:** 준비 때 `youtube:load`와 'YouTube 함께보기 · 고급 음향 효과가 비활성화돼요' 안내(`youtube.effects_disabled`)가 한 번 나고, COMMIT
  따라잡기가 준비 길을 다시 돌며 `youtube:load`와 같은 안내를 한 번 더 낸다. 그 둘째 불러오기가 아직 손잡기 중인 iframe을 지우고(`destroy`) 새
  iframe을 만들어 손잡기를 처음부터 다시 기다린다. IFrame API 스크립트가 아직 오는 중이면 iframe은 없고 불러오기와 안내만 두 번이다.
- **바뀐 뒤:** 같은 occurrence·영상의 불러오기가 이미 도는 중이면 상주처럼 다뤄 둘째 `youtube:load`를 내지 않는다. 안내 한 번, YouTube 화면
  그대로. 화면이 3초 안에 준비되는 기기에서는 들어오는 순간(COMMIT 받은 뒤 3 s)과 방 위치는 같다. 느린 휴대폰에서는 고친 뒤 그 기기의 소리가
  지금보다 일찍 날 수 있다(지금은 화면을 다시 만드느라 늦게 남). 사진의 시험은 새 화면도 0.5초 만에 준비되게 해서 같아 보인다. 까닭: 지금은
  다시 만든 iframe이 COMMIT 때 손잡기를 처음부터 하고, 그것이 약 2.6 s를 넘으면 3 s 계획이 지나간다(`plannedLateYouTubeTiming`이 남은 시간
  400 ms 아래에서 null, `src/pro-room/playback-controller.ts:363-376`). 그러면 마지막 시도가 바로 따라잡기로 더 늦게 들어온다. 고친 뒤는 첫
  iframe이 3 s 일찍 손잡기를 시작해 계획에 맞출 수 있다. 그 차이의 크기는 재지 않았다. 고칠 모양은 늦은 합류 고정 행을 더한 시험만
  PR(#539)이 적은 첫째 제안이다: `src/player/playlist.ts`의 `prepareAuthoritativePlayback` 재사용 판정(`reuseResidentYouTube`, `:2667-2681`)에서 판정해 `playTrack`의
  `youtube:load`(`:1190`)를 건너뛰고, 준비 이음새 `prepareYouTubeAuthorityOccurrence`(`src/youtube/iframe.ts:2126`)가 장벽 없는 10 s 예산을
  기다린다. 정확한 모양은 만들 때 정한다[추론].
- **고칠 모양의 넓이(리뷰):** 사진에 쓴 임시 고침은 첫 불러오기가 아직 도는 동안 같은 queue 항목·영상의 `prepareAuthoritativePlayback`을 모두
  상주처럼 다룬다. 그 함수는 서버 PREPARE, COMMIT 따라잡기, 장벽 없는 복원과 다시 합류가 함께 지나는 입구다(`src/player/playlist.ts:2643-2681`,
  `:2726-2731`). 그래서 그 모양대로면 첫 손잡기가 느린 동안 같은 곡의 복원이나 로컬 다시 합류도 다시 불러오기와 안내를 하지 않게 되는데,
  공유 길 행 셋도 오너 질문도 그 경우를 다루지 않는다. 만들 때 넷째 공유 길 행(첫 iframe이 손잡기 중일 때 온 같은 YouTube occurrence의 복원
  또는 다시 합류, 양쪽에서)을 더하고, 술어를 COMMIT 따라잡기로 좁히기를 권한다(그러면 오너께 드린 설명 그대로다). 좁히지 않으면 그 경우를
  의도한 변경에 넣어 오너께 다시 적는다.
- **사진(만들기 전에 오너에게, 찍은 것):** 기기 하나(Chromium, 한국어, 휴대폰 화면 390 × 844), 사진 시험 안에 둔 임시 가짜 YouTube
  (`e2e/helpers/fake-yt.ts`가 아님), 합성 방 코드의 PRO 방 흉내. 변형은 하나다: 첫 iframe의 손잡기를 COMMIT 뒤 0.5 s까지 붙잡음(iframe
  손잡기 중). PREPARE를 받은 때(T)부터 여덟 장: T + 0.3, 1.5, 2.7 s(READY 실패 뒤, 안내 사라짐), COMMIT(C, 약 T + 3.0 s) + 0.15 s(지금: 안내
  2, 화면 #1이 지워지고 #2가 생김 / 바뀐 뒤: 안내 없음, #1 그대로), C + 0.45, 1.2(화면 준비), 3.6(방 위치로 들어옴, 둘 다 같음), 5.5 s. 한 장으로
  보기(`frame-sheet.png`)는 그 가운데 다섯(T + 0.3, 2.7, 3.2, 4.2, 6.6 s, 곧 C + 0.2, 1.2, 3.6)이다. '지금'과 '바뀐 뒤'(커밋하지 않는 임시 고침)를
  두 줄로 놓았고, 세는 값(불러오기, 지우기, 플레이어, 안내)은 지금 2·1·2·2, 바뀐 뒤 1·0·1·1로 단위 행과 맞는다. IFrame API 스크립트 오는 중
  변형은 찍지 않았다: 그때는 화면이 없어, 바뀌는 것은 불러오기와 안내 횟수(2 → 1)뿐이다(지우기는 둘 다 없음).
- **실패 시험(만들 때 먼저):** `src/youtube/__tests__/pro-late-prepare-reload.test.ts`의 (a) 행 둘을 뒤집는다. '(a) replays youtube:load and
  the effects toast when the COMMIT catch-up meets a still-loading iframe'(`:405`): 불러오기·안내 2 → 1, `YT.Player` 2 → 1, 첫 iframe의
  `destroy` 없음, `getYouTubePlayer()`가 첫 iframe. '(a) replays youtube:load and the effects toast while the IFrame API script is still
  loading'(`:455`): 불러오기·안내 2 → 1, 스크립트가 오면 플레이어 하나. 들어오는 순간과 위치 단언은 그대로다. 두 행의 제목을 바꾸고 이름으로
  적는다.
- **양쪽에서 통과할 공유 길 회귀 행(실패 시험 앞, 새 묶음, `__helpers__/scripted-iframe-api.ts`):** R1 Standard 방의 YouTube 불러오기는
  `youtube.effects_disabled`를 한 번 띄운다. R2 보통 PRO occurrence 바뀜(READY가 제때)은 `youtube:load`와 안내를 한 번 내고, 제때 온 COMMIT은
  더하지 않는다. R3 다른 영상 A의 iframe이 아직 손잡기 중일 때 온 영상 B의 불러오기는 지금처럼 A를 지우고 새 iframe을 만든다
  (`src/youtube/iframe.ts:1809-1822`, 플레이어 둘, 첫 iframe의 기록 ['destroy']). 오늘 안내 횟수를 세는 행동 시험은 늦은 합류 고정 행뿐이라,
  너무 넓은 고침('occurrence가 바뀔 때만 안내', '불러오는 iframe은 늘 유지')은 이 셋 없이는 실패 없이 Standard 동작을 바꿀 수 있다. R4는 위
  '고칠 모양의 넓이'의 넷째 행이다(아직 쓰지 않음).
- **그대로 초록이어야 할 행:** `src/player/__tests__/playlist.test.ts` 'reuses the exact resident YouTube video during server preparation'
  (`:578`), 'lets an unbarriered YouTube restore wait for a first player load'(`:627`), 'restarts the current YouTube occurrence without
  reloading its iframe'(`:1999`), 'directly hands off a new queue occurrence of the resident YouTube video'(`:2034`), `pro-late-prepare-reload.test.ts`의
  상주 iframe (a) 행(`:497`, 불러오기·안내 0), (b)·(c) 행과 Android 행(`:627`부터), `playback-late-cohort-join.test.ts` 8행,
  `load-lifecycle.test.ts`의 `:383`, `:472`, `:487`, T0a PRO READY 시각 골든.
- **고칠 자리(오늘 줄):** `src/player/playlist.ts:2667-2681`, `:1190`. `src/youtube/player.ts:2889`(`youtube:load` 처리기가 `loadYouTubeVideo`를
  부름). `src/youtube/iframe.ts:1741`(`loadYouTubeVideo`), `:1809-1822`(지우기 문), `:1919`(안내), `:2126`(준비 이음새).
- **혼합 버전:** READY를 놓친 기기의 따라잡기만 바뀌고 서버와 주고받는 프레임과 READY 시각은 같다[추론].
- **크기:** Phase 6 순증 +123 B에서 상한까지 +77 B가 남는다(6C-3을 실으면 그 차도 더함). 넘으면 Q29대로 잰 숫자로 묻는다.
- **되돌리기 메모:** 이 증분만 되돌리면 (a) 행이 오늘 동작으로 돌아간다. 6D를 되돌리면 함께 되돌아간다.
- **열린 항목:** 실으면 'YouTube 재합류 동기화'에도 이 보고서를 잇는다(아래 '열린 항목').

## 열린 항목

[release-record §2의 열린 항목](../release-record.md) 둘에 이 보고서를 잇는다(계획 §4.9). 이 브랜치는 release-record를 바꾸지 않으므로 링크와
아래 문장은 릴리스 담당이 버전 올리기 PR에서 더한다(계획 §4.2-7). 기기 근거 없이 지우지 않는다.

- **'YouTube 첫 음 정렬(S01–S02, XS01–XS04)'(지금 `docs/release-record.md:3469-3472`, 복구 길):** 확인한 것(로컬, 자동): 게스트 로컬 복구와
  방장 레거시 복구가 같은 각본에서 바탕과 같은 명령, 타이머, 프레임을 같은 순간에 낸다(복구 골든 38행이 바탕 런타임과 끝에서 같음), Standard
  방장의 음수 오프셋 대기의 출시 순간과 오프셋(`player.test.ts`의 op 로그 행), T0a 와이어 골든, 로컬 Chromium YouTube spec 열, WebKit YouTube
  활성화 spec. 확인하지 못한 것: 실제 YouTube, iPhone Safari/PWA, 블루투스, 실기기의 귀로 듣는 첫 음.
- **'PRO 시작 시계 현장 확인'(지금 `:3615-3629`):** 확인한 것: PRO 시작 토큰 넷이 저마다 자기 사건에만 움직이고(`pro-start-tokens.test.ts`), arm의
  시작 종류가 Worker와 App의 합집합 하나이며, ZS-06·ZS-09 끝점 행, PRO READY 시각 골든, 늦은 합류 고정 행이 그대로다. 확인하지 못한 것: 현장
  시계 오차의 원인(원시 시계, 실제 선택값, YouTube 관측 표본)과 하트비트가 COMMIT을 앞지른 기기.
- **6D-6을 실으면 'YouTube 재합류 동기화'(`:3473-3478`)에도.**

## Phase 7로 넘기는 것 (계획 §8)

- **계약 셋 그대로:** (a) `youtube:set-volume`은 엔진 볼륨 이벤트마다 정확히 한 번 `Math.round(v * 100)`이고 주인이 hold를 거쳐 한 번 쓴다, (b)
  PRO 관문의 pending·settled가 iframe hold에 닿는다, (c) 시작 탭은 `audio:activate`와 같은 동기 스택에서
  `primeYouTubePlayer({ retryPending: true })`를 부른다. 6D는 셋을 건드리지 않았고 `youtube-iframe-audio-order.test.ts`의 Phase 7 계약 행과
  `setup-start.test.ts`가 그대로다.
- **PRO arm의 원하는 오디오 읽기(S1):** 6C-3의 규칙 하나 뒤나 Phase 7 계약 (a) 아래에서, `youtube-iframe-audio-order.test.ts`를 같은 변경에서
  고치며 한다. 그때 RO-12와 RO-03이 `owner-in-place` 후보가 된다.
- **Phase 6을 `duplicated`로 끝내는 레코드:** RO-02, RO-03, RO-12(위 6D-5). 남는 예외는 RO-33(게스트 복구, 이제 클래스), RO-34(PRO 어댑터
  eager), RO-13(수동 오프셋 owner-in-place, Phase 6은 물림 포트로만), CHECK 12의 넛지 이름 읽기 열하나, CHECK 11의 prime 제스처 unMute와 주차
  hard-mute 증명이다.
- **남기는 중복:** 플랫폼 판별과 플레이어 어댑터 둘(Q27).
- **핵심 커버리지:** Phase 6이 새 모듈 넷(`iframe-audio.ts` 6A-4, `start-ownership.ts` 6B-1, `arm-steps.ts` 6C-4, `zero-start-recovery.ts` 6D-1)과
  `zero-start.ts`, `authority-arm.ts`를 넣었다.
- **번들:** Phase 6의 실측 순증 +123 B(6D-6 앞)를 Phase 7 계획의 기준으로 넘긴다.
- **하네스:** T0a 하네스와 복구 골든의 하네스(진짜 `initYouTube`, 각본의 IFrame API, 한 순서 흔적)를 Phase 7의 'YouTube 모드의 실제 OS 끊김 fence
  창 특성화'의 바탕으로 넘긴다.
- **늦은 합류의 남긴 흠:** Q22 (나) ~ (라)는 기록만이고, `RoomContext.coordinatorId`가 운영에서 늘 null인 것은 Phase 6 뒤 따로 본다.
- **끝 조건 2의 넘겨주기(위 '오너에게' 7):** 오너가 (나)를 고르면 Phase 7이 `player.ts`의 `onFallbackRequired`에 남은 울타리와 들리는 앞섬
  읽기를 `GuestZeroStartRecovery`로 옮기고, 같은 커밋에서 CHECK 12의 실행 스냅샷 읽기 기준치(`player.ts` 8 → 6, 새 항목
  `src/youtube/zero-start-recovery.ts` 2)와 RO-02·RO-33의 '실행 스냅샷은 `player.ts`만 읽음' 문장을 고친다.
- **기기 라운드:** QA052 ~ QA055의 블라인드 결과는 오너 탐색 때다.

## 머지 전에 할 일 (릴리스 담당)

1. **6B와 6C 먼저, 그 위로 옮기기:** 6B와 6C가 main에 들어가 배포·기록된 뒤 이 갈래를 그 main 위로 옮긴다(squash로 들어가면 `bdb5759a` 위의
   이 갈래 커밋만 옮김). 옮긴 테스트 먼저 커밋을 새 부모에서 다시 돌려 같은 이름의 행만 실패하는지 보고, 크기와 가드 수를 다시 잰다.
2. **6D-6:** 오너가 위 '6D-6' 절의 사진을 보고 답한 뒤에만. '예'면 양쪽에서 통과할 회귀 행 넷(셋과 리뷰가 더한 넷째, 위 '고칠 모양의
   넓이'), 실패 시험((a) 행 둘을 뒤집음), 런타임 커밋을
   이 열차의 마지막 런타임 증분(버전 올리기 앞)으로 둔다. '아니요'면 만들지 않는다.
3. **버전 올리기와 문서:** 아래 '배포 조건과 순서' 2, 3.

## 배포 조건과 순서 (릴리스 담당)

1. 한 번에 한 열차, main 런타임이 배포본과 같을 때만: 6B와 6C가 먼저 나가고 그 기록 뒤에 6D를 옮긴다. 이 배포까지 런타임 의존성 변경
   (Dependabot 포함)을 머지하지 않는다.
2. 버전 올리기 커밋(마지막 런타임 커밋): 6C 다음 번호와 epoch를 9.0.30의 버전 올리기와 같은 거울 여섯 파일 일곱 줄에 적는다(`package.json`,
   `package-lock.json` 두 곳, `ADMIN_SCRIPT_VERSION`, `ADMIN_ASSET_VERSION`, `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 캐시
   쿼리, [6A 보고서](phase6-6a-start-constants-owner-queries-2026-10-31.md)). 그 뒤 `guard:sw-cache-version` PASS, `guard:release-identity` 새
   버전, `build:checked` 전체. 계약 동결: 바탕 main..머리의 `cloudflare/` 차이가 `cloudflare/app-worker.ts`의 버전 한 줄뿐인지 본다.
3. 문서(계획 §4.2-7): release-record §2에 이 열차의 '배포 전' 항목(이 보고서 링크, 오너 답, 배포 조건, 되돌리기, 배포 뒤 확인)과 위 '열린 항목'의
   링크와 문장. 레지스트리와 설계 문서는 이미 이 브랜치에 있다. 6D-6을 실으면 그 '의도한 변경'과 실패 시험 커밋을 이 보고서의 자기 절에 더한다.
4. PR CI, 자동 코드 리뷰, dispatch 직전 머지, exact-main CI success 뒤 Release target `app`, Developer API D1 false,
   `raise_app_build_floor` false. 기록 PR을 열차 PR 머지와 deploy job 시작 사이에 머지하지 않는다.
5. 배포 직후(게이트 아님): 공개 최소 빌드 상태와 Operations Drift Audit, 아래 '배포 뒤 확인'. 머지 뒤 main SHA에서 Full E2E를 한 번 돌려
   보고서의 QA 라운드에 적되 exact-main 후보로 쓰지 않는다(계획 §4.2-5). Phase 6 끝 조건 6의 14일은 이 배포부터 센다.
6. 배포 기록 PR: release-record §1과 `Last source review` 덮어쓰기, `docs/release-history.md` 한 행, §2의 이 항목을 '배포 뒤 확인'으로.

## 배포 뒤 확인 (블라인드, 게이트 아님)

계획 §4.9의 기기 후보(QA053, QA054, QA055, 절차는 영역 조사 pro-and-iframe-audio §4.5·§4.7과 계획 §7)다. 확인하는 사람에게는 '절차'만 주고
기준은 주지 않으며, 받은 관찰값을 여기 기준과 견준다. Phase 6 앞의 기준선(Q6)은 재지 않았다. 옛·새 빌드를 섞어 시작하는 기기 행은 두지
않는다(혼합 버전 근거는 T0a 프레임·시각 골든과 복구 골든, P5-D9 C). 기기가 없는 단계는 건너뛰고 '기기 없음'으로 적는다. PRO 단계는 돌리기
전에 그 방의 모든 PRO 탭을 새로 고친다(바닥 795 아래의 열린 탭이 시작마다 3 s를 더할 수 있음, 계획 §5).

**절차(확인하는 사람에게 주는 것, 약 1시간 50분):** 모든 기기가 같은 앱 버전이고(앱 정보의 버전 번호를 적음) 주소 끝에 `?mxqrLog=debug`를
붙여 연다. 새로 고치거나 다시 들어갈 때도 다시 붙인다. 각 단계 뒤 채팅에 `/debug console`을 입력하고 `[YouTube`와 `[PRO`로 시작하는 줄을
시각과 함께 복사하며, PRO 단계는 `/debug sync`의 `youtube-release` 줄도 복사한다.

- **A. 늦게 붙는 일반방 게스트(약 20분):** (1) 데스크톱 Chrome 방장, 데스크톱 Chrome 게스트(개발자 도구 네트워크 'Slow 4G')와 Android Chrome
  게스트. 방장이 YouTube 곡을 시작하고, 느린 게스트의 소리가 몇 초 늦게 붙었는지와 붙은 뒤의 어긋남(같음, 조금, 많이)을 적는다. 다음 곡에서
  한 번 더 한다. (2) iPhone Safari 게스트가 방에 들어온 직후(약 2초 안) 방장이 YouTube 곡을 시작한다. 게스트의 소리가 붙는 때와 어긋남을
  적는다. iPhone에 탭해서 재생(TAP TO PLAY) 화면이 떴는지, 한 번 누른 뒤 방 위치로 붙었는지 적는다.
- **B. 방장의 시작이 실패할 때(약 30분):** (1) 데스크톱 Chrome 방장, 게스트 둘. 방장 기기가 아직 불러오지 않은 YouTube 곡을 고르고, 방장
  기기의 네트워크를 끊은 채 ▶를 누른 뒤 약 12초 끊어 두었다가 다시 잇는다. 콘솔의 `[YouTube ZeroStart]` 경고 줄(`prepare-timeout`이나
  `commit-send-failed`)을 그대로 복사하고, 방 전체가 시작되기까지의 시간과 방장 기기의 소리를 적는다. (2) 방장이 다음 곡을 누른 직후 게스트
  하나의 연결만 몇 초 끊었다 다시 잇는다(그 게스트 기기의 Wi-Fi를 끄고 몇 초 뒤 켬, 페이지는 그대로 둠). 방 전체가 시작되기까지의 시간과
  방장 소리를 적는다. (3) 방장이 다음 곡을 누른 직후 1초 안에 게스트 하나가 페이지를 새로 고친다. 방이 시작되기까지의 시간과 그 게스트가
  다시 붙은 때를 적는다. (4) Android 방장(블루투스 이어폰)으로 (1)을 한 번 한다.
- **C. 음수 수동 오프셋과 반복(약 25분):** 데스크톱 Chrome 방장, iPhone Safari와 Android Chrome 게스트. (1) 방장 수동 오프셋 −5.000 s로 YouTube
  곡을 시작한다. (2) −9.999 s로 다시 한다. (3) 반복 한 곡을 켜고 곡이 두 번 처음으로 돌아가게 둔다. (4) −5.000 s 그대로 곡이 10초를 넘었을 때
  ⏮를 한 번 눌러 곡을 처음부터 다시 시작하고, 다른 때에 재생 중 시간 막대를 0:00으로 옮긴다. 단계마다 방장 스피커가 시작한 때와 모든 기기의
  어긋남을 적는다.
- **D. PRO 세 대(약 35분):** iPhone을 포함한 PRO 기기 셋, 재생목록에 YouTube 둘. (1) 첫 곡을 시작한다. (2) 다음 곡을 누르고 소리가 나기 전
  1초 안에 iPhone이 앱의 일시정지를 누르고 3초 뒤 재생한다. (3) 곡이 재생되는 중에 넷째 기기(AirPods를 낀 iPhone이 있으면 그것)가 방에
  들어온다. (4) 수동 싱크 −5 s인 기기로 다음 곡을 시작한다. (5) 같은 라운드에 iPhone 잠금 화면에서 일시정지, 5초 뒤 재생한다. 단계마다 모든
  기기의 소리, 짧게 새는 소리가 있었는지, 늦게 들어온 기기가 붙은 때를 적는다. iPhone마다 탭해서 재생(TAP TO PLAY) 화면이 떴는지, 한 번
  누른 뒤 방 위치로 붙었는지 적는다.

**통과 기준(주지 않음):**

- A: 느린 게스트만 늦게 붙고(콘솔에 `[YouTube ZeroStart] Falling back locally`, `Recovered locally`), 방장과 다른 게스트는 제때 시작한다. 붙기
  전에 예열 소리가 새지 않고, 붙은 뒤 소리 크기가 설정과 같다. `Local fallback failed:`가 있으면 그 줄을 따로 적는다. (2)에서 iPhone이 탭해서
  재생 화면을 띄웠다면 복구 줄 없이 레거시로 시작해도 맞다(소리가 풀리지 않은 iPhone은 zero-start 실행에서 빠짐).
- B: (1)·(4) 콘솔에 `[YouTube ZeroStart] prepare-timeout`이나 `commit-send-failed` 줄이 있으면, 방장이 3초 다리 안에 다시 이어졌을 때는
  `Falling back to legacy rendezvous`가, 아직 끊겨 있었으면 `Legacy recovery timed out`이 그 뒤에 온다. 어느 쪽이든 방장 기기는 다시 이어진
  뒤 음소거로 남지 않는다. 그 줄이 없으면 '복구가 일어나지 않음'으로 적고 실패가 아니다. `Legacy recovery timed out`은 따로 적는다(T0b 결함
  1의 길, 오너 답 전). (2) 게스트가 장벽 안에 다시 이어지면 약 2초 뒤 `Falling back to legacy rendezvous` 줄이 오고 방장이 음소거로 남지
  않는다. 다시 이어진 때가 장벽 뒤면 '일어나지 않음'으로 적고 실패가 아니다(자동 근거는 골든의 H3·H3b). (3) 방은 그 게스트 없이 제때
  시작하고, 그 게스트는 늦은 합류로 붙으며 레거시 줄은 없다(새로 고친 게스트는 새 연결로 들어와 방장에게 나감과 새 입장으로 보임).
- C: 방장 스피커가 대기 동안 멈춰 있다가 방 시계에 맞춰 시작하고 게스트와 어긋나지 않는다. 반복 곡이 다시 시작될 때도 오프셋이 유지된다.
  (4)는 게스트가 재생하는 동안 방장 스피커가 약 5초 0:00에 멈춰 있다가 게스트와 맞춰 시작한다.
- D: 모든 PRO 기기가 제때 시작하고, (2)는 준비가 끝나도 소리가 새지 않고 일시정지가 이긴다. (3)의 기기는 방 위치로 붙는다(`youtube-release`의
  path·timingMode로 판정). (5)는 그 기기만 멈췄다가 방 시계에 맞춰 다시 붙는다. 블루투스 기기의 첫 음이 잘리지 않는다.
- A(2)와 D의 iPhone: 탭해서 재생은 iPhone마다 세션에 많아야 한 번이고, 탭 전에는 소리가 나지 않으며, 탭 뒤에는 방 위치로 붙는다.

**실패하면:** 일시적 네트워크로 설명되지 않으면 위 '되돌리기'대로 앞으로 고치기나, 급할 때만 명시적으로 검토한 CLI 되돌리기로 checkpoint
App을 정한다. 증상의 경로(게스트 복구, 방장 복구, 로컬 시작 대기, PRO 토큰)를 적는다. '기기 없음'과 '미확인'은 실패가 아니다.

## 사용자가 알아챌 변화

없다. 버전 올리기와 함께 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 넷째이자 마지막, 창 모양은 지금 그대로). 처음 받는 코드는 gzip 기준 JS
291 B, 전체 293 B 늘고 raw로는 전체 252 B 는다(6C와 런타임이 같은 바탕 대비, 버전 올리기 앞, 위 '번들 크기'). 6D-6은 만들지 않았으므로 늦게
합류하는 PRO 기기의 안내 두 번도 그대로다.

## 기록과 레지스트리

- 이 브랜치: 레지스트리 RO-02(두 복구, 로컬 시작 대기, Phase 6 끝 상태), RO-03(토큰 넷, 합집합, 밀기, Phase 6 끝 상태), RO-12(셋째 박자, 모듈 안의
  두 정리, CHECK 11 역사, 밀기를 남기는 이유, Phase 6 끝 상태), RO-13(물림 포트 문장), RO-33(클래스와 단계)과 가드 항목 5·11·12, 설계 문서
  `docs/design/youtube-start-ownership.md`(모듈 표, claim 표, 'The PRO start tokens', 'Not covered yet', 'Verification', 'Applies to'),
  `docs/qa-domains.md` QA053, 핵심 커버리지 등재(`zero-start-recovery.ts`와 두 시험 파일), 이 보고서와 `docs/README.md` 증거 목록. 6D-5의 기록
  말고는 모두 센 코드나 규칙을 옮긴 커밋과 같은 커밋이다.
- 레지스트리 상태는 RO-02, RO-03, RO-12 모두 `duplicated` 그대로다(6D-5가 남은 기계와 `owner-in-place`가 될 변경을 적음). 레지스트리 머리의
  `Last source review`는 기록을 코드와 다시 맞추는 PR이 고친다.
- 리뷰 반영(주석·기록 고침 커밋): 색인의 Consolidation 칸 셋(RO-02·RO-03 '0d, 6 done; rest: decision', RO-12 '6 done; pushes: 6C-3 or 7',
  CHECK 1은 Status 칸만 견주어 가드 그대로), RO-02의 앵커(두 복구의 토큰 행, 울타리의 실행·영상 확인을 함께 고정한다는 문장, 로컬 시작 대기의
  첫 울타리와 물림의 타이머 지우기), RO-03과 설계 문서 'The PRO start tokens'와 `player.ts` 주석의 COMMIT 세대 문장(idle이 아니고 큐 항목을
  가진 COMMIT과 해체가 옮김. `request.queueItemId`가 null인 COMMIT은 세대를 옮기기 전에 돌아감).
- 리뷰 뒤 마지막 검사의 기록 커밋: 이 보고서의 QA 라운드 4와 그 값을 적은 머리 표, 'T0a·T0b·6B·6C 파일', 끝 조건, 가드, 번들 크기의
  문장, 시험 쪽 관찰 하나(아래 '하지 않은 것과 확인하지 않은 것'), 그리고 보고서 파일 이름을 계획한 이름
  `phase6-6d-recovery-pro-arm-2026-11-02.md`로 바꿈(`cb2279ba`가 `phase6-6d-recovery-pro-tokens-2026-11-02.md`로 더했고, 그 이름을 잇는 곳은
  `docs/README.md`의 항목 하나라 같은 커밋에서 고침). 런타임, 시험, 가드, 레지스트리, 설계 문서는 바꾸지 않았다.
- 릴리스 담당이 버전 올리기와 함께: release-record §2의 6D 항목과 열린 항목 연결, 그리고 배포 뒤 기록 PR(위 '배포 조건과 순서' 3, 6).

## 오너에게

1. **[화면 바뀜: '예'면 PRO 방에서 곡 준비가 늦어 뒤늦게 합류하는 기기에서 'YouTube 함께보기' 안내가 두 번 대신 한 번 뜨고, 불러오던 YouTube
   화면이 지워졌다 다시 생기지 않아요. 느린 휴대폰에서는 그 기기의 소리가 지금보다 일찍 날 수 있어요] 6D-6: 사진처럼 바꿔도 될까요?**
   2026-10-30에 '4차 업데이트에서 고침, 만들기 전 사진 먼저'라고 하셨어요. 언제: 그 곡을 받을 때 아직 YouTube 화면이 없던 기기(예: 들어와서
   처음 듣는 YouTube 곡)의 화면이 2.3초 안에 준비되지 못해 방이 먼저 시작하고 약 3초 뒤 따라 들어올 때예요(드묾). 지금: 준비 때 안내 한 번,
   방이 시작될 때 같은 안내 한 번 더, 불러오던 화면이 지워졌다 새로 만들어져요. 바뀐 뒤: 안내 한 번, 화면 그대로예요. 화면이 3초 안에 준비되는
   기기에서는 들어오는 때와 위치는 같아요. 느린 휴대폰에서는 고친 뒤 그 기기의 소리가 지금보다 일찍 날 수 있어요(지금은 화면을 다시 만드느라
   늦게 나요). 사진의 시험은 새 화면도 0.5초 만에 준비되게 해서 같아 보여요. 일반방 불러오기, 보통 PRO 트랙 바꾸기, 다른 영상을 불러오는 중에
   또 바꾸는 경우는 지금 그대로예요. 사진(지금과 바뀐 뒤를 다섯 장씩)은 따로 드려요.
   - (가, 권장) 예: 사진대로 4차 업데이트(6D)의 마지막 단계로 만들어요(지금 그대로 지킬 행 넷과 실패하는 시험 먼저). 업데이트 창은 늘지 않아요.
   - (나) 아니요: 만들지 않고 지금 동작을 시험에 고정한 그대로 둬요.
2. **[화면 바뀜: 고치기로 하실 때만, 그 경우 그 시작이 0:00에서 멈추지 않고 이어짐] 시험이 새로 찾은 것 하나: 기록만 하기를 권해요.**
   일반방 방장의 옛 방식 복구(방장 시작이 실패한 뒤 약 3초 안에 YouTube 화면을 0:00에 맞춰 옛 방식으로 넘기는 단계)에서, 방 안에 없던
   영상을 0:00으로 옮겼는데 그 자리가 0.35초 넘게 어긋나면 다시 옮기지 않고
   3초가 끝날 때까지 기다리다 포기해요. 포기한 뒤는 T0b 결함 1과 같이 0:00에 멈춘 채 안내가 없어요. 방 안에 이미 있던 영상은 다시 옮기고,
   참가자 복구 코드도 같은 모양이에요. 실제 YouTube에서 0:00으로 옮긴 자리가 0.35초 넘게 어긋나는지는 기기에서 보지 못했어요. 오늘 동작으로
   시험에 고정해 두었어요('waits out its bridge without seeking again when a settle lands a loaded target past the tolerance').
   - (가, 권장) 기록만 하고 지금 고치지 않아요. 고치면 그 경우 시작이 성공하게 되어 [화면 바뀜]이라, 기기에서 어긋남이 보이면 그때 여쭤요.
     고친다면 Phase 7이에요.
   - (나) 6D의 마지막 단계로 고쳐요(업데이트 창은 늘지 않음, 시험 먼저, 만들기 전 전후 표).
3. **[화면 그대로] PRO 기기의 소리 설정을 읽는 방식은 이번에 바꾸지 않았어요: 정하실 것은 없어요.** 계획은 PRO 기기가 YouTube 소리 설정을 한 곳에서
   직접 읽게 하려 했지만, 마스터 볼륨이 0과 0.5 % 사이일 때 소리가 달라질 수 있어 화면·소리를 그대로 두는 열차에서는 하지 않았어요. 6C-3의 규칙
   하나가 들어간 뒤나 Phase 7에서 다시 봐요.
4. **[화면 그대로] 첫 로딩 크기: 정하실 것은 없어요.** 6D는 앱을 처음 열 때 받는 양을 압축 기준 291바이트 늘려요(6C 대비). Phase 6 전체로는
   123바이트 늘었고 상한(200바이트) 안이에요. 6D-6을 만들 때 쓸 수 있는 남은 몫은 77바이트예요.
5. **[화면 그대로] 6D를 언제 낼지: 권장은 '6B와 6C가 나가 기록된 뒤, 6D-6 답을 받아 반영하고, 자동 관문을 모두 통과하면 낸다'예요.** 화면과
   소리는 그대로이고(6D-6을 '예'로 하시면 위 경우만 달라짐) 업데이트 창만 한 번 떠요(Phase 6 넷 가운데 마지막). 릴리스 담당이 정해요. 6D에
   문제가 있어 되돌리면 그때 운영 중인 앱(6C)으로 돌아가요.
6. **[화면 바뀜: 고치기로 하실 때만] T0b 결함 넷(2026-11-01에 따로 여쭘)은 아직 답을 기다려요.** 결함 1(방장 기기의 YouTube 시작이 끝내 실패하면 안내
   없이 0:00에 멈춘 채 잠금 화면만 '재생 중')과 결함 2(다음 트랙 준비가 실패한 참가자의 재생 버튼이 약 2.7초 ▶ 모양)는 권장이 이 열차의 마지막
   단계라, 고치기로 하시면 6D-6과 함께 그 자리에
   두고 만들기 전에 사진이나 표를 먼저 드려요. 답이 없으면 싣지 않아요.
7. **[화면 그대로] Phase 6 끝 조건 하나를 어떻게 볼지: 권장은 (가)예요.** 계획의 끝 조건 2는 '참가자 복구를 감싸는 코드 묶음
   (`onFallbackRequired`)이 `player.ts`에서 없어짐'이었어요. 6D는 복구의 몸통을 새 파일로 옮겼지만, `player.ts`에는 복구에 일을 넘겨주는 짧은
   묶음이 남았어요(역할 확인, 앞 복구 지우기, 기기의 소리 앞섬 읽기, 복구가 시도마다 묻는 울타리). 이것을 '몸통이 없으니 끝'으로 읽은 것은 이
   열차가 정한 것(D9)이라 여쭤요. 화면과 소리는 어느 쪽이든 같아요.
   - (가, 권장) 그 읽기를 받아 끝 조건 2를 '참'으로 봐요. 남은 넘겨주기는 기록에 적어 둬요.
   - (나) Phase 7에서 울타리와 소리 앞섬 읽기도 복구 클래스로 옮겨요. 그 변경이 같은 커밋에서 가드 기준치(실행 스냅샷 읽기: `player.ts` 8 → 6,
     `START_RUN_SNAPSHOT_BASELINE`에 `src/youtube/zero-start-recovery.ts` 2를 더함)와 레지스트리 RO-02·RO-33의 '실행 스냅샷은 `player.ts`만
     읽음' 문장을 고쳐요. 그때까지 끝 조건 2는 '아님'으로 남아요.

## QA 라운드

모두 Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, vite 8.3.3, `--maxWorkers=4`, Playwright 1.63.0(Chromium 1243, WebKit 2359),
포트 4795 / 9795, trace 끔(따로 적은 것 말고).

### 1. 구현 중 증분별 검사 (2026-11-02 09:44 ~ 15:55 KST)

이 갈래의 worktree(`npm ci` 482 packages)에서. 증분마다 테스트 먼저 커밋을 부모 런타임에서 돌리고(코드 커밋을 stash로 빼거나 런타임 파일을
테스트 먼저 커밋에서 되살림, 끝에 작업 트리 깨끗), 코드 커밋에서 아래를 돌렸다.

- **바탕 `bdb5759a`(09:44 ~ 10:18):** 단위 전체 744 files, 17,883행 가운데 17,882 통과·1 건너뜀, 가드 모두 OK(위 '정확한 개수 가드'의 바탕
  열), 핵심 커버리지 103 files / 4,268, 로컬 Chromium YouTube spec 여덟(계획 §4.2-3) 41 / 41, 로컬 WebKit `setup-youtube-activation` 4 / 4, 크기
  (위 '번들 크기'의 바탕 행).
- **6D-1 `dc596f8d`:** 단위 전체 746 files 17,937 통과·1 건너뜀, typecheck·lint·format 통과, 핵심 커버리지 105 files / 4,319
  (`zero-start-recovery.ts` 99.44 / 97.14 / 100 / 100), Chromium 41 / 41(코드 커밋 11:37 ~ 11:49, 테스트 먼저 커밋 11:57 ~ 12:09). WebKit은
  `iframe.ts`를 건드리지 않아 돌리지 않았다.
- **6D-2 `f6d7c1e1`:** 단위 전체 746 files 17,979 통과·1 건너뜀, typecheck·lint·format 통과, 핵심 커버리지 105 files / 4,359
  (`zero-start-recovery.ts` 99.29 / 96.98 / 100 / 100. 첫 실행은 분기 95.78로 문턱에 걸려, 닿을 수 있는 분기 행을 테스트 먼저 커밋에 더함),
  Chromium 41 / 41(13:17 ~ 13:30).
- **6D-3 `17d15b9d`:** 단위 전체 746 files 17,982 통과·1 건너뜀, typecheck·lint·format 통과, 핵심 커버리지 105 files / 4,359, 바꾼 시험 파일 둘을
  seed 7, 31, 4242, 20261030으로 섞어 210 / 210씩, Chromium 41 / 41(14:23 ~ 14:35, 음수 수동 오프셋 행 `:90` 포함. 그 행은 zero-start로
  시작해 6D-3의 원시에 닿지 않는다, 위 6D-3 '그대로 통과').
- **6D-4 `051a0727`(빌드·Playwright·커버리지·타입 검사는 주석만 다른 첫 판 `bcbe9c80`에서, 운영 빌드 바이트 같음):** 단위 전체 747 files 17,986
  통과·1 건너뜀, typecheck·lint·format 통과, 핵심 커버리지 105 files / 4,359(`authority-arm.ts` 89.63 / 82.6 / 98.61 / 93.89, 바탕과 같음), 토큰
  관련 세 파일을 네 seed로 섞어 13 / 13씩, Chromium 41 / 41(15:26 ~ 15:38), WebKit 4 / 4(15:40).
- 위 '증분' 절의 변이 확인(6D-4)도 이 라운드다(운영 파일을 잠깐 바꿔 돌리고 바이트 그대로 되돌림).

### 2. 리뷰 전 마지막 검사 (`a9ee6842`, 그 뒤는 보고서 커밋 `cb2279ba`뿐, 2026-11-02 16:09 ~ 17:34 KST)

이 갈래의 worktree에서. 시작할 때 같은 PC에서 다른 node 작업은 돌지 않았고, 이 검사의 실행은 하나씩 차례로 돌렸다. 앞뒤로 작업 트리는
깨끗했다.

- **단위 전체(파일 순서):** 747 files, 17,987행 가운데 17,986 통과, 1 건너뜀(`release-deployment-state.test.ts`의 jq가 필요한 한 행, jq가
  없는 PC에서 CI 밖이면 건너뜀), 실패 0(16:09 ~ 16:20). 다시 돌린 것 없음. T0a 골든과 고정 행(와이어 골든 16, PRO READY 시각 골든 10, 로그 동결
  13, 정지·해체 14, 시작 소유 경계 24, 시작 종류 끝점 6, arm 취소 토큰 4, 복원 박자 58, 방 전환 6, 보임 8, 타이머 주인 질의 49, 늦은 합류 7과 8,
  시간 parity 10), T0b 참값표 62와 19, 6B 행 34와 5, 6C 행(라우터 9, 음향 순서 19, 주인 37, 무장 단계 37, 무장 골든 63, `local-offset` 31)이
  바탕 수 그대로이고, 6D의 복구 골든 38, 복구 단위 53, 토큰 4, `player.test.ts` 140, `sync-integration.test.ts` 243, 가드 자체 시험 104가 모두
  통과한다.
- **shuffle(`src/youtube`, `src/player`, `src/pro-room`, seed마다 한 번):** 247 files, 6,788행. seed 7, 31, 4242, 20261030 모두 6,788 / 6,788.
- **바꾼 시험 파일 seed 1 ~ 16:** 9 files(새 셋과 고친 여섯, 가드 자체 시험 포함), 667행. seed 열여섯 모두 667 / 667.
- **중립 두 방향:** 위 'T0a·T0b·6B·6C 파일'(바탕 시험 파일을 끝 런타임에서 562 / 563, 새·바꾼 고정을 바탕 런타임에서 509 / 510과 새 단위
  파일의 불러오기 실패, 실패는 모두 적은 이음새).
- **`npm run typecheck`**(99 s, 앱·시험·Worker·browser-classic·node-scripts·tooling·e2e 프로젝트), **`npm run lint`**(130 s),
  **`npm run format:check`**(53 s), **`npm run check:workers`**(20 s): 모두 종료 코드 0.
- **`build:checked`의 25 단계를 하나씩:** `guard:sw-cache-version` 하나만 실패했다(위 'Version'의 글 그대로, App 18 파일). 나머지 24 단계는
  통과했다: authored JS 둘(0 remaining, 107 retired; 0 inline), TypeScript project coverage 1,574 files / 19 projects, classic runtime 15,
  auxiliary browser 2, service worker(v803), UI kit 10, release identity 'MUSIXQUARE 9.0.30; service-worker cache epoch v803', brand
  capitalization 1,038, declaration ownership 10, source complexity, room authority(79 / 22 / 13 / 0 / 0, 412 files), profanity, hreflang 43,
  sitemap 93, `npm run build`, legacy TV(Chromium 79, `main-ojgPFHeO.js`), service worker build(v803, 바이트 동일), UI kit build, initial
  transfer budget(위 '번들 크기'), prod hooks, prod security, 글꼴(44 stacks), SW 앱 셸 96 assets.
- **그 밖 `guard:*` 13개도 모두 통과**(`package.json`의 `guard:*` 37개 가운데 실패는 위 하나): bus-pairing 202 / 202, chunk-pump(412 files),
  transport-health(12 files), import-graph(412 files, 2,114 edges, 순환 0), lifecycle-writes, navigation-sinks, dead-exports(412 / 2,180 / 0 /
  20 / 76), font assets, standard-room hot path, Developer API boundaries, D1 migrations(19), ops drift contract, Playwright API.
- **`node scripts/check-resource-ownership.mts`와 `--report`:** 49 records, 459 production files, CHECK 11 20, CHECK 12 읽기 11·지우기 9, 파사드
  쓰기 2, 스냅샷 읽기 8, 장부 합성 1, CHECK 5 1 / 1 / 45, `--report` 107줄(위 '정확한 개수 가드').
- **크기:** `build:checked`의 운영 빌드를 `measureInitialTransfer`로 읽었다: `main-ojgPFHeO.js` 859,957 / 253,963, eager JS gzip 465,730,
  eager total 2,047,596 / 543,922(6D-4 코드 커밋과 같음, 바탕 대비 위 '번들 크기'). `dist/`의 .js, .mjs, .html, .css 276 파일의 SHA-256이 6D-4
  코드 커밋의 빌드와 모두 같다.
- **`npm run test:coverage:critical`**(`--maxWorkers=4`): 105 files / 4,359 통과, 전체 84.63 / 79.82 / 90.43 / 88.29(문턱 73 / 66 / 80 / 78), 파일별
  문턱 오류 없음(108 s). `zero-start-recovery.ts` 99.29 / 96.98 / 100 / 100(문턱 98 / 96 / 99 / 99), `authority-arm.ts` 89.63 / 82.6 / 98.61 /
  93.89(문턱 86 / 80 / 97 / 91), `zero-start.ts` 88.84 / 85.45 / 100 / 92.47(문턱 84 / 83 / 96 / 88). `arm-steps.ts`, `iframe-audio.ts`, 장부는
  문턱 99에서 빠짐없이 덮여 표에 나오지 않는다.
- **Worker 커버리지(`vitest.workers.config.ts`, 6D-4가 그 프로필의 `pro-room-playback-timing.test.ts`를 고쳐서):** 69 files / 3,325 통과,
  86.7 / 83.54 / 94.34 / 90.97, 문턱 오류 없음(107 s).
- **`npm run build:e2e` 뒤 로컬 Playwright(포트 4795 / 9795, trace 끔):** `test:e2e:critical`의 여덟 파일 101 / 101(5.9분, 17:15 ~ 17:21),
  YouTube spec 열 개(`e2e/youtube*.test.ts`, Chromium) 53 / 53(12.5분, 17:21 ~ 17:33). 그 가운데 계획 §4.2-3의 여덟(`youtube-sync` 6,
  `youtube-manual-zero-start` 10, `youtube-output-delay` 3, `youtube-end-transition` 6, `youtube-native-operator` 2, `youtube-manual-repeat` 1,
  `youtube-pending-seek` 4, `youtube` 9, 느린 게스트 복구 중 Sync `:157`과 음수 수동 오프셋 `:90` 포함)은 41 / 41로 6A ~ 6C의 41과 같고, 나머지
  둘(`youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8)은 12 / 12다. 로컬 WebKit(`playwright.webkit.config.ts`, iPhone 13)
  `setup-youtube-activation.test.ts` 4 / 4(16 s, 계획 §4.2-4). 실패, 다시 시도, 불안정 표시는 없다(설정 `retries: 0`). 끝난 뒤 두 포트에 남은
  listener는 없다.
- **배포 대상과 계약 동결:** 위 'Deploy target'. **끝 조건 대조:** 위 'Phase 6 끝 조건'의 `git grep`과 `git diff`.

### 3. 리뷰 반영 (`6e3bd6f5`와 그 뒤 주석·기록 고침 커밋, 2026-11-02 19:28 ~ 20:05 KST)

이 갈래의 worktree에서. 리뷰가 찾은 것 가운데 높음·중간 전부와 싼 낮음을 반영했다(시험 먼저). 런타임 바이트는 바뀌지 않는다. 아래 (a) ~
(d)는 `zero-start-recovery.test.ts`의 새 게스트 행이다: (a) `clear()` 뒤로 빠져나간 시도, (b) 검증 정리 중인 포기 뒤로 빠져나간 시도, (c)
검증 정리 중 `clear()` 뒤로 빠져나간 정리 재시도, (d) 확인된 출시 뒤로 빠져나간 시도.

- **시험 행(`6e3bd6f5`, 시험만):** `player.test.ts` 141(새 행 하나: YouTube 세션만 바뀐 뒤 늦게 울린 음수 시작 출시가 따라잡기 seek 앞의 첫
  울타리에서 멈춤. 그리고 수동 편집 행의 `'yt-host-local-start'` null 단언), `zero-start-recovery.test.ts` 58(게스트 (a) ~ (d), 방장의
  `cancel()` 뒤로 빠져나간 검증 정리 재시도 하나). 부모 `cb2279ba`에서 199 / 199. 바탕 런타임(`src/youtube`의 런타임 아홉 파일을 `bdb5759a`
  것으로 되돌리고 복구 모듈을 지움, 바탕과의 런타임 차이 없음을 확인, 끝에 HEAD로 되돌려 깨끗)에서 새 `player.test.ts` 141 / 141.
  `typecheck:tests`(34 s), 두 파일의 eslint와 prettier 통과.
- **변이 확인(하나씩 넣고 그 파일을 돌린 뒤 git으로 바이트 그대로 되돌림):** `player.ts` 출시의 첫 울타리(`:686`)를 지우면 새 행 하나만,
  물림의 `clearManagedTimer('yt-host-local-start')`(`:658`)를 지우면 수동 편집 행 하나만 실패한다(141 가운데 140 통과). `zero-start-recovery.ts`:
  `clear()`가 게스트 세대를 옮기지 않으면 (a)와 (c), 포기가 정리 세대를 새로 잡지 않으면 (b), 확인된 출시가 세대를 옮기지 않으면 (d), 포기의
  낡음 확인이나 시도의 세대 확인을 지우면 (a)·(b)·(d), 게스트 검증 정리의 현재 확인을 늘 참으로 하면 (c), 방장 검증 정리의 현재 확인을 늘
  참으로 하면 방장 행이 실패하고, 58 가운데 나머지는 통과한다. `finishUnavailable`의 세대 확인은 지금처럼 닿을 수 없는 방어다.
- **주석·기록 고침:** `player.ts`의 COMMIT 세대 주석 하나와 문서. `npm run build`의 `dist/` .js, .mjs, .html, .css 276 파일이 고치기 전
  빌드와 SHA-256으로 모두 같다(`main-ojgPFHeO.js`). 곧 eager JS gzip 465,730 그대로다(부모 대비 0, Phase 6 누계 +123 B 그대로).
- **단위 전체(파일 순서, 레지스트리를 고친 트리):** 747 files, 17,993행 가운데 17,992 통과, 1 건너뜀(jq 행), 실패 0(19:43 ~ 19:53). 다시 돌린
  것 없음. 복구 골든 38, 복구 단위 58, `player.test.ts` 141, `sync-integration.test.ts` 243, 가드 자체 시험 104가 통과한다.
- **shuffle(바꾼 시험 파일 둘, seed 7, 31, 4242, 20261030):** 모두 199 / 199.
- **`npm run lint:app`**(88 s), **`npm run format:check:app`**(35 s): 종료 코드 0. 바꾼 문서 넷은 prettier 검사를 통과한다.
- **`node scripts/check-resource-ownership.mts`와 `--report`:** 49 records, 459 production files, CHECK 11 20, CHECK 12 11 / 9 / 2 / 8 / 1,
  CHECK 5 1 / 1 / 45, `--report` 107줄로 모두 그대로다. `guard:dead-exports` 412 / 2,180 / 0 / 20 / 76 그대로.
- **핵심 커버리지(`--maxWorkers=4`):** 105 files / 4,364 통과(새 단위 행 다섯), 전체 84.63 / 79.83 / 90.43 / 88.29, 문턱 오류 없음(98 s).
  `zero-start-recovery.ts` 99.64 / 97.59 / 100 / 100(전 99.29 / 96.98 / 100 / 100).
- **끝 조건 대조:** 위 'Phase 6 끝 조건' 2의 grep을 브랜치 끝에서 적은 범위대로 다시 돌렸다.
- **다시 돌리지 않은 것:** 빌드 바이트가 같고 런타임 경로가 바뀌지 않아 Playwright, WebKit, Worker 커버리지, `build:checked` 전체와
  `npm run typecheck` 전체는 다시 돌리지 않았다(QA 라운드 2의 결과 그대로). 리뷰 뒤 끝에서 QA 라운드 4가 모두 다시 돌렸다.

### 4. 리뷰 뒤 마지막 검사 (`5267e8b2`, 그 뒤는 이 기록 커밋뿐, 2026-11-02 20:10 ~ 21:28 KST)

이 갈래의 worktree에서, 리뷰 반영을 마친 브랜치 끝에서 라운드 2의 마지막 검사를 모두 다시 돌렸다. 시작할 때 같은 PC에서 다른 node 작업은
돌지 않았고, 실행은 하나씩 차례로 돌렸다. 앞뒤로 작업 트리는 깨끗했다(중립 실행과 바탕 빌드가 `git restore`로 바꾼 파일은 그때마다 HEAD로
되돌렸고, 되돌린 뒤 `git status`가 비어 있었다).

- **단위 전체(파일 순서):** 747 files, 17,993행 가운데 17,992 통과, 1 건너뜀(`release-deployment-state.test.ts`의 jq 행), 실패 0(560 s, 20:10 ~
  20:20). 다시 돌린 것 없음. 라운드 2가 적은 T0a 골든과 고정 행, T0b 참값표 62와 19, 6B 행 34와 5, 6C 행이 같은 수로 통과하고, 6D의 복구
  골든 38, 복구 단위 58, 토큰 4, `player.test.ts` 141, `host-local-rendezvous.test.ts` 70, `sync-integration.test.ts` 243, 가드 자체 시험 104가
  통과한다.
- **shuffle(`src/youtube`, `src/player`, `src/pro-room`, seed마다 한 번):** 247 files, 6,794행(라운드 2보다 리뷰 행 여섯이 많음). seed 7, 31,
  4242, 20261030 모두 6,794 / 6,794.
- **바꾼 시험 파일 seed 1 ~ 16:** `git diff --name-only bdb5759a..5267e8b2`의 시험 파일 아홉(새 셋과 고친 여섯, 가드 자체 시험 포함), 673행.
  seed 열여섯 모두 673 / 673.
- **중립 두 방향:** 위 'T0a·T0b·6B·6C 파일'. 바탕 시험 파일 여섯을 끝 런타임에서 563 가운데 562, 새·바꾼 고정 여덟 파일을 바탕 런타임에서 511
  가운데 510과 새 단위 파일의 불러오기 실패이고, 실패는 라운드 2와 같은 이음새다. 리뷰가 더한 `player.test.ts` 행도 6C 런타임에서 통과한다.
- **`npm run typecheck`**(92 s), **`npm run lint`**(115 s), **`npm run format:check`**(48 s), **`npm run check:workers`**(18 s): 모두 종료 코드 0.
- **`build:checked`의 25 단계를 하나씩:** `guard:sw-cache-version` 하나만 실패했다(위 'Version'의 글, App 18 파일 목록이 라운드 2와 같음).
  나머지 24 단계는 라운드 2와 같은 값으로 통과했다(brand capitalization만 이 보고서를 더해 1,039): legacy TV `main-ojgPFHeO.js`, room
  authority 79 / 22 / 13 / 0 / 0(412 files), initial transfer budget(entry 839.8 KiB raw / 248.0 KiB gzip, eager JS 454.8 KiB gzip, eager
  total 1,999.6 KiB raw / 531.2 KiB gzip), service worker build v803 바이트 동일, SW 앱 셸 96 assets 등.
- **그 밖 `guard:*` 13개도 모두 통과**(`package.json`의 `guard:*` 37개 가운데 실패는 위 하나): bus-pairing 202 / 202, chunk-pump(412 files),
  transport-health(12 files), import-graph(412 files, 2,114 edges, 순환 0), lifecycle-writes, navigation-sinks, dead-exports(412 / 2,180 / 0 /
  20 / 76), font assets, standard-room hot path, Developer API boundaries, D1 migrations(19), ops drift contract, Playwright API.
- **`node scripts/check-resource-ownership.mts`와 `--report`:** 49 records, 459 production files, CHECK 11 20, CHECK 12 11 / 9 / 2 / 8 / 1,
  CHECK 5 1 / 1 / 45, `--report` 107줄이 라운드 2의 출력과 글자까지 같다.
- **크기:** 바탕 빌드(중립 실행의 바탕 런타임 트리에서 `npm run build`)는 `main-BDpc0SkS.js` 859,737 / 253,698, eager JS gzip 465,439, eager
  total 2,047,344 / 543,629로 6C 보고서의 끝 값, 라운드 1과 같다. 끝의 `build:checked` 빌드는 `main-ojgPFHeO.js` 859,957 / 253,963, eager
  JS gzip 465,730, eager total 2,047,596 / 543,922이고, `dist/`의 .js, .mjs, .html, .css 276 파일의 SHA-256이 라운드 2(`a9ee6842`)의 빌드와
  모두 같다. 6D 순증 +291 B, Phase 6 누계 +123 B 그대로다(위 '번들 크기').
- **`npm run test:coverage:critical`**(`--maxWorkers=4`): 105 files / 4,364 통과, 전체 84.63 / 79.82 / 90.43 / 88.29, 파일별 문턱 오류 없음
  (96 s). 라운드 3의 분기 79.83과 다른 것은 6D 밖 `src/network/pro-system-audio-direct.ts`의 분기 하나가 실행마다 달라서다(12,490과 12,491 /
  15,646, 라운드 2도 79.82). `zero-start-recovery.ts` 99.64 / 97.59 / 100 / 100, `authority-arm.ts` 89.63 / 82.6 / 98.61 / 93.89,
  `zero-start.ts` 88.84 / 85.45 / 100 / 92.47.
- **Worker 커버리지(`vitest.workers.config.ts`):** 69 files / 3,325 통과, 86.7 / 83.54 / 94.34 / 90.97, 문턱 오류 없음(94 s).
- **`npm run build:e2e` 뒤 로컬 Playwright(포트 4795 / 9795, trace 끔):** `test:e2e:critical`의 여덟 파일 101 / 101(5.7분, 21:09 ~ 21:15),
  YouTube spec 열 개(Chromium) 53 / 53(12.3분, 21:15 ~ 21:27). 그 가운데 계획 §4.2-3의 여덟(`youtube-sync` 6, `youtube-manual-zero-start` 10,
  `youtube-output-delay` 3, `youtube-end-transition` 6, `youtube-native-operator` 2, `youtube-manual-repeat` 1, `youtube-pending-seek` 4,
  `youtube` 9)은 41 / 41이고 나머지 둘(`youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8)은 12 / 12다. 로컬 WebKit(iPhone 13)
  `setup-youtube-activation.test.ts` 4 / 4(15.9 s). 실패, 다시 시도, 불안정 표시는 없고(`retries: 0`), 끝난 뒤 두 포트에 남은 listener는 없다.
- **배포 대상과 계약 동결:** 바탕 대비 App 10(위 'Deploy target'의 목록과 같음), 나머지 Worker 0, App 런타임 의존성 차이 없음. 9.0.30
  `3c098e9d` 대비 App 18. 계약 동결의 `git diff --stat bdb5759a..5267e8b2 -- …`가 비어 있다. **끝 조건 대조:** 위 'Phase 6 끝 조건'의
  `git ls-files`, `git grep`, `git diff`가 같은 결과다. **되돌리기 계산:** 위 '되돌리기'의 `git merge-tree`를 `5267e8b2`에서 다시 했다(6D-4가
  `player.ts`의 주석 두 줄에서도 충돌하는 것 말고 같음).

## 하지 않은 것과 확인하지 않은 것

- **6D-6, 버전 올리기, release-record 항목, PR, 머지, 배포:** 6D-6은 오너가 사진을 본 뒤에 만들고(위 '6D-6'), 나머지는 릴리스 담당의 몫이라 하지
  않았다. GitHub에 쓰지도 읽지도 않았다.
- **T0b 결함 넷의 고침:** 오너 답 전이라 싣지 않았다(결함 1과 2는 이 열차의 마지막 단계를 권함). 참값표가 오늘 동작으로 고정한 결함(H4·H4a,
  G8pa·G8·G8p·G8a, P1·P4, H10·H10a·H10c)은 6D가 답을 바꾸지 않아 그대로다. 6C-3은 6C의 것이고 오너가 표를 보는 중이다.
- **새로 찾은 것 하나(Q18):** 방장 레거시 복구가 다시 옮기지 않는 경우는 오늘 동작으로 고정했고 고치지 않았다(위 '오너에게' 2).
- **멈춘 것과 하지 않은 것:** S1 PRO arm의 살아 있는 오디오 읽기(6D-4), S2 방장 복구를 실행의 단계로, S3 iOS prime 대기 옮기기, S4
  `onPhaseChange` 잇기나 장부 epoch, S5 토큰 합치기. 모두 중립이 아니거나 장부를 거울로 만들어 하지 않았다. D8 고정 행은 더하지 않았다.
- **실기기, iOS Safari, 블루투스, 6D 런타임의 Full E2E와 CI:** 기기 확인은 배포 뒤 블라인드로 하며 게이트가 아니다. WebKit 레인은 로컬
  `setup-youtube-activation.test.ts`만 돌렸다(계획 §4.2-4). Phase 6 앞의 기기 기준선(Q6)은 재지 않았다.
- **증분별 테스트 먼저 다시 돌림:** 마지막 검사(QA 라운드 2, 4)에서 테스트 먼저 짝을 하나씩 다시 돌리지 않았다. 구현 때의 부모 실행(QA 라운드 1)을 적었고,
  마지막 검사는 이 갈래의 새·바꾼 고정을 바탕 런타임에 한꺼번에 돌렸다(위 'T0a·T0b·6B·6C 파일').
- **변이 확인:** 구현 때는 6D-4에서만 했고 마지막 검사(QA 라운드 2, 4)에서 다시 하지 않았다. 리뷰 반영 때 새 행이 잡는 변이만 확인했다(QA 라운드 3).
- **리뷰가 낮음으로 적었으나 싸지 않아 하지 않은 것:** 복구 골든의 비동기 전달 변형(`__stateNotifyDelayMs: 0`: 코호트에서 빠진 게스트의 출시와
  확인, 3,000 ms 다리 정리, 1.8 s 확인 시간 넘김, 방장 H1·H4)과 Android 게스트 행(들리는 앞섬 250 ms)은 더하지 않았다. 오늘 골든은 동기
  전달과 'other' 플랫폼만 고정하고, Android 앞섬은 가짜 단위 행 하나(100 ms)만 고정한다. 기기의 이벤트 순서를 이 골든이 고정하지 않으므로,
  시험만 단계로(부모와 바탕 런타임에서 먼저 돌려) 더하기를 권한다. 6D-6의 넷째 공유 길 행도 쓰지 않았다(6D-6을 만들 때, 위 '고칠 모양의 넓이').
- **남은 주석:** T0a 시험 `youtube-start-owner-boundary.test.ts`의 머리 주석(21 ~ 23줄)이 6B가 지운 합성 이름을 아직 적는다. T0a 파일을 바이트
  그대로 두는 열차라 고치지 않았다.
- **Worker 묶음 dry-run(`check:worker-bundles`):** `cloudflare/` 차이가 0이고 버전 거울을 바꾸지 않아 돌리지 않았다(`check:workers`와 Worker
  커버리지는 돌림).
- **6D-6의 시각과 세는 값:** 시험용 가짜 YouTube에서 잰 값이고 기기 값이 아니다.
- **시험 쪽 관찰 하나(제품 결함 아님, [화면 그대로]):** 6D-6 사진을 찍다 보니, 기존 PRO 끝에서 끝 시험의 서버 흉내(`e2e/critical-browser.test.ts:289`,
  `:464`, `:593`, `e2e/pro-entry-password.test.ts:78`, `e2e/pro-entry-retry.test.ts:67`, `e2e/pro-upload-recovery.test.ts:58`)는 앱이 보내는
  프레임 가운데 `type: 'pro-clock'`에만 답하는데, 앱은 시계 요청을 `type: 'pro-realtime'`, `channel: 'clock'`으로 보낸다
  (`src/pro-room/network-bridge.ts:1037-1040`. 서버는 그 요청에 `pro-clock`으로 답함, `cloudflare/signaling-worker.ts:7401-7403`). 그래서 그
  흉내들은 앱의 시계 요청에 답하지 않는다. 지금 그 시험들은 시계가 필요 없어 통과하지만 PRO 재생을 다루는 끝에서 끝 시험을 새로 쓸 때
  걸린다(사진 시험은 `channel: 'clock'`에 답하게 해서 돌렸다). 권장: 흉내를 서버 모양에 맞추는 시험만 변경. 열차: App 열차 밖(업데이트 창
  없음), 언제든.
- 위 '배포 뒤 확인'의 대략적 기기 시간(약 1시간 50분)은 추정이다.
