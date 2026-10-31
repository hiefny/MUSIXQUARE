# Phase 6 6A: YouTube 시작 시간 집, 시작 타이머 소유자 질의, 검증 복원 하나 (2026-10-31)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | 준비됨, 배포 전(App 9.0.30 / v803으로 낼 열차, 미병합). 계획의 6A-1 ~ 6A-4, 열차 리뷰 반영, 크기 후속과 그 리뷰 반영이 브랜치 `agent/p6-6a`에 있다. 처음 main `599465dd` 위에서 21커밋(테스트 먼저 7, 코드 7, 가드만 2, 시험만 4, 주석·레지스트리만 1)과 기록 커밋 셋(`a883f9b9`, `a9b670fa`, `b92e6417`)으로 만들었고, 2026-10-31 20:30 KST에 그 스물넷을 패치 그대로 main `9e68a7a3`(App 9.0.28 #545, 그 기록 #546, 시험만 #547 뒤) 위로 옮겼다(머리 `77c34a25`, 아래 QA 라운드 6의 대응표). 그 뒤에 옮김을 적은 기록 커밋 둘(이 보고서의 상태와 QA 라운드 6, release-record §2의 이 열차 '배포 전' 항목)이 있다. 오너가 앱 글꼴 업데이트를 먼저 내기로 정해 그것이 App 9.0.29 / v802(#548, 2026-10-31 23:39 KST 배포)로 나갔고, 2026-11-01 01:00 KST에 스물여섯 커밋을 패치 그대로 그 배포 기록(#549) 뒤의 main `e51dd292` 위로 다시 옮겼다(QA 라운드 7의 대응표). 그 위에 배포 순서와 Q6을 고친 기록 커밋, 버전 올리기와 함께 고칠 남은 기록(아래 '배포 조건과 순서' 4), Phase 5.5 R4가 넘긴 R4-Q3 주석 커밋, 버전 올리기(9.0.30 / v803, 마지막 런타임 커밋)와 그 뒤 검사를 적는 기록 커밋을 더한다. PR, 배포와 배포 기록은 이 브랜치에 없다. QA 라운드 1(테스트 먼저 커밋을 부모 런타임에서 다시 돌림)과 2(`b80485f3`의 전체 검사)를 2026-10-31 16:03 ~ 17:19 KST에, 크기 후속의 라운드 3(`08135e4f`)을 17:53 ~ 18:25 KST에, 그 리뷰 반영의 라운드 4(`0f28e66d`, 가드만)를 19:04 ~ 19:12 KST에, 옮기기 전 브랜치 끝의 마지막 검사인 라운드 5(코드는 `0f28e66d`)를 19:21 ~ 20:06 KST에, 옮김과 재확인인 라운드 6(코드는 `f6275c81`, `0f28e66d`와 같은 6A 코드)을 20:30 ~ 21:20 KST에, 9.0.29 기록 위로 다시 옮김과 재확인인 라운드 7(코드는 `cbc107a8`, 같은 6A 코드)을 2026-11-01 01:00 ~ 01:19 KST에 했다. 처음 받는 코드는 바탕보다 작다: 처음 바탕에서 증분 차의 합으로 eager JS gzip −149 B(eager 전체 −152 B), 옮긴 바탕 `9e68a7a3`과 머리를 다시 빌드해 견주면 둘 다 −114 B, 다시 옮긴 바탕 `e51dd292`(App 9.0.29와 같은 런타임)와 견주면 eager JS −154 B, eager 전체 −152 B라 Phase 6 상한 안이다(아래 '번들 크기'). 오너 질문 둘은 권장안 (가)를 따랐다: 1(크기)은 크기 후속으로 정할 것이 남지 않았고, 2(계획의 상태 이름 정리)는 이 브랜치에 싣지 않았다. 배포 순서는 오너가 정했다(2026-10-31 저녁, 아래 '오너에게' 3): 앱 글꼴 업데이트를 먼저 내고(9.0.29), 6A는 그 뒤에 9.0.30 / v803으로 낸다. 오너가 2026-10-31 23:20 KST 무렵 약 40시간 자리를 비우며 릴리스와 시험을 맡겼으므로(오너의 허락이 꼭 필요한 일만 묻고 나머지는 진행), 그 동안은 이 위임이 'Phase 6 업데이트 열차는 오너가 깨어 있을 때만 낸다'는 규칙을 대신한다(아래 '배포 조건과 순서' 2). 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다 |
| Base               | main `e51dd292`(App 9.0.29의 배포 기록 #549, 2026-11-01 01:00 KST에 다시 옮긴 바탕, QA 라운드 7). 운영 App 9.0.29 / v802(`c4667abc`, 2026-10-31 23:39 KST 배포) 뒤 main에 들어온 것은 그 배포 기록(문서만)이라 바탕의 App 런타임 경로는 운영과 같다. 같은 툴체인으로 만든 바탕 빌드의 진입 청크도 9.0.29 운영 smoke가 읽은 것과 이름·크기가 같다(`main-L7A6LLee.js`, 862,602 B). 다시 옮기며 지난 #548의 App 런타임(글꼴 전환)과 시험은 이 갈래가 바꾼 파일과 겹치지 않고, 겹친 것은 `docs/README.md`와 `docs/release-record.md`뿐이다. 그 앞 바탕은 main `9e68a7a3`(2026-10-31 20:30 KST에 옮긴 바탕, QA 라운드 6)였다. 그때 운영 App 9.0.28 / v801(`aa7baad5`, 2026-10-31 11:29 KST 배포) 뒤 main에 들어온 것은 문서(#546)와 시험만(#547)이라 바탕의 App 런타임 경로가 운영과 같았고, 같은 툴체인으로 만든 바탕 빌드의 진입 청크도 9.0.28 운영 smoke가 읽은 것과 이름·크기가 같았다(`main-DL5HBqTb.js`, 862,523 B). 옮기며 지난 #545의 App 런타임(PRO 시스템 오디오 SFU 둘, 재생목록 그리기 둘, 버전 거울)은 이 갈래가 바꾼 13 파일과 겹치지 않는다. 처음 바탕은 main `599465dd`(Phase 6 T1 #543와 YouTube 시험 순서 #544 뒤)였다. 그때 운영 App 9.0.27 / v800(`23f29283`, 2026-10-31 04:31 KST 배포) 뒤 main에 들어온 것은 문서(#540), 시험만(#541, #542, #544), 가드만(#543)이라 바탕의 App 런타임 경로가 운영과 같았고, 바탕 빌드의 진입 청크도 9.0.27 운영 smoke가 읽은 것과 같았다(`main-BYFZlrrn.js`, 862,203 B). 아래 라운드 1 ~ 5와 표의 '바탕'은 이 처음 바탕이다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Version            | 9.0.30 / v803. 버전 올리기 커밋(마지막 런타임 커밋)이 9.0.29 / v802를 9.0.30 / v803으로 올린다. 그 앞 커밋들은 SemVer와 SW 캐시를 바꾸지 않는다(다시 옮긴 뒤 `guard:release-identity` 'MUSIXQUARE 9.0.29; service-worker cache epoch v802', 그 앞에는 9.0.28 / v801과 9.0.27 / v800). App 런타임 경로가 바뀌므로 다음 App 패치와 SW epoch를 함께 올려야 하고, 버전 올리기 앞에서는 `guard:sw-cache-version`이 바로 그 이유 하나로 실패한다(다시 옮긴 뒤 'newer than v802 (c4667abc)', QA 라운드 7. 그 앞에는 'newer than v801 (aa7baad5)', 라운드 6, 'newer than v800 (23f29283)', 라운드 2와 5). 올리면 업데이트 창이 한 번 뜬다(Q1의 넷 가운데 첫째, 9.0.29의 창 다음, 창 모양은 지금 그대로). 바닥(저장·유효 795)은 바꾸지 않는다. 9.0.27 기록이 적은 9.0.28(SFU 추측 발행)은 이 갈래를 만드는 동안 나갔고, 오너가 먼저 내기로 한 앱 글꼴 업데이트가 9.0.29 / v802로 나간 뒤라 6A의 번호가 9.0.30 / v803이다(아래 '배포 조건과 순서' 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Scope              | 계획 §4.5의 6A-1 ~ 6A-4, 모두 중립. 6A-1(H3, PRE-1, PRE-2, PA-15): 다른 모듈이 시작 타이머를 이름으로 읽지 않고 그 주인에게 묻는다. 6A-2(PRE-5): `resetYouTubeSyncState`가 되풀이하는 직접 지우기 하나와 아무도 걸지 않는 `'yt-mix-snapshot'` 지우기를 지운다. 6A-3(C2-1, PRE-10, PA-04 ~ PA-06, RT-02): YouTube 시작 시간 값을 `src/youtube/constants.ts` 한 집으로 모은다. 6A-4(C2-3, SS-01, PA-13): 여섯 오디오 복원 루프가 새 `src/youtube/iframe-audio.ts`의 검증 복원 하나를 쓴다. 와이어, 서버, 저장 모양, 계약 표지, 의존성, 타이머 이름, 로그 줄, 화면, 소리는 바꾸지 않는다([화면 그대로]). 계획의 6A-3 (가) 상태 열거는 이 브랜치에 없다(아래 '계획과 달라진 것'). 6A-5(버전 올리기·문서)는 9.0.29 기록 위로 다시 옮긴 뒤 더했다: 남은 기록, 9.0.30 / v803 버전 올리기. 그 앞에 Phase 5.5 R4가 다음 App 업데이트로 넘긴 R4-Q3 주석 하나(`src/pro-room/snapshot.ts`, 주석뿐)를 실었다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Deploy target      | `app`(예상). `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`, `changedAppRuntimeDependencies`, `releaseTargetWorkers`로 `599465dd..b80485f3`을 견준 로컬 git 판정: App 13(`src/player/playlist.ts`, `src/pro-room/playback-authority-hooks.ts`, `src/pro-room/playback-controller.ts`, `src/youtube/`의 `authority-arm.ts`, `constants.ts`, `handlers.ts`, `iframe-audio.ts`, `iframe.ts`, `native-control-authority.ts`, `player-runtime-bridge.ts`, `player.ts`, `sync.ts`, `zero-start.ts`), PRO room 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음. 운영 App `23f29283` 대비도 같은 App 13이고, 운영 PRO room `683074bc`와 나머지 넷 `71f5b96c` 대비 그 Worker들의 런타임 경로 차이는 0이다. 크기 후속 뒤 `599465dd..08135e4f`도 같은 함수로 같은 App 13, 나머지 Worker 0, 의존성 차이 없음이다(후속이 바꾼 런타임 경로 6개가 모두 그 13 안). 그 리뷰 반영 뒤 `599465dd..0f28e66d`와 마지막 검사의 브랜치 끝도 같다(리뷰 반영과 기록은 런타임 경로 0). 옮긴 뒤 같은 함수로 `9e68a7a3..77c34a25`도, 운영 App 9.0.28 `aa7baad5`, PRO room `683074bc`, 나머지 넷 `71f5b96c` 대비도 같은 App 13, 나머지 Worker 0, 의존성 차이 없음이다(QA 라운드 6). 다시 옮긴 뒤 `e51dd292..3be18bdb`도, 운영 App 9.0.29 `c4667abc`, PRO room `683074bc`, 나머지 넷 `71f5b96c` 대비도 같은 App 13, 나머지 Worker 0, 의존성 차이 없음이다(QA 라운드 7). R4-Q3 주석(`src/pro-room/snapshot.ts`, App 경로뿐)과 버전 올리기(버전 거울)가 그 위에 App 경로만 더한다(QA 라운드 8). 운영을 조회하지 않은 판정이라 릴리스의 부분 릴리스 검사를 대신하지 않는다. `raise_app_build_floor` false, Developer API D1 false(계획 RT-01)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Operations         | 운영에 닿지 않았다. 로컬 git, 로컬 시험·빌드·Playwright만 했다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Resource ownership | 새 레코드 없음(새 흐름이 아니라 기존 자원 RO-02, RO-03, RO-12의 주인 이동). 센 코드를 옮긴 커밋이 같은 커밋에서 레지스트리 RO-02(H3 소유자 질의, 시간 집, 받는 쪽 parity 시험), RO-03(시간 집), RO-12(검증 복원, 새 파일 머리 `Resource owner: RO-12`)와 가드 항목 11·12, 기준치를 고쳤다: CHECK 11 44 → 32, CHECK 12 읽기 14 → 11과 지우기 10 → 9, CHECK 5 복사 2 → 1(아래 '정확한 개수 가드'). 크기 후속은 기준치와 보고만 하는 같은 값 쌍(45)을 바꾸지 않고, RO-02, RO-03, RO-12의 시간 집 문장이 낱개 이름을 적는다. 그 리뷰 반영의 가드 커밋(`0f28e66d`)은 CHECK 5가 스칼라 집 옆 사본을 다시 잡게 하고 가드 항목 5 문장을 고치며, 기준치와 쌍은 그대로다. `node scripts/check-resource-ownership.mts`: 49 records, 450 → 451 production files(9.0.29 기록 위로 다시 옮긴 뒤 457, #548의 글꼴 전환 뒤의 수)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

이 문서는 Phase 6 계획의 첫 App 열차 6A의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의
Phase 6 계획(2026-10-30)과 그 영역 조사, 오너 답(2026-10-30)이고, PRE, PA, RT, SS, C2 번호와 Q 번호는 그 노트의 번호다.
계획의 줄 번호는 `78ec56f5`, `d630269a`, `f8a30068` 기준이라 위치를 모두 기호로 다시 찾았다. 앞선 Phase 6 단계는 시험만인
T0a(#539, #541, #542)와 가드만인 T1(#543)이고, `AGENTS.md`대로 보고서가 없다. 이 보고서에서 '중립'은 T0a의 골든과 고정 행이
바이트 그대로 통과하고, 와이어가 바뀌지 않고, 같은 프레임이 같은 시각에 나간다는 뜻이다.

## 오너 결정 (2026-10-30, 모두 권장)

- **Q0 시작:** PRO 정리 R4가 나간 뒤 따로 '시작' 없이 Phase 6을 시험·가드만인 첫 단계(T0a, T1)부터 시작한다. 6A는 그 다음 단계다.
- **Q1 넷:** Phase 6을 App 업데이트 넷(6A ~ 6D)으로 낸다. 6A가 첫째이고, 업데이트 창은 버전 올리기와 함께 한 번 뜬다.
- **Q3 박자는 각자 그대로:** 소리를 되돌리는 박자 셋을 공용 코드로 옮기되 간격은 바꾸지 않는다. 6A-4가 '명령 → 120 ms → 확인'
  (`'settle-then-verify'`)과 '명령 → 확인 → 120 ms'(`'verify-then-settle'`)를 매개변수로 두고, 두 복구의 해제 앞 복원은 자기
  50 ms 폴을 그대로 쓴다.
- **Q4 C2-1은 첫 업데이트에:** 미뤄 둔 App 쪽 Phase 0d 상수 정리(C2-1)를 따로 내지 않고 6A-3에 실었다.
- **Q18 결함마다 묻기:** 시험이 결함을 재현하면 오늘 동작으로 고정하고 결함마다 따로 묻는다. 이 열차의 새 행은 모두 오늘 동작을
  고정한 것이고 결함으로 적은 행은 없다. PRO 늦은 합류 고정(#539)이 재현한 Q22의 (가) ~ (라)는 오늘 동작 그대로 초록이다.
- **Q6 기준선:** 오너 답(2026-10-30)은 '시간이 될 때 9.0.27 뒤의 운영에서 기기 기준선을 재고, 첫 업데이트 전에 절차를 받는다'다.
  절차는 계획 §7의 기기 기준선 절차(7.1 ~ 7.7, 합 약 3시간, 없는 기기의 단계는 건너뛰고 '기기 없음'으로 적음, 확인하는 사람에게
  기대값은 주지 않음)이고, 이 릴리스 전에 오너에게 드리는 비공개 질문 목록에 넣어 건넸다. 게이트가 아니다. Phase 6 앞의 기준선은
  재지 않았다: 오너가 자리에 없어(2026-10-31 23:20 KST 무렵부터 약 40시간) 오너 기기로 잴 수 없었고, 6A는 위임대로 기준선 없이
  나간다. 그래서 아래 '배포 뒤 확인'은 기준선과 견주지 못하고 판정 기준과만 견준다.
- **엔지니어링 기본값(계획 §9.3 아홉, §9.4 열, 권장대로):** 이 열차가 기댄 것은 Q5(두 2.3 s는 따로 두고 순서 시험으로만 잇는다,
  7,700은 10,000 − 2,300으로 끌어낸다), Q7(소유자 질의는 처음에 소유자 자기 타이머를 읽는다), Q8(시작 소유를 native 보호 목록에
  넣지 않는다), Q9(PRO 넛지 이름 읽기는 남긴다, RO-13), Q10(CHECK 11·12는 resource-ownership 가드 안), Q11(새 test-only export
  없음), Q17(겹친 직접 지우기 하나와 죽은 지우기만 지운다), Q21(release-record의 'Android YouTube 출력 정렬·혼합 버전' 항목은 바닥
  795를 근거로 혼합 버전 문장만 닫고 출력 정렬 실측은 남긴다, 6A-5), Q26(새 모듈 `iframe-audio.ts`), Q29(번들 상한을 넘으면 잰
  숫자로 묻는다, 아래 '오너에게' 1)다. Q24(정확 개수 가드)는 이미 정해진 규칙이다.
- **배포 순서(오너 답 2026-10-31 저녁, 아래 '오너에게' 3):** 앱 글꼴 업데이트를 먼저 낸다. 그것이 App 9.0.29 / v802로 2026-10-31
  23:39 KST에 나갔고, 6A는 그 배포 기록 위로 옮겨(QA 라운드 7) 9.0.30 / v803으로 낸다. 업데이트 창은 모두 두 번 뜬다.
- **릴리스 위임(2026-10-31 23:20 KST 무렵):** 오너가 약 40시간 자리를 비우며 릴리스와 시험을 맡겼다(오너의 허락이 꼭 필요한 일만
  묻고 나머지는 진행). 그 동안은 이 위임이 'Phase 6 업데이트 열차는 오너가 깨어 있을 때만 낸다'는 규칙을 대신하므로, 6A는 자동
  관문을 모두 통과하면 오너가 자리에 없어도 낸다(아래 '배포 조건과 순서' 2).

## 증분 한눈에

'부모에서'는 테스트 먼저 커밋을 그 트리 그대로(런타임은 부모의 것) 다시 돌린 결과(실패 / 그 실행의 행)이고, '코드 커밋에서'는 같은
파일과 코드 커밋이 고친 시험 파일을 코드 커밋에서 돌린 결과다. 둘 다 이 검사가 임시 worktree에서 다시 돌렸다(QA 라운드 1). 크기
후속 행은 QA 라운드 3이, 그 리뷰 행은 라운드 4가 이 갈래의 worktree에서 돌렸다. 실패한 행은 모두 바꾼 행이고, 양쪽 통과를 뜻한
행은 부모에서도 통과했다. 이 표와 아래 절의 SHA는 처음 바탕 `599465dd` 위의 것이다. main `9e68a7a3` 위로 옮긴 뒤의 SHA와, 옮긴
부모에서 다시 돌려 같은 이름의 행만 실패하고 코드 커밋에서 모두 통과한 결과는 QA 라운드 6에 있다.

| 증분                              | 항목                              | 테스트 먼저 → 코드                              | 부모에서                                   | 코드 커밋에서      | 가드                          |
| --------------------------------- | --------------------------------- | ----------------------------------------------- | ------------------------------------------ | ------------------ | ----------------------------- |
| 6A-1 H3 소유자 질의               | PRE-1, PRE-2, PA-15               | `09a1bb8c` → `faffa69b`                         | 15 / 121(3 files)                          | 211 / 211(5 files) | CHECK 12 읽기 14 → 11         |
| 6A-2 겹친 직접 지우기             | PRE-5                             | `8cc9decc` → `d34b4478`                         | 3 / 112(2 files)                           | 293 / 293(3 files) | CHECK 12 지우기 10 → 9        |
| 6A-3 C2-1 시간 집                 | PRE-10, PA-04 ~ PA-06, RT-02      | `d9bee96c` → `4c5ca5e9`                         | 8 / 82(3 files)                            | 438 / 438(9 files) | CHECK 5 복사 2 → 1            |
| 6A-4 C2-3 검증 복원               | SS-01, PA-13                      | `e1a1a4d3` → `5e3edd0c`, `0ec9e8e0`, `0cd720fc` | 1 / 67, 새 시험 파일은 불러오기 실패(27행) | 534 / 534(8 files) | CHECK 11 44 → 32              |
| 리뷰: CHECK 12를 이름마다 셈      | RO-02, 가드 항목 12               | `cd35aed8` → `4a1a7e89`                         | 4 / 68                                     | 68 / 68            | 수 그대로(11, 9)              |
| 리뷰: 오늘 동작 고정              | 시험만 넷                         | `a35e07b9`, `95b03762`, `21f1836a`, `b80485f3`  | 새 행 모두 통과(6A 앞 런타임에서도)        | 해당 없음          | 없음                          |
| 리뷰: 주석·레지스트리             | RO-02, RO-03, RO-12, 가드 항목 12 | `5a3d356b`                                      | 해당 없음                                  | 빌드 바이트 동일   | 없음                          |
| 크기 후속: 낱개 이름 집           | 6A-3(C2-1), Q29                   | `12367317` → `08135e4f`                         | 4 / 83(2 files)                            | 234 / 234(6 files) | 수 그대로(CHECK 5 1 / 1 / 45) |
| 크기 후속 리뷰: CHECK 5 스칼라 집 | 6A-3(C2-1), 가드 항목 5           | `fcb21ae6` → `0f28e66d`                         | 2 / 72                                     | 72 / 72            | 수 그대로(CHECK 5 1 / 1 / 45) |
| 기록                              | 이 보고서, `docs/README.md`       | 기록 커밋 셋                                    | 해당 없음                                  | 해당 없음          | 없음                          |
| R4-Q3 주석(9.0.29 기록 위)        | Phase 5.5 R4 오너 질문 R4-Q3      | 아래 'R4-Q3 주석'                               | 해당 없음                                  | 빌드 바이트 동일   | 없음                          |

## 증분

### 6A-1 H3 소유자 질의 (PRE-1, PRE-2, PA-15)

바탕에서는 `native-control-authority.ts`의 `hasProtectedTransitionOwner`가 일곱 이름(PRO 넛지, `'yt-auto-sync'`,
`'yt-clock-action'`, `'yt-seek-play'`, `'yt-rendezvous-buffer'`, `'yt-rendezvous-play'`, `'yt-rendezvous-calibrate'`)을, `sync.ts`의
수동 아닌 하트비트 보류와 `iframe.ts`의 보조 `YOUTUBE_STATE` 보류·서브 영상 자동 넘김 확인이 `'yt-auto-sync'`를 이름으로 읽었다.

- `player-runtime-bridge.ts`: 새 훅 `isYouTubeAutoSyncPending`. `player.ts`가 설정하기 전에는 false이고, `player.ts`는 자기
  `'yt-auto-sync'` 타이머로 답한다(Q7).
- `native-control-authority.ts`: 등록 포트 `registerYouTubeNativeControlSyncOwnerQuery`. 등록 전에는 false다. `sync.ts`가 이 모듈을
  가져오므로 거꾸로 가져올 수 없어, `sync.ts`가 모듈 끝에서 자기 타이머 다섯(두 상태 동작과 랑데부 세 단계)에 대한 질의를 등록한다.
  follow-up realign(`'yt-rendezvous-follow-up'`)은 옛 이름 목록처럼 넣지 않는다. `hasProtectedTransitionOwner`는 기존 질의 여섯을
  그대로 두고, PRO 넛지는 이름으로 계속 읽고(RO-13 owner-in-place), 이어 두 질의를 옛 목록의 순서로 묻는다.
- `sync.ts`의 하트비트 보류와 `iframe.ts`의 두 확인은 `isYouTubeAutoSyncPending`을 묻는다. 보조 `YOUTUBE_STATE` 보류의
  `isYouTubeZeroStartProtocolActive()` 절반은 계획대로 6B-2 몫이라 그대로다. `player.ts` 자기 읽기, 타이머 이름, 거는 곳은 그대로다.
- 훅 객체 전체를 넘기는 시험 셋에 새 필드를 더했다(`host-local-rendezvous.test.ts`의 대역은 자기가 거는 `'yt-auto-sync'`로 답하고,
  나머지 둘은 그 타이머가 없어 false).
- 가드 CHECK 12 읽기 14 → 11(`iframe.ts` 3 → 1, `sync.ts` 4 → 3, `native-control-authority.ts`는 넛지만 남아 1). import graph에
  간선 하나(`native-control-authority.ts` → `player-runtime-bridge.ts`)가 늘고 순환은 없다. 새 export 둘은 운영 코드가 가져간다.
- 시험(테스트 먼저 `09a1bb8c`): 새 `native-control-owner-ports.test.ts`가 `player.ts`와 `sync.ts`를 불러오지 않은 채 Standard 방장
  native PLAY의 보호 소유자 판정을 본다: 다리 질의가 pending이면 그 이름의 타이머가 없어도 보류, 여섯 이름 가운데 하나의 날
  타이머만 있고 주인이 아니라고 답하면 그대로 결정, `sync.ts`가 등록한 질의가 pending이면 보류. 대조 행과 PRO 넛지 행은 양쪽에서
  통과한다. `youtube-timer-owner-queries.test.ts`에 다리 질의가 2단계 대기 동안 pending이고 대기가 끝나거나 pause가 더 새 대기를
  거두면 아님을 보는 행 하나, `resource-ownership-guard.test.ts`의 운영 글을 고정한 CHECK 12 행 여섯.
- 부모에서 15 / 121 실패: owner-queries 1(`isYouTubeAutoSyncPending`이 없어 TypeError), owner-ports 8(이름을 읽는 부모는 질의를
  무시하거나 등록 포트가 없음), 가드 6(운영 글과 수가 아직 14와 10). T0a H3 진리표를 포함한 owner-queries의 나머지 45행과 owner-ports의
  대조·넛지 행 2는 통과했다. `faffa69b`에서 그 세 파일과 훅 필드를 더한 `host-local-rendezvous.test.ts`(70),
  `zero-start-heartbeat-ownership.test.ts`(20)까지 211 / 211 통과.

### 6A-2 겹친 직접 지우기 (PRE-5)

- `iframe.ts`의 `resetResidentYouTubeSync`가 `'yt-clock-action'`을 직접 지우지 않는다. 같은 동기 실행에서 바로 다음에 부르는
  `resetYouTubeSyncState`가 주인(`cancelClockAction`)으로 그 타이머, 세대, clock-action 로딩 표시를 거둔다. 그 사이에 타이머를
  읽는 코드가 없고 `clearManagedTimer()`는 다른 효과가 없다.
- `player.ts`의 `stopYouTubeMode`가 `'yt-mix-snapshot'`을 지우지 않는다. 그 이름의 타이머를 거는 코드가 없다. 시작 타이머가 아니라
  CHECK 12가 세지 않던 줄이다.
- 남긴 것(Q17): reset의 `'yt-seek-play'` 직접 지우기(아래 '계획과 달라진 것' 4), reset의 `'yt-auto-sync'` 지우기(`player.ts`의
  retire 없이 돎), `player.ts`의 상태 동작 지우기 여섯, `sync.ts`의 넛지 지우기, `leaveSession`의 이름 없는 `clearAllManagedTimers`.
- CHECK 12 지우기 10 → 9(`iframe.ts` 3 → 2). `src/youtube/`의 타이머 호출은 209 → 207(가드 항목 12).
- 시험(테스트 먼저 `8cc9decc`): owner-queries의 PRE-5 행이 `adoptResidentYouTubeOccurrence`가 대기 중인 게스트 clock action을 주인으로
  거두고(`'false clock-action'` 한 번, play 없음) 대기 중인 `'yt-seek-play'`를 지움(play 없음)을 고정한다. 부모와 코드 커밋 양쪽에서
  통과해야 하는 중립 고정이다. 가드 행 셋이 바뀐 운영 글(지우기 9, `iframe.ts` 기준 2)을 본다.
- 부모에서 3 / 112 실패(가드 셋). PRE-5 행을 포함한 owner-queries 47행은 통과했다. `d34b4478`에서
  `stale-async-guards.test.ts`(181)까지 293 / 293 통과.

### 6A-3 C2-1 시간 집 (PRE-10, PA-04 ~ PA-06, RT-02)

`src/youtube/constants.ts`에 새 export 여섯을 두고 Standard zero-start 컨트롤러, PRO arm, PRO 준비 이음새(`iframe.ts`), Standard
복구(`player.ts`), PRO 재생 컨트롤러가 각자의 사본 대신 그것을 읽는다. 숫자는 모두 그대로다. 아래의 두 묶음(`YOUTUBE_ARM_TIMING`,
`STANDARD_ZERO_START_BARRIER`)은 크기 후속(`08135e4f`)부터 값마다 이름 붙인 export다(아래 '크기 후속').

- `YOUTUBE_ARM_TIMING`: hard-mute 폴 30 ms × 12, warm play 260 ms, pause·seek 간격 80 ms, 정착 폴 80 ms, 정착 허용치 0.12 s, 정착
  박자(연속 2표본, 여섯째 폴마다 다시 seek, 계획 (라)), 오디오 복원 120 ms × 8, 출시 확인 1.8 s, 따라잡기 허용치 40 ms.
  `YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC`는 40 / 1,000으로 끌어내며 옛 리터럴 0.04와 같은 double이다.
- `STANDARD_ZERO_START_BARRIER`: 게스트 대기 3,000, 게스트 결정 2,300, 시작 앞섬 700, 준비 예산 10,000, 늦은 대체 앞섬 800 ms.
  코호트에서 빠진 게스트가 받는 7.7 s는 준비 예산 − 게스트 결정으로 끌어낸다(Q5).
- PRO 준비 예산 둘(`PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS` 2,300, `PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS` 10,000)을
  `iframe.ts`에서 주석과 함께 옮겼다. 2.3 s는 Standard 게스트 결정과 값만 같은 다른 값이라 주석으로만 잇는다(Q5).
- `YOUTUBE_FRESH_START_MAX_SEC`(0.12, 계획 (나)): `handlers.ts` 둘, `player.ts` 둘, `native-control-authority.ts` 하나의 새 시작 문턱.
  같은 값의 정착 허용치와 이름을 나눴다.
- `zero-start.ts`는 자기만 쓰는 타임라인·보정 값만 남기고 머리 주석이 PRO를 섬긴다고 더 적지 않는다. `authority-arm.ts`는 `TIMING`
  사본을 지웠다. `player.ts`의 두 정리 루프의 120 ms·8회, 1.8 s, 초 단위 0.04 비교, 0.12 문턱이 집을 읽는다. 3 s 다리, 0.35 s 정착,
  50 ms 폴은 한 파일만 써서 남는다(계획 (다), 6D-1이 옮김). `playlist.ts`는 무장벽 예산을 집에서, `playback-controller.ts`는 자기
  40 ms 사본 대신 arm의 따라잡기 허용치를 가져온다. 3,000 ms `LATE_YOUTUBE_COMMIT_LEAD_MS`는 PA-06대로 비공개로 남는다.
- `playback-authority-hooks.ts`의 `prepareBudgetMs` 주석이 끝점이 그 값으로 하는 일(값은 읽지 않고 있었는지만 봄)을 적는다(주석만).
- 시험 사본: 늦은 합류 도우미 사본(`pro-late-youtube-join-timing.ts`)에서 40 ms와 1.8 s를 빼고 네 묶음이 `YOUTUBE_ARM_TIMING`을
  읽는다(크기 후속부터 낱개 이름 export). `playlist.test.ts`는 무장벽 예산을 집에서 읽는다. 단언은 바뀌지 않았다. 레지스트리 RO-03
  'Anchor tests'의 그 값 줄도 같이 고쳤다.
- 가드: `constants.ts`가 RO-02/RO-03/RO-12 시간 계약 파일이 되고 arm 시간 복사 쌍이 없어졌다(CHECK 5 복사 2 → 1). 그 대신 기존
  `constants.ts` 스칼라와 `iframe.ts` 모듈 스칼라의 같은 값 쌍 18이 보고만 하는 목록에 더해졌다(27 → 45). 레지스트리 RO-02, RO-03,
  RO-12가 집과 parity 시험 이름을 적는다. `guard:import-graph`는 `src/pro-room` → `src/youtube/constants.ts` 간선을 더해도 순환 0이다.
- 시험(테스트 먼저 `d9bee96c`): 새 `start-timing-parity.test.ts`가 각 집을 옮기기 전 사본의 리터럴 값으로 고정하고(7.7 s와 0.04 double
  포함), 진짜 zero-start 컨트롤러를 보낼 수 있는 끝값까지 몰아 그 프레임을 받는 쪽(`registerHandler`, `handleData`)에 넣는다:
  PREPARE 창과 그 10 s 상한, Android 출력 지연 250 ms를 실은 ±600 ms ARMED 앞섬, ARMED 위치·볼륨·로드 비율·`preparedMs`, 100 peer
  코호트, TIMELINE 위치. 받는 쪽은 각 끝값을 받고 한 걸음 너머를 버린다. 이 시험은 `cloudflare/`를 가져오지 않는다.
  `pro-room-playback-timing.test.ts`에 2.3 s 장벽 예산이 3 s 장벽 안에 있고 700 ms를 READY 몫으로 남긴다는 순서 행 둘(COMMIT 앞섬과
  값만 같음), 가드 시험에 집 옆의 같은 이름 사본과 다시 적은 arm 시간 객체를 거절하는 CHECK 5 행 둘(객체 행은 크기 후속이 지우고
  그 리뷰 반영이 스칼라 집과 짝지어 되살렸다).
- 부모에서 8 / 82 실패: parity 4(집이 아직 없음), 순서 2, 가드 2. 컨트롤러 출력만 읽는 parity 6행은 부모에서도 통과했다(보내는
  쪽 끝값과 받는 쪽 경계는 오늘도 맞음). `4c5ca5e9`에서 `protocol.test.ts`(81), `playlist.test.ts`(125), PRO 늦은 합류 고정
  넷(`playback-late-cohort-join.test.ts` 8, `authority-arm.test.ts` 77, `pro-late-prepare-reload.test.ts` 7,
  `pro-manual-zero-start.test.ts` 58)까지 438 / 438 통과. 늦은 합류의 40 ms (d) 행, 1.8 s (b) 행, Android (d) 행이 옮기기 전후 그대로다.

### 6A-4 C2-3 검증 복원 (SS-01, PA-13)

새 `src/youtube/iframe-audio.ts`(머리 `Resource owner: RO-12`)는 복원 원시만 갖는다. 상태, 자기 타이머, 로그가 없다.

- `writeYouTubeAudio`: `setVolume` 뒤 `mute` 또는 `unMute`. `isYouTubeAudioRestored`: 같은 음소거 상태, 이어 볼륨 차이 1 이하.
  NaN 볼륨은 맞지 않는다.
- `restoreYouTubeAudioVerified(cadence, canWrite, write, verify, onDone, schedule, canVerify = canWrite)`: 최대
  `YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS`번, `YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS` 간격(크기 후속 전에는
  `YOUTUBE_ARM_TIMING`의 두 속성), 첫 시도는 동기. 두 박자는 따로 남는다(Q3):
  `'settle-then-verify'`(쓰기, 기다림, 확인)와 `'verify-then-settle'`(쓰기와 확인, 그 뒤 기다림). 호출자의 울타리가 모든 쓰기 앞과
  settle-then-verify의 확인 앞에서 돈다. 던지는 쓰기는 그 시도의 확인을 건너뛰고, 던지는 확인은 복원 안 됨이다. 모든 기다림은
  호출자의 schedule로 간다. 그래서 타이머 키·슬롯과 그것을 지우는 곳이 호출자에 남는다.
- 여섯 루프가 박자, 울타리, 확인 술어, 결과, 타이머를 그대로 지킨다:
  - `zero-start.ts` 활성 복원(settle-then-verify): 쓰기와 확인마다 `#getPreparedPlayer` 울타리, `finiteOr`(NaN 볼륨을 복원으로 봄),
    `#markArmed` 또는 마지막 시도의 명령·읽기 오류를 실은 `#failLocalPrepare('audio-restore-timeout')`, 실행 타이머(`#later`).
    분리 복원(settle-then-verify): 세대와 같은 플레이어 울타리, 시도 수를 실은 `'audio-restore-complete'` debug 줄, `onError
'audio-restore-timeout'`, `#detachedAudioRestoreTimer`. 원하는 오디오가 바뀌면 여전히 취소한다.
  - `authority-arm.ts` 활성 복원(settle-then-verify): 쓰기마다 `#ensurePlayerCurrent`(확인 앞에는 없음, 오늘과 같음), 명령 오류는
    삼킴, `#markPrepared` 또는 `'audio-restore-timeout'`, `#later`. 분리 복원(verify-then-settle): 슬롯·세대·같은 플레이어 울타리,
    `#detachedRestoreTimers`. 원하는 오디오가 바뀌면 여전히 재지정한다. `#restoreCapturedAudio`, `#attemptAudioRestore`,
    `#attemptDetachedAudioRestore`와 복원의 attempt 필드가 없어졌다.
  - `player.ts`의 방장 레거시 복구와 게스트 로컬 대체의 검증 정리(verify-then-settle): 세대 울타리, 시도마다 pause와 seek 다시 냄,
    관리 타이머 `'yt-zero-start-host-fallback'`(`scheduleHostFallback`)과 `'yt-zero-start-external-fallback'`을 전처럼 `player.ts`가
    걸고 지운다(`/debug` 타이머 이름 동결, `cancelYtAutoSync`와 `clearAllManagedTimers`가 지우는 키 그대로). `restoreFallbackAudio`와
    `isFallbackAudioRestored`가 없어지고, 두 복구의 해제 앞 복원은 자기 50 ms 폴로 공용 쓰기·확인을 쓴다. 게스트 대체의 해제 쓰기와
    두 복구가 교체·취소된 iframe을 정리하는 쓰기(`cleanupExactPlayer`)도 `writeYouTubeAudio`로 쓴다.
- 호출 모양: 첫 코드 커밋 `5e3edd0c`은 옵션 객체였다. 다음 커밋 `0ec9e8e0`이 같은 복원을 위치 매개변수와 결과 콜백 하나
  (`onDone(restored, attempts)`)로 바꿨다. 이유는 크기다(아래 '번들 크기': `5e3edd0c`은 부모 대비 eager JS gzip +146 B, `0ec9e8e0` 뒤
  6A-4 전체는 −18 B). `0cd720fc`은 주석과 레지스트리 문장만 고쳐 빌드가 바이트로 같다(QA 라운드 2에서 진입 청크 이름과 크기가 같음).
- 가드·레지스트리·커버리지: CHECK 11 44 → 32(`zero-start.ts` 12 → 6, `authority-arm.ts` 10 → 4, `player.ts` 17 → 14, 새
  `iframe-audio.ts` 3, `iframe.ts` 3과 `retained-player-controller.ts` 2 그대로). `iframe-audio.ts`가 RO-02/RO-03/RO-12 시간 계약 파일에
  들고 자기 시간 상수는 없다(CHECK 5 그대로). 레지스트리 RO-12의 현재 주인, 목표 주인, 생명주기, 기한 주인(최대 8번 120 ms 간격,
  호출자 타이머로), 시간 집, 상태(여전히 `duplicated`: 원하는 상태와 hold는 뒤 열차의 C2-2), 가드 항목 11.
  `vitest.critical.config.ts`에 `iframe-audio.test.ts`와 `iframe-audio.ts`를 넣고 파일 문턱 99 / 99 / 99 / 99를 두었다.
- 시험(테스트 먼저 `e1a1a4d3`): 새 `iframe-audio.test.ts`(node 환경)가 쓰기, 확인, 루프의 두 박자와 단계 순서·시각, 8회 상한, 동기
  첫 시도, 울타리, 던지는 쓰기와 확인, 시도 수, 120 ms 기다림만 schedule에 묻는 것, 상태를 나누지 않는 겹친 두 루프를 고정한다.
  가드 `--report` 행이 `player.ts`의 `restoreFallbackAudio` 대신 `iframe-audio.ts`의 `writeYouTubeAudio`를 기대한다.
- 부모에서: 가드 1 / 67 실패, `iframe-audio.test.ts`는 모듈이 없어 불러오기 실패(27행이 모이지 않음). `5e3edd0c`에서 T0a 박자 표
  `youtube-audio-restore-cadence.test.ts`(51), PRO READY 시각 골든(10), 인용 로그 줄(13), `zero-start.test.ts`(155),
  `authority-arm.test.ts`(77), `player.test.ts`(134), `iframe-audio.test.ts`(27), 가드(67)까지 534 / 534 통과.

### 열차 리뷰 반영

중립성, 소유권·가드, 오디오 동작의 세 갈래로 리뷰했고, 그 반영은 시험만 커밋 넷, CHECK 12의 테스트 먼저와 가드 커밋, 주석·레지스트리
커밋이다. 런타임 동작은 바꾸지 않았다.

- `a35e07b9`(시험만): 두 활성 복원의 재지정, 확인 울타리, 정착 재-seek를 고정한다. `zero-start.test.ts`: WebKit이 첫 unMute를 무시하는
  게스트 활성 복원 60 ms에 볼륨을 바꾸면 +120 ms 시도가 `setVolume(55)`를 쓰고 +240 ms ARMED가 볼륨 55를 싣는다. 첫 쓰기 60 ms 뒤
  iframe이 교체되거나 영상이 바뀌면 +120 ms에 ARMED 없이 실패하고 어느 iframe에도 다시 쓰지 않는다. seek가 닿지 않는 게스트는 +820,
  +1300, +1780, +2260에 pause하고 80 ms 뒤 seek한다(여섯째 폴마다). `authority-arm.test.ts`: 같은 볼륨 변경(READY +240 ms, 볼륨 55),
  마지막 복원 기다림 안의 iframe 변경은 취소가 아니라 `'audio-restore-timeout'`으로 끝나고 어느 iframe에도 쓰지 않음, seek가 닿지
  않는 arm은 같은 네 시각에 pause·seek하고 2.3 s 예산에서 `'settle-timeout'`, 재시도 전에 iframe이 바뀐 분리 복원은 거기서 끝나
  `cancelAll()`이 거둘 것이 없고 iframe이 돌아오면 다음 준비가 그 iframe 자신의 볼륨을 잡는다.
- `95b03762`(시험만): 가짜 플레이어에 손잡이 `__unMuteThrowCount`(받아들인 unMute가 효과를 낸 뒤 던짐, 기본 꺼짐)를 더하고 T0a 박자 표에
  'unMute throws x1'을 더해 일곱 루프마다 행을 둔다: zero-start와 arm의 활성·분리 복원은 자기 쓰기에서 오류를 잡고 그 시도를 확인해
  첫 확인에 복원, 두 정리는 그 시도의 확인을 건너뛰고 120 ms 뒤 다시 씀, 게스트 해제 앞 복원은 50 ms 뒤 다시 폴. 기존 행과 배열은
  바뀌지 않았다.
- `21f1836a`(시험만): `player.test.ts`에 Standard 방장의 음수 시작 출시(`'yt-host-local-start'`)가 40 ms 늦으면 seek 없이 잡은 위치에서
  재생하고 늦음을 적용 오프셋(−9.789)과 자동 오프셋(0.21)에 넣으며, 41 ms 늦으면 먼저 0.041로 seek하고 둘을 지킨다(−9.749, 0.25)는
  행 둘. 초 단위 늦음과 ms 단위 허용치를 비교하는 실수(6A-3이 피해야 했던 것)를 잡는다. owner-queries에 follow-up realign만 남은
  동안 native PLAY(:213)와 PAUSE(:496)가 곧바로 결정된다는 행 둘(`sync.ts`의 등록 질의가 follow-up을 빼는 것).
- `cd35aed8` → `4a1a7e89`(테스트 먼저, 가드만): CHECK 12가 남의 시작 타이머 읽기·지우기를 호출마다 한 번이 아니라 그 호출이 가질 수
  있는 시작 타이머 이름마다 센다. 6A-1이 넛지 읽기의 이름 목록에서 지운 여섯 이름을 되넣으면 이제 'RATCHET REGRESSION ...
  native-control-authority.ts has 7, baseline 1'이다. 기준치는 그대로다(이 트리의 센 호출은 모두 이름 하나).
- `5a3d356b`(주석·레지스트리만): CHECK 11의 이유 글과 RO-12 문장이 `writeYouTubeAudio`의 모든 호출자를 적고, RO-02 기한 주인, RO-03
  시간 집, 가드 항목 12(`src/youtube/` 타이머 호출 205)를 6A-4에 맞췄다. `sync.ts`의 두 목록이 서로를 가리키고,
  `stale-async-guards.test.ts`의 한 주석이 6A-2가 지운 줄을 더 인용하지 않는다. 빌드는 바이트로 같다.
- `b80485f3`(시험만): `fake-yt-player.test.ts`가 새 손잡이를 고정한다(무시된 unMute는 던지지도 세지도 않음).
- 근거: 이 넷의 새 행은 모두 부모(6A 런타임)에서 통과하고, 6A 앞 런타임에서도 통과한다. 임시 worktree에서 `b80485f3`의 시험 위에
  `599465dd`의 런타임 13 파일을 되돌리고(`authority-arm.test.ts`가 가져오는 집 한 줄만 6A 앞 사본이 들던 리터럴 40과 1,800으로 바꿈)
  돌린 결과: `zero-start.test.ts` 159 / 159, `authority-arm.test.ts` 82 / 82, 박자 표 58 / 58, `player.test.ts` 136 / 136,
  `fake-yt-player.test.ts` 12 / 12, owner-queries 48 / 49, owner-ports 2 / 10. 실패 아홉은 모두 6A-1의 소유자 질의를 요구하는 6A-1
  테스트 먼저 행이다. 그래서 이 행들은 6A가 바꾸지 않은 오늘 동작을 고정한다.

### 크기 후속: 시작 시간 집을 낱개 이름으로 (6A-3, Q29)

'오너에게' 1의 권장안 (가)다. 6A-3의 두 묶음 집을 값마다 이름 붙인 export로 바꿨다. minifier는 객체의 속성 이름을 남기므로, 묶음은
읽는 곳마다 긴 속성 이름을 처음 받는 코드에 실었다. 값, 읽는 곳, 시각, 와이어, 로그 줄, 화면, 소리는 그대로다. 계획의 공용 상태
이름(`YOUTUBE_PLAYER_STATE`)은 '오너에게' 2의 (가)대로 싣지 않았다.

- `constants.ts`: `YOUTUBE_ARM_TIMING`이 `YOUTUBE_ARM_HARD_MUTE_POLL_MS`(30), `YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS`(12),
  `YOUTUBE_ARM_WARM_PLAY_MS`(260), `YOUTUBE_ARM_PAUSE_SEEK_GAP_MS`(80), `YOUTUBE_ARM_SETTLE_POLL_MS`(80),
  `YOUTUBE_ARM_SETTLE_EPSILON_SEC`(0.12), `YOUTUBE_ARM_SETTLE_STABLE_SAMPLES`(2), `YOUTUBE_ARM_SETTLE_RESEEK_EVERY`(6),
  `YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS`(120), `YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS`(8), `YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS`(1,800),
  `YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_MS`(40)가 되고, 기존 `YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC`는 그 40 / 1,000이다.
  `STANDARD_ZERO_START_BARRIER`는 `STANDARD_ZERO_START_GUEST_TOTAL_WAIT_MS`(3,000), `STANDARD_ZERO_START_GUEST_DECISION_MS`(2,300),
  `STANDARD_ZERO_START_COMMIT_LEAD_MS`(700, COMMIT 뒤 시작 앞섬), `STANDARD_ZERO_START_PREPARE_BUDGET_MS`(10,000),
  `STANDARD_ZERO_START_LATE_FALLBACK_LEAD_MS`(800)가 된다. 가드와 레지스트리가 읽는 나머지 이름(CHECK 5 계약 파일 목록,
  `PRO_YOUTUBE_BARRIERED_PREPARE_TIMEOUT_MS`, `PRO_YOUTUBE_UNBARRIERED_PREPARE_TIMEOUT_MS`, `YOUTUBE_FRESH_START_MAX_SEC`,
  `YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC`)은 그대로다.
- 읽는 다섯 파일(`zero-start.ts`, `authority-arm.ts`, `player.ts`, `iframe-audio.ts`, `playback-controller.ts`)이 그 이름을 읽는다.
  7.7 s는 여전히 준비 예산 − 게스트 결정이다. 타이머 호출과 iframe 오디오 쓰기 줄은 바뀌지 않았다.
- 시험: 늦은 합류 네 묶음(`authority-arm.test.ts`, `playback-late-cohort-join.test.ts`, `pro-late-prepare-reload.test.ts`,
  `pro-manual-zero-start.test.ts`)은 같은 지역 이름으로 낱개 export를 읽는다(단언 그대로). parity 묶음은 객체를 읽던 세 행을 지우고
  테스트 먼저 커밋의 낱개 이름 세 행(행 이름은 지운 셋과 같고 describe 이름만 다름)을 남기며, PREPARE 끝값 행이 낱개 이름을 읽는다. 가드 시험은 다시 적은 객체를
  집 객체와 짝짓던 행을 지운다(집이 더 객체가 아님, 아래 '크기 후속 리뷰'가 스칼라 집과 짝짓는 행으로 되살림). T0a 골든과 고정 행은
  바뀌지 않았다.
- 레지스트리 RO-02, RO-03, RO-12의 시간 집 문장, RO-03 'Anchor tests'의 한 줄, 늦은 합류 도우미 주석이 낱개 이름을 적는다.
- 가드: CHECK 5는 복사 1, 의심 1, 보고만 하는 같은 값 쌍 45 그대로다(새 이름 가운데 다른 계약 파일의 시간 스칼라와 값이 같은 것이
  없음). CHECK 11(32)과 CHECK 12(읽기 11, 지우기 9)도 그대로다. 이 커밋의 한계: CHECK 5는 시간 객체를 객체끼리만 견주므로 스칼라
  집 옆에 다시 적은 객체 하나를 잡지 못했다(두 시작 파일이 같은 객체를 다시 적으면 잡음). 같은 이름 사본은 시간 이름(`_MS` 등)만
  보므로 `*_MAX_ATTEMPTS`, `*_SEC`, `*_SAMPLES`, `*_EVERY` 사본도 보지 않았다. 아래 '크기 후속 리뷰'의 가드 커밋이 둘 다 다시 잡는다.
- 시험(테스트 먼저 `12367317`): parity에 낱개 이름 세 행(값, 7.7 s, 0.04 double), 가드에 집 옆의 같은 이름 arm 사본을 거절하는 행과
  두 시작 파일이 같은 arm 객체를 다시 적으면 거절하는 행(부모에서도 통과). 부모(`a883f9b9` 런타임)에서 4 / 83 실패(parity 3은 이름이
  없어 undefined, 가드 1은 짝지을 스칼라 집이 없음), 나머지 79행 통과. `08135e4f`에서 그 두 파일과 코드 커밋이 고친 시험 네 파일
  234 / 234 통과.
- 크기(아래 '번들 크기'): 부모 대비 eager JS gzip −386 B, 바탕 대비 −149 B.

### 크기 후속 리뷰: CHECK 5가 스칼라 집 옆 사본을 다시 잡음 (가드 항목 5)

크기 후속의 리뷰가 찾은 '낮음' 하나다. 집이 낱개 이름이 되면서 CHECK 5가 6A-3의 객체 집 옆에서 잡던 사본 둘(위 '크기 후속'의
한계)을 놓쳤다. 가드만 고쳤고 런타임은 그대로다(`a9b670fa..0f28e66d`의 런타임 경로는 모든 Worker에서 0).

- `scripts/check-resource-ownership.mts`: 시간 계약이 '스칼라 집'(값마다 이름 붙인 export를 두는 파일)을 적을 수 있고,
  RO-02/RO-03/RO-12 계약이 `src/youtube/constants.ts`를 적는다. 그 계약에서 (1) 집의 모든 숫자 스칼라와, 다른 계약 파일에서 그와
  이름이 같은 숫자 스칼라가 접미사와 상관없이 같은 이름 검사에 든다(`*_MAX_ATTEMPTS`, `*_SEC`, `*_SAMPLES`, `*_EVERY` 사본도 복사).
  이 이름들은 이름으로만 짝지으므로 보고만 하는 같은 값 목록은 늘지 않는다. (2) 집의 스칼라를 한 객체
  (`<scalars>@src/youtube/constants.ts`)로 다른 계약 파일의 시간 객체와 견주므로, 그 값 다섯 이상을 나누는 다시 적은 arm 객체가
  다시 복사다. 머리 주석, `TIMING_PAIR_BASELINE` 주석, 레지스트리의 가드 항목 5가 그렇게 적는다. 계약 파일 목록은 그대로다.
- 기준치는 그대로다: 이 트리에서 CHECK 5는 복사 1, 의심 1, 같은 값 쌍 45이고, `--report` 108줄이 부모 가드의 출력과 같다.
- 여전히 잡지 않는 것: 이름이 다른 사본(시간 이름이면 보고만, 아니면 보지 않음), 값 넷 이하를 나누는 객체, 집이 계약에 없는 파일의
  사본. `src/pro-room/playback-controller.ts`는 RO-03 PRO 재생 계약(`cloudflare/pro-room-playback-timing.ts`와 짝)에 있고 그 계약에
  `constants.ts`가 없어, 거기 다시 적은 40 ms `YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_MS`는 바탕에서도 지금도 잡지 않는다(이 브랜치
  밖의 옛 틈이고, 계약 파일 목록은 바꾸지 않았다).
- 시험(테스트 먼저 `fcb21ae6`): 가드 시험에 행 셋. 집 옆 `player.ts`에 다시 적은 arm 시간 객체를
  `<scalars>@src/youtube/constants.ts`와 짝지어 거절(크기 후속이 지운 6A-3 행과 같은 이름), `player.ts`의 같은 이름 사본
  일곱(`YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS`, `YOUTUBE_ARM_SETTLE_EPSILON_SEC`, `YOUTUBE_ARM_SETTLE_STABLE_SAMPLES`,
  `YOUTUBE_ARM_SETTLE_RESEEK_EVERY`, `YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS`, `YOUTUBE_RELEASE_CATCH_UP_TOLERANCE_SEC`,
  `YOUTUBE_FRESH_START_MAX_SEC`)을 거절, 집의 횟수와 값만 같은 다른 이름의 시간(`RESEEK_GAP_MS` 6, `YOUTUBE_ARM_SETTLE_RESEEK_EVERY`와
  같은 값)은 같은 값 목록을 늘리지 않음(부모에서도 통과). 부모(`a9b670fa` 가드)에서 72행 가운데 2 실패(앞의 두 행), 70 통과.
  `0f28e66d`에서 72 / 72.

### R4-Q3 주석: PRO 재생목록 슬롯 요약의 낡은 'Opt-in summary' (Phase 5.5 R4가 넘긴 것)

Phase 5.5 R4(PRO 방 Worker만)는 오너 질문 R4-Q3에서 `src/pro-room/snapshot.ts`의 `parsePlaylistSlots` 문서 주석 'Opt-in summary'를
고치는 일을 다음 App 업데이트로 넘겼다(권장 (가), App 파일이라 `pro-room` 부분 릴리스가 거절함). 9.0.27, 9.0.28, 9.0.29는 그 주석 없이
나갔고, 9.0.29 배포 기록이 이 일을 6A로 옮겼다(release-record R4 절). 그 요약은 9.0.25부터 App이 `X-MXQR-Pro-Playlist-Slots` 머리글을
보내지 않고, PRO Worker가 모든 스냅샷에 `playlistSlots`를 싣고(`cloudflare/pro-room-worker.ts`의 스냅샷 만들기), App은 그것이 없는
스냅샷을 받지 않으므로 더는 opt-in이 아니다. 주석을 '모든 스냅샷이 opt-in 머리글 없이 싣는 요약'으로 고쳤다(두 줄이 세 줄).

- 이 열차에 싣는 근거: 주석만 바뀐다. 그 커밋 앞뒤로 운영 빌드(`npm run build`)의 `dist/` 940 파일이 sha256으로 모두 같았고(QA
  라운드 7의 머리 `3be18bdb`와 주석을 고친 트리), 그 파일은 App 경로뿐이라(`runtimePathsForWorker`, PRO room 0) target `app`이
  그대로다. 버전 올리기 앞이라 `guard:sw-cache-version`의 규칙(버전 올리기가 마지막 런타임 커밋)과 맞는다. 단위 시험은 이 주석을
  읽지 않는다. prettier와 eslint가 그 파일에서 통과했다. 버전 올리기 뒤 전체 검사(QA 라운드 8)가 이 커밋을 포함해 다시 본다.
- 테스트 먼저 커밋은 없다(동작 없는 주석).

## 계획과 달라진 것

1. **줄 번호:** 계획 인용은 옛 SHA 기준이라 모든 위치를 기호로 다시 찾았다.
2. **6A-3 (가) 상태 열거를 싣지 않음:** `YOUTUBE_PLAYER_STATE`가 없다. `zero-start.ts`의 `YOUTUBE_ZERO_START_PLAYER_STATE`와
   `authority-arm.ts`의 `PLAYER_STATE`가 비공개로 남고, `player.ts`의 플레이어 상태 읽기도 숫자 그대로다. 커밋에 이유가 적혀 있지 않다.
   이 브랜치를 만드는 동안 6A-3 코드 커밋(`4c5ca5e9`) 위에 (가)를 얹은 커밋하지 않은 빌드는 eager JS gzip 466,786 B로 그 커밋보다
   +50 B였다. 이 검사는 그 측정을 다시 하지 않았다(그 실험 패치는 6A-4 뒤의 `authority-arm.ts`와 충돌). 그 값은 객체 집 위에서 잰
   것이고, 낱개 이름 집(크기 후속) 위에서는 재지 않았다. 동작과 와이어는 어느 쪽이든 같다(값 −1, 0, 1, 2, 3, 5). 계획의 Q4 대안 가운데
   '상태 열거를 각 파일 비공개 열거로 남김'과 같은 상태다. 이 브랜치는 '오너에게' 2의 권장안 (가)대로 싣지 않는다.
3. **6A-5(버전 올리기와 문서)는 늦게 더함:** 처음 브랜치의 범위는 런타임 증분이었고, 번호가 앱 글꼴 업데이트와의 순서에 달려 릴리스
   담당이 9.0.29 기록 위로 다시 옮긴 뒤 더했다(아래 '배포 조건과 순서' 3, 4, '기록과 레지스트리'). 계획에 없던 R4-Q3 주석(Phase 5.5
   R4가 다음 App 업데이트로 넘긴 `src/pro-room/snapshot.ts`의 낡은 문서 주석)도 그때 실었다.
4. **6A-2의 `'yt-seek-play'` 줄:** 계획은 `resetResidentYouTubeSync`의 겹친 두 줄을 지우게 했다. `'yt-seek-play'` 줄은 남겼다:
   `stale-async-guards.test.ts`의 YouTube → YouTube 재사용 회귀 행이 `sync.ts`와 `core/timers`를 mock하고 그 지우기를 단언한다. 그래서
   CHECK 12 지우기는 10 → 8이 아니라 10 → 9다.
5. **6A-4 호출 모양:** 옵션 객체 꼴이 부모 대비 +146 B여서 같은 동작을 위치 매개변수로 다시 썼다(위 6A-4).
6. **CHECK 12의 셈:** T1의 CHECK 12는 호출 하나를 이름이 몇이든 한 번 셌다. 그래서 6A-1이 지운 여섯 이름을 넛지 읽기의 이름 목록에
   되넣어도 수가 그대로였다(래칫이 6A-1을 지키지 못함). 리뷰 반영에서 이름마다 세도록 바꿨다. 같은 셈으로 바탕은 읽기 20(목록의 일곱이
   7), 지우기 10이다(QA 라운드 2에서 이 가드를 바탕 트리에 돌려 확인: `native-control-authority.ts` 7, `iframe.ts` 3, `sync.ts` 4). 주석과
   레지스트리의 호출 수(14와 10, 뒤 11과 9)는 그 설명과 함께 남겼다.
7. **핵심 커버리지 문턱:** 계획은 `iframe-audio.ts`와 그 시험을 넣으라고만 적었다. 파일 문턱을 99로 두었다.
8. **6A-3 집 모양:** `4c5ca5e9`의 객체 두 개(`YOUTUBE_ARM_TIMING`, `STANDARD_ZERO_START_BARRIER`)를 크기 때문에 값마다 이름 붙인
   export로 바꿨다(위 '크기 후속', '오너에게' 1의 권장안 (가)). 값과 읽는 곳은 그대로다. CHECK 5는 그 스칼라 집을 따로 본다(위
   '크기 후속 리뷰').

## 정확한 개수 가드

| 가드                                           | 바탕 `599465dd`                                                                                                 | `b80485f3`                                                                                                                         | 크기 후속 `08135e4f`                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| CHECK 11 iframe 오디오 쓰기(RO-12)             | 44: `zero-start.ts` 12, `authority-arm.ts` 10, `player.ts` 17, `iframe.ts` 3, `retained-player-controller.ts` 2 | 32: `zero-start.ts` 6, `authority-arm.ts` 4, `player.ts` 14, `iframe-audio.ts` 3, `iframe.ts` 3, `retained-player-controller.ts` 2 | 32, 파일마다 같음                           |
| CHECK 12 남의 시작 타이머 읽기(RO-02, 호출 수) | 14                                                                                                              | 11, 모두 PRO 넛지(`iframe.ts` 1, `local-offset.ts` 2, `native-control-authority.ts` 1, `player.ts` 4, `sync.ts` 3)                 | 11, 같음                                    |
| 같은 읽기, 이름마다(`4a1a7e89`부터의 셈)       | 20(`native-control-authority.ts` 7)                                                                             | 11                                                                                                                                 | 11                                          |
| CHECK 12 남의 시작 타이머 지우기               | 10: `iframe.ts` 3, `player.ts` 6, `sync.ts` 1                                                                   | 9: `iframe.ts` 2, `player.ts` 6, `sync.ts` 1                                                                                       | 9, 같음                                     |
| CHECK 5 복사 / 의심 / 같은 값 쌍(보고만)       | 2 / 1 / 27                                                                                                      | 1 / 1 / 45                                                                                                                         | 1 / 1 / 45, 쌍 목록도 같음                  |
| resource-ownership                             | 49 records, 450 production files                                                                                | 49 records, 451 production files                                                                                                   | 49 records, 451 production files            |
| `src/youtube/` 타이머 호출(가드 항목 12)       | 210                                                                                                             | 205                                                                                                                                | 205(타이머 호출 줄 바뀜 없음)               |
| dead-exports                                   | 403 prod files, 2,114 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76                                    | 404, 2,124, 0, 20, 76                                                                                                              | 404, 2,139(객체 둘 대신 이름 17), 0, 20, 76 |
| import-graph                                   | 403 files, 2,087 edges, 순환 0                                                                                  | 404 files, 2,098 edges, 순환 0                                                                                                     | 404 files, 2,098 edges, 순환 0              |

room-authority(직접 읽기 79, 구독 22, 쓰기 13, PRO 읽기 0, 스냅샷 읽기 0, 404 files), bus-pairing 202 / 202, source-complexity(YouTube
파일은 목록에 없음)는 바뀐 기준치가 없다. 내린 기준치는 모두 센 코드를 옮긴 커밋에서 레지스트리 기록과 함께 내렸고, 올린 기준치는 없다.
크기 후속 리뷰의 가드 커밋(`0f28e66d`)은 CHECK 5가 보는 사본을 넓혔지만 이 트리의 수(1 / 1 / 45)와 `--report` 출력은 크기 후속 열
그대로다. main `9e68a7a3` 위로 옮긴 머리(`77c34a25`)에서도 resource-ownership은 49 records, 451 production files, CHECK 5 1 / 1 / 45,
CHECK 11 32, CHECK 12 읽기 11과 지우기 9로 같고, import-graph도 404 files, 2,098 edges, 순환 0으로 같다. dead-exports는 404 / 2,142 / 0
/ 20 / 76이다(바인딩 +3은 옮기며 지난 #545가 `pro-system-audio-sfu.ts`에 더한 보류 export 셋, 기준치 그대로, QA 라운드 6).

## 번들 크기

같은 툴체인(Node 24.22.2, vite 8.3.3)으로 커밋마다 `npm run build`를 하고 `scripts/check-initial-transfer-budget.mts`의 측정을 바이트로
읽었다(QA 라운드 2). 시험만, 가드만, 문서만 커밋은 빌드가 바로 앞 코드 커밋과 같다. 크기 후속에서는 바탕, `a883f9b9`, `08135e4f`를
다시 빌드해 같은 측정(`measureInitialTransfer`)으로 쟀다(QA 라운드 3). 바탕과 `a883f9b9`는 진입 청크 이름과 모든 값이 라운드 2와
같았다.

| 커밋                    | 진입 청크          | 진입 raw / gzip   | eager JS gzip (부모 대비) | eager total raw / gzip (부모 대비) |
| ----------------------- | ------------------ | ----------------- | ------------------------- | ---------------------------------- |
| 바탕 `599465dd`         | `main-BYFZlrrn.js` | 862,203 / 253,778 | 466,481                   | 2,059,004 / 545,725                |
| 6A-1 `faffa69b`         | `main-DqVfbBh5.js` | 862,353 / 253,814 | 466,521 (+40)             | 2,059,154 / 545,766 (+41)          |
| 6A-2 `d34b4478`         | `main-Bbwvxc8m.js` | 862,311 / 253,796 | 466,499 (−22)             | 2,059,112 / 545,741 (−25)          |
| 6A-3 `4c5ca5e9`         | `main-BSUmIIIe.js` | 862,106 / 253,742 | 466,736 (+237)            | 2,059,416 / 545,979 (+238)         |
| 6A-4 `5e3edd0c`         | `main-D3DxfJRk.js` | 861,653 / 253,879 | 466,882 (+146)            | 2,058,963 / 546,125 (+146)         |
| 6A-4 `0ec9e8e0`         | `main-DneD15-T.js` | 861,118 / 253,718 | 466,718 (−164)            | 2,058,428 / 545,959 (−166)         |
| `0cd720fc` ~ `12367317` | `main-DneD15-T.js` | 861,118 / 253,718 | 466,718 (0)               | 2,058,428 / 545,959 (0)            |
| 크기 후속 `08135e4f`    | `main-C-K1wcbh.js` | 860,403 / 253,552 | 466,332 (−386)            | 2,057,356 / 545,573 (−386)         |
| `a9b670fa` ~ 브랜치 끝  | `main-C-K1wcbh.js` | 860,403 / 253,552 | 466,332 (0)               | 2,057,356 / 545,573 (0)            |

- 증분별(부모 대비 eager JS gzip): 6A-1 +40, 6A-2 −22, 6A-3 +237, 6A-4 −18(두 코드 커밋 합), 크기 후속 −386. 모두 증분 상한
  +300 B 안이다.
- **Phase 순증은 이제 −149 B로 상한 +200 B 안이다**(처음 바탕 위에서 잰 증분 차의 합 = 마지막 − 바탕, 그때 사이에 낀 Phase 6 밖
  열차 없음. 옮긴 뒤는 아래 마지막 항목). 크기 후속 전에는
  +237 B로 상한을 넘었다. eager total gzip은 −152 B(후속 전 +234 B), 진입 청크는 raw −1,800 B, gzip −226 B다. KiB로는 eager JS
  455.5 → 455.4 KiB, eager total 532.9 → 532.8 KiB gzip이고 `guard:initial-transfer-budget`을 통과한다. 처음 받는 양이 늘지 않으므로
  계획 §4.2-6과 Q29의 멈춤 조건은 더 해당하지 않는다(아래 '오너에게' 1).
- 후속 전 순증의 주된 원인은 6A-3의 객체 모양 집이었다(객체의 속성 이름은 minifier가 남긴다). 같은 바꿈을 크기만 잰 실험(커밋하지
  않음, 시험 없음)은 eager JS gzip 466,329 B, eager total gzip 545,573 B, 진입 raw 860,403 B였다. 커밋한 `08135e4f`는 eager JS가 3 B
  크고(466,332 B) 나머지 둘은 같다.
- 크기 후속 리뷰의 두 커밋(`fcb21ae6`, `0f28e66d`)은 가드 스크립트, 그 시험, 레지스트리만 바꾼다. `0f28e66d` 트리를 다시 빌드해
  쟀더니 진입 청크(`main-C-K1wcbh.js`)와 모든 값이 `08135e4f`와 같았다(QA 라운드 4).
- 마지막 검사(QA 라운드 5)는 바탕 `599465dd`(이 worktree를 잠시 detached로 바꿔 빌드한 뒤 갈래로 되돌림)와 브랜치 끝(`build:checked`의
  `npm run build` 단계)을 다시 빌드해 같은 측정으로 쟀다. 바탕은 `main-BYFZlrrn.js` 862,203 / 253,778, eager JS gzip 466,481, eager total
  2,059,004 / 545,725, 브랜치 끝은 `main-C-K1wcbh.js` 860,403 / 253,552, 466,332, 2,057,356 / 545,573으로 위 표와 같다(순증 eager JS
  gzip −149 B, eager total gzip −152 B).
- 옮긴 뒤(QA 라운드 6): 바탕 `9e68a7a3`(이 worktree를 잠시 detached로 바꿔 빌드한 뒤 갈래로 되돌림)과 머리 `77c34a25`를 같은
  툴체인으로 다시 빌드해 같은 측정으로 쟀다. 바탕은 `main-DL5HBqTb.js` 862,523 / 253,904, eager JS gzip 466,608, eager total
  2,059,730 / 545,905(진입 청크가 9.0.28 운영과 같음), 머리는 `main-MqxN8195.js` 860,735 / 253,706, 466,494, 2,058,094 / 545,791이다
  (머리는 두 번 빌드해 같음). 차는 eager JS gzip −114 B, eager total gzip −114 B, 진입 raw −1,788 B, gzip −198 B로 처음 바탕에서 잰
  −149 B, −152 B와 조금 다르다. 6A의 diff는 옮기기 전과 같으므로, 옮기며 바뀐 바탕(#545의 App 런타임과 버전 문자열)과 함께
  압축되는 차이로 본다[추론]. 계획의 Phase 순증 정의(증분 차의 합, 사이에 낀 Phase 6 밖 열차 9.0.28은 뺌)로는 −149 B 그대로이고, 어느 쪽이든 처음
  받는 양이 바탕보다 작아 상한 +200 B와 Q29의 멈춤 조건에 해당하지 않는다. `guard:initial-transfer-budget`은 eager JS 455.6 KiB, eager
  total 533.0 KiB gzip으로 통과했다(바탕은 455.7 KiB, 533.1 KiB).
- 다시 옮긴 뒤(QA 라운드 7): 바탕은 App 9.0.29 `c4667abc`(따로 만든 detached worktree, `e51dd292`의 런타임과 같음), 머리는
  `3be18bdb`를 같은 툴체인으로 빌드해 같은 측정으로 쟀다. 바탕은 `main-L7A6LLee.js` 862,602 / 253,954, eager JS gzip 465,602, eager
  total 2,050,014 / 543,792(진입 청크가 9.0.29 운영과 같음), 머리는 `main-CHcXz9Kr.js` 860,802 / 253,720, 465,448, 2,048,366 /
  543,640이다. 차는 eager JS gzip −154 B, eager total gzip −152 B, 진입 raw −1,800 B, gzip −234 B로, 바탕이 9.0.29의 글꼴 전환을
  담은 뒤에도 처음 받는 양이 바탕보다 작다. 9.0.29는 Phase 6 밖 열차라 Phase 순증(증분 차의 합)은 −149 B 그대로다.

## 혼합 버전

| 조합                                                           | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 바닥 795 이상 옛 App 방장과 6A 게스트, 6A 방장과 옛 App 게스트 | 같은 프레임을 같은 시각에 보낸다. 와이어(`src/network/protocol.ts`, `src/types/index.ts`, `src/core/constants.ts`, `cloudflare/`)가 바탕과 바이트로 같고(`git diff --stat 599465dd..b80485f3`와 `599465dd..08135e4f`, 옮긴 뒤 `9e68a7a3..77c34a25` 비어 있음), H3는 진리표 그대로라 하트비트와 보조 `YOUTUBE_STATE` 시점이 같으며, C2-3은 두 박자를 지켜 ARMED 시점이 같고, C2-1은 숫자 그대로다. 근거는 기기 혼합 행이 아니라 T0a의 Standard 와이어·시각 골든과 H3 진리표가 바이트 그대로 통과한 것이다(Phase 5의 P5-D9 C 선례) |
| PRO 방의 옛·새 기기                                            | PREPARE와 COMMIT은 서버를 거치고 서버는 바뀌지 않는다. arm 활성 복원(2.3 s 준비 예산 안)과 분리 복원이 검증 복원을 쓰지만 T0a PRO READY 시각 골든이 그대로라 READY 시각, 곧 시작 시각이 같다. 박자를 합치는 것은 Q3의 대안이고 동작 변경이라 하지 않았다                                                                                                                                                                                                                                                                         |
| 바닥 795 아래의 열린 세션                                      | 바닥은 열린 세션을 닫지 않는다. 6A는 프레임을 얼려 그 위험을 더하거나 줄이지 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                              |

결과가 다르더라도 '방이 zero-start 대신 레거시로 시작' 같은 품질 저하이고 재생이 멈추지는 않는다고 본다(계획 §5, 추론).

## 되돌리기

기본은 더 높은 SemVer·epoch의 앞으로 고치기다. 새 되돌리기 경계는 없다: 계약 표지, D1, 저장 모양, 바닥을 바꾸지 않아 forward floor가
생기지 않는다.

- **실패 자동 복구:** target `app`의 실패 복구는 릴리스 안에서 checkpoint의 App(dispatch 때의 운영 App)으로 간다. 오너가 정한 순서대로
  글꼴 전환이 먼저 나갔으므로 9.0.29 / v802(빌드 802, App 버전 `f9c684cb`)다. 바닥 795 이상이라 `lower`가 필요 없다. 와이어가 같아 되돌린 App과 6A가 섞인 방도 같은 프레임을 같은 시각에 보낸다.
- **손 되돌리기:** 배포 뒤 checkpoint App(v802)으로 가는 손 되돌리기는 v803을 받은 클라이언트에 낮은 epoch를 돌려주므로,
  release-record §2 9.0.29 절의 열린 항목('낮은 epoch로 가는 App 손 되돌리기의 규칙', 결정 전)을 따른다. 결정이 날 때까지는
  `docs/hotfix-procedure.md`대로 급하지 않으면 6A만 빼는 9.0.31 / v804 이상의 코드 되돌리기가 기본이고, 급할 때만 명시적으로 검토한
  CLI 되돌리기로 checkpoint App(App 하나, `lower` 없음)으로 간다. 출처 없는 버전의 다음 수리 릴리스 판정도 그 절차대로다. 손 되돌리기도
  배포라 기록 PR과 이력 한 행을 낸다.
- **혼자 되돌릴 수 있는 기간:** 6B가 머지되기 전까지다. 6B 장부는 6A-1 소유자 질의와 6A-3 상수를, 6C-2는 6A-4의 `iframe-audio.ts`를,
  6D-1은 6A-3의 1,800 ms와 120 ms × 8을 쓴다(계획). 그 뒤에는 6A부터 가장 최근 열차까지 앞으로 되돌린다: 새 `agent/` 갈래에서 그
  열차들의 커밋을 거꾸로 되돌리고, 다음 SemVer·epoch(버전 거울 여섯과 `index.html`의 bootstrap 캐시 쿼리), 전체 게이트, App 릴리스,
  기록. 앞으로 되돌리기와 앞으로 고치기는 각각 업데이트 창 하나를 Q1의 넷 밖으로 더한다.
- **되돌릴 때 가드:** 6A 커밋들이 가드 기준치(CHECK 5, 11, 12)와 레지스트리를 같은 커밋에서 옮겼으므로 되돌리면 함께 돌아온다.
  `4a1a7e89`(이름마다 세는 CHECK 12, 옮긴 뒤 `3e80f168`)만 남기고 6A-1을 되돌리면 읽기가 이름마다 20이 되므로, 그 되돌리기가 기준치와 RO-02 기록을 함께
  올린다(`AGENTS.md` Resource ownership).

## 배포 조건과 순서 (릴리스 담당)

1. 오너에게: 1(첫 로딩 바이트)은 권장안 (가)를 이 갈래에 실었다(크기 후속, 처음 받는 양이 바탕보다 줄어 Q29의 멈춤 조건이 없음).
   2(상태 이름 정리)는 (가)대로 싣지 않았다. 오너가 2의 (나)를 고르면 그 증분을 테스트 먼저부터 이 갈래에 더하고 커밋마다 크기를
   다시 잰다. 3(배포 순서)은 오너가 답했다: 앱 글꼴 업데이트 먼저, 6A는 그 뒤(아래 2).
2. 순서와 위임, 한 번에 한 열차: 오너가 앱 글꼴 업데이트(화면이 바뀌고 업데이트 창이 뜨는 App 열차)를 먼저 내기로 정해(2026-10-31
   저녁) 그것이 9.0.29 / v802로 나갔고(#548, 23:39 KST), 6A는 그 배포 기록(#549) 뒤의 main `e51dd292` 위로 옮겨 테스트 먼저 커밋을 옮긴
   부모에서 다시 돌렸다(QA 라운드 7). 그래서 6A는 9.0.30 / v803이다. Phase 6 업데이트 열차는 오너가 깨어 있을 때만 낸다는 규칙은, 오너가
   2026-10-31 23:20 KST 무렵 약 40시간 자리를 비우며 릴리스와 시험을 맡긴(오너의 허락이 꼭 필요한 일만 묻기) 그 기간에는 이 위임이
   대신한다. 그래서 6A는 아래 자동 관문이 모두 통과하면 오너가 자리에 없어도 낸다. main 런타임이 배포본과 같을 때만 낸다(지금 main
   `e51dd292`는 운영 App 9.0.29 `c4667abc` 위에 문서만). main이 다시 움직이면 그 위로 다시 옮기고 같은 재확인과 크기 측정을 한다. 이
   배포까지 런타임 의존성 변경(Dependabot 포함)을 머지하지 않는다.
3. 버전 올리기 커밋(마지막 런타임 커밋): 9.0.29 / v802 → 9.0.30 / v803을 9.0.29의 버전 올리기와 같은 거울 여섯 파일 일곱 줄에 적는다:
   `package.json:3`, `package-lock.json:3`과 `:9`, `browser/classic-runtime/admin.ts`의 `ADMIN_SCRIPT_VERSION`, `cloudflare/app-worker.ts`의
   `ADMIN_ASSET_VERSION`, `scripts/service-worker-asset.ts`의 SW 캐시 epoch, `index.html`의 `/bootstrap.js?cache=` 쿼리. 그 뒤
   `guard:sw-cache-version` PASS, `guard:release-identity`가 새 버전, `build:checked` 전체 통과(QA 라운드 8). 계약 동결:
   `git diff --stat <바탕 main>..HEAD -- cloudflare/ src/network/protocol.ts src/core/constants.ts src/types/index.ts`가
   `cloudflare/app-worker.ts`의 버전 한 줄만 보인다(다시 옮긴 뒤 `e51dd292..3be18bdb`는 비어 있음).
4. 문서 증분(계획 6A-5): release-record §2의 이 열차 '배포 전' 항목(이 보고서 링크, 오너 답, 배포 조건, 되돌리기, 배포 뒤 확인, 열린
   항목)은 첫 옮김 뒤 기록 커밋이 더했다. 다시 옮긴 뒤 버전 올리기 앞에 더한 것: 그 항목의 순서·위임·번호와 Q6 문장, 9.0.22 항목의
   '2.3 s 준비 예산과 공유 시간 집의 순서 시험(Phase 0d C2-1)은 보지 않았다' 구절(순서 시험이 6A-3에서 생김), 'Android YouTube 출력
   정렬·혼합 버전' 항목의 혼합 버전 문장(Q21: 바닥 795를 근거로 닫고 출력 정렬 실측은 남김), 레지스트리 배포 묶음 문단에 Phase 6의
   App 업데이트 넷(Q1, 2026-10-30), R4 절의 R4-Q3 문장. 버전 올리기 뒤의 기록 커밋이 그 항목에 버전 올리기 SHA와 QA 라운드 8을 적는다.
   기기 근거 없이 열린 항목을 지우지 않는다.
5. PR CI, 자동 코드 리뷰, dispatch 직전 머지, exact-main CI success 뒤 Release target `app`, Developer API D1 false,
   `raise_app_build_floor` false.
6. 배포 직후(게이트 아님): 공개 최소 빌드 상태(저장·유효 795, live App 803)와 Operations Drift Audit, 그리고 아래 '배포 뒤 확인'.
   머지 뒤 main SHA에서 Full E2E를 한 번 돌려 이 보고서의 QA 라운드에 적되 exact-main 후보로 쓰지 않는다(계획 §4.2-5).
7. 배포 기록 PR: release-record §1과 `Last source review` 덮어쓰기, `docs/release-history.md` 한 행, §2의 이 항목을 '배포 뒤 확인'으로,
   §4에 이 릴리스 항목과 현재 경계 줄, 다른 항목의 다음 되돌리기 번호를 9.0.31 / v804로(9.0.29 기록의 선례), R4 절의 R4-Q3 문장을 닫음.

## 배포 뒤 확인 (블라인드, 게이트 아님)

계획 §4.5의 기기 후보다. 확인하는 사람에게는 '절차'만 주고 기준은 주지 않으며, 받은 관찰값을 여기 기준과 견준다. Phase 6 앞의
기준선(Q6)은 오너가 자리에 없어 재지 않았으므로(위 '오너 결정') 기준선과의 견줌은 없다. 오너가 뒤에 계획 §7 절차로 기준선을 재면 그
값은 그때의 운영(6A 뒤)의 것이라 6A 전후 비교가 아니다. 기기가 없는 단계는 건너뛰고 '기기 없음'으로 적는다.

**절차(확인하는 사람에게 주는 것):** 모든 기기에서 주소 끝에 `?mxqrLog=debug`를 붙여 연다. 새로 고치거나 다시 들어갈 때도 다시
붙인다. 각 단계 뒤 채팅에 `/debug console`을 입력하고 `[YouTube`와 `[PRO`로 시작하는 줄을 시각과 함께 복사한다. 모든 기기에서 앱
정보의 버전 번호를 적는다.

- **A. 일반방 예열 중 일시정지와 볼륨 0(약 35분):** (1) 데스크톱 Chrome을 방장으로 일반방을 만들고 iPhone Safari와 Android Chrome을
  게스트로 넣는다. 모든 기기의 볼륨을 50으로 두고 재생목록에 YouTube 두 곡을 넣는다. (2) 방장이 첫 곡을 누르고, 소리가 나기 전(1초 안)
  iPhone 게스트가 앱의 일시정지를 누르고 3초 뒤 재생을 누른다. 일시정지 동안 짧게 새는 소리가 있었는지, 재생 뒤 소리 크기(같음, 작음,
  큼, 없음)를 적는다. (3) (2)를 Android 게스트로 한 번 한다. (4) 방장이 다음 곡을 누르고 소리가 나기 전 iPhone 게스트가 볼륨을 0으로
  내렸다가 2초 뒤 50으로 올린다. 세 곡에 걸쳐 세 번 한다. (5) 방장을 iPhone Safari로 바꿔 (2)와 (4)를 방장 기기에서 한 번씩 한다.
  (6) Mac의 Safari를 방장이나 게스트로 넣어 (2)를 한 번 한다. (7) Android 게스트에 블루투스 이어폰을 연결하고 (2)를 한 번 한다.
- **B. PRO 준비 중 일시정지(약 10분):** 그 PRO 방의 모든 탭을 먼저 새로 고친다. iPhone과 Android를 같은 PRO 방에 넣고, 다른 기기가 다음
  YouTube 곡을 누른 뒤 소리가 나기 전 1초 안에 Android에서 이어폰 버튼(또는 알림의 미디어 컨트롤)으로 일시정지하고 5초 뒤 재생한다.
  모든 기기의 소리를 적고 `/debug sync`의 `youtube-release` 기록도 복사한다.
- **C. 시작 직후의 헤드셋·잠금 화면(H3, 약 25분):** (1) 데스크톱 Chrome 방장, 버튼 있는 이어폰을 낀 iPhone Safari 게스트. 방장이 곡
  중간에서 seek하고 2초 안에 게스트가 이어폰 버튼으로 일시정지, 5초 뒤 재생한다. (2) 방장이 수동 싱크 오프셋을 −5.000 s로 두고 곡을
  처음부터 시작하고, 게스트 소리가 나기 전 기다리는 동안 게스트가 잠금 화면에서 일시정지, 5초 뒤 재생한다. (3) iPhone을 방장으로
  바꿔(데스크톱 Chrome 게스트) (1)을 방장 기기에서 한다. 단계마다 게스트와 방장의 소리를 적는다.

**통과 기준(주지 않음):**

- A: 재생하거나 볼륨을 50으로 올리면 그 기기의 소리가 설정 볼륨으로 돌아오고, 일시정지와 볼륨 0 동안 예열 소리가 새지 않는다. 방장
  콘솔에 `[YouTube ZeroStart] prepare-host`와 `Playback released`가 있고 어느 기기에도 `[YouTube ZeroStart] audio-restore-timeout`
  경고가 없다. iOS 방장(5)과 Mac Safari(6)도 같다(방장 hard-mute와 활성 복원이 WebKit의 첫 unMute 무시를 지난다). `Falling back to
legacy rendezvous`는 실패로 보지 않고 적는다(예열 중 취소가 레거시로 넘어간 경우). 블루투스(7)는 첫 음이 잘리지 않고, 어긋남은
  기준선 대비 변화만 본다.
- B: 준비가 끝나도 소리가 새지 않고 일시정지가 이기며, 재생하면 방 시계에 맞춰 다시 붙는다.
- C: 게스트의 진짜 일시정지가 존중된다(게스트만 멈추고 재생하면 방 시계에 맞춰 붙는다). seek 직후나 기다리는 중이라는 이유로 무시되거나
  방 전체가 멈추지 않는다. (3)에서 방장의 일시정지는 방에 그대로 전해진다(오늘 동작). 어느 단계에서도 예열 소리가 새지 않는다.

**실패하면:** 일시적 네트워크로 설명되지 않는 어긋남이면 위 '되돌리기'대로 앞으로 고치기(9.0.31 / v804 이상)나, 급할 때만 명시적으로 검토한 CLI 되돌리기로 checkpoint App(9.0.29)을 정한다.
'기기 없음'과 '미확인'은 실패가 아니다.

## 사용자가 알아챌 변화

없다. 버전 올리기와 함께 업데이트 창이 한 번 뜬다(9.0.29의 창 다음, 창 모양은 지금 그대로). 처음 받는 코드는 gzip 기준 JS 154 B,
전체 152 B 줄어든다(다시 옮긴 바탕 `e51dd292`, 곧 운영 9.0.29 대비, 지금 처음 받는 양 약 531 KiB의 0.03 %. 첫 옮긴 바탕 `9e68a7a3`
대비로는 둘 다 114 B, 처음 바탕 대비로는 149 B와 152 B, 위 '번들 크기').

## 기록과 레지스트리

- 이 브랜치: 레지스트리 RO-02, RO-03, RO-12와 가드 항목 11·12(센 코드를 옮긴 커밋에서), 이 보고서와 `docs/README.md` 증거 목록.
  크기 후속(`08135e4f`)이 RO-02, RO-03, RO-12의 시간 집 문장을 같은 커밋에서 낱개 이름으로 고쳤다. 그 리뷰 반영의 가드
  커밋(`0f28e66d`)이 가드 항목 5 문장을 같은 커밋에서 고쳤다.
- 옮긴 뒤 기록 커밋: 이 보고서의 상태와 QA 라운드 6, `docs/README.md` 증거 목록의 바탕, release-record §2의 이 열차 '배포 전' 항목.
- 9.0.29 기록 위로 다시 옮긴 뒤(릴리스 담당): 이 보고서의 순서·위임·버전과 QA 라운드 7, Q6 문장, release-record의 '§2 맨 위 9.0.29
  절' 가리킴을 '§2 9.0.29 절'로(6A 절이 §2 맨 위에 있으므로, 9.0.29 보고서의 가리킴 셋도), 위 '배포 조건과 순서' 4의 남은 기록,
  R4-Q3 주석과 R4 절의 그 문장, 버전 올리기 뒤 QA 라운드 8. 남은 것은 위 '배포 조건과 순서' 7(배포 기록 PR). 레지스트리 머리의
  `Last source review`(2026-10-22)는 기록을 코드와 다시 맞추는 PR이 고친다.
- Phase 5.5 날짜 보고서(`phase5-5-r1-train3-v2-accept-2026-10-29.md`의 C2-1 기다림 문장 셋, `phase5-5-r2-v2-send-2026-10-29.md`의 하나)는
  날짜 증거라 그대로 둔다. 그 기다림은 6A-3(`4c5ca5e9`)으로 닫혔다: App 쪽 시간 집과 2.3 s·3 s 순서 시험이 이 브랜치에 있다.

## 오너에게

1과 2는 권장안 (가)를 따랐다. 1은 크기 후속(`12367317`, `08135e4f`)으로 처리해 정할 것이 남지 않았고, 2는 이 브랜치에 싣지
않았다. 3(배포 순서)은 오너가 2026-10-31 저녁에 답했다: 앱 글꼴 업데이트 먼저, 6A는 그 뒤 9.0.30 / v803.

1. **[화면 그대로] 첫 업데이트의 처음 받는 코드 크기(Q29): 권장안 (가)로 줄였어요.** 화면과 소리는 그대로예요. 새로 모은 시간 값을
   묶음 대신 낱개 이름으로 바꿨어요(값과 동작은 그대로). 그래서 이번 업데이트는 앱을 처음 열 때 받는 양을 늘리지 않고 압축 기준
   149바이트(전체로는 152바이트) 줄여요. 9.0.28 위로 옮긴 뒤 다시 재면 둘 다 114바이트 줄어요. 바꾸기 전에는 237바이트 늘어 Phase 6
   상한 200바이트를 넘었어요. 이제 상한 안이라 멈출 이유가 없어졌고, 크기 때문에 따로 정하실 것은 없어요(배포 순서는 3). 글꼴 업데이트
   9.0.29 위로 다시 옮긴 뒤에는 154바이트(전체로는 152바이트) 줄어요.
   묶음 모양으로 되돌리기를 원하시면(이전의 (나) 다음 업데이트에서 되찾기, (다) 상한 올리기) 크기
   후속과 그 리뷰 반영의 네 커밋(`12367317`, `08135e4f`, `fcb21ae6`, `0f28e66d`)을 함께 되돌리면 코드가 후속 전과 같아져요(크기 후속
   두 커밋만 되돌리면 가드 시험이 충돌해요).
2. **[화면 그대로] 플레이어 상태 이름 정리를 뒤로 미루기.** 계획에 있던 'YouTube 플레이어 상태 숫자(−1, 0, 1, 2, 3, 5)에 공용 이름 붙이기'를
   이번 업데이트에 넣지 않았어요. 코드 안 이름만 바뀌는 일이라 화면·소리는 어느 쪽이든 같아요. 권장안 (가)대로 뒤 열차로 넘겨 두었어요.
   - (가, 권장, 지금 상태) 뒤 열차로 넘긴다(시작 준비 단계를 함께 쓰게 만드는 6C에서 크기와 함께 다시 본다).
   - (나) 이번 업데이트에 넣는다: 만드는 중에 묶음 모양 위에서 잰 값으로는 처음 받는 양이 약 50바이트 더 늘었어요. 낱개 이름 위에서는
     재지 않았어요. 고르시면 시험 먼저 커밋부터 더하고 크기를 다시 재요.
3. **[화면 그대로] 6A를 언제, 앱 글꼴 업데이트와 어느 순서로 낼지: 글꼴 먼저로 답하셨어요(2026-10-31 저녁).** 6A는 화면과
   소리가 그대로이고 업데이트 창만 한 번 떠요. 글꼴 업데이트가 9.0.29로 먼저 나갔고(2026-10-31 23:39 KST), 6A는 그 배포 기록 위로
   옮겨 시험 먼저 커밋과 처음 받는 크기를 다시 확인했어요(QA 라운드 7). 6A는 9.0.30으로 나가고, 업데이트 창은 모두 두 번 떠요. 자리를
   비우시며 릴리스와 시험을 맡기셨으므로(약 40시간), 그 동안은 'Phase 6 업데이트는 깨어 계실 때만'을 이 위임이 대신해 자동 관문이
   모두 통과하면 냅니다. 6A에 문제가 있어 되돌리면 9.0.29의 앱으로 돌아가요(배포 뒤 손으로 되돌릴 때의 규칙은 '되돌리기').

## QA 라운드

### 1. 증분별: 테스트 먼저 다시 돌림

2026-10-31 16:44 ~ 16:49 KST, Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest 5.0.3, `--maxWorkers=4`. `599465dd`에서 만든 임시
worktree(`npm ci`)에서 커밋마다 detached로 바꿔 돌렸고, 끝난 뒤 그 worktree는 깨끗했다. 결과는 위 '증분 한눈에'와 각 절이다. 크기
후속의 테스트 먼저 커밋은 아래 라운드 3이다.

- `09a1bb8c` 15 / 121 실패(가드 6, owner-ports 8, owner-queries 1) → `faffa69b` 211 / 211.
- `8cc9decc` 3 / 112 실패(가드 3) → `d34b4478` 293 / 293.
- `d9bee96c` 8 / 82 실패(가드 2, 순서 2, parity 4) → `4c5ca5e9` 438 / 438.
- `e1a1a4d3` 가드 1 / 67 실패와 `iframe-audio.test.ts` 불러오기 실패 → `5e3edd0c` 534 / 534.
- `cd35aed8` 4 / 68 실패 → `4a1a7e89` 68 / 68.
- 리뷰 반영 시험만 넷의 새 행: 6A 앞 런타임에서 모두 통과(위 '열차 리뷰 반영'의 근거).

### 2. 전체 검사

마지막 커밋 `b80485f3`, 2026-10-31 16:03 ~ 17:19 KST, 같은 환경(vite 8.3.3, Playwright 1.63 Chromium). 깨끗한 트리에서 돌렸다.

- 단위 전체(파일 순서): 727 files, 17,218 통과, 1 건너뜀, 실패 0(719 s). 건너뛴 하나는 jq가 없는 PC에서 건너뛰는 기존 행
  (`release-deployment-state.test.ts`의 `it.skipIf(!jqAvailable && !process.env.CI)`)이다. git fixture 행의 시간 초과는 없었다.
- `src/youtube`와 `src/pro-room`을 `--sequence.shuffle`로 seed 7, 31, 4242, 20261030: 174 files, 4,777행. `src/youtube`는 네 seed 모두
  실패 0이다. `src/pro-room`의 두 파일만 실패했다: seed 7은 `system-audio-service.test.ts` 32, seed 31은 그 파일 57과
  `runtime-preload.test.ts` 3, seed 4242는 50과 2, seed 20261030은 76과 1. 두 파일과 그 런타임은 이 브랜치가 건드리지 않았고, 바탕
  `599465dd`(171 files, 4,705행)에서 같은 명령과 seed로 실패한 행의 집합이 넷 모두 글자 그대로 같다(32, 60, 52, 77). 그래서 6A와
  무관한 기존 순서 의존이다(아래 '확인하지 않은 것').
- `npm run typecheck`(전체, `typecheck:tests`, `typecheck:browser-classic`, `typecheck:node-scripts` 포함), `npm run lint`(app과
  tooling), `npm run format:check`, `npm run check:workers` 모두 종료 코드 0.
- `build:checked`의 각 단계를 하나씩 돌렸다(`guard:sw-cache-version`이 실패하면 사슬이 멈추므로). `guard:sw-cache-version` 하나만
  실패했다: '[sw-cache-version] FAIL: committed PWA runtime changes are newer than v800 (23f29283).'와 위 'Deploy target'의 App 13 파일,
  'Bump CACHE_VERSION in scripts/service-worker-asset.ts after these changes, then commit the bump.' 버전을 올리지 않았다는 것 말고는
  이유가 없다. 나머지(authored JS 둘, TypeScript project coverage 1,537 files, classic runtime 16, auxiliary browser, service worker,
  UI kit, release identity, brand capitalization, declaration ownership, source complexity, room authority, profanity, hreflang 43,
  sitemap 93, `npm run build`, legacy TV(Chromium 79), service worker build(v800, 바이트 동일), UI kit build, initial transfer budget,
  prod hooks, prod security, 글꼴 2,009.5 KiB, SW 앱 셸 94 assets)는 모두 통과했다.
- 그 밖 `guard:*` 전부 통과: bus-pairing 202 / 202, chunk-pump, transport-health, import-graph(404 files, 2,098 edges, 순환 0),
  lifecycle-writes, navigation-sinks, dead-exports(404 / 2,124 / 0 / 20 / 76), font assets, standard-room hot path, Developer API
  boundaries, D1 migrations, ops drift contract, Playwright API.
- `node scripts/check-resource-ownership.mts`와 `--report`: 위 '정확한 개수 가드'. 이름마다 세는 지금 가드를 바탕 트리에 돌린 확인도 같다.
- 크기: 위 '번들 크기'(커밋마다 빌드, 마지막 트리는 이 worktree의 `build:checked` 단계 빌드와 바이트로 같음).
- `npm run test:coverage:critical`: 93 files / 3,726 통과, 전체 83.92 / 79.1 / 89.37 / 87.64(문턱 73 / 66 / 80 / 78), 파일별 문턱 오류
  없음(`iframe-audio.ts` 99 / 99 / 99 / 99 포함).
- `npm run test:coverage:workers`: 69 files / 3,325 통과, 86.72 / 83.55 / 94.41 / 90.98.
- `npm run build:e2e` 뒤 로컬 Playwright(Chromium, 포트 4648 / 9648): `test:e2e:critical` 100 / 100(5.7분), YouTube 여덟 spec(계획
  §4.2-3: `youtube-sync`, `youtube-manual-zero-start`, `youtube-output-delay`, `youtube-end-transition`, `youtube-native-operator`,
  `youtube-manual-repeat`, `youtube-pending-seek`, `youtube`) 41 / 41(12.0분).
- 계약 동결(계획 §4.2 Phase 6 검사 1): `git diff --stat 599465dd..b80485f3 -- cloudflare/ src/network/protocol.ts src/core/constants.ts
src/types/index.ts package.json package-lock.json index.html scripts/service-worker-asset.ts browser/`가 비어 있다.

### 3. 크기 후속 (`12367317`, `08135e4f`)

2026-10-31 17:53 ~ 18:25 KST, 같은 환경(Node 24.22.2 / npm 12.0.2, vitest 5.0.3, vite 8.3.3, `--maxWorkers=4`), 이 갈래의 worktree에서.
시작할 때 이 PC에 다른 node 작업이 없었고, 끝난 뒤 트리는 깨끗했다.

- 테스트 먼저: 커밋 직전 트리(= `12367317`, 런타임은 `a883f9b9`)에서 두 파일 4 / 83 실패(parity 3, 가드 1), 79 통과. 실패는 모두 새
  이름을 읽는 행이다.
- `08135e4f`, 단위:
  - `src/youtube` 파일 순서: 66 files, 1,907 통과, 실패 0. `--sequence.shuffle`의 seed 7, 31, 4242, 20261030에서도 네 번 모두 66 files,
    1,907 통과, 실패 0.
  - `playback-late-cohort-join.test.ts` 8 / 8, `protocol.test.ts` 81 / 81, `resource-ownership-guard.test.ts` 69 / 69. `src/youtube` 밖의
    나머지 T0a 시험 파일(`src/pro-room` 15, `player-controls.test.ts`)과 `playlist.test.ts` 17 files, 878 통과. 코드 커밋이 고친 시험
    여섯 파일 234 / 234.
- `npm run typecheck`(전체 사슬), `npm run lint`, `npm run format:check`: 커밋한 것과 같은 트리에서 모두 종료 코드 0.
- 가드: `node scripts/check-resource-ownership.mts`와 `--report`는 위 '정확한 개수 가드'(CHECK 5 1 / 1 / 45와 쌍 목록, CHECK 11 32,
  CHECK 12 11과 9가 `a883f9b9`와 같음). `guard:dead-exports` 404 / 2,139 / 0 / 20 / 76, `guard:import-graph` 404 files, 2,098 edges,
  순환 0, `guard:initial-transfer-budget` 통과.
- 크기: 바탕 `599465dd`(이 worktree를 잠시 detached로 바꿔 빌드한 뒤 갈래로 되돌림), `a883f9b9`, `08135e4f`를 `npm run build`로 만들어
  `measureInitialTransfer`로 쟀다(위 '번들 크기'). `08135e4f`는 두 번 빌드해 진입 청크 이름과 모든 측정값이 같았다.
- 배포 대상과 계약 동결: 위 'Deploy target'의 함수로 `599465dd..08135e4f`는 App 13, 나머지 Worker 0, 의존성 차이 없음. 라운드 2의 계약
  동결 diff를 `599465dd..08135e4f`로 돌려도 비어 있다.
- 돌리지 않은 것: 단위 전체, `src/pro-room` shuffle, 커버리지, `build:checked` 사슬, Playwright(아래 '확인하지 않은 것').

### 4. 크기 후속 리뷰 (`fcb21ae6`, `0f28e66d`)

2026-10-31 19:04 ~ 19:12 KST, 같은 환경, 이 갈래의 worktree에서. 시작할 때 이 PC에 다른 vitest 작업이 없었고, 끝난 뒤 트리는
깨끗했다.

- 테스트 먼저: 커밋한 트리(= `fcb21ae6`, 가드는 `a9b670fa`)에서 `resource-ownership-guard.test.ts` 72행 가운데 2 실패(스칼라 집 옆
  객체, 같은 이름 사본 일곱), 70 통과. `0f28e66d`에서 72 / 72.
- `node scripts/check-resource-ownership.mts`: OK, 49 records, 451 production files, CHECK 5 1 / 1 / 45, CHECK 11 32, CHECK 12
  읽기 11과 지우기 9. `--report` 108줄이 가드를 바꾸기 전과 같다.
- `tsc -p tsconfig.test.json`, `tsc -p tsconfig.node-scripts.json`, `tsc -p tsconfig.tooling.json`, 바꾼 파일의 eslint(시험은 app
  설정, 가드는 tooling 설정)와 prettier: 모두 종료 코드 0. `guard:dead-exports` 404 / 2,139 / 0 / 20 / 76, `guard:import-graph` 404
  files, 2,098 edges, 순환 0(둘 다 라운드 3과 같음).
- 크기: `0f28e66d` 트리를 `npm run build`로 만들어 `measureInitialTransfer`로 쟀다: `main-C-K1wcbh.js` 860,403 / 253,552, eager JS
  gzip 466,332, eager total 2,057,356 / 545,573(`08135e4f`와 같음).
- 배포 대상과 계약 동결: 'Deploy target'의 함수로 `a9b670fa..0f28e66d`는 모든 Worker 0과 의존성 차이 없음, `599465dd..0f28e66d`는
  App 13, 나머지 Worker 0, 의존성 차이 없음. 라운드 2의 계약 동결 diff를 `599465dd..0f28e66d`로 돌려도 비어 있다.
- 돌리지 않은 것: 런타임이 바뀌지 않아 단위 시험은 가드 시험만 돌렸다.

### 5. 마지막 검사 (브랜치 끝, 코드는 `0f28e66d`)

2026-10-31 19:21 ~ 20:06 KST, 같은 환경(Node 24.22.2 / npm 12.0.2, vitest 5.0.3, vite 8.3.3, Playwright 1.63 Chromium, `--maxWorkers=4`),
이 갈래의 worktree에서. 돌린 트리는 `0f28e66d`의 코드·가드·시험에 그 뒤 기록(이 보고서와 `docs/README.md`)만 더한 브랜치 끝이다(이 절을
더하기 전). 시작할 때 이 PC에 다른 node 작업이 없었고, 검사는 겹치지 않게 하나씩 돌렸으며, 끝난 뒤 트리는 깨끗했다.

- 단위 전체(파일 순서): 727 files, 17,222 통과, 1 건너뜀, 실패 0(527 s). 건너뛴 하나는 라운드 2와 같은 jq 행이고, 라운드 2보다 넷 많은
  행은 크기 후속의 시험(+1)과 그 리뷰의 가드 시험(+3)이다. git fixture 행의 시간 초과는 없었다.
- `npm run typecheck`(전체 사슬), `npm run lint`(app과 tooling), `npm run format:check`: 모두 종료 코드 0.
- `build:checked`의 25 단계를 순서대로 하나씩 돌렸다. `guard:sw-cache-version` 하나만 실패했다: '[sw-cache-version] FAIL: committed PWA
  runtime changes are newer than v800 (23f29283).'와 위 'Deploy target'의 App 13 파일, 'Bump CACHE_VERSION in
  scripts/service-worker-asset.ts after these changes, then commit the bump.' 버전을 올리지 않았다는 것 말고는 이유가 없다. 나머지 24
  단계는 통과했다(authored JS 둘, TypeScript project coverage 1,537 files, classic runtime 16, auxiliary browser, service worker, UI kit,
  release identity 'MUSIXQUARE 9.0.27; service-worker cache epoch v800', brand capitalization, declaration ownership, source complexity,
  room authority(79 / 22 / 13 / 0 / 0, 404 files), profanity, hreflang 43, sitemap 93, `npm run build`, legacy TV(Chromium 79,
  `main-C-K1wcbh.js`), service worker build(v800, 바이트 동일), UI kit build, initial transfer budget, prod hooks, prod security, 글꼴
  2,009.5 KiB, SW 앱 셸 94 assets).
- 그 밖 `guard:*` 13개도 모두 통과했다(`package.json`의 `guard:*` 37개 가운데 실패는 위 하나): bus-pairing 202 / 202, chunk-pump,
  transport-health, import-graph(404 files, 2,098 edges, 순환 0), lifecycle-writes, navigation-sinks, dead-exports(404 / 2,139 / 0 / 20 /
  76), font assets, standard-room hot path, Developer API boundaries, D1 migrations, ops drift contract, Playwright API.
- `node scripts/check-resource-ownership.mts`: OK, 49 records, 451 production files, CHECK 5 1 / 1 / 45, CHECK 11 32, CHECK 12 읽기 11과
  지우기 9. `--report`는 108줄이다.
- 크기: 위 '번들 크기'의 마지막 항목(바탕과 브랜치 끝을 다시 빌드, eager JS gzip −149 B, eager total gzip −152 B).
  `guard:initial-transfer-budget`은 eager JS 455.4 KiB, eager total 532.8 KiB gzip으로 통과했다.
- `npm run test:coverage:critical`: 93 files / 3,726 통과, 전체 83.92 / 79.1 / 89.37 / 87.64(라운드 2와 같음), 파일별 문턱 오류 없음
  (`iframe-audio.ts`는 lcov로 함수 7 / 7, 줄 24 / 24, 분기 19 / 19).
- `npm run test:e2e:critical`(앞 단계로 `build:e2e`), 로컬 Playwright Chromium, 포트 4648 / 9648: 100 / 100(5.4분). 같은 e2e 빌드로
  라운드 2의 YouTube 여덟 spec: 41 / 41(11.8분).
- 배포 대상과 계약 동결: 'Deploy target'의 함수로 `599465dd`..브랜치 끝은 App 13, 나머지 Worker 0, 의존성 차이 없음. 라운드 2의 계약
  동결 diff를 브랜치 끝으로 돌려도 비어 있다.
- 되돌리기 확인('오너에게' 1): 크기 후속의 두 커밋만 `git revert --no-commit`하면 `resource-ownership-guard.test.ts`에서 충돌한다(그
  리뷰 반영의 시험 커밋이 같은 곳을 고침). 그 리뷰 반영까지 네 커밋(`0f28e66d`, `fcb21ae6`, `08135e4f`, `12367317`)을 되돌리면 충돌
  없이 `src/`, `scripts/`, 레지스트리가 `a883f9b9`와 같아진다. 둘 다 곧바로 `git revert --abort`로 거뒀고 트리는 깨끗했다. 그래서
  '오너에게' 1의 되돌리기 문장을 네 커밋으로 고쳤다.
- 돌리지 않은 것: `src/youtube`와 `src/pro-room`의 shuffle(라운드 2, `src/youtube`는 라운드 3에서도), `test:coverage:workers`와
  `check:workers`(라운드 2, 그 뒤 `cloudflare/` 차이 없음), WebKit과 실기기(아래 '확인하지 않은 것').

### 6. main `9e68a7a3` 위로 옮김과 재확인

2026-10-31 20:30 ~ 21:20 KST, Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=6`(JSON 보고), 처음 갈래 끝 `b92e6417`에서
새로 만든 worktree(`npm ci`). 검사는 하나씩 돌렸고 끝난 뒤 트리는 깨끗했다. 옮긴 머리 `77c34a25`의 코드·가드·시험은 `0f28e66d`의 것에
main의 변경을 더한 것이다.

- 옮김: `git fetch origin` 뒤 스물네 커밋을 `git rebase`로 main `599465dd`에서 `9e68a7a3`로 옮겼다. 지난 main 커밋은 셋이다: #545
  (`aa7baad5`, App 9.0.28 / v801 런타임 릴리스), #546(그 배포 기록, 문서만), #547(시험만, 남은 단위 시험 15 파일의 순서 의존 제거).
  충돌은 `docs/README.md`의 두 곳뿐이었다. 증거 목록 맨 위에 이 보고서 항목을 더한 `a883f9b9`와 그 항목의 끝 세 줄을 고친 `b92e6417`
  모두 양쪽을 남겨, 6A 항목을 'Maintained evidence and completed records' 맨 위, main의 9.0.28 열차·SFU 대체·재생목록 항목 위에
  두었다. 레지스트리(`docs/design/resource-ownership-registry.md`)와 `vitest.critical.config.ts`를 포함한 나머지는 저절로 합쳐졌다.
  옮기며 새 커밋을 더하지 않았고 버전, SW 캐시, 기록 글을 바꾸지 않았다.
- 그대로 옮겼음: 스물넷 모두 커밋 메시지가 바이트로 같다. 21커밋은 `git patch-id`가 같고, 기록 커밋 셋은 더하고 뺀 줄이 같고 문맥만
  움직였다. `git diff 9e68a7a3..77c34a25`는 `docs/README.md` 말고 모든 파일에서 `git diff 599465dd..b92e6417`와 줄마다 같고,
  `docs/README.md`는 6A 항목만 더하고 main의 글을 지우지 않는다. 합쳐진 네 파일(`docs/README.md`, 레지스트리, 이 보고서,
  `vitest.critical.config.ts`)은 prettier 검사를 통과했다.
- 대응표(옮긴 뒤 ← 처음, 오래된 것부터):

  | 옮긴 뒤    | 처음       | 커밋                                                               |
  | ---------- | ---------- | ------------------------------------------------------------------ |
  | `f5cd88e6` | `09a1bb8c` | 6A-1 테스트 먼저                                                   |
  | `e0496e0b` | `faffa69b` | 6A-1 소유자 질의                                                   |
  | `020873c7` | `8cc9decc` | 6A-2 테스트 먼저                                                   |
  | `d59e1cfe` | `d34b4478` | 6A-2 겹친 직접 지우기                                              |
  | `439b459b` | `d9bee96c` | 6A-3 테스트 먼저                                                   |
  | `e9478297` | `4c5ca5e9` | 6A-3 시간 집                                                       |
  | `96cb4ea8` | `e1a1a4d3` | 6A-4 테스트 먼저                                                   |
  | `3eff67c8` | `5e3edd0c` | 6A-4 검증 복원 하나                                                |
  | `33c2fb0b` | `0ec9e8e0` | 6A-4 위치 매개변수와 결과 콜백 하나                                |
  | `ed35292d` | `0cd720fc` | 6A-4 주석                                                          |
  | `c43d291d` | `a35e07b9` | 시험만: 재지정, 확인 울타리, 정착 재-seek                          |
  | `78bf07df` | `95b03762` | 시험만: 복원 루프마다 던지는 쓰기                                  |
  | `dd2897e5` | `21f1836a` | 시험만: 레거시 로컬 시작의 따라잡기 끝, follow-up 대기             |
  | `dc775bda` | `cd35aed8` | CHECK 12 이름마다, 테스트 먼저                                     |
  | `3e80f168` | `4a1a7e89` | CHECK 12 이름마다, 가드만                                          |
  | `b1354d1c` | `5a3d356b` | 주석·레지스트리만                                                  |
  | `74ee6cbc` | `b80485f3` | 시험만: 가짜 플레이어의 던지는 unMute 손잡이                       |
  | `92828c3c` | `a883f9b9` | 기록: 이 보고서(`docs/README.md` 충돌, 양쪽 남김)                  |
  | `dac49020` | `12367317` | 크기 후속, 테스트 먼저                                             |
  | `0a77f949` | `08135e4f` | 크기 후속: 값마다 이름 붙인 export                                 |
  | `2f525604` | `a9b670fa` | 기록: 크기 후속                                                    |
  | `a8fe187d` | `fcb21ae6` | CHECK 5 스칼라 집, 테스트 먼저                                     |
  | `f6275c81` | `0f28e66d` | CHECK 5 스칼라 집, 가드만                                          |
  | `77c34a25` | `b92e6417` | 기록: CHECK 5 후속과 마지막 검사(`docs/README.md` 충돌, 양쪽 남김) |

- 테스트 먼저(라운드 1과 같은 방법): 테스트 먼저 커밋마다 그 커밋에서 그 시험 파일을, 코드 커밋에서 같은 파일과 코드 커밋이 고친
  시험 파일을 돌렸다. 같은 파일 묶음을 옮긴 뒤 SHA와 처음 SHA 양쪽에서 돌려 실패한 행의 이름을 정렬해 견줬다. 모든 쌍에서 옮긴 부모의
  실패 행이 처음 부모의 실패 행과 이름까지 같고, 코드 커밋은 모두 100 % 통과했다. 수는 위 '증분 한눈에'와 같다: 6A-1 `f5cd88e6` 15 /
  121 실패 → `e0496e0b` 211 / 211, 6A-2 `020873c7` 3 / 112 → `d59e1cfe` 293 / 293, 6A-3 `439b459b` 8 / 82 → `e9478297` 438 / 438, 6A-4
  `96cb4ea8` 가드 1 / 67과 `iframe-audio.test.ts` 불러오기 실패 → `3eff67c8`, `33c2fb0b`, `ed35292d` 각각 534 / 534, CHECK 12 이름마다
  `dc775bda` 4 / 68 → `3e80f168` 68 / 68, 크기 후속 `dac49020` 4 / 83 → `0a77f949` 234 / 234, CHECK 5 스칼라 집 `a8fe187d` 2 / 72 →
  `f6275c81` 72 / 72. 리뷰의 시험만 넷은 옮긴 부모에서 모두 통과했다: `c43d291d` 241 / 241(`authority-arm`, `zero-start`), `78bf07df` 58 /
  58(복원 박자 표), `dd2897e5` 185 / 185(`player`, owner-queries), `74ee6cbc` 12 / 12(가짜 플레이어).
- 머리 `77c34a25`, 단위:
  - `src/youtube` 파일 순서 66 files, 1,907 / 1,907. `--sequence.shuffle`의 seed 7, 31, 4242, 20261030에서도 네 번 모두 같다.
  - `src/pro-room` 파일 순서 108 files, 2,914 / 2,914. 같은 네 seed에서도 모두 통과했다. 라운드 2에서 shuffle로 실패하던 두 파일
    (`system-audio-service.test.ts`, `runtime-preload.test.ts`)은 main의 #547 뒤 네 seed 모두 통과한다.
  - T0a 골든: #539, #541, #542가 더하거나 고친 시험 36 files(`src/pro-room` 16, `src/youtube` 18, `protocol.test.ts`,
    `player-controls.test.ts`)를 함께 돌려 1,538 / 1,538. 이 갈래는 그 가운데 10 파일을 고치고, 지운 줄은 늦은 합류 네 묶음의 import와
    주석(이제 집에서 가져옴), 주석 줄, 시험 import 하나뿐이다. 지운 단언은 없다.
- `npm run typecheck`: 종료 코드 0.
- `node scripts/check-resource-ownership.mts`: OK, 49 records, 451 production files, CHECK 5 1 / 1 / 45, CHECK 11 32, CHECK 12 읽기 11과
  지우기 9(옮기기 전과 같음). `guard:dead-exports` 404 / 2,142 / 0 / 20 / 76(바인딩 +3은 #545의 보류 export 셋), `guard:import-graph` 404
  files, 2,098 edges, 순환 0.
- 버전 가드: `guard:release-identity` 'MUSIXQUARE 9.0.28; service-worker cache epoch v801'. `guard:sw-cache-version`은 버전을 올리지
  않은 것 하나로만 실패한다: 'committed PWA runtime changes are newer than v801 (aa7baad5)'와 옮기기 전과 같은 App 13 파일.
- 계약 동결: `git diff --stat 9e68a7a3..77c34a25 -- cloudflare/ src/network/protocol.ts src/core/constants.ts src/types/index.ts
package.json package-lock.json index.html scripts/service-worker-asset.ts browser/`가 비어 있다.
- 배포 대상: 'Deploy target'의 함수로 `9e68a7a3..77c34a25`와 운영 SHA(App 9.0.28 `aa7baad5`, PRO room `683074bc`, 나머지 넷 `71f5b96c`)
  대비 모두 App 13, 나머지 Worker 0, App 런타임 의존성 차이 없음.
- 크기: 위 '번들 크기'의 '옮긴 뒤' 항목(바탕 `9e68a7a3`과 머리를 다시 빌드, eager JS와 eager total 모두 gzip −114 B,
  `guard:initial-transfer-budget` 통과).
- 돌리지 않은 것: 단위 전체(그래서 git fixture 행의 시간 초과도 볼 일이 없었다), `npm run lint`, 위 네 파일과 이 라운드에 고친 문서
  밖의 `format:check`, `build:checked` 사슬과 위에 적지 않은 가드, 핵심·Worker 커버리지, `check:workers`, Playwright. 옮기며 바뀐 것은
  main 쪽(#545의 App 런타임 넷과 버전 거울, #546 문서, #547 시험)이고 이 갈래의 diff는 `docs/README.md` 말고는 옮기기 전과 같다.

### 7. App 9.0.29 기록 `e51dd292` 위로 다시 옮김과 재확인

2026-11-01 01:00 ~ 01:19 KST, Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=6`(JSON 보고). 옮김과 머리의 검사는 이
갈래의 worktree에서, 테스트 먼저 다시 돌리기는 `c4667abc`에서 따로 만든 detached worktree(`npm ci`, 런타임 의존성은 바탕과 같음)에서
커밋마다 detached로 바꿔 했다. 검사는 하나씩 돌렸고 끝난 뒤 두 트리는 깨끗했다.

- 옮김: 오너가 앱 글꼴 업데이트를 먼저 내기로 정해(2026-10-31 저녁) 그것이 App 9.0.29 / v802(#548 squash `c4667abc`)로 23:39 KST에
  나갔고, 그 배포 기록(#549 squash `e51dd292`, 문서만)이 2026-11-01 00:58 KST에 main에 들어왔다. `git fetch origin` 뒤 스물여섯 커밋을
  `git rebase`로 `9e68a7a3`에서 `e51dd292`로 옮겼다(지난 main 커밋은 그 둘). 충돌은 문서 커밋 넷에서만 났다: `docs/README.md`
  (`92828c3c`, `77c34a25`, `5ef68471`의 6A 항목과 main의 9.0.29 항목)와 `docs/release-record.md`(`ff1aca14`의 6A '배포 전' 절과 main의
  9.0.29 '배포 뒤 확인' 절, 둘 다 §2 맨 위에 더함). 모두 양쪽을 남겨 라운드 6처럼 6A 항목과 6A 절을 맨 위에, main의 9.0.29 항목과
  절을 그 바로 아래에 두었다. 나머지는 저절로 합쳐졌다. 옮기며 새 커밋을 더하지 않았고 버전, SW 캐시, 기록 글을 바꾸지 않았다.
- 그대로 옮겼음: 스물여섯 모두 커밋 메시지가 바이트로 같다. 21커밋은 `git patch-id`가 같고, 기록 커밋 다섯은 더하고 뺀 줄이 같고
  문맥만 움직였다. `git diff e51dd292..3be18bdb`는 `docs/README.md`와 `docs/release-record.md` 말고 모든 파일에서
  `git diff 9e68a7a3..ff1aca14`와 줄마다 같고, 그 두 파일도 더하고 뺀 줄의 묶음이 같다(main의 글을 지우지 않음).
- 대응표(다시 옮긴 뒤 ← 라운드 6, 오래된 것부터. 처음 SHA는 라운드 6의 표):

  | 다시 옮긴 뒤 | 라운드 6   | 커밋                                                       |
  | ------------ | ---------- | ---------------------------------------------------------- |
  | `d37c2060`   | `f5cd88e6` | 6A-1 테스트 먼저                                           |
  | `6a4940c9`   | `e0496e0b` | 6A-1 소유자 질의                                           |
  | `7a48c8a7`   | `020873c7` | 6A-2 테스트 먼저                                           |
  | `733733dd`   | `d59e1cfe` | 6A-2 겹친 직접 지우기                                      |
  | `4cf0d3d8`   | `439b459b` | 6A-3 테스트 먼저                                           |
  | `7cd7f2c4`   | `e9478297` | 6A-3 시간 집                                               |
  | `8393f350`   | `96cb4ea8` | 6A-4 테스트 먼저                                           |
  | `33543405`   | `3eff67c8` | 6A-4 검증 복원 하나                                        |
  | `407124cc`   | `33c2fb0b` | 6A-4 위치 매개변수와 결과 콜백 하나                        |
  | `2b406e10`   | `ed35292d` | 6A-4 주석                                                  |
  | `8ebf1c84`   | `c43d291d` | 시험만: 재지정, 확인 울타리, 정착 재-seek                  |
  | `aab93da8`   | `78bf07df` | 시험만: 복원 루프마다 던지는 쓰기                          |
  | `2f4dc4d9`   | `dd2897e5` | 시험만: 레거시 로컬 시작의 따라잡기 끝, follow-up 대기     |
  | `a70bf036`   | `dc775bda` | CHECK 12 이름마다, 테스트 먼저                             |
  | `2358f5f7`   | `3e80f168` | CHECK 12 이름마다, 가드만                                  |
  | `7dedbc61`   | `b1354d1c` | 주석·레지스트리만                                          |
  | `db1695e4`   | `74ee6cbc` | 시험만: 가짜 플레이어의 던지는 unMute 손잡이               |
  | `5ab2b943`   | `92828c3c` | 기록: 이 보고서(`docs/README.md` 충돌, 양쪽 남김)          |
  | `8d30a84e`   | `dac49020` | 크기 후속, 테스트 먼저                                     |
  | `91621214`   | `0a77f949` | 크기 후속: 값마다 이름 붙인 export                         |
  | `af65b9b9`   | `2f525604` | 기록: 크기 후속                                            |
  | `3523adbd`   | `a8fe187d` | CHECK 5 스칼라 집, 테스트 먼저                             |
  | `cbc107a8`   | `f6275c81` | CHECK 5 스칼라 집, 가드만                                  |
  | `94c370f6`   | `77c34a25` | 기록: CHECK 5 후속과 마지막 검사(`docs/README.md` 충돌)    |
  | `73878060`   | `5ef68471` | 기록: 첫 옮김과 재확인(`docs/README.md` 충돌)              |
  | `3be18bdb`   | `ff1aca14` | 기록: release-record의 '배포 전' 절(`release-record` 충돌) |

- 테스트 먼저(라운드 6과 같은 방법과 파일 묶음): 일곱 쌍 모두 새 부모의 실패 행이 라운드 6의 실패 행과 이름까지 같고(정렬해 견줌),
  코드 커밋은 모두 100 % 통과했다. 6A-1 `d37c2060` 15 / 121 → `6a4940c9` 211 / 211, 6A-2 `7a48c8a7` 3 / 112 → `733733dd` 293 / 293,
  6A-3 `4cf0d3d8` 8 / 82 → `7cd7f2c4` 438 / 438, 6A-4 `8393f350` 가드 1 / 67과 `iframe-audio.test.ts` 불러오기 실패(아직 없는
  `../iframe-audio.ts`) → `33543405`, `407124cc`, `2b406e10` 각각 534 / 534, CHECK 12 이름마다 `a70bf036` 4 / 68 → `2358f5f7` 68 / 68,
  크기 후속 `8d30a84e` 4 / 83 → `91621214` 234 / 234, CHECK 5 스칼라 집 `3523adbd` 2 / 72 → `cbc107a8` 72 / 72. 실패 이유는 처음과
  같다: 가드 기준치와 아직 없는 소유자 포트·질의(6A-1), 겹친 지우기 기준치(6A-2), 시간 집 parity·순서와 가드(6A-3), 아직 없는 모듈과
  CHECK 11(6A-4), 이름마다 세는 CHECK 12, 낱개 이름 export, CHECK 5 스칼라 집. 리뷰의 시험만 넷도 새 부모에서 모두 통과했다:
  `8ebf1c84` 241 / 241, `aab93da8` 58 / 58, `2f4dc4d9` 185 / 185, `db1695e4` 12 / 12.
- 머리 `3be18bdb`, 단위:
  - `src/youtube` 파일 순서 66 files, 1,907 / 1,907. `--sequence.shuffle`의 seed 7과 4242에서도 같다.
  - `src/pro-room` 파일 순서 108 files, 2,915 / 2,915(라운드 6의 2,914에 #548이 `upload-failure-dialog.test.ts`에 더한 행 하나).
    seed 7과 4242에서도 모두 통과했다.
  - T0a 골든 36 files 1,539 / 1,539(라운드 6의 1,538에 #548이 `player-controls.test.ts`에 더한 행 하나).
- `npm run typecheck`: 종료 코드 0.
- `node scripts/check-resource-ownership.mts`: OK, 49 records, 457 production files(#548의 글꼴 전환 뒤의 수), CHECK 5 1 / 1 / 45,
  CHECK 11 32, CHECK 12 읽기 11과 지우기 9(옮기기 전과 같음). `guard:dead-exports` 410 / 2,157 / 0 / 20 / 76, `guard:import-graph`
  410 files, 2,103 edges, 순환 0(모두 기준치 안, #548 뒤의 수).
- 버전 가드: `guard:release-identity` 'MUSIXQUARE 9.0.29; service-worker cache epoch v802'. `guard:sw-cache-version`은 버전을 올리지
  않은 것 하나로만 실패한다: 'committed PWA runtime changes are newer than v802 (c4667abc)'와 옮기기 전과 같은 App 13 파일.
- 계약 동결: `git diff --stat e51dd292..3be18bdb -- cloudflare/ src/network/protocol.ts src/core/constants.ts src/types/index.ts
package.json package-lock.json index.html scripts/service-worker-asset.ts browser/`가 비어 있다.
- 배포 대상: 'Deploy target'의 함수로 `e51dd292..3be18bdb`와 운영 SHA(App 9.0.29 `c4667abc`, PRO room `683074bc`, 나머지 넷
  `71f5b96c`) 대비 모두 App 13, 나머지 Worker 0, App 런타임 의존성 차이 없음.
- 크기: 아래 '번들 크기'의 '다시 옮긴 뒤' 항목(바탕과 머리를 다시 빌드, eager JS gzip −154 B, eager total gzip −152 B).
- 돌리지 않은 것: 단위 전체, lint, `format:check`, `build:checked` 사슬과 위에 적지 않은 가드, 핵심·Worker 커버리지, Playwright. 버전
  올리기 뒤의 전체 검사(QA 라운드 8)가 모두 다시 돌린다.

## 확인하지 않은 것

- 실기기, iOS Safari, WebKit 레인(`setup-youtube-activation.test.ts` 포함), 블루투스, Full E2E. 기기 확인은 배포 뒤 블라인드로 하며
  게이트가 아니다. Phase 6 앞의 기기 기준선(Q6)은 재지 않았다: 절차(계획 §7, 약 3시간, 없는 기기 단계는 건너뜀, 기대값 없음)는 이
  릴리스 전에 오너의 비공개 질문 목록으로 건넸고 게이트가 아니며, 오너가 자리에 없어(약 40시간 위임) 6A는 기준선 없이 나간다.
- PR CI, 자동 코드 리뷰, exact-main CI, 버전 올리기 뒤의 `guard:sw-cache-version`과 `build:checked` 사슬 전체.
- main `9e68a7a3` 위로 옮긴 뒤(QA 라운드 6)에는 단위 전체, lint, `format:check` 전체, `build:checked` 사슬과 라운드 6에 적지 않은 가드,
  핵심·Worker 커버리지, `check:workers`, Playwright를 다시 돌리지 않았다. 버전을 올린 뒤의 전체 게이트(위 '배포 조건과 순서' 3)가 이것을
  다시 본다.
- 상태 열거 (가)의 크기를 낱개 이름 집 위에서 재지 않았다(위 '계획과 달라진 것' 2).
- 크기 후속(`08135e4f`) 뒤에는 `src/pro-room` shuffle, `test:coverage:workers`, `check:workers`를 다시 돌리지 않았다. 런타임 변경은
  `constants.ts`와 읽는 다섯 파일의 이름뿐이고 `cloudflare/` 차이는 브랜치 전체에서 0이다. 단위 전체, 핵심 커버리지(`iframe-audio.ts`
  문턱 포함), `build:checked`의 모든 단계, `test:e2e:critical`과 YouTube 여덟 spec은 마지막 검사(QA 라운드 5)가 브랜치 끝에서 돌렸다.
- CHECK 5의 남은 한계(위 '크기 후속 리뷰'): 이름이 다른 사본(시간 이름이면 보고만, 아니면 보지 않음), 값 넷 이하를 나누는 객체,
  집이 계약에 없는 파일의 사본(`playback-controller.ts`에 다시 적은 40 ms 따라잡기 허용치 등, 바탕부터 있던 틈)은 가드가 잡지 않는다.
  리뷰로 본다. 크기 후속(`08135e4f`)이 놓친 스칼라 집 옆 객체와 시간 이름이 아닌 같은 이름 사본은 `0f28e66d`부터 다시 잡는다.
- `src/pro-room`의 shuffle 순서 의존(`system-audio-service.test.ts`, `runtime-preload.test.ts`)은 바탕에도 있는 기존 문제라 이 갈래에서
  고치지 않았다. main의 #547(시험만)이 고쳐, 옮긴 뒤에는 네 seed 모두 통과한다(QA 라운드 6).
- 영역 조사의 대략적 기기 시간(A 35분, B 10분, C 25분)은 추정이다.
