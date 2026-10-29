# Phase 5.5 R3: App이 PRO 스냅샷 schemaVersion 1 받기를 그만두고 받는 쪽을 좁힘, 9.0.25 (2026-10-30)

| Field | Value |
| --- | --- |
| Status | 초안(2026-10-30). 증분 R3-1 ~ R3-7과 이 열차의 기록(release-record §2·§3·§4, hotfix-procedure, PRO 운영 문서의 되돌리기 문단, 이 보고서)을 만들고 증분별 검사(QA 라운드 1)와 기록 커밋 `39b36a0a`의 전체 기본 검사(QA 라운드 2, bump가 없어 실패하는 `guard:sw-cache-version` 말고 모두 통과)를 했다. 미병합·미배포다. 브랜치 `agent/p55-r3`은 PRO 스냅샷 schemaVersion 2 보내기 브랜치의 끝 `91601774` 위의 커밋이다: 테스트 먼저 7, 코드 9, 서버 권한 ADR 문서 1, 기록 1, QA 라운드 2를 적은 문서 1, 그 뒤 리뷰를 반영한 문서. 마지막 App 런타임 커밋은 R3-6 `f72629c2`이고 R3-7 `d965af02`은 릴리스 workflow의 값 하나다. SemVer와 SW 캐시는 올리지 않았다(릴리스 담당이 main 위로 옮긴 뒤 9.0.25 / v798을 마지막 런타임 커밋으로 올림). main 위로 옮기기와 옮긴 부모에서 테스트 먼저 다시 돌리기, bump, 열차 끝 리뷰, PR, PR CI, 자동 코드 리뷰, exact-main CI, 배포는 아직이다(QA 라운드 3, 4는 자리만) |
| Base | `91601774`(PRO 스냅샷 schemaVersion 2 보내기 브랜치 `agent/p55-r2`의 끝, 9.0.22 PR #524의 브랜치 끝 `7630b1a9` 위). 운영은 9.0.22 / v795(R1, #524 머지 `71f5b96c`, 2026-10-29 18:35 KST 배포, 바닥 789)와 그 뒤 9.0.23 / v796(App UI와 번역, #526 머지 `5a5afb0e`, 21:23 KST 배포)이다. schemaVersion 2를 보내는 PRO Worker는 아직 받아들이는 중이고 바닥 795 뒤에 나간다. 이 브랜치는 그 PRO Worker의 머지와 기록 뒤 main 위로 옮기고 이 문서의 SHA를 다시 적는다 |
| Version | 9.0.25 / v798 예정(앱 빌드 798). 9.0.24 / v797이 운영에 있으므로 다음 패치와 epoch다. 업데이트 창이 뜬다(바닥 795 위의 9.0.22 ~ 9.0.24 탭에는 '나중에'가 있는 보통 창). 새 바닥은 없다 |
| Scope | Phase 5.5 계획의 R3(증분 R3-1 ~ R3-7). App이 PRO 스냅샷 schemaVersion 1을 받지 않고 `passwordRequired`와 `playlistSlots`, 관리자 목록 답의 `{ administrators }`, bootstrap의 `passwordRequired`를 요구한다(PSK-01 ~ PSK-06의 A2, PSK-04, OV-A22, Q15). 시작 종류는 `timingMode`로만 읽고(ZS-05), 하트비트 스냅샷이 COMMIT보다 먼저 준비된 checkpoint를 내려놓으면 그 PREPARE의 종류로 시작한다(ZS-06, 의도한 동작 변화). live LAN-direct의 숫자 `liveExpiresAt`을 거절한다(PLE-04). PRO opt-in 머리글 둘을 보내지 않는다(HDR-1, PSK-07). 일반방 게스트는 SESSION_FULL과 OPERATOR_TOAST를 `i18nKey`로만 읽는다(STD-3, STD-4). 전송 계층이 은퇴한 PRO 개발자 신호 프레임을 읽지 않는다(PSK-11 클라이언트, 좁힘). Production Release의 PRO 최소 빌드 요구 값을 비운다(R3-7, Q21). Worker, D1, 비밀, 바인딩, Wrangler 설정, CORS, 계약 표지, 저장 모양은 바꾸지 않는다(`cloudflare/app-worker.ts`는 주석 하나) |
| Deploy target | `app`. `scripts/release-deployment-state.mts`의 `changedRuntimePaths`와 Worker별 런타임 경로로 `91601774` 대비 견준 로컬 git 판정: App 15(`cloudflare/app-worker.ts`, `src/` 14), PRO 방 0, remote-share 0, signaling 0, Developer API facade 0, Developer API 0. `changedAppRuntimeDependencies`는 빈 목록이다. 바뀐 시험 파일, e2e, 문서, `.github/workflows/release.yml`은 어느 런타임 경로에도 없다. 공유 시간 파일 `cloudflare/pro-room-playback-timing.ts`(PRO와 App 두 목록에 듦)와 PRO Worker는 건드리지 않았다. 운영 조회인 릴리스의 부분 릴리스 호환 검사를 대신하지 않는다. Developer API D1 `false`, `raise_app_build_floor` `false` |
| Operations | 이 열차는 아직 운영에 아무것도 하지 않았다. dispatch 직전 읽기와 배포 직후 확인은 '배포 조건과 순서'와 QA 라운드 3(자리)에 있다 |
| Resource ownership | 새 복구·재시도·시간 제한·감시·생명주기 흐름이 없어 새 레코드는 없다. R3-2가 RO-03의 699 ms 문장과 그 시간 시험의 699 고정을 고쳤다(`node scripts/check-resource-ownership.mts` 출력은 그대로). 요구 값을 비운 것은 시간 값이 아니라 P2의 사전 검사가 읽는 빌드 번호다 |

이 문서는 Phase 5.5의 셋째 런타임 릴리스 R3의 증분과 QA를 기록한다. 근거는 공개하지 않는 작업 노트(`docs/private/`)의 Phase 5.5
계획(2026-10-28)과 그 영역 조사이고, PSK, ZS, PLE, HDR, STD, OV 번호와 Q 번호는 그 노트의 번호다. 계획의 줄 번호는 `6a23c46e` 기준이라
증분마다 위치를 기호로 다시 찾았다. 동작이 바뀌는 증분마다 테스트를 먼저 커밋하고 부모 코드에서 새 행과 바뀐 행만 실패함을 확인했다.
계획 단계 이름은 R1(9.0.22, [보고서](phase5-5-r1-train3-v2-accept-2026-10-29.md)), F2(바닥 795), R2(PRO 스냅샷 schemaVersion 2를
처음 보내는 PRO Worker, [보고서](phase5-5-r2-v2-send-2026-10-29.md)), R3(이 릴리스)이다. 영구 운영 문서(release-record §4,
hotfix-procedure, 설계 문서)에는 단계 이름 대신 SemVer, 빌드, 그리고 계약 문구 'PRO 스냅샷 schemaVersion 2를 처음 보내는 PRO
Worker'로 적었다. 이 릴리스의 머지 SHA와 Release ID는 배포 기록 PR이 채운다. 영구 문서의 'R2'는 Cloudflare R2다.

## 오너 결정과 순서

- 옛 버전 정책, 강제 업데이트, 작은 통신 필드의 순서(받는 쪽, 바닥, 보내는 쪽), Phase 5.5 계획 질문(2026-10-28)과 시작
  승인(2026-10-29)은 [R1 보고서](phase5-5-r1-train3-v2-accept-2026-10-29.md#오너-결정과-순서)와 같다. 이 릴리스에 닿는 것:
  - 로드맵의 PRO 스냅샷 v2 순서: 클라이언트가 v2를 받음(9.0.22), 바닥 올림(795), PRO Worker가 v2를 보내고 v1을 멈춤, 클라이언트가
    v1 받기를 멈춤(이 릴리스).
  - Q4: `timingMode`는 끝까지 선택 필드다. 그래서 필드 없는 COMMIT도 재생은 되고, 예약 제어(scheduled-control)로 시작한다.
  - Q5: ZS-06(스냅샷이 COMMIT보다 먼저 온 기기의 시작 종류)을 이 릴리스의 별도 증분으로 낸다(동작 변화).
  - Q7: 이 App이 모르는 `i18nKey`의 운영자 알림은 원시 키나 방장 문구 없이 보이지 않는다.
  - Q8: 새 되돌리기 경계는 문서로만 적고 계약 표지는 바꾸지 않는다.
  - Q10: 바닥 도구와 PRO smoke는 entry-policy 머리글을 계속 보낸다(PRO Worker가 읽지 않아 결과가 같음).
  - Q15: 부르는 곳 없는 `getAdministrators`와 PSK-11의 클라이언트 잔재를 지우고 bootstrap `passwordRequired`를 필수로 한다. 신호
    Worker 쪽은 남긴다.
  - Q21: PRO 최소 빌드 요구 값은 이 런타임 PR이 지운다(R3-7).
- 배포 정책(2026-10-25): 자동 게이트가 통과하면 따로 묻지 않고 배포한다. 기기 근거는 게이트가 아니다.
- 순서: schemaVersion 2를 보내는 PRO Worker의 머지와 배포 → 그 기록 → 이 브랜치를 main 위로 옮기고 bump → 이 릴리스 머지와 배포 →
  이 릴리스의 기록 → (계획의 기본) R4 PRO 정리. 그 PRO Worker의 배포부터 이 배포까지 런타임 의존성 변경을 머지하지 않고, 이
  릴리스의 머지와 기록 사이에 다른 머지를 끼우지 않는다.

## 이 릴리스가 기대는 것

받는 쪽만 좁히므로 바닥이 더 필요 없다. 그만 받는 모양마다 그것을 보내던 쪽이 이미 운영에서 사라졌거나 바닥이 거른다.

| 그만 받는 것 | 보내던 쪽 | 이 App이 만나는 쪽 |
| --- | --- | --- |
| 스냅샷 schemaVersion 1, `passwordRequired`·`playlistSlots` 없는 스냅샷, `authorityVersion`이 든 관리자 목록 답 | schemaVersion 2를 처음 보내는 PRO Worker 앞의 PRO Worker | 그 PRO Worker와 그 뒤(모든 스냅샷 답이 schemaVersion 2이고 두 필드를 스스로 실음). 교차 계약 행(`pro-room-worker.test.ts`의 `parseProRoomSnapshot` 호출, in-process Worker에 붙인 `ProRoomApiClient`)이 Worker 출력을 이 파서로 읽는다 |
| `passwordRequired` 없는 bootstrap | 릴리스 W(`a3893f04`) 앞 PRO Worker | 릴리스 W 뒤 모든 PRO Worker는 모든 상태에서 싣는다 |
| 699 ms COMMIT 앞섬을 zero-start로 읽기 | 같은 v2 앞 PRO Worker | 그 PRO Worker는 모든 PREPARE와 transition COMMIT에 `timingMode`를 싣고 두 종류 모두 700 ms 앞섬을 쓴다 |
| live LAN-direct의 숫자 `liveExpiresAt` | 같은 v2 앞 PRO Worker | 그 PRO Worker는 null을 저장하고 답하며, 앞 Worker가 저장한 숫자를 불러올 때 null로 바꾼다 |
| SESSION_FULL `message`, OPERATOR_TOAST `text` | 9.0.21 이하 일반방 방장(키도 함께 실음) | 바닥 795가 들이는 방장은 9.0.22 이상이고 키만 보낸다. 787 이상 방장은 모두 키를 싣는다 |
| 개발자 신호 프레임(developer-command, developer-invalidation, 단독 pro-queue-addition) | 2026-07-20(`d4b208cc`) 앞 신호 Worker | 그 뒤 신호 Worker는 그 문자열이 없고 내부 개발자 경로를 409 `PRO_COORDINATOR_REMOVED`로 답한다. PRO 큐 추가 알림은 `pro-room-invalidated` 서버 사건의 `addition`으로만 온다 |

보내기를 그만두는 것은 PRO opt-in 머리글 둘뿐이다. 릴리스 W의 PRO Worker부터 어느 PRO Worker도 그 머리글을 읽지 않는다.

그래서 이 릴리스의 상대는 schemaVersion 2를 처음 보내는 PRO Worker이고, 경계는 '이 App이 배포된 뒤 PRO를 그 Worker 아래로 되돌리지
않음'이다(아래 '되돌리기'). 앱 빌드 바닥은 795 그대로다.

## 증분 한눈에

부모 실패는 테스트 먼저 커밋을 그 부모 코드에서 돌린 결과(실패 / 그 실행의 전체 행)이고 각 커밋 메시지에 적혔다. 실패 행은 모두
새로 넣거나 바꾼 행이고, 양쪽 통과를 뜻한 행은 부모에서도 통과했다.

| 증분 | 항목 | 테스트 먼저 → 코드 | 부모 실패 | 런타임 경로 |
| --- | --- | --- | --- | --- |
| R3-1 | PSK-01 ~ PSK-06의 A2, PSK-04, OV-A22, Q15 | `559ef2f0` → `870529a4`, `ca359032`(`getAdministrators` 삭제) | 18 / 16,685(단위 전체 702 files, skip 1) | App |
| R3-2 | ZS-05 | `29de4013` → `23efea6a` | 1 / 196(2 files) | App |
| R3-2 | ZS-06(동작 변화) | `18cee3e7` → `b6658208`, ADR `77f65ca0` | 2 / 19(1 file) | App |
| R3-3 | PLE-04 | `79dc4836` → `2e8a34f7` | 6 / 954(10 files) | App |
| R3-4 | HDR-1, PSK-07 | `d0d84b47` → `55d8e0c7` | 4 / 147(`api.test.ts`), 주간 Playwright `e2e/pro-entry-password.test.ts` 10 / 10 | App(`cloudflare/app-worker.ts`는 주석) |
| R3-5 | STD-3, STD-4 | `4d975921` → `fc7b5996` | 5 / 70(3 files) | App |
| R3-6 | PSK-11 클라이언트(좁힘) | `30d8cfbd` → `f72629c2` | 9 / 307(3 files) | App |
| R3-7 | Q21 요구 값 비우기 | 없음 → `d965af02` | 해당 없음(값 하나, 건너뜀 행은 P2가 고정) | 없음(workflow) |
| 기록 | §2·§3·§4, hotfix-procedure, PRO 운영 문서, 이 보고서 | `39b36a0a`(문서), QA 라운드 2를 적은 문서 커밋, 리뷰를 반영한 문서 커밋 | 해당 없음 | 없음 |

## 증분

### R3-1 스냅샷 schemaVersion 1 받기 중단 (PSK-01 ~ PSK-06의 A2, PSK-04, OV-A22)

`parseProRoomSnapshot`이 schemaVersion 2만 읽는다. schemaVersion 1 갈래와 그 키 목록(`LEGACY_SNAPSHOT_SCHEMA_VERSION`,
`parseSnapshotWireVersion`, `LEGACY_PRESENCE_KEYS`, `LEGACY_VIEWER_KEYS`, `LEGACY_SNAPSHOT_KEYS`, `OPTIONAL_SNAPSHOT_KEYS`와 presence·viewer
파서의 와이어 판 인자)을 지웠다. 코디네이터 시대 키 넷이 있든 없든 v1 와이어는 null이 되어, 그것을 실은 답은 모두
`INVALID_RESPONSE`다. `passwordRequired`와 `playlistSlots`가 정확한 키 집합에 들어가고 `ProRoomSnapshot`에서 필수가 됐다. 읽는 쪽의
대체값(없는 `passwordRequired`를 보호로 보던 것, 없는 `playlistSlots`를 null로 내던 것)과 playlist-state-manager의
`requirePlaylistSlots`, `activePlaylistSlot`을 지웠다. 남긴 것: 재생과 presence의 `coordinatorEpoch` 일치, 아무도 없는 sleeping 방만
받는 조건. 관리자 목록 PUT·DELETE 답은 `{ administrators }`만 받는다(PSK-04). bootstrap은 모든 상태에서 `passwordRequired`를 요구하고
open이면 false, pin_required면 true다(Q15). 부르는 곳 없는 `getAdministrators`는 따로 커밋에서 지웠다(`git log -S`로 `c8aa1139`에서
생긴 뒤 제품 호출이 없음. PRO Worker의 GET 경로는 그대로).

- 부모 `91601774`에서 단위 전체 16,685행 가운데 18행 실패: `domain.test.ts`(v1 와이어 셋의 거절, 두 필드 없는 스냅샷, 같은 revision과
  다음 revision의 v1 와이어), `api.test.ts`(v1 스냅샷을 실은 GET, 세션, 계정 분리, 전체 하트비트 답, `authorityVersion`이 든 관리자
  답, `passwordRequired` 없는 bootstrap의 activation_required·pin_required·suspended, `playlistSlots` 없는 스냅샷),
  `runtime-playlist-slots.test.ts`(`playlistSlots` 없는 Worker 스냅샷이 입장을 `PRO_ROOM_SNAPSHOT_INVALID`로 멈춤).
- 고정값: 스냅샷 도우미가 두 필드를 빠뜨린 고정값에 `passwordRequired` true와 playlist 하나의 `playlistSlots`를 더한다(두 와이어
  모두). 만든 스냅샷의 playlist를 바꾸는 모의 서버(약 35행, 여섯 파일)는 새 시험 도우미 `recountProPlaylist`로 활성 칸 개수를 다시
  센다. 모두 부모에서 통과한다. 제품 export는 더하지 않았다.
- e2e: PRO 고정값(`e2e/helpers/pro-room-fixture.ts`)이 `passwordRequired` true인 schemaVersion 2 스냅샷이고 bootstrap 모의
  여섯(critical-browser 셋, pro-upload-recovery, pro-activation-account, dialog-locale-layout)이 `passwordRequired`를 싣는다. 로컬
  critical E2E(`test:e2e:critical`, Chromium 98행)는 테스트 먼저 상태와 코드 커밋 `ca359032`에서 모두 98 / 98 통과했다(증분 작업
  로그).

### R3-2 시작 종류는 timingMode로만 (ZS-05, ZS-06)

ZS-05: transition COMMIT은 `timingMode`가 zero-start일 때만 zero-start로 시작하고, 종류를 싣지 않은 COMMIT은 앞섬이 몇이든 예약
제어다. 그 앞 PRO Worker가 zero-start를 표시하던 699 ms 앞섬 판독(`PRO_PLAYBACK_ZERO_START_WIRE_LEAD_MS`)을 지웠다. 필드는 선택이라
(Q4) 필드 없는 COMMIT도 진행 중 타임라인에서 재생되고, 배운 시작 앞섬만 쓰지 않는다. 부모 `ca359032`에서 1 / 196 실패(699 ms의 새
행). 700 ms와 702 ms 행은 양쪽 통과이고, 필드로 옮긴 재생 행 셋도 양쪽 통과다.

ZS-06(의도한 동작 변화, Q5): 하트비트 스냅샷 복원이나 재조정이 이 App이 준비한 PREPARE의 checkpoint를 COMMIT 프레임보다 먼저
내려놓으면, `restorePlaybackCheckpoint`가 그 PREPARE의 전환으로 커밋하면서 이제 PREPARE가 적은 종류도 싣는다. 그래서 하트비트가
COMMIT을 앞지른 기기도 방의 다른 기기처럼 zero-start로, 배운 시작 앞섬을 써서 시작한다. 맞는 PREPARE가 없거나(늦은 입장, 방이 그
revision을 다른 checkpoint로 커밋함) PREPARE가 예약 제어나 종류 없음을 적었으면 복원은 예약 제어 그대로다(ZS-09). checkpoint 시각
뒤에 도착한 복원은 늦은 COMMIT처럼 다룬다. 부모 `23efea6a`에서 2 / 19 실패(복원과 재조정의 zero-start 행), 예약 제어 넷은 양쪽
통과다. 서버 권한 ADR(`docs/design/pro-room-server-authority.md`)의 시작 종류 문단이 경로마다 어느 종류를 읽는지 적는다(`77f65ca0`).
레지스트리 RO-03의 699 문장과 그 시간 시험의 699 고정도 고쳤다(Worker가 아직 읽는 2999 ms 고정은 남김).

### R3-3 숫자 LAN-direct 거절 (PLE-04)

`parseProRoomSystemAudioState`가 live LAN-direct를 `liveExpiresAt` null로만 읽는다. 그 앞 PRO Worker의 숫자 호환값(PLE-01부터 null로
읽던 것)은 다른 잘못된 값처럼 거절하고, SFU live는 여전히 양의 마감이 있어야 한다. 하트비트 답은 그 상태가 무효면 무효이므로 그런
답, `/system-audio` 상태, commit, lease 하트비트 답이 `INVALID_RESPONSE`다. live 타입은 그대로(`number | null`)다.

- 부모 `b6658208`에서 6 / 954 실패(계약 행, 전체·compact 하트비트, 상태·commit·lease 답, 컨트롤러의 `INVALID_STATE`).
- 파서에 닿는 LAN-direct 고정값을 모두 null로 옮겼다(시험 실행에서 옮기지 않으면 아홉 파일 104행이 고정값만으로 실패). 수신 슬롯의 S7
  승격 행과 5B-G6 두 시간 예산 행은 마감 없는 직접 live에서 시작해 SFU 서술자가 승격의 예산을 싣는 것을 그대로 본다. 모두 양쪽
  통과다.
- `pro-room-worker.test.ts`의 LAN-direct 교차 계약 행이 Worker 자신의 와이어가 null이고 App이 그 와이어를 그대로 읽음을 본다. 이
  행이 null을 보내는 Worker보다 이 거절이 main에 먼저 들어가는 것을 막는다.

### R3-4 opt-in 머리글 보내기 중단 (HDR-1, PSK-07)

`ProRoomApiClient`가 PRO 요청에 `X-MXQR-Pro-Entry-Policy: optional-v1`과 `X-MXQR-Pro-Playlist-Slots: v1`을 싣지 않는다. 릴리스 W의
PRO Worker부터 어느 PRO Worker도 읽지 않고, 그 앞 Worker는 이 App이 거절하는 schemaVersion 1을 보낸다. `X-MXQR-App-Build`는 남는다.
App facade의 소유권 이전 commit 주석을 고쳤다(app 경로의 주석뿐이라 target `app` 그대로). PRO 운영 문서의 bootstrap 문장이 9.0.25를
두 머리글을 모두 보내지 않는 첫 App으로 적는다. Worker 시험 주석 둘이 '모든 App이 보냄'을 9.0.24까지로 고쳤다.

- 부모 `77f65ca0`에서 `api.test.ts` 4 / 147 실패(소유권 이전, 공개 방 입장, PIN 변경, presence 입장과 스냅샷 읽기). 주간 Playwright
  `e2e/pro-entry-password.test.ts`의 공유 route 모의가 모든 `/api/pro-room/` 요청에서 두 머리글이 없음을 보므로, 부모의 e2e 빌드에서
  열 행이 모두 실패하고 이 커밋의 빌드에서 모두 통과했다.
- 남긴 것: PRO Worker의 CORS 허용 목록과 그 시험 행(뒤의 PRO 정리), e2e CORS 모의, 9.0.22 ~ 9.0.24 탭처럼 머리글을 보내는 Worker 시험
  고정값, 릴리스 smoke와 바닥 도구의 entry-policy 머리글(Q10).

### R3-5 SESSION_FULL과 OPERATOR_TOAST를 키로만 (STD-3, STD-4)

게스트가 방장의 자기 언어 대체 문구를 읽지 않는다. SESSION_FULL은 번역한 `i18nKey`를, 키가 없거나 사전에 없으면 게스트 자신의 '방
가득 참' 문구를 보이고, 검증기가 `message` 절을 지워 `message`는 읽지 않는 키다. OPERATOR_TOAST는 검증기가 `i18nKey`(128자 미만
문자열)를 요구하고 그 번역만 보인다. 이 App이 모르는 키는 아무것도 보이지 않는다(Q7). `text`는 읽지 않는 키다. ProtocolMap 타입도
따라가 `text`를 다시 넣는 송신자는 타입 검사에서 걸린다. room-authority 지문(`handleOperatorToast`의 방장·운영자 관문)은 그대로다.

- 부모 `55d8e0c7`에서 5 / 70 실패(방장 문구만 실은 room-full 프레임, `text`만 있거나 모르는 키의 운영자 알림, 열기 전 room-full,
  `protocol-validation-coverage.test.ts`의 정확 목록 비교).
- 시험 locale이 시스템 locale을 따르므로(Node의 `navigator.language`) 새 행은 글자 대신 `t(...)`를 기대하고 한국어 방장 문구를
  보낸다. 영어 시스템에서만 'Room is full'이 게스트 문구와 우연히 같다.

### R3-6 은퇴한 PRO 개발자 신호 프레임 (PSK-11 클라이언트, 좁힘)

developer-command, developer-invalidation, 단독 pro-queue-addition 신호 프레임은 브라우저 코디네이터의 것이었다. 신호 Worker는
2026-07-20 `d4b208cc`(PRO 방 권한을 서버로 옮김)에서 두 문자열을 잃었고(`git log -S`), 내부 개발자 경로는 409
`PRO_COORDINATOR_REMOVED`로 답한다(`cloudflare-signaling-worker.test.ts`가 고정). PRO 큐 추가 알림은 `pro-room-invalidated` 서버
사건의 `addition`으로만 App에 오고 `acceptProRoomRealtimeFrame`이 읽는다(RO-46).

- 지운 것: `cloudflare-signaling.ts`의 세 프레임 파싱, 호스트 소켓의 코디네이터 전용 방출, 게스트 소켓의 거절(이제 다른 모르는
  프레임처럼 무시). `transport/types.ts`의 `DeveloperCommandFrame`, `DeveloperInvalidationFrame`, 두 파서, `TransportPeer`의 세 사건.
  bus 짝 하나를 한 커밋에서: `peer.ts`가 그 전송 사건을 `network:pro-queue-addition`으로 넘기던 것, `runtime.ts`의 그 리스너,
  EventMap 항목(bus-pairing 203 / 203 → 202 / 202). 개발자 `set_effects` 명령이 유일한 제품 호출이던 App의
  `parseRoomEffectsPatch`, `RoomEffectsPatch`, `mergeRoomEffectsForTests`(남기면 dead-exports 시험 전용이 21로 늘어남. PRO Worker는
  자기 사본을 씀).
- 남긴 것: `ProQueueAdditionFrame`과 `parseProQueueAdditionFrame`(서버 사건 경로), 전송 계층 PRO 신호 모드의 티켓 role
  'coordinator'. 제품 코드는 `d4b208cc` 뒤로 전송 계층에 `proSignaling`을 넘기지 않으므로 그 PRO 모드 전체가 운영에서 쓰이지
  않는다. role만 지우면 계속 쓰이지 않을 모드의 코디네이터 호스트 행(`cloudflare-signaling.test.ts`, `pro-epoch-close-name.test.ts`)을
  다시 써야 해서, 그 모드는 뒤의 정리 한 번으로 지우도록 남겼다. 신호 Worker 쪽은 그대로다(Q15).
- 부모 `fc7b5996`에서 9 / 307 실패(세 프레임 × 일반방 호스트, 일반방 게스트, PRO member 소켓에서 오류 없이 무시. 부모는
  `UNEXPECTED_DEVELOPER_*` 오류를 냄). 코드 커밋은 코디네이터 소켓 행 넷과 두 개발자 파서 블록을 지우고 큐 추가 파서 행을
  `pro-queue-addition.test.ts`로 그대로 옮겼다. `room-effects.test.ts`는 patch 행을 지우고 상태 행을 남겼으며, 병합 행이 지키던
  `roomEffectsEqual`은 양쪽 통과 행 하나가 지킨다.

### R3-7 PRO 최소 빌드 요구 값 비우기 (Q21)

`.github/workflows/release.yml`의 'Check the App build floor the PRO Worker requires' 단계 `MXQR_PRO_ROOM_REQUIRED_APP_BUILD`를 '795'
→ ''. 그 위 주석이 왜 비었는지 적는다. 이 App 뒤에는 schemaVersion 2 보내기를 되돌리는 수리(9.0.25 전 비상 길의 기본 출구)가 모든 PRO
방을 깨뜨리므로, App을 795 아래로 내린 뒤의 수리는 schemaVersion 2를 그대로 보내고 곧 바닥을 795로 다시 올린다. 그래서 검사는 그
수리나, App 보고가 멈췄을 때의 뒤 PRO 릴리스를 막을 뿐이다(계획 Q21 (4)). 단계와 멈춤 출구, P2의 단위 행은 남고 값이 비면 요청 없이
건너뛴다('skips without a request while the PRO Worker requires no App build'). P2의 구조 행이 빈 값을 받아 시험은 그대로다. 어느
런타임 경로 목록에도 없어 target이 바뀌지 않고, 이 변경을 되돌리면 795가 돌아온다. bump는 하지 않았다.

### 기록

- release-record §2: 이 릴리스의 '배포 전' 항목, schemaVersion 2를 보내는 PRO Worker 항목의 되돌리기 줄에 9.0.25 뒤의 앞 단계,
  'PRO 시작 시계 현장 확인'에 ZS-06. §3: 요구 값 문장(795 → 비어 있음과 그 이유). §4: 머리의 현재 경계 줄((1)의 가리킴, (3)의 바닥이 (8)로 오름,
  (6)에 '9.0.25 뒤에는 (9)'와 9.0.25 전의 수리 출구, 새 (8) 9.0.25 뒤 PRO를 schemaVersion 2를 처음 보내는 PRO Worker 아래로 되돌리지
  않음과 꼭 할 때의 순서, 새 (9) 합친 순서), 이 릴리스 항목, schemaVersion 2 PRO Worker 항목의 코드 되돌리기와 수리 출구에 9.0.25
  조건, 릴리스 W 항목의 'App 파서는 둘을 선택으로 받고'를 9.0.24까지로.
- hotfix-procedure: presence close 문단(손 PRO 되돌리기 바닥이 9.0.25 뒤 schemaVersion 2 PRO Worker로 오름), App Build Floor의 요구
  값 문장(9.0.25가 비움), schemaVersion 2 PRO Worker 문장(9.0.25 전의 수리 출구, 9.0.25 뒤에는 다음 문장), 이 릴리스의 문장(PRO 손
  되돌리기 금지와 꼭 할 때의 순서, 합친 순서, 그 뒤 수리), Rollback의 CLI 문장.
- `docs/design/pro-room-architecture-and-operations.md` Rollback: 릴리스 W 앞 PRO 문단의 머리글 조건과 '파서는 둘을 선택으로'를 9.0.24까지로,
  9.0.25의 되돌리기 문단.
- `docs/README.md` 증거 목록에 이 보고서.

## 계획과 달라진 것

계획의 줄은 모두 기호로 다시 찾았다(줄은 R1, R2와 앞 증분이 밀었다). 그 밖에 계획 시점(`6a23c46e`)과 다른 것:

1. **R3 checkpoint의 App:** 계획 §4의 합친 순서는 'App을 R3 checkpoint의 R1 App으로'다. R1 뒤 9.0.23 / v796과 9.0.24 / v797이 나갔으므로 이
   릴리스의 checkpoint App은 그 직전 live App(예정으로는 9.0.24)이다. 9.0.22 이상이라 두 스키마를 모두 읽고 바닥 795 이상이라
   `lower`가 필요 없어 순서의 뜻은 같다. 영구 문서는 '9.0.25 릴리스 checkpoint의 App'으로 적었다.
2. **R3-1:** R1-6(`cc8d024b`)이 계획의 `snapshot.ts` 범위 일부(코디네이터 키 절)를 이미 지웠고, R3-1은 남은 schemaVersion 1 갈래를
   지웠다. 계획의 '참가자가 있는 sleeping 스냅샷 거부' 행은 R1-6 후속 `2e675b36`이 두 와이어로 이미 더해 다시 더하지 않았다. 관리자
   답 모의(`runtime-server-playback.test.ts`)는 R1-6 뒤 이미 `{ administrators }`라 고칠 것이 없었다. 두 필드를 필수로 하자 계획이
   보지 못한 단위 고정값(약 35행)을 맞춰야 했다. `getAdministrators`는 따로 커밋에서 지웠다(R1-4 LEAVE-1 `590c1b7d` 선례). 부모도 이미
   `passwordRequired` false 없는 open bootstrap을 거절했으므로 bootstrap의 동작 변화는 activation_required, pin_required,
   suspended뿐이다. `dialog-locale-layout`의 activation_required 모의는 요청되지 않는다(그 시험은 '/'를 연다).
3. **R3-2:** R1-10이 더한 App 699의 서술 둘(RO-03 시간 시험의 699 고정, 레지스트리 RO-03 문단)을 ZS-05 코드 커밋에서 고쳤다.
   `cloudflare/pro-room-playback-timing.ts` 머리 주석도 같은 말을 하지만 PRO와 App 두 경로에 든 파일이라 고치면 target이 `all`이 되어
   2999 읽기를 지우는 PRO 릴리스(R4)로 미뤘다. ZS-06 행은 복원만이 아니라 같은 함수를 쓰는 재조정 경로에도 두었다. 서버 권한 ADR의
   시작 종류 문단은 계획의 기록 목록에 없지만 R2-4가 쓴 그 문단이 699 판독을 적어 고쳤다.
4. **R3-3:** 계획은 숫자 LAN-direct 고정값 이동을 선택 타입 나누기의 일로 보았지만, 거절만으로 아홉 파일 104행이 고정값 때문에
   실패해 이동은 필수였다(테스트 먼저 커밋, 양쪽 통과). 선택인 live 타입 나누기는 작지 않아(런타임 타입 오류 하나, 시험 아홉 파일
   13개) 하지 않았다. 파서에 닿지 않는 숫자 고정값 둘(`session-controller.test.ts`, `system-capture-stop.test.ts`)은 남겼다.
5. **R3-4:** `e2e/pro-entry-password.test.ts:103`은 공유 route 모의에 있어 부모에서 한 행이 아니라 열 행이 모두 실패한다. App
   facade 주석은 두 곳이 틀려 통째로 다시 썼다. 계획 밖의 Worker 시험 주석 둘을 고쳤다. bus-pairing은 이 브랜치 바탕에서 계획 §5의
   202 / 202가 아니라 203 / 203이었다.
6. **R3-5:** 계획은 'Room is full'이 우연히 같다고 보았지만 시험 locale은 시스템을 따른다(위 R3-5). 닿지 않게 된
   `handleOperatorToast`의 `typeof i18nKey` 확인을 지웠다. 선택 항목(bus 타입, setup.ts 대체)은 계획의 파일 목록 밖이라 하지 않았고,
   모르는 키 행(Q7)을 더했다.
7. **R3-6 범위:** 계획의 PSK-11 클라이언트 잔재는 티켓 role 'coordinator'를 포함하지만, 전송 계층의 PRO 신호 모드 전체가
   2026-07-20 뒤로 운영 호출이 없다(제품 코드가 `proSignaling`을 넘기지 않음). role만 지우면 쓰이지 않을 모드의 코디네이터 호스트
   행을 다시 써야 해서 개발자 프레임과 bus 짝만 지웠다. 계획의 '테스트 54줄' 가운데 21줄(`cloudflare-signaling-worker.test.ts`)은
   신호 Worker를 시험하므로 Q15대로 그대로다. 개발자 명령 파서를 지우자 App의 효과 patch 파서가 죽어 함께 지웠다(dead-exports 기준치
   유지). 정리 행만이 아니라 세 프레임을 무시하는 테스트 먼저 행(9)을 두었다.
8. **기록 범위:** 계획이 적은 'the App still sends it'(PRO 운영 문서 :197-200)은 R3-4가 이미 고쳤다. 계획 밖에서 틀리게 된 문장
   셋(PRO 운영 문서 Rollback의 '9.0.14 to 9.0.21'과 '파서는 둘을 선택으로', release-record §3의 요구 값 문장)을 고쳤고, R1·R2처럼
   §2에 '배포 전' 항목을 더했다. §1 '의존성·호환'의 틀리게 되는 두 문장(8.11.33 opt-in 머리글을 'App은 계속 보내고', 릴리스 A의
   SESSION_FULL·OPERATOR_TOAST 받기)은 §1이 운영 상태라 배포 기록 PR이 고친다(§2 항목에 적음). 열차 2 보고서
   (`old-version-removal-2w-workers-2026-10-26.md`)의 같은 문장은 날짜가 붙은 근거라 두었다.
9. **가드:** bump가 없어 이 브랜치에서는 `guard:sw-cache-version`이 실패한다. `guard:release-identity`는 통과한다(QA 라운드 2).

## 정확한 개수 가드

바뀐 기준치는 없다. bus-pairing 203 / 203 → 202 / 202(R3-6이 죽은 짝 하나를 한 커밋에서 지움, 기준치가 아니라 실측). dead-exports(완전히
죽은 것 0, 시험 전용 20, 자기 전용 76), import-graph 순환 0, room-authority(직접 읽기 79, 구독 22, 쓰기 13, PRO 읽기 0, 스냅샷 읽기 0,
`handleOperatorToast` 지문 그대로), 선언된 메시지 종류 101, resource-ownership 49 records가 그대로다(QA 라운드 2). 줄 수:
`src/pro-room/runtime.ts` 4,154 / 10,000. 제품 코드 +106 / −574줄(`src/` 14 파일과 `cloudflare/app-worker.ts` 주석).

## 혼합 버전

바닥 795 뒤 운영에 새로 들어올 수 있는 App은 9.0.22(795) 이상이다.

| 조합 | 결과 |
| --- | --- |
| 9.0.25 App, schemaVersion 2를 처음 보내는 PRO Worker나 그 뒤 | 모든 스냅샷, 관리자 답, 종류 실은 PREPARE·COMMIT, null LAN-direct를 읽는다. opt-in 머리글이 없어도 Worker의 답은 같다. 하트비트가 COMMIT을 앞지른 기기도 PREPARE의 종류로 시작한다(ZS-06) |
| 9.0.22 ~ 9.0.24 App(열린 탭), 같은 PRO Worker | 바뀌지 않는다(두 스키마를 읽음). 그 탭은 opt-in 머리글을 계속 보내고 Worker는 읽지 않는다 |
| 9.0.25 App, schemaVersion 2 앞 PRO Worker(9.0.22의 PRO Worker. 손 되돌리기, (8)이 금지) | 모든 스냅샷 답이 `INVALID_RESPONSE`이고, live LAN-direct의 숫자를 거절해 그 방의 하트비트 답 전체를 버리며, 종류 없는 COMMIT을 모두 예약 제어로 시작한다(소리는 멈추지 않음). 그 탭은 새로 고칠 때까지 남는다 |
| 9.0.25 App, 그 PRO Worker가 숫자 LAN-direct를 저장한 채 한 번도 불러오지 않은 방 | 그 Worker가 불러올 때 null로 바꾸므로 답은 null이다. 그 변환은 뒤의 PRO 정리에서도 지우지 않는다 |
| 9.0.25 게스트, 9.0.22 이상 일반방 방장 | 방장이 키만 보내므로 보이는 것이 같다 |
| 9.0.25 게스트, 바닥 아래 방장(유효 바닥 0 창) | 9.0.21 이하 방장도 키를 함께 실으므로 번역한 키를 보인다. 키 없는 운영자 알림을 보낸 방장은 없다 |
| 신호 Worker | 바뀌지 않는다. 2026-07-20 뒤 어느 신호 Worker도 개발자 프레임을 보내지 않는다 |

## 되돌리기

기본은 더 높은 SemVer와 캐시 epoch의 코드 되돌리기(9.0.26 / v799 이상)다.

**실패 자동 복구:** `app`의 실패 복구는 App만 checkpoint(dispatch 때 live인 App, 9.0.22 이상)로 되돌린다. 안전하다: 그 App은
schemaVersion 1과 2를 모두 읽고, 바닥 795 이상이라 `lower`가 필요 없다. Worker 호환 바닥 평가가 실패하면 대비 목록이 App을 건너뛰어
9.0.25 App이 실패 표시인 채 live로 남는다. schemaVersion 2 PRO Worker와 짝이 맞는 의도한 상태라 안전하고 앞으로 고친다. 다만 `app`의
배포 뒤 smoke(App generation, 익명 계정 경계, PRO 방 smoke의 health·bootstrap 카나리아 둘·익명 스냅샷 401, Standard HTTPS)는 HTTP만
보고 9.0.25 파서로 PRO 답을 읽지 않는다(배포 job은 브라우저 없이 돈다). 그래서 이 릴리스가 낼 수 있는 실패, 곧 9.0.25가 실제
schemaVersion 2 스냅샷, 하트비트, 관리자, 시스템 오디오 답을 거절해 9.0.25 탭의 모든 PRO 방이 깨지는 결함은 커밋 표지를 지나고 이
복구는 돌지 않는다. 그 결함은 배포 조건 7의 배포 직후 확인이 처음 보며, 그때는 '배포 직후 확인과 기기 확인'의 '실패하면'대로 App을
손으로 되돌린다.

**손 되돌리기 경계:** release-record §4 머리의 현재 경계 줄 (8), (9)와 §4의 이 릴리스 항목이 정본이다
([§4](../release-record.md#4-복구-시-주의), [hotfix-procedure](../hotfix-procedure.md#app-build-floor)).

1. 9.0.25가 배포된 뒤 PRO Worker를 schemaVersion 2를 처음 보내는 PRO Worker 아래로 손으로 되돌리지 않는다. 'App 9.0.25가 live인
   동안'이 아니다: App을 되돌려도 열린 9.0.25 탭은 새로 고칠 때까지 남는다. 꼭 되돌려야 하면 (a) App을 이 릴리스 checkpoint의
   App으로, (b) PRO를 9.0.22의 PRO Worker로(그 아래는 Durable Object 되돌리기 바닥이라 금지). 열린 9.0.25 탭은 (b)부터 새로 고칠 때까지
   PRO 방에서 깨진다. 그 PRO 버전은 'Rollback:' 메시지라 git 출처가 없으므로 다음 수리 릴리스는 `all`이다.
2. 합친 순서: 9.0.25 뒤 App을 9.0.22(빌드 795) 아래로 내리는 일은 (a) App을 이 릴리스 checkpoint의 App으로, (b) PRO를 9.0.22의 PRO
   Worker로, (c) 9.0.15 아래면 Signaling을 9.0.22 checkpoint의 버전으로, (d) 대상 빌드로 `lower`, (e) App 순서로만 한다. (a)가 끝난
   상태는 9.0.25 앞과 같아 (b) ~ (e)는 schemaVersion 2 PRO Worker 문장의 순서와 같다. PRO를 먼저 되돌리면 9.0.25 App이 live인 동안
   PRO가 schemaVersion 1을 보내 열린 탭과 새 페이지가 모두 `INVALID_RESPONSE`를 받는다.
3. 그 길 뒤의 수리: main의 App이 schemaVersion 1을 읽지 않으므로 수리 `all`은 schemaVersion 2를 보내는 PRO를 그대로 배포하고(그
   변경을 되돌리면 모든 PRO 방이 깨짐), 수리 직후 바닥을 795로 다시 올린다(그때의 저장 바닥으로 같은 값 `set`, `set` 795, `status`,
   신호 입장 smoke). `set`은 live App 위로 못 올리므로 수리 전에는 할 수 없고, 그 사이 열린 795 앞 탭은 PRO 방에서
   `INVALID_RESPONSE`를 본다. 요구 값이 비어 사전 검사가 이 수리를 막지 않는다(R3-7).
4. 계약 표지는 바꾸지 않았다(Q8). 표지는 그 릴리스의 실패 자동 복구와 비상 배포만 막고 손 CLI 되돌리기는 막지 못하며, 바꾸면
   target `all`이 된다.

## 배포 조건과 순서

1. schemaVersion 2를 처음 보내는 PRO Worker가 머지되고 배포됐으며 그 기록 PR이 main에 있다. 이 브랜치를 그 main 위로 옮기고, 테스트
   먼저 일곱을 옮긴 부모에서 다시 돌려 같은 행만 실패함을 보며, R3-1의 로컬 critical E2E를 두 커밋에서 다시 돌리고, 9.0.25 / v798
   bump를 마지막 런타임 커밋으로 둔 뒤 이 문서와 release-record §2 항목의 SHA를 고친다. 그 PRO Worker를 손으로 되돌린 적이 있으면 그
   뒤의 `all` 수리 릴리스 뒤에만 낸다. 9.0.25 전 비상 길의 기본 출구(그 변경을 되돌리는 수리 PR)를 탔으면 바닥 795와 그 PRO Worker를
   다시 내고 기록한 뒤에만 낸다(그 전에는 교차 계약 행이 이 PR의 머지를 막는다).
2. dispatch 직전 live PRO Worker의 배포 메시지가 그 PRO Worker 머지 SHA의 `git:<sha>`(또는 그 뒤 PRO 런타임 변경이 없는 자손)다. App
   대상 부분 게이트도 PRO가 HEAD와 같은 런타임 경로인지 보고 손 되돌리기 버전에서 막지만 사람이 먼저 본다.
3. 그 PRO Worker의 배포부터 이 배포까지 런타임 의존성 변경을 머지하지 않았다.
4. 이 PR은 dispatch 직전에만 머지한다. 그때부터 이 릴리스의 기록 PR 머지까지 다른 PR을 머지하지 않는다. exact-main CI success.
5. dispatch 직전 `status`를 다시 읽어 저장·유효 795와 300초 안의 App 보고(`generatedAt - reportedAt`)를 확인한다.
6. Release: target `app`, Developer API D1 `false`, `raise_app_build_floor` `false`. PRO 최소 빌드 사전 검사는 `app`에서 돌지 않는다.
7. 배포 직후(게이트 아님): 아래 '배포 직후 확인과 기기 확인'의 나눠 줄 절차 A, B, C(W = 3)와 선택 D를 합성 방(오너가 가진 PRO
   방)에서 9.0.25 탭으로 하게 하고, 받은 관찰값을 그 절의 판정 기준과 견주어 QA 라운드 4에 적는다. 확인하는 사람에게는 판정 기준을
   건네지 않는다. 방이 뜨지 않거나 하트비트가 거절되면 그 절의 '실패하면'대로 App을 손으로 되돌린다(`app`의 smoke는 HTTP뿐이라 그
   결함에는 실패 자동 복구가 돌지 않는다).
8. 기록 PR: §1과 `Last source review` 덮어쓰기(§1 '의존성·호환'의 opt-in 머리글과 SESSION_FULL·OPERATOR_TOAST 문장 포함),
   `release-history.md` 한 행, §2의 이 항목을 '배포 뒤 확인'으로, §4의 이 항목과 현재 경계 줄 (8)에 머지 SHA, Release ID, checkpoint
   ID, hotfix-procedure의 9.0.25 문장 옆에 머지 SHA와 Release ID.

## 사용자가 알아챌 변화

- 9.0.25: 하트비트 스냅샷이 COMMIT 프레임보다 먼저 온 PRO 기기가 다른 기기처럼 zero-start로 시작한다(배운 시작 앞섬 적용). 그 밖은
  지금 운영의 PRO Worker와 바닥 위 방장이 보내지 않는 모양만 거절해 보이는 변화가 없다. 업데이트 창이 한 번 뜬다.
- schemaVersion 2 PRO Worker 아래로 PRO를 손으로 되돌린 경우(금지)만: 9.0.25 탭의 PRO 방 실패(위 '혼합 버전').

## 기록과 레지스트리

- release-record §2: 이 릴리스의 '배포 전' 항목, schemaVersion 2 PRO Worker 항목의 되돌리기 줄, 'PRO 시작 시계 현장 확인'의 ZS-06.
  §3: 요구 값 문장. §4: 머리의 현재 경계 줄((1), (3), (6), 새 (8), (9))과 이 릴리스 항목, schemaVersion 2 PRO Worker 항목, 릴리스 W 항목.
  §1은 배포 기록 PR이 덮어쓴다.
- hotfix-procedure: presence close 문단, App Build Floor의 요구 값 문장과 schemaVersion 2 PRO Worker 문장, 이 릴리스의 문장, Rollback의
  CLI 문장.
- `docs/design/pro-room-architecture-and-operations.md`(R3-4의 bootstrap 문장, 기록의 Rollback 문단),
  `docs/design/pro-room-server-authority.md`(R3-2), 레지스트리 RO-03(R3-2). 새 레코드는 없다.
- `docs/README.md` 증거 목록에 이 보고서. `release-history.md`는 배포 때.

## QA 라운드

### 1. 증분별

`91601774` 위, 커밋 시각 2026-10-29 22:44 ~ 2026-10-30 02:18 KST. Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest
`--maxWorkers=4`. 테스트 먼저 커밋마다 부모 코드에서 돌려 위 표의 행만 실패함을 봤다. 코드 커밋에서 돌린 것(커밋 메시지):

- R3-1 `870529a4`, `ca359032`: 단위 전체 702 files 통과(skip 1), 로컬 critical E2E 98 / 98(테스트 먼저 상태에서도 98 / 98).
- R3-2 `23efea6a`, `b6658208`: pro-room과 youtube 단위.
- R3-3 `2e8a34f7`: pro-room, audio, network, core 단위.
- R3-4 `55d8e0c7`: `api.test.ts`, 이 커밋의 e2e 빌드에서 `e2e/pro-entry-password.test.ts` 10 / 10.
- R3-5 `fc7b5996`: network, player, ui 단위, `guard:room-authority-boundaries`(79, 22, 13 그대로).
- R3-6 `f72629c2`: 전송, room-effects, runtime-preload, network 단위 61 files / 1,487, `tsc`, `typecheck:tests`, eslint, prettier,
  bus-pairing 202 / 202, dead-exports 0 / 20 / 76, room-authority, import-graph, source-complexity. 테스트 먼저 `30d8cfbd`에서
  `typecheck:tests`, prettier, eslint.
- R3-7 `d965af02`: `app-build-floor-script.test.ts`와 `release-deployment-state.test.ts` 177 통과와 skip 1, prettier.

### 2. 전체 검사

기록 커밋 `39b36a0a`, 2026-10-30 02:33 ~ 02:50 KST. Windows 11 로컬, Node 24.22.2 / npm 12.0.2, vitest `--maxWorkers=4`. 계획의 기본
검사 전체를 한 번 돌렸다. `build:checked`는 첫 실패에서 멈추는 사슬이라 그 단계들을 하나씩 돌렸고, bump가 없어 실패하는
`guard:sw-cache-version` 하나 말고는 모든 단계가 종료 코드 0이다. 도는 동안 커밋 밖에 있던 것은 hotfix-procedure의 요구 값 문장 위치
고침 하나(이 문서 커밋에 들어감, 어느 시험도 그 문장을 읽지 않음)뿐이다.

- release target: `scripts/release-deployment-state.mts`의 `changedRuntimePaths`, `runtimePathsForWorker`,
  `changedAppRuntimeDependencies`로 `91601774..39b36a0a`를 견줌: App 15(`cloudflare/app-worker.ts`, `src/` 14), PRO 방 0,
  remote-share 0, signaling 0, Developer API facade 0, Developer API 0, App 런타임 의존성 차이 없음. 곧 `app`만이다.
- typecheck 전체(`types:workers:check`, `typecheck:tests`, `typecheck:browser-classic`, `typecheck:node-scripts`,
  `tsconfig.tooling.json`, `tsconfig.e2e.json` 포함), `check:workers`, lint, `format:check`.
- 가드: dead-exports(399 files, 2,104 bindings, 완전히 죽은 것 0, 시험 전용 20, 자기 전용 76), import-graph(399 files, 2,075 edges,
  순환 0), bus-pairing 202 / 202, lifecycle-writes, navigation-sinks, room-authority-boundaries(직접 읽기 79, 구독 22, 쓰기 13, PRO
  읽기 0, 스냅샷 읽기 0), transport-health, standard-room-hot-path, chunk-pump, source-complexity(`src/pro-room/runtime.ts` 4,154 /
  10,000, `.github/workflows/release.yml` 1,796 / 2,000), `node scripts/check-resource-ownership.mts`(49 records / 446 files).
- 단위 전체 702 files / 16,653 통과와 skip 1(jq가 없는 로컬에서 건너뛰는 `release-deployment-state.test.ts`의 한 행), 488 s.
- Worker 설정 커버리지 69 files / 3,320 통과. 전체 86.7 / 83.54 / 94.34 / 90.97, `cloudflare/app-worker.ts` 82.31 / 77.66 / 89.62 /
  87.46, `cloudflare/pro-room-worker.ts` 87.94 / 84.36 / 96.36 / 91.99, `cloudflare/signaling-worker.ts` 85.42 / 83.27 / 95.85 / 89.22.
- 핵심 커버리지 90 files / 3,521 통과(80.92 / 75.66 / 86.92 / 84.79), `src/network/transport/cloudflare-signaling.ts` 83.37 / 81.36 /
  85.43 / 88.56(문턱 72 / 71 / 72 / 78). release-tooling 커버리지 14 files / 432 통과와 skip 1(같은 jq 행), 79.55 / 75.24 / 86.38 /
  81.48.
- `build:checked`의 단계: `guard:release-identity` 'MUSIXQUARE 9.0.22; service-worker cache epoch v795'(버전 거울이 서로 맞아 통과),
  `guard:sw-cache-version` 'FAIL: committed PWA runtime changes are newer than v795 (16d24d89)'(bump가 없어서뿐, 릴리스 담당의 bump가
  고침), brand capitalization 996 sources, 진입 842.2 KiB raw / 247.9 KiB gzip, eager JS 455.2 KiB gzip, eager total 2,010.7 KiB raw /
  532.7 KiB gzip(9.0.22의 456.5와 2,017.1 / 534.1에서 줄어듦), SW 앱 셸 95 자산, 레거시 TV(Chromium 79) 정적 검사, prod-hooks,
  prod-security, 글꼴과 나머지 inventory·hreflang·sitemap 가드.
- 로컬 Playwright(Chromium, e2e 빌드, 02:53 ~ 02:59 KST): critical E2E(`test:e2e:critical`) 98 / 98, PRO 묶음(pro-activation-account,
  pro-entry-app-update, pro-entry-password, pro-entry-retry, pro-upload-recovery, dialog-locale-layout) 39 / 39. R3-1이 바꾼 고정값과
  bootstrap 모의, R3-4가 바꾼 route 모의의 머리글 확인을 이 커밋에서 다시 돈 것이다.
- `check:worker-bundles`는 돌리지 않았다(App Worker는 주석 하나만 바뀜).

### 3. 운영 전제 (자리)

- dispatch 직전 공개 status(저장, 유효, revision, live, 보고 시각과 나이)와 live PRO Worker의 배포 메시지. (아직)

### 4. PR, 배포와 배포 직후 확인 (자리)

- PR, PR CI, 자동 코드 리뷰, exact-main CI, Release run, checkpoint. (아직)
- 배포 직후 확인: 아래 '받을 관찰값'(방 코드와 식별자는 지우고 개수와 필요한 줄만)과 '판정 기준'에 따른 판정. (아직)

## 배포 직후 확인과 기기 확인 (게이트 아님)

배포 조건 7의 배포 직후 확인(A, B, C와 선택 D)과 오너가 나중에 하는 기기 확인 후보 둘(후보 1은 백그라운드에서 막 돌아온 폰을 넣은
B, 후보 2는 10분 동안의 C)은 블라인드로 한다 ([5A 기기 절차](phase5-5a-receive-slot-2026-10-25.md#phase-5-기기-절차-오너가-나중에-쓸-것-p5-d2-a)와 같은 방식). 확인하는 사람에게는
'나눠 줄 절차'와 '받을 관찰값'만 그대로 건네고 기대값은 주지 않는다. 판정하는 쪽이 받은 값을 '판정 기준'과 견주며, 판정 기준은
건네지 않는다. 결과는 QA 라운드 4(배포 직후 확인)나 그 뒤에 더하는 QA 라운드(후보)에 적되, 방 코드와 식별자는 지우고 개수와 필요한
줄만 옮긴다.

### 나눠 줄 절차

방 코드는 따로 건넨다. 아래 `<PRO 방 코드>`를 그 코드로 바꿔 쓴다.

준비:

- 방은 오너가 가진 PRO 방이다. 고객 방은 쓰지 않고 운영 방을 새로 만들지 않는다.
- 모든 기기를 같은 Wi-Fi에 두고 VPN을 끈다. 주인 기기는 방 주인 계정으로 로그인한 데스크톱 Chrome이고, 청취자 기기는 로그아웃한 다른
  기기(폰이나 다른 브라우저)다. 기기는 모두 합쳐 넷 이하다.
- 기기마다 MUSIXQUARE 탭을 모두 닫고 새 탭에서 `https://musixquare.com/<PRO 방 코드>?mxqrLog=info`를 열어 방에 들어간다. PIN을 물으면
  넣는다. 업데이트 창이 뜨면 그 사실을 적고 '적용하기'를 누른 뒤, 그 탭을 닫고 같은 주소로 다시 연다.
- 디버그 글: 채팅에 `/debug sync`나 `/debug console`을 보내면 겹창이 뜨고 그 글이 클립보드에 한 번 복사된다. 메모에 기기 이름과 지금
  시각을 적고 그 글을 붙여 넣은 뒤 겹창 가장자리를 눌러 닫는다. 끝날 때까지 탭을 새로 고치거나 닫지 않는다.
- 메모는 확인을 맡긴 사람에게만 넘기고 공개된 곳에 올리지 않는다.

A. 들어가기(배포 직후 확인)

1. 기기마다 방에 들어간다.
2. 기기마다 `/debug sync` 글을 붙여 넣는다.

B. YouTube 시작 두 번(배포 직후 확인, 후보 1)

1. 재생목록의 YouTube 항목이 둘보다 적으면 주인 기기에서 더해 둘 이상으로 한다.
2. 주인 기기에서 재생 단추가 아니라 재생목록의 YouTube 항목을 눌러 재생을 시작하고 그 시각을 적는다.
3. 30초 넘게 지나 주인 기기에서 '다음 트랙'을 누르고 그 시각을 적는다. 다음 항목도 YouTube 항목이어야 한다.
4. 후보 1에서만: 2와 3 앞마다 청취자 폰 하나('돌아온 기기')를 홈 화면으로 1분 넘게 보냈다가 앱으로 돌아오게 하고, 돌아온 지 10초
   안에 주인 기기에서 누른다. 돌아온 시각을 적는다.
5. 3 뒤 15분 안에 기기마다 `/debug sync` 글을 붙여 넣는다.

C. 같은 Wi-Fi 공유 동안의 하트비트(배포 직후 확인은 W = 3, 후보 2는 W = 10)

1. B 뒤에 주인 기기에서 시스템 오디오 공유를 시작한다: '시스템 오디오 공유' → 소리가 나는 Chrome 탭 → '탭 오디오도 공유' 켬 → '공유'.
   그 시각을 적는다.
2. 청취자 기기마다 소리가 들리는지 보고, 끊기면 그 시각을 적는다. 어느 기기든 토스트가 뜨면 그 글과 시각을 적는다.
3. 공유를 시작하고 1분 뒤와 W분 뒤(후보 2는 5분 뒤에도) 기기마다 `/debug console` 글을 붙여 넣는다.
4. W분 뒤 주인 기기에서 공유를 멈춘다.

D. 선택(배포 직후 확인)

1. 주인 기기의 '연결'에서 청취자 기기 하나 옆의 왕관 단추(관리자 권한 부여)를 누르고, 그 기기에 관리자 표시가 생기는지 1분 동안 본다.
   생겼으면 그 관리자를 해제하고(확인 창의 '관리자 해제') 표시가 없어지는지 1분 동안 본다. 사이에 뜬 토스트를 그대로 적고 주인
   기기에서 `/debug console` 글을 붙여 넣는다.
2. 아무 기기의 새 탭에서 `https://musixquare.com/000000`을 연다. 들어가기를 요구하면 누르고, 뜬 창의 제목과 글을 그대로 적은 뒤 더
   진행하지 않고 탭을 닫는다.

### 받을 관찰값

1. 기기마다: 기기 종류와 브라우저, 업데이트 창이 떴는지, 방 화면(재생목록과 참가자 목록)이 떴는지, PIN을 물었는지, 들어가는 동안
   보인 글·오류 코드·토스트(그대로), A 2의 `/debug sync` 글.
2. B: 두 시작의 시각(후보 1은 돌아온 시각도)과 기기마다 B 5의 `/debug sync` 글.
3. C: 공유를 시작하고 멈춘 시각, 모든 기기가 같은 Wi-Fi였는지, 청취자 기기마다 소리가 끊긴 시각(없으면 '없음'), 뜬 토스트와 그
   시각, 기기마다 C 3의 `/debug console` 글.
4. D(했으면): 관리자 표시가 생기고 없어졌는지, 뜬 토스트, 주인 기기의 `/debug console` 글, `000000`에서 뜬 창의 제목과 글.

### 판정 기준 (나눠 주지 않음)

- 유효: 기기의 `/debug sync` 셋째 줄이 `Client build: app=9.0.25 | cacheEpoch=v798`로 시작한다. 아니면 그 기기의 결과는 무효이고 새
  탭에서 다시 한다.
- 들어가기: 모든 기기에 방 화면이 뜨고, 들어가는 동안 오류 글이나 코드가 없다. PIN을 물었으면 pin_required bootstrap을 지난 것이다.
  묻지 않는 방(open)에서는 이 릴리스가 바꾼 bootstrap 갈래(activation_required, pin_required, suspended) 가운데 D 2의
  activation_required만 본다.
- 시작: 시작마다, 그 시작의 `revision`에 `purpose` "prepare"이고 `outcome` "selected"인 `playback-clock` 행이 있는 기기는 같은
  `revision`의 `youtube-release` 행 `timingMode`가 "zero-start"다. 그런 행이 없는 기기(그 PREPARE를 준비하지 못함)의 예약 제어는 늦은
  입장과 같은 정해진 동작(ZS-09)이라 적기만 한다. 행은 그 시작이 COMMIT 프레임으로 왔는지 하트비트 스냅샷(ZS-06)으로 왔는지 말하지
  않는다. 9.0.25는 두 길 모두 PREPARE의 종류로 시작하므로 이 기준은 ZS-06의 회귀를 잡지만, 돌아온 기기가 그 길을 탔는지는 확인하지
  못한다. `[PRO YouTube] Zero-start playback released`는 `log.debug` 줄이라 운영 로그 수준(WARN)이나 `?mxqrLog=info`의
  `/debug console`에 나오지 않으므로 쓰지 않는다.
- 하트비트: 먼저 공유가 끝까지 LAN-direct였는지 본다. 모든 기기가 같은 Wi-Fi였고 어느 `/debug console`에도 `[ProSysAudioSFU]`,
  'Promoted LAN-direct publication to SFU', 'LAN-direct to SFU promotion failed' 줄이 없어야 하며, 아니면 이 부분은 무효라 다시 한다.
  그러면 공유 시작부터 W분 동안 기기마다 '[PRO] Presence heartbeat failed', 'Heartbeat state was not applied', 'Lease heartbeat
  failed', 'LAN-direct authority heartbeat grace elapsed' 줄이 없고 청취자 소리가 끊기지 않았으면 통과다. 9.0.25가 하트비트 답을
  거절하면(스냅샷이나 live LAN-direct의 숫자 `liveExpiresAt` 때문에 `INVALID_RESPONSE`) 답 전체가 버려지므로, 청취자에게는 '[PRO]
  Presence heartbeat failed'가 하트비트(약 15초)마다 나오고 'Heartbeat state was not applied'는 나오지 않는다. 공유자에게는 'Lease
  heartbeat failed'도 나오고, 약 60초 뒤 'LAN-direct authority heartbeat grace elapsed' 줄과 함께 공유가 멈춘다. 그 줄들이 하트비트마다
  이어지거나 어느 줄이든 `INVALID_RESPONSE`를 말하면 하트비트가 거절된 것이다. 이어지지 않는 한두 줄만 있으면 한 번 다시 한다. 읽은 글의 첫 줄 시각이 공유 시작보다 늦으면 그 앞은 300줄 고리 밖이므로
  그 기기의 개수는 그 시각부터의 개수로 적는다.
- D: 관리자 표시가 생기고 없어졌으며, '네트워크 오류가 발생했어요' 토스트와 '[Connect] Could not grant administrator', '[Connect]
  Could not revoke administrator' 줄이 없다(답을 거절해도 서버의 변경은 다음 하트비트 스냅샷으로 보일 수 있어 표시만으로는 판정하지
  않는다). `000000`에서는 '아직 준비 중인 PRO 방이에요' 창이 뜬다.

### 실패하면 (배포 직후 확인)

이 소절도 건네지 않는다. 배포 직후 확인에서 방이 뜨지 않거나 하트비트가 거절되면(위 판정 기준. D를 했다면 관리자 답이나 활성화 전
bootstrap의 거절도 같다) 9.0.25가 실제 schemaVersion 2 답을 거절하는 결함이다. 그 결함은 커밋 표지를 지났고 실패 자동 복구는 돌지
않았으므로(위 '되돌리기') 손으로 한다:

1. App을 9.0.25 릴리스 recovery checkpoint의 App(dispatch 때 live였던 App, 9.0.22 이상)으로 되돌린다. hotfix-procedure의
   [Rollback](../hotfix-procedure.md#rollback) CLI 되돌리기다(`versions deploy <그 버전 ID>@100%`,
   `--config cloudflare/wrangler.app.toml`, message `Rollback: <이유>`). 저장 바닥이 795인 동안 `lower`는 필요 없다.
2. PRO Worker는 그대로 둔다. 그 App은 schemaVersion 2를 읽고, release-record §4 현재 경계 줄 (7)대로 PRO를 schemaVersion 2를 처음
   보내는 PRO Worker 아래로 되돌리지 않는다.
3. release-record §1과 `Last source review`를 덮어쓰고 `release-history.md`에 한 행을 더한다.
4. 앞으로 고친다. 되돌린 App 버전은 `Rollback:` 메시지라 git 출처가 없으므로 다음 수리 릴리스는 `all`이고
   ([hotfix-procedure의 출처 문단](../hotfix-procedure.md#normal-hotfix)), 그 사이 다른 Worker의 부분 릴리스는 부분 게이트가 출처
   없는 App에서 막는다.

열린 9.0.25 탭은 새로 고칠 때까지 PRO 방에서 깨진 채 남는다. 시작 기준만 어긋나면 소리는 멈추지 않으므로 손으로 되돌리지 않고, QA
라운드 4에 적은 뒤 기본 되돌리기(더 높은 SemVer의 코드 되돌리기)나 앞으로 고치기로 다룬다.

## 확인하지 않은 것

- main 위로 옮긴 뒤 테스트 먼저 다시 돌리기, R3-1의 critical E2E 다시 돌리기, bump 뒤 `build:checked`(이 브랜치의
  `guard:sw-cache-version`은 bump가 없어 실패).
- 실제 schemaVersion 2 PRO Worker와 이 App의 브라우저 왕복. 로컬 e2e는 고정값과 모의 답이고, Worker 출력과 App 파서를 잇는 것은
  in-process 교차 계약 행이다. 릴리스의 배포 뒤 smoke도 HTTP뿐이라 이 왕복은 배포 직후 확인이 처음 본다.
- 운영 단계와 배포, 실기기와 iOS Safari, WebKit 레인 전체, Full E2E(로컬에서는 critical E2E와 PRO 묶음만 Chromium으로 돌림).
- 전송 계층 PRO 신호 모드(티켓 role 'coordinator' 포함)의 정리. 2026-07-20 뒤 운영 호출이 없고 R3-6은 개발자 프레임만 지웠다.
