# Phase 6 6C: YouTube 상태 라우터, iframe 오디오 주인, 무장 단계 (2026-11-02)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 준비됨, 배포 전, 9.0.33 뒤에 한 번 더 옮겨야 함. 6C-3은 준비함, 오너를 기다림. 브랜치 `agent/p6-6c`는 main `7b869c35` 위 커밋 스물하나다: 넘겨받은 열다섯(계획 6C-1, 6C-2, 6C-4, 6C-5의 테스트 먼저·코드 커밋 여덟, 첫 독립 리뷰를 반영한 여섯(시험만 하나, 테스트 먼저·런타임 둘, 테스트 먼저·가드 둘, 문서 하나), 이 보고서의 기록 커밋 하나)을 패치 그대로 옮긴 것(QA 라운드 5), 옮긴 뒤의 둘째 독립 리뷰(QA 라운드 6)를 반영한 넷(시험만 `4d4e5be2`, 테스트 먼저·가드 `cf8fbfab` → `cf8a5a99`, 문서 `a9951bfd`), 이 기록을 옮긴 뒤 모습으로 고친 문서 커밋 `f9f4a57c`, 마지막 검사(QA 라운드 8)를 적은 이 기록 커밋. 계획의 6C-3(마스터 볼륨이 0보다 크고 0.5 %보다 작을 때 YouTube를 음소거하는 규칙 하나, 오너가 '예'로 답한 의도 변경)은 만들지 않았다: 오너 답이 '만들기 전에 전후 시각 표를 먼저'라서 표만 준비했다(아래 '6C-3: 준비함, 만들지 않음, 오너를 기다림'). 옮긴 뒤 `6998f04e`의 검사(QA 라운드 5, 6), 코드 끝 `a9951bfd`의 검사(QA 라운드 7), 기록 끝 `f9f4a57c`(코드는 `a9951bfd`와 같음)의 마지막 검사(QA 라운드 8: 단위 전체, 네 디렉터리의 seed 넷, typecheck·lint·format, `guard:*` 37개, `build:checked`의 25 단계, 핵심 커버리지, critical E2E, YouTube spec, WebKit 활성화 spec)는 버전 올리기를 기다리는 `guard:sw-cache-version` 말고 모두 통과했다. App 9.0.33(한글을 다시 Pretendard로 그리는 열차)은 그사이 main `4faf38d9`(#560)로 들어왔지만 이 갈래의 바탕은 `7b869c35` 그대로다: 그 열차의 배포와 기록 뒤 그 main 위로 다시 옮기고 그 끝 SHA에서 다시 돌리기 전에는 PR을 열거나 머지하지 않는다(아래 '머지 전에 할 일' 1. `4faf38d9`와의 시험 병합은 `docs/README.md` 하나만 충돌). T0b가 찾은 결함 넷의 고침은 오너 답이 없어 싣지 않았다. 6C-3(오너가 표를 본 뒤), 버전 올리기와 문서(계획 6C-6), release-record §2의 이 열차 항목과 열린 항목 연결, PR, 머지, 배포는 릴리스 담당이 한다. 로컬과 브랜치 결과는 exact-main-SHA 후보를 대신하지 않는다 |
| Base               | `7b869c35` = main: 9.0.31(#555, 기록 #556), App 9.0.32 / v805로 나간 6B(#557, squash `3ea689b9`, 기록 #558), Phase 7 T0 시험만 PR #559. 그 App 런타임은 운영 9.0.32와 같다(#558, #559는 기록과 시험만). 넘겨받은 열다섯은 6B의 브랜치 끝 `89e0b682`(그 [보고서](phase6-6b-start-ledger-readers-2026-11-01.md)의 마지막 기록 커밋, 운영 코드 `418b411d`) 위에 만들어졌고, 6B가 main에 든 뒤 `89e0b682` 위의 커밋만 이 main 위로 옮겼다: `src`와 `scripts`의 차이가 옮기기 전과 바이트로 같고, 충돌은 설계 문서 하나였다(QA 라운드 5). `89e0b682`와 `7b869c35`의 운영 `src` 차이는 9.0.31의 `src/i18n/font-metrics.ts`, `src/i18n/font-prefetch-samples.ts` 둘(import, export, 파일 수 변화 없음)과 버전 줄뿐이다. 바탕 빌드는 진입 `main-FMXWdlb7.js` 861,056 B, eager JS gzip 465,403 B다(아래 '번들 크기'). 마지막 검사(QA 라운드 8) 동안 원격 main은 `4faf38d9`(#560, App 9.0.33 / v806의 squash, 2026-11-02 12:59 KST 머지)였다. 이 갈래는 그 위로 옮기지 않았고, 시험으로만 `git merge-tree`(충돌은 `docs/README.md` 하나)와 이 갈래의 `src` 차이를 `4faf38d9`에 얹은 임시 트리의 빌드와 단위 묶음을 돌렸다(QA 라운드 8). 그 열차가 배포·기록된 뒤 그 main 위로 한 번 더 옮긴다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Version            | 없음. 9.0.32 / v805 그대로다(`guard:release-identity` 'MUSIXQUARE 9.0.32; service-worker cache epoch v805'). App 런타임 경로가 바뀌므로 다음 App 패치와 SW epoch를 함께 올려야 하고, 그 전에는 `guard:sw-cache-version`이 그 이유 하나로 실패한다: '[sw-cache-version] FAIL: committed PWA runtime changes are newer than v805 (3ea689b9).'와 App 9 파일(`src/youtube/`의 `arm-steps.ts`, `authority-arm.ts`, `iframe-audio.ts`, `iframe.ts`, `local-offset.ts`, `player-runtime-bridge.ts`, `player.ts`, `start-ownership.ts`, `zero-start.ts`), 'Bump CACHE_VERSION in scripts/service-worker-asset.ts after these changes, then commit the bump.'(QA 라운드 5, 7, 8). 이 열차 앞에 App 9.0.33 / v806(한글을 다시 Pretendard로 그리는 열차, main `4faf38d9`(#560)에 머지됨, 그 배포와 기록은 이 검사에서 확인하지 않음)이 나가고, 6C는 그 뒤 9.0.34 / v807로 나간다. 올리면 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 셋째, 창 모양은 지금 그대로). 바닥(저장·유효 795)은 바꾸지 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Scope              | 계획 §4.8의 6C-1(C2-6, SS-06, PA-15), 6C-2(C2-2, SS-07, PA-14, PA-17), 6C-4(C2-8a, PA-07), 6C-5(C2-8b, PA-08), 모두 중립. 6C-1: `iframe.ts`가 iframe 상태를 시작 주인들에게 묻는 고정 순서가 시작 claim 종류마다 결정 하나인 라우터가 되고, Standard 방장의 대기 room time 읽기가 하나로 합쳐진다(대기 술어는 레거시 전용으로 그대로). 6C-2: `src/youtube/iframe-audio.ts`가 App의 iframe 오디오 쓰기, PRO 일시정지 관문의 iframe 토큰, hold의 주인이 된다(RO-12). 6C-4·6C-5: 두 무장 기계(Standard zero-start, PRO arm)가 새 `src/youtube/arm-steps.ts`(RO-03)의 hard-mute 대기, warm PLAYING 수락, settle을 함께 쓴다. 그 위에 첫 독립 리뷰를 반영한 시험만 하나(방장 레거시 복구의 두 규칙 칸, Phase 7 계약 (a) 강화), 중립 런타임 하나(시작 hold를 장부에 직접 물음), CHECK 12 새 규칙 하나(주차 hold 등록), 기록 고침 하나, 그리고 옮긴 뒤 둘째 독립 리뷰를 반영한 시험만 하나(settle이 폴을 세는 방식 셋을 두 기계 골든에, Q12 행의 확인, 표본기 주석), CHECK 12 규칙 둘(주차 자리의 쓰기를 `AUDIO HOLD REGISTRATION`에, 새 `PAUSE GATE WRITERS`), 기록 고침 하나(두 기계의 'non-positive'는 시작 때 잡는 값뿐). 와이어, 서버, 저장 모양, 계약 표지, 의존성, 타이머 이름, 로그 줄, 준비 이벤트, 화면, 소리는 바꾸지 않는다([화면 그대로]). 6C-3은 전후 표만 있다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Deploy target      | `app`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`로 운영 App 9.0.32 `3ea689b9`(main `7b869c35`와 런타임이 같음)와 코드 끝 `a9951bfd`를 견준 로컬 git 판정: App 9(`src/youtube/`의 `arm-steps.ts`, `authority-arm.ts`, `iframe-audio.ts`, `iframe.ts`, `local-offset.ts`, `player-runtime-bridge.ts`, `player.ts`, `start-ownership.ts`, `zero-start.ts`), PRO room 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음(QA 라운드 7, 기록 끝 `f9f4a57c`에서 다시 판정한 QA 라운드 8도 같음). 9.0.33이 먼저 나가면 그 main 위로 옮긴 뒤 그 운영 대비로 다시 판정한다(지금의 `4faf38d9`는 이 갈래의 조상이 아니라 그 판정 함수가 견주지 못함). 운영을 조회하지 않은 판정이라 릴리스의 부분 릴리스 검사를 대신하지 않는다. `raise_app_build_floor` false, Developer API D1 false(계획 RT-01). 계약 동결: `git diff --stat 7b869c35..a9951bfd -- cloudflare/ src/network/protocol.ts src/core/constants.ts src/types/index.ts package.json package-lock.json index.html scripts/service-worker-asset.ts browser/ docs/release-record.md docs/release-history.md src/youtube/constants.ts`가 비어 있다(`7b869c35..f9f4a57c`도 비어 있음, QA 라운드 8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Operations         | 운영에 닿지 않았다(로컬 git, 로컬 시험·빌드·Playwright만). GitHub 쓰기, push, 배포, 운영 요청은 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Resource ownership | 새 레코드 없음. 라우터, iframe 오디오 주인, 무장 단계는 기존 자원 RO-02, RO-12, RO-03의 주인이고, 주차 hold 등록은 RO-14의 기록 문장이다. 센 코드나 규칙을 옮긴 커밋이 같은 커밋에서 레지스트리와 기준치를 고쳤다: CHECK 11 32 → 26(6C-2 `59015d00`) → 20(6C-4 `e35bbbfa`), CHECK 5 YouTube 시작 계약 파일에 `arm-steps.ts`(수 1 / 1 / 45 그대로), CHECK 12 읽기 11·지우기 9, 파사드 쓰기 2, 스냅샷 읽기 8, 장부 합성 1 그대로와 새 실패 닫힘 규칙 `AUDIO HOLD REGISTRATION`(`be93e908`, 주차 자리의 쓰기와 넘기기까지 `cf8a5a99`), `PAUSE GATE WRITERS`(`cf8a5a99`). `node scripts/check-resource-ownership.mts`: 49 records, 457 → 458 production files(`arm-steps.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

이 문서는 Phase 6 계획의 셋째 App 열차 6C의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의 Phase 6
계획(2026-10-30)과 그 영역 조사, 오너 답(2026-10-30)이고, SS, PA, RT, C2 번호와 Q 번호는 그 노트의 번호다. 계획의 줄 번호는
`78ec56f5` 기준이라 6A, T0b, 6B가 옮긴 위치를 모두 기호로 다시 찾았고, 이 문서의 줄 번호는 코드 끝 `a9951bfd`의 것이다. 앞선
Phase 6 단계는 시험만인 T0a(#539, #541, #542), 가드만인 T1(#543), 첫 App 열차 6A(#550, 9.0.30 / v803,
[보고서](phase6-6a-start-constants-owner-queries-2026-10-31.md)), 시험만인 T0b(#552, #553)와 둘째 App 열차 6B(#557, 9.0.32 / v805,
[보고서](phase6-6b-start-ledger-readers-2026-11-01.md))이고, main에는 그 뒤 Phase 7의 시험만 T0(#559)이 들어왔다. 그 뒤 main에 들어온
App 9.0.33(#560, `4faf38d9`)은 이 갈래의 바탕이 아니다(아래 '머지 전에 할 일' 1). 커밋 SHA는 main
`7b869c35` 위로 옮긴 뒤의 것으로 적는다. 옮기기 전 SHA는 그것으로 돌린 QA 라운드 1 ~ 4와 그 결과를 인용하는 자리에만 '(옮기기 전)'과
함께 남기고, 둘의 대응은 QA 라운드 5에 있다. 이 보고서에서 '중립'은 T0a의 골든과 고정 행, T0b 참값표의 모든 칸(U·P 행과
비동기 전달 변형 포함), 6B의 행이 바이트 그대로 통과하고, 와이어가 바뀌지 않고, 같은 프레임이 같은 시각에 나가며, T0a PRO READY 시각
골든과 PRO 늦은 합류 고정 행이 초록이라는 뜻이다. main의 Phase 7 T0 행(`src/audio/__tests__` 23 파일,
`media-session-lock-screen-pause.test.ts`, 오디오 랩)도 그대로 통과한다. 앞 단계 시험 파일을 바꾼 곳(다리 훅을 지워 꼭 필요했던 T0b
이음새 둘, Q12 시험 지움)은 아래 'T0b·T0a·6B 파일'에 따로 적는다.

## 오너 결정 (2026-10-30, 모두 권장)

- **Q1 넷:** Phase 6을 App 업데이트 넷(6A ~ 6D)으로 낸다. 6C는 셋째이고, 업데이트 창은 버전 올리기와 함께 한 번 뜬다.
- **Q2 예:** 오너 답은 '0 < 마스터 볼륨 < 0.5 %면 YouTube 음소거로 한 규칙, 3차 업데이트 맨 마지막, 실패하는 시험 먼저, 만들기 전 전후
  시각 표'다. 그래서 이 갈래는 계획의 6C-3을 만들지 않고 전후 표만 준비했다(아래 '6C-3'). 오너가 표를 보고 답하면 이 열차의 마지막
  런타임 증분으로 만든다. 그때까지 두 규칙은 `readYouTubeAppAudio`(`src/youtube/iframe-audio.ts:118`)의 이름 붙은 두 변형('rounded',
  'non-positive')이고 자리마다 오늘 규칙을 지킨다.
- **Q18 결함마다 묻기:** 시험이 결함을 재현하면 오늘 동작으로 고정하고 결함마다 따로 묻는다. 6C의 새 행은 오늘 동작을 고정했고, 새로
  드러난 결함은 하나다: settle 중 늦춘 다시 seek가 던지면 그 오류가 타이머 밖으로 나가 전역 오류 로그를 남긴다(6C-5 골든 'seeks that
  throw while settling', 로그만 다름, 아래 '오너에게' 2). T0b가 찾아 2026-11-01에 따로 여쭌 결함 넷은 답이 없어 이 열차에 싣지 않았다.
- **Q3 박자는 각자 그대로:** 6C는 검증 복원과 그 박자를 건드리지 않는다. 공유 단계는 hard-mute 폴(30 ms, 최대 열두 번), warm 수락
  (260 ms), settle(80 ms 폴, 0.12 s, 연속 두 표본, 여섯째 폴마다 다시 seek)을 `src/youtube/constants.ts`의 값 그대로 읽는다.
- **엔지니어링 기본값(계획 §9.3, §9.4, 권장대로):** 이 열차가 기댄 것은 Q8(시작 소유를 native 보호 목록에 넣지 않는다: 6C-1의 대기
  술어는 레거시 hold만 본다), Q10·Q24(CHECK 11·12는 resource-ownership 가드 안에서 정확 개수), Q11(새 시험 전용 export 없음,
  `guard:dead-exports` 시험 전용 20 그대로), Q12(PRO arm의 운영 미사용 'load' 갈래를 시험 둘과 함께 지움, 6C-4), Q14(`authority-arm.ts`는
  공유 단계 위의 얇은 PRO 파사드), Q26(새 모듈 `arm-steps.ts`: 두 운영 소비자의 공유 계약), Q27(두 거울 플레이어 타입만 `arm-steps.ts`의
  공통 타입 위에 두고 어댑터 둘과 플랫폼 판별은 남김), Q29(번들 상한을 넘으면 잰 숫자로 묻는다: 해당 없음, 아래 '번들 크기')다.
- **Q22 늦은 합류 흠:** (가)는 6D의 마지막 증분에서 고치기로 했다. 그때까지 PRO 늦은 합류 고정 행(#539, `pro-late-prepare-reload.test.ts`,
  `playback-late-cohort-join.test.ts`)은 오늘 동작 그대로 초록이고 6C에서도 그대로다.
- **Q6 기준선:** Phase 6 앞의 기기 기준선은 재지 않았다. 아래 '배포 뒤 확인'은 기준선과 견주지 못하고 판정 기준과만 견준다.
- **릴리스 위임:** 6A·6B 보고서가 적은 위임(2026-10-31 23:20 KST 무렵부터 약 40시간)은 오너가 돌아오는 2026-11-02 오후까지다. 6C-3의
  전후 표는 오너에게 직접 보이기로 한 것이라 위임으로 정하지 않는다.
- **열차 순서:** 6B는 2026-11-02에 9.0.32 / v805로 나갔다. 그 뒤 App 9.0.33(한글을 다시 Pretendard로 그림)이 6C보다 먼저 나가고, 6C는
  9.0.34 / v807이다.

## 증분 한눈에

'부모에서'는 테스트 먼저 커밋을 그 트리 그대로(런타임은 부모의 것) 다시 돌린 결과(실패 / 그 실행의 행)이고, '코드 커밋에서'는 같은
파일들을 코드 커밋에서 돌린 결과다. 넘겨받은 열다섯의 두 열은 옮기기 전 SHA에서 임시 worktree로 다시 돌린 것이고(QA 라운드 3), '옮긴
뒤'는 옮긴 커밋에서 그 짝을 다시 돌린 결과다(QA 라운드 5, 짝마다 묶음이 더 작음). 둘째 리뷰 반영 줄은 QA 라운드 7이다. 실패한 행은
모두 그 테스트 먼저 커밋이 더한 행이고, 함께 돌린 중립 고정 파일(T0a 골든, T0b 참값표 둘, 6B 장부 행, PRO 늦은 합류 고정 행, 9.0.8
방장 스피커 행 등)은 양쪽에서 모두 통과했다.

| 증분                                 | 항목                        | 테스트 먼저 → 코드      | 부모에서                                                                             | 코드 커밋에서           | 옮긴 뒤(QA 라운드 5)                                                  | 가드                                                               |
| ------------------------------------ | --------------------------- | ----------------------- | ------------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 6C-1 C2-6 상태 라우터                | SS-06, PA-15                | `972338df` → `6edfda84` | 0 / 690(20 files), 새 행은 오늘 동작 고정                                            | 690 / 690               | 0 / 40, 그다음 40 / 40                                                | 수 그대로                                                          |
| 6C-2 C2-2 iframe 오디오 주인         | SS-07, PA-14, PA-17         | `6078a8f8` → `59015d00` | 36 / 1,010(27 files), 모두 `iframe-audio-owner.test.ts`                              | 1,010 / 1,010           | 36 / 54(모두 `iframe-audio-owner.test.ts`), 그다음 54 / 54            | CHECK 11 32 → 26                                                   |
| 6C-4 C2-8a 무장 단계                 | PA-07                       | `67ce787b` → `e35bbbfa` | `arm-steps.test.ts` 불러오기 실패(9행), 나머지 29 files 1,406 / 1,406                | 1,413 / 1,413(30 files) | `arm-steps.test.ts` 불러오기 실패, 나머지 117 / 117, 그다음 124 / 124 | CHECK 11 26 → 20, CHECK 5 계약 파일에 `arm-steps.ts`               |
| 6C-5 C2-8b settle                    | PA-08                       | `821d55ee` → `3f9bf647` | 28 / 1,474(31 files), 모두 `arm-steps.test.ts`                                       | 1,474 / 1,474           | 28 / 100(모두 `arm-steps.test.ts`), 그다음 100 / 100                  | 수 그대로                                                          |
| 첫 리뷰: 레거시 복구 칸, Phase 7 (a) | 시험만                      | `19a81173`              | 192 / 192 통과(3 files, 런타임은 `d20acc97`(옮기기 전)), 음향 순서 19행은 바탕에서도 | 해당 없음               | 156 / 156                                                             | 없음                                                               |
| 첫 리뷰: 시작 hold를 장부에 직접     | RO-12, RO-02                | `3738ea92` → `338b3622` | 8 / 1,012(27 files), 모두 `iframe-audio-owner.test.ts`                               | 1,012 / 1,012           | 8 / 37, 그다음 37 / 37                                                | 수 그대로                                                          |
| 첫 리뷰: 주차 hold 등록 가드         | RO-12, 가드 항목 12         | `afee2a6c` → `be93e908` | 3 / 98                                                                               | 98 / 98                 | 3 / 98, 그다음 98 / 98                                                | 새 규칙 `AUDIO HOLD REGISTRATION`, 수 그대로                       |
| 첫 리뷰: 기록 고침                   | 문서만                      | `f9bb3c4b`              | 해당 없음                                                                            | 빌드 바이트 동일        | 해당 없음                                                             | 없음                                                               |
| 기록                                 | 이 보고서, `docs/README.md` | `6998f04e`              | 해당 없음                                                                            | 해당 없음               | 해당 없음                                                             | 없음                                                               |
| 둘째 리뷰: settle이 폴을 세는 방식   | 시험만                      | `4d4e5be2`              | 골든 68 / 68, `authority-arm.test.ts` 80 / 80(런타임은 main `7b869c35`)              | 같은 두 파일 148 / 148  | 해당 없음(옮긴 뒤 커밋)                                               | 없음                                                               |
| 둘째 리뷰: 주차 자리와 관문 쓰는 쪽  | RO-12, 가드 항목 12         | `cf8fbfab` → `cf8a5a99` | 4 / 103                                                                              | 103 / 103               | 해당 없음(옮긴 뒤 커밋)                                               | `AUDIO HOLD REGISTRATION` 넓힘, 새 `PAUSE GATE WRITERS`, 수 그대로 |
| 둘째 리뷰: 두 규칙의 잡는 때         | 주석과 레지스트리만         | `a9951bfd`              | 해당 없음                                                                            | 크기 같음               | 해당 없음                                                             | 없음                                                               |
| 기록 고침                            | 이 보고서, `docs/README.md` | `f9f4a57c`              | 해당 없음                                                                            | 해당 없음               | 해당 없음                                                             | 없음                                                               |
| 마지막 검사 기록                     | 이 보고서                   | 이 기록 커밋            | 해당 없음                                                                            | 해당 없음               | 해당 없음                                                             | 없음                                                               |

부모에서 실패한 이유는 모두 아직 없는 코드다: 6C-2 'TypeError: clearYouTubePauseGate is not a function'(공유 `beforeEach`), 6C-4
"Cannot find module '../arm-steps.ts'", 6C-5 'settleYouTubeAtTarget is not a function', 시작 hold 'isStartHardMuteHeld is not a function'(그
부모의 주인은 시작 hold를 셋째 등록 hold로 받음), 가드 행 셋은 규칙이 없어 가드가 아무것도 보고하지 않음(실제 트리 행은 통과), 둘째
리뷰의 가드 행 넷도 같다. 6C-1과 시험만 커밋의 새 행은 오늘 동작을 고정한 것이라 부모에서도 통과한다. 넘겨받은 열다섯의 수는 구현 때
기록한 값(QA 라운드 1)과 모두 같다.

## 증분

### 6C-1 C2-6 iframe 상태 라우터 (SS-06, PA-15)

- **라우터:** `iframe.ts`가 iframe 상태를 시작 주인들에게 묻던 고정 순서가 `routeYouTubeStartPlayerState`(`src/youtube/iframe.ts:3082`)가
  된다. 시작 claim 종류마다 결정 하나를 오늘 순서로 둔다(`:3055`의 위치 목록): PRO arm 자기 처리기, zero-start 실행 처리기, 복구의
  active claim(`isYouTubeStartRecoveryActive`), Standard 방장의 레거시 로컬 시작 hold(`isStandardHostYouTubeLocalStartPending`), 그리고
  `pro-direct`는 `0`(PRO 직접 COMMIT의 로컬 대기는 아무것도 소비하지 않음). 처음 소비하는 주인에서 물음이 끝나는 단락도 같다. 주인마다
  상태가 올 때 클로저로 물어 그 순간의 바인딩이 답하고, 모듈을 불러올 때는 아무것도 읽지 않는다. 순서는 타입으로만 두어(종류 문자열이
  번들에 실리지 않음) 장부에 claim 종류를 더하고 라우터 결정을 빠뜨리면 컴파일되지 않는다(`start-ownership.ts`가
  `YouTubeStartClaimKind` 타입을 내보냄). 오래된 재사용 피드백 확인(`isStaleReusedPlayerFeedback`)은 그대로 라우터 앞에서 한 번 돈다
  (`:3162-3163`).
- **합친 대기 읽기:** `local-offset.ts`의 `toCanonicalYouTubeTime`(`:280-285`)은 끝 hold 뒤 Standard 방장의 대기 room time을 읽기 하나
  (`readStandardHostYouTubePendingStart`, `:131`)로 읽는다: 레거시 로컬 시작(어떤 답이든, 호출자가 clamp하므로 유한하지 않은 답은 0),
  아니면 zero-start 실행의 예약 시작(유한할 때), 각 읽기는 한 번, 그 순서로. 이 읽기는 `toCanonicalYouTubeTime`만 읽는다.
- **레거시 전용 대기 술어(PA-15, 설계대로):** `isStandardHostYouTubeLocalStartPending`(`:120`)과 그 독자 여섯(라우터, native-control
  보호 주인 확인, seek의 mid-sync 확인, 방장의 재생·일시정지 토글 `youtube:toggle-play`, `sync.ts`의 방장 하트비트 상태, 수동 오프셋
  런타임)은 레거시 hold만 본다. 실행의 hold와 합치면 실행의 `starting` 단계의 BUFFERING·PAUSED가 소비되고, 실행의 스피커 hold 동안
  진짜 헤드셋 일시정지가 App 자신의 출력으로 읽히며, 옛 빌드에 보내는 방장 상태가 바뀔 수 있다(아래 '혼합 버전').
- **바뀌지 않은 것:** 관리 타이머 이름, 로그 줄, bus 이벤트를 내는 곳과 듣는 곳, 준비 이벤트, 가드 수.
- **기록(같은 커밋):** 설계 문서 [youtube-start-ownership.md](youtube-start-ownership.md)의 'The iframe state router' 절, 레지스트리 RO-02
  (주인·흐름, 허용 요청자, 앵커 시험, 상태 `duplicated` 그대로).
- **시험(테스트 먼저 `972338df`):** 새 `youtube-start-state-router.test.ts`(9행)가 진짜 `iframe.ts`와 `player.ts`를 각본의 IFrame API
  뒤에서 몰고, `iframe.ts`가 주인에게 묻는 자리마다 진짜 주인에게 먼저 묻는 감싸개로 답을 기록한다. PRO arm 예열, Standard 방장
  zero-start 예열, active 게스트 복구, 방장의 −5 s 레거시 로컬 시작 hold가 소비한 PAUSED는 뒤 주인과 보통 길에 닿지 않고, 아무 주인도
  잡지 않으면 모든 주인이 오늘 순서로 한 번씩 물리고 보통 길이 한 번 돈다(R1). 오래된 재사용 피드백 확인은 첫 주인보다 먼저 재사용
  iframe의 기한을 정리한다(R2). `local-offset.test.ts`에 대기 읽기 행 12(R3). 모두 오늘 동작을 고정한 행이라 부모에서도 통과한다.
- **변이 확인(구현 때, QA 라운드 1):** arm을 실행 뒤에 물으면 라우터 9행 모두, 단락 없이 모두 물으면 6행, 오래된 확인을 라우터 뒤로
  옮기면 4행(R2 모두), 레거시 결정을 빼면 3행이 실패한다. 술어를 실행 hold와 합치면(PA-15) 10행(비평 blocker 행 5
  `standard-start-pause-teardown.test.ts`와 레거시 null R3 행 5), 합친 읽기가 zero-start를 먼저 물으면 `local-offset.test.ts` 31행
  가운데 10행이 실패한다. 라우터 결정 없이 claim 종류를 더하면 `iframe.ts`의 타입 검사가 실패한다.

### 6C-2 C2-2 iframe 오디오 주인 (SS-07, PA-14, PA-17)

`src/youtube/iframe-audio.ts`(머리 `Resource owner: RO-12`, 6A-4부터 검증 복원을 가짐)가 App 자신의 iframe 오디오 쓰기와 그것을
닫아 두는 hold의 주인이 된다.

- **쓰기 셋, 오늘 순서 그대로(`applyYouTubeAudio`, `:190`):** `youtube:set-volume` 쓰기(`setVolume`, 그다음 주차 물음, 그다음 mute
  또는 hold되지 않은 unMute), PRO 일시정지 관문의 정착(먼저 주차 물음, 주차된 iframe에는 `setVolume` 없음), PRO 직접 COMMIT(주차도
  시작 주인도 묻지 않음). `player.ts`는 bus 처리기 셋, 복구 의도 갱신, 두 시작 기계로 원하는 오디오를 미는 것을 오늘 순서로 두고 주인을
  거쳐 쓴다(`src/youtube/player.ts:1439`, `:4365-4379`, `:4387-4398`).
- **관문 토큰:** PRO 일시정지 관문의 iframe 토큰이 `player.ts`에서 옮겨 온다(`holdYouTubePauseGate`, 맞는 토큰만 푸는
  `releaseYouTubePauseGate`, `stopYouTubeMode`의 `clearYouTubePauseGate`, `isYouTubePauseGateHeld`). 관문이 열리면 그대로 바로 맨
  `mute()`를 한다(`enforceYouTubePauseGate`, `:153`, 주차든 hold든). `src/audio/engine.ts`는 WebAudio 쪽 자기 토큰을 그대로 갖는다(계획
  §8, Phase 7).
- **원하는 오디오는 저장하지 않고 쓸 때 읽는다:** `readYouTubeAppAudio`(`:118`)가 `audio.masterVolume`을 오늘의 두 규칙 가운데 하나로
  읽는다. 'rounded'(정수 퍼센트가 0이면 음소거)는 관문 정착, 직접 COMMIT, `player.ts`의 두 복구 의도(교체 대체의 의도와 넘겨받은 준비의
  의도)가 읽고, `youtube:set-volume` 쓰기는 `engine.ts`가 보낸 반올림 퍼센트에 같은 규칙을 쓴다. 'non-positive'(0 이하만 음소거)는
  Standard zero-start 실행의 원하는 오디오(실행이 잡아 둔 값을 그 복원, 출시 unMute, 취소 복원과 두 복구의 의도가 가져간다: 게스트 로컬
  복구, 방장 자신의 실행이 실패한 뒤의 레거시 복구)와 PRO 준비(`src/youtube/iframe.ts:2182`)가 읽는다. 어느 자리도 규칙을 바꾸지 않았다.
- **hold는 종류마다(계획 §4.8):** 관문은 바로 맨 `mute()`를 하고 모든 App 쓰기의 unMute를 mute로 바꾼다. 주차(RO-14)는 retained player
  controller의 검증 hard mute(`ensureRetainedYouTubePlayerHardMuted`)를 그 쓰기의 mute·unMute 대신 받고 unMute는 받지 않는다. 시작
  주인의 hard mute(zero-start 실행, 복구(게스트 로컬 복구나 방장의 레거시 복구), PRO arm)는 unMute만 막는다(그 주인이 최신 원하는
  오디오를 스스로 되돌림). 주차 hold는 `player.ts`가 모듈 평가 때 한 번 클로저 둘로 등록한다(`registerYouTubeAudioHolds`,
  `src/youtube/player.ts:4749`). 시작 주인의 hold는 첫 리뷰 반영 `338b3622`부터 주인이 쓰는 순간 장부의 `isYouTubeStartHardMuteOwned`에
  직접 묻는다(아래 '리뷰 반영').
- **그대로 둔 것:** iOS prime의 제스처 unMute(`src/youtube/iframe.ts:1517`), 시작 기계 자신의 hard mute와 복원, `engine.ts`(이벤트를
  내는 두 처리기 `src/audio/engine.ts:716-722`, `:742-745`), 모든 순간, 프레임, 타이머 이름, 로그 줄. PRO 준비는 원하는 오디오와 관문을
  주인에게서 읽고, 런타임 다리의 관문 훅(`isProPlaybackPauseGatePendingFromIframe`)은 지웠다(계획 §3 #8. §4.10 끝 조건 2의 '다리 훅
  없음'이 `src`에서 참).
- **CHECK 11(RO-12) 32 → 26:** `player.ts` 14 → 4, `iframe-audio.ts` 3 → 7(`applyYouTubeAudio` 3, `enforceYouTubePauseGate` 1). 레지스트리
  RO-12, RO-14, RO-02와 가드 항목 11, 설계 문서의 다리 행과 독자 칸이 같은 커밋이다. 핵심 커버리지에 `iframe-audio-owner.test.ts`를
  넣어 `iframe-audio.ts`의 99 % 문턱을 지킨다.
- **시험(테스트 먼저 `6078a8f8`):** 새 `youtube-iframe-audio-order.test.ts`(jsdom, 진짜 배선, 18행)가 쓰기마다 iframe 명령, 두 시작
  기계로 미는 값, 묻는 hold(주차, 그 검증 hard mute, 장부의 hard-mute claim)를 순서대로 공개 이음새의 감싸개로 기록한다: O1 ~ O10
  (볼륨 쓰기의 반올림·clamp·유한하지 않은 값, 관문, 주차, 시작 주인 hold 셋, iframe 없음과 손잡기 전, 관문 열림, 정착, 직접 COMMIT,
  던지는 `setVolume`, `stopYouTubeMode`의 관문 버림), 마스터 볼륨 0, 0.004, 0.005의 두 규칙 행, Phase 7 계약 (a) 행. 이 행들은 부모에서도
  통과하는 고정 행이다. 새 `iframe-audio-owner.test.ts`(node, 36행)는 주인의 조각을 고정하고 부모에서는 모두 실패한다.
- **변이 확인(구현 때, QA 라운드 1):** 볼륨 쓰기가 `setVolume` 앞에서 주차를 물으면 10 / 18, 시작 주인 hold를 무시하면 14 / 42(경계 행
  8 포함), App 쓰기가 관문을 무시하면 4 / 155(O2, O7, O8과 `player.test.ts` 'keeps a participant-local PRO pause gate closed across volume
  changes'), 정착이 주차 앞에서 `setVolume`을 쓰면 4 / 18, 직접 COMMIT이 시작 hold를 물으면 1 / 18(O8), 관문 열림이 주차를 물으면 1 / 18
  (O6), 검증 hard mute 없는 주차는 4 / 200(O3, O7과 `stale-async-guards.test.ts` 두 행), `stopYouTubeMode`가 관문을 비우지 않으면 6 / 200이
  실패한다. 규칙 하나('rounded', 6C-3의 변경)는 그때 2 / 185였고, 리뷰 반영 뒤에는 두 규칙 행의 0.004에서 여섯 칸과 주인의 0.004 규칙
  행이 실패한다(아래 '6C-3').
- **T0b 이음새 둘:** 다리 훅을 지워 꼭 필요했다(아래 'T0b·T0a·6B 파일').

### 6C-4 C2-8a 무장 단계 (PA-07)

새 `src/youtube/arm-steps.ts`(머리 `Resource owner: RO-03`, 두 운영 소비자의 공유 계약)를 두 무장 기계가 함께 쓴다.

- **hard-mute 대기 `waitForYouTubeHardMute`(`:108`):** 첫 `mute()`, 그다음 기계 자신의 타이머로 폴(0 ms 뒤, 그다음 30 ms마다), 폴마다
  기계의 울타리 먼저. 읽기가 던지면 음소거 아님으로 세고, 확인되지 않은 폴은 마지막(열두째)이 아니면 다시 mute한다(던지면 무시).
  마지막 폴은 기계의 timeout으로 끝난다. 확인한 폴이 기계의 warm을 부른다. 첫 `mute()`가 던지면 기계에 닿아 기계가 자기 이유로 실패한다.
- **warm PLAYING 수락 `acceptYouTubeWarmPlaying`(`:145`):** settle은 수락한 warm PLAYING 260 ms 뒤 기계의 타이머로 시작하고, warm 지연은
  기계의 시계로 읽어 0 아래로 내려가지 않는다.
- **타입 `YouTubeArmPlayer`(`:68`, 타입만, 바이트 0):** `YouTubeAuthorityArmPlayer`가 그 타입이고 `YouTubeZeroStartPlayer`가 메서드
  둘을 더해 넓힌다. 어댑터 둘(`player.ts`의 `getZeroStartPlayer`, `iframe.ts`의 `getYouTubeAuthorityArmPlayer`)과 플랫폼 판별은
  그대로다(Q27).
- **각 기계가 지키는 것:** 시계(zero-start `Date.now()`, PRO arm `performance.now()`), 스케줄러와 울타리·취소, 실패 이유와 내용, warm
  (warm 쌍은 같은 `setVolume`·`mute`로 `writeYouTubeAudio`를 거침), 어떤 PLAYING을 받는지, warm 감시와 기한, settle(6C-5까지), 오디오
  복원, 출시.
- **Q12:** PRO arm의 운영 미사용 load warm을 지웠다. arm은 `iframe.ts`가 부탁하는 유일한 종류인 상주 iframe만 데우고, 준비가 상주
  영상을 전략을 읽지 않고 확인한다. 시험 둘('loads a non-resident target exactly once…', 'reports READY only after hard mute, real warm
  PLAYING, settle, and audio restore')을 함께 지웠고, 새 골든이 상주 warm의 전체 순서를 고정한다.
- **가드와 기록(같은 커밋):** CHECK 11 26 → 20(`arm-steps.ts` 2, `zero-start.ts` 6 → 2, `authority-arm.ts` 4 → 0과 그 항목 지움), CHECK 5의
  YouTube 시작 계약 파일에 `arm-steps.ts`(자기 시간 값 없음, 수 그대로). 레지스트리 RO-03(공유 단계와 각 기계가 지키는 것, 골든을 parity
  표로, 상태 `duplicated` 그대로), RO-12, 가드 항목 5·11. 핵심 커버리지에 `arm-steps.ts`(99 / 99 / 99 / 99)와 `authority-arm.ts`(86 / 80 /
  97 / 91, 같은 두 실행 87.71 / 81.92 / 98.52 / 92.3의 약 1점 아래).
- **시험(테스트 먼저 `67ce787b`):** 새 `arm-steps-golden.test.ts`(35행)가 두 기계를 같은 각본의 가짜 iframe에서 돌려 PREPARE부터 한
  시간축에 명령, 보고한 상태와 소비 여부, 단계, debug 줄, 오류, 결과(게스트 ARMED, arm 준비 결과)를 명시 배열로 고정한다: 상주 정지·재생
  (상태를 한 task 뒤에 알림 포함)·끝난 iframe, 던지는 seek, 차가운 iframe, 70 ms 늦거나 끝내 오지 않는 mute, `isMuted()`·`mute()` 오류,
  음소거 중 영상 바뀜, 재생하지 않는 warm, warm 명령 전의 PLAYING, 음소거 중 iframe 없음이나 바뀜, 예열 중 iframe 바뀜. 부모에서 35행
  모두 통과한다. 새 `arm-steps.test.ts`(9행)는 부모에서 모듈이 없어 불러오기에 실패한다. `authority-arm.test.ts`의 긴 음수 오프셋 행은 기대
  값 그대로 상주 준비로 바뀌었다.
- **변이 확인(구현 때, QA 라운드 1):** 첫 폴을 기다림 없이 하면 12 / 283, 확인되지 않은 폴에서 다시 mute하지 않으면 19 / 283, 열셋째 폴
  3 / 283, `isMuted()` throw를 음소거로 세면 3 / 44, 폴의 `mute()` throw를 잡지 않으면 3 / 44, settle을 30 ms 늦추면 35 / 70(PRO READY
  골든과 와이어 골든 포함), warm 지연이 0 아래로 내려가면 1 / 44, arm 지연을 `Date.now()`로 재면 7 / 125, zero-start 지연을
  `performance.now()`로 재면 1 / 210, zero-start가 warm 명령 전 PLAYING을 받으면 1 / 194, zero-start 울타리가 `player-unavailable`로
  실패하지 않으면 1 / 194, arm 울타리가 iframe을 보지 않으면 2 / 119, zero-start warm 쌍에 `setVolume`이 없으면 19 / 210이 실패한다.
- **이제 고정한 정책 차이(결함 아님):** 음소거 중 iframe이 바뀌면 zero-start는 새 iframe으로 계속 폴하고 데우며 PRO arm은 superseded로
  멈춘다. 음소거 중 iframe이 없으면 zero-start는 `player-unavailable`, arm은 superseded다. warm 명령 전의 PLAYING은 arm이 받고
  zero-start는 받지 않는다(동기로만 올 수 있고 실제 API는 비동기로 알리므로 운영에서는 생기지 않음[추론]). zero-start는 던지는 warm 쌍
  mute를 `youtube-load-failed`로 적는다(진단 이름뿐).

### 6C-5 C2-8b settle (PA-08)

- **공유 settle `settleYouTubeAtTarget`(`src/youtube/arm-steps.ts:196`):** 기계의 warm iframe 정지 뒤, pause-seek 간격(80 ms) 뒤 목표로
  seek, 그다음 settle 폴(80 ms)마다 연속 두 폴이 기계의 영상을 목표 0.12 s 안의 PAUSED나 CUED로 찾을 때까지. 그러지 않은 폴은 재생 중인
  iframe을 멈추고, 여섯째 폴마다(정착한 폴도 셈) 다시 멈추고 seek한다. 시간 값은 `constants.ts`에서 읽고, 시계를 읽지 않고 자기
  타이머도 없다.
- **기계마다 정책(그대로):** zero-start는 seek와 폴마다 목표를 다시 풀고(폴의 try 밖), 상태 바로 뒤에 위치를 읽고(prepare-timeout이
  마지막 폴의 상태, 위치, 목표를 알림), 정지 한 pause-seek 간격 뒤 울타리 뒤에서 다시 seek하고(거기서 던지면 타이머 밖으로 나감), 첫
  seek가 던지면 폴이 목표 밖을 찾게 두며, 다른 iframe이면 seek와 폴 전에 `player-replaced`, iframe이 없으면 seek 전 `player-replaced`·폴
  전 `player-unavailable`, PREPARE 10 s를 넘은 첫 폴에서 `prepare-timeout`이다. PRO arm은 목표 하나, 그 영상의 PAUSED·CUED일 때만 위치
  읽기, 폴 안에서 바로 다시 seek, 첫 seek가 던지면 `player-command-failed`, 폴마다 다른 iframe이면 superseded(첫 seek 전은 아님), 준비
  기한에 `settle-timeout`이다.
- **그 밖:** zero-start 정리는 settle이 목표를 확인했는지(`targetVerified`, settle이 끝날 때 정함)를 안정 횟수 대신 읽는다. 늦춘 다시
  seek가 실행이 아직 settling인지도 확인한다(아래 '중립 메모' (b)). PRO arm은 쓰지 않게 된 paused·cued 상태 이름을 버렸다. 레지스트리
  RO-03(공유 settle과 기계마다 정책, `arm-steps.ts`가 읽는 settle 값, 골든의 settle 행)이 같은 커밋이다. 가드 수, 커버리지 문턱, 와이어는
  그대로다.
- **시험(테스트 먼저 `821d55ee`):** 골든 35 → 63행: 늦거나 끝내 닿지 않는 seek, settle 중 영상 바뀜과 PLAYING, settle의 기다림마다 iframe
  없음·바뀜(정지와 seek 사이, 폴 전, 다시 seek의 정지와 seek 사이), 던지는 pause·seek·위치 읽기, PREPARE 정확히 10 s 뒤의 zero-start
  폴, settle 중 참가자의 로컬 목표가 바뀌는 zero-start 행 둘(앞에는 어느 시험도 'seek와 폴마다 목표를 다시 풂'을 고정하지 않았음). 두
  기계의 타이머는 타이머 밖으로 나간 throw를 `uncaught`로 적는 스케줄러를 거친다(앞 행은 바뀌지 않음). `arm-steps.test.ts` 9 → 37행(새
  28행은 부모에서 'settleYouTubeAtTarget is not a function'으로 실패).
- **변이 확인(구현 때, QA 라운드 1):** 다시 seek 박자를 서로 바꾸면 각각 6행(골든 5와 단위 1), 위치 읽기 순서를 바꾸면 2 / 220과
  1 / 141, 첫 seek throw 정책을 바꾸면 2 / 220과 1 / 141, 울타리 이유나 자리를 바꾸면 1 ~ 5행, zero-start가 정확히 10 s에 포기하면
  1 / 220, 목표를 settle에 한 번만 풀면 2 / 2,217, 늦춘 다시 seek가 폴의 목표로 seek하면 2 / 100, `targetVerified`를 정하지 않으면 4 / 222,
  세 표본이면 43 / 124, 첫 seek 간격을 빼면 61 / 124가 실패한다. PRO arm이 기한 뒤에만 포기하게 바꾼 변이(`>`)는 그 순간 기한 타이머가
  먼저 울려 보이지 않는다.
- **8a + 8b의 크기:** 설계가 추정한 gzip −0.8 ~ −1.3 KB는 생기지 않았다: eager JS gzip +57 B(6C-4 +11, 6C-5 +46), 진입 raw −883 B. 두
  사본이 이미 잘 압축됐고, 클로저와 위치 정책 인자가 지운 사본만큼 든다[추론].

### 첫 리뷰 반영 (`19a81173` ~ `f9bb3c4b`)

첫 독립 리뷰 세 갈래(중립, 주인·가드, 기기 오디오 추론)가 6C-5 끝 `d20acc97`(옮기기 전, 지금 `3f9bf647`)을 봤다(QA 라운드 2). 높음은 없었고, 중간 하나와 낮음·정보를 아래처럼
반영했다.

- **시험만 `19a81173`:** 두 규칙 행에 방장의 레거시 복구 칸(`hostLegacyRecovery`: 방장 자신의 zero-start 준비가 실패한 뒤 실행이 잡아
  둔 'non-positive' 오디오를 가져감)을 더했다(중간). 기록한 값은 칸마다 방장 실행의 확인되지 않은 hard-mute 폴 mute 다섯(+310, +340,
  +370, +400, +431) 뒤, 0.004는 '+481 setVolume(0)', 'unMute()', 'playVideo()', 0.005는 같은 것을 볼륨 1로, 0은 +481부터 +3431까지
  50 ms마다 setVolume(0)·mute(), 그 뒤 +3551부터 +3911까지 120 ms마다 검증 정리이고 창 안에서 재생하지 않는다. Phase 7 계약 (a) 행은
  엔진 볼륨 이벤트마다 쓰기의 `setVolume` 줄만이 아니라 전체 흔적을 O1 모양으로 견주고, 새 행이 `engine.ts`의 진짜 처리기로
  `audio:set-volume` 0.4를 예열 중 방장(마지막이 'start hold? true', unMute 없음)과 주차된 iframe('parking proof', 'mute()')에 보낸다.
  `player.test.ts`의 T0b 다리 행 제목을 바꿨다(아래 'T0b·T0a·6B 파일'). 이 묶음은 이 갈래(19행)와 옮기기 전 바탕 런타임 `89e0b682`(같은 19행)에서
  통과한다(QA 라운드 3). 옮긴 뒤에는 main 런타임 `7b869c35`에서도 통과한다(QA 라운드 7).
- **장부에 직접 묻는 시작 hold(`3738ea92` → `338b3622`):** 6C-2에서는 `registerYouTubeAudioHolds`가 `player.ts`에서 시작 주인의
  hard mute를 셋째 클로저로 받아, 뒤 등록이 그 hold를 보이지 않게 바꿀 수 있었고 unMute를 정하는 조건이 CHECK 12의 시작 claim 읽기 밖에
  있었다. 장부는 아무것도 가져오지 않는 잎이라 `iframe-audio.ts`가 `isYouTubeStartHardMuteOwned`를 가져와(`:72`) 쓰는 순간 묻는다
  (`:200`). 등록은 주차만 받는다(`iframe.ts`가 이 모듈을 가져오므로 주차 쪽은 가져올 수 없음). 보이는 것도 들리는 것도 같다: `player.ts`가
  그 클로저를 불러올 때(어떤 App 쓰기보다 먼저) 등록했고, 장부는 claim이 없으면 등록되지 않은 hold처럼 거짓으로 답한다. 모든 쓰기가
  같은 자리에서 같은 질의를 묻는다(음향 순서 흔적 그대로). 가드 수 그대로이고 CHECK 12는 이제 그 unMute 가드의 장부 호출을 읽는다(그
  문장의 claim 하나). eager JS gzip −19 B. 테스트 먼저 `3738ea92`은 `iframe-audio-owner.test.ts`가 주차만 등록하고 PRO arm claim을 진짜
  장부에 등록하게 바꾸고(기대 흔적 그대로), active 복구 claim이 hard mute를 가진 동안 볼륨 쓰기와 정착의 unMute가 막히고 직접 COMMIT은
  시작 주인을 묻지 않는 행을 더했다. 기록(같은 커밋): `iframe-audio.ts` 머리, RO-12, RO-02, 설계 문서의 독자 행(6C-2부터 독자 23곳, 아홉
  모듈).
- **CHECK 12 주차 hold 등록(`afee2a6c` → `be93e908`):** `registerYouTubeAudioHolds`는 뒤 호출이 바꾸는 모듈 수준 자리이고 첫 호출 전에는
  주차가 아무것도 막지 않아, App 쓰기가 주차된 iframe을 unMute할 수 있다. 레지스트리는 `player.ts`가 한 번 등록한다고 적었지만 검사하는
  것이 없었다(다른 모듈의 export 함수 안에 호출을 더해도 가드 통과). CHECK 12가 이제 `START CLAIM REGISTRATION` 옆에서 실패 닫힘
  `AUDIO HOLD REGISTRATION (RO-12)`으로 `src/youtube/player.ts`의 최상위 문장 하나 밖의 호출(주인 파일 포함), 그곳의 둘째 호출이나 호출
  없음, 넘기기(다시 내보내기, 값으로 씀, 주인 이름공간을 값으로 씀, 주인의 동적 import)를 실패시킨다(`scripts/check-resource-ownership.mts:3610`,
  `:3751`). 실제 트리에서는 하나도 걸리지 않고 수는 그대로다. 가드 머리 항목 12, 레지스트리 가드 항목 12, RO-12가 같은 커밋이다.
- **기록 고침 `f9bb3c4b`(문서만):** RO-12와 `iframe-audio.ts` 머리·`readYouTubeAppAudio` JSDoc(두 규칙의 자리, `youtube:set-volume`
  쓰기는 `readYouTubeAppAudio`를 읽지 않음, hard mute는 `arm-steps.ts`의 공유 대기, 두 arm의 warm 쌍), RO-14(쓰기마다 주차를 묻는 자리),
  RO-02와 설계 문서(대기 술어의 여섯째 독자는 방장의 재생·일시정지 토글), RO-03과 CHECK 11의 `arm-steps.ts` 이유(마지막 폴은 다시 mute하지
  않음, `arm-steps.ts`가 hard-mute·warm·settle 값의 유일한 독자). 빌드 바이트는 `338b3622`과 같다(아래 '번들 크기').
- **고치지 않은 것:** 커밋 `59015d00`의 메시지가 적은 hold 문장은 이 기록 고침이 기록에서 바로잡았고, 메시지는 이력이라 다시 쓰지 않았다.
  리뷰가 낸 선택 기기 후보(PRO 방 iPhone에서 앱으로 일시정지하고 약 1초 안에 직접 경로로 다시 재생)는 아래 '배포 뒤 확인' F에 넣었다.

### 옮긴 뒤 둘째 리뷰 반영 (`4d4e5be2` ~ `a9951bfd`)

main `7b869c35` 위로 옮긴 `6998f04e`를 독립 리뷰 세 갈래(중립, 주인·가드, 기기 오디오 추론)가 다시 봤다(QA 라운드 6). 중립 결함은
없었고, 중간 둘(이 기록이 옮기기 전 브랜치를 적음, 옮긴 뒤 기기 대역 검사를 다시 돌리지 않음)과 낮음들을 아래처럼 반영했다. 런타임은
바꾸지 않았다(주석만 바뀐 `iframe-audio.ts` 말고는 운영 파일 그대로, 크기 같음).

- **시험만 `4d4e5be2`:** settle의 세 정책은 새 모듈의 단위 시험 `arm-steps.test.ts`만 고정했고, 그 파일은 6C 앞 트리에서 돌 수 없어 옛 것과
  새 것이 같다는 증거가 되지 못했다(코드는 셋 다 옛 기계와 같음). 두 기계를 함께 돌리는 `arm-steps-golden.test.ts`에 행 다섯을 더했다(63 →
  68): 한 폴 동안 목표에 정착했다가 7 s로 흘러간 iframe은 그 정착한 폴까지 센 여섯째 폴(+820)에서 다시 seek한다(두 기계), 정착한 폴 다음
  폴의 위치 읽기가 한 번 던지면 안정 횟수가 처음부터다(두 기계, +660에 소리 복원), zero-start에서 PREPARE 10 s 안의 마지막 폴(+9,940)이
  정착을 찾고 10 s를 넘은 첫 폴(+10,020)이 정착을 끝내면 prepare-timeout이 아니라 정착이다(그 뒤 늦은 ARMED와 `commit-wait-timeout`까지
  오늘 동작으로 고정). 각본에는 스스로 움직이는 위치와 한 번만 던지는 위치 읽기 두 손잡이를 더했다. 새 행은 main 런타임 `7b869c35`에서도
  통과하고, 이 트리에서 '정착하지 않은 폴만 셈'(S04), '던지는 읽기가 안정 횟수를 남김'(S06), '정착할 폴 앞에서 예산을 먼저 물음'(S08)
  변이는 각각 새 행만(2, 2, 1) 실패시킨다. 같은 커밋이 `authority-arm.test.ts`의 긴 음수 오프셋 행 확인을 상주 arm 자신의 일로 바꾸고(위
  'T0b·T0a·6B 파일'), 참값표 표본기의 unMuteHeld 주석을 '주인이 쓰는 순간 장부를 물음'으로 고쳤다(주석만, 두 참값표의 답 그대로).
- **CHECK 12 주차 자리와 PRO 관문 쓰는 쪽(`cf8fbfab` → `cf8a5a99`):** `AUDIO HOLD REGISTRATION`은 `registerYouTubeAudioHolds`의 호출만
  보고 그 호출이 채우는 주차 자리의 쓰기는 보지 않았다: `iframe-audio.ts`에 두 자리를 `notHeld`로 되돌리는 함수를 더하고 `iframe.ts`에서
  부르게 한 임시 변이가 가드를 통과했다(그러면 뒤의 App 쓰기가 주차된 iframe을 unMute할 수 있음). 이제 주인 파일에서 `isParked`와
  `enforceParking`의 쓰기는 `registerYouTubeAudioHolds` 본문의 두 대입만 되고(그 함수를 누가 부르든), 두 자리를 값으로 쓰거나 내보내도
  실패한다. 6C-2 전 `player.ts`의 비공개 `let`이던 PRO 관문 토큰은 주인의 export 셋 뒤에 있으므로, 형제 규칙 `PAUSE GATE WRITERS
(RO-12)`가 `holdYouTubePauseGate`, `releaseYouTubePauseGate`, `clearYouTubePauseGate`의 호출을 `src/youtube/player.ts`(관문 처리기 둘과
  `stopYouTubeMode`)에만 두고(주인 파일 포함 다른 곳의 호출, 다시 내보내기, 값으로 씀, 주인 이름공간으로 부름을 실패시킴), 토큰의 쓰기를
  그 셋 안에만 둔다(`scripts/check-resource-ownership.mts:3560`, `:3601`). 실제 트리에서는 하나도 걸리지 않고 수와 `--report` 107줄은
  그대로다. 테스트 먼저 `cf8fbfab`의 새 행 다섯 가운데 넷은 규칙이 없는 부모에서 실패한다. 가드 머리 항목 12, 레지스트리 가드 항목 12,
  RO-12가 같은 커밋이다.
- **기록 고침 `a9951bfd`(주석과 레지스트리만):** `iframe-audio.ts` 머리와 `readYouTubeAppAudio` JSDoc, RO-12의 'Two mute rules remain'은
  zero-start 실행의 원하는 오디오(복원, 출시 unMute, 취소 복원)와 PRO 준비를 'non-positive' 규칙에 두었는데, 그것은 각 기계가 시작할 때
  잡는 값뿐이다. 실행 중 `youtube:set-volume`마다(두 기계와 복구 의도), PRO 관문 정착마다(PRO arm), 게스트 로컬 대체를 넘겨받는 실행이
  바쁨이 될 때(넘겨받은 준비의 의도) `player.ts`가 'rounded' 답을 밀고, 민 답이 잡은 값을 바꾼다(`zero-start.ts`와 `authority-arm.ts`의
  `updateDesiredAudioState`). 그래서 볼륨 이벤트를 받은 실행은 오늘도 'rounded' 규칙을 따른다(아래 '6C-3'). 빌드 크기는 `6998f04e`와
  같다(아래 '번들 크기').
- **기록 고침 `f9f4a57c`:** 이 보고서와 `docs/README.md`를 옮긴 뒤 모습(바탕, 버전, 배포 대상, SHA, 크기, 되돌리기, 순서, 오너 메모, QA
  라운드 5 ~ 7, Phase 7 계약 확인)으로 고쳤고, 6C-3 표에 넘겨받은 준비의 의도와 잡는 때를 적었다. 마지막 검사(QA 라운드 8)는 그 뒤의 기록
  커밋이 이 보고서에만 적었다(`docs/README.md` 항목은 9.0.33 위로 옮길 때 다시 고침).
- **반영하지 않은 것:** 두 규칙 행에 넘겨받은 준비 칸(`transferredPrepare`)을 더하는 선택 제안은 싣지 않았다. 게스트 로컬 대체 중
  (2.8 ~ 3.4 s) 원격 방장이 새 준비를 시작하는 탐침을 이 트리에서 돌렸지만 어느 시점에서도 그 실행이 0.004에서 unMute해, 넘겨받은
  'rounded' 의도가 실행에 닿는 길을 재현하지 못했다(원인 미확인, 아래 '6C-3'). 커밋 `59015d00`의 메시지는 이력이라 그대로다.

### 중립 메모: 운영에서 닿지 않는 의미 차이 셋

- **(a) 첫 hard-mute 폴의 예약(`e35bbbfa`):** 첫 폴은 이제 각 기계의 try 안에서 예약된다. 전에는 던지는 스케줄러가 밖으로 나갔다: PRO
  arm에서는 Promise executor 밖으로 나가 `prepare()`를 거절하고 `#run`을 기한 타이머 없이 'muting'에 남겼고, zero-start에서는
  `handlePrepare`와 `beginHostTransition` 밖으로 나갔다. 이제는 `hard-mute-command-failed`나 `player-command-failed`로 실패한다. 운영의
  스케줄러는 `setTimeout`을 감싸고 던지지 않는다.
- **(b) 다시 seek의 settling 울타리(`3f9bf647`):** zero-start의 늦춘 다시 seek가 실행이 아직 'settling'인지도 확인한다. 그 타이머가 울릴
  때는 늘 그렇다: 실행이 현재인 채 settling을 떠나는 모든 길이 실행의 타이머를 먼저 지우고, 다시 seek(80 ms 간격)는 다음 80 ms 폴보다
  먼저 울린다.
- **(c) warm 지연의 바닥(`e35bbbfa`):** zero-start의 `warmPlayingMs`는 0 아래로 내려가지 않는다. 그 유일한 독자인 ARMED 프레임은 보내는
  쪽에서 이미 0 ~ 60,000 ms로 묶는다.

첫 독립 리뷰가 옮기기 전 바탕 `89e0b682`와 `d20acc97`의 두 기계를 각본 1,800개(seed 셋)와 설정 다섯으로 돌린 차등 시험 9,000회, 다른 갈래가 각본 50,000개로
돌린 200,000회에서 명령, 보고한 상태, 단계, debug 줄, 오류, 와이어 프레임, 결과가 모두 같았다. 바탕과 머리의 App 쓰기 차등 시험(무작위
순서 1,200개)도 iframe 명령, 시작 기계로 미는 값, hold 물음이 바이트로 같았다(QA 라운드 2).

## T0b·T0a·6B 파일

6C가 바꾼 앞 단계 시험 파일은 아래뿐이고 기대 값과 강제 값은 바꾸지 않았다. 두 T0b 참값표(`youtube-start-ownership-table.test.ts`,
`youtube-start-ownership-table-pro.test.ts`, U·P 행과 비동기 전달 변형 포함), `fake-yt-player.ts`, T0a 골든(`standard-start-wire-golden.test.ts`,
`pro-ready-timing-golden.test.ts`, 로그 동결 `youtube-quoted-log-lines.test.ts` 등), PRO 늦은 합류 고정(`pro-late-prepare-reload.test.ts`,
`playback-late-cohort-join.test.ts`), 6B 행(`start-ownership.test.ts`, `start-ownership-reader-windows.test.ts`)은 바탕과 바이트로 같다
(`git diff 7b869c35..a9951bfd`에 없음). main의 Phase 7 T0 시험 파일(`src/audio/__tests__`,
`media-session-lock-screen-pause.test.ts`, `e2e/audio-lab`, `playwright.audio-lab.config.ts`)도 바뀌지 않았고,
`vitest.critical.config.ts`는 6C의 포함과 문턱(QA 라운드 1)이 #559의 포함과 문턱 옆에 자동 병합으로 놓였다(QA 라운드 5).

- **다리 훅을 지워 꼭 필요했던 T0b 이음새 둘(6C-2 `59015d00`):** `player.test.ts`의 T0b 행(#552) 'answers the PRO pause gate and the
  pending-start cancel through the bridge'는 관문을 `isYouTubePauseGateHeld()`로 묻고, 첫 리뷰 반영 `19a81173`에서 제목이 'answers the PRO pause
  gate through the iframe audio owner and the pending-start cancel through the bridge'가 됐다. 참값표 표본기
  `__helpers__/start-ownership-sampler.ts`(#553)의 pauseGate 열도 `isYouTubePauseGateHeld`를 읽는다. 기대 값은 그대로다. 바탕의 두
  파일을 이 갈래의 런타임에서 돌리면, 그 행은 'TypeError: bridge.isProPlaybackPauseGatePendingFromIframe is not a function'으로만
  실패하고(`player.test.ts` 137행 가운데 1), 바탕의 표본기로는 두 참값표 81행 가운데 표본을 읽는 76행이 같은 지운 훅
  ('isProPlaybackPauseGatePendingFromIframe is not a function')으로만 실패한다(QA 라운드 3). 이 갈래의 표본기로는 두 참값표가 81 / 81이고
  참값표 파일은 바탕과 바이트로 같다. 훅을 남기면 시험 전용 export가 되므로(Q11) 이 둘은 'T0b 행 그대로'가 아니라 아래 Q12 시험 지움과
  함께 바꾼 것으로 적는다.
- **Q12 시험 지움(6C-4 `e35bbbfa`):** `authority-arm.test.ts`의 load 행 둘을 지웠고 준비 도우미의 전략 타입이 'resident'만이 됐다. 긴 음수
  오프셋 행은 기대 값 그대로 상주 준비로 바뀌었다(테스트 먼저 `67ce787b`). 그 행은 상주 영상을 스스로 넣은 뒤 영상 확인만 남겨 아무것도 증명하지 못했으므로, 둘째 리뷰 반영
  `4d4e5be2`가 그 확인을 상주 arm 자신의 일(다음 준비의 warm과 settle이 3 s로 seek, `loadVideoById` 없음)로 바꿨다(기대 값 그대로, main
  런타임에서도 통과). 바탕의 이 파일을 이 갈래에서 돌리면 82행 가운데 그 셋(지운
  load 행 둘과 load로 준비하던 긴 음수 오프셋 행)만 실패한다(QA 라운드 3).
- **대역 키 지움(6C-2):** `host-local-rendezvous.test.ts`, `native-control-owner-ports.test.ts`, `zero-start-heartbeat-ownership.test.ts`의
  대역 훅 객체에서 지운 다리 키 하나씩. 바탕의 세 파일은 이 갈래의 런타임에서도 그대로 통과한다(70 / 70, 10 / 10, 24 / 24).
- **더한 행과 바늘:** `local-offset.test.ts`에 R3 12행(바탕의 19행은 이 갈래에서도 19 / 19), `resource-ownership-guard.test.ts`에
  `AUDIO HOLD REGISTRATION` 행(그 묶음 98행)과 seek mid-sync 행의 바늘(`player.ts`의 시작 장부 import가 한 줄이 되어 바늘이 그 import를
  따름, 기대 결과 그대로. 바탕의 이 파일을 이 갈래에서 돌리면 94행 가운데 이 행만 여러 줄 import를 찾지 못해 실패한다).
- **바탕 런타임에서의 새 고정:** 6C의 새 중립 고정 넷(라우터, 음향 순서, 무장 골든, `local-offset.test.ts`)의 코드 끝 사본을 main
  런타임 `7b869c35`에 돌려 127 / 127 통과한다(라우터 9, 음향 순서 19, 무장 골든 68, `local-offset.test.ts` 31, QA 라운드 7). 옮기기 전
  바탕 `89e0b682`에서는 골든 63행으로 122 / 122(QA 라운드 3), 옮긴 `6998f04e`의 사본은 main 런타임에서 122 / 122였다(QA 라운드 6).
- **옮긴 뒤 main의 시험 파일로:** 이 갈래가 고친 앞 단계 시험 파일 여섯을 main 것으로 바꿔 `6998f04e`에서 돌리면 342행 가운데 실패는
  Q12 load 행 셋과 `player.test.ts`의 다리 행 하나뿐이다(338 / 342, QA 라운드 6).

## 계획과 달라진 것

1. **줄 번호:** 계획 인용은 `78ec56f5` 기준이라 모든 위치를 기호로 다시 찾았다.
2. **6C-3은 만들지 않았다:** 오너 답(Q2)의 '만들기 전 전후 시각 표'대로 표만 준비했다. 계획의 머지 순서(6C-1 → 6C-2 → 6C-4 → 6C-5 →
   6C-3 → 6C-6)에서 6C-3과 6C-6이 남는다.
3. **주차 hold 등록 자리:** 계획은 `retained-player-controller.ts`의 주차 hold 등록을 적었다. 주인 모듈은 주차 쪽을 가져올 수 없어(`iframe.ts`가
   주인을 가져옴) `player.ts`가 클로저 둘(`isRetainedYouTubePlayerParked`, `ensureRetainedYouTubePlayerHardMuted`, 둘 다 `iframe.ts`를 거쳐
   controller에 닿음)로 한 번 등록한다(RO-14 문장). controller 파일은 바뀌지 않았다.
4. **시작 hold는 등록이 아니라 장부 직접 물음:** 6C-2는 셋째 클로저로 받았고, 첫 리뷰 반영 `338b3622`이 장부를 직접 묻게 바꿨다. CHECK 12에
   계획에 없던 `AUDIO HOLD REGISTRATION` 규칙을 더했고(`be93e908`), 옮긴 뒤 둘째 리뷰 반영이 그 규칙을 주인의 주차 자리
   쓰기까지 넓히고 `PAUSE GATE WRITERS`를 더했다(`cf8a5a99`).
5. **시작 기계는 아직 원하는 오디오를 받아서 쓴다:** 레지스트리의 목표('기계도 주인에게서 읽음')와 달리 `player.ts`가 오늘 순서대로 두
   기계에 원하는 오디오를 밀고(`updateYouTubeZeroStartDesiredAudioState`, `updateProYouTubeAuthorityDesiredAudioState`), 주인은 App 쓰기와
   hold만 갖는다. 미는 순서와 시점이 바뀌면 중립이 깨질 수 있어서다. PRO arm이 주인에서 읽는 것은 6D-4(C2-13)다.
6. **PA-15:** 대기 술어는 합치지 않고 레거시 전용으로 남겼다(설계 문서와 RO-02에 이유). 합친 것은 room time 읽기 하나다.
7. **첫 mute도 공유 대기 안:** 6C-4는 첫 `mute()`까지 `waitForYouTubeHardMute`에 넣었다(CHECK 11 20. 껍데기에 남겼다면 21).
8. **크기:** 8a + 8b의 gzip 감소는 생기지 않았다(위 6C-5). Phase 상한 안이다.
9. **더한 시험과 가드:** 방장 레거시 복구의 두 규칙 칸, Phase 7 계약 (a)의 전체 흔적과 hold 행, `AUDIO HOLD REGISTRATION`(첫 독립 리뷰
   반영), 두 기계 골든의 settle 정책 행 다섯, 주인의 주차 자리 쓰기 검사와 `PAUSE GATE WRITERS`(옮긴 뒤 둘째 독립 리뷰 반영)는 계획에
   없었다.
10. **6C-6(버전 올리기·문서)은 이 브랜치에 없다:** 릴리스 담당이 더한다(아래 '배포 조건과 순서').
11. **두 번 옮김:** 계획은 6B 위에 쌓고 6B가 main에 들면 한 번 옮기는 것이었다. 6B 뒤에 9.0.33(한글 Pretendard)이 끼어 6C는 9.0.34가
    되고, 9.0.33이 main에 든 뒤 한 번 더 옮긴다(아래 '머지 전에 할 일' 1).

## 정확한 개수 가드

바탕 열은 옮기기 전 바탕 `89e0b682`에서 잰 값이고(QA 라운드 3), main `7b869c35`도 같다: 둘의 운영 `src` 차이는 `src/i18n`의 두
파일 안쪽(import, export, 파일 수 변화 없음)과 버전 줄뿐이다. 끝 열은 코드 끝 `a9951bfd`의 값이고(QA 라운드 7), 기록 끝 `f9f4a57c`의
마지막 검사(QA 라운드 8, `--report` 107줄은 줄 번호를 빼면 라운드 5와 같음)와 옮기기 전 끝 `6915ee9e`(QA 라운드 4), 옮긴 `6998f04e`(QA
라운드 5)의 값과 같다(둘째 리뷰의 규칙 둘과 brand capitalization만 다름).

| 가드                                                       | 바탕 `89e0b682` = `7b869c35`                                                                                                       | 코드 끝 `a9951bfd`                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CHECK 11 iframe 오디오 쓰기(RO-12)                         | 32(`zero-start.ts` 6, `authority-arm.ts` 4, `player.ts` 14, `iframe-audio.ts` 3, `iframe.ts` 3, `retained-player-controller.ts` 2) | 20(`arm-steps.ts` 2, `zero-start.ts` 2, `player.ts` 4, `iframe-audio.ts` 7, `iframe.ts` 3, `retained-player-controller.ts` 2) |
| CHECK 12 남의 시작 타이머 읽기 / 지우기(RO-02)             | 11 / 9                                                                                                                             | 11 / 9                                                                                                                        |
| CHECK 12 파사드 쓰기 / 실행 스냅샷 읽기 / 장부 합성        | 2 / 8 / 1                                                                                                                          | 2 / 8 / 1(같은 `player.ts :: seekYouTubeFromApp`)                                                                             |
| CHECK 12 주차 hold 등록과 자리(`be93e908`, `cf8a5a99`부터) | 규칙 없음                                                                                                                          | `player.ts` 최상위 문장 하나, 넘기기 없음, 주인의 두 자리는 등록 함수의 두 대입만                                             |
| CHECK 12 PRO 관문 쓰는 쪽(`cf8a5a99`부터)                  | 규칙 없음                                                                                                                          | 셋터 셋은 `player.ts`의 관문 처리기 둘과 `stopYouTubeMode`만, 토큰 쓰기는 셋터 안만                                           |
| CHECK 5 복사 / 의심 / 같은 값 쌍(보고만)                   | 1 / 1 / 45                                                                                                                         | 1 / 1 / 45(YouTube 시작 계약 파일에 `arm-steps.ts`)                                                                           |
| resource-ownership                                         | 49 records, 457 production files, `--report` 119줄                                                                                 | 49 records, 458 production files, `--report` 107줄                                                                            |
| dead-exports                                               | 410 prod files, 2,161 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76                                                       | 411, 2,173, 0, 20, 76                                                                                                         |
| import-graph                                               | 410 files, 2,101 edges, 순환 0                                                                                                     | 411 files, 2,107 edges, 순환 0                                                                                                |
| bus-pairing                                                | 202 / 202                                                                                                                          | 202 / 202                                                                                                                     |
| room-authority                                             | 79 / 22 / 13 / 0 / 0, 410 files                                                                                                    | 79 / 22 / 13 / 0 / 0, 411 files                                                                                               |
| brand capitalization                                       | 1,035 copy sources(`89e0b682`)                                                                                                     | 1,040(main의 기록과 시험이 더한 원본 포함, `f9f4a57c`에서도 1,040)                                                            |

`--report`의 바뀐 줄은 CHECK 11 사이트 열둘(32 → 20)과 줄 번호뿐이다. 내린 기준치는 CHECK 11(6C-2, 6C-4)이고 올린 기준치는 없다. 규칙
`AUDIO HOLD REGISTRATION`과 `PAUSE GATE WRITERS`는 수가 아니라 자리를 고정한다. 기준치와 레지스트리는 센 코드를 옮긴 커밋(`59015d00`,
`e35bbbfa`)과 규칙을 더하거나 넓힌 커밋(`be93e908`, `cf8a5a99`)이 같은 커밋에서 고쳤다. dead-exports의 새 binding 열둘(6C-1 claim 종류
타입 1, 6C-2 주인의 export 여덟과 지운 다리 훅 하나로 +7, 6C-4 무장 단계 셋, 6C-5 settle 하나)은 모두 운영이 쓰고, 옮긴 뒤 main과 견줘도
완전히 죽은 것, 시험 전용, 자기 전용 집합이 같다(QA 라운드 6). import-graph의 새 간선 여섯(6C-2 둘, 6C-4 셋, `338b3622`의
`iframe-audio.ts` → `start-ownership.ts` 하나)은 순환을 만들지 않는다. source-complexity(YouTube 파일은 목록에 없음)도 바뀐 기준치가 없다.

## 번들 크기

같은 툴체인(Node 24.22.2, vite 8.3.3)으로 `npm run build`를 하고 `scripts/check-initial-transfer-budget.mts`의 `measureInitialTransfer`로
바이트를 읽었다. 6C의 순증은 옮긴 뒤 바탕 main `7b869c35`(9.0.32 런타임) 대비로 잰다: 둘째 리뷰가 `7b869c35`와 `6998f04e`를 쟀고(QA
라운드 6), 그 바탕(이 갈래의 운영 `src/youtube` 여덟 파일만 `7b869c35` 것으로 바꾼 같은 트리)과 코드 끝 `a9951bfd`를 다시 쟀고(QA
라운드 7), 마지막 검사가 `7b869c35`의 깨끗한 임시 worktree(자기 `npm ci`) 빌드와 기록 끝 `f9f4a57c`의 `build:checked` 빌드를 다시
쟀다(QA 라운드 8). 세 번의 수가 같다. 아래 마지막 두 줄은 그사이 main이 된 `4faf38d9`(9.0.33)와, 같은 임시 worktree에서 그 위에 이
갈래의 `src` 차이만 얹은 시험 트리(커밋하지 않음)다(QA 라운드 8).

| 빌드                                                   | 진입 청크          | 진입 raw / gzip   | eager JS gzip | eager total raw / gzip |
| ------------------------------------------------------ | ------------------ | ----------------- | ------------- | ---------------------- |
| 바탕 main `7b869c35`(9.0.32)                           | `main-FMXWdlb7.js` | 861,056 / 253,683 | 465,403       | 2,048,923 / 543,650    |
| 코드 끝 `a9951bfd`(`6998f04e`, `f9f4a57c`와 같은 크기) | `main-BmRvLMcR.js` | 859,737 / 253,702 | 465,436       | 2,047,647 / 543,682    |
| 차                                                     |                    | −1,319 / +19      | **+33**       | −1,276 / +32           |
| 지금 main `4faf38d9`(9.0.33, 참고)                     | `main-jGfUMtkO.js` | 861,056 / 253,686 | 465,404       | 2,049,037 / 543,682    |
| `4faf38d9` + 이 갈래의 `src` 차이(시험 트리, 참고)     | `main-BMqZqEcM.js` | 859,737 / 253,706 | 465,437       | 2,047,761 / 543,714    |
| 차(참고)                                               |                    | −1,319 / +20      | +33           | −1,276 / +32           |

- **6C 순증(main `7b869c35` 대비):** eager JS gzip +33 B, eager total gzip +32 B, eager total raw −1,276 B, 진입 raw −1,319 B, 진입 gzip
  +19 B. 바뀐 eager 파일은 진입 청크와 `transport`(raw +43), 그리고 gzip만 1 ~ 2 B 바뀐 `index.html`과 `peer`뿐이다.
  `guard:initial-transfer-budget`을 통과한다(entry 839.6 KiB raw / 247.8 KiB gzip, eager JS 454.5 KiB gzip, eager total 1,999.7 KiB raw /
  530.9 KiB gzip, QA 라운드 6, 8).
- **9.0.33 위에서(참고, QA 라운드 8):** `4faf38d9` 대비 시험 트리의 차는 eager JS gzip +33 B, eager total gzip +32 B, 진입 raw −1,319 B로
  `7b869c35` 대비와 같고 진입 gzip만 1 B 다르다. 바뀐 eager 파일도 같은 넷이다. 9.0.33의 `7b869c35` 대비 차는 CSS(`main.css` raw +114 B /
  gzip +32 B)와 gzip 몇 바이트뿐이라 6C의 순증을 바꾸지 않는다. 옮긴 뒤 정식으로 다시 잰다(아래 '머지 전에 할 일' 1).
- **증분별(옮기기 전 바탕 `89e0b682` 위에서 커밋마다, 부모 대비 eager JS gzip, QA 라운드 3):** 6C-1 `efcc24f2`(지금 `6edfda84`) +69,
  6C-2 `8ef3794a`(`59015d00`) −73, 6C-4 `376552c7`(`e35bbbfa`) +11, 6C-5 `d20acc97`(`3f9bf647`) +46, 첫 리뷰 `1984c751`(`338b3622`) −19.
  모두 증분 상한 +300 B 안이다. 그때의 순증은 +34 B였고, 옮긴 뒤 +33 B와의 1 B 차이는 바탕의 9.0.31 글꼴 파일이 압축 문맥을 바꾼 것으로
  본다[추론]. 기록 고침 `f9bb3c4b`, `a9951bfd`는 주석만 바꾸고, 테스트 먼저와 가드 커밋은 런타임을 바꾸지 않는다.
- **Phase 6 누계(계획 §4.2-6, 증분마다 부모 대비 잰 차의 합, 사이에 낀 Phase 6 밖 열차는 뺌):** 6A −149 B + 6B −53 B + 6C +33 B =
  **−169 B**로 Phase 상한 +200 B 안이다(6C 앞까지 −202 B, 6C의 +33 B는 QA 라운드 8에서 다시 잼). 사이에 낀 9.0.31, 9.0.33 같은 Phase 6 밖 열차의 차는
  누계에 넣지 않는다. Q29의 멈춤 조건에 해당하지 않는다.
- 6C-1의 +69 B는 라우터와 합친 읽기, 6C-2의 −73 B는 지운 다리 훅과 `player.ts`의 반복된 오디오 계산이 주인 하나로 모인 것, 6C-4·6C-5의
  +57 B는 공유 단계의 클로저와 정책 인자, `338b3622`의 −19 B는 등록 클로저 하나가 빠진 것으로 본다[추론].
- 9.0.33 위로 다시 옮기면 그 새 부모 대비로 다시 잰다(아래 '머지 전에 할 일' 1).

## 혼합 버전

계획 §4.8의 혼합 버전과 §5의 6C 행이다. 근거는 기기 혼합 행이 아니라 T0a의 프레임·시각 골든과 T0b 참값표, 6C의 무장 골든이 바이트
그대로 통과한 것이다(Phase 5의 P5-D9 C 선례). 와이어(`src/network/protocol.ts`, `src/types/index.ts`, `src/core/constants.ts`, `cloudflare/`)는
main `7b869c35`(운영 9.0.32)와 바이트로 같다.

| 조합                                              | 결과                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6C 방장과 옛 게스트: 레거시 대기 동안의 방장 상태 | 대기 술어 `isStandardHostYouTubeLocalStartPending`을 레거시 전용으로 남겨(6C-1) 방장 하트비트 상태(`sync.ts`)와 재생·일시정지 토글이 같은 술어를 같은 때 묻는다. 옛 게스트가 받는 state 1은 그대로다(T0a 와이어 골든, `standard-start-pause-teardown.test.ts`의 비평 blocker 행). 합쳤다면 바뀌었을 자리다 |
| 옛·새 방장과 게스트: 시작 프레임과 시각           | 무장 단계를 옮긴 두 기계의 명령과 프레임이 같은 순간에 나간다(무장 골든 68행이 main 런타임 `7b869c35`에서도 같음, T0a 와이어 골든 그대로)                                                                                                                                                                  |
| 옛·새 기기: 0 < 마스터 볼륨 < 0.005               | 6C-3을 만들지 않았으므로 ARMED의 `muted` 값도 그대로다. 6C-3을 만들면 게스트 ARMED의 `muted`만 0.004 같은 값에서 바뀌고, 방장의 ARMED 처리는 그 값을 읽지 않는다(계획 §4.8)                                                                                                                                |
| PRO 방의 옛·새 기기                               | PREPARE·READY·COMMIT은 서버를 거치고 서버는 바뀌지 않는다. T0a PRO READY 시각 골든과 T0b PRO 참값표가 그대로다                                                                                                                                                                                             |
| 바닥 795 아래의 열린 세션                         | 바닥은 열린 세션을 닫지 않는다. 6C는 프레임을 얼려 그 위험을 더하거나 줄이지 않는다                                                                                                                                                                                                                        |

결과가 다르더라도 '방이 zero-start 대신 레거시로 시작' 같은 품질 저하이고 재생이 멈추지는 않는다고 본다(계획 §5, 추론).

## 되돌리기

기본은 더 높은 SemVer·epoch의 앞으로 고치기다. 새 되돌리기 경계는 없다: 계약 표지, D1, 저장 모양, 바닥을 바꾸지 않아 forward floor가
생기지 않는다.

- **실패 자동 복구:** target `app`의 실패 복구는 릴리스 안에서 checkpoint의 App(dispatch 때의 운영 App)으로 간다. 6C 앞에 9.0.33(한글
  Pretendard)이 나가므로 checkpoint는 9.0.33의 App이다(6B의 9.0.32가 아님). 바닥 795 이상이라 `lower`가 필요 없고, 와이어가 같아 되돌린 App과 6C가 섞인 방도 같은 프레임을 같은 시각에 보낸다.
- **손 되돌리기:** 배포 뒤 checkpoint App으로 가는 손 되돌리기는 6C를 받은 클라이언트에 낮은 epoch를 돌려주므로 release-record §2의 열린
  항목('낮은 epoch로 가는 App 손 되돌리기의 규칙', 결정 전)과 `docs/hotfix-procedure.md`를 따른다. 결정 전에는 6C만 빼는 다음 번호의 코드
  되돌리기가 기본이고, 급할 때만 명시적으로 검토한 CLI 되돌리기다.
- **혼자 되돌릴 수 있는 기간:** 6D가 머지되기 전까지다(계획 §4.8: 6D-4가 6C-2의 `iframe-audio.ts`를 읽음). 그 뒤에는 6C부터 가장 최근
  열차까지 앞으로 되돌린다: 새 `agent/` 갈래에서 그 열차들의 커밋을 거꾸로 되돌리고, 다음 SemVer·epoch(버전 거울 여섯과 `index.html`의
  bootstrap 캐시 쿼리), 전체 게이트, App 릴리스, 기록. 앞으로 되돌리기와 앞으로 고치기는 각각 업데이트 창 하나를 Q1의 넷 밖으로 더한다.
  6C-3을 실으면 6C를 되돌릴 때 함께 되돌아간다(Q2).
- **증분을 골라 되돌릴 때(SHA는 main `7b869c35` 위로 옮긴 것, 9.0.33 위로 다시 옮기면 그 SHA로 바꿈):** 6C-5만은 `3f9bf647`과
  `821d55ee`을 함께(settle 단위 행이 공유 settle을 요구, 골든 행은 두 런타임 모두 통과, `4d4e5be2`의 골든 행 다섯도 두 런타임에서 통과해
  남겨도 됨). 6C-4를 되돌리면 6C-5도 함께이고 CHECK 11이 26으로, Q12 시험 둘과 load 갈래가 돌아오며 `4d4e5be2`의 긴 음수 오프셋 행 고침도
  함께 되돌린다. 6C-2를 되돌리면 그 위의 첫 리뷰 반영 넷(`3738ea92`, `338b3622`, `afee2a6c`, `be93e908`), `19a81173`의 Phase 7 hold 행,
  둘째 리뷰의 가드 둘(`cf8fbfab`, `cf8a5a99`)과 `a9951bfd`의 주석·레지스트리 문장도 함께이고, CHECK 11이 32로, 다리 훅과 T0b 이음새 둘이
  main 모양으로 돌아온다. 6C-1은 뒤 증분이 라우터에 기대지 않아 혼자 되돌릴 수 있다[추론]. 가드 기준치와 레지스트리는 센 코드를 옮긴
  커밋과 함께 되돌아온다.

## 6C-3: 준비함, 만들지 않음, 오너를 기다림

계획 §4.8의 6C-3(PA-12, 'intended')이다. 오너가 2026-10-30에 '예'(Q2)라고 답하며 '만들기 전에 전후 시각 표를 먼저'라고 했으므로 만들지
않고 아래 표를 준비했다. 같은 표를 쉬운 말로 오너에게 따로 드린다(아래 '오너에게' 1). 오너가 '예'면 이 열차의 마지막 런타임 증분(6C-5와
리뷰 반영 뒤, 버전 올리기 앞)으로 실패 시험 먼저 만들고, 이 절을 그 '의도한 변경'의 자기 절로 바꾼다. '아니요'면 두 규칙을 이름 붙은
그대로 둔다(동작 그대로, 증분 없음).

- **바꾸는 것:** `readYouTubeAppAudio`(`src/youtube/iframe-audio.ts:118`)의 'non-positive' 변형을 지워, 그 두 독자(Standard zero-start
  실행의 원하는 오디오 `src/youtube/player.ts:2277`, PRO 준비 `src/youtube/iframe.ts:2182`)가 'rounded'를 쓴다. 그러면 실행이 잡아 둔 값을
  가져가는 다섯 자리(실행의 복원과 출시 unMute, 준비 취소 때의 복원, 게스트 로컬 복구, 방장 자신의 실행이 실패한 뒤의 레거시 복구)도
  함께 바뀐다. 계획 표가 적은 두 경우(zero-start 시작, PRO 준비)보다 넓다.
- **'non-positive'는 시작 때 잡는 값뿐:** 두 기계는 시작할 때 원하는 오디오를 'non-positive'로 잡지만, 실행 중 `youtube:set-volume`마다
  (두 기계와 복구 의도), PRO 관문 정착마다(PRO arm), 게스트 로컬 대체를 넘겨받는 실행이 바쁨이 될 때(넘겨받은 준비의 의도,
  `src/youtube/player.ts:2305`, `:2394-2396`) `player.ts`가 'rounded' 답을 밀어 잡은 값을 바꾼다(`a9951bfd`가 RO-12와 `iframe-audio.ts`에
  적음). 그래서 아래 '지금' 칸은 실행 중 그런 밀기가 없을 때의 값이다. 0.5 % 아래 값이 실제로 들어오는 길로 본 방 설정 맞추기
  (`src/audio/effects.ts:681` → `audio:set-volume` → `youtube:set-volume`)가 실행 중에 오면 그 실행은 오늘도 'rounded'를 따르고, 6C-3은
  그 실행을 바꾸지 않는다. 넘겨받은 준비의 의도는 코드상 'rounded'이지만, 게스트 로컬 대체 중(2.8 ~ 3.4 s) 새 준비를 넣은 로컬 탐침에서는
  그 실행이 0.004에서 unMute했다(넘겨받은 의도가 실행에 닿는 길을 재현하지 못함, 원인 미확인, QA 라운드 7). 6C-3을 만들 때 이 길을 먼저
  확인한다.
- **측정:** 옮기기 전 브랜치 끝 `6915ee9e`(지금 `f9bb3c4b`)의 임시 worktree에서 시험용 가짜 YouTube 화면으로, 오늘 코드('지금')와 그 변형을 메모리에서만 지운 같은
  코드('바뀐 뒤', 추적 파일 바뀜 없음)를 견줬다(QA 라운드 3). 계획 때 바탕에서 잰 값과 모두 같다. 일반방은 방장이 ▶를 누른 때(참가자는
  방장이 시작한 때), PRO는 서버 PREPARE부터 센다. '무시 n번'은 WebKit이 unMute를 무시하는 흉내이고 기기에서 잰 값이 아니다.

마스터 볼륨 0.4 %(0.004)에서 경우마다:

| 경우                                                                                                                                                      | 지금                                                                                                                     | 바뀐 뒤                                                                                                                  | 보이고 들리는 차이                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 일반방 zero-start, 방장과 참가자(실행 중 볼륨 이벤트와 넘겨받은 의도가 없을 때)                                                                           | 0.5초 `setVolume(0)`·`unMute()`, 1.32초 재생과 `unMute()`(참가자 ARMED 0.62초)                                           | 0.5초 `setVolume(0)`·`mute()`, 1.32초 재생(unMute 없음)                                                                  | [화면 바뀜] iPhone: 지금은 YouTube 소리가 기기 볼륨으로 들림 → 바뀐 뒤 무음(데스크톱·Android는 볼륨 0이라 들리는 차이 없음[추론]). 시각은 같다                                                    |
| PRO 준비(준비 중 볼륨 이벤트와 관문 정착이 없을 때)                                                                                                       | 0.5초 `setVolume(0)`·`unMute()`, READY 0.62초(음소거 아님)                                                               | 0.5초 `setVolume(0)`·`mute()`, READY 0.62초(음소거)                                                                      | 위와 같음. 시각은 같다                                                                                                                                                                            |
| 준비 중 피어 교체로 방장 실행이 취소될 때의 복원                                                                                                          | 0.3초 `setVolume(0)`·`unMute()`, 1.8초 `mute()`, 1.85초 교체 대체가 음소거로 재생                                        | 0.3초 `setVolume(0)`·`mute()`, 뒤는 같음                                                                                 | 들리는 차이 없음(그 사이 iframe은 멈춰 있음). 시각은 같다                                                                                                                                         |
| 게스트 로컬 복구(다음 트랙 준비 실패, 코호트 제외)                                                                                                        | 3.0초 `setVolume(0)`·`unMute()` 두 번 뒤 재생                                                                            | 3.0초 `setVolume(0)`·`mute()` 두 번 뒤 재생                                                                              | [화면 바뀜] iPhone: 기기 볼륨으로 들림 → 무음. 시각은 같다                                                                                                                                        |
| 방장 자신의 실행이 실패한 뒤의 레거시 복구(iframe이 hard mute를 끝내 확인하지 않는 드문 경우)                                                             | 0.38초 `setVolume(0)`·`unMute()`·재생, 같은 때 Stage-1 `YOUTUBE_STATE`, 4.38초 Stage-2 `YOUTUBE_SYNC`, 재생 버튼 재생 중 | 0 %일 때처럼 0.38초부터 3.33초까지 50 ms마다 `setVolume(0)`·`mute()`, 4.17초까지 검증 정리, 재생 없음, Stage 프레임 없음 | [화면 바뀜] 그 경우 방장 기기의 재생 버튼이 ▶ 그대로이고 영상이 0:00에 멈추며 참가자도 시작하지 않는다(지금 0 %와 같은 길, T0b 결함 첫째 H4의 길[추론]). 재생 버튼의 로딩 표시(0 ~ 0.33초)는 같다 |
| 볼륨 쓰기, 관문 정착, 직접 COMMIT, 교체 대체 자신의 의도, 넘겨받은 준비의 의도(게스트 로컬 대체를 넘겨받는 실행), 실행 중 볼륨 이벤트나 관문 정착이 민 값 | 지금도 'rounded'(음소거)                                                                                                 | 같음                                                                                                                     | 없음                                                                                                                                                                                              |

WebKit이 unMute를 무시하는 흉내에서(0.4 %, 지금 → 바뀐 뒤):

| 경우                       | 무시 없음                        | 1번                                             | 2번                             | 8번                                                                                     |
| -------------------------- | -------------------------------- | ----------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| 일반방 방장                | 방 시작 1.32초 → 1.32초          | 1.44초 → 1.32초                                 | 1.56초 → 1.32초                 | 1.46초 준비 실패, 1.51초 레거시 시작(Stage 2 5.51초) → 1.32초                           |
| 일반방 참가자              | ARMED 0.62초, 시작 1.32초 → 같음 | 0.74초, 1.44초(방 전체 늦어짐) → 0.62초, 1.32초 | 0.86초, 1.56초 → 0.62초, 1.32초 | 1.47초 준비 실패, 방 전체 3.0초에 시작하고 이 기기는 로컬 복구로 3.0초 → 0.62초, 1.32초 |
| PRO 참가자(가장 늦은 기기) | READY 0.62초 → 0.62초            | 0.74초 → 0.62초                                 | 0.86초 → 0.62초                 | 1.46초 실패 → 0.62초                                                                    |

대조 0과 0.005는 지금과 바뀐 뒤가 같다(0은 늘 음소거, 0.62초·1.32초. 0.005는 볼륨 1로 unMute, 무시하면 지금처럼 늦어짐). PRO 방 시작은
가장 늦은 READY의 0.7초 뒤라 무시 1번·2번이면 방 시작도 1.44초·1.56초로 늦어지고, 8번이면 다른 기기는 2.16초에 시작하고 그 기기만 늦게
따라 들어온다[추론]. 가짜 화면 모형만의 경우(unMute가 0.25초 늦게 반영되어 다시 명령할 때마다 지연을 다시 셈)는 지금 방장이 끝내 재생하지
못하거나 참가자가 빠지고, 바뀐 뒤에는 1.32초에 제때 시작한다.

- **실패 시험(만들 때 먼저):** `youtube-iframe-audio-order.test.ts` 두 규칙 행의 0.004 줄에서 여섯 칸(`hostZeroStart`, `guestZeroStart`,
  `proPrepare`, `replacementRecovery`, `hostLegacyRecovery`, `guestRecovery`)과 `iframe-audio-owner.test.ts`의 0.004 규칙 행을 뒤집는다.
  '바뀐 뒤' 측정에서 실패한 것은 이 두 시험뿐이었다(측정 묶음 104행 가운데 2). 0과 0.005 줄, 같은 줄의 볼륨 쓰기·관문 정착·직접 COMMIT
  칸, T0a PRO READY 시각 골든(마스터 볼륨 1), T0b 참값표, 6B 행은 그대로다. 계획 표는 이 실패 시험이 zero-start와 PRO 준비 두 경우만
  뒤집는다고 적었지만, 같은 실행 값을 가져가는 취소 복원과 두 복구가 함께 바뀌어(레거시 복구 칸은 첫 리뷰 반영 `19a81173`이 더함) 0.004 줄의
  여섯 칸이다. 옮긴 뒤 둘째 리뷰가 `6998f04e`의 임시 사본에서 `readYouTubeAppAudio`를 'rounded'로 고정해 `src/youtube`, `src/player`,
  `src/pro-room`을 돌렸을 때도 6,693행 가운데 이 두 행만 실패했고, 두 규칙 행의 차이는 위 여섯 칸뿐이었다(QA 라운드 6). 넘겨받은 준비의
  칸(`transferredPrepare`)은 위 탐침이 그 길을 재현하지 못해 더하지 않았다.
- **혼합 버전:** 게스트 ARMED의 `muted`만 0.004 같은 값에서 바뀌고 방장은 읽지 않는다. 프레임 모양과 시각은 같다.
- **되돌리기 메모:** 6C를 되돌리면 함께 되돌아간다. 이 증분만 되돌리면 두 규칙이 돌아오고 실패 시험의 0.004 줄이 오늘 값으로 돌아간다.
- **닿는 범위:** 볼륨 슬라이더로는 0.5 % 아래 값을 만들 수 없다(`index.html`의 볼륨 슬라이더에 `step`이 없어 1 % 단위이고, 음소거 버튼은
  0이나 바로 전 값을 보냄 `src/ui/player-controls.ts:388`, `:407`, `:410`)[추론]. 방 설정 맞추기(`src/audio/effects.ts:681`) 같은 다른 길로
  그런 값이 들어올 때만 닿고, 그런 값을 보내는 곳은 찾지 못했다.

## 열린 항목 'YouTube 첫 음 정렬(S01–S02, XS01–XS04)'

[release-record §2의 열린 항목](../release-record.md)(main `7b869c35`의 `docs/release-record.md:3782-3785`)은 일반·PRO, 방장·게스트, 양·음
오프셋, 다음 곡·반복·중간 참가·취소를 실제 YouTube, iPhone Safari/PWA, 블루투스에서 확인하라고 적는다. 6C의 무장 단계가 첫 음 시점을
다루므로(계획 §4.8) 이 보고서를 그 항목에서 잇는다. 이 브랜치는 release-record를 바꾸지 않으므로 링크는 릴리스 담당이 버전 올리기
PR(계획 6C-6)에서 더한다(계획 §4.2-7).

- **이 열차가 확인한 것(로컬, 자동):** 두 무장 기계의 hard-mute 대기, warm 수락, settle이 같은 각본에서 바탕과 같은 명령을 같은 순간에
  보낸다(무장 골든 68행이 main 런타임 `7b869c35`와 코드 끝에서 같음, 옮기기 전의 차등 시험 9,000회와 200,000회). 출시 순간과 출력 앞섬
  계산은 바뀌지 않았고 T0a 와이어 골든, PRO READY 시각 골든, 9.0.8 방장 스피커 행이 통과한다. 옮긴 `6998f04e`와 기록 끝 `f9f4a57c`에서
  로컬 Chromium YouTube spec 여덟(41 / 41), 로컬 WebKit YouTube 활성화 spec(4 / 4), critical E2E(101 / 101)가 통과했다(QA 라운드 6, 8,
  옮기기 전에는 QA 라운드 4).
- **확인하지 못한 것:** 실제 YouTube, iPhone Safari/PWA, 블루투스, 실기기의 귀로 듣는 첫 음. 그래서 항목은 열린 채 둔다(기기 근거 없이
  지우지 않음).

## Phase 7로 넘기는 계약 (계획 §8)

세 계약은 main의 Phase 7 T0(#559) 위에서 다시 확인했다: 옮긴 뒤 `src/audio/__tests__` 23 파일과
`media-session-lock-screen-pause.test.ts`, 아래 (a)의 계약 행, (b)의 O6·O7·O10 행, `setup-start.test.ts`가 함께 26 files 474 / 474로
통과하고(코드 끝 `a9951bfd`, QA 라운드 7), Phase 7 T0의 로컬 Chromium 오디오 랩(`playwright.audio-lab.config.ts`)이 17 / 17로 통과하며(옮긴
`6998f04e`, QA 라운드 5), 옮긴 뒤 `setup-youtube-activation`(WebKit), YouTube Chromium spec 여덟, critical E2E(그 안의 background-resume)도
통과했다(QA 라운드 6, 8). `vitest.critical.config.ts`는 두 열차의 포함과 문턱을 함께 갖는다(자동 병합, QA 라운드 5). 마지막 검사(QA 라운드
8)에서도 `src/audio/__tests__` 23 파일이 네 디렉터리 묶음 안에서 파일 순서와 seed 넷 모두 통과하고, 핵심 커버리지의 Phase 7 파일(`context.ts`,
`context-recovery.ts`)이 문턱을 지킨다.

- **(a) `youtube:set-volume`은 엔진 볼륨 이벤트마다 정확히 한 번, `Math.round(v * 100)`:** 그 이벤트를 내는 곳은 `engine.ts`의
  `audio:set-volume`과 `audio:apply-youtube-volume` 처리기 둘뿐이고(`src/audio/engine.ts:722`, `:744`, 이 열차에서 바뀌지 않음), 주인이
  hold를 거쳐 한 번 쓴다. `youtube-iframe-audio-order.test.ts`의 Phase 7 계약 행이 마스터 볼륨 0, 0.004, 0.005, 0.734, 1에서 처리기 둘과
  보낸 값, 쓰기의 전체 흔적을, 그리고 예열 중 시작 주인과 주차된 iframe에는 hold로만 닿음을 고정한다(진짜 `engine.ts` 처리기).
- **(b) PRO 관문의 pending·settled가 iframe hold에 닿는다:** O6, O7, O10 행. WebAudio 쪽 토큰(`engine.ts`)과 합칠지는 Phase 7이 정한다.
  앱 정지에서 iframe 쪽만 비우는 비대칭(`stopYouTubeMode`의 `clearYouTubePauseGate`, `src/youtube/player.ts:1583`)도 그대로 넘어간다.
  iframe 쪽 토큰을 쓰는 곳은 이제 가드가 지킨다(`PAUSE GATE WRITERS`: 셋터 셋은 `player.ts`의 관문 처리기 둘과 `stopYouTubeMode`만).
- **(c) 시작 탭은 `audio:activate`와 같은 동기 스택에서 `primeYouTubePlayer({ retryPending: true })`를 부른다:** `src/ui/setup-start.ts`는
  바뀌지 않았고(`:10-11`, 주석 `:13-14` 'Keep the play call in the actual tap stack') `setup-start.test.ts`가 통과한다. iOS prime의
  제스처 unMute도 그대로다.

## 머지 전에 할 일 (릴리스 담당)

1. **9.0.33 먼저, 그 위로 다시 옮기기:** 6B는 9.0.32로 나갔고 이 갈래는 그 main `7b869c35` 위로 옮겼다(QA 라운드 5). 이 열차 앞에 App
   9.0.33(한글을 다시 Pretendard로 그림)이 나가고, 그 열차는 마지막 검사(QA 라운드 8) 때 이미 main `4faf38d9`(#560, squash)였다. 그
   배포와 기록이 끝나면 이 갈래를 그 main 위로 다시 옮긴다(`git rebase --onto <그 main> 7b869c35`로 이 갈래 커밋 스물하나만 옮김). QA 라운드 8의
   `git merge-tree --write-tree origin/main HEAD`에서 충돌은 `docs/README.md`(두 열차가 증거 목록 맨 위에 항목을 더함) 하나였고, 9.0.33이
   바꾼 `tsconfig.test.json`과 `src/i18n`, `src/ui/user-text-font.ts`는 이 갈래가 건드리지 않는다. 9.0.33은 시작 화면의
   글꼴 불러오기를 바꾸고 그 화면에서 탭 스택의 prime이 돌므로, 옮긴 끝 SHA에서 다음을 다시 돌리고 이 보고서에 새 QA 라운드로 적는다:
   옮긴 테스트 먼저 커밋을 새 부모에서(같은 이름의 행만 실패하는지), WebKit `setup-youtube-activation`, YouTube Chromium spec 여덟, critical
   E2E, 단위 전체, `build:checked`, 새 부모 대비 eager 크기, 가드 수. 이 보고서의 SHA, 바탕, 버전 칸과 `docs/README.md` 항목도 그때 다시
   고친다. QA 라운드 5 ~ 8의 증거(라운드 8의 9.0.33 위 시험 트리 포함)로 PR을 열거나 머지하지 않는다.
2. **6C-3:** 오너가 위 '6C-3' 절의 표를 보고 답한 뒤에만. '예'면 실패 시험 먼저(두 규칙 행의 0.004에서 여섯 칸과 주인의 0.004 규칙 행을
   뒤집음), 그다음 `readYouTubeAppAudio`의 'non-positive' 변형을 지우는 런타임 커밋을 이 열차의 마지막 런타임 증분으로 둔다. 만들기 전에
   넘겨받은 준비의 의도가 실행에 닿는 길을 확인한다(위 '6C-3'). '아니요'면 두 규칙을 이름 붙은 그대로 둔다.
3. **버전 올리기와 문서(계획 6C-6):** 아래 '배포 조건과 순서' 2, 3.

## 배포 조건과 순서 (릴리스 담당)

1. 한 번에 한 열차, main 런타임이 배포본과 같을 때만: 9.0.33이 먼저 나가고 그 기록 뒤에 6C를 옮긴다. 이 배포까지 런타임 의존성 변경
   (Dependabot 포함)을 머지하지 않는다.
2. 버전 올리기 커밋(마지막 런타임 커밋, 계획 6C-6): 9.0.34 / v807을 6B의 버전 올리기(#557의 `582ab9d9`)와 9.0.30의 `8d148fff`처럼 거울 여섯
   파일 일곱 줄에 적는다(`package.json`, `package-lock.json` 두 곳, `ADMIN_SCRIPT_VERSION`, `ADMIN_ASSET_VERSION`,
   `SERVICE_WORKER_CACHE_VERSION`, `index.html`의 bootstrap 캐시 쿼리). 그 뒤 `guard:sw-cache-version` PASS, `guard:release-identity` 새 버전,
   `build:checked` 전체. 계약 동결: 바탕 main..머리의 `cloudflare/` 차이가 `cloudflare/app-worker.ts`의 버전 한 줄뿐인지 본다.
3. 문서(계획 6C-6, §4.2-7): release-record §2에 이 열차의 '배포 전' 항목(이 보고서 링크, 오너 답, 배포 조건, 되돌리기, 배포 뒤 확인)과
   열린 항목 'YouTube 첫 음 정렬(S01–S02, XS01–XS04)'의 이 보고서 링크와 확인한 것·못 한 것(위 절). 레지스트리 RO-02, RO-03, RO-12,
   RO-14와 설계 문서는 이미 이 브랜치에 있다. 6C-3을 실으면 그 '의도한 변경'과 실패 시험 커밋을 이 보고서의 자기 절에 더한다.
4. PR CI, 자동 코드 리뷰, dispatch 직전 머지, exact-main CI success 뒤 Release target `app`, Developer API D1 false,
   `raise_app_build_floor` false. 기록 PR을 열차 PR 머지와 deploy job 시작 사이에 머지하지 않는다.
5. 배포 직후(게이트 아님): 공개 최소 빌드 상태와 Operations Drift Audit, 아래 '배포 뒤 확인'. 머지 뒤 main SHA에서 Full E2E를 한 번 돌려
   보고서의 QA 라운드에 적되 exact-main 후보로 쓰지 않는다(계획 §4.2-5).
6. 배포 기록 PR: release-record §1과 `Last source review` 덮어쓰기, `docs/release-history.md` 한 행, §2의 이 항목을 '배포 뒤 확인'으로.

## 배포 뒤 확인 (블라인드, 게이트 아님)

계획 §4.8의 기기 후보(QA052, QA053, QA055, 절차는 영역 조사 pro-and-iframe-audio §4.1 ~ §4.4와 §4.6, 계획 §7)다. 라우터, 오디오 쓰기,
무장 단계가 모두 iOS·WebKit을 타는 가장 무거운 열차라 6A·6B보다 단계가 많다. 확인하는 사람에게는 '절차'만 주고 기준은 주지 않으며, 받은
관찰값을 여기 기준과 견준다. Phase 6 앞의 기준선(Q6)은 재지 않았다. 옛·새 빌드를 섞어 시작하는 기기 행은 두지 않는다(혼합 버전 근거는
T0a 프레임·시각 골든과 무장 골든, P5-D9 C). 기기가 없는 단계는 건너뛰고 '기기 없음'으로 적는다. PRO 단계는 돌리기 전에 그 방의 모든 PRO
탭을 새로 고친다(바닥 795 아래의 열린 탭이 시작마다 3 s를 더할 수 있음, 계획 §5).

**절차(확인하는 사람에게 주는 것, 약 2시간 15분):** 모든 기기가 같은 앱 버전이고(앱 정보의 버전 번호를 적음) 주소 끝에
`?mxqrLog=debug`를 붙여 연다. 새로 고치거나 다시 들어갈 때도 다시 붙인다(홈 화면 앱은 붙일 수 없어 그 단계의 줄이 없을 수 있음). 각
단계 뒤 채팅에 `/debug console`을 입력하고 `[YouTube`와 `[PRO`로 시작하는 줄을 시각과 함께 복사하며, PRO 단계는 `/debug sync`의
`youtube-release` 줄도 복사한다.

- **A. iOS 탭 없는 준비와 탭 대체(약 20분):** (1) 이 세션에서 처음 연 iPhone Safari로 일반방에 게스트로 들어간다. 방장이 로컬 파일을
  재생하다 YouTube로 바꾼다. 재생 버튼이나 'TAP TO PLAY'가 떴는지, 소리가 났는지, 걸린 대략의 시간을 적는다. (2) 같은 iPhone으로 PRO
  방에 들어가고 다른 기기가 YouTube 첫 트랙을 재생한다. 같이 적는다. (3) iPhone 홈 화면 앱으로 (2)를 반복한다. (4) iPhone에서 입장
  버튼을 누른 직후 1초 안에 PRO 방의 재생이 시작되게 한다. 'TAP TO PLAY'가 뜨면 누르고, 누른 뒤 소리가 날 때까지의 시간을 적는다.
- **B. 잠금 화면과 하드웨어 버튼(약 20분):** (1) iPhone(PRO 권한 없음)과 Android(PRO 권한 있음)를 같은 PRO 방에 넣고 YouTube를
  재생한다. (2) iPhone 잠금 화면에서 일시정지, 5초 뒤 재생. (3) Android의 이어폰 버튼이나 알림의 미디어 컨트롤로 일시정지, 5초 뒤 재생.
  (4) 다음 트랙을 누르고 소리가 나기 전 1초 안에 (3)을 한다. (5) 데스크톱 Chrome 일반방 방장에서 키보드 미디어 키로 일시정지와 재생.
  단계마다 모든 기기의 소리를 적는다.
- **C. 일반방 시작 직후의 헤드셋·잠금 화면(약 25분):** (1) 데스크톱 Chrome 방장, iPhone Safari 게스트(버튼 있는 이어폰). 방장이 YouTube
  곡을 시작하고 게스트 소리가 난 직후(약 2초 안) 게스트가 이어폰 버튼으로 일시정지하고 5초 뒤 재생한다. (2) (1)을 잠금 화면으로 한다.
  (3) 방장이 곡 중간에서 위치를 옮기고 2초 안에 게스트가 이어폰 버튼으로 일시정지, 5초 뒤 재생한다. (4) 방장이 수동 오프셋 −5.000 s로
  곡을 시작하고, 게스트 소리가 나기 전 대기 동안 게스트가 잠금 화면에서 일시정지한다. (5) iPhone을 방장으로 바꿔(데스크톱 Chrome
  게스트) (1)과 (3)을 방장 기기에서 한다. 게스트와 방장의 소리를 적는다.
- **D. 예열 중 일시정지와 볼륨 0 ↔ 50(약 35분):** (1) 데스크톱 Chrome 방장, iPhone Safari와 Android Chrome 게스트, 모든 볼륨 50, 재생목록에
  YouTube 두 곡. (2) 방장이 첫 곡을 누르고 소리가 나기 전(1초 안) iPhone 게스트가 앱의 일시정지를 누르고 3초 뒤 재생을 누른다. 일시정지
  동안 짧게 새는 소리가 있었는지, 재생 뒤 소리 크기(같음, 작음, 큼, 없음)를 적는다. (3) (2)를 Android 게스트로 한 번 한다. (4) 방장이
  다음 곡을 누르고 소리가 나기 전에 iPhone 게스트가 볼륨을 0으로 내렸다가 2초 뒤 50으로 올린다. 세 곡에 걸쳐 세 번 한다. (5) 방장을
  iPhone Safari로 바꿔 (2)와 (4)를 방장 기기에서 한 번씩 한다. (6) 데스크톱 Safari를 방장이나 게스트로 넣어 (2)를 한 번 한다.
- **E. 블루투스, PRO 여러 대, 느린 망(약 30분):** (1) Android에 블루투스 이어폰, iPhone에 AirPods를 연결하고 유선이나 내장 스피커 기기
  하나와 같은 PRO 방에 넣는다. YouTube 첫 트랙, 다음 트랙, 일시정지 뒤 재생, 30초 지점으로 옮기기를 차례로 하고, 단계마다 첫 음이
  잘렸는지, 기준 기기와의 어긋남(같음, 조금, 많이), 다음 트랙이 시작되기 전 어느 기기에서든 짧게 새는 소리가 있었는지 적는다. (2)
  일반방에서 Android 블루투스 게스트로 (1)을 반복한다. (3) 일반방 게스트를 데스크톱 Chrome으로 바꾸고 개발자 도구 네트워크를 'Slow 4G'로
  둔 뒤 방장이 다음 곡을 시작한다. 게스트 소리가 몇 초 늦게 붙었는지와 붙은 뒤 어긋남을 적는다.
- **F. PRO 방 iPhone의 빠른 일시정지·재생(약 5분, 선택):** PRO 방에서 YouTube 트랙이 재생되는 동안 iPhone이 앱의 일시정지를 누르고
  약 1초 안에 재생을 누른다. 세 번 하고, 재생 뒤 소리가 들렸는지 적는다.

**통과 기준(주지 않음):**

- A: (1) ~ (3)은 탭 없이 소리가 나고 `[YouTube Prime]` 경고가 없다. (4)는 탭 창이 뜨거나 바로 소리가 나며, 탭 뒤 소리가 서버 시계에 맞춰
  이어진다. 탭이 3 s 장벽 뒤면 COMMIT이 scheduled-control로 끝점에 가므로 `[PRO YouTube] Zero-start playback released`가 없어도 정상이고
  `youtube-release`의 path·timingMode로 판정한다. 어느 경우에도 소리 없는 채 탭 창이 안 뜨는 상태가 없다(iOS prime의 제스처 unMute와
  탭 스택은 6C가 건드리지 않음).
- B: (2)는 iPhone만 멈추고 재생 때 방 시계에 맞춰 다시 붙는다. (3)은 방 전체가 멈췄다 재생된다. (4)는 준비가 끝나도 소리가 새지 않고
  일시정지가 이긴다(관문의 바로 맨 `mute()`, 6C-2가 옮김). (5)는 방장 일시정지가 존중된다. 어느 단계에서도 warm 소리가 짧게 새지 않는다.
- C: 게스트의 진짜 일시정지가 존중된다(게스트만 멈추고, 재생을 누르면 방 시계에 맞춰 다시 붙음). 시작 직후 약 2.75초 보정 창 안이라는
  이유로 일시정지가 무시되거나 방 전체가 멈추지 않는다(6C-1이 대기 술어를 레거시 전용으로 둔 이유). (5)에서 방장의 일시정지는 방에
  그대로 전해진다. 예열 소리가 새지 않는다.
- D: 재생이나 볼륨 50으로 돌아가면 그 기기의 소리가 설정 볼륨으로 돌아온다. 일시정지 중과 볼륨 0 중에는 예열 소리가 새지 않는다(시작
  주인 hold는 unMute만 막음, 6C-2). 방장 콘솔에 `[YouTube ZeroStart] prepare-host`와 `Playback released`가 있고 어느 기기에도
  `[YouTube ZeroStart] audio-restore-timeout` 경고가 없다(iOS 방장 (5)에서도: 방장 hard-mute 대기와 활성 복원이 WebKit을 탐).
  `Falling back to legacy rendezvous`는 실패로 보지 않고 적는다.
- E: 첫 음이 잘리지 않고, 다음 트랙의 warm 소리가 어느 기기에서도 새지 않는다. 블루투스 어긋남 자체는 기준이 아니고(Android 250 ms 고정
  보정은 블루투스를 구분하지 않음) 다음 측정과의 변화만 본다. 느린 망 게스트는 settle을 여러 번 거치거나 `Falling back locally`와
  `Recovered locally`로 늦게 붙고, 방장은 정상으로 시작한다.
- F: 다시 재생 뒤 소리가 들린다. 소리 없이 재생되면 WebKit이 정착의 unMute 한 번을 무시한 것으로 보이며[추론], 그 쓰기는 6C 앞에서도
  같은 검증 없는 unMute 한 번이라 6C 회귀가 아니고 따로 적는다(독립 리뷰의 선택 후보).

**실패하면:** 일시적 네트워크로 설명되지 않으면 위 '되돌리기'대로 앞으로 고치기나, 급할 때만 명시적으로 검토한 CLI 되돌리기로 checkpoint
App을 정한다. 증상의 경로(라우터, iframe 오디오 쓰기, 무장 단계)를 적는다. '기기 없음'과 '미확인'은 실패가 아니다.

## 사용자가 알아챌 변화

없다. 버전 올리기와 함께 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 셋째, 창 모양은 지금 그대로). 처음 받는 코드는 gzip 기준 JS 33 B, 전체
32 B 늘고 raw로는 전체 1,276 B 준다(운영 9.0.32와 런타임이 같은 main `7b869c35` 대비, 버전 올리기 앞, 위 '번들 크기'). 6C-3은 만들지 않았으므로 0.5 % 아래
볼륨의 동작도 그대로다.

## 기록과 레지스트리

- 이 브랜치: 레지스트리 RO-02(라우터, 레거시 전용 대기 술어와 그 독자 여섯, 시작 hold의 새 독자), RO-03(공유 무장 단계와 각 기계의 정책,
  골든을 parity 표로), RO-12(쓰기 주인, hold 종류, 쓸 때 읽는 원하는 오디오, 이름 붙은 두 규칙과 그 'non-positive'가 시작 때 잡는 값뿐임, CHECK 11 수, 등록·주차
  자리·관문 쓰는 쪽 규칙), RO-14(주차 hold
  등록 문장)와 가드 항목 5·11·12, 설계 문서 `docs/design/youtube-start-ownership.md`(상태 라우터 절, 다리 행, 독자 칸), 핵심 커버리지 등재
  (`iframe-audio-owner.test.ts`, `arm-steps.ts`, `authority-arm.ts`), 이 보고서와 `docs/README.md` 증거 목록. 이 보고서 말고는 모두 센
  코드나 규칙을 옮긴 커밋과 같은 커밋이다.
- 레지스트리 상태는 RO-02, RO-03, RO-12 모두 `duplicated` 그대로다(복구가 아직 주인 단계가 아님, 오디오 복원과 출시는 기계마다, 시작
  기계는 원하는 오디오를 받아서 씀. 6D). 레지스트리 머리의 `Last source review`는 기록을 코드와 다시 맞추는 PR이 고친다.
- 릴리스 담당이 버전 올리기와 함께: release-record §2의 6C 항목과 열린 항목 연결, 그리고 배포 뒤 기록 PR(위 '배포 조건과 순서' 3, 6).

## 오너에게

1. **[화면 바뀜: '예'면 마스터 볼륨이 0과 0.5 % 사이일 때만, 아이폰의 YouTube 소리와 시작하는 때, 그리고 방장 기기의 YouTube 화면이
   음소거를 받아 주지 않는 드문 경우 방이 시작되는지가 달라져요] 6C-3: 0.5 % 아래를 YouTube 음소거 규칙 하나로 만들까요?** 2026-10-30에
   '예'라고 하시며 만들기 전에 전후 시각 표를 먼저 보여 달라고 하셨어요. 표는 위 '6C-3' 절에 있고, 쉬운 말로 쓴 같은 표를 따로 드려요.
   사진에 담기지 않고 소리와 때만 바뀌어 사진 대신 표를 먼저 드려요. 볼륨 슬라이더로는 0.5 % 아래 값을 만들 수 없어 보통 사용에서는
   닿지 않아요.
   - (가, 권장) 예: 표대로 3차 업데이트(6C)의 마지막 단계로 만들어요(실패하는 시험 먼저). 아이폰에서 들리던 YouTube 소리가 마스터 볼륨대로
     무음이 되고, 레거시 복구의 드문 경우는 지금 0 %일 때와 같아져요. 업데이트 창은 늘지 않아요.
   - (나) 아니요: 두 규칙을 지금처럼 이름 붙은 그대로 두고 만들지 않아요. 동작은 그대로예요.
   - 답을 기다리는 동안 6C의 나머지(화면·소리가 그대로인 정리 넷)는 준비된 그대로 두고, 이 단계만 기다려요.
2. **[화면 그대로] 시험이 새로 찾은 작은 결함 하나: 이번에는 고치지 않기를 권해요.** 일반방 YouTube 시작의 위치 맞추기 중 여섯째 확인마다
   80 ms 뒤에 다시 하는 위치 맞추기에서 YouTube 화면이 오류를 던지면, 그 오류가 앱의 전역 오류 로그에 약 0.5초마다 한 줄씩 남아요(시작
   준비가 10초 예산을 다 쓸 때까지). 확인은 그대로 이어지고 10초 뒤 준비가 끝나는 것도 지금과 같아요. 화면과 소리는 같고 로그만 달라요.
   첫 위치 맞추기의 오류는 조용히 넘기므로 둘이 달라요. 실제 YouTube 화면이 위치 맞추기에서 오류를 던지는 것은 화면이 망가졌을 때뿐이라고
   봐요[추론]. 오늘 동작으로 시험에 고정해 두었어요(무장 골든 'seeks that throw while settling').
   - (가, 권장) 이번 열차에서는 고치지 않아요. 고친다면 뒤 정리 열차(Phase 7)에서 첫 위치 맞추기처럼 조용히 넘기면 되고, 로그 줄이
     사라지는 것 말고는 바뀌는 것이 없어요.
   - (나) 6C의 마지막 단계로 고쳐요(업데이트 창은 늘지 않음, 시험 먼저).
3. **[화면 그대로] 첫 로딩 크기: 정하실 것은 없어요.** 6C는 앱을 처음 열 때 받는 양을 압축 기준 33바이트 늘려요(지금 운영 중인 9.0.32
   대비). Phase 6 전체로는 6A·6B와 합쳐 169바이트 줄었고, 상한(늘어남 200바이트)과 멀어요.
4. **[화면 그대로] 6C를 언제 낼지: 권장은 '한글 글꼴 업데이트(9.0.33)가 나가 기록된 뒤, 6C-3 답을 받아 반영하고, 그 위에서 자동 관문을
   모두 다시 통과하면 9.0.34로 낸다'예요.** 6B는 9.0.32로 이미 나갔어요. 화면과 소리는 그대로이고(6C-3을 '예'로 하시면 위 표의 경우만
   달라짐) 업데이트 창만 한 번 떠요(Phase 6 넷 가운데 셋째). 릴리스 담당이 정해요. 6C에 문제가 있어 되돌리면 그때 운영 중인 앱(9.0.33)으로
   돌아가요.

## QA 라운드

모두 Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, `--maxWorkers=4`, Playwright 1.63.0(Chromium 1243, WebKit 2359), trace
끔(따로 적은 것 말고). 포트는 라운드 1 ~ 4가 4791 / 9791, 라운드 5 ~ 8이 5391 / 5392다. 라운드 1 ~ 4는 옮기기 전 SHA에서 돌렸다.

### 1. 구현 중 증분별 검사 (2026-11-01 22:47 ~ 2026-11-02 05:26 KST)

증분마다 그 코드 커밋에서 돌렸다. 테스트 먼저 커밋의 Playwright와 증명 묶음 일부는 임시 detached worktree(`node_modules`를 이 갈래의
worktree에 연결, 끝에 연결을 먼저 풀고 worktree를 지움)에서 돌렸다. 증분 묶음은 `src/youtube`, `src/player`, `src/pro-room`, `network`의
`protocol.test.ts`·`sync.test.ts`, `ui`의 `player-controls`·`seekbar`·`setup-start`, 가드 자체 시험이다.

- **6C-1 `efcc24f2`:** 증분 묶음 246 files 7,071 / 7,071, 단위 전체 740 files 17,724 통과·1 건너뜀, typecheck·lint·format 통과, 핵심 커버리지
  99 files / 4,051, 로컬 Chromium YouTube spec 여덟(계획 §4.2-3) 41 / 41(코드 커밋과 테스트 먼저 커밋 모두), 로컬 WebKit
  `setup-youtube-activation` 4 / 4.
- **6C-2 `8ef3794a`:** 증분 묶음 248 files 7,125 / 7,125, 단위 전체 742 files 17,778 통과·1 건너뜀, typecheck·lint·format 통과, 핵심 커버리지
  100 files / 4,087(`iframe-audio.ts` 문장 64 / 64, 분기 48 / 48, 함수 17 / 17, 줄 51 / 51), Chromium 41 / 41(두 커밋), WebKit 4 / 4.
- **6C-4 `376552c7`:** 증분 묶음 250 files 7,167 / 7,167, 단위 전체 744 files 17,820 통과·1 건너뜀, typecheck·lint·format 통과, 핵심 커버리지
  103 files / 4,211(같은 두 실행: `arm-steps.ts` 100 %, `authority-arm.ts` 87.71 / 81.92 / 98.52 / 92.3, `zero-start.ts` 86.74 / 84.51 /
  98.43 / 90.42), Chromium 41 / 41(두 커밋), WebKit 4 / 4.
- **6C-5 `d20acc97`(단위 검사는 주석만 다른 앞 판에서, 운영 빌드 바이트 같음):** 증분 묶음 250 files 7,223 / 7,223, 단위 전체 744 files
  17,876 통과·1 건너뜀, typecheck·lint·format 통과, 핵심 커버리지 103 files / 4,267, Chromium 41 / 41(두 커밋), WebKit 4 / 4(15.7 s).
- 위 '증분' 절의 변이 확인도 이 라운드다(운영 파일을 잠깐 바꿔 돌리고 바이트 그대로 되돌림, 끝에 작업 트리 깨끗).

### 2. 독립 리뷰와 반영 (2026-11-02 05:26 ~ 06:47 KST)

세 갈래(중립, 주인·가드, 기기 오디오 추론)가 `d20acc97`을 브랜치를 바꾸지 않는 임시 사본에서 봤다(사본과 연결은 지움).

- **중립:** 바탕의 시험 파일(표본기 도우미는 이 갈래의 것)을 머리 런타임에서 돌린 단위 전체 17,867행 가운데 실패는 Q12 load 행 셋과
  `player.test.ts`의 다리 행 하나였다. 새 중립 고정은 바탕 런타임에서 121 / 121(그때 음향 순서 18행). 실제 `initYouTube` 배선으로 무작위
  App 쓰기 순서 1,200개(seed 셋: 볼륨 0 ~ 150과 NaN·Infinity, 관문 pending·settled와 다른 토큰·종류, 주차와 시작 hold 바꿈, 마스터 볼륨 0,
  0.004, 0.005, 0.3, 1, −0.1, NaN, null, `setVolume` 없는 iframe과 iframe 없음)를 바탕과 머리에 돌려 iframe 명령, 시작 기계로 미는 값,
  hold 물음이 바이트로 같았다. 무장 기계 차등 시험은 위 '중립 메모'.
- **주인·가드:** 가드가 바탕과 여덟 커밋 모두에서 OK, CHECK 11 32 → 26 → 20이 파일마다 기준치와 같고, CHECK 5와 12는 그대로, 기준치는
  `8ef3794a`와 `376552c7`에서만 움직였다. 새 시험 전용·자기 전용 binding 없음, 관리 타이머 키와 키마다 호출 수 같음, 로그 줄과 실패 이유
  같음(`player-replaced` 호출 자리만 다섯에서 셋으로 합쳐짐).
- **기기 오디오 추론:** 50,000 각본(zero-start 방장·게스트, PRO arm, 200,000회, 흔적 약 1,100만 줄)에 mute·isMuted·seek·pause·play·위치·영상
  자료·상태 오류, 늦거나 오지 않는 mute와 seek, iframe 바뀜·없어짐, 영상 바뀜, 스스로 재생, 비동기 상태 알림, WebKit식 unMute 무시·지연·오류,
  원하는 오디오 밀기, COMMIT·ABORT·ARMED·피어 사건, 취소, 둘째 PREPARE, 던지는 로컬 목표를 섞어 0 차이였고, 심은 변이(zero-start 다시 seek를
  바로)는 seed 6에서 잡혔다. Phase 7 계약 셋이 지켜지고, prime 제스처 unMute와 탭 경로, 잠금 화면·native-control 독자, 출시 순간과 출력 앞섬
  계산, 주차 iframe의 검증 hard mute 순서, WebKit 복원 루프는 그대로다.
- **찾은 것:** 높음 0, 중간 하나(RO-12의 두 규칙 자리 목록과 6C-3 표가 방장 레거시 복구를 빠뜨림), 낮음과 정보 열하나. 반영은 위 '리뷰
  반영'이고 반영하지 않은 것은 그 절 끝에 적었다.
- **반영 뒤 검사(`6915ee9e`):** 단위 전체 744 files 17,882 통과·1 건너뜀, 핵심 커버리지 103 files / 4,268, 로컬 Playwright
  `e2e/youtube.test.ts` 9 / 9, lint, format, 앱·시험·node-scripts·tooling tsc 통과, 가드 수 그대로, guard 묶음(import-graph, dead-exports,
  source-complexity, room-authority, standard-room hot path, lifecycle-writes, bus-pairing) 통과. `youtube-iframe-audio-order.test.ts` 19 / 19는
  바탕 런타임 `89e0b682`에서도 통과했다(임시 worktree, 끝에 지움).

### 3. 증분별 테스트 먼저 다시 돌림, 바탕 견줌, 크기, 6C-3 측정 (넘겨받기 전 검사, 옮기기 전 SHA, 2026-11-02 07:28 ~ 07:53 KST)

바탕 `89e0b682`에서 만든 임시 detached worktree(이 갈래 worktree의 `node_modules`를 연결, 같은 툴체인)에서 커밋마다 바꿔 돌렸다. 바꿀
때마다 작업 트리가 깨끗했고, 끝에 연결을 먼저 풀고 worktree를 지웠다.

- **테스트 먼저 짝 여섯과 시험만 하나:** 위 '증분 한눈에'(각 짝의 묶음은 구현 때의 증명 묶음 그대로: 6C-1 20 files, 6C-2와 시작 hold
  27 files, 6C-4 30 files, 6C-5 31 files, 가드 1 file, 시험만 3 files).
- **바탕 시험 파일을 브랜치 끝 런타임에서:** 이 갈래가 고친 앞 단계 시험 파일 일곱과 표본기를 바탕 것으로 바꿔(참값표 둘과 함께, 9 files
  517행) 돌리면 436 통과, 81 실패다. 실패는 모두 위 'T0b·T0a·6B 파일'에 적은 이음새다: 표본기의 지운 다리 훅 76(참값표), `player.test.ts`
  다리 행 1, `authority-arm.test.ts`의 Q12 행 3, 가드 자체 시험의 바늘 1. 다른 행(대역 키 셋과 `local-offset.test.ts`)은 통과한다.
- **새 중립 고정을 바탕 런타임에서:** 122 / 122(라우터 9, 음향 순서 19, 무장 골든 63, `local-offset.test.ts` 31).
- **바탕의 가드:** 위 '정확한 개수 가드'의 바탕 열.
- **크기:** 위 '번들 크기'(커밋마다 `npm run build`).
- **6C-3 측정:** 위 '6C-3'(측정 묶음 104행: 낮은 볼륨 Standard 30, PRO 15, 레거시 복구 3, 음향 순서 19, 주인 37. 지금 104 / 104, 바뀐 뒤 2
  실패). 측정용 시험 파일과 설정은 임시 worktree에만 두었다가 지웠다.

### 4. 넘겨받기 전 마지막 검사 (옮기기 전 `6915ee9e`, 그 뒤는 기록 커밋 `bdb5759a`뿐, 2026-11-02 07:12 ~ 08:24 KST)

이 갈래의 worktree에서. 원격 main은 이 검사 동안 `dda3ee18`이고 6B는 main에 없다. 같은 PC에서 다른 작업은 돌지 않았고, 이 검사의 실행
몇 개(shuffle seed와 임시 worktree의 빌드·시험)가 겹쳐 돌았다. Playwright는 혼자 돌렸다. 앞뒤로 작업 트리는 깨끗했다.

- **단위 전체(파일 순서):** 744 files, 17,883행 가운데 17,882 통과, 1 건너뜀(`release-deployment-state.test.ts`의 jq가 필요한 한 행, jq가
  없는 PC에서 CI 밖이면 건너뜀), 실패 0(557 s, 07:12 ~ 07:21 KST). 다시 돌린 것 없음.
- **shuffle(`src/youtube`, `src/player`, `src/pro-room`, seed마다 한 번):** 244 files, 6,690행. seed 7, 31, 4242, 20261030 모두 6,690 / 6,690.
- **바꾼 시험 파일 seed 1 ~ 16:** 14 files(새 다섯, 고친 여섯과 가드 자체 시험, 고친 표본기를 쓰는 참값표 둘), 696행. seed 열여섯 모두
  696 / 696.
- **`npm run typecheck`**(118 s), **`npm run lint`**(162 s), **`npm run format:check`**(60 s): 모두 종료 코드 0.
- **`build:checked`의 25 단계를 하나씩:** `guard:sw-cache-version` 하나만 실패했다(위 'Version'의 글 그대로, App 16 파일). 나머지 24 단계는
  통과했다: authored JS 둘(0 remaining, 107 retired; 0 inline), TypeScript project coverage 1,570 files / 19 projects, classic runtime 15,
  auxiliary browser 2, service worker(v803), UI kit 10, release identity 'MUSIXQUARE 9.0.30; service-worker cache epoch v803', brand
  capitalization 1,036, declaration ownership 10, source complexity, room authority(79 / 22 / 13 / 0 / 0, 411 files), profanity, hreflang 43,
  sitemap 93, `npm run build`, legacy TV(Chromium 79, `main-BDpc0SkS.js`), service worker build(v803, 바이트 동일), UI kit build, initial
  transfer budget(entry 839.6 KiB raw / 247.8 KiB gzip, eager JS 454.5 KiB gzip, eager total 1,999.4 KiB raw / 530.9 KiB gzip), prod hooks,
  prod security, 글꼴(44 stacks), SW 앱 셸 96 assets.
- **그 밖 `guard:*` 13개도 모두 통과**(`package.json`의 `guard:*` 37개 가운데 실패는 위 하나): bus-pairing 202 / 202, chunk-pump(411 files),
  transport-health(12 files), import-graph(411 files, 2,107 edges, 순환 0), lifecycle-writes, navigation-sinks, dead-exports(411 / 2,173 / 0 /
  20 / 76), font assets, standard-room hot path, Developer API boundaries, D1 migrations(19), ops drift contract, Playwright API.
- **`node scripts/check-resource-ownership.mts`와 `--report`:** 49 records, 458 production files, CHECK 11 20, CHECK 12 읽기 11·지우기 9, 파사드
  쓰기 2, 스냅샷 읽기 8, 장부 합성 1, CHECK 5 1 / 1 / 45, `--report` 107줄(위 '정확한 개수 가드').
- **크기(바탕 `89e0b682` 대비):** `build:checked` 빌드를 `measureInitialTransfer`로 읽어 임시 worktree의 브랜치 끝 빌드와 바이트까지 같았다:
  `main-BDpc0SkS.js` 859,737 / 253,698, eager JS gzip 465,439, eager total 2,047,344 / 543,629. 바탕 대비 eager JS gzip +34 B, eager total
  gzip +32 B, 진입 raw −1,319 B, 진입 gzip +20 B(위 '번들 크기').
- **`npm run test:coverage:critical`**(`--maxWorkers=4`): 103 files / 4,268 통과, 전체 84.39 / 79.63 / 90.28 / 88.08(문턱 73 / 66 / 80 / 78), 파일별
  문턱 오류 없음(106 s). lcov로 `arm-steps.ts` 함수 9 / 9, 줄 52 / 52, 분기 32 / 32, `iframe-audio.ts` 17 / 17, 49 / 49, 48 / 48, 장부 20 / 20,
  18 / 18, 3 / 3(셋 다 문턱 99), `authority-arm.ts` 89.63 / 82.6 / 98.61 / 93.89(문턱 86 / 80 / 97 / 91), `zero-start.ts` 88.37 / 85.31 /
  98.46 / 92.06(문턱 84 / 83 / 96 / 88).
- **`npm run build:e2e` 뒤 로컬 Playwright(포트 4791 / 9791, trace 끔):** `test:e2e:critical`의 여덟 파일 101 / 101(5.9분, 08:04 ~ 08:10
  KST), YouTube spec 열 개(`e2e/youtube*.test.ts`, Chromium) 53 / 53(12.5분). 그 가운데 계획 §4.2-3의 여덟(`youtube-sync` 6,
  `youtube-manual-zero-start` 10, `youtube-output-delay` 3, `youtube-end-transition` 6, `youtube-native-operator` 2, `youtube-manual-repeat` 1,
  `youtube-pending-seek` 4, `youtube` 9, 마지막 파일의 모드 전환, 재생목록 200 → 201, 로컬 트랙으로 YouTube 소유를 떠남, 돌아오는 로컬
  후속 예열 행 포함)은 41 / 41로 6A·6B의 41과 같고, 나머지 둘(`youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8)은 12 / 12다.
  로컬 WebKit(`playwright.webkit.config.ts`, iPhone 13) `setup-youtube-activation.test.ts` 4 / 4(16 s, 계획 §4.2-4). 실패, 다시 시도, 불안정
  표시는 없다(설정 `retries: 0`).
- **배포 대상과 계약 동결:** 위 'Deploy target'.

### 5. main `7b869c35` 위로 옮김과 다시 돌림 (`6998f04e`, 2026-11-02 10:57 ~ 11:40 KST)

6B가 9.0.32로 나가고 main이 `7b869c35`(#556, #557, #558, Phase 7 T0 #559)가 된 뒤, 넘겨받은 브랜치(`bdb5759a`)로 이 갈래의 worktree를
새로 만들어 Node 24.22.2 / npm 12.0.2로 `npm ci`를 하고(`89e0b682`와 main의 패키지 파일 차이는 버전과 스크립트 한 줄), `89e0b682` 위의 커밋
열다섯만 `7b869c35` 위로 옮겼다(`git rebase --onto`). push, 버전 올리기, SW 캐시와 release-record 변경은 없다.

| 옮기기 전  | 옮긴 뒤    | 커밋                           |
| ---------- | ---------- | ------------------------------ |
| `fd0f30ff` | `972338df` | 6C-1 테스트 먼저               |
| `efcc24f2` | `6edfda84` | 6C-1                           |
| `3f76693f` | `6078a8f8` | 6C-2 테스트 먼저               |
| `8ef3794a` | `59015d00` | 6C-2                           |
| `19b2bf5a` | `67ce787b` | 6C-4 테스트 먼저               |
| `376552c7` | `e35bbbfa` | 6C-4                           |
| `74dfa6d8` | `821d55ee` | 6C-5 테스트 먼저               |
| `d20acc97` | `3f9bf647` | 6C-5                           |
| `0bec09e6` | `19a81173` | 첫 리뷰, 시험만                |
| `7b8d032e` | `3738ea92` | 첫 리뷰, 시작 hold 테스트 먼저 |
| `1984c751` | `338b3622` | 첫 리뷰, 시작 hold             |
| `a225e294` | `afee2a6c` | 첫 리뷰, CHECK 12 테스트 먼저  |
| `87712e70` | `be93e908` | 첫 리뷰, CHECK 12              |
| `6915ee9e` | `f9bb3c4b` | 첫 리뷰, 기록 고침             |
| `bdb5759a` | `6998f04e` | 이 보고서의 기록 커밋          |

- **충돌 하나:** 6C-1 코드 커밋(`efcc24f2` → `6edfda84`)에서 `docs/design/youtube-start-ownership.md`의 'Not covered yet' 첫 두 항목. main의
  6B 기록이 뒤 항목(참값표가 오늘 동작으로 고정한 틈)의 머리를 "rows marked 'Looks like a defect'"와 2026-11-01에 오너에게 여쭌 넷으로
  고쳐 쓰고 그 목록과 'Fake ordering' 문단을 바꿨고, 6C-1은 앞 항목(C2-11/C2-13, 고정 순서 분배가 상태 라우터로, 대기 술어는 설계상
  레거시 전용)을 고쳐 썼다. 둘 다 남겼다: 6C-1의 앞 항목, 그다음 main의 뒤 항목과 목록, 문단 그대로. 줄 끝은 그대로이고 `format:check`가
  통과한다. 나머지 열넷은 깨끗하게 옮겨졌다.
- **자동 병합(눈과 더하고 지운 줄 집합으로 확인):** `docs/README.md`(6C 항목이 main의 6B 항목 위), `vitest.critical.config.ts`(main의 Phase
  7 T0 오디오 포함과 `src/audio/context.ts` 커버리지 항목, 올린 context-recovery 문턱이 6C의 `iframe-audio-owner`, `arm-steps`,
  `arm-steps-golden`, `authority-arm` 포함과 `arm-steps.ts`, `authority-arm.ts` 문턱 옆에).
- **충실도:** `git diff 89e0b682 bdb5759a -- src scripts`와 `git diff 7b869c35 6998f04e -- src scripts`가 바이트로 같고, 문서와 설정 파일마다
  더하고 지운 줄이 옮기기 전과 같다. 모든 커밋의 작성자와 커미터는 hiefny이고 메시지 끝의 공동 작성자 줄이 그대로다. 계약 동결 경로의
  `git diff --stat 7b869c35..6998f04e`가 비어 있고, 운영 변경은 같은 `src/youtube` 아홉 파일이다.
- **테스트 먼저 짝:** 위 '증분 한눈에'의 '옮긴 뒤' 열. 실패 이유는 각 커밋 메시지가 적은 것과 같다.
- **89 파일 묶음**(T0a #539, #541, #542, T0b #552, #553(두 참값표의 U·P 행과 비동기 변형), 6B의 `start-ownership`,
  `start-ownership-reader-windows`, `zero-start-fallback-ownership`, `native-control-owner-ports`, `resource-ownership-guard`, 6C의 라우터,
  음향 순서, 주인, 무장 단계, 무장 골든, `local-offset`와 고친 `host-local-rendezvous`, `zero-start-heartbeat-ownership`, `authority-arm`,
  `player`, Phase 7 T0의 `src/audio/__tests__` 23 파일과 `media-session-lock-screen-pause`, 그 밖 `iframe-audio`, `zero-start`,
  `media-session`): 파일 순서 3,470 / 3,470, seed 7, 31, 4242, 20261030 각각 3,470 / 3,470.
- **`src/youtube`, `src/player`, `src/pro-room`:** 파일 순서 245 files 6,693 / 6,693(옮기기 전 6,690과 main의
  `media-session-lock-screen-pause` 3행), 같은 seed 넷 각각 6,693 / 6,693.
- **가드:** resource-ownership OK(49 records, 458 production files, CHECK 11 20, CHECK 12 11 / 9 / 2 / 8 / 1, CHECK 5 1 / 1 / 45, `--report`
  107줄), dead-exports(411 / 2,173 / 0 / 20 / 76), import-graph(411 files, 2,107 edges, 순환 0), bus-pairing 202 / 202. `npm run typecheck`(97 s),
  `npm run lint`(134 s), `format:check` 통과.
- **핵심 커버리지(병합된 설정):** 110 files / 4,496 통과, 문턱 오류 없음. `authority-arm.ts` 89.63 / 82.6 / 98.61 / 93.89, `zero-start.ts`
  88.37 / 85.31 / 98.46 / 92.06, Phase 7의 `context.ts` 89.53 / 84.36 / 95.52 / 91.68, `context-recovery.ts` 90.99 / 88.66 / 88.57 / 93.37.
- **Phase 7 T0 오디오 랩(`playwright.audio-lab.config.ts`, Chromium, 자기 `build:e2e`, 포트 5391 / 5392, trace 끔):** 17 / 17(3.3분).
- **`guard:sw-cache-version`:** 종료 코드 1, 버전 올리기 전 예상 실패 하나('newer than v805 (3ea689b9)', `src/youtube` 아홉 파일).
- **돌리지 않은 것:** YouTube Chromium spec, WebKit `setup-youtube-activation`, critical E2E, 단위 전체, `build:checked`, 크기(라운드 6, 7이 돌림).

### 6. 옮긴 뒤 둘째 독립 리뷰 (`6998f04e`, 2026-11-02 11:44 ~ 12:43 KST)

세 갈래(중립, 주인·가드, 기기 오디오 추론)가 브랜치를 바꾸지 않고 임시 사본(끝에 지움)에서 봤다. 반영은 위 '옮긴 뒤 둘째 리뷰 반영'이다.

- **중립:** 운영 변경을 main과 줄마다 견줘(라우터 순서와 단락, 그 앞의 오래된 확인, 합친 대기 읽기, `applyYouTubeAudio`의 쓰기 0, 1, 2,
  관문 토큰, 두 mute 규칙의 자리, PRO 준비 읽기, hard-mute 대기 둘, warm 쌍과 수락, settle 둘의 울타리·목표·읽는 순서·기한) 위 '중립 메모'의
  셋 말고는 같았다. main의 시험 파일 여섯을 이 갈래에서 돌리면 338 / 342(Q12 load 행 셋과 다리 행 하나만 실패), 이 갈래의 중립 고정 넷을 main
  런타임 `7b869c35`에서 122 / 122, 89 파일 묶음 3,470 / 3,470. 단위 전체 750 files는 17,973행 가운데 17,972 통과, 실패 하나는
  `release-deployment-state` git fixture 시간 초과로 혼자 다시 돌리면 105 / 105다. 변이 50개(31 파일): hold 종류(A02 ~ A10), 주차된
  iframe의 unMute(A01, `stale-async-guards`도 잡음), 라우터 순서·단락·오래된 확인 위치(R01 ~ R04), settle 다시 seek를 빼거나 박자를 바꿈(S01 ~
  S03, S12, S13)은 잡혔고, 두 규칙 바꿈(A13, A17 ~ A19)은 두 규칙 행만 잡는다. 남은 것은 S18(main과 같아 보이지 않음)과 S19(중립 메모 (b),
  닿지 않음)다. settle 정책 셋(S04, S06, S08)은 `arm-steps.test.ts`만 잡아 `4d4e5be2`로 골든에 더했다.
- **주인·가드:** CHECK 11 20을 따로 grep해도 20(`arm-steps` 2, `iframe-audio` 7, `iframe` 3, `player` 4, `retained-player-controller` 2,
  `zero-start` 2), CHECK 12 `--report` 자리가 기준치와 같고 운영 타이머 키는 더하거나 빼지 않았다. 등록 규칙의 임시 변이 넷(player.ts의 둘째
  등록, 등록 지움, iframe.ts의 등록, 최상위 if 안의 둘째 등록)은 기대대로 실패한다. dead-exports `--analyze-json`의 완전히 죽은 것, 시험
  전용(20), 자기 전용(76), 허용 키 집합이 main과 같다(살아 있는 항목만 바뀜: 새 운영 export 열셋, 지운 다리 훅 하나). hard-mute·warm·settle
  값은 `arm-steps.ts`만 읽고 zero-start는 늦은 대체를 위해 `PAUSE_SEEK_GAP`만 남겼다. 라우터의 대응 타입은 claim 종류가 빠지면 컴파일되지
  않는다. 주인의 주차 자리를 되돌리는 함수(`iframe.ts`에서 부름)는 가드를 통과했다(낮음, `cf8a5a99`로 고침). 그 밖 가드
  source-complexity, room-authority-boundaries, standard-room-hot-path, lifecycle-writes, navigation-sinks, transport-health, release-identity
  (9.0.32 / v805), declaration-ownership, typescript-project-coverage, chunk-pump가 통과한다.
- **크기:** `npm run build`로 main `7b869c35`와 `6998f04e`를 견줘 eager JS gzip 465,403 → 465,436, eager total gzip 543,650 → 543,682, 진입 raw
  861,056 → 859,737, `guard:initial-transfer-budget` 통과(위 '번들 크기').
- **기기 오디오 추론과 기기 대역 검사:** `6998f04e`의 `git archive` 사본에 자기 `npm ci`(Node 24.22.2)와 `npm run build:e2e`, 포트 5391 /
  5392, trace 끔: WebKit(iPhone 13) `setup-youtube-activation` 4 / 4(40.7 s), YouTube Chromium spec 여덟(`youtube-sync`,
  `youtube-manual-zero-start`, `youtube-output-delay`, `youtube-end-transition`, `youtube-native-operator`, `youtube-manual-repeat`,
  `youtube-pending-seek`, `youtube`) 41 / 41(13.4분, 6A·6B의 41과 같음), `test:e2e:critical` 여덟 파일 101 / 101(6.4분, background-resume
  포함), 단위 12 파일(`setup-start`, `player-controls`, media-session 다섯, `master-volume`, 음향 순서, 주인, `iframe-audio`,
  `youtube-audio-restore-cadence`) 466 / 466(`--maxWorkers=2`). 사본은 지웠다. 6C-3 측정: 사본에서 `readYouTubeAppAudio`를 'rounded'로 고정해
  `src/youtube`, `src/player`, `src/pro-room` 6,691 / 6,693, 실패 둘은 주인의 0.004 행과 두 규칙 0.004 행이고 차이는 여섯 칸뿐.
- **찾은 것:** 중립 결함 0, 높음 0. 중간 둘: 이 기록이 옮기기 전 브랜치를 적음(이 기록 커밋), 옮긴 뒤 기기 대역 검사를 돌리지 않았음(위에서
  돌렸고, 9.0.33 뒤 다시). 낮음: 골든에 없는 settle 정책 셋, Q12 행의 빈 확인, 표본기 주석, 주인의 주차 자리 쓰기, PRO 관문 쓰는 쪽, 6C-3
  표의 넘겨받은 준비 의도, Phase 7 넘김 기록, 두 규칙의 잡는 때. 모두 위 '옮긴 뒤 둘째 리뷰 반영'에 반영했다(넘겨받은 준비 칸 선택 제안만
  싣지 않음).

### 7. 둘째 리뷰 반영 검사 (코드 끝 `a9951bfd`, 그 뒤는 기록 커밋 `f9f4a57c`뿐, 2026-11-02 12:43 ~ 13:26 KST)

이 갈래의 worktree에서, 포트 없이(E2E 안 돌림). 운영 파일을 main 것으로 잠깐 바꿔 돌린 것은 끝에 `git checkout`으로 되돌렸고, 앞뒤로 작업
트리는 깨끗했다.

- **`4d4e5be2`:** 골든 68 / 68과 `authority-arm.test.ts` 80 / 80, 같은 두 파일을 main 런타임 `7b869c35`(운영 `src/youtube` 여덟 파일만 바꿈)에서
  148 / 148. `arm-steps.ts` 변이 S04, S06, S08은 골든 68행 가운데 새 행만 각각 2, 2, 1 실패시킨다(변이마다 되돌림).
- **`cf8fbfab` → `cf8a5a99`:** 가드 자체 시험 99 / 103(새 행 넷 실패) → 103 / 103. `node scripts/check-resource-ownership.mts` OK(49 records,
  458 production files, 수 그대로, `--report` 107줄). 리뷰의 임시 변이(주인에 자리를 되돌리는 함수, `iframe.ts`에서 부름)를 실제 파일에 넣으면
  종료 코드 1과 `AUDIO HOLD REGISTRATION` 둘, 되돌린 뒤 OK.
- **`src/youtube`, `src/player`, `src/pro-room`과 가드 자체 시험(파일 순서):** 246 files 6,801 / 6,801(6,698과 103, 149 s).
- **Phase 7 T0와 계약 행:** `src/audio` 23 파일, `media-session-lock-screen-pause`, 음향 순서, `setup-start` 26 files 474 / 474.
- **중립 고정을 main 런타임에서:** 라우터 9, 음향 순서 19, 골든 68, `local-offset.test.ts` 31, 127 / 127.
- **형식:** `npm run typecheck:tests`, `tsc --noEmit`, `tsc -p tsconfig.node-scripts.json`, `tsc -p tsconfig.tooling.json` 종료 코드 0,
  바꾼 파일의 eslint(앱·도구 설정)와 prettier 통과.
- **가드:** dead-exports 411 / 2,173 / 0 / 20 / 76, import-graph 411 files 2,107 edges 순환 0, bus-pairing 202 / 202, room-authority 79 / 22 / 13 /
  0 / 0(411 files), brand capitalization 1,040, source-complexity, lifecycle-writes, standard-room-hot-path 통과. release-identity 'MUSIXQUARE
  9.0.32; service-worker cache epoch v805', `guard:sw-cache-version`은 예상 실패 하나(v805, `3ea689b9`, 아홉 파일).
- **크기:** `npm run build`로 코드 끝과, 운영 `src/youtube` 여덟 파일만 main 것으로 바꾼 같은 트리를 견줬다(위 '번들 크기', 라운드 6과 같은
  수).
- **배포 대상:** 운영 9.0.32 `3ea689b9` 대비 App 9, 나머지 Worker 0, 의존성 차이 없음. 계약 동결 경로(`src/youtube/constants.ts` 포함)의
  `git diff --stat 7b869c35..a9951bfd`가 비어 있다.
- **6C-3 넘겨받은 준비 탐침:** 음향 순서 시험의 임시 사본(커밋하지 않음)에서 게스트 로컬 복구 시나리오(다음 트랙 로드 2.6 s 늦음) 중 원격
  방장이 새 준비를 시작하게 했다: 처음 occurrence로 2.8, 2.9, 3.0, 3.12 s(새 실행도 느린 로드로 다시 복구), 게스트가 막 받은 다음
  트랙(상주)으로 2.9, 3.12, 3.4 s. 0.004에서 새 실행이나 그 복구의 소리 복원과 출시는 모든 경우 unMute였다(0은 mute, 0.005는 볼륨 1의
  unMute). 상주 2.9 s에서는 준비 순간 장부의 복구 claim이 active였다.
- **돌리지 않은 것:** 단위 전체, 핵심 커버리지, `build:checked` 사슬, E2E. QA 라운드 8과 9.0.33 뒤의 다시 돌림이 맡는다(위 '머지 전에 할
  일' 1).

### 8. 마지막 검사 (기록 끝 `f9f4a57c`, 코드는 `a9951bfd`와 같음, 2026-11-02 13:31 ~ 14:22 KST)

이 갈래의 worktree에서, 포트 5391 / 5392, trace 끔, `retries: 0`. 시작할 때 같은 PC에서 돌던 다른 무거운 작업은 없었고, 이 검사의 실행은
하나씩 돌렸다(임시 worktree의 `npm ci`만 typecheck와 겹침). Playwright는 혼자 돌렸다. 앞뒤로 작업 트리는 깨끗했다(`git status` 변경 0).
원격 main은 이 검사 동안 `4faf38d9`(#560, App 9.0.33 / v806의 squash, 12:59 KST에 머지)였고 이 갈래는 옮기지 않았다. 9.0.33 위의 확인은
마지막 항목의 임시 worktree에서만 했다.

- **단위 전체(파일 순서):** 750 files 17,983 / 17,983 통과, 건너뜀과 실패 0(496 s, 13:31 ~ 13:39 KST). 다시 돌린 것 없음(git fixture 시간
  초과도 없음). 라운드 6의 17,973에 둘째 리뷰 반영의 골든 다섯과 가드 자체 시험 다섯이 더해진 수다.
- **`src/youtube`, `src/player`, `src/pro-room`, `src/audio`:** 268 files 7,147행(앞 셋 245 files 6,698과 Phase 7 T0의 `src/audio/__tests__`
  23 files 449). 파일 순서(117 s)와 `--sequence.shuffle` seed 7, 31, 4242, 20261030 각각 7,147 / 7,147.
- **`npm run test:coverage:critical`**(`--maxWorkers=4`): 110 files / 4,501 통과, 전체 84.61 / 79.9 / 90.4 / 88.25, 파일별 문턱 오류 없음(93 s).
  lcov로 `arm-steps.ts` 함수 9 / 9, 줄 52 / 52, 분기 32 / 32, `iframe-audio.ts` 17 / 17, 49 / 49, 48 / 48, 장부 20 / 20, 18 / 18, 3 / 3,
  `authority-arm.ts` 89.63 / 82.6 / 98.61 / 93.89, `zero-start.ts` 88.37 / 85.31 / 98.46 / 92.06, Phase 7의 `context.ts` 89.53 / 84.36 / 95.52 /
  91.68, `context-recovery.ts` 90.99 / 88.66 / 88.57 / 93.37(라운드 5와 같음).
- **`npm run typecheck`**(103 s), **`npm run lint`**(110 s), **`npm run format:check`**(41 s): 모두 종료 코드 0.
- **`guard:*` 37개와 `build:checked`의 25 단계:** 사슬은 `guard:sw-cache-version`에서 멈추므로 25 단계(guard 24개와 `npm run build`)를
  사슬 순서대로 하나씩 돌리고, 사슬 밖 guard 13개도 하나씩 돌렸다. 실패는 `guard:sw-cache-version` 하나(위 'Version'의 글 그대로, App 9
  파일)다. 나머지는 통과: authored JS 둘(0 remaining, 107 retired; 0 inline), TypeScript project coverage 1,586 files / 19 projects, classic
  runtime 15, auxiliary browser 2, service worker(v805, 빌드 뒤 바이트 동일), UI kit 10, release identity 'MUSIXQUARE 9.0.32;
  service-worker cache epoch v805', brand capitalization 1,040, declaration ownership 10, source complexity,
  room authority(79 / 22 / 13 / 0 / 0, 411 files), profanity, hreflang 43, sitemap 93, `npm run build`, legacy TV(Chromium 79,
  `main-BmRvLMcR.js`), initial transfer budget(entry 839.6 KiB raw / 247.8 KiB gzip, eager JS 454.5 KiB gzip, eager total 1,999.7 KiB
  raw / 530.9 KiB gzip), prod hooks, prod security, 글꼴(44 stacks, 빌드 포함), SW 앱 셸 96 assets, bus-pairing 202 / 202, chunk-pump(411
  files), transport-health(12 files), import-graph(411 files, 2,107 edges, 순환 0), lifecycle-writes, navigation-sinks, dead-exports(411 /
  2,173 / 0 / 20 / 76), standard-room hot path, Developer API boundaries, D1 migrations(19), ops drift contract, Playwright API.
- **`node scripts/check-resource-ownership.mts`와 `--report`:** OK, 49 records, 458 production files, CHECK 11 20, CHECK 12 읽기 11·지우기 9,
  파사드 쓰기 2, 스냅샷 읽기 8, 장부 합성 1, CHECK 5 1 / 1 / 45, `--report` 107줄(줄 번호를 빼면 라운드 5의 출력과 같음).
- **크기:** `build:checked`의 빌드를 `measureInitialTransfer`로 읽은 값과, 바탕 `7b869c35`의 임시 detached worktree(자기 `npm ci`, 연결
  없음)에서 `npm run build`로 읽은 값이 위 '번들 크기'의 첫 두 줄과 바이트까지 같다(차 +33 B).
- **배포 대상과 계약 동결:** 운영 9.0.32 `3ea689b9` 대비 `f9f4a57c`: App 9, 나머지 Worker 0, 의존성 차이 없음. 계약 동결 경로의
  `git diff --stat 7b869c35..f9f4a57c`가 비어 있다.
- **`npm run build:e2e` 뒤 로컬 Playwright:** `test:e2e:critical`의 여덟 파일 101 / 101(5.3분, background-resume 포함), YouTube spec 열 개
  (`e2e/youtube*.test.ts`, Chromium) 53 / 53(12.2분). 그 가운데 계획 §4.2-3의 여덟(`youtube-sync` 6, `youtube-manual-zero-start` 10,
  `youtube-output-delay` 3, `youtube-end-transition` 6, `youtube-native-operator` 2, `youtube-manual-repeat` 1, `youtube-pending-seek` 4,
  `youtube` 9)은 41 / 41로 6A·6B와 라운드 4, 6의 41과 같고, 나머지 둘(`youtube-landscape-full-bleed` 4, `youtube-search-interactions` 8)은
  12 / 12다. 로컬 WebKit(`playwright.webkit.config.ts`, iPhone 13) `setup-youtube-activation.test.ts` 4 / 4(16.5 s). 실패, 다시 시도, 불안정
  표시는 없다.
- **9.0.33 위 시험(참고, 커밋하지 않음):** `git merge-tree --write-tree origin/main HEAD`의 충돌은 `docs/README.md` 하나다. 위 임시 worktree를
  `4faf38d9`로 바꿔 빌드하고, `git diff 7b869c35 a9951bfd -- src`(22 파일)를 `git apply`로 얹어 다시 빌드했다(크기는 위 '번들 크기'의 참고
  줄). 그 시험 트리에서 `src/youtube`, `src/player`, `src/pro-room`, `src/audio`가 파일 순서로 268 files 7,147 / 7,147이다. 끝에 시험 트리를
  되돌리고 worktree를 지웠다. 옮긴 뒤의 정식 검사를 대신하지 않는다(위 '머지 전에 할 일' 1).

## 하지 않은 것과 확인하지 않은 것

- **6C-3, 버전 올리기, release-record 항목, PR, 머지, 배포:** 6C-3은 오너 답을 기다리고(위 '6C-3'), 나머지는 릴리스 담당의 몫이라 하지
  않았다. GitHub에 쓰지도 읽지도 않았고 push도 없다.
- **9.0.33 위로 다시 옮김과 그 뒤 검사:** 9.0.33은 마지막 검사(QA 라운드 8) 때 이미 main `4faf38d9`(#560)였지만, 그 배포와 기록은
  이 검사에서 확인하지 않았고 옮기기는 릴리스 담당의 머지 전 할 일이라 하지 않았다. 라운드 8은 바탕 `7b869c35` 위의 갈래를 검사했고,
  9.0.33 위는 시험 병합과 커밋하지 않은 시험 트리(빌드 크기와 단위 묶음)만 봤다. 옮긴 뒤 끝 SHA에서 WebKit `setup-youtube-activation`,
  YouTube Chromium spec 여덟, critical E2E, 단위 전체, `build:checked`, 새 부모 대비 eager 크기를 다시 돌린다(위 '머지 전에 할 일' 1).
  QA 라운드 5 ~ 8은 그 후보를 대신하지 않는다.
- **T0b 결함 넷의 고침:** 오너 답 전이라 싣지 않았다. 참값표가 오늘 동작으로 고정한 결함(H4·H4a, G8pa·G8·G8p·G8a, P1·P4, H10·H10a·H10c)은
  6C가 답을 바꾸지 않아 그대로다. 화면에 닿는 고침([화면 바뀜])은 묻지 않고 싣지 않는다.
- **새 결함 하나(Q18):** settle 중 늦춘 다시 seek의 throw가 전역 오류 로그로 나가는 것은 오늘 동작으로 고정했고 고치지 않았다(위 '오너에게'
  2). 같은 골든이 고정한 관찰 하나는 결함으로 보지 않는다: 정착을 시작하는 `pauseVideo()`가 던지는데 재생은 이어지는 가짜 모형에서는 두
  기계가 준비 실패 정리에서 소리를 되돌려(`setVolume`·`unMute`) 무음으로 돌던 warm 재생이 들릴 수 있다. 실제 기기에서 `pauseVideo()`만 실패하고
  재생이 이어지는 경우는 확인되지 않았다[추론]. 기기에서 재현되면 그때 묻는다.
- **실기기, iOS Safari, 블루투스, 6C 런타임의 Full E2E와 CI:** 기기 확인은 배포 뒤 블라인드로 하며 게이트가 아니다. WebKit 레인은 로컬
  `setup-youtube-activation.test.ts`만 돌렸다(계획 §4.2-4). Phase 6 앞의 기기 기준선(Q6)은 재지 않았다.
- **`check:workers`, Worker 묶음 dry-run, Worker 단위 커버리지:** `cloudflare/` 차이가 0이고 버전 거울을 바꾸지 않아 돌리지 않았다. Worker의
  타입 검사(`typecheck:workers`, `types:workers:check`)는 `npm run typecheck` 사슬 안에서 돌았다.
- **변이 확인:** 구현 때(QA 라운드 1), 첫 독립 리뷰(QA 라운드 2), 둘째 독립 리뷰(QA 라운드 6, 변이 50개)의 결과와 둘째 리뷰 반영의 settle
  변이 셋(QA 라운드 7)을 적었다. 넘겨받기 전 마지막 검사(QA 라운드 4)와 옮긴 뒤 마지막 검사(QA 라운드 8)는 변이를 다시 하지 않았다.
- **가드가 보지 않는 것:** `AUDIO HOLD REGISTRATION`은 등록 자리와 횟수, 주인의 주차 자리 쓰기와 넘기기를 보고, 등록이 넘기는 클로저의
  내용(주차 질의와 검증 hard mute)은 보지 않는다. `PAUSE GATE WRITERS`는 관문 셋터의 호출 자리와 토큰 쓰기를 보고, 셋터를 부르는 처리기의
  순서(밀기 다음 쓰기)는 보지 않는다(O6, O7 행의 몫). 그 몫은 O3, O7과 `stale-async-guards.test.ts`의 주차 행이다. 레지스트리 '아직 검사 안 함'의 나머지(문장 사이에 엮은 claim,
  주인 인스턴스에 부른 claim 질의 등)는 그대로다.
- **넘겨받은 준비 의도의 길:** 게스트 로컬 대체를 넘겨받는 실행에 'rounded' 의도가 닿는 길을 로컬 탐침으로 재현하지 못했다(QA 라운드 7).
  6C-3을 만들기 전에 확인한다.
- **남은 주석:** T0a 시험 `youtube-start-owner-boundary.test.ts`의 머리 주석(21 ~ 23줄)이 6B가 지운 합성과 다리 훅 이름을 아직 적는다(6B
  보고서가 적은 것). T0a 파일을 바이트 그대로 두는 열차라 고치지 않았고, 다음 시험만 커밋에서 고친다.
- **6C-3 표의 기기 값:** 아이폰이 YouTube 볼륨을 무시해 기기 볼륨으로 들린다는 것과 PRO 방의 시작 시각(가장 늦은 READY의 0.7초 뒤)은
  추론이고, '무시 n번'은 흉내다. 오너가 '예'로 답하면 만든 뒤 배포 뒤 확인에 0.5 % 아래 설정 기기 한 번을 더할지는 그때 정한다.
- 영역 조사의 대략적 기기 시간(약 2시간 15분)은 추정이다.
