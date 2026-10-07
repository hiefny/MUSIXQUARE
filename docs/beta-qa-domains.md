# 베타 전체 프로젝트 QA 도메인

| Field | Value |
| --- | --- |
| Status | Guide — QA 범위 설계, 실행 결과 아님 |
| Applies to | mxqr_beta 전체 제품·브라우저·서버·데이터·QA 환경 |
| Last source review | 2026-10-07 — QA082의 현행 제한 재확인 |
| Executable sources | [제품 소스](../src/), [브라우저 자산](../browser/), [Workers](../cloudflare/), [E2E](../e2e/), [도구/빌드](../package.json) |
| Related documents | [베타 현재 상태](beta-release-readiness.md), [허용한 설계·제약](known-accepted.md), [모바일 확대 정책](mobile-app-zoom-policy.md), [문서 허브](README.md) |

초기 소스 검토 기준은 239bfe595aa8d9337a9e10b4165907182eeb386b이다.
2026-10-07의 30라운드 QA(`9afc36b4d8bccc575a923b0dfaadd103145ba09f`)에서
QA082의 폐기된 일일 BOT 제한 문구를 현행 분/시간 제한으로 바로잡았다.
**현재 베타를 하나의 제품으로 보고 30개 대분류·122개 세부 QA 범위를 정리했다.**
main과의 차이 여부와 관계없이 사용자 기능, 권한, 데이터, 실패·복구 경계를 포함한다.

이 문서는 새 결함 발견이나 새 테스트 통과를 보고하지 않는다. 연결한 기존 검사는
검증을 시작할 위치이며, 해당 도메인의 모든 조건을 이미 검증했다는 뜻은 아니다.
기존 결과·미확정 관측·실기 한계는 베타 현재 상태와 각 날짜의 보고서에서 확인한다.
후속 변경 시 기존 QA 식별자를 유지하고 범위를 분할·추가한 관계를 기록한다.

## 우선순위와 검증 방법

P0/P1/P2는 **QA 실행 순서**다. 발견된 결함의 심각도나 배포 승인 상태가 아니다.

| 순서 | 의미 | 범위 수 |
| --- | --- | ---: |
| P0 | 권한·출력·세션·데이터 경계를 먼저 확인한다. 실패 시 핵심 사용이나 격리가 깨질 수 있다. | 62 |
| P1 | 기기·실패 복구·지원 경계·성능·사용 가능성을 넓혀 확인한다. | 54 |
| P2 | 표시·집계·애니메이션 등의 정확성과 완성도를 확인한다. | 6 |

| 방법 | 확인할 수 있는 범위와 한계 |
| --- | --- |
| 자동 | 모듈·프로토콜·Worker handler·로컬 SQLite·계약/산출물 검사. mock/fake clock 사용 여부를 결과에 남긴다. |
| 브라우저 | 실제 DOM·gesture·iframe 경계·AudioContext·여러 context·빌드 자산. 모사 iframe이나 stub이면 외부 서비스 검증으로 기록하지 않는다. |
| 로컬서비스 | 격리한 Worker/DO/D1/R2·PeerJS·loopback 통합. handler mock 통과와 실제 서비스 통합 통과를 구분한다. |
| 실기 | 실제 iOS/Android/데스크탑·설치 PWA·출력 장치·마이크/캡처·네트워크. 모바일 viewport나 headless WebKit으로 대체할 수 없다. |
| 운영확인 | 설정·binding·schema·자산·버전·복구 요건의 계약 대조. 필요한 실제 외부 상태는 별도 read-only 증거로 구분한다. |

대회 동결 중에는 mxqr_beta의 격리한 로컬 QA를 진행한다. 아래 운영 계약 항목은
main 변경·프로덕션 쓰기/배포·Operations Drift Audit 재활성화의 허가가 아니다.

## 대분류 지도

| 번호 | 도메인 | 세부 범위 | 핵심 검증 |
| ---: | --- | --- | --- |
| 1 | 큐 모델·목록 | QA001–QA002 (2) | 항목 식별·삭제/재정렬·반복/셔플·긴 목록 |
| 2 | 재생 제어·상태 전이 | QA003–QA007 (5) | 출력 소유권·최신 명령·탐색/정지/재개·종료 |
| 3 | 파일 입력·기본 디코딩 | QA008–QA011 (4) | 선택/drop·업로드·decode 취소·기기별 실패와 정상 곡 복귀 |
| 4 | 대용량 하이브리드 엔진 | QA012–QA016 (5) | 엔진 선택·지원 코덱·타임라인·구간 PCM·Worker 정리 |
| 5 | 공유 시계·파일 싱크 | QA017–QA019 (3) | 공통 시작·부호 있는 보정·drift·시계 변화·실제 음향 |
| 6 | 오디오·DSP·출력 장치 | QA020–QA028 (9) | 채널·효과·mute·사용자 활성화·OS 중단·브라우저 수명 |
| 7 | RAM·파일 복구·장시간 성능 | QA029–QA031 (3) | 메모리 소유권·누락 복구·정체·자원 누적 |
| 8 | P2P 파일 전송·프리로드 | QA032–QA036 (5) | 무결성·역순·재개·송신 압력·전달 정책·승격 |
| 9 | Standard 방·입장·네트워크 | QA037–QA042 (6) | 초대/QR/PIN·권한·bootstrap·signaling·연결 생존 |
| 10 | 시스템 오디오 공유 | QA043–QA046 (4) | 캡처 거절·direct/SFU·단일 출력·공유 종료 복원 |
| 11 | YouTube | QA047–QA055 (9) | 검색·iframe·playlist·광고/오류·시작 barrier·실기 싱크 |
| 12 | 데모 | QA056–QA058 (3) | 진입/종료·소스/효과 복원·단계·공통 시작 |
| 13 | PRO 방·서버 권위 | QA059–QA067 (9) | claim·세션·lease·revision·PREPARE/COMMIT·저장 미디어 |
| 14 | 계정·로그인·탈퇴 | QA068–QA072 (5) | OAuth·쿠키·최신 로그인·닉네임·통계·삭제 fence |
| 15 | Developer API | QA073–QA076 (4) | 키/scope·DTO·CAS·재요청·명령 결과·업로드 소유권 |
| 16 | 채팅·명령·BOT | QA077–QA082 (6) | 거부/초안·안전한 표시·권한·링크·읽기 위치·늦은 BOT |
| 17 | Remote Share·R2 | QA083–QA085 (3) | capability·암호화·다운로드 정체·quota·재요청·정리 |
| 18 | 관리자·서비스 정책·PRO 배정 | QA086–QA089 (4) | 관리자 인증·maintenance·공지·campaign/voucher |
| 19 | 방 세대·소유권 이전 | QA090–QA091 (2) | 코드 재사용·폐기·이전 세대 격리·transfer saga |
| 20 | DB·마이그레이션·운영 집계 | QA092–QA093 (2) | D1/DO 제약·이전 DB 업그레이드·중복/부분 실패·통계 |
| 21 | 공개 요청 보안·남용 방어 | QA094 (1) | Origin/CORS/CSP·입력 한도·PoW·rate-limit·정보 노출 |
| 22 | 의존성·도구체인 | QA095 (1) | lock·override 호환성·실제 설치 동작·audit·서명 |
| 23 | UI·모바일·접근성 | QA096–QA104 (9) | 제어 표시·seek·모달·키보드·레이아웃·스크린리더·테마/대비 |
| 24 | 다국어·RTL·폰트 | QA105–QA107 (3) | 언어 우선순위·동적 문구·placeholder·bidi·폰트 실패 |
| 25 | 번역 기여·검토·내보내기 | QA108–QA110 (3) | 초안·다중 탭·제안/투표·동시 검토·cursor·export |
| 26 | PWA·초기 로딩·업데이트 | QA111–QA115 (5) | 실제 설치·오프라인·private cache·다중 버전·reset 복구 |
| 27 | 공개 페이지·콘텐츠 전달 | QA116 (1) | 직접 경로·404·언어·RSS/이미지 장애·숨긴 글·캐시 |
| 28 | 전역 자원 수명·지연 로딩 | QA117–QA118 (2) | 세션 정리·이벤트/타이머·cleanup 예외·chunk 실패 |
| 29 | 진단·로그·관측 정확성 | QA119 (1) | 현재 세션/시계·상한·로컬 전용·익명화·실제 음향 구분 |
| 30 | QA 환경·산출물·운영 계약 | QA120–QA122 (3) | 로컬 격리·빌드 결과·브라우저 기준·binding·복구 요건 |

## 세부 QA 범위

각 항목은 판정 기준·권장 검증 방법·대표 구현·기존 검사 진입점을 갖는다.
한 항목 안의 정상·경계·실패·경합 시나리오는 실행 계획에서 개별 test case로 확장한다.

## 1. 큐 모델·목록

### QA001. 큐 항목 identity·순서·용량·반복/셔플의 기본 모델 — P0

**판정:** 같은 파일·영상이 여러 번 있어도 queueItemId로 구분하고 인덱스 변경 뒤 현재 항목을 다시 찾는다. 빈 큐·첫/끝 항목·현재 항목 삭제·동시 추가·상한·중복/낡은 snapshot·반복/셔플에서 유효한 다음 항목을 한 번만 선택한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/player/queue-model.ts](../src/player/queue-model.ts), [src/player/playlist.ts](../src/player/playlist.ts)

**기존 검사 진입점:** [src/player/__tests__/queue-model.test.ts](../src/player/__tests__/queue-model.test.ts)

### QA002. 큐 목록 조작·확장·선택 표시 — P1

**판정:** reorder·remove·현재 곡 이동·서브곡 확장에서 올바른 큐 항목을 조작한다. 긴 목록의 progressive render와 제목 갱신이 selection·focus를 보존한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/ui/playlist-view.ts](../src/ui/playlist-view.ts), [src/ui/playlist-reorder.ts](../src/ui/playlist-reorder.ts)

**기존 검사 진입점:** [src/ui/__tests__/playlist-view.test.ts](../src/ui/__tests__/playlist-view.test.ts), [src/ui/__tests__/playlist-reorder.test.ts](../src/ui/__tests__/playlist-reorder.test.ts)

## 2. 재생 제어·상태 전이

### QA003. 재생 소유권과 상태 전이 — P0

**판정:** 파일·YouTube·시스템 공유의 출력 소유자는 하나이며, 이전 콜백은 새 준비·재생·정지 상태를 바꾸지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/player/ownership.ts](../src/player/ownership.ts), [src/player/lifecycle.ts](../src/player/lifecycle.ts)

**기존 검사 진입점:** [src/player/__tests__/ownership.test.ts](../src/player/__tests__/ownership.test.ts), [src/player/__tests__/playback-state-contract.test.ts](../src/player/__tests__/playback-state-contract.test.ts)

### QA004. 비동기 재생 의도의 우선권 — P0

**판정:** 빠른 곡 교체와 PLAY·PAUSE·seek의 완료 순서가 뒤집혀도 최신 의도만 적용하며, 이전 finally는 새 loader·lock을 지우지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/player/_state.ts](../src/player/_state.ts), [src/player/decode.ts](../src/player/decode.ts), [src/player/transport.ts](../src/player/transport.ts)

**기존 검사 진입점:** [src/player/__tests__/concurrency-invariants.test.ts](../src/player/__tests__/concurrency-invariants.test.ts), [src/player/__tests__/load-epoch.test.ts](../src/player/__tests__/load-epoch.test.ts)

### QA005. 탐색·정지 체크포인트·재개 — P0

**판정:** 재생·정지 중 탐색과 준비 중 PAUSE, 늦은 PREPARE에서도 정확한 정지 위치를 보존하고 재개한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/player/guest-file-pause.ts](../src/player/guest-file-pause.ts), [src/player/transport.ts](../src/player/transport.ts), [src/player/playback.ts](../src/player/playback.ts)

**기존 검사 진입점:** [src/player/__tests__/file-prepare-pause.test.ts](../src/player/__tests__/file-prepare-pause.test.ts), [src/player/__tests__/transport-position.test.ts](../src/player/__tests__/transport-position.test.ts)

### QA006. 자연 종료와 다음 곡 진입 — P0

**판정:** 짧은 클립·중복 ended·늦은 타이머·seek 중 종료에서도 곡을 끝까지 재생하고 다음 곡·반복·셔플에 한 번만 진입한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/player/transport.ts](../src/player/transport.ts), [src/player/playlist.ts](../src/player/playlist.ts)

**기존 검사 진입점:** [src/player/__tests__/transport-short-file-end.test.ts](../src/player/__tests__/transport-short-file-end.test.ts), [e2e/playback-advanced.test.ts](../e2e/playback-advanced.test.ts)

### QA007. OS 미디어 제어와 로컬 일시정지 — P1

**판정:** MediaSession 동작이 참가자 권한에 맞고, 게스트의 로컬 일시정지를 늦은 PONG·재합류가 취소하지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/player/media-session.ts](../src/player/media-session.ts), [src/player/local-output-rejoin.ts](../src/player/local-output-rejoin.ts)

**기존 검사 진입점:** [src/player/__tests__/media-session-file-rejoin.test.ts](../src/player/__tests__/media-session-file-rejoin.test.ts), [src/player/__tests__/local-output-rejoin.test.ts](../src/player/__tests__/local-output-rejoin.test.ts)

## 3. 파일 입력·기본 디코딩

### QA008. 파일 선택·분류·드래그 입력의 수명 — P1

**판정:** 선택기와 drop이 같은 정책으로 MIME 없음/binary·대소문자 확장자·명시적 비오디오 MIME·혼합 파일·디렉터리·cloud placeholder를 구별한다. 확인 중 권한 철회·방 종료·데모 진입·반복 drop·Escape에서 잘못 추가하거나 브라우저가 파일로 이동하지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/media/audio-file.ts](../src/media/audio-file.ts), [src/ui/file-drop.ts](../src/ui/file-drop.ts)

**기존 검사 진입점:** [src/media/__tests__/audio-file.test.ts](../src/media/__tests__/audio-file.test.ts), [src/ui/__tests__/file-drop.test.ts](../src/ui/__tests__/file-drop.test.ts)

### QA009. 기본 전체 PCM 디코딩의 수명 — P0

**판정:** 직접 로드·수신 완료·프리로드 승격·데모의 decode 결과가 정확한 파일 소유권에만 적용되고 실패 시 이전 출력이 남지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/player/decode.ts](../src/player/decode.ts)

**기존 검사 진입점:** [src/player/__tests__/decode.test.ts](../src/player/__tests__/decode.test.ts), [e2e/disconnect-during-decode.test.ts](../e2e/disconnect-during-decode.test.ts)

### QA010. 기기별 재생 불가 판정과 복구 — P0

**판정:** terminal codec 실패와 재시도 가능한 출력·Worker 시작 실패를 구별하고, 실패 곡 반복 재시도를 막으며 다음 정상 곡에 재합류한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/player/device-track-failure.ts](../src/player/device-track-failure.ts), [src/player/decode.ts](../src/player/decode.ts), [src/player/playlist.ts](../src/player/playlist.ts)

**기존 검사 진입점:** [src/player/__tests__/failed-file-revisit.test.ts](../src/player/__tests__/failed-file-revisit.test.ts), [src/player/__tests__/decode.test.ts](../src/player/__tests__/decode.test.ts)

### QA011. 운영자 파일 uplink와 큐 반영 — P1

**판정:** 권한 있는 업로드를 정확한 host upload 세션에 귀속하고 권한 철회·재접속·취소·큐 용량 경계에서 부분 업로드·허위 성공을 남기지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/network/operator-file-uplink.ts](../src/network/operator-file-uplink.ts), [src/player/playlist.ts](../src/player/playlist.ts)

**기존 검사 진입점:** [src/network/__tests__/operator-file-uplink.test.ts](../src/network/__tests__/operator-file-uplink.test.ts), [src/player/__tests__/host-file-queue-capacity.test.ts](../src/player/__tests__/host-file-queue-capacity.test.ts)

## 4. 대용량 하이브리드 엔진

### QA012. 엔진 선택과 메모리 추정 — P1

**판정:** 기기별 임계값의 전·동일·초과 및 메타데이터 실패를 구별하고, 큰 곡 뒤 작은 곡은 기본 엔진으로 돌아간다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/player/decode-admission.ts](../src/player/decode-admission.ts), [src/player/large-file-policy.ts](../src/player/large-file-policy.ts)

**기존 검사 진입점:** [src/player/__tests__/large-file-policy.test.ts](../src/player/__tests__/large-file-policy.test.ts), [e2e/hybrid-file-engine.test.ts](../e2e/hybrid-file-engine.test.ts)

### QA013. 코덱·컨테이너 허용과 거부 처리 — P1

**판정:** 허용 입력은 준비하고 미지원·손상 입력은 명확히 거부하며, 거부가 방 전체 중단이나 무한 재시도를 만들지 않는다. 지원하지 않는 로컬 동영상 입력과 큰 Opus/Vorbis 등은 지원 계약에 따라 거부하며, 큰 파일을 무조건 전체 PCM 디코딩으로 우회하지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/player/large-audio/index.ts](../src/player/large-audio/index.ts), [src/player/large-audio/aac-decoder.ts](../src/player/large-audio/aac-decoder.ts)

**기존 검사 진입점:** [src/player/large-audio/__tests__/codec-support.test.ts](../src/player/large-audio/__tests__/codec-support.test.ts), [src/player/large-audio/__tests__/aac-decoder.test.ts](../src/player/large-audio/__tests__/aac-decoder.test.ts)

### QA014. 인코더 지연·끝 패딩·컨테이너 타임라인 — P0

**판정:** 허용한 코덱·프로파일에서 MP3 gapless·AAC trim/edit·SBR/PS 형식·다채널 순서를 반영해 시작·seek·끝의 길이와 시간 정렬을 유지한다. 지원 계약 밖의 입력은 통제된 거부로 판정한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/player/large-audio/mp3-gapless.ts](../src/player/large-audio/mp3-gapless.ts), [src/player/large-audio/aac-container-timing.ts](../src/player/large-audio/aac-container-timing.ts), [src/player/large-audio/aac-decoder.ts](../src/player/large-audio/aac-decoder.ts)

**기존 검사 진입점:** [e2e/large-audio-codec-parity.test.ts](../e2e/large-audio-codec-parity.test.ts), [e2e/large-audio-aac-parity.test.ts](../e2e/large-audio-aac-parity.test.ts)

### QA015. 구간 PCM 공급과 청크 경계 — P0

**판정:** 선행 예약·보유 PCM을 제한하고 유의미한 청크 무음·중복·시간 이동을 막으며, background 지연 후 현재 타임라인으로 복귀한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/player/large-audio/bounded-playback.ts](../src/player/large-audio/bounded-playback.ts), [src/player/large-audio/pcm-chunk-guards.ts](../src/player/large-audio/pcm-chunk-guards.ts)

**기존 검사 진입점:** [src/player/large-audio/__tests__/bounded-playback.test.ts](../src/player/large-audio/__tests__/bounded-playback.test.ts), [e2e/large-audio-codec-parity.test.ts](../e2e/large-audio-codec-parity.test.ts)

### QA016. 디코더 Worker와 출력 자원의 해제 — P1

**판정:** 준비 취소·연속 seek·곡 교체·실패·방 종료에서 reader·Worker·출력 참조를 해제하고 지연 중 Worker 누적을 막는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/player/large-audio/bounded-track.ts](../src/player/large-audio/bounded-track.ts), [src/player/large-audio/worker-call.ts](../src/player/large-audio/worker-call.ts), [src/player/file-playback-resource.ts](../src/player/file-playback-resource.ts)

**기존 검사 진입점:** [src/player/large-audio/__tests__/track-lifecycle.test.ts](../src/player/large-audio/__tests__/track-lifecycle.test.ts), [src/player/large-audio/__tests__/decoder-failure-worker-cleanup.test.ts](../src/player/large-audio/__tests__/decoder-failure-worker-cleanup.test.ts)

## 5. 공유 시계·파일 싱크

### QA017. 파일의 공통 시작 예약 — P0

**판정:** 방장·게스트·늦은 참가자가 같은 논리 위치와 시작 시각을 사용하며, 초기화·구간 준비 지연을 중복 가산하지 않는다. 서로 다른 실제 출력 장치의 첫 음과 지속 음향 차이도 별도로 측정한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/player/transport.ts](../src/player/transport.ts), [src/player/file-play-timing.ts](../src/player/file-play-timing.ts)

**기존 검사 진입점:** [src/player/__tests__/file-play-timing.test.ts](../src/player/__tests__/file-play-timing.test.ts), [e2e/local-file-common-start.test.ts](../e2e/local-file-common-start.test.ts)

### QA018. 기기별 수동 싱크 보정 — P0

**판정:** 양수·음수·극단값 보정은 로컬 출력만 바꾸며, 방의 시작·종료 시각과 시작 전 필요한 무음 대기를 보존한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/player/transport.ts](../src/player/transport.ts)

**기존 검사 진입점:** [src/player/__tests__/transport-manual-start.test.ts](../src/player/__tests__/transport-manual-start.test.ts), [e2e/local-manual-start.test.ts](../e2e/local-manual-start.test.ts)

### QA019. 공유 시계 보정과 자동 재동기화 — P0

**판정:** RTT·늦은/중복 PONG·sample 만료·OS 시계 step을 처리하고 입장·drift·local pause·수동 offset에 맞게 현재 출력만 보정한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/network/shared-clock.ts](../src/network/shared-clock.ts), [src/network/sync.ts](../src/network/sync.ts), [src/network/sync-worker.ts](../src/network/sync-worker.ts)

**기존 검사 진입점:** [src/network/__tests__/shared-clock.test.ts](../src/network/__tests__/shared-clock.test.ts), [e2e/playback-sync.test.ts](../e2e/playback-sync.test.ts)

## 6. 오디오·DSP·출력 장치

### QA020. 오디오 그래프 연결과 재초기화 — P0

**판정:** source를 안정된 출력 경로에 한 번 연결하고, 효과·역할·AudioContext 변경 시 이중 출력·끊어진 경로·이전 context 연결을 남기지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/audio/engine.ts](../src/audio/engine.ts), [src/audio/file-playback-route.ts](../src/audio/file-playback-route.ts)

**기존 검사 진입점:** [src/audio/__tests__/engine.test.ts](../src/audio/__tests__/engine.test.ts), [src/audio/__tests__/file-playback-route.test.ts](../src/audio/__tests__/file-playback-route.test.ts)

### QA021. 기기 스피커 역할과 저역 경로 — P1

**판정:** 공개 Center·Left·Right·Sub 역할의 채널·합산 gain·low-pass가 맞고 전환 중 클릭·순간 출력 급증을 억제한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/audio/channel.ts](../src/audio/channel.ts)

**기존 검사 진입점:** [src/audio/__tests__/channel.test.ts](../src/audio/__tests__/channel.test.ts), [e2e/audio-channel.test.ts](../e2e/audio-channel.test.ts)

### QA022. DSP 효과와 연속 미리보기 — P1

**판정:** 효과 범위·초기화·preset 적용이 일관되고, 연속 reverb 미리보기의 늦은 계산이 최종 적용값을 덮지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/audio/effects.ts](../src/audio/effects.ts), [src/audio/engine.ts](../src/audio/engine.ts)

**기존 검사 진입점:** [src/audio/__tests__/effects-reverb-coalescing.test.ts](../src/audio/__tests__/effects-reverb-coalescing.test.ts), [e2e/audio-effects.test.ts](../e2e/audio-effects.test.ts)

### QA023. 볼륨·음소거·재생 gate의 합성 — P0

**판정:** 볼륨·mute·PRO 일시정지 gate가 독립적으로 작동하고, gate 해제 후 최신 볼륨을 복원하며 의도하지 않은 소리를 내지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/audio/engine.ts](../src/audio/engine.ts), [src/audio/effects.ts](../src/audio/effects.ts)

**기존 검사 진입점:** [src/audio/__tests__/master-volume.test.ts](../src/audio/__tests__/master-volume.test.ts), [src/audio/__tests__/effects.test.ts](../src/audio/__tests__/effects.test.ts)

### QA024. 방 공통 음향 설정과 기기 설정의 분리 — P1

**판정:** 동기화 선택·권한 철회·baseline·적용/거부에서 방 효과·볼륨은 수렴하되, 기기 역할·수동 싱크는 방에 전파하지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/audio/effects.ts](../src/audio/effects.ts)

**기존 검사 진입점:** [src/audio/__tests__/effects.test.ts](../src/audio/__tests__/effects.test.ts), [e2e/demo-settings-recovery.test.ts](../e2e/demo-settings-recovery.test.ts)

### QA025. 사용자 동작과 오디오 시작 허용 — P0

**판정:** 최초 진입·autoplay 차단·suspended/closed context에서 신뢰된 클릭으로 출력을 시작하고, 실패 시 재시도 상태와 복구 안내를 보존한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/audio/context.ts](../src/audio/context.ts), [src/player/transport.ts](../src/player/transport.ts)

**기존 검사 진입점:** [src/audio/__tests__/context-health.test.ts](../src/audio/__tests__/context-health.test.ts), [e2e/demo-output-recovery.test.ts](../e2e/demo-output-recovery.test.ts)

### QA026. OS 중단·백그라운드·오디오 시계 복구 — P0

**판정:** running 상태만으로 출력 정상이라 판단하지 않고 잠금·전화·앱 전환·PWA 복귀 시 현재 출력만 복구하며 낡은 복구 동작을 차단한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/audio/context-recovery.ts](../src/audio/context-recovery.ts), [src/audio/context.ts](../src/audio/context.ts), [src/audio/output-health.ts](../src/audio/output-health.ts)

**기존 검사 진입점:** [src/audio/__tests__/foreground-output-health.test.ts](../src/audio/__tests__/foreground-output-health.test.ts), [e2e/background-resume.test.ts](../e2e/background-resume.test.ts)

### QA027. 볼륨·효과·채널 UI의 권한과 gesture — P0

**판정:** 드래그 중 권한 회수·재부여·원격 설정 변경에서 취소된 조작을 재발행하지 않는다. UI 값과 실제 출력 또는 정식 설정이 일치한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/ui/settings.ts](../src/ui/settings.ts), [src/ui/range-drag.ts](../src/ui/range-drag.ts)

**기존 검사 진입점:** [src/ui/__tests__/effects-drag-authority.test.ts](../src/ui/__tests__/effects-drag-authority.test.ts), [e2e/effects-drag-authority.test.ts](../e2e/effects-drag-authority.test.ts)

### QA028. 페이지 이동·BFCache·화면 유지의 실제 브라우저 수명 — P1

**판정:** 연속 Back·닫기에서 확인창이 중복되지 않고 Stay 선택 시 세션을 유지하며 확정 이탈에서 한 번 정리한다. beforeunload에서 조기 종료하지 않는다. 뒤로/앞으로 이동·BFCache·화면 잠금·wake-lock 거절/자동 해제·늦은 sentinel에서 죽은 연결 UI나 종료된 화면 유지가 부활하지 않는다. wake lock은 최선 노력 계약이며 OS 잠금 방지를 절대 보장하지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/core/page-lifecycle.ts](../src/core/page-lifecycle.ts), [src/core/wake-lock.ts](../src/core/wake-lock.ts), [src/core/session-reset.ts](../src/core/session-reset.ts), [src/core/back-button-guard.ts](../src/core/back-button-guard.ts)

**기존 검사 진입점:** [src/core/__tests__/page-lifecycle.test.ts](../src/core/__tests__/page-lifecycle.test.ts), [src/core/__tests__/wake-lock.test.ts](../src/core/__tests__/wake-lock.test.ts), [src/core/__tests__/session-reset.test.ts](../src/core/__tests__/session-reset.test.ts), [src/core/__tests__/back-button-guard.test.ts](../src/core/__tests__/back-button-guard.test.ts)

## 7. RAM·파일 복구·장시간 성능

### QA029. RAM 저장 슬롯과 메모리 소유권 — P1

**판정:** 청크·Blob·current/preload·PCM을 정확한 occurrence/session에 귀속하고 교체·취소·종료 시 해제하며 미디어를 영구 저장하지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/storage/ramstore.ts](../src/storage/ramstore.ts), [src/storage/storage.ts](../src/storage/storage.ts), [src/player/decode-admission.ts](../src/player/decode-admission.ts)

**기존 검사 진입점:** [src/storage/__tests__/ramstore.test.ts](../src/storage/__tests__/ramstore.test.ts), [src/storage/__tests__/storage-admission.test.ts](../src/storage/__tests__/storage-admission.test.ts)

### QA030. 누락 데이터 복구와 watchdog 소유권 — P0

**판정:** 진척·정체·FILE_WAIT·호스트 손실을 구별하고 retry·timeout을 현재 요청에만 적용하며 외부 미디어 전환 후 이전 파일을 되살리지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/storage/recovery.ts](../src/storage/recovery.ts), [src/storage/transfer-receive.ts](../src/storage/transfer-receive.ts), [src/network/file-request-authority.ts](../src/network/file-request-authority.ts)

**기존 검사 진입점:** [src/storage/__tests__/recovery-owner-transition.test.ts](../src/storage/__tests__/recovery-owner-transition.test.ts), [src/storage/__tests__/file-wait-host-loss.test.ts](../src/storage/__tests__/file-wait-host-loss.test.ts)

### QA031. 장시간·대용량·한도 근처의 성능과 자원 증가 — P1

**판정:** 긴 재생·여러 번 입퇴장·큰 파일 교체·많은 큐/채팅/참가자에서 방 소유 Worker·timer·listener·Blob·PCM·DOM이 계속 누적되지 않고 조작 가능성을 유지한다. 큰 파일의 전체 encoded Blob 비용과 제한된 PCM 비용을 함께 측정하고 기존 용량·fanout 계약 안에서 수용/거부 경계를 확인한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/core/session-scope.ts](../src/core/session-scope.ts), [src/player/large-audio/diagnostics.ts](../src/player/large-audio/diagnostics.ts), [src/share/file-delivery-policy.ts](../src/share/file-delivery-policy.ts), [src/player/queue-model.ts](../src/player/queue-model.ts)

**기존 검사 진입점:** [src/core/__tests__/session-scope.test.ts](../src/core/__tests__/session-scope.test.ts), [src/player/__tests__/queue-model.test.ts](../src/player/__tests__/queue-model.test.ts)

## 8. P2P 파일 전송·프리로드

### QA032. 파일 전송 입력 무결성과 수신 권한 — P0

**판정:** 크기·청크 총수·길이·index·session·queue·host 연결을 검증하고, 정확한 활성 전송의 유효 청크만 rate-limit 예외를 얻는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/storage/transfer-receive.ts](../src/storage/transfer-receive.ts), [src/network/protocol.ts](../src/network/protocol.ts)

**기존 검사 진입점:** [src/storage/__tests__/chunk-rate-limit-exemption.test.ts](../src/storage/__tests__/chunk-rate-limit-exemption.test.ts), [src/network/__tests__/protocol-validation-coverage.test.ts](../src/network/__tests__/protocol-validation-coverage.test.ts)

### QA033. 제어·벌크 순서 역전과 재개 prefix — P0

**판정:** PREPARE·START·RESUME·END가 청크를 추월하거나 뒤처져도 같은 전송의 prefix·sparse suffix만 보존하고 중복·다른 session을 승격하지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/storage/transfer-receive.ts](../src/storage/transfer-receive.ts)

**기존 검사 진입점:** [src/storage/__tests__/transfer-prepare-channel-ordering.test.ts](../src/storage/__tests__/transfer-prepare-channel-ordering.test.ts), [src/storage/__tests__/transfer-resume-channel-ordering.test.ts](../src/storage/__tests__/transfer-resume-channel-ordering.test.ts)

### QA034. 송신 backpressure와 참가자별 독립 진행 — P1

**판정:** 느린 참가자가 다른 참가자의 파일 완료를 막지 않고, capacity 이벤트 유실·채널 교체·timeout·취소 시 전송을 정리한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/storage/chunk-pump.ts](../src/storage/chunk-pump.ts), [src/storage/transfer-backpressure.ts](../src/storage/transfer-backpressure.ts), [src/storage/transfer-send.ts](../src/storage/transfer-send.ts)

**기존 검사 진입점:** [src/storage/__tests__/transfer-backpressure.test.ts](../src/storage/__tests__/transfer-backpressure.test.ts), [e2e/multi-guest.test.ts](../e2e/multi-guest.test.ts)

### QA035. 프리로드 우선권·승격·취소 — P0

**판정:** 추측 전송이 현재 곡을 방해하지 않고 승격된 current 전송을 유지하며, 반복·셔플·큐 변경은 불필요한 추측 lane만 교체한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/storage/preload.ts](../src/storage/preload.ts), [src/storage/preload-watchdog.ts](../src/storage/preload-watchdog.ts)

**기존 검사 진입점:** [src/storage/__tests__/transfer-priority.test.ts](../src/storage/__tests__/transfer-priority.test.ts), [e2e/preload-queue-mode-cancellation.test.ts](../e2e/preload-queue-mode-cancellation.test.ts)

### QA036. 로컬 직접 전송과 원격 전달의 선택 — P1

**판정:** ICE 분류 지연·변경에도 session의 전달 방식을 유지하고 R2 대기·실패·local promotion 시 다른 방식의 늦은 프레임을 차단한다. 파일 session별 audience·capability·descriptor를 고정하고, 동일 object 재결합·foreground promotion·실패 곡 재선택도 최신 큐와 출력 소유권에만 적용한다.

**방법:** 자동 / 브라우저 / 실기 / 로컬서비스

**대표 구현:** [src/share/file-delivery-policy.ts](../src/share/file-delivery-policy.ts), [src/share/remote-share.ts](../src/share/remote-share.ts), [src/storage/transfer-receive.ts](../src/storage/transfer-receive.ts)

**기존 검사 진입점:** [src/share/__tests__/file-delivery-policy.test.ts](../src/share/__tests__/file-delivery-policy.test.ts), [src/storage/__tests__/remote-local-promotion.test.ts](../src/storage/__tests__/remote-local-promotion.test.ts), [src/share/__tests__/remote-share.test.ts](../src/share/__tests__/remote-share.test.ts)

## 9. Standard 방·입장·네트워크

### QA037. Standard 방 생성·초대·PIN·입장 bootstrap — P0

**판정:** 코드 namespace·PIN 저장 경계·입장 prerequisites를 지키고 HELLO/APPLIED 완료 전 권한·재생을 공개하지 않는다. fresh/reconnect 입장의 최종 수렴을 확인한다. 초대 링크·QR 생성/스캔, 잘못된 코드, 카메라 거부·창 닫기 중 늦은 스캔 결과를 확인한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 실기

**대표 구현:** [src/network/standard-room-prerequisites.ts](../src/network/standard-room-prerequisites.ts), [src/network/host.ts](../src/network/host.ts), [src/ui/setup-host-invite.ts](../src/ui/setup-host-invite.ts), [src/ui/setup-qr-scanner.ts](../src/ui/setup-qr-scanner.ts)

**기존 검사 진입점:** [src/core/__tests__/standard-room-pin-storage-boundary.test.ts](../src/core/__tests__/standard-room-pin-storage-boundary.test.ts), [e2e/late-join-bootstrap-catchup.test.ts](../e2e/late-join-bootstrap-catchup.test.ts), [src/ui/__tests__/setup-host-invite.test.ts](../src/ui/__tests__/setup-host-invite.test.ts), [src/ui/__tests__/setup-qr-scanner.test.ts](../src/ui/__tests__/setup-qr-scanner.test.ts)

### QA038. Standard 멤버·관리자·기기 관리 — P0

**판정:** member와 physical device를 구분한다. grant/revoke/kick·동일 계정 여러 기기·삭제 assertion이 올바른 대상을 갱신하고 stale 기기 재등장을 막아야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/network/standard-room-authority.ts](../src/network/standard-room-authority.ts), [src/rooms/member-directory.ts](../src/rooms/member-directory.ts)

**기존 검사 진입점:** [src/network/__tests__/host.test.ts](../src/network/__tests__/host.test.ts), [e2e/device-management.test.ts](../e2e/device-management.test.ts)

### QA039. signaling admission·wire 프로토콜 — P0

**판정:** 허용 Origin·엄격한 schema·host-only frame·PRO single-use ticket·세대·incarnation이 맞을 때만 relay한다. reserved code·malformed frame·credentials URL 누출을 차단한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/signaling-protocol.ts](../cloudflare/signaling-protocol.ts), [cloudflare/signaling-worker.ts](../cloudflare/signaling-worker.ts)

**기존 검사 진입점:** [src/network/transport/__tests__/cloudflare-signaling-worker.test.ts](../src/network/transport/__tests__/cloudflare-signaling-worker.test.ts), [src/core/__tests__/pro-signaling-credential-boundary.test.ts](../src/core/__tests__/pro-signaling-credential-boundary.test.ts)

### QA040. signaling liveness·재접속·HTTP 대체 경로 — P1

**판정:** WebSocket hibernation·host departure·ICE/DTLS 종료·HTTP bridge·대체 도메인·backoff에서 정확한 연결 소유권과 정리를 보장한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [src/network/transport/cloudflare-signaling.ts](../src/network/transport/cloudflare-signaling.ts), [src/network/transport/standard-http-signaling.ts](../src/network/transport/standard-http-signaling.ts)

**기존 검사 진입점:** [src/network/transport/__tests__/standard-http-signaling.test.ts](../src/network/transport/__tests__/standard-http-signaling.test.ts), [e2e/reconnection.test.ts](../e2e/reconnection.test.ts)

### QA041. 참가 bootstrap과 최신 큐 수렴 — P0

**판정:** HELLO·baseline·APPLIED 순서를 지키고 준비 중 바뀐 큐·반복·셔플을 따라잡으며 이전 연결의 완료가 새 연결을 확정하지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/network/join-bootstrap.ts](../src/network/join-bootstrap.ts), [src/network/host.ts](../src/network/host.ts), [src/network/guest.ts](../src/network/guest.ts), [src/network/queue-authority.ts](../src/network/queue-authority.ts)

**기존 검사 진입점:** [src/network/__tests__/join-bootstrap.test.ts](../src/network/__tests__/join-bootstrap.test.ts), [src/network/__tests__/host-bootstrap-catchup.test.ts](../src/network/__tests__/host-bootstrap-catchup.test.ts)

### QA042. 연결 생존 판정과 signaling 복구 — P0

**판정:** ICE·DTLS·datachannel·heartbeat·signaling을 구별해 건강한 media/data 연결은 보존하고 terminal peer는 정확히 정리한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/network/heartbeat-monitor.ts](../src/network/heartbeat-monitor.ts), [src/network/signaling-health.ts](../src/network/signaling-health.ts), [src/network/peer-state.ts](../src/network/peer-state.ts), [src/network/transport/peerjs-adapter.ts](../src/network/transport/peerjs-adapter.ts)

**기존 검사 진입점:** [src/network/__tests__/heartbeat-monitor.test.ts](../src/network/__tests__/heartbeat-monitor.test.ts), [src/network/transport/__tests__/signaling-liveness.test.ts](../src/network/transport/__tests__/signaling-liveness.test.ts)

## 10. 시스템 오디오 공유

### QA043. 캡처 시작과 실패 롤백 — P0

**판정:** 권한 거절·audio track 없음·캡처 중 취소·기기/시간 한도·publisher 예약을 처리하고 준비 실패 시 이전 재생 의도를 보존한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/audio/system-capture.ts](../src/audio/system-capture.ts), [src/audio/system-audio-policy.ts](../src/audio/system-audio-policy.ts)

**기존 검사 진입점:** [src/audio/__tests__/system-capture.test.ts](../src/audio/__tests__/system-capture.test.ts), [e2e/system-audio-controls.test.ts](../e2e/system-audio-controls.test.ts)

### QA044. 직접·SFU 전달 경로의 단일성 — P0

**판정:** Standard·PRO 및 local·remote 청중에서 share generation의 경로를 고정하고 실패 전환·publisher 교체 시 이중 소리·낡은 stream을 남기지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/network/system-audio-delivery.ts](../src/network/system-audio-delivery.ts), [src/network/system-audio-sfu.ts](../src/network/system-audio-sfu.ts), [src/network/pro-system-audio-direct.ts](../src/network/pro-system-audio-direct.ts), [src/network/pro-system-audio-sfu.ts](../src/network/pro-system-audio-sfu.ts)

**기존 검사 진입점:** [src/network/__tests__/system-audio-delivery.test.ts](../src/network/__tests__/system-audio-delivery.test.ts), [src/network/__tests__/pro-system-audio-sfu.test.ts](../src/network/__tests__/pro-system-audio-sfu.test.ts)

### QA045. 수신 허용·종료·이전 재생 복원 — P0

**판정:** 신뢰된 수신 동작·출력 unlock을 연결하고 stop·track ended·오류·방 종료·새 공유 시 이전 route를 정리하며 최신 재생 의도를 복원한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/network/system-audio-guest.ts](../src/network/system-audio-guest.ts), [src/network/system-audio-host.ts](../src/network/system-audio-host.ts), [src/audio/system-capture.ts](../src/audio/system-capture.ts)

**기존 검사 진입점:** [src/network/__tests__/system-audio-guest.test.ts](../src/network/__tests__/system-audio-guest.test.ts), [src/audio/__tests__/system-capture-stop.test.ts](../src/audio/__tests__/system-capture-stop.test.ts)

### QA046. PRO 시스템 오디오 publication·복원 — P1

**판정:** owner lease·generation·direct/SFU 경로가 하나의 활성 출력만 소유해야 한다. 신규 입장·publication 복구·끝난 공유 뒤 YouTube 복원은 현재 소유권에서만 수행한다. 실제 출력 장치 관측은 자동 검사와 구분한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [src/pro-room/system-audio-service.ts](../src/pro-room/system-audio-service.ts), [src/pro-room/system-audio-controller.ts](../src/pro-room/system-audio-controller.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/system-audio-service.test.ts](../src/pro-room/__tests__/system-audio-service.test.ts), [src/pro-room/__tests__/playback-snapshot-share-ownership.test.ts](../src/pro-room/__tests__/playback-snapshot-share-ownership.test.ts)

## 11. YouTube

### QA047. YouTube 입력·검색·추가 — P1

**판정:** 검색어·URL·shorts·live·playlist를 올바르게 판별하고 잘못된 ID를 거절한다. IME 조합, Enter 반복, 더블클릭에서도 선택한 항목을 한 번만 추가한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/youtube/search.ts](../src/youtube/search.ts), [src/ui/player-controls.ts](../src/ui/player-controls.ts)

**기존 검사 진입점:** [src/youtube/__tests__/search.test.ts](../src/youtube/__tests__/search.test.ts), [e2e/youtube-search-interactions.test.ts](../e2e/youtube-search-interactions.test.ts)

### QA048. 검색·미리보기·제목 요청 수명 — P1

**판정:** 응답 headers/body 지연, 취소, 검색어 변경, 창 닫기 후 이전 결과가 새 UI를 덮지 않는다. 실패·빈 결과·스켈레톤 상태가 명확하다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/youtube/search.ts](../src/youtube/search.ts), [src/youtube/oembed.ts](../src/youtube/oembed.ts)

**기존 검사 진입점:** [src/youtube/__tests__/search.test.ts](../src/youtube/__tests__/search.test.ts), [src/youtube/__tests__/oembed-demo-ownership.test.ts](../src/youtube/__tests__/oembed-demo-ownership.test.ts)

### QA049. iframe 준비·사용자 활성화·autoplay — P1

**판정:** 새 iframe과 재사용 iframe, iOS 첫 Start·QR 버튼 활성화, 비동기 준비 실패에서 입장과 재생 흐름이 진행된다. 탭 재생 안내와 실제 재생 증거가 일치한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/youtube/iframe.ts](../src/youtube/iframe.ts), [src/ui/setup-guest.ts](../src/ui/setup-guest.ts)

**기존 검사 진입점:** [src/ui/__tests__/setup-guest-recovery.test.ts](../src/ui/__tests__/setup-guest-recovery.test.ts), [e2e/setup-youtube-activation.test.ts](../e2e/setup-youtube-activation.test.ts)

### QA050. YouTube 플레이리스트 manifest·곡 발생 identity — P0

**판정:** 같은 외부 playlist의 다른 큐 항목, 캐시 eviction, 지연 indexing·제목 응답에서도 현재 큐 항목의 영상 순서와 제목만 사용한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/youtube/queue-manifest.ts](../src/youtube/queue-manifest.ts), [src/youtube/player.ts](../src/youtube/player.ts)

**기존 검사 진입점:** [src/youtube/__tests__/pro-occurrence-manifest.test.ts](../src/youtube/__tests__/pro-occurrence-manifest.test.ts), [src/youtube/__tests__/queue-native-playlist-ownership.test.ts](../src/youtube/__tests__/queue-native-playlist-ownership.test.ts)

### QA051. cue·로딩 중 최신 재생 명령 — P0

**판정:** Next 이후 즉시 Pause·Seek·상대 이동, 지연 CUED, 취소 후 동일 영상 재선택에서 마지막 유효 의도만 적용되고 이전 명령이 부활하지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/youtube/player.ts](../src/youtube/player.ts), [src/youtube/iframe.ts](../src/youtube/iframe.ts)

**기존 검사 진입점:** [src/youtube/__tests__/pending-cue-seek-intent.test.ts](../src/youtube/__tests__/pending-cue-seek-intent.test.ts), [e2e/youtube-pending-seek.test.ts](../e2e/youtube-pending-seek.test.ts)

### QA052. iframe 자체 제어·광고·오류·종료 — P0

**판정:** native PLAY·PAUSE·SEEK가 역할 권한과 일치한다. 광고, BUFFERING, 오류, ENDED를 잘못된 앱 명령이나 곡 전환으로 해석하지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/youtube/native-control-policy.ts](../src/youtube/native-control-policy.ts), [src/youtube/iframe.ts](../src/youtube/iframe.ts)

**기존 검사 진입점:** [src/youtube/__tests__/native-control-play-resume.test.ts](../src/youtube/__tests__/native-control-play-resume.test.ts), [e2e/youtube-end-transition.test.ts](../e2e/youtube-end-transition.test.ts)

### QA053. YouTube 시작 barrier·무음 준비·fallback — P0

**판정:** PREPARE·ARMED·COMMIT 순서, cohort 일부 실패, ACK 누락, iframe 교체, 새 명령에서 제한된 시간 안에 종료·복구한다. warm-up 음성 누출과 이전 예약 부활이 없다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/youtube/zero-start.ts](../src/youtube/zero-start.ts), [src/youtube/zero-start-ownership.ts](../src/youtube/zero-start-ownership.ts)

**기존 검사 진입점:** [src/youtube/__tests__/zero-start.test.ts](../src/youtube/__tests__/zero-start.test.ts), [src/youtube/__tests__/zero-start-fallback-ownership.test.ts](../src/youtube/__tests__/zero-start-fallback-ownership.test.ts)

### QA054. YouTube 수동 싱크·signed offset — P0

**판정:** 음수·양수·최대 보정값·Reset·반복 직후·host snapshot 공백·PRO 기기 자체 Pause에서 요청한 보정을 유지한다. 공유 전환 후 현재 재생 의도를 복원한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/youtube/sync.ts](../src/youtube/sync.ts), [src/youtube/local-offset.ts](../src/youtube/local-offset.ts)

**기존 검사 진입점:** [src/youtube/__tests__/manual-offset-apply.test.ts](../src/youtube/__tests__/manual-offset-apply.test.ts), [e2e/youtube-manual-zero-start.test.ts](../e2e/youtube-manual-zero-start.test.ts)

### QA055. YouTube 실제 첫 음·지속 싱크·출력 지연 — P1

**판정:** iOS·Android·데스크탑과 Bluetooth·유선에서 첫 음, Pause·Resume·Seek·반복·광고 후 실제 음향 차이와 수렴 시간을 관측한다. 플레이어 시간과 스피커 출력 시간을 구분하며 모사 타임라인 검사를 실기 확인으로 확대하지 않는다.

**방법:** 브라우저 / 실기

**대표 구현:** [src/youtube/play-latency.ts](../src/youtube/play-latency.ts), [src/youtube/pro-lead-learner.ts](../src/youtube/pro-lead-learner.ts)

**기존 검사 진입점:** [src/youtube/__tests__/play-latency.test.ts](../src/youtube/__tests__/play-latency.test.ts), [e2e/youtube-sync.test.ts](../e2e/youtube-sync.test.ts)

## 12. 데모

### QA056. 데모 입장·트랙 loading·재시도 — P1

**판정:** Standard에서 host·guest 권한, CDN·decoder 실패, 빠른 exit·re-entry, 새 트랙 요청에 현재 generation만 완료한다. PRO에서는 데모 진입을 거부하고 기존 재생·전송을 건드리지 않으며 active/loading·XHR·미디어 정지·broadcast의 부작용이 없다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/demo/mode.ts](../src/demo/mode.ts), [src/demo/loader.ts](../src/demo/loader.ts)

**기존 검사 진입점:** [src/demo/__tests__/mode-recovery.test.ts](../src/demo/__tests__/mode-recovery.test.ts), [e2e/demo-reliability.test.ts](../e2e/demo-reliability.test.ts)

### QA057. 데모 종료·이전 소스·효과 복원 — P0

**판정:** curtain 동안 곡·방·권한·설정 변경에서 최신 소유권을 보존한다. 파일 Blob·transfer meta·decoder resource 쌍을 유지하고 사용이 끝난 resource를 해제한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/demo/mode.ts](../src/demo/mode.ts)

**기존 검사 진입점:** [src/demo/__tests__/mode-recovery.test.ts](../src/demo/__tests__/mode-recovery.test.ts), [e2e/demo-settings-recovery.test.ts](../e2e/demo-settings-recovery.test.ts)

### QA058. 데모 단계·효과·공통 재생 — P1

**판정:** 단계 이동, 효과 ON·OFF, 역할 선택, host Pause·Resume, 빠른 guest·늦은 입장에서 동일 트랙과 정식 시작 위치를 사용한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/demo/mode.ts](../src/demo/mode.ts), [src/demo/playback-timing.ts](../src/demo/playback-timing.ts)

**기존 검사 진입점:** [src/demo/__tests__/mode-sync.test.ts](../src/demo/__tests__/mode-sync.test.ts), [e2e/demo-common-start.test.ts](../e2e/demo-common-start.test.ts)

## 13. PRO 방·서버 권위

### QA059. PRO 활성화·복구 claim — P0

**판정:** claim 종류별 방·세대·계정·유효기간 조건을 지킨다. 계정 지정 activation은 지정 계정만 허용하고, 비지정 activation은 인증·entitlement 계약을 확인한다. recovery는 현재 owner 계정·authority epoch·검증된 세션을 대조한다. legacy/admin/offline 발급을 구분하고 변조·부적절한 재사용·만료가 소유권을 바꾸지 않도록 한다. URL fragment의 노출·정리·새로고침·재진입 결과도 해당 claim 계약과 맞춘다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [cloudflare/pro-room-claims.ts](../cloudflare/pro-room-claims.ts), [src/pro-room/claim-fragment.ts](../src/pro-room/claim-fragment.ts), [cloudflare/pro-room-worker.ts](../cloudflare/pro-room-worker.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/claim-bootstrap.test.ts](../src/pro-room/__tests__/claim-bootstrap.test.ts), [src/pro-room/__tests__/claim-reload-recovery.test.ts](../src/pro-room/__tests__/claim-reload-recovery.test.ts)

### QA060. PRO 세션·PIN·탭 인계 — P0

**판정:** PIN 회전·동시 접속·탭 인계·leave/rejoin 뒤 오래된 응답이 새 세션을 해제하거나 credential을 덮어쓰지 않아야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/pro-room/session-controller.ts](../src/pro-room/session-controller.ts), [src/pro-room/pin-rotation.ts](../src/pro-room/pin-rotation.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/session-controller.test.ts](../src/pro-room/__tests__/session-controller.test.ts), [src/pro-room/__tests__/tab-handoff.test.ts](../src/pro-room/__tests__/tab-handoff.test.ts)

### QA061. PRO presence·장기 접속·복구 — P1

**판정:** participant incarnation·heartbeat·sleep/wake·TTL·재접속이 일관되어야 하며 만료되거나 교체된 기기가 재등장하지 않아야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/pro-room/runtime.ts](../src/pro-room/runtime.ts), [src/pro-room/transport-recovery.ts](../src/pro-room/transport-recovery.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/pro-room-worker.test.ts](../src/pro-room/__tests__/pro-room-worker.test.ts), [src/pro-room/__tests__/session-controller.test.ts](../src/pro-room/__tests__/session-controller.test.ts)

### QA062. PRO 위임 권한·계정 lease — P0

**판정:** 회수/regrant가 이전 큐·효과·재생 쓰기를 되살리지 않아야 한다. 계정 교체·lease 만료·동일 계정 여러 기기의 권한 경계도 확인한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/pro-room/runtime.ts](../src/pro-room/runtime.ts), [src/pro-room/account-lease-policy.ts](../src/pro-room/account-lease-policy.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/runtime-account-lease.test.ts](../src/pro-room/__tests__/runtime-account-lease.test.ts), [src/pro-room/__tests__/runtime-media-mutation-authority.test.ts](../src/pro-room/__tests__/runtime-media-mutation-authority.test.ts)

### QA063. PRO 큐·snapshot 수렴 — P1

**판정:** revision/CAS가 단조로워야 하고 추가·삭제·재정렬·첫 곡 선택 중 늦은 HTTP/heartbeat가 최신 큐를 되돌리지 않아야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/pro-room/playlist-state-manager.ts](../src/pro-room/playlist-state-manager.ts), [src/pro-room/revision.ts](../src/pro-room/revision.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/playlist-state-manager.test.ts](../src/pro-room/__tests__/playlist-state-manager.test.ts), [src/pro-room/__tests__/playback-queue-projection.test.ts](../src/pro-room/__tests__/playback-queue-projection.test.ts)

### QA064. PRO 서버 재생 명령·전환 — P0

**판정:** PREPARE→READY→COMMIT/CANCEL의 정확한 transition만 출력에 적용한다. 중복·역순·응답 유실·새 명령·재접속 중 이전 명령을 차단한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/pro-room/playback-controller.ts](../src/pro-room/playback-controller.ts), [src/pro-room/playback-authority-hooks.ts](../src/pro-room/playback-authority-hooks.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/runtime-server-playback.test.ts](../src/pro-room/__tests__/runtime-server-playback.test.ts), [src/pro-room/__tests__/runtime-playback-reconnect-response.test.ts](../src/pro-room/__tests__/runtime-playback-reconnect-response.test.ts)

### QA065. PRO 미디어 관측·취소 복구 — P1

**판정:** ended/unavailable/sub-video 관측은 현재 적용 revision·미디어만 대상으로 해야 한다. decode 대기·기기 오류·취소된 다음 곡 뒤 정확한 현재 checkpoint를 복구한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/pro-room/playback-authority-hooks.ts](../src/pro-room/playback-authority-hooks.ts), [src/pro-room/playback-controller.ts](../src/pro-room/playback-controller.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/runtime-playback-observation-hydration.test.ts](../src/pro-room/__tests__/runtime-playback-observation-hydration.test.ts), [src/pro-room/__tests__/playback-native-preparation-cancel.test.ts](../src/pro-room/__tests__/playback-native-preparation-cancel.test.ts)

### QA066. PRO 저장 미디어·캐시·업로드 큐 — P1

**판정:** canonical asset identity·quota·메모리 소유권을 보존한다. 취소·재시도·캐시 promotion·큐 제거·orphan GC에서 파일 혼선·중복 저장을 방지한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [src/pro-room/media-transfer.ts](../src/pro-room/media-transfer.ts), [src/pro-room/upload-queue.ts](../src/pro-room/upload-queue.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/media-transfer.test.ts](../src/pro-room/__tests__/media-transfer.test.ts), [src/pro-room/__tests__/upload-queue.test.ts](../src/pro-room/__tests__/upload-queue.test.ts)

### QA067. PRO 효과·반복·셔플 동기화 — P1

**판정:** 필드별 최신 사용자 의도만 저장한다. GET/PUT 실패·CAS 충돌·권한 회수·opt-out이 이전 변경을 재발행하지 않고 canonical 상태로 수렴해야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/pro-room/runtime.ts](../src/pro-room/runtime.ts), [src/pro-room/effects-reconciliation.ts](../src/pro-room/effects-reconciliation.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/runtime-settings-intent-authority.test.ts](../src/pro-room/__tests__/runtime-settings-intent-authority.test.ts), [src/pro-room/__tests__/runtime-queue-mode-conflict-recovery.test.ts](../src/pro-room/__tests__/runtime-queue-mode-conflict-recovery.test.ts)

## 14. 계정·로그인·탈퇴

### QA068. Google OAuth·PKCE·로그인 반환 — P0

**판정:** issuer/state/nonce/PKCE 검증·단일 소비·안전한 returnTo를 보장한다. callback 변조·중복 flow·Google/D1 장애·응답 body 정체를 bounded하게 처리한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/account-auth.ts](../cloudflare/account-auth.ts), [src/account/login-return.ts](../src/account/login-return.ts)

**기존 검사 진입점:** [src/core/__tests__/account-auth.test.ts](../src/core/__tests__/account-auth.test.ts), [src/account/__tests__/login-return.test.ts](../src/account/__tests__/login-return.test.ts)

### QA069. 계정 세션·쿠키·로그아웃 순서 — P0

**판정:** 최신 발급 세션이 우선이며 늦은 logout/delete 응답이 새 로그인을 제거하지 못해야 한다. legacy cookie·만료·동시 로그인·세션 상한·조회 실패 경계를 확인한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [cloudflare/account-auth.ts](../cloudflare/account-auth.ts), [src/account/session.ts](../src/account/session.ts)

**기존 검사 진입점:** [src/core/__tests__/account-cookie-ordering.test.ts](../src/core/__tests__/account-cookie-ordering.test.ts), [src/account/__tests__/session.test.ts](../src/account/__tests__/session.test.ts)

### QA070. 프로필·닉네임·방 표시 정체성 — P1

**판정:** 서버 정규화·금칙어·호환 키 유일성·충돌 처리가 일치해야 하며 브라우저 spoof가 verified room identity로 전달되지 않아야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [cloudflare/account-nickname.ts](../cloudflare/account-nickname.ts), [src/account/room-identity.ts](../src/account/room-identity.ts)

**기존 검사 진입점:** [src/core/__tests__/account-nickname-policy.test.ts](../src/core/__tests__/account-nickname-policy.test.ts), [src/account/__tests__/room-identity.test.ts](../src/account/__tests__/room-identity.test.ts)

### QA071. 계정 활동 통계·세션 scope — P2

**판정:** aggregate-only delta·중복 방지·overflow·계정 전환 scope·flush 수명이 정확해야 한다. 이전 계정 통계가 새 계정에 쓰이지 않아야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [src/account/activity-stats.ts](../src/account/activity-stats.ts), [cloudflare/account-auth.ts](../cloudflare/account-auth.ts)

**기존 검사 진입점:** [src/account/__tests__/activity-stats.test.ts](../src/account/__tests__/activity-stats.test.ts), [src/core/__tests__/account-auth.test.ts](../src/core/__tests__/account-auth.test.ts)

### QA072. 계정 탈퇴·권한 정리 saga — P0

**판정:** 삭제 fence 후 새 권한·쓰기를 금지한다. PRO 세대별 reverse edge·기존 기기·번역 데이터 정리가 중간 장애·cron 재개에서도 durable·idempotent해야 한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/account-auth.ts](../cloudflare/account-auth.ts), [cloudflare/auth.pro-room-generation.migration.sql](../cloudflare/auth.pro-room-generation.migration.sql)

**기존 검사 진입점:** [src/core/__tests__/account-auth.test.ts](../src/core/__tests__/account-auth.test.ts), [src/core/__tests__/account-auth-sqlite.test.ts](../src/core/__tests__/account-auth-sqlite.test.ts)

## 15. Developer API

### QA073. API key 발급·인증·scope·폐기 — P0

**판정:** key secret은 digest-only로 저장되고 room/generation/authority epoch에 귀속된다. 만료·회수 즉시 차단·scope 분리·모든 잘못된 key의 동일 오류 계약을 확인한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/developer-api-worker.ts](../cloudflare/developer-api-worker.ts), [scripts/developer-api-key.mts](../scripts/developer-api-key.mts)

**기존 검사 진입점:** [src/developer-api/__tests__/developer-api-worker.test.ts](../src/developer-api/__tests__/developer-api-worker.test.ts), [src/developer-api/__tests__/developer-api-key-cli.test.ts](../src/developer-api/__tests__/developer-api-key-cli.test.ts)

### QA074. API 조회·공개 DTO·캐시 계약 — P0

**판정:** caller-relative provenance·ETag/304·effects v2·queue mode를 정확히 공개한다. asset ID/object key/secret/private shuffle order 누출을 금지한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/developer-api-facade-worker.ts](../cloudflare/developer-api-facade-worker.ts), [public/developers/openapi.yaml](../public/developers/openapi.yaml)

**기존 검사 진입점:** [src/developer-api/__tests__/developer-api-facade-worker.test.ts](../src/developer-api/__tests__/developer-api-facade-worker.test.ts), [src/core/__tests__/developer-api-docs.test.ts](../src/core/__tests__/developer-api-docs.test.ts)

### QA075. API 쓰기·명령 결과·idempotency — P0

**판정:** queue/playback/effects CAS와 명령 소유권을 지킨다. 응답 유실 재요청·동일 key 다른 body·회수 중 in-flight·상태 polling·rate-limit 경계를 확인한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/developer-api-worker.ts](../cloudflare/developer-api-worker.ts), [cloudflare/developer-api.authority-fence.migration.sql](../cloudflare/developer-api.authority-fence.migration.sql)

**기존 검사 진입점:** [src/core/__tests__/developer-api-authority-fence-sqlite.test.ts](../src/core/__tests__/developer-api-authority-fence-sqlite.test.ts), [src/developer-api/__tests__/developer-api-worker.test.ts](../src/developer-api/__tests__/developer-api-worker.test.ts)

### QA076. API 직접 업로드·큐 소유 provenance — P1

**판정:** 예약/완료의 media identity·서명 URL/header·generation·quota가 일치해야 한다. 키별 own-clear가 다른 키·참가자 항목을 보호하고 orphan을 회수해야 한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/developer-api-facade-worker.ts](../cloudflare/developer-api-facade-worker.ts), [cloudflare/pro-room-worker.ts](../cloudflare/pro-room-worker.ts)

**기존 검사 진입점:** [src/developer-api/__tests__/developer-api-facade-worker.test.ts](../src/developer-api/__tests__/developer-api-facade-worker.test.ts), [src/pro-room/__tests__/pro-room-worker.test.ts](../src/pro-room/__tests__/pro-room-worker.test.ts)

## 16. 채팅·명령·BOT

### QA077. 채팅 전송·정책·초안 보존 — P1

**판정:** mute·freeze·slowmode·복구 중 전송 거부, 동일 메시지 재시도, double-fire에서 허위 성공·초안 손실·과한 dedup이 없다. 표시와 payload identity가 일치한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/ui/chat.ts](../src/ui/chat.ts)

**기존 검사 진입점:** [src/ui/__tests__/chat-mute.integration.test.ts](../src/ui/__tests__/chat-mute.integration.test.ts), [e2e/critical-browser.test.ts](../e2e/critical-browser.test.ts)

### QA078. 채팅 명령·자동완성·귓속말·BOT — P0

**판정:** 명령 인수, IME, combobox navigation, 권한, local·transport 실행을 구분한다. BOT·귓속말·notice의 중복 실행과 허용되지 않은 전송이 없다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/chat/commands.ts](../src/chat/commands.ts), [src/ui/chat.ts](../src/ui/chat.ts)

**기존 검사 진입점:** [src/ui/__tests__/chat.test.ts](../src/ui/__tests__/chat.test.ts), [e2e/chat-commands.test.ts](../e2e/chat-commands.test.ts)

### QA079. 채팅 안전한 렌더링·그룹·공지 — P0

**판정:** 이름·본문·BOT·notice·귓속말의 HTML·URL·속성이 실행되지 않는다. 동일 nickname과 실제 member identity를 구분하고 행 상한·줄바꿈·공지 중복 방지를 유지한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/ui/chat-render.ts](../src/ui/chat-render.ts), [src/ui/chat.ts](../src/ui/chat.ts)

**기존 검사 진입점:** [src/ui/__tests__/chat.test.ts](../src/ui/__tests__/chat.test.ts), [src/ui/__tests__/bot-chat-render.test.ts](../src/ui/__tests__/bot-chat-render.test.ts)

### QA080. 채팅 YouTube 링크·timestamp 동작 — P1

**판정:** 안전한 링크만 카드화하고 늦은 제목 응답을 현재 카드에 적용한다. click·Enter·Space 탐색이 동일 권한과 올바른 시간에 작동하며 무효 시간과 일반 숫자는 inert 상태를 유지한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/ui/chat-render.ts](../src/ui/chat-render.ts)

**기존 검사 진입점:** [src/ui/__tests__/chat.test.ts](../src/ui/__tests__/chat.test.ts), [e2e/chat-youtube-bubbles.test.ts](../e2e/chat-youtube-bubbles.test.ts)

### QA081. 채팅 drawer·unread·읽기 위치·복사 — P1

**판정:** 모바일 detent·키보드·회전과 이전 메시지 읽기에서 읽기 위치를 유지한다. unread·jump 상태가 일치하고 실제 선택 텍스트, tap·clipboard 실패, 재초기화 동작을 보존한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/ui/chat-drawer-detents.ts](../src/ui/chat-drawer-detents.ts), [src/ui/chat-copy.ts](../src/ui/chat-copy.ts)

**기존 검사 진입점:** [src/ui/__tests__/chat.test.ts](../src/ui/__tests__/chat.test.ts), [e2e/chat-copy-tap.test.ts](../e2e/chat-copy-tap.test.ts)

### QA082. BOT 요청·비용·방 변경·결과 — P1

**판정:** authenticated room/session lease·request ID·권한·현재 요청 제한(인증 토큰별 분당 3회, 방별 기준 시점부터 1시간당 100회)을 지킨다. 모델 응답이 늦어도 다른 방·계정에 명령·채팅 결과를 적용하지 않아야 한다. 예전 일일 제한은 폐기된 계약이며 현재 검사 기준으로 사용하지 않는다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/pro-bot.ts](../cloudflare/pro-bot.ts), [src/pro-room/runtime.ts](../src/pro-room/runtime.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/pro-room-worker.test.ts](../src/pro-room/__tests__/pro-room-worker.test.ts), [src/pro-room/__tests__/runtime-bot-session-lease.test.ts](../src/pro-room/__tests__/runtime-bot-session-lease.test.ts)

## 17. Remote Share·R2

### QA083. R2 업로드·capability·암호화 경계 — P0

**판정:** 현재 host assertion·raw body·actor·room에만 session을 할당한다. whole-object size·서명·키 회전·암호화 metadata·finalize identity를 검증한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [src/share/remote-upload.ts](../src/share/remote-upload.ts), [cloudflare/remote-share-upload-assertion.ts](../cloudflare/remote-share-upload-assertion.ts)

**기존 검사 진입점:** [src/share/__tests__/remote-upload.test.ts](../src/share/__tests__/remote-upload.test.ts), [src/share/__tests__/remote-share-upload-assertion.test.ts](../src/share/__tests__/remote-share-upload-assertion.test.ts)

### QA084. R2 다운로드·진행·만료·메모리 — P1

**판정:** status/content-length/암호문 검증·progress watchdog·한 번의 transient retry·abort 수명·메모리 admission이 일치해야 한다. 정체·유실·초과 size·오래된 GET을 확인한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [src/share/remote-download.ts](../src/share/remote-download.ts), [src/share/r2-client.ts](../src/share/r2-client.ts)

**기존 검사 진입점:** [src/share/__tests__/remote-download.test.ts](../src/share/__tests__/remote-download.test.ts), [src/share/__tests__/remote-download-lifetime.test.ts](../src/share/__tests__/remote-download-lifetime.test.ts)

### QA085. R2 quota·durable replay·정리 — P0

**판정:** 동일 업로드 재요청을 중복 소비하지 않는다. actor/방/IP budget·receipt·expiry·삭제·lifecycle rule을 일관 적용하고 PRO namespace 접근을 금지한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/remote-share-worker.ts](../cloudflare/remote-share-worker.ts), [cloudflare/r2-lifecycle.remote-share.json](../cloudflare/r2-lifecycle.remote-share.json)

**기존 검사 진입점:** [src/share/__tests__/remote-share-worker.test.ts](../src/share/__tests__/remote-share-worker.test.ts), [src/core/__tests__/release-r2-policy-state.test.ts](../src/core/__tests__/release-r2-policy-state.test.ts)

## 18. 관리자·서비스 정책·PRO 배정

### QA086. 관리자 인증·credential·UI 요청 수명 — P0

**판정:** admin cookie·CSRF·login rate·로그아웃·secret 표시 수명·늦은 조회 순서를 보장한다. 이전 선택·로그인의 응답이 새 UI나 credential을 덮어쓰지 않아야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/app-worker.ts](../cloudflare/app-worker.ts), [browser/classic-runtime/admin.ts](../browser/classic-runtime/admin.ts)

**기존 검사 진입점:** [src/core/__tests__/admin-credential-lifecycle.test.ts](../src/core/__tests__/admin-credential-lifecycle.test.ts), [src/core/__tests__/admin-read-ordering.test.ts](../src/core/__tests__/admin-read-ordering.test.ts)

### QA087. 서비스 maintenance·방 suspension — P0

**판정:** strongly ordered maintenance CAS·bounded cache·각 Worker의 public admission·기존 작업 처리·admin 유지·회복 계약을 확인한다. App/signaling/PRO/R2/API의 차단 경계를 맞추되, 이미 발급한 R2 presigned PUT과 시작된 PUT의 별도 drain 계약을 즉시 취소와 혼동하지 않는다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/service-maintenance.ts](../cloudflare/service-maintenance.ts), [cloudflare/service-control-object.ts](../cloudflare/service-control-object.ts), [cloudflare/remote-share-ops.md](../cloudflare/remote-share-ops.md)

**기존 검사 진입점:** [src/core/__tests__/app-maintenance-admin.test.ts](../src/core/__tests__/app-maintenance-admin.test.ts), [src/pro-room/__tests__/service-control.test.ts](../src/pro-room/__tests__/service-control.test.ts)

### QA088. 운영 공지·history·revision — P2

**판정:** 공지 publish/취소/expiry·history·idempotency·CAS가 원자적이어야 한다. maintenance/rate 객체와 저장·실패 범위를 격리하고 UI가 최신 공지만 표시해야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/service-control-object.ts](../cloudflare/service-control-object.ts), [browser/classic-runtime/admin.ts](../browser/classic-runtime/admin.ts)

**기존 검사 진입점:** [src/pro-room/__tests__/service-control.test.ts](../src/pro-room/__tests__/service-control.test.ts), [src/core/__tests__/admin-dashboard-ui.test.ts](../src/core/__tests__/admin-dashboard-ui.test.ts)

### QA089. PRO grant campaign·voucher·할당 — P0

**판정:** draft/active/paused/ended·재고·digest-only voucher·계정당 entitlement·동시 redemption·배치 rollback·orphan/transfer lineage를 일관 적용한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/pro-room-grants.ts](../cloudflare/pro-room-grants.ts), [scripts/pro-grant-campaign.mts](../scripts/pro-grant-campaign.mts)

**기존 검사 진입점:** [src/pro-room/__tests__/pro-room-grants.test.ts](../src/pro-room/__tests__/pro-room-grants.test.ts), [src/pro-room/__tests__/pro-grant-schema-sqlite.test.ts](../src/pro-room/__tests__/pro-grant-schema-sqlite.test.ts)

## 19. 방 세대·소유권 이전

### QA090. 방 registry·generation·폐기·코드 재사용 — P0

**판정:** 공개 room code가 재사용돼도 DO/media/API key/account edge가 이전 세대와 섞이지 않아야 한다. retirement/cutover/cleanup 중단·재개와 history 보존을 확인한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/pro-room-generation.ts](../cloudflare/pro-room-generation.ts), [scripts/pro-room-generation-cutover.mts](../scripts/pro-room-generation-cutover.mts)

**기존 검사 진입점:** [src/core/__tests__/pro-room-generation-registry-sqlite.test.ts](../src/core/__tests__/pro-room-generation-registry-sqlite.test.ts), [src/pro-room/__tests__/pro-room-worker.test.ts](../src/pro-room/__tests__/pro-room-worker.test.ts)

### QA091. 방 소유권 이전·복구 saga — P0

**판정:** transfer intent/preflight/revoke/commit/abort가 같은 lineage를 지킨다. 전 단계 crash·중복 승인·계정 삭제·원래 owner 권한/API key 정리 경계를 확인한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/app-worker.ts](../cloudflare/app-worker.ts), [cloudflare/admin-metrics.owner-transfer-saga.migration.sql](../cloudflare/admin-metrics.owner-transfer-saga.migration.sql)

**기존 검사 진입점:** [src/pro-room/__tests__/pro-room-grants.test.ts](../src/pro-room/__tests__/pro-room-grants.test.ts), [src/core/__tests__/pro-room-generation-registry-sqlite.test.ts](../src/core/__tests__/pro-room-generation-registry-sqlite.test.ts)

## 20. DB·마이그레이션·운영 집계

### QA092. D1·DO migration·schema 계약 — P0

**판정:** baseline/이전 DB 업그레이드·manifest·제약·FK·index·idempotent 재실행·배포 전 readback이 일치해야 한다. 부분 적용·타입 불일치·누락 binding은 fail-closed여야 한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/d1-migrations.manifest.json](../cloudflare/d1-migrations.manifest.json), [cloudflare/durable-object-migrations.manifest.json](../cloudflare/durable-object-migrations.manifest.json)

**기존 검사 진입점:** [src/core/__tests__/d1-migration-contract.test.ts](../src/core/__tests__/d1-migration-contract.test.ts), [src/core/__tests__/durable-object-migration-contract.test.ts](../src/core/__tests__/durable-object-migration-contract.test.ts)

### QA093. 운영 통계·lifetime 집계·개인정보 — P2

**판정:** 이벤트 중복 소비·cleanup/backfill 뒤 lifetime 단조성·daily/hourly 경계·정수 overflow·집계 조회 수명을 확인한다. raw IP·개인 식별값을 공개하지 않아야 한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/app-worker.ts](../cloudflare/app-worker.ts), [cloudflare/admin-metrics.lifetime-analytics.migration.sql](../cloudflare/admin-metrics.lifetime-analytics.migration.sql)

**기존 검사 진입점:** [src/core/__tests__/lifetime-room-metrics-sqlite.test.ts](../src/core/__tests__/lifetime-room-metrics-sqlite.test.ts), [src/core/__tests__/about-lifetime-room-count-worker.test.ts](../src/core/__tests__/about-lifetime-room-count-worker.test.ts)

## 21. 공개 요청 보안·남용 방어

### QA094. 공개 Worker ingress·abuse·보안 헤더 — P0

**판정:** canonical URL/path·Origin/CORS·CSP·bounded JSON/UTF-8·PoW/capability·IP pseudonym rate·private route·exception detail 비공개를 일관 적용한다.

**방법:** 자동 / 로컬서비스 / 운영확인

**대표 구현:** [cloudflare/app-worker.ts](../cloudflare/app-worker.ts), [scripts/assert-production-security-config.mts](../scripts/assert-production-security-config.mts)

**기존 검사 진입점:** [src/core/__tests__/app-worker-cors.test.ts](../src/core/__tests__/app-worker-cors.test.ts), [src/core/__tests__/capability-pow.test.ts](../src/core/__tests__/capability-pow.test.ts)

## 22. 의존성·도구체인

### QA095. 의존성·도구체인·설치 재현성 — P1

**판정:** 고정한 Node/npm·lockfile·override API 호환성·의존성 트리·audit·서명 검증을 재현한다. 실제 설치된 라이브러리의 호출과 loopback 동작을 확인하며 개발 의존성·운영 의존성·도구 실행 환경 결과를 구분한다.

**방법:** 자동 / 로컬서비스

**대표 구현:** [package.json](../package.json), [package-lock.json](../package-lock.json)

**기존 검사 진입점:** [src/core/__tests__/tooling-contracts.test.ts](../src/core/__tests__/tooling-contracts.test.ts)

## 23. UI·모바일·접근성

### QA096. 미디어 선택·재생 제어 표시 — P1

**판정:** 파일·YouTube·공유·데모·idle·loading 전환에서 Play·Sync·소스 버튼의 활성화, busy, 문구가 실제 가능한 동작과 일치한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/ui/player-controls.ts](../src/ui/player-controls.ts), [src/ui/file-start-loading.ts](../src/ui/file-start-loading.ts)

**기존 검사 진입점:** [src/ui/__tests__/player-controls.test.ts](../src/ui/__tests__/player-controls.test.ts), [src/ui/__tests__/control-surfaces.test.ts](../src/ui/__tests__/control-surfaces.test.ts)

### QA097. seek 타임라인·정지 위치·임시 projection — P1

**판정:** 늦은 buffer·duration, paused checkpoint, PRO pending seek, 곡·소스 변경, 늦은 change 이벤트에서도 rail과 실제 위치가 일치하고 취소된 gesture가 부활하지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/ui/seekbar.ts](../src/ui/seekbar.ts)

**기존 검사 진입점:** [src/ui/__tests__/seekbar.test.ts](../src/ui/__tests__/seekbar.test.ts), [e2e/seek-drag-source-change.test.ts](../e2e/seek-drag-source-change.test.ts)

### QA098. 수동 싱크 편집창 UX — P1

**판정:** desktop 전체 선택, 모바일 키보드 억제, IME, 부호·숫자 정규화, 잘못된 입력, blur·Done·Escape가 일관적이다. 소스 변경 시 이전 초안을 새 소스 offset에 쓰지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/ui/manual-sync-overlay-runtime.ts](../src/ui/manual-sync-overlay-runtime.ts)

**기존 검사 진입점:** [src/ui/__tests__/manual-sync-focus.test.ts](../src/ui/__tests__/manual-sync-focus.test.ts), [src/ui/__tests__/player-controls.test.ts](../src/ui/__tests__/player-controls.test.ts)

### QA099. 모달·팝업 stack·키보드 focus — P1

**판정:** 중첩 dialog·채팅·설정에서 Tab trap, 최상위 Escape, return focus, inert, 닫힌 창 focus 금지가 유지된다. 늦은 작업이 닫은 창을 다시 열지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/ui/dom.ts](../src/ui/dom.ts), [src/ui/dialog.ts](../src/ui/dialog.ts)

**기존 검사 진입점:** [src/ui/__tests__/dialog.test.ts](../src/ui/__tests__/dialog.test.ts), [src/ui/__tests__/dialog-account-ownership.test.ts](../src/ui/__tests__/dialog-account-ownership.test.ts)

### QA100. 모바일·가로 화면·safe area·fullscreen — P1

**판정:** 작은 landscape, standalone, 노치, 소프트 키보드, Android system bar, 회전에서 필수 제어와 metadata에 접근할 수 있다. fullscreen 실패·소스 전환 뒤 잔여 shell이 없다. 앱 fixed-zoom 정책 자체를 generic 결함으로 취급하지 않으며, 허용된 브라우저 확대·viewport·DPR 변화에서의 레이아웃을 해당 정책 안에서 판정한다.

**방법:** 브라우저 / 실기

**대표 구현:** [css/style.css](../css/style.css), [src/ui/player-controls.ts](../src/ui/player-controls.ts)

**기존 검사 진입점:** [e2e/webkit-mobile-smoke.test.ts](../e2e/webkit-mobile-smoke.test.ts), [e2e/youtube-landscape-full-bleed.test.ts](../e2e/youtube-landscape-full-bleed.test.ts)

### QA101. 접근성·스크린리더·대비·동작 줄이기 — P1

**판정:** 버튼 이름·상태, slider 값, tab·landmark, error·live 안내, 색상 대비가 적절하다. 키보드만으로 핵심 작업이 가능하며 실제 스크린리더 읽기 순서와 reduced-motion 동작을 확인한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/ui/dom.ts](../src/ui/dom.ts), [css/style.css](../css/style.css)

**기존 검사 진입점:** [src/ui/__tests__/contrast-accessibility.test.ts](../src/ui/__tests__/contrast-accessibility.test.ts), [e2e/accessibility-contrast.test.ts](../e2e/accessibility-contrast.test.ts)

### QA102. visualizer 표시·canvas 수명 — P2

**판정:** circular·spectrum·demo·Pause held frame·theme·DPR·resize에서 잘림·깜빡임·중복 loop가 없고 idle에 불필요한 계속 렌더링이 없다. 확대 변화는 앱 fixed-zoom 정책과 허용된 브라우저 배율 변화의 범위를 구분하여 검사한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/ui/visualizer.ts](../src/ui/visualizer.ts)

**기존 검사 진입점:** [src/ui/__tests__/visualizer.test.ts](../src/ui/__tests__/visualizer.test.ts), [e2e/visualizer-layout.test.ts](../e2e/visualizer-layout.test.ts)

### QA103. 로고 리빌·긴 제목·표시 애니메이션 — P2

**판정:** 느린 bootstrap, hidden tab, reduced motion에서 로고·greeting이 완료된다. 제목 hover·focus·touch marquee와 언어 변경에서 글자 누락과 불필요한 레이아웃 이동이 없다.

**방법:** 자동 / 브라우저

**대표 구현:** [browser/classic-runtime/wordmark-anim.ts](../browser/classic-runtime/wordmark-anim.ts), [src/ui/playlist-title-marquee.ts](../src/ui/playlist-title-marquee.ts)

**기존 검사 진입점:** [e2e/wordmark-reveal.test.ts](../e2e/wordmark-reveal.test.ts), [src/ui/__tests__/playlist-title-marquee.test.ts](../src/ui/__tests__/playlist-title-marquee.test.ts)

### QA104. 테마·대비·알림음 설정의 저장과 복원 — P2

**판정:** 테마 저장값·초기 system 선택·저장 거절 fallback, 대비 auto/on/off·실시간 OS 대비·forced-colors, UI 소리 ON/OFF가 재진입 후 일관된다. 데모/일반 화면의 theme-color·color-scheme을 실제 표면과 맞추고 꺼둔 알림음을 출력하지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/ui/settings.ts](../src/ui/settings.ts), [src/ui/theme-chrome.ts](../src/ui/theme-chrome.ts), [src/core/contrast.ts](../src/core/contrast.ts), [src/audio/ui-sounds.ts](../src/audio/ui-sounds.ts)

**기존 검사 진입점:** [src/ui/__tests__/settings.test.ts](../src/ui/__tests__/settings.test.ts), [src/core/__tests__/contrast.test.ts](../src/core/__tests__/contrast.test.ts), [src/audio/__tests__/ui-sounds.test.ts](../src/audio/__tests__/ui-sounds.test.ts)

## 24. 다국어·RTL·폰트

### QA105. 언어 선택·URL·초기 언어·세션 유지 — P1

**판정:** saved·browser·explicit locale 우선순위, English root·alias, static 이동, 실시간 언어 전환에서 URL·언어·설정이 일치하고 연결을 유지한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/i18n/index.ts](../src/i18n/index.ts), [src/i18n/locales.ts](../src/i18n/locales.ts)

**기존 검사 진입점:** [src/i18n/__tests__/locale-paths.test.ts](../src/i18n/__tests__/locale-paths.test.ts), [e2e/release-smoke.test.ts](../e2e/release-smoke.test.ts)

### QA106. 번역 계약·fallback·복수형·동적 문구 — P1

**판정:** 누락 key, 반복 placeholder, plural forms, HTML 구조, 버전·금액·제한 문구가 계약과 일치한다. state가 그대로여도 언어 전환 후 동적 label이 갱신된다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/i18n/index.ts](../src/i18n/index.ts), [src/i18n/plural.ts](../src/i18n/plural.ts)

**기존 검사 진입점:** [src/i18n/__tests__/translations.test.ts](../src/i18n/__tests__/translations.test.ts), [src/ui/__tests__/presentation-language-state.test.ts](../src/ui/__tests__/presentation-language-state.test.ts)

### QA107. RTL·혼합 문자·폰트·긴 번역 레이아웃 — P1

**판정:** Arabic·Hebrew·Latin 혼합 이름, 숫자·시간·Unicode·emoji·긴 문구에서 bidi 격리와 제어 방향을 보존한다. 폰트 차단·late load 상황에서도 읽고 조작할 수 있다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/i18n/locale-fonts.ts](../src/i18n/locale-fonts.ts), [src/ui/user-text-font.ts](../src/ui/user-text-font.ts)

**기존 검사 진입점:** [e2e/rtl-player-layout.test.ts](../e2e/rtl-player-layout.test.ts), [e2e/rtl-settings-layout.test.ts](../e2e/rtl-settings-layout.test.ts)

## 25. 번역 기여·검토·내보내기

### QA108. 번역 작업장 초안·로컬 저장·다중 탭 — P1

**판정:** source·key·locale별 초안, 손상 JSON·용량 초과·저장 거절·다른 탭 변경에서 마지막 작업을 보존한다. placeholder·markup를 검증하고 다른 탭 저장 내용을 덮지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [.workshop/translate/drafts.ts](../.workshop/translate/drafts.ts), [.workshop/translate/storage-session.ts](../.workshop/translate/storage-session.ts)

**기존 검사 진입점:** [src/i18n/__tests__/translation-workspace-drafts.test.ts](../src/i18n/__tests__/translation-workspace-drafts.test.ts), [src/i18n/__tests__/translation-community-ui.test.ts](../src/i18n/__tests__/translation-community-ui.test.ts)

### QA109. 번역 제안·투표·수신 불확실성 — P0

**판정:** 로그인·CSRF·언어·canonical baseline, 계정 변경, 전송 중 초안 변경, 응답 손실에서 유효 제안만 저장한다. idempotency·vote toggle·탈퇴 작성자 정책이 일치한다. 서버의 key·markup 검증, 계정당 한 표, 삭제 fence를 클라이언트와 함께 확인한다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [src/i18n/translation-community.ts](../src/i18n/translation-community.ts), [cloudflare/translation-community.ts](../cloudflare/translation-community.ts), [cloudflare/auth.translation-community.migration.sql](../cloudflare/auth.translation-community.migration.sql)

**기존 검사 진입점:** [src/i18n/__tests__/translation-community-ui.test.ts](../src/i18n/__tests__/translation-community-ui.test.ts), [src/core/__tests__/translation-community.test.ts](../src/core/__tests__/translation-community.test.ts), [src/core/__tests__/admin-translation-ui.test.ts](../src/core/__tests__/admin-translation-ui.test.ts)

### QA110. 번역 검토·분할 export·적용 추적 — P1

**판정:** review revision, 필터·페이지 이동, 오래된 baseline, 이미 적용된 제안 제외, continuation에서 빠짐과 중복이 없다. 적용 과정에서 key·placeholder를 보존한다. 동시 승인·stable cursor·stale export budget을 서버 계약과 맞춘다.

**방법:** 자동 / 브라우저 / 로컬서비스 / 운영확인

**대표 구현:** [browser/classic-runtime/admin.ts](../browser/classic-runtime/admin.ts), [cloudflare/translation-community.ts](../cloudflare/translation-community.ts), [cloudflare/auth.translation-community.migration.sql](../cloudflare/auth.translation-community.migration.sql)

**기존 검사 진입점:** [src/core/__tests__/admin-translation-ui.test.ts](../src/core/__tests__/admin-translation-ui.test.ts), [src/core/__tests__/apply-translation-suggestions.test.ts](../src/core/__tests__/apply-translation-suggestions.test.ts), [src/core/__tests__/translation-community.test.ts](../src/core/__tests__/translation-community.test.ts)

## 26. PWA·초기 로딩·업데이트

### QA111. PWA 설치·manifest·standalone 실행 — P1

**판정:** 언어별 이름·start URL·scope·icon, Android 설치, iOS 홈화면 추가, 기존 설치 후 언어 변경, cold standalone 실행에서 올바른 shell과 제어를 표시한다. 모사 standalone viewport만으로 실제 설치를 확인했다고 판정하지 않는다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [browser/classic-runtime/bootstrap.ts](../browser/classic-runtime/bootstrap.ts), [public/manifests/ko.webmanifest](../public/manifests/ko.webmanifest)

**기존 검사 진입점:** [src/i18n/__tests__/pwa-manifest-locales.test.ts](../src/i18n/__tests__/pwa-manifest-locales.test.ts), [e2e/webkit-mobile-smoke.test.ts](../e2e/webkit-mobile-smoke.test.ts)

### QA112. Service Worker 설치·오프라인·캐시 정책 — P0

**판정:** core shell 일부 실패를 설치 완료로 오인하지 않는다. offline route·lazy chunk·폰트 group·audio primer range, no-store·민감 query의 저장과 제거 정책을 유지한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [browser/service-worker.ts](../browser/service-worker.ts)

**기존 검사 진입점:** [src/core/__tests__/service-worker-cache.test.ts](../src/core/__tests__/service-worker-cache.test.ts), [e2e/production-candidate-smoke.test.ts](../e2e/production-candidate-smoke.test.ts)

### QA113. PWA 업데이트·다중 탭·세대 전환 — P0

**판정:** waiting·controllerchange·Later, prompt·check lease, storage 거절, 혼합 버전 탭에서 안내와 전환을 중복하지 않는다. 필요한 구 lazy chunk를 보존하고 완료 안내를 현재 세대와 일치시킨다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/sw-register.ts](../src/sw-register.ts), [src/sw-update-coordination.ts](../src/sw-update-coordination.ts)

**기존 검사 진입점:** [src/core/__tests__/sw-update-coordination.test.ts](../src/core/__tests__/sw-update-coordination.test.ts), [src/core/__tests__/sw-update-completion.test.ts](../src/core/__tests__/sw-update-completion.test.ts)

### QA114. 초기 bootstrap·first paint·degraded 복구 — P1

**판정:** 느린 locale·폰트·runtime script, cached navigation, Worker 응답 순서, offline→online, hidden→visible에서 blank·잘못된 언어·영구 loading 없이 준비되거나 명확한 복구 동작을 제공한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [browser/classic-runtime/bootstrap.ts](../browser/classic-runtime/bootstrap.ts), [src/core/bootstrap-readiness.ts](../src/core/bootstrap-readiness.ts)

**기존 검사 진입점:** [src/core/__tests__/bootstrap-recovery.test.ts](../src/core/__tests__/bootstrap-recovery.test.ts), [src/ui/__tests__/setup-boot-guard.test.ts](../src/ui/__tests__/setup-boot-guard.test.ts)

### QA115. hard reset·실패한 reload·복구 재진입 — P1

**판정:** stalled waiting Worker, throw·no-op reload, pagehide·BFCache 복귀, 늦은 controllerchange에서 reset latch가 영구 고착하거나 중복 reload하지 않는다. 새 요청의 수명을 보존한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/core/sw-hard-reset.ts](../src/core/sw-hard-reset.ts), [src/sw-register.ts](../src/sw-register.ts)

**기존 검사 진입점:** [src/core/__tests__/sw-hard-reset.test.ts](../src/core/__tests__/sw-hard-reset.test.ts), [src/core/__tests__/sw-register-recovery.integration.test.ts](../src/core/__tests__/sw-register-recovery.integration.test.ts)

## 27. 공개 페이지·콘텐츠 전달

### QA116. 공개 페이지·경로·블로그/RSS·이미지 전달 — P1

**판정:** landing·about·history·events·designsystem·개발자/정책 페이지의 직접 진입·새로고침·언어·링크·404가 맞다. RSS/이미지 upstream 장애·body 정체·malformed/과대 입력에서 최신 정상 백업과 허용된 이미지 경로만 사용하며 숨긴 글·pagination·cache 변경이 일관된다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [cloudflare/app-worker.ts](../cloudflare/app-worker.ts), [browser/classic-runtime/editorial-pages.ts](../browser/classic-runtime/editorial-pages.ts), [browser/classic-runtime/static-language.ts](../browser/classic-runtime/static-language.ts), [browser/classic-runtime/blog-pagination.ts](../browser/classic-runtime/blog-pagination.ts), [.workshop/landing/main.ts](../.workshop/landing/main.ts)

**기존 검사 진입점:** [src/core/__tests__/app-worker-cors.test.ts](../src/core/__tests__/app-worker-cors.test.ts), [e2e/history-page.test.ts](../e2e/history-page.test.ts), [e2e/not-found-page.test.ts](../e2e/not-found-page.test.ts), [e2e/design-system-page.test.ts](../e2e/design-system-page.test.ts), [e2e/about-page-layout.test.ts](../e2e/about-page-layout.test.ts)

## 28. 전역 자원 수명·지연 로딩

### QA117. 전역 세션·이벤트·타이머·요청의 수명 — P0

**판정:** leave/join·방 변경·계정 변경·반복 초기화에서 이전 세션의 이벤트·타이머·요청이 새 세션에 적용되지 않는다. cleanup 일부 예외와 중복 dispose에도 나머지 정리가 끝나고, 종료 뒤 등록한 자원도 즉시 해제한다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/core/session.ts](../src/core/session.ts), [src/core/session-scope.ts](../src/core/session-scope.ts), [src/core/timers.ts](../src/core/timers.ts), [src/core/events.ts](../src/core/events.ts)

**기존 검사 진입점:** [src/core/__tests__/session.test.ts](../src/core/__tests__/session.test.ts), [src/core/__tests__/session-scope.test.ts](../src/core/__tests__/session-scope.test.ts), [src/core/__tests__/timers.test.ts](../src/core/__tests__/timers.test.ts), [src/core/__tests__/events.test.ts](../src/core/__tests__/events.test.ts)

### QA118. 지연 feature import 실패와 복구 경계 — P1

**판정:** 방/PRO 기능 chunk의 실패가 join·create·claim 흐름에서 일관된 재로딩 필요 상태로 전달된다. 감싼 cause와 순환 cause도 처리하고, 실패한 ESM을 같은 문서에서 무한 재시도하거나 partial 세션·로딩 잠금을 남기지 않는다.

**방법:** 자동 / 브라우저

**대표 구현:** [src/core/lazy-feature-failure.ts](../src/core/lazy-feature-failure.ts), [src/network/room-session-feature-loader.ts](../src/network/room-session-feature-loader.ts), [src/pro-room/setup-flow.ts](../src/pro-room/setup-flow.ts)

**기존 검사 진입점:** [src/network/__tests__/room-session-feature-loader.test.ts](../src/network/__tests__/room-session-feature-loader.test.ts), [src/pro-room/__tests__/setup-runtime-failure.test.ts](../src/pro-room/__tests__/setup-runtime-failure.test.ts), [src/ui/__tests__/setup-host-recovery.test.ts](../src/ui/__tests__/setup-host-recovery.test.ts)

## 29. 진단·로그·관측 정확성

### QA119. 진단·로그·싱크 관측의 정확성과 개인정보 — P1

**판정:** 기록의 시계 영역·revision·현재 곡 alias·출력 상태가 실제 세션과 일치한다. Flight Recorder의 샘플/이벤트 상한·중단·내보내기와 log 수명을 확인하고, 기록이 임의 저장/전송되거나 secret·원본 식별자를 노출하지 않는다. 논리 drift·AudioContext 시계·실제 스피커 지연을 구분한다.

**방법:** 자동 / 브라우저 / 실기

**대표 구현:** [src/diagnostics/sync-flight-recorder.ts](../src/diagnostics/sync-flight-recorder.ts), [src/core/log.ts](../src/core/log.ts), [src/core/log-capture.ts](../src/core/log-capture.ts), [src/chat/debug-memory-history.ts](../src/chat/debug-memory-history.ts)

**기존 검사 진입점:** [src/diagnostics/__tests__/sync-flight-recorder.test.ts](../src/diagnostics/__tests__/sync-flight-recorder.test.ts), [src/core/__tests__/log.test.ts](../src/core/__tests__/log.test.ts)

## 30. QA 환경·산출물·운영 계약

### QA120. 로컬 개발·QA의 네트워크 격리 — P0

**판정:** 로컬 URL·명시한 endpoint override·PeerJS·Worker fixture를 구분하고 기본값이나 실패 fallback으로 운영 API에 쓰지 않는다. 잘못된/누락 설정은 안전하게 거부하며 실행 로그와 네트워크 기록으로 실제 대상·포트·origin을 입증한다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [vite.config.ts](../vite.config.ts), [docs/configuration-reference.md](../docs/configuration-reference.md), [docs/local-worker-integration.md](../docs/local-worker-integration.md)

**기존 검사 진입점:** [e2e/network-isolation.test.ts](../e2e/network-isolation.test.ts), [src/core/__tests__/playwright-security-config.test.ts](../src/core/__tests__/playwright-security-config.test.ts)

### QA121. 생산용 산출물·브라우저 기준·폰트/WASM·라이선스 — P1

**판정:** 생산용 빌드의 직접/지연 chunk·classic/auxiliary script·Worker·WASM·폰트·서비스 워커 자산이 실제 경로에서 로드된다. 초기 전송 예산·지원 브라우저 문법/CSS·공개 notices·source map/검사 hook/secret 제외 계약을 맞추고 개발 서버 통과를 빌드 산출물 통과로 대체하지 않는다.

**방법:** 자동 / 브라우저 / 로컬서비스

**대표 구현:** [vite.config.ts](../vite.config.ts), [scripts/assert-production-build-clean.mts](../scripts/assert-production-build-clean.mts), [scripts/check-worker-bundles.mts](../scripts/check-worker-bundles.mts), [scripts/check-initial-transfer-budget.mts](../scripts/check-initial-transfer-budget.mts), [scripts/check-app-font.mts](../scripts/check-app-font.mts), [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)

**기존 검사 진입점:** [e2e/production-candidate-smoke.test.ts](../e2e/production-candidate-smoke.test.ts), [src/core/__tests__/worker-bundle-dry-run.test.ts](../src/core/__tests__/worker-bundle-dry-run.test.ts), [src/core/__tests__/legacy-tv-compatibility.test.ts](../src/core/__tests__/legacy-tv-compatibility.test.ts), [src/core/__tests__/auxiliary-browser-assets.test.ts](../src/core/__tests__/auxiliary-browser-assets.test.ts), [src/core/__tests__/app-font-guard.test.ts](../src/core/__tests__/app-font-guard.test.ts)

### QA122. 운영 binding·secret·배포·복구 계약 검토 — P0

**판정:** 운영 계약 검토 영역으로서 실제 Worker/DO/D1/R2/CORS/key rotation·계약 floor와 소스를 맞춘다. exact candidate SHA·버전/cache·범위·checkpoint/rollback의 증거 요건과 competition freeze의 main/production/audit workflow 동결을 검토한다. 이 항목은 배포 실행을 뜻하지 않는다.

**방법:** 자동 / 운영확인

**대표 구현:** [scripts/release-deployment-state.mts](../scripts/release-deployment-state.mts), [docs/beta-release-readiness.md](../docs/beta-release-readiness.md)

**기존 검사 진입점:** [src/core/__tests__/release-deployment-state.test.ts](../src/core/__tests__/release-deployment-state.test.ts), [src/core/__tests__/ops-drift-audit.test.ts](../src/core/__tests__/ops-drift-audit.test.ts)

## 기능 사이를 연결하는 시퀀스 QA

개별 버튼의 정상 동작만 반복하면, 순서가 뒤집힐 때 생기는 결함을 놓친다.
아래 조합은 도메인별 검사와 별도로 같은 세션에서 이어서 수행한다.
각 조합의 기준 순서를 먼저 통과시킨 후 한 경계씩 바꿔 원인과 대조군을 보존한다.

| 조합 | 반드시 바꿀 순서/실패 | 최종 판정 | 관련 범위 |
| --- | --- | --- | --- |
| 파일 준비 → 다음 곡 → Pause → 늦은 decode/PREPARE | headers와 body 지연, old finally, 재접속 | 마지막 곡·정지 위치·잠금·출력이 일치 | QA004·QA005·QA009·QA033 |
| 프리로드 → 큐 재정렬/삭제 → current 승격 | 같은 파일 중복, 청크 역순, R2 응답 유실 | 올바른 occurrence만 재생, current 데이터 보존 | QA001·QA033·QA035·QA036 |
| YouTube 준비 → Seek/Pause → 시작 예약 → 반복 | 음수/양수 offset, 지연 CUED/ACK, iframe 교체 | 새 의도만 출력하며 무음 준비가 새지 않음 | QA051·QA053·QA054 |
| 효과/볼륨 드래그 → 권한 회수 → 재부여 → 늦은 저장 | GET/PUT 실패, CAS 충돌, opt-out | 취소한 값을 재발행하지 않고 최신 값으로 수렴 | QA027·QA062·QA067 |
| 파일/YouTube → 시스템 공유 → 새 곡 → 공유 종료 | 캡처 거부, track ended, direct/SFU 교체 | 단일 출력·최신 재생 의도·정확한 소스 복원 | QA003·QA043·QA044·QA045·QA046 |
| 재생 → 화면 잠금/전화/앱 전환 → 네트워크 교체 → 복귀 | AudioContext 시계 정체, 늦은 heartbeat/PONG | 죽은 연결 UI 없이 재합류, 로컬 Pause 보존 | QA007·QA026·QA042·QA019·QA028 |
| PRO 전환 → leave/rejoin → 이전 HTTP COMMIT/heartbeat | 취소/중복/역순, transition 교체 | 새 세션·현재 revision만 적용 | QA060·QA064·QA065·QA117 |
| 계정 A 요청 → 로그아웃/탈퇴 → 계정 B 로그인 | 늦은 쿠키 응답, profile/통계/BOT/번역 응답 | 계정 B와 새 방에 A의 응답·권한이 적용되지 않음 | QA069·QA071·QA072·QA082·QA109 |
| API 업로드/명령 → 응답 유실 → 재요청 → 키 회수 | 같은 key 다른 body, queue CAS, 늦은 finalize | 중복 소비/생성 없음, 회수 후 쓰기 금지 | QA073·QA075·QA076·QA085 |
| 방 소유권 이전/삭제 → 코드 재사용 → 옛 참가자 복귀 | saga 단계별 crash·재시도·계정 삭제 | 이전 세대의 자산·키·권한을 새 방에서 사용 불가 | QA090·QA091·QA072 |
| 오래된 설치 PWA → 새 SW → 여러 탭 → offline → reload 실패 | storage 거절, chunk 제거, BFCache | 혼합 세대 충돌·영구 blank/loading·재로딩 반복 없음 | QA112·QA113·QA114·QA115·QA118 |
| 전송 거부/slowmode → 초안 편집 → 복구 → 재전송 | 권한 변경, 같은 문구, 늦은 응답 | 거절을 성공으로 표시하지 않고 새 초안 보존 | QA077·QA062·QA117 |

## 각 범위를 test case로 확장하는 공통 축

| 축 | 최소한 포함할 변형 |
| --- | --- |
| 방·권한 | Standard/PRO, host/owner/controller/member/guest, opt-in/out, 권한 회수·재부여, 동일 계정 여러 기기 |
| 미디어 | 짧은/긴 파일, 같은 곡 중복, 허용/미지원/손상 codec, 기본/구간 decode, YouTube 단일/playlist/live, 시스템 공유, 데모 |
| 상태·순서 | idle/loading/prepared/playing/paused/failed, 첫/끝 곡, 중복·역순·오래된 callback, 빠른 연타, 취소→새 요청, leave→join |
| 입력·한도 | 빈 값, 0/최솟값/최댓값, 한도 직전·동일·초과, 음수/NaN/과대 정수, Unicode/IME/RTL, 악성 HTML/URL, 잘못된 wire·DB 타입 |
| 실패·복구 | 요청 시작/headers/body 각각의 지연·실패, 401/403/409/429/5xx, 응답 유실·재요청, 저장 거절, 부분 teardown, Worker/iframe 교체 |
| 네트워크 | 지연·변동·단절·복귀·낮은 대역폭·느린 한 참가자, Wi-Fi/모바일 전환, local/direct/remote 전달, 실제 NAT/relay 조건 |
| 기기·출력 | 지원 Chromium/WebKit, 실제 iOS/Android/데스크탑, browser/standalone, 유선/Bluetooth/내장 출력, sample rate·오디오 중단 |
| 지속 시간·성능 | cold/warm, 작은/긴 큐, 계약 한도 근처, 장시간 재생·반복 입퇴장·소스 변경, 메모리/CPU/DOM/Worker 추세 |

모든 축의 무조건 전수 곱은 만들지 않는다. 경계별 양쪽과 P0 경합 조합을 먼저 확인하고,
P1/P2는 대표 조합과 pairwise로 넓힌다. 지원 계약 밖의 조건은 올바른 거부와 복구를 검증한다.
수용 수치와 성능 예산이 없는 실기/장시간 항목은 실행 전 장치·기간·측정법·판정값을 정한다.
단순히 CPU/메모리가 낮아 보이거나 조작이 한 번 성공한 것을 통과 기준으로 삼지 않는다.

## 우선 시작할 QA 순서

1. 격리한 QA 환경과 기준 SHA·지원 계약을 확정한다. 상태·권한·단일 출력·비동기 취소의 P0 경계를 검사한다.
2. 파일 전송/프리로드·Standard/PRO 재접속·YouTube 시작/보정·시스템 공유를 위 시퀀스로 엮는다.
3. 계정/API/관리자/방 세대/DB의 권한·응답 유실·중복·부분 실패를 로컬서비스와 브라우저에서 확인한다.
4. 실제 기기의 파일·YouTube 첫 음과 지속 싱크, autoplay, 화면 잠금 복귀, 시스템 캡처·실제 설치 PWA를 확인한다.
5. 장시간·큰 큐·메모리·모바일/접근성·다국어·정적 페이지·오프라인/업데이트·생산용 산출물로 범위를 넓힌다.

특히 실제 음향 QA는 병행할 가치가 크다. 이전 QA에 탐색 직후 일시적인 native PCM 차이와
자동 복구 관측이 남아 있어, 재현 환경과 원인을 추가 분리해야 한다.
이는 새 확정 결함이라는 판정이 아니며, 정확한 기존 증거는
[마지막 QA 기록](design/beta-final-qa-2026-10-04.md)과 [현재 상태](beta-release-readiness.md)를 따른다.

## 결함·관측·제약을 구분하는 기준

- RAM 미디어와 구간 PCM 엔진은 전체 encoded File/Blob 수신 비용을 제거하지 않는다. 메모리 QA는 두 비용을 모두 기록한다.
- 큰 파일의 미지원 codec/profile/container, 로컬 동영상 입력, 브라우저 캡처 한계는 현재 지원 계약에 따라 통제된 거부를 확인한다.
- 앱의 고정 확대 정책은 의도한 계약이다. 그 정책 안의 제어 접근·키보드·스크린리더·대비·OS 확대 가능성을 별도로 확인한다.
- AudioContext·공용 event bus·sync Worker·SW 점검 timer 등 페이지 수명의 singleton은 유지될 수 있다. 세션 자원의 지속 증가와 구분한다.
- PRO YouTube 제목이 기기 언어별로 다를 수 있다. 큐 identity·영상 순서·재생 시간의 일치를 확인한다.
- 기존 P2P 경량 검증과 권한 모델은 허용한 설계를 따른다. 임의로 새 완전 schema를 요구하지 않고 현재 경계의 우회 가능성을 검사한다.
- HTTP 200, Promise resolve, console 오류 없음, mock의 정해진 숫자만으로 성공을 판정하지 않는다. 최종 상태·권한·실제 출력/데이터를 대조한다.
- 실제 발생 경로가 입증되지 않은 강제 예외는 후보로 남긴다. 확정 결함은 공개 진입점·재현 절차·기대 계약·대조군·원본 증거로 설명한다.

## QA 결과에 남길 최소 증거

| 항목 | 기록할 내용 |
| --- | --- |
| 대상 | QA ID·정확한 코드 SHA·작업 트리 변경 여부·빌드/의존성 식별 |
| 환경 | OS/브라우저/실기·출력 장치·방/역할·서비스 대상·네트워크 조건·fixture/mock 여부 |
| 절차 | 전제·입력/순서·실패 주입 위치·예상 최종 상태·관측 시계와 대기 종료 조건 |
| 결과 | pass/fail/skip·retry/flaky·원본 실패와 재검증·타임라인/네트워크/자원/음향 증거 |
| 판정 | 확정 제품 결함 / 검사 판정 오류 / 미확정 후보 / 허용한 제한 / 외부 환경 제약 |
| 후속 | 영향·원인·beta 수정/회귀·미실행 범위·남은 실기/운영 확인 |

새 QA 실행으로 증거·미해결 항목·호환성·복구 요건 등이 달라지면
[베타 현재 상태](beta-release-readiness.md)에 같은 변경으로 반영한다.
이 범위 설계만으로 기존 검사 결과나 릴리스 준비 상태는 변경하지 않는다.
