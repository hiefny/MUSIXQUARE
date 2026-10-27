# Phase 5 5B 배포 묶음: 수신 슬롯 동작 변경과 시스템 오디오 옛 버전 항목 (2026-10-26)

| 항목      | 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기준      | origin/main `4d7650c0`(옛 버전 제거 1차 #496, 런타임은 9.0.13 / v786)에서 시작했다. 브랜치는 `agent/phase5-5b`. 그 뒤 main에 들어온 다섯 커밋, 곧 옛 버전 제거 1차 기록 `c3eb4859`(#497), 강제 업데이트 열차 `dd9c9d4d`(#498, 9.0.14 / v787, App build floor 787), 그 기록 `9e02d2df`(#499), 옛 버전 제거 2차의 Workers 릴리스 W `a3893f04`(#500, target all, 앱 업데이트 없음)와 그 기록 `cb159851`(#501)을 합침 커밋 `2fc81c70`으로 합쳤다(글자 충돌은 `docs/README.md` 하나, 아래 [QA 라운드 5](#5-main-합침-뒤-다시-돌리기-2fc81c70-2026-10-27)). 그 검사 중 main에 옛 버전 제거 2차의 App 릴리스 A `5dd7cc1f`(#502, 9.0.15 / v788, main에 머지됐고 배포 전)가 들어와 합침 커밋 `0d59df41`로 다시 합쳤다(아래 [QA 라운드 6](#6-릴리스-a-합침-뒤-다시-돌리기-0d59df41-2026-10-27)). 릴리스 A는 2026-10-27 06:20 KST에 Release 40403240275로 배포됐고, 그 기록 `1ff7fdf2`(#504, 문서만)를 합침 커밋 `08509f84`로 받았다(아래 [QA 라운드 7](#7-릴리스-a-기록-합침-08509f84-2026-10-27)). 배포 전 운영은 9.0.15 / v788이었다. PR #505의 squash `a930030a`(2026-10-27 10:06 KST)는 트리가 마지막 head `e9dc1ed3`와 같고 부모는 `1ff7fdf2`다(아래 [QA 라운드 9](#9-pr-ci-codex-exact-main-ci-배포와-공개-확인-2026-10-27)). |
| 5B 묶음   | 증분마다 테스트 먼저 커밋과 코드 커밋 한 쌍이고, 리뷰 반영 커밋이 셋 있다. 5B-G1 `1f8c7a66` → `e74e10da`, 5B-G2 `09a5743f` → `bf80584d`(리뷰 `b0234155`), 5B-G3 `0e451e80` → `a2894382`, 5B-G4 `c29dc8ec` → `8a2c7164`(리뷰 `98c4b040`), 5B-G5 `fefac7a7` → `b4b724b9`, 5B-G6 `9336aeb2` → `95b04ea3`(리뷰 `99b335b6`), 5B-C4-13 `29e5fb72` → `c852c465`, 5B-OV1 `3fd45d5b` → `7293697f`, 5B-OV2 `43b21ea1` → `04f07124`, 5B-OV3 `1ab5f0b8` → `fddbda0a`, 중립 `c0b86b62`. 그 위에 이 보고서와 기록 커밋(문서만), main 합침 `2fc81c70`, 합침 뒤 기록 커밋 `3281b853`(문서만), 릴리스 A 합침 `0d59df41`(room-authority 테스트 기준치 81 → 80 포함), 그 뒤 기록 커밋 둘(문서만), 릴리스 A 기록 합침 `08509f84`(문서만)와 그 기록 커밋 `614c3652`(문서만), 마지막 런타임 커밋인 bump `198b8cf8`(9.0.16 / v789), 그 뒤 이 보고서와 기록의 최종 검사 커밋 `e9dc1ed3`(문서만, PR #505의 마지막 head)이 있다.                                                                                                                                                                                                                                                                                                                    |
| 상태      | 배포됨. 출시 순서는 강제 업데이트 열차(9.0.14 / v787, floor 787 켬, 2026-10-26 16:15 KST), 릴리스 W(2026-10-27 03:34 KST), 릴리스 A(2026-10-27 06:20 KST 배포, 기록 #504) 다음이었다(W → A → 5B, 2026-10-26 약 14:10 KST 결정대로 머지와 배포를 한 줄로). 릴리스 A의 배포와 그 기록 PR이 끝난 뒤 main을 다시 합쳤다(`08509f84`). 그 뒤 bump `198b8cf8`(9.0.16 / v789)이 마지막 런타임 커밋이고, 그 위는 문서뿐이다. bump 뒤 최종 검사는 아래 [QA 라운드 8](#8-bump-뒤-최종-검사-198b8cf8-9016--v789-2026-10-27)이다. 강제 업데이트 열차가 main에 들어왔으므로 `docs/release-record.md` §2의 배포 전 항목은 main 합침 뒤 이 브랜치에서 더했고, 배포 기록 PR이 §1, §4와 릴리스 이력을 고쳤다. 오너 결정(2026-10-25 약 01:50 KST)대로 자동 게이트가 통과해 따로 묻지 않고 PR #505 squash `a930030a`(2026-10-27 10:06 KST)를 [Release 40431540366](https://github.com/hiefny/MUSIXQUARE/actions/runs/40431540366)으로 배포했다(target `app`, deploy job 10:18:13 KST 완료, attempt 1 성공, QA 라운드 9). 배포 직전 floor `status`는 돌리지 않았다. 남은 것은 게이트가 아닌 배포 뒤 확인이다(release-record §2).                                                                                                               |
| 현재 증분 | 5A가 만든 수신 슬롯(`src/network/system-audio-receive-slot.ts`, RO-04)에서 C4-0이 오늘 동작으로 고정한 틈 1~7, 10~12를 라벨 붙인 묶음 여섯과 C4-13으로 고친다(P5-D5 A, P5-D11 B). 같은 파일들에 있는 시스템 오디오 옛 버전 항목 OV-A04, OV-B05, OV-B06, OV-A08(시스템 오디오 부분), 코디네이터 시대 잔재(OV-A03 메모)와 죽은 채널 배관 SA-9를 지운다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 제품 식별 | 9.0.16 / v789(앱 빌드 789). bump `198b8cf8`이 거울 일곱(`package.json`, `package-lock.json` 둘, App Worker `ADMIN_ASSET_VERSION`, 관리자 스크립트 `ADMIN_SCRIPT_VERSION`, `SERVICE_WORKER_CACHE_VERSION`, `index.html` bootstrap 쿼리)을 릴리스 A의 bump `8407046a`와 같은 모양으로 한 커밋에서 올렸다. 올리기 직전 fetch한 origin/main은 `1ff7fdf2`(9.0.15 / v788, 2026-10-27 06:20 KST 배포)였고, 9.0.15가 배포돼 SemVer와 캐시 epoch를 함께 올렸다. W → A → 5B 순서라 릴리스 A 보고서의 순서표와 같다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 배포 대상 | target `app`, Developer API D1 `false`, `raise_app_build_floor` `false`. 운영 `5dd7cc1f`와 견준 런타임 경로 변경은 App 17개(`src` 13, `browser/classic-runtime/admin.ts`, `index.html`, `scripts/service-worker-asset.ts`, `cloudflare/app-worker.ts`의 bump 한 줄)이고 다른 다섯 Worker는 0개다(`release-deployment-state.mts`의 Worker별 런타임 경로로 잼). D1, 비밀, 바인딩, App 런타임 의존성은 바뀌지 않는다. 시스템 오디오 계약 표지 `single-stereo-v3+heartbeat-state-v1`도 그대로다. 보내는 프레임 변화는 OV-B06의 READY 하나다(아래 [호환과 혼합 버전](#호환과-혼합-버전)). 2026-10-27 10:18 KST에 이 입력 그대로 배포했다(부분 릴리스 판정과 App 배포 직전 다시 확인 compatible, 올리기 단계 skip, App 배포는 새 자산 74개).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 환경      | Windows 11 로컬, Node 24.20.0 / npm 12.0.2. 단위는 jsdom과 가짜 WebRTC, Web Audio, Cloudflare Realtime이다. 로컬 Playwright(헤드리스 Chromium, PeerJS 일반방)의 `e2e/system-audio-controls.test.ts`는 5B-OV2(`04f07124`)와 5B-OV3(`c0b86b62`) 뒤에 5/5 PASS다. 계획 §6은 5B-G1과 5B-G3 뒤에도 돌리기로 했는데 그 실행이 커밋 기록에 없어, 열차 끝에 두 커밋을 꺼내 돌렸다(둘 다 5/5, QA 라운드 5). main 합침 뒤와 bump 뒤에도 5/5다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 운영      | 2026-10-27 10:18 KST에 운영에 나갔다(Release 40431540366, App `317f176f`, 다른 다섯 Worker는 릴리스 W `a3893f04` 그대로). 배포 뒤 운영에 한 것은 공개 GET과 최소 빌드 읽기, Operations Drift Audit 40432152099뿐이다(QA 라운드 9). 실제 기기, iOS·WebKit, 실제 Cloudflare Realtime, 운영 시스템 오디오 수신은 5B 코드로 돌리지 않았다(아래 [실기기로 확인하지 않은 것](#실기기로-확인하지-않은-것)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

이 문서는 구조 개선 Phase 5의 두 번째 앱 배포(5B)에 실리는 증분과 QA를 기록한다. 5A는 동작을 바꾸지 않는
이동만 실었고([Phase 5 5A 보고서](phase5-5a-receive-slot-2026-10-25.md)), C4-0이 오늘 동작으로 고정한 틈을 고치는 일은
5B로 왔다. 증분마다 그 틈을 고정한 행을 뒤집거나 새 행을 더한 테스트 먼저 커밋을 두었고, 그 행은 바꾸기 전 코드에서
실패한다. 중립 증분은 바꾸기 전과 뒤에 모두 통과하는 테스트만 둔다. 증분마다 커밋, 검증한 코드 SHA, 환경, PASS/FAIL/SKIP과
한계를 적는다. 유지 계약은 [시스템 오디오 수신 소유](system-audio-receive-ownership.md)와 registry RO-04다.

## 오너 결정

- **2026-10-25 약 04:00 KST, Phase 5 추천안 전부:** 5B에 관한 것은 P5-D3 A(앱 업데이트 두 번, 5B는 동작 변경을
  증분마다 실패 테스트와 라벨로), P5-D5 A(C4-0 틈을 라벨 붙인 묶음으로 고치고 단위 근거를 받아들임), P5-D11 B(C4-13을
  5B에 넣고 F3 단위 재현을 실패 테스트로 씀), P5-D8 A(attachEpoch 울타리 없음)다. P5-D10(수신 패리티)은 답이 없어 기본값
  A(패리티를 바꾸지 않고 RO-04에 표로 적음), P5-D12와 P5-D13은 기본값 A(Phase 5에 넣지 않음)로 갔다.
- **약 01:50 KST, 배포 시점과 기기 게이트:** 자동 게이트가 통과하면 바로 내고, 기기 근거는 코드 게이트가 아니다. 그래서
  증분마다 기기 기대값을 결과보다 먼저 고정해 두고(아래 [기기 기대값](#기기-기대값-결과보다-먼저-고정)), 오너가 나중에
  기기 세션에서 쓴다.
- **약 16:40 KST, 옛 버전 정책:** 옛 앱 버전과의 혼합 호환은 더 이상 설계 제약이 아니다. 5B는 그래서 시스템 오디오
  파일에 있는 옛 버전 항목도 맡는다. 강제 업데이트 열차가 floor 787을 켠 뒤에 나가지만, 이 빌드가 보내는 모든 프레임은
  9.0.12/9.0.13의 정확한 키 수신기도 받아야 한다는 규칙은 그대로 지켰다.
- **2026-10-26 약 14:10 KST, '1 and 2, go':** 5B와 옛 버전 제거 2차를 병렬로 진행한다. 제거 2차는 OV-A04, OV-B05,
  OV-B06, SA-9, OV-A08(시스템 오디오 부분), 코디네이터 잔재를 맡지 않는다(5B 몫). 게스트의
  `SYSTEM_AUDIO_SFU_CAPABILITY` 보내기(OV-F06)는 5B 이상의 floor 뒤 열차로 남는다.

## 계획과 비평

계획은 2판까지 갔다. 계획 비평 2(2026-10-26, 판정 '바꿀 것')의 일곱 지적을 `4d7650c0`에서 하나씩 확인했고, 모두
받아들이되 둘은 좁혔다.

| #   | 무게 | 지적                                                                                                                     | 처리                                                                                                                                                                                                             |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 중간 | G1에서 일반방 직접 통화를 닫으면 방장이 게스트를 SFU로 넘기며 STOP, START, READY를 보내고, 그 START가 후속 주인을 멈춘다 | 확인. 거절된 직접 통화는 닫지 않고 열린 채 두며, STOP이나 수신 끝이 닫는다. 짝 하네스는 만들지 않고 두 행을 합쳐 보인다(Standard S9 행의 `closeCount()` 0, 방장 쪽 '열린 통화는 60초 동안 handoff 없음' 가드 행) |
| 2   | 중간 | G2에서 구독 진행 중에 PRO SFU 구독자를 멈추면 `connection_unstable`과 재시도가 나온다                                    | 확인. 끝낸 발행 표시로 reconcile catch와 재시도 catch를 막고, 실제 전송 행(트랙 노출과 구독 완료 사이의 force-stop과 후속 주인)을 더함                                                                           |
| 3   | 중간 | G6의 기기 문구가 LAN-direct 중지마다 생기는 대기 창(스피너, 재생 아이콘 꺼짐, 잠금 화면 '일시정지')을 숨겼다             | 확인. 틈 11은 interrupt가 아니라 end로 바꿨고, 틈 12는 interrupt로 둠(이유는 G6 절)                                                                                                                              |
| 4   | 낮음 | G2 '보이면' 문구: force-stop된 코디네이터 source는 조용하지 않고 계속 들린다                                             | 확인. 틈 4(유휴 화면 아래 계속 들림)와 틈 5(조용, 열린 구독)로 나눠 적음                                                                                                                                         |
| 5   | 낮음 | G1은 수신 중 자리표시가 늘 현재라고 보지만, 메타를 null로 쓰는 두 곳이 있다                                              | 확인. 거절된 resume과 attach도 그 경로의 source와 프라이머를 떼고, 남는 창은 G1 위험에 적음                                                                                                                      |
| 6   | 낮음 | G4의 가드 없는 코디네이터 end는 공유자 heartbeat마다 돈다. 가드 행은 공유 claim이 살아 있을 때만 앞뒤로 통과한다         | 확인. 슬롯 질의로 자기 발행의 end만 가두고(청취자 경로는 그대로), 유휴 상태의 낡은 공유 제목 행을 새로 더함                                                                                                      |
| 7   | 낮음 | 낡은 수치, 미뤄 둔 기록 줄, OV-B06 수신 행이 'direct' 경로만 봄                                                          | 확인. room-authority 82 → 81, 호환 줄을 계획 §8에 모아 기록 갱신으로 넘김, STOP→START→READY('unselected') 변형 행 추가                                                                                           |

## 제품·런타임 증분

### 5B-G1 붙이기 울타리 (틈 2, 3)

테스트 `1f8c7a66`, 코드 `e74e10da`. 슬롯은 자기 수신 자리표시가 현재 메타일 때만 붙이고 다시 이어 붙인다.
`attachSystemAudioSource`는 `'attached' | 'not-receiving' | 'graph-unavailable'`을 돌려주고(전에는 boolean), 울타리를
그래프보다 먼저 본다. 거절된 붙이기와 resume은 아무것도 쓰지 않고 그 경로의 이전 source와 프라이머를 뗀다. 울타리는
자리표시만 보고 `slot.phase`는 보지 않는다(P5-D8 A, attachEpoch 없음).

- 경로의 반응: 일반방 직접 통화는 통화를 열어 둔 채 현재로 두고 교체 기한만 지운다(비평 1). 일반방 SFU는 신뢰 경계
  거절 때처럼 구독을 닫는다. PRO 코디네이터는 조용히 돌아간다(SFU 정리는 G2).
- 받아들인 남은 경우(계획의 G1 위험, 리뷰에서 다시 확인): 일반방 게스트가 받는 중에 현재 항목 삭제(`player/playlist.ts`의
  삭제, 비우기, 다시 기준 잡기)가 메타를 null로 써서 자리표시가 없어진 창에서 교체 직접 통화의 붙이기가 거절되면, 슬롯은 이전
  통화의 source를 떼지만 `systemAudio.isReceiving`은 켜 둔 채이고 게스트는 교체 기한도 지운다. 그래서 방장의 STOP까지
  기한 없이 무음인 채 공유 재생으로 보인다. 방장 자신의 삭제가 먼저 캡처를 멈추므로(삭제는 다음 항목을 틀거나 대기열을
  비우고, START는 대기열 권한에 묶임) 그 창은 왕복 한 번쯤이다. RO-04에 적었다.
- 테스트 먼저: Standard S9(직접, SFU), PRO S8b(LAN-direct), PRO S9 두 경로, transport S8b 두 경로를 뒤집고 슬롯 울타리
  행을 더했다. 바꾸기 전 코드에서 13행 실패, 방장 가드 행('열린 직접 통화는 닫힘이나 오류 없이 60초 동안 SFU handoff 없음')은
  앞뒤로 통과.
- 기기 기대값: 기기에서 재현할 수 없다(후속 주인이나 force-stop이 최대 500 ms의 `initAudio()` 창 안에 와야 함).

### 5B-G2 PRO force-stop과 후속 주인 정리 (틈 4, 5)

테스트 `09a5743f`, 코드 `bf80584d`, 리뷰 `b0234155`. 바뀌지 않은 발행의 수신이 끝나면 PRO 코디네이터도 자기 경로를
끝낸다.

- force-stop(틈 4): 서비스의 `system-audio:force-stop` 리스너가, 코디네이터가 원격 발행의 키를 쥐고 있으면 대기 재시도,
  끊김 유예, 직접 수신 마감을 지우고 경로를 떼며 진행 중인 구독을 버리고 SFU 구독자를 멈추고 그 발행을 끝냄으로 표시한다
  (`coordinatorEndedKey`). 코디네이터 자기 시작 안의 force-stop은 두 `beginTrustedSystemAudioReception` 호출을 감싼 깊이
  카운터로 가린다(CHECK 4 기준점은 그대로).
- 거절된 SFU 트랙(틈 5): 신뢰 경계나 울타리가 살아 있는 발행의 SFU 트랙을 거절하면 같은 식으로 끝낸다(재시도, 알림 없음).
  LAN-direct 수신 경로는 열어 둔다(조용히 닫으면 발행자가 공유 전체를 SFU로 올리고, 'stopped'로 닫으면 다시 제안을 부르며,
  열린 경로는 Cloudflare 트래픽이 없다. RO-04에 기록).
- 끝낸 키에서는 heartbeat, 방 문맥 재발행, 재시도가 구독도 시작도 다시 하지 않는다. 키가 바뀌면 `cleanupCoordinatorGraph`가
  표시를 지운다. 구독 진행 중의 멈춤은 실패가 아니다(비평 2).
- 테스트 먼저: 바꾸기 전 코드에서 8행 실패(PRO 5, transport 3), 가드 두 행 통과. 리뷰 반영(`b0234155`): 틈 4의 LAN-direct
  절반에 행이 없었다. force-stop 행을 SFU와 LAN-direct의 it.each로 바꿨고, 열린 LAN-direct 경로에서 나중의 수신 fallback이
  `connection_unstable`을 한 번 보이는 것과 거절된 resume 뒤 SFU 구독이 공유 끝까지 열려 있는 것을 받아들인 경우로 고정했다.
- 기기 기대값: 재현할 수 없다(PRO 청취자의 force-stop은 거의 나가기에서만 오고, 그때는 서비스 초기화가 먼저 돈다). 보이면
  전에는 유휴 화면 아래에서 공유가 방 초기화까지 들렸고, 뒤에는 force-stop에서 소리와 구독이 멈춘다.

### 5B-G3 일반방 SFU 재발행 (틈 1)

테스트 `0e451e80`, 코드 `a2894382`. 방장이 다시 발행하는 동안 게스트가 SFU로 받다가 새 구독이 붙기 전에 실패하면(대기 READY
없는 구독 실패, 구독자 PC의 'failed') 전에는 STOP까지 무음 '재생'이 남았다. 이제 그 구독이 아무것도 붙이지 않았고 슬롯이
수신 중이면 `failGuestSfuSubscription`이 수신을 슬롯 마감으로 넘긴다(자리표시와 복원점 유지, receiving false, 실패
시각부터 30초).

- 선택: 바로 `receive_failed`로 끝내지 않고 마감으로 넘긴다. 실패한 구독이 수신을 잇는 기존 SFU 의미(S3 handoff)이고,
  그대로 두는 틈 13과 맞으며, 30초 안의 READY가 아직 붙일 수 있고, 새 타이머, 알림, 프레임이 없다.
- 테스트 먼저: 바꾸기 전 코드에서 3행 실패, 가드 한 행 통과.
- 기기 기대값: 재현할 수 없다. 보이면 전에는 방장이 멈출 때까지 무음 재생, 뒤에는 대기 자리표시, 30초 뒤
  `system_audio.receive_failed`와 이전 제목(그 30초 안에 READY가 오면 알림 없이 소리가 돌아옴).

### 5B-G4 공유자 자신의 claim (틈 6)

테스트 `c29dc8ec`, 코드 `8a2c7164`, 리뷰 `98c4b040`. `'system-audio'` 재생 주인은 슬롯의 claim이기도 하고 이 기기 자신의
공유이기도 하다.

- `endTrustedSystemAudioReception`은 복원점 소비, 대기 응답, 마감 해제, 경로 포트, receiving 내림은 그대로 하되, 제목 쓰기,
  주인 놓기, idle은 자리표시가 현재이거나 주인 메타가 공유자의 것(`systemAudioMode === 'sharing'`)이 아닐 때만 한다.
- `commitTrustedSystemAudioReception`은 공유자의 메타를 복원점으로 잡지 않는다.
- 새 읽기 전용 질의 `hasTrustedSystemAudioReception()`. `cleanupCoordinatorGraph`는 자기 발행에서 슬롯이 아직 수신을
  쥘 때만 end를 부른다(비평 6. 가드 없이 두면 공유자 heartbeat마다 세대가 오르고 `/debug sa` 'cleanup:'이 찍힌다).
- 테스트 먼저: 바꾸기 전 코드에서 7행 실패(guest 3, PRO 3, service 1), 가드 두 행 통과. 리뷰 반영(`98c4b040`): PRO
  공유자의 SFU 발행자 복구(리스 해제와 재획득) 길도 이 규칙이 바꾼다는 것을 찾았다. 전에는 해제의 idle 뷰가 공유자 claim을
  놓아 공유가 계속되는 동안 플레이어가 제목 없는 idle로 남았고, 이제 'System Audio Sharing'과 재생 상태를 유지한다. 그
  길을 고정하는 PRO 행과 service 행을 더했다(부모 소스에서 PRO 행 실패 확인).
- 기기 기대값: 재현할 수 없다(둘째 데스크톱 공유자가 필요). 리뷰가 찾은 길은 선택 확인이다(아래 기기 기대값).

### 5B-G5 중첩된 end가 시작의 복원점을 지킴 (틈 7)

테스트 `fefac7a7`, 코드 `b4b724b9`. 시작의 `stopAllMedia`가 로컬 캡처 중 force-stop을 내면 그 guest 리스너의 end가 시작
안에서 돈다. 전에는 그 end가 시작의 복원점을 소비하고 세대를 넘겨, STOP이나 공유 끝에 제목이 없었고 그 뒤 열린 경계 대기가
아무도 커밋하지 않는 세대에 붙었다. 이제 슬롯이 `'claiming'`이고 자리표시가 아직 없을 때의 end는 그 시작 앞의 것만
끝낸다(대기 응답, 마감 해제, 경로 포트, receiving 내림은 그대로, 제목 쓰기 없음).

- 그대로 둔 것: LAN-direct에서 직접 수신 마감은 시작이 돌아온 뒤 켜지므로 중첩 force-stop이 지우지 못한다(30초에 알림 한
  번, 늦은 트랙은 붙음).
- 테스트 먼저: 바꾸기 전 코드에서 2행 실패, 가드 행과 질의 행 통과.
- 기기 기대값: 보이는 변화 없음(운영에서 중첩 end는 공유 중이던 PRO 기기에서만 생기고, G4 뒤 그 시작은 복원점을 잡지 않음).

### 5B-G6 슬롯이 경로 닫힘을 들음 (틈 11, 12)

테스트 `9336aeb2`, 코드 `95b04ea3`, 리뷰 `99b335b6`.

- 틈 11, end: 직접 전송이 로컬 콜백 `onLiveRouteStopped({ participantId, generation, publicationId })`를 얻었다. 발행자의
  `'stopped'` 닫힘이 현재 수신 경로를 닫으면 서비스가 살아 있는 직접 발행을 확인하고 직접 수신 마감을 지우고 경로를 떼며
  슬롯이 수신을 쥐고 있으면 끝낸다(알림 없음, 발행 키 유지). interrupt가 아니라 end인 이유: interrupt는 자리표시를 남긴 채
  receiving을 내려 모든 LAN-direct 청취자에게 대기 상태(재생 버튼 스피너, Media Session 'paused')를 보인다(비평 3).
- 틈 12, interrupt: SFU 이벤트 처리기가 살아 있는 원격 발행의 만료된 descriptor(`expiresAt <= now`)에 대한
  `subscriber-state: 'stopped'`만 받아 source를 떼고 `'route'`로 interrupt한다(알림 없음). 코디네이터 자기 멈춤은 만료 전
  descriptor라 무시한다.
- 리뷰 반영(`99b335b6`): 틈 12 기록의 전제가 틀렸다. 구독자 예산 만료는 승격 뒤에만 오는 것이 아니라, 두 시간 제한에 닿는
  모든 PRO SFU 공유 끝에서 보통 서버 idle 상태보다 먼저 온다. interrupt는 유지하고 이유를 고쳐 적었으며, 승격 없는 두 시간
  끝 행과 service 행을 더했다.
- 테스트 먼저: 바꾸기 전 코드에서 3행 실패(transport 37/40 통과), 가드 두 행 통과.
- 기기 기대값: 아래 [기기 기대값](#기기-기대값-결과보다-먼저-고정)의 LAN-direct 중지와 두 시간 끝.

### 5B-C4-13 숨김 중 공유 끝 뒤 복귀 수리 한 번 (틈 10, F3)

테스트 `29e5fb72`, 코드 `c852c465`. `src/pro-room/runtime.ts`만 바꾼다(RO-21, 복귀 수리 권한). 첫 복원이 실패한 채 페이지가
숨겨진 동안 공유가 끝나면, 보일 때 같은 revision이 두 번 arm됐다(공유 뒤 복원, 그 뒤에 줄 선 전경 수리).

- 복원 콜백은 자기 reconcile이 적용됐고 liveness가 현재이며 페이지가 보이고 시작 뒤 숨김이 없을 때 그 복귀를 reconcile된
  것으로 표시한다. `recoverVisibleProRoomPlayback`은 자기 owner로 reconcile하고, 표시된 복귀면 재시도 대신 정리한다. 재시도
  사다리는 그대로다.
- 라벨 틈 밖의 좁은 동작 변화 하나(계획이 적은 위험, RO-21과 `c852c465` 메시지): 전경 수리가 자기 owner를 가지므로 그
  수리 도중 누른 수동 Sync는 합류하지 않고 뒤에 줄 선다. 전에는 이미 모든 매체로 넓혀진 수리에만 합류했다. 기기 단계는
  없고 `runtime-server-playback.test.ts`(합류 행 'joins an in-flight YouTube visibility pass …' 포함)는 그대로 통과한다.
- 테스트 먼저: F3 행 뒤집기, 바꾸기 전 코드에서 F3 행 실패(나머지 통과). 코드 커밋에서 새 행 하나를 더해 2/10 실패 →
  10/10 통과. 고치지 않고 오늘 동작으로 고정한 것: 보인 뒤 복원이 다시 실패하고 전경 수리가 먼저 적용되면 복원 재시도가 한
  번 더 arm한다.
- 기록: RO-21은 owner-in-place, RO-41 삭제(46 → 45 기록).
- 기기 기대값: 5P-5(아래).

### 5B-OV1 인증 없는 PRO 상태 경로와 코디네이터 잔재 (중립, OV-A04, OV-A03 메모)

테스트 `3fd45d5b`, 코드 `7293697f`.

- OV-A04: `pro-room/system-audio-controller.ts`의 `acceptProSystemAudioState`(8.3.72부터 운영 호출자 없음)와
  `#acceptParsedState`의 `authenticated` 인자를 지웠다. 직접→SFU, 낡은 SFU→직접 규칙은 그대로다.
- 코디네이터 잔재: `ensureCoordinatorSubscription` 맨 위의 `adoptSystemAudioReceiveRoute('pro-coordinator')`를 지웠다. PRO
  방은 Standard SFU 구독을 시작하지 않으므로(`network.hostConn`이 null) 빈 경로를 은퇴시키던 것이다. 방 문맥 adopt와 재시도
  정리 adopt는 남는다.
- 테스트 먼저(앞뒤로 통과): controller 행을 인증 heartbeat 경로로 옮기고, PRO 가드 행 'PRO 방에 온 Standard READY는 Standard
  구독을 시작하지 않는다'. 코드 커밋에서 service 행 하나가 남은 adopt 위치를 세도록 바뀌었다(부모에서 실패).
- 기기 기대값: 없음(닿는 호출자 없음).

### 5B-OV2 LAN 게스트 SFU 능력 협상의 방장 쪽과 'all' 울타리 (옛 버전, OV-B05, OV-B06)

테스트 `43b21ea1`, 코드 `04f07124`.

- OV-B05: 방장은 모든 LAN 게스트를 SFU 가능으로 본다. `system-audio-delivery.ts`의 능력 집합과 그 export 셋, 능력 순서,
  `'unsupported'` 결과, 승격의 능력 게이트, 스냅샷 키를 지웠다. `handleSfuCapability`와 등록을 지웠다(프레임은 검사기를
  지나 처리기 없이 버려진다. MSG 형식과 검사기는 게스트가 아직 보내므로 남는다). `peer.ts`의 import와 초기화 셋도 지웠다.
  room-authority 직접 읽기는 82 → 81.
- OV-B06: `makeReadyMessage`는 늘 그 피어의 고정 audience를 보낸다. 직접 경로가 실패한 원격 피어는 `'all'` 대신
  `{ audience: 'remote', handoffFromDirect: true }`를 받는다. 받아들인 남은 차이(리뷰, 낮음): 표지는 처음 보내기에
  성공한 READY에만 실린다. 제한 중이라 표지 READY를 무시해 경로가 'unselected'로 남은 게스트가 방장과 달리 자신을
  'local'로 분류하면, 표지 없이 다시 보낸 `'remote'` READY를 버린다. 옛 `'all'` 울타리는 이를 통과시켰다. 제한된 게스트와
  엇갈린 연결 분류가 함께 필요하고 조사서가 OV-B06을 낮음으로 본다.
- SA-2(STOP→START 뒤 handoff READY)는 그대로 둔다. 9.0.12/9.0.13 게스트도 그 쌍이 필요하다(READY 처리기는 'direct'
  경로에서만 다시 시작하고 현재 메타의 surface를 씀). 지우려면 게스트 변경, 그 빌드의 floor, 방장 변경이 차례로 필요하다.
  `system-audio-host.ts`의 오해를 부르던 주석만 고쳤다. SA-8(오류 이름과 문구)은 범위 밖이다.
- 테스트 먼저: 바꾸기 전 코드에서 18행 실패(delivery 8, host 3, sfu 5, start 2). Standard 묶음의 OV-B06 수신 행 둘(경로
  'direct'와, 방장의 STOP과 START 뒤 'unselected')은 앞뒤로 통과한다. 이것이 새 READY를 받는 9.0.12/9.0.13 게스트 코드다.
- 기기 기대값: 없음(LAN 게스트 여덟 넘게, 표지 없는 LAN 게스트, 강제 직접 실패가 필요하고 오늘 방은 4대).

### 5B-OV3 START surface와 READY audience 필수, 채널 인자 정리 (옛 버전 OV-A08, 중립 SA-9)

테스트 `1ab5f0b8`, 코드 `fddbda0a`(옛 버전), `c0b86b62`(중립).

- OV-A08: `protocol.ts`의 START 검사기는 `surface`를 16자 이하 문자열로 요구하고(전에는 선택), SFU_READY 검사기는
  `audience`('remote' 또는 'all')를 요구한다. `types/index.ts`의 두 payload 형식도 필수가 됐다. `normalizeSfuReadyPayload`는
  빠진 audience를 'remote'로 채우지 않고 복사한다(다른 모양 검사처럼 없으면 거절). `tracks` 울타리와
  `normalizeSystemAudioSurface`의 모르는 값 처리('display')는 그대로다.
- 보내는 쪽 확인: 두 프레임을 만드는 곳은 `createSystemAudioStartFrame`과 `makeReadyMessage`뿐이고, 9.0.12(`78e9ee98`)와
  9.0.13(`4d7650c0`)에서 `2038b51f` 이전부터 바뀌지 않았다(`git log -L`, 두 빌드의 `git grep`). 9.0.14(`dd9c9d4d`)는 그
  파일들을 건드리지 않는다. START 보내는 자리는 다섯이다(`system-capture.ts`, 방장 셋, `player/playback.ts`. SFU 모듈의 것은
  5B-OV2에서 없어짐).
- 테스트 먼저: `protocol.test.ts`의 'START without surface 거절'과 'READY without audience 거절'이 바꾸기 전 코드에서 실패
  (network, pro-room, player, audio 258 files 중 이 2행만 실패). 앞뒤로 통과: 모르는 짧은 surface는 지나가 'display'로
  읽히고 17자, 숫자, null, 객체는 거절, audience와 track 옆에 `tracks`가 있는 READY는 계속 거절. 고정물 정리(앞뒤로 통과):
  `handleData`에 넣는 원시 START 52곳에 `surface: 'display'`(guest 43, queue-authority 2, PRO 2, evidence-logs, peer,
  file-prepare-pause, Standard와 lifecycle의 `start()` 도우미), SFU 단위 묶음이 처리기에 바로 넣던 READY 넷에
  `audience: 'remote'`.
- SA-9(중립): `system-audio:incoming-call`의 채널 인자를 지웠다(형식, `peer.ts`의 emit, guest 리스너의 옛 형식 갈래, 채널별
  getter/setter와 'Ignored unsupported channel call' 갈래, 채널 키 교체 감시 맵과 디버그 맵). 'STEREO' 상수는 로그 줄,
  타이머 이름(`sys-audio-guest-replacement-watchdog-STEREO`, `sys-audio-guest-trust-gate-STEREO-<n>`), `/debug sa` 채널
  기록에 남는다. SFU 모듈 리스너는 이미 인자가 없었다. 테스트 emit 43곳이 둘째 인자를 버렸다(guest 36, sfu 4, Standard,
  lifecycle, evidence-logs). 중립 근거: 수신 판독 줄 묶음과 `/debug sa` 고정이 그대로 통과하고, `setManagedTimer`를 잠시
  계측해(커밋 안 함) 실제 타이머 모듈을 쓰는 시스템 오디오 여덟 묶음이 부모(`fddbda0a`)와 이 커밋에서 같은 타이머 이름 424개
  다중집합을 쓰는 것을 확인했다.
- 기기 기대값: 없음. 지금 보내는 쪽은 모두 두 필드를 넣으므로 어느 기기도 차이를 보지 않고, 엄격해진 검사는 floor 787 아래
  클라이언트의 프레임에만 닿는다. SA-9는 로그, 타이머, `/debug sa`가 같다.

## 그대로 둔 것

- 틈 8, 13, 14(알림 차이)와 틈 9(승격 때 시작 다시)는 P5-D5 A의 묶음 밖이다. 그 틈을 고정한 행(Standard 'a live
  subscriber connection failure …', lifecycle의 'expected today: …' 행들, PRO 'S7: a direct-to-SFU promotion …')은
  `4d7650c0`과 `c0b86b62` 사이에 제목과 단언이 그대로다(5B-OV3의 START 고정물과 emit 인자만 바뀜). 라운드 2에서 모든 코드
  커밋에서 통과한다.
- P5-D10 A: 수신 패리티는 바꾸지 않고 RO-04에 표로 적었다(5B-G1 코드 커밋, 5B-G2와 5B-G6이 마지막 두 줄을 채움).
- SA-2는 유지(5B-OV2 절), SA-8은 범위 밖, P5-D12와 P5-D13은 Phase 5에 넣지 않는다.
- 오너께 드리는 관찰(고치지 않음, C4-0 틈과 P5-D5 묶음 밖): 일반방 직접 통화의 기존 신뢰 경계 거절
  (`system-audio-guest.ts`, START가 30초 안에 커밋하지 않은 스트림)은 통화를 닫고, 그러면 방장이 STOP, START, READY로 게스트를
  SFU로 넘긴다. 공유가 계속되는 동안 대기 자리표시 중에 후속 주인이 재생을 잡았다면 그 START가 다시 시작해 후속 주인을
  멈춘다. 비평 1과 같은 구조지만 오늘 동작이고 G1은 건드리지 않는다.

## 호환과 혼합 버전

릴리스 기록의 5B 항목(AGENTS.md: 호환이 바뀜)에 넣은 줄이다. main 합침 뒤 이 브랜치에서 `docs/release-record.md` §2의
5B 배포 전 항목에 넣었다. 9.0.14(`dd9c9d4d`), 릴리스 W(`a3893f04`), 릴리스 A(`5dd7cc1f`, 9.0.15)는 시스템 오디오
파일(`src/network/system-audio-*`, `peer.ts`, PRO 시스템 오디오 컨트롤러와 서비스, 직접 전송)을 건드리지 않았고,
릴리스 A가 고친 `protocol.ts`와 `types/index.ts`의 자리는 시스템 오디오 밖의 검사기와 형식이다(`4d7650c0`과 `5dd7cc1f`
사이의 diff). 그래서 아래의 9.0.12/9.0.13 판정은 9.0.14와 9.0.15에도 그대로다.

- OV-B06: 이 빌드의 방장은 직접 경로가 실패한 원격 피어에 READY `{ audience: 'remote', handoffFromDirect: true }`를
  보낸다(전에는 `'all'`). 9.0.12~9.0.15 게스트는 이를 받아 'direct'와 'unselected' 두 경로에서 처리한다. `'all'` 울타리에
  기대던 것은 floor 아래의 8.4.38~8.4.39 게스트뿐이다.
- OV-B05: 방장은 `SYSTEM_AUDIO_SFU_CAPABILITY`를 무시하고(처리기 없음, 프레임은 검사 뒤 버려짐) 모든 LAN 피어를 SFU 가능으로
  본다. 이 빌드의 게스트는 나중 floor까지 표지를 계속 보낸다(OV-F06). 지금 모든 게스트가 보내므로 오늘 결과는 같다.
- OV-A08: 이 빌드의 수신기는 `surface` 없는 START와 `audience` 없는 SFU_READY를 거절한다. 9.0.12~9.0.15의 모든 보내는
  쪽이 둘 다 넣는다. 모르는 짧은 surface는 계속 받아 'display'로 읽는다.
- OV-A04: PRO 시스템 오디오 컨트롤러의 인증 없는 피어 fan-out 수신 경로가 없어졌다(8.3.72부터 운영 호출자 없음).
- G1~G6, C4-13, SA-9, 코디네이터 잔재는 프레임을 바꾸지 않는다. G6은 로컬 전송 콜백 하나를 더한다. 이 빌드가 보내는 모든
  프레임은 9.0.12~9.0.15 정확한 키 수신기가 받는다.
- 부분 릴리스: 9.0.15 이하 방장과 5B 게스트에서는 방장이 START에 `surface`, READY에 `audience`를 늘 넣는다(받음). 5B 방장과
  9.0.15 이하 게스트에서는 위의 READY(받음). floor 787부터 9.0.13 이하는 새 입장과 재접속에서 거절되므로, 운영에서
  남는 혼합은 9.0.14, 릴리스 A(9.0.15)와 5B 사이다.

옛 버전 항목마다 누가 무엇을 잃는지는 다음과 같다(옛 버전 호환 조사 2026-10-25의 영향 열을 이 브랜치 코드로 다시 확인).
'floor 아래'인 클라이언트는 최소 앱 빌드 787(2026-10-26 16:15 KST)부터 새 입장과 재접속에서 거절되므로, 그 앞에 맺어
아직 열린 세션이나 floor 읽기가 0이 되는 창(보고가 5분 넘게 멈춤)에서만 닿는다.

| 항목                  | 닿는 클라이언트                                                                                             | 잃는 것                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| OV-A04                | 없음(fan-out은 7.0.0에서 사라졌고 마지막 호출자는 8.3.72에서 인증 경로로 바뀜)                              | 없음                                                                                                                                     |
| 코디네이터 잔재       | 없음(PRO 방은 Standard SFU 구독을 시작하지 않음, `network.hostConn` null)                                   | 없음                                                                                                                                     |
| OV-B05                | 8.4.38 전 LAN 게스트(8.3.16~8.4.37, v1 표지), floor 아래                                                    | LAN 직접 실패 때 STOP(유휴) 대신 버리는 v2 READY를 받아 30초 뒤 `receive_failed`. 전에도 소리는 없었다                                   |
| OV-B06                | 8.4.38~8.4.39 원격 게스트, floor 아래                                                                       | 직접 실패 뒤 늦은 직접 통화가 SFU를 이길 수 있다(실패 경로). 8.4.40 이상은 `guestRejectLateDirectRoute`가 같은 일을 한다                 |
| OV-A08(시스템 오디오) | `surface` 없는 START를 보내던 8.4.29 전 방장, `audience` 없는 READY를 보내던 7.0.0 v1 시절 방장, floor 아래 | 그런 방장이 floor 전에 연 방에 5B 게스트가 들어가면 그 START나 READY를 거절해 시스템 오디오를 받지 못한다. 9.0.14 게스트는 그대로 받는다 |
| SA-9                  | 없음(채널 배관은 `peer.ts`가 이미 걸러 어떤 버전도 섬기지 않음)                                             | 없음                                                                                                                                     |

## QA 라운드

### 1. 증분별 (2026-10-26 15:33 ~ 2026-10-27 03:24 KST)

| 검사            | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 테스트 먼저     | 위 증분 절. 동작 증분마다 뒤집은 행과 새 행은 부모 코드에서 실패했고(G1 13, G2 8, G3 3, G4 7, G5 2, G6 3, C4-13 1, OV2 18, OV3 2), 코드 커밋 뒤 수정 없이 통과했다. 가드 행은 앞뒤로 통과했다. OV1은 중립이라 테스트 먼저 행이 앞뒤로 통과하고, 코드 커밋이 adopt 수를 세던 service 단위 행 하나를 남은 두 자리로 고쳤다(부모에서 실패). SA-9는 단언을 바꾸지 않고 emit 인자만 바꿨다. |
| 변이 검사       | G2, G3, G4, G5, G6, C4-13 커밋 메시지에 적은 변이(조건 하나씩 빼기)가 각각 예상한 행을 실패시켰다.                                                                                                                                                                                                                                                                                     |
| 단위 전체       | 커밋 메시지에 남은 실행: G5 15,667, G6 15,672, G6 리뷰 15,674, C4-13 15,680, OV2 15,690, OV3 코드와 SA-9 15,693(모두 672 files, `--maxWorkers=6`, PASS). G1~G4와 OV1의 전체 수는 메시지에 없다. 이 빈칸은 아래 라운드 2로 메운다.                                                                                                                                                      |
| 핵심 커버리지   | G5, G6(87 files / 3,306), C4-13(3,313), OV2와 SA-9(3,317). 하한은 내리지 않았다.                                                                                                                                                                                                                                                                                                       |
| 정적과 가드     | 런타임 증분마다 `tsc --noEmit`, `typecheck:tests`, `check:workers`, `lint`, `format:check`, resource-ownership, dead-exports(20/20, 76/76, fully dead 0), import-graph, bus-pairing(202/202), lifecycle-writes, room-authority(82, OV2부터 81), transport-health. `guard:sw-cache-version`은 bump 전이라 설계대로 돌리지 않았다.                                                       |
| 빌드와 예산     | G6, C4-13, OV2, OV3에서 `build`와 `guard:initial-transfer-budget` PASS(아래 [초기 JS 예산](#초기-js-예산)).                                                                                                                                                                                                                                                                            |
| 로컬 Playwright | OV2(`04f07124`)와 SA-9(`c0b86b62`) 뒤 `e2e/system-audio-controls.test.ts` 5/5.                                                                                                                                                                                                                                                                                                         |

### 2. 열차 끝 다시 돌리기 (2026-10-27)

G1~G4와 OV1의 전체 실행 수가 커밋에 남지 않았으므로, 열차 끝에 기준과 모든 코드 커밋을 차례로 꺼내(`git checkout
--detach`) 시스템 오디오 묶음 26 files를 같은 기계에서 다시 돌렸다(`--maxWorkers=6`). 묶음은
`src/network/__tests__/*system-audio*.test.ts`, `src/pro-room/__tests__/*system-audio*.test.ts`, `protocol.test.ts`,
`peer.test.ts`, `src/pro-room/__tests__/runtime-server-playback.test.ts`이고, 네 수신 슬롯 계약 묶음, guest, sfu, host,
service, subscriber-watchdog, runtime-system-audio-join, 두 판독 줄 묶음이 모두 들어 있다. 실패와 건너뜀은 없다.

| 코드 SHA   | 증분                 | 결과                      |
| ---------- | -------------------- | ------------------------- |
| `4d7650c0` | 기준(9.0.13 런타임)  | 26 files / 744 tests PASS |
| `e74e10da` | 5B-G1                | 26 / 752 PASS             |
| `b0234155` | 5B-G2(리뷰 반영까지) | 26 / 758 PASS             |
| `a2894382` | 5B-G3                | 26 / 761 PASS             |
| `98c4b040` | 5B-G4(리뷰 반영까지) | 26 / 772 PASS             |
| `b4b724b9` | 5B-G5                | 26 / 774 PASS             |
| `99b335b6` | 5B-G6(리뷰 반영까지) | 26 / 781 PASS             |
| `c852c465` | 5B-C4-13             | 26 / 787 PASS             |
| `7293697f` | 5B-OV1               | 26 / 791 PASS             |
| `04f07124` | 5B-OV2               | 26 / 797 PASS             |
| `fddbda0a` | 5B-OV3 옛 버전       | 26 / 800 PASS             |
| `c0b86b62` | 5B-OV3 중립(SA-9)    | 26 / 800 PASS             |

한계: 이 라운드는 시스템 오디오 묶음만 다시 돌렸다. 단위 전체는 라운드 1에 적은 커밋과 라운드 3에서만 돌았다. 중간 커밋
(`bf80584d`, `8a2c7164`, `95b04ea3`)은 다음 리뷰 반영 커밋이 테스트만 더하거나 주석만 바꾸므로 따로 돌리지 않았다.

### 3. 5B-OV3 마지막 검사 (`c0b86b62`, 2026-10-27)

| 검사            | 결과                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 단위 전체       | 672 files / 15,693 tests PASS(`--maxWorkers=6`).                                                                                                                                                                                               |
| 핵심 커버리지   | `test:coverage:critical` 87 files / 3,317 tests PASS, 하한 그대로.                                                                                                                                                                             |
| 정적            | `tsc --noEmit`, `typecheck:tests`, `check:workers`, `lint`, `format:check` PASS.                                                                                                                                                               |
| 가드            | resource-ownership(45 기록, CHECK 9 쓰기 3·3·3·1), dead-exports(테스트 전용 20/20, 자기만 76/76, fully dead 0), import-graph(397 files, 순환 0), bus-pairing(202/202), lifecycle-writes, room-authority-boundaries(81), transport-health PASS. |
| 빌드와 예산     | `build`와 `guard:initial-transfer-budget` PASS.                                                                                                                                                                                                |
| 로컬 Playwright | `e2e/system-audio-controls.test.ts` 5/5(`build:e2e` 뒤 Chromium).                                                                                                                                                                              |
| 하지 않은 것    | `guard:sw-cache-version`(bump 전 설계대로 실패), main 합침 뒤 다시 돌리기(출시 준비), PR CI, exact-main CI, 릴리스 smoke.                                                                                                                      |

### 4. 열차 끝 레인 검사 (`dfed3993`, 2026-10-27 05:23 ~ 05:40 KST)

`dfed3993`은 `c0b86b62` 위의 문서 커밋(이 보고서와 기록)이라 코드는 라운드 3과 같다. 같은 기계에서 레인 검사 묶음을
처음부터 다시 돌렸다(`build:e2e` 뒤).

| 검사               | 결과                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 정적               | `typecheck`(전체 체인), `typecheck:tests`, `check:workers`, `lint`, `format:check` PASS.                                                                                                                                                                                                                                                                                                                                  |
| 단위 전체          | 672 files / 15,693 tests PASS(`--maxWorkers=6`). Workers 설정 60 files / 2,914 tests PASS.                                                                                                                                                                                                                                                                                                                                |
| 핵심 커버리지      | `test:coverage:critical` 87 files / 3,317 tests PASS, 하한 그대로.                                                                                                                                                                                                                                                                                                                                                        |
| 가드               | navigation-sinks, dead-exports(테스트 전용 20/20, 자기만 76/76, fully dead 0), bus-pairing, import-graph(397 files, 순환 0), lifecycle-writes, release-identity(9.0.13 / v786), resource-ownership(45 기록, 슬롯 쓰기 3·3·3·1), transport-health, room-authority-boundaries(81), source-complexity PASS.                                                                                                                  |
| `sw-cache-version` | FAIL. 이유는 bump 전 런타임 파일 13개(`src/network/` 9개, `src/pro-room/` 3개, `src/types/index.ts`)가 v786보다 새롭다는 것 하나뿐이고 설계대로다. 이 실패로 `build:checked`와 가드 묶음이 그 자리에서 멈췄으므로, 그 뒤 단계(resource-ownership, transport-health, 욕설 패턴, hreflang, sitemap, `build`, 레거시 TV, 서비스 워커, UI kit, 초기 전송 예산, prod-hooks, prod-security, 글꼴, 앱 셸)를 따로 돌려 모두 PASS. |
| 빌드와 예산        | `build`와 `guard:initial-transfer-budget` PASS. 첫 로딩 JS gzip 464,456 B(기준 `4d7650c0` 464,588 B보다 132 B 적음, 아래 표와 같음).                                                                                                                                                                                                                                                                                      |
| 로컬 Playwright    | `test:e2e:critical` 61/61, `e2e/system-audio-controls.test.ts` 5/5(Chromium, 기본 포트).                                                                                                                                                                                                                                                                                                                                  |
| 하지 않은 것       | 라운드 3과 같다.                                                                                                                                                                                                                                                                                                                                                                                                          |

### 5. main 합침 뒤 다시 돌리기 (`2fc81c70`, 2026-10-27)

`git fetch` 뒤 origin/main이 `4d7650c0`에서 `cb159851`로 다섯 커밋 움직였으므로 합침 커밋 `2fc81c70`으로 합쳤다. 글자
충돌은 `docs/README.md`의 증거 목록 하나였고 두 항목을 모두 두었다(5B를 위에). registry(main의 RO-50, RO-51과 5B의
RO-41 삭제, RO-21 owner-in-place)와 `docs/design/pro-room-architecture-and-operations.md`(#500과 5B-OV1)는 저절로
합쳐졌다. main의 다섯 커밋은 시스템 오디오 파일을 건드리지 않았다. 합침 커밋 전에 `tsc --noEmit`, `typecheck:tests`,
`check:workers`를 돌려 PASS를 본 뒤 커밋했고, 같은 기계에서 레인 검사를 처음부터 다시 돌렸다(05:44 ~ 06:08 KST).

| 검사                                | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 정적                                | `typecheck`(전체 체인, `typecheck:tests` 포함), `check:workers`, `lint`, `format:check` PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 단위 전체                           | 680 files / 16,125 tests PASS(`--maxWorkers=6`, 283 s). Workers 설정 67 files / 3,180 tests PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 핵심 커버리지                       | `test:coverage:critical` 87 files / 3,447 tests PASS, 하한 그대로(전체 80.7 / 75.37 / 86.65 / 84.55).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 가드                                | navigation-sinks(398 files), dead-exports(테스트 전용 20/20, 자기만 76/76, fully dead 0), bus-pairing(202/202), import-graph(398 files, 순환 0), lifecycle-writes, release-identity(9.0.14 / v787, main에서 옴), transport-health, room-authority-boundaries(직접 읽기 81 그대로. main은 이 기준값을 바꾸지 않았다), source-complexity, standard-room-hot-path, chunk-pump, resource-ownership(47 기록 / 442 files, 슬롯 쓰기 3·3·3·1) PASS.                                                                                                                                            |
| `sw-cache-version`, `build:checked` | 둘 다 PASS. 그러나 이 PASS는 bump를 뜻하지 않는다. 가드는 first-parent 역사에서 CACHE_VERSION이 첫 부모와 다른 가장 새 커밋을 bump로 읽는데, 합침 커밋 `2fc81c70`은 첫 부모(5B 브랜치, v786)와 견주면 main의 v787을 가져왔으므로 가드가 그 커밋을 bump로 보고 그 뒤 바뀐 파일이 없다고 판정했다(출력 'v787 (2fc81c70) covers all committed PWA runtime changes'). 5B의 런타임 변경은 v787 bump `2077ef60` 뒤에 있으므로 bump는 여전히 필요하다. PR CI의 병합 ref와 main의 squash 커밋은 첫 부모가 main이라 그때 가드가 실패한다[추론, 가드 코드 판독]. 가드는 고치지 않았다(아래 관찰). |
| 빌드와 예산                         | `build`, `guard:initial-transfer-budget`, 레거시 TV(Chromium 79), 서비스 워커(v787), UI kit, prod-hooks, prod-security, 글꼴, SW 앱 셸(97 자산) PASS. 첫 로딩 JS gzip 466,708 B(main `cb159851` 466,874 B보다 166 B 적음, 아래 표).                                                                                                                                                                                                                                                                                                                                                     |
| 로컬 Playwright                     | `test:e2e:critical` 61/61, `e2e/system-audio-controls.test.ts` 5/5(Chromium, `build:e2e` 뒤).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 계획 §6의 빈 실행                   | 5B-G1 `e74e10da`과 5B-G3 `a2894382`를 꺼내(`git checkout --detach`, 각자 `build:e2e`) `e2e/system-audio-controls.test.ts`를 돌렸다. 둘 다 5/5 PASS(06:05 ~ 06:08 KST). 이로써 계획 §6의 네 지점(G1, G3, OV2, OV3) 모두에 실행이 있다.                                                                                                                                                                                                                                                                                                                                                   |
| 하지 않은 것                        | bump와 그 뒤의 `sw-cache-version`·`release-identity`, PR CI, Codex, exact-main CI, 릴리스 smoke.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

관찰(고치지 않음, 5B 범위 밖의 도구): `guard:sw-cache-version`은 bump가 든 main을 bump 없는 런타임 변경이 있는 브랜치에
합치면 그 합침 커밋을 bump로 읽어 거짓으로 통과한다. 출시 경로(PR CI, main squash, exact-main CI)에서는 실패하므로
릴리스 위험은 아니지만, 합침 뒤의 로컬 PASS를 bump 근거로 쓰면 안 된다. 고치는 한 방법은 합침 커밋을 모든 부모와
버전이 다를 때만 bump로 읽는 것이다(그러면 `2fc81c70`은 둘째 부모 main과 같은 v787이라 bump가 아니고, 가드는 더 아래의
bump에서 5B 런타임 변경을 찾아 실패한다). 가드 변경은 오너가 고를 일이다.

### 6. 릴리스 A 합침 뒤 다시 돌리기 (`0d59df41`, 2026-10-27)

라운드 5를 끝내고 다시 `git fetch`하니 origin/main이 릴리스 A `5dd7cc1f`(#502, 9.0.15 / v788, main에 머지됐고 배포 전)로
움직여 있어 합침 커밋 `0d59df41`로 합쳤다. 글자 충돌은 `docs/README.md`의 증거 목록과 `docs/release-record.md` §2의 배포 전
항목 둘이었고 양쪽을 모두 두었다(5B를 위에). 두 갈래가 함께 고친 `protocol.ts`, `types/index.ts`, `pro-room/runtime.ts`
(릴리스 A는 `PRO_ROOM_PIN_KEEP_UNSUPPORTED` 갈래, 5B C4-13은 다른 hunk), room-authority 가드, 세 테스트
파일(`protocol.test.ts`, `file-prepare-pause.test.ts`, PRO `system-audio-controller.test.ts`),
`pro-room-architecture-and-operations.md`, registry는 저절로 합쳐졌고, room-authority 경계 테스트는 두 갈래의 편집이
같아 그대로 받았다. 릴리스 A 보고서가 예상한 대로 두 갈래가 서로 다른 읽기를 하나씩 내려(릴리스 A는
`remote-share.ts`, 5B는 `system-audio-sfu.ts`) git이 같은 총합 편집 '82 → 81'을 한 번만 남겼으므로, 합침 커밋에서
경계 테스트의 기준치를 가드가 잰 80으로 내렸다(파일별 허용 목록은 바르게 합쳐짐, 내리는 변경이라 기록 갱신 없음).
합침 커밋 전에 `tsc --noEmit`, `typecheck:tests`와 겹친 다섯 묶음(room-authority, protocol, PRO 컨트롤러,
file-prepare-pause, runtime-system-audio-join, 161 tests)을 돌려 PASS를 본 뒤 커밋했고, 레인 검사를 처음부터 다시
돌렸다(06:14 ~ 06:34 KST).

| 검사                                | 결과                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 정적                                | `typecheck`(전체 체인, `typecheck:tests` 포함), `check:workers`, `lint`, `format:check` PASS.                                                                                                                                                                                                                                                                                                           |
| 단위 전체                           | 680 files / 16,108 tests PASS(`--maxWorkers=6`). Workers 설정 67 files / 3,182 tests PASS.                                                                                                                                                                                                                                                                                                              |
| 핵심 커버리지                       | `test:coverage:critical` 87 files / 3,444 tests PASS, 하한 그대로(전체 80.74 / 75.36 / 86.7 / 84.61).                                                                                                                                                                                                                                                                                                   |
| 가드                                | navigation-sinks(398 files), dead-exports(테스트 전용 20/20, 자기만 76/76, fully dead 0), bus-pairing(202/202), import-graph(398 files, 순환 0), lifecycle-writes, release-identity(9.0.15 / v788, 릴리스 A에서 옴), transport-health, room-authority-boundaries(직접 읽기 80), source-complexity, standard-room-hot-path, chunk-pump, resource-ownership(47 기록 / 442 files, 슬롯 쓰기 3·3·3·1) PASS. |
| `sw-cache-version`, `build:checked` | 둘 다 PASS. 라운드 5와 같은 거짓 통과다('v788 (0d59df41) covers all committed PWA runtime changes'). bump는 여전히 필요하다.                                                                                                                                                                                                                                                                            |
| 빌드와 예산                         | `build`, `guard:initial-transfer-budget`, 레거시 TV, 서비스 워커(v788), UI kit, prod-hooks, prod-security, 글꼴, SW 앱 셸(96 자산, 릴리스 A가 루트 영문 매니페스트를 지움) PASS. 첫 로딩 JS gzip 465,651 B(main `5dd7cc1f` 465,767 B보다 116 B 적음, 아래 표).                                                                                                                                          |
| 로컬 Playwright                     | `test:e2e:critical` 61/61, `e2e/system-audio-controls.test.ts` 5/5(Chromium, `build:e2e` 뒤).                                                                                                                                                                                                                                                                                                           |
| 하지 않은 것                        | 라운드 5와 같다. 릴리스 A의 배포와 기록 PR 뒤의 다시 합침도 아직이다.                                                                                                                                                                                                                                                                                                                                   |

### 7. 릴리스 A 기록 합침 (`08509f84`, 2026-10-27)

릴리스 A가 2026-10-27 06:20 KST에 배포되고([Release 40403240275](https://github.com/hiefny/MUSIXQUARE/actions/runs/40403240275),
target `app`) 그 기록 PR #504가 `1ff7fdf2`로 머지됐다. `git fetch` 뒤 origin/main은 `5dd7cc1f`에서 그 한 커밋만 움직였고,
합침 커밋 `08509f84`로 받았다. #504는 문서 넷(`docs/release-record.md` §1과 `Last source review` 줄, 릴리스 A 항목을 배포
뒤 확인으로 옮김, §4의 되돌리기 경계, `docs/release-history.md` 한 행, 릴리스 A 보고서의 QA 라운드 7, `docs/README.md`)만
바꿨다. 글자 충돌은 `docs/release-record.md` §2에서 5B 배포 전 항목 바로 뒤의 릴리스 A 제목 한 줄이었고, 5B 항목을 위에
두고 main의 '배포 뒤 확인' 제목을 받았다. `docs/README.md`는 저절로 합쳐졌다(두 증거 항목, 5B를 위에).

소스, 테스트, registry, 가드 파일은 main에서 바뀌지 않았으므로 단위와 빌드는 이 합침만으로 다시 돌리지 않았고, 가드
기준값만 다시 쟀다. room-authority-boundaries는 직접 읽기 80·구독 22·쓰기 13(398 production files)으로 경계 테스트
11/11이 그대로 통과하고, resource-ownership은 47 기록 / 442 production files, 수신 슬롯 쓰기 3·3·3·1로 그대로다. 그래서
기준값을 바꾸지 않았다. 레인 검사 전체는 bump 뒤 최종 검사에서 다시 돈다.

### 8. bump 뒤 최종 검사 (`198b8cf8`, 9.0.16 / v789, 2026-10-27)

검증 SHA는 bump `198b8cf8`이다(마지막 런타임 커밋, 그 뒤는 이 문서 커밋뿐). 환경은 위 표와 같다(Node 24.20.0 / npm
12.0.2). 기본 묶음은 작업 폴더의 일괄 검사 스크립트로 한 번에 돌렸고(07:13 ~ 07:29 KST, typecheck부터 critical E2E까지),
그 뒤 핵심 커버리지, `build:checked` 다시, 초기 JS, 후보 Playwright, 시스템 오디오 Playwright를 차례로 돌렸다(~07:33 KST).

| 검사              | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 식별              | `guard:release-identity` 9.0.16 / v789, `guard:sw-cache-version` PASS('v789 (198b8cf8) covers all committed PWA runtime changes'). 라운드 5와 6의 거짓 통과와 달리 이번 PASS는 실제 bump를 읽은 값이다.                                                                                                                                                                     |
| 정적              | `npm run typecheck`(전체 체인), `typecheck:tests`, `check:workers`, lint, `format:check` PASS.                                                                                                                                                                                                                                                                              |
| 단위              | 전체 680 files / 16,108 PASS(`--maxWorkers=6`, 349 s), Worker 67 files / 3,182 PASS(라운드 6과 같다).                                                                                                                                                                                                                                                                       |
| `build:checked`   | 전체 PASS(`guard:sw-cache-version` 포함 모든 단계 한 번에). 서비스 워커 v789, 레거시 TV(Chromium 79), UI kit, 초기 전송 예산, prod-hooks, prod-security, 글꼴, SW 앱 셸 96 자산(주입된 진입 자산 42, 시작 Worker 자산 1).                                                                                                                                                   |
| 가드              | navigation-sinks(398 files, `SKIP_WAITING` 보내기 2, sink 호출 4), dead-exports(내보낸 binding 2,097, 테스트 전용 20/20, 자기만 76/76, fully dead 0), bus-pairing 202/202, import-graph(순환 0), lifecycle-writes(슬롯 쓰기 3·3·3·1), room-authority-boundaries(직접 읽기 80, 구독 22, 쓰기 13), `check-resource-ownership`(47 records / 442 files) PASS. 기준치 변화 없음. |
| critical E2E      | `test:e2e:critical` 61/61 PASS(3.9분, 기본 포트).                                                                                                                                                                                                                                                                                                                           |
| 핵심 커버리지     | `test:coverage:critical` 87 files / 3,444 PASS, 파일별 하한 유지(전체 80.74 / 75.36 / 86.7 / 84.61, 라운드 6과 같다).                                                                                                                                                                                                                                                       |
| 후보 Playwright   | `build:checked`를 다시 돌린 production 산출물(`guard:prod-hooks` PASS)에서 `test:e2e:candidate` 19/19 PASS(`forced-update-resume.test.ts` 2행 포함, 51.5초). critical E2E가 `dist/`를 E2E 빌드로 바꾼 뒤라 먼저 다시 빌드했다(릴리스 A 라운드 6의 순서 함정).                                                                                                               |
| 시스템 오디오 E2E | `npm run test:e2e -- e2e/system-audio-controls.test.ts`(기본 설정, `build:e2e` 뒤 Chromium) 5/5 PASS. `e2e/`에서 이름에 system-audio가 든 Playwright 파일은 이것 하나다.                                                                                                                                                                                                    |
| 초기 JS           | 465,652 B gzip, 진입 스크립트 `main-CEBZWVF6.js` 861,486 B raw / 253,478 B gzip, 첫 로딩 파일 26. 운영 main `5dd7cc1f` 465,767 B 대비 −115 B, 유지 상한 491,568 B까지 25,916 B(아래 [초기 JS 예산](#초기-js-예산)).                                                                                                                                                         |
| SKIP              | 실제 기기, WebKit, 기본 Playwright 전체 목록, C5-0 랩(5B는 전송 경로를 바꾸지 않음), PR CI·Codex·exact-main CI·릴리스 smoke(이 로컬 결과는 exact-main-SHA 후보를 대신하지 않는다).                                                                                                                                                                                          |

### 9. PR CI, Codex, exact-main CI, 배포와 공개 확인 (2026-10-27)

검증 대상은 PR head `e9dc1ed3`(마지막 런타임 커밋인 bump `198b8cf8` 뒤 문서 커밋 하나)와 그 squash 머지 `a930030a`(트리가
`e9dc1ed3`와 같고 부모는 `1ff7fdf2`)다. 환경은 GitHub Actions(Node 24.20.0)와 운영 Cloudflare다. 시각은 KST다.

| 검사                     | 결과와 범위                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #505 CI               | PR을 09:57:39에 열자 `pull_request` 실행 [40429668105](https://github.com/hiefny/MUSIXQUARE/actions/runs/40429668105)이 09:57:42에 생겼고, attempt 1에서 11/11 success였다(10:06:10 완료).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Codex                    | 요약 댓글: PR을 열 때('PR opened') head `e9dc1ed3` 코드 리뷰가 09:59:10에 completed, `has_any_findings`와 `has_unresolved_findings`는 false, 보안 리뷰는 돌지 않음. Codex가 09:59:13에 PR에 👍 반응을 남겼다(요약 댓글이 적는 '지적 없음' 표시). 리뷰와 리뷰 댓글은 없다. 10:06:20에 squash 머지했다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 리뷰                     | PR #505 설명: 증분마다 실패 테스트 먼저와 독립 리뷰 둘(동작, 통신·위생), 열차 끝 셋, 릴리스 준비 둘이 모두 승인했다. 리뷰 본문은 저장소에 없다. 5B 리뷰의 낮음 지적 하나: `src/network/system-audio-sfu.ts`의 주석이 게스트의 `SYSTEM_AUDIO_SFU_CAPABILITY`를 읽는 방장을 '9.0.13까지'로 적지만, 9.0.14(`dd9c9d4d`)와 9.0.15(`5dd7cc1f`)도 `registerHandler(MSG.SYSTEM_AUDIO_SFU_CAPABILITY, handleSfuCapability)`로 읽는다(두 SHA의 `git grep`으로 확인). 동작과 통신은 맞고(게스트는 열차 3까지 보냄) 주석만 낡았다. 코드 주석이라 문서만인 배포 기록 PR에서 고치지 않았고 UI 묶음에서 고친다(아직 고치지 않음).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| exact-main CI            | [40430571006](https://github.com/hiefny/MUSIXQUARE/actions/runs/40430571006) attempt 1, 11 jobs 모두 success(10:06:25~10:15:19). 후보는 artifact 12701538220(digest sha256 `7b61d0a77335003884ca7bccdcc073d8bed85319e3b77f738ec994107a7d4952`)이고, 릴리스가 내려받아 이 digest와 릴리스 파일 809개를 확인했다(릴리스 A와 같은 수).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Release                  | [40431540366](https://github.com/hiefny/MUSIXQUARE/actions/runs/40431540366) attempt 1 성공(10:15:55 dispatch, deploy job 10:16:11~10:18:13), target `app`, Developer API D1 `false`, `raise_app_build_floor` false(올리기 단계 skip). 릴리스 커밋이 아직 main 머리인지 확인(10:16:24) 통과. 부분 릴리스 판정 compatible(10:17:02): 다섯 Worker 모두 릴리스 W `a3893f04`의 버전(PRO room `319f6e8f`, remote-share `8018b4ff`, signaling `2407c10c`, Developer API facade `19f49fa0`, Developer API `55c07e48`)이고 바뀐 경로는 0이다. App 배포 직전 다시 확인(10:17:35)도 같은 배포·버전·message로 compatible. checkpoint(artifact 12701439839)는 App 하나(9.0.15 / v788 `5dd7cc1f`, version `389fef92`)와 PRO generation·entitlement floor(`ready`, release `a3893f04`, floor release `4c5612d5`, App `verified-release-ancestor`)를 보존한다. target `app`이라 PRO generation readiness의 fence와 복원 단계는 skip이다. App 대상 D1 계약 적용·확인 단계 일곱 success. App 배포: `dist` 869 files를 읽어 새 자산 74개를 올렸고(733개는 이미 있음) 올린 크기는 984.42 KiB / gzip 200.76 KiB, version `317f176f-748b-4fde-80c9-ed995e3470e5`(10:17:45), message `git:a930030afc0a01e8d6c34bb169df69406a6726fc`. 최종 소유권 10:18:06 verified, 커밋 표지 artifact 12702041741, 배포 원본 artifact 12702106758, recovery job skipped. |
| 릴리스 smoke             | App generation(`main-CEBZWVF6.js` 861,486 B, 24 assets, 세 번 연속 읽기로 수렴. 라운드 8의 진입 스크립트 raw 861,486 B와 같다), 익명 계정 경계와 페이지의 최소 빌드 읽기(10:17:56, strict, `effectiveMinAppBuild` 787), PRO 공개 경계(`319f6e8f`, 첫 시도, `000000` `activation_required`, `000001` `pin_required`와 `passwordRequired` true, 익명 스냅샷 거절), Standard HTTPS signaling(10:18:04, `appBuild.build` 789로 방장·게스트 입장과 offer·answer 중계, `bridgeOpenMs` 방장 1,508ms·게스트 639ms) success. 503 재시도와 실패한 smoke는 없었다. Worker별 smoke(PRO room, remote-share, signaling, Developer API)는 그 Worker를 배포하지 않아 돌지 않았다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 배포 직전 floor `status` | 돌리지 않았다(App Build Floor 실행 목록에 W-verify [set 40379025557](https://github.com/hiefny/MUSIXQUARE/actions/runs/40379025557) 뒤의 실행이 없다). 대신 위 계정 경계 smoke가 페이지 읽기 strict 787을, Standard HTTPS smoke가 바닥 787 위에서 빌드 789 입장을 봤고, 아래 공개 상태와 Drift Audit이 저장·유효 787을 읽었다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 공개 자산·독립 확인      | 공개 GET(10:21) `/` 200 144,467 B(`bootstrap.js?cache=v789`, 진입 `main-CEBZWVF6.js`), `/service-worker.js` 200 38,199 B(`CACHE_VERSION = "v789"`, 9.0.15와 같은 크기). `/api/app-build-floor`: `minAppBuild` 787, `effectiveMinAppBuild` 787, revision 1(updated 2026-10-26T07:15:03.890Z), `liveAppBuild` 789, `reportedLiveAppBuild` 789(10:19:49 보고), state `valid`. `/api/app-build-floor/effective` `{"effectiveMinAppBuild":787}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Drift Audit              | [40432152099](https://github.com/hiefny/MUSIXQUARE/actions/runs/40432152099) attempt 1(`a930030a`, 10:22:09 dispatch, 10:22:45 완료) automated-checks-passed: 32 pass / 0 fail / 5 manual-only. App build floor 행 PASS('Stored floor 787 (enforced 787) is within the live App build 789 reported 172 s ago.').                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| SKIP                     | 배포 직전 floor `status`(위), 실제 기기, iOS·WebKit, 실제 Cloudflare Realtime, 운영 시스템 오디오 수신, 운영 브라우저의 업데이트 대화상자(9.0.14·9.0.15 탭의 '나중에' 있는 창, 적용 뒤 재로드), 9.0.14·9.0.15 기기와의 실제 혼합 방, 5B 런타임의 전체 직렬 E2E(최신 정기 Full E2E [40414428421](https://github.com/hiefny/MUSIXQUARE/actions/runs/40414428421)은 `1ff7fdf2`, 곧 9.0.15 런타임에서 success).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

로컬 결과는 exact-main-SHA CI 후보를 대신하지 않았다. 실기기 확인은 release-record §2에 열려 있다.

## 초기 JS 예산

같은 기계에서 기준 `4d7650c0`과 `c0b86b62`를 `npm run build`로 빌드하고 `measureInitialTransfer()`로 바이트를 쟀다.
첫 로딩 파일 수는 26으로 같다.

| 값               | `4d7650c0`(9.0.13) | `c0b86b62`  | 차이   |
| ---------------- | ------------------ | ----------- | ------ |
| entry raw        | 856,831 B          | 856,837 B   | +6 B   |
| entry gzip       | 251,948 B          | 251,960 B   | +12 B  |
| eager JS gzip    | 464,588 B          | 464,456 B   | -132 B |
| eager total raw  | 2,043,788 B        | 2,043,295 B | -493 B |
| eager total gzip | 543,049 B          | 542,918 B   | -131 B |

줄어든 것은 첫 로딩에 드는 `system-audio-delivery.ts`(OV-B05의 능력 집합과 순서), `peer.ts`(capability 초기화 셋, SA-9
emit 인자), `protocol.ts`(OV-A08 검사기)로 본다[추론]. entry의 +6 B는 따로 가르지 않았다. G1~G6과 C4-13이 바꾼
슬롯, guest, SFU, 서비스, 직접 전송, 런타임은 지연 모듈이라 첫 로딩에 들지 않는다. `guard:initial-transfer-budget`은 PASS다(5% 예비선 유지). 지연 청크는 따로 재지 않았다.

main 합침 뒤(QA 라운드 5) 같은 기계에서 main `cb159851`(운영 9.0.14 / v787의 App 런타임)과 합침 커밋 `2fc81c70`을 다시
쟀다. `cb159851`의 진입 청크는 `main-CaKT24Ie.js` 862,421 B로 운영 App generation smoke가 본 값과 같고, 첫 로딩 JS gzip
466,874 B는 기록의 9.0.14 값과 같다. 첫 로딩 파일 수는 26으로 같다.

| 값               | `cb159851`(9.0.14) | `2fc81c70`  | 차이   |
| ---------------- | ------------------ | ----------- | ------ |
| entry raw        | 862,421 B          | 862,433 B   | +12 B  |
| entry gzip       | 253,786 B          | 253,792 B   | +6 B   |
| eager JS gzip    | 466,874 B          | 466,708 B   | -166 B |
| eager total raw  | 2,050,468 B        | 2,049,972 B | -496 B |
| eager total gzip | 545,336 B          | 545,169 B   | -167 B |

차이는 합치기 전(`4d7650c0` 대비 `c0b86b62`)과 거의 같다. 5B와 main의 첫 로딩 변경이 서로 겹치지 않는다는 뜻으로 읽는다[추론].

릴리스 A 합침 뒤(QA 라운드 6) 같은 기계에서 main `5dd7cc1f`(릴리스 A 9.0.15 / v788, 배포 전)과 합침 커밋 `0d59df41`을
쟀다. `5dd7cc1f`의 첫 로딩 JS gzip 465,767 B는 릴리스 A 보고서의 bump 값과 같다. 첫 로딩 파일 수는 26으로 같다.

| 값               | `5dd7cc1f`(9.0.15) | `0d59df41`  | 차이   |
| ---------------- | ------------------ | ----------- | ------ |
| entry raw        | 861,468 B          | 861,486 B   | +18 B  |
| entry gzip       | 253,474 B          | 253,476 B   | +2 B   |
| eager JS gzip    | 465,767 B          | 465,651 B   | -116 B |
| eager total raw  | 2,045,470 B        | 2,044,988 B | -482 B |
| eager total gzip | 544,227 B          | 544,111 B   | -116 B |

raw 차이(-482 B)는 앞의 두 비교(-493 B, -496 B)와 거의 같고, gzip 차이는 50 B쯤 줄었다. 릴리스 A가 `protocol.ts`의 다른
검사기를 함께 지워 압축 문맥이 바뀐 것으로 본다[추론, 가르지 않음].

bump 뒤(QA 라운드 8) `build:checked`의 production 산출물을 같은 방법으로 쟀다. main `5dd7cc1f` 값은 위 표와 같다(운영
App generation smoke가 본 진입 청크 `main-D2yIdvWs.js` 861,468 B와 같은 크기). 첫 로딩 파일 수는 26으로 같다.

| 값               | `5dd7cc1f`(9.0.15, 운영) | `198b8cf8`(9.0.16) | 차이   |
| ---------------- | ------------------------ | ------------------ | ------ |
| entry raw        | 861,468 B                | 861,486 B          | +18 B  |
| entry gzip       | 253,474 B                | 253,478 B          | +4 B   |
| eager JS gzip    | 465,767 B                | 465,652 B          | -115 B |
| eager total raw  | 2,045,470 B              | 2,044,988 B        | -482 B |
| eager total gzip | 544,227 B                | 544,115 B          | -112 B |

bump는 버전 문자열만 바꿔 `0d59df41`과 raw가 같고, gzip 차이 1~4 B는 빌드마다의 흔들림 범위다. 늘어난 증분은 없어
로드맵의 '증분당 +300 B'와 'Phase당 순 +200 B'에 걸리지 않는다. 새 청크는 없다.

## 기록·레지스트리

- RO-04: 증분마다 같은 커밋에서 갱신했다(울타리, 코디네이터 경로 끝, 재발행 handoff, 공유자 claim, 중첩 end, 경로 닫힘,
  P5-D10 A 패리티 표, 기준 테스트, 상태). 5B-OV3은 기준 테스트 줄 하나와 상태 문장을 더한다. 기록은 `duplicated`로 남는다
  (PRO 코디네이터가 자기 마감과 정리를 가진다).
- RO-21은 owner-in-place(`runtime.ts`가 복귀 수리 권한), RO-41은 삭제(46 → 45 기록, 색인과 ID 목록 포함).
- [시스템 오디오 수신 소유](system-audio-receive-ownership.md): 틈 1~7, 10~12를 고친 증분과 함께 표시했고 8, 9, 13, 14는
  그대로다. 검증 목록에 5B-OV3의 프레임 검사 행을 더했다.
- `check-room-authority-boundaries.mts`: `system-audio-sfu.ts` appRole 읽기 11 → 10, 합계 82 → 81(OV2). 다른 가드 기준값은
  바뀌지 않았다. 올린 기준값은 없다.
- main 합침 뒤 다시 잰 값(QA 라운드 5): registry는 47 기록(main이 RO-50 App build floor와 RO-51 복귀 대화상자를 더해 48,
  5B가 RO-41을 지움), 442 production files. room-authority 직접 읽기는 81 그대로다(main은 그 기준값을 바꾸지 않았다).
  dead-exports 20/20·76/76, bus-pairing 202/202, 슬롯 쓰기 3·3·3·1도 그대로다.
- 릴리스 A 합침 뒤(QA 라운드 6): registry는 여전히 47 기록이다(릴리스 A는 RO-06, RO-15, RO-18, RO-22 문장만 바꿈).
  room-authority 직접 읽기는 80이고 경계 테스트 기준치를 81에서 80으로 내렸다(합침 커밋 `0d59df41`). 그 밖의 기준값은 그대로다.
- 릴리스 A 기록 합침 뒤(QA 라운드 7, `08509f84`): main은 문서만 바꿨고 기준값은 모두 그대로다(registry 47 기록 / 442 files,
  room-authority 직접 읽기 80·구독 22·쓰기 13, 슬롯 쓰기 3·3·3·1). bump `198b8cf8` 뒤(QA 라운드 8)에도 같다.
- `docs/release-record.md` §2에 5B 배포 전 항목을 더했다. 배포 기록 PR이 §1과 `Last source review`를 이 릴리스로
  덮어쓰고, §2 항목을 '배포 뒤 확인'으로 옮기고(실기기 항목은 열린 채), 릴리스 A·W 항목의 순서 문장과 강제 업데이트·5A
  항목의 안내를 고치고, §4에 이 릴리스의 되돌리기 경계를 더하고, `release-history.md`에 한 행을 더했다. registry RO-04의
  'not yet released' 표기도 배포로 고쳤다. [허용한 위험](../known-accepted.md)은
  바뀌지 않는다. 5B가 받아들인 경우(5B-G2 절의 둘과 5B-G1 절의 메타 null 창)는 RO-04에 적었고, 새 허용 위험은 없다.

## 출시 전에 남은 것

- 끝남: main(`cb159851`까지)을 합침 커밋 `2fc81c70`으로 합치고 레인 검사를 다시 돌렸다(QA 라운드 5). 예상과 달리
  글자 충돌은 `docs/README.md` 하나였고(두 증거 항목을 모두 둠), registry와
  `docs/design/pro-room-architecture-and-operations.md`는 저절로 합쳐졌다. 소스 파일은 겹치지 않았다. 기록 수와
  room-authority 합계는 위 [기록·레지스트리](#기록레지스트리)에 다시 쟀다.
- 끝남: `docs/release-record.md` §2에 5B 배포 전 항목(범위와 상태, 위 호환 줄, 아래 기기 기대값의 단계 범위. 판정 기준은 블라인드라 이 보고서에만 둠)을 더했다. §1과 릴리스
  이력은 배포 뒤에 고친다.
- 끝남: 그 사이 main에 들어온 릴리스 A(`5dd7cc1f`, 9.0.15 / v788, 배포 전)를 합침 커밋 `0d59df41`로 합치고 레인 검사를
  다시 돌렸다(QA 라운드 6). 릴리스 A가 OV-F06의 `FILE_R2_CAPABILITY` 절반을 지웠고 `SYSTEM_AUDIO_SFU_CAPABILITY`
  보내기는 5B의 OV-B05 빌드 뒤 열차 3으로 남겼으므로(릴리스 A 보고서), 옛 버전 제거 2차 목록에서 OV-B05는 이미 5B 몫이다.
- 끝남: 릴리스 A가 배포되고(2026-10-27 06:20 KST) 그 기록 PR #504(`1ff7fdf2`)가 머지된 뒤 main을 합침 커밋 `08509f84`로
  다시 합쳤다(QA 라운드 7, 문서만이라 가드 기준값만 다시 잼). 단위, 가드, 빌드와 예산은 bump 뒤 최종 검사에서 다시 돈다.
- 끝남: bump `198b8cf8`(9.0.16 / v789, 올리기 직전 origin/main `1ff7fdf2`)과 bump 뒤 최종 검사(QA 라운드 8,
  `guard:sw-cache-version`과 `guard:release-identity` 포함).
- 끝남: PR CI, Codex, exact-main CI, 릴리스 smoke, 배포(target `app`, Developer API D1 `false`,
  `raise_app_build_floor` `false`, 2026-10-27 10:18 KST, QA 라운드 9), 배포 뒤 §1 덮어쓰기, §4 되돌리기 경계, 릴리스 이력
  한 줄(배포 기록 PR).
  열차 3(게스트의 시스템 오디오 표지 보내기 OV-F06 나머지 포함)의 바닥은 max(릴리스 A 빌드 788, 5B 빌드 789), 곧 789다(두
  빌드 모두 배포됨).
- 남음(UI 묶음): 위 QA 라운드 9의 5B 리뷰 낮음 지적(`system-audio-sfu.ts` 주석의 '9.0.13까지')은 다음 UI 묶음에서 고친다.
- 다음 순서(오너 지시 2026-10-27): PR #503(PRO 업로드 신뢰성)은 이 보고서의 기록 #506 뒤 main을 합쳐 2026-10-27 13:42 KST에
  9.0.17 / v790(target `all`, Release 40450793853)으로 나갔다. 그다음 UI 묶음(UI 감사와 힌트 문구 감사의 권고)이 다음 앱
  업데이트로, 이어 PRO 방 영수증 보관 시간 줄이기 열차가 나가고, Phase 5.5(구버전 제거 열차 3과 PRO 스냅샷 v2)는 오너 승인을
  기다린다.

## 배포·회복

**배포 대상.** target `app`, Developer API D1 `false`, `raise_app_build_floor` `false`. 운영 `5dd7cc1f`와 견준 런타임
경로 변경은 App 17개, 다른 다섯 Worker 0개다(머리 표 '배포 대상'). bump가 SemVer와 SW 캐시 epoch를 함께 올리므로 업데이트
창이 뜨는 배포이고, 바닥을 올리지 않으므로 9.0.14와 9.0.15 탭에는 '나중에'가 있는 보통 창이 뜬다. 오너 결정(2026-10-25 약
01:50 KST)대로 자동 게이트(로컬 검사, 리뷰, PR CI, Codex, exact-main CI, 릴리스 smoke)가 통과하면 따로 묻지 않는다.
결과: 2026-10-27 10:18 KST에 이 입력 그대로 배포했다(QA 라운드 9).

**순서.** W → A → 5B다. 릴리스 A는 2026-10-27 06:20 KST에 배포됐고 그 기록 #504가 머지된 뒤 이 브랜치가 main을 합쳤다
(`08509f84`). 릴리스 A 보고서의 머지 규칙대로 5B는 자기 배포 직전에만 main에 머지하고, 머지부터 배포와 기록 PR 머지까지
다른 열차는 머지하지도 릴리스하지도 않는다. 그 사이 main이 움직이면 다시 합치고, 런타임이 바뀌었으면 bump와 최종 검사를
다시 한다(문서만이면 bump 그대로). 완료: 5B는 릴리스 A 기록 #504(`1ff7fdf2`) 뒤에 머지했고(2026-10-27 10:06 KST, squash
`a930030a`의 부모가 `1ff7fdf2`), 머지부터 배포까지 main에 다른 머지는 없었다(릴리스의 'main 머리 확인' 단계 통과). 다음은
오너 지시(2026-10-27)대로 PR #503(9.0.17 / v790, 2026-10-27 13:42 KST 배포), UI 묶음, PRO 방 영수증 보관 시간 줄이기 열차
순이고, Phase 5.5(열차 3과 PRO 스냅샷 v2)는 오너 승인을 기다린다.

**되돌리기 경계.**

- 기본은 더 높은 SemVer와 캐시 epoch의 코드 되돌리기다([hotfix-procedure.md](../hotfix-procedure.md)의 Rollback). 5B는
  저장 데이터 모양, D1, 비밀, 바인딩, 계약 표지(`single-stereo-v3+heartbeat-state-v1`, PRO 입장 정책 표지 9.0.4)를 바꾸지
  않으므로, 되돌리면 고친 틈(G1~G6, C4-13)과 지운 옛 버전 항목(OV-A04, OV-B05, OV-B06, OV-A08 시스템 오디오 부분,
  코디네이터 잔재, SA-9)이 돌아올 뿐이다.
- 급할 때의 Cloudflare App 버전 되돌리기: checkpoint(artifact 12701439839)가 보존한 9.0.15 / v788(`5dd7cc1f`, App
  `389fef92`)은 저장 바닥 787 위라 `lower` 없이 된다. 9.0.13 이하(787 아래)로 내리기 전에는 `lower`를 먼저 하고, 열차 3이 바닥을 789로 올린 뒤에는 9.0.16
  아래로 내리기 전에 바닥을 먼저 내린다(릴리스 A의 경계와 같은 규칙). 같은 PRO 입장 정책 표지를 가진 9.0.5 이상으로만
  되돌린다.
- 되돌린 9.0.15와 이 빌드가 한 방에서 만나는 경우는 위 [호환과 혼합 버전](#호환과-혼합-버전)과 같다. 두 빌드는 서로의 모든
  시스템 오디오 프레임을 받는다.
- 다른 다섯 Worker는 이 릴리스가 바꾸지 않으므로 그 되돌리기 기준은 릴리스 W의 checkpoint 그대로다.
- 바닥에 기대는 것: OV-A08, OV-B05, OV-B06이 잃게 하는 것(위 [호환과 혼합 버전](#호환과-혼합-버전)의 표)은 바닥 787 아래
  클라이언트에만 닿는다. 9.0.16이 live인 동안 바닥을 787 아래로 내리면 그 클라이언트가 다시 들어와 그것을 겪을 수 있다.
  G1~G6, C4-13, SA-9, OV-A04, 코디네이터 잔재는 바닥에 기대지 않는다.
- 이 릴리스는 성공해 실패 자동 복구(App만 checkpoint로 되돌림)는 돌지 않았다(recovery job skipped). 이 경계들은 배포
  기록 PR이 release-record §4 '구조 개선 Phase 5 5B'에 옮겨 적었다.

## 기기 기대값 (결과보다 먼저 고정)

오너가 나중에 쓸 기기 세션용이다(기기 근거는 게이트가 아님, 2026-10-25 01:50). 5A 뒤 첫 세션이 '5A 뒤' 기준선을 주고, 5B
비교는 결정 문서 §3.8을 그대로 쓰되 다음만 다르다. 이 절의 통과와 퇴행 기준은 메인 세션이 결과와 견줄 때만 쓴다.
오너는 기기 시트(5A 보고서의 [Phase 5 기기 절차](phase5-5a-receive-slot-2026-10-25.md#phase-5-기기-절차-오너가-나중에-쓸-것-p5-d2-a))만
보고 돌리고, 이 절은 결과를 낸 뒤에 읽는다(5A 절의 블라인드 원칙과 같다). 릴리스 기록 §2의 5B 기기 항목에는 바뀜이 예상되는
단계만 적었다.

- 5P-5(C4-13): 바뀜 예상. iPhone Safari PRO 청취자, YouTube 항목, 공유 30초 뒤 잠금, 10초 뒤 공유 중지, 그 10초 뒤 잠금
  해제. 통과: iPhone 두 번 모두 소리가 처음 돌아온 뒤 30초 안에 '두 번째 멈춤'(1초 넘는 무음 뒤 멈춘 자리에서 다시 재생)이
  없고 YouTube 1이 시작 한 번으로 돌아온다. 귀로만 판정한다(T8: flight recorder에 표시 줄 없음). 5B 전 세션 값이 있으면
  비교하고, 첫 세션이 5B 뒤면 고친 뒤 근거로만 적는다. Android 5P-5b는 참고만 한다. 나머지 5P-5 값은 '5A 뒤' 기준선과 같아야
  한다. 두 번째 멈춤이 들리면 C4-13 퇴행으로 부르기 전에 RO-21의 남은 순서(보인 뒤 복원의 새 시계 표본이 실패하고 그 뒤에 줄
  선 전경 수리가 먼저 적용되면 250 ms 복원 재시도가 같은 revision을 다시 arm함, 위 5B-C4-13 절)와 먼저 견준다. 그것이 RO-21의
  다시 볼 조건이다. 잠금 해제 직후 느린 네트워크가 그 순서를 부를 수 있다[추론].
- PRO LAN-direct 청취자의 공유 중지(5B-G6 틈 11; 5P-1, 5P-2, 5P-3, 5P-7): 작은 변화 예상. 5P-4는 뺀다. 그 단계에서는 H가
  공유를 멈추기 전에 G2가 LTE로 다시 들어오고, PRO 직접 전송은 host 후보만 쓰므로 늦은 참가자의 LAN 경로를 증명하지 못해
  발행 전체가 SFU로 승격된다(직접과 SFU를 섞어 보내지 않음). 그래서 중지 때 G1도 SFU 청취자이고 이 변화가 닿지 않는다. 다른
  단계도 §3.8의 경로 판정이 'direct(추정)'인 시도(H 파일에 `[ProSysAudioSFU]` 줄과 승격 줄이 없음)만 이 기대의 대상이다.
  소리는 전처럼 멈추고, 청취자의 제목과 재생 버튼이 서버 idle 상태가 아니라 중지 신호에서(보통 1초 안 일찍[추론, 재지
  않음]) 공유 전으로 돌아온다. 중지 때 재생 버튼 스피너와 잠금 화면 '일시정지'가 없다. YouTube 1은 전과 같은 때 돌아온다. 기록 값(D 멈춘 초, YouTube 1까지 초, 30초 안
  재동기 점프, YouTube 1 뒤 제목, 토스트)은 '5A 뒤' 기준선과 같아야 한다. 중지와 YouTube 1 사이에 본 제목이 공유 전 제목이어도
  퇴행이 아니다. 중지 때 스피너나 잠금 화면 '일시정지'가 보이면 5B 퇴행 후보다. 5P-5(잠김)는 이것을 볼 수 없다.
- PRO SFU 공유가 두 시간 제한에 닿을 때(5B-G6 틈 12, 리뷰 `99b335b6`가 계획 §7의 '재현 불가'를 고침): 각 SFU 청취자가 구독자
  예산 만료와 서버 idle 상태 사이에 대기 상태(재생 버튼 스피너, 재생 아이콘 꺼짐, 잠금 화면 '일시정지')를 잠깐(보통 약
  1초[추론, 재지 않음]) 보이고, 그 뒤 공유 전 제목, idle, YouTube 1이 전처럼 온다. 알림 없음. 예상된 것이고 5B 퇴행이 아니다. 전에는 그 창 동안
  무음 재생을 보였다. 시계가 서버보다 늦은 청취자는 대기 상태를 못 볼 수 있다. 기기 시트의 단계가 아니고 선택 확인이다.
- PRO 데스크톱 공유자의 SFU 발행자 복구(5B-G4 리뷰 `98c4b040`): 공유자가 `connection_unstable`을 본 뒤 발행자가 복구되면,
  전에는 공유가 계속되는 동안 공유자 플레이어가 제목 없는 idle로 남았고(`/debug sa` `[Playback]` mode:none/idle), 뒤에는
  'System Audio Sharing'과 재생 상태를 계속 보인다(mode:system-audio/playing receiving:no). 청취자는 영향 없음. 선택 확인이다.
- 그 밖의 Set 5S, Set 5P 단계: 바뀜 예상 없음(5B 틈 고침은 시트가 만들 수 없는 타이밍이나 둘째 데스크톱 경우이고, OV 항목은
  floor 아래 클라이언트용). 이 단계들의 §3.8 퇴행은 5B 퇴행 후보다.
- 기기에서 재현할 수 없어 단위 근거만 있는 것: 틈 1, 2, 3, 4, 5, 6(공유자 복구 길 제외), 7, idle 상태가 늦을 때의 틈 11, 모든
  OV 항목과 SA-9.

## 실기기로 확인하지 않은 것

- 5B 코드는 실제 기기, iOS·WebKit, 실제 Cloudflare Realtime에서 돌리지 않았다. 위 기기 기대값은 모두 오너의 나중 세션 몫이다.
- '5A 뒤' 기준선 세션 없이 5B가 2026-10-27 10:18 KST에 배포돼, 운영에서는 그 기준선을 더 얻을 수 없다. 운영의 다음 기기
  세션은 5B 코드이고, 5P-5 값은 위 기기 기대값의 '첫 세션이 5B 뒤면' 규칙대로 고친 뒤 근거로만 적는다. 위 기대값에서
  '5A 뒤' 기준선과 견주게 한 값은 견줄 운영 기준선이 없다.
- 로컬 Playwright는 PeerJS 일반방 직접 통화만 본다. PRO 경로와 일반방 SFU는 단위와 가짜 전송 묶음만 본다.
- 운영 브라우저의 업데이트 대화상자(9.0.14·9.0.15 탭에 뜨는 '나중에' 있는 창, 적용 뒤의 재로드)와 이 빌드의 실제 사용자
  세션, 9.0.14·9.0.15 기기와의 실제 혼합 방.
- PR CI, Codex, exact-main CI, Release, 릴리스 smoke는 QA 라운드 9에서 통과했다. 라운드 1~8의 결과는 로컬이고
  exact-main-SHA 후보를 대신하지 않는다. 리뷰 본문은 저장소에 없어 PR #505 설명으로만 안다.
