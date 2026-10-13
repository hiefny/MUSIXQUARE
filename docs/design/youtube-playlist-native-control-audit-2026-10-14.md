# YouTube 목록·관리자 iframe 조작 조사 — 2026-10-14

이 문서는 수정 전 조사 기록이다. 이후 구현·검증·배포 상태는
[수정 보고서](youtube-playlist-native-control-repair-2026-10-14.md)를 따른다.

## 범위와 기준선

- 검토·실행 코드 SHA: `1964828e34587214ec3f98bee7a2cf4392a36768`.
  배포 제품 SHA는 `16c6b2196139c206f881c4457237cc36b1c44fe6`, App 8.10.9/cache v671이다.
- 오너 제보: 일반방에서 목록이 200곡으로 끝남. PRO는 처음 추가하면 펼침·재생이
  되지만 퇴장 후 재입장하면 목록이 안 뜸. 일반방의 재생 권한을 받은 게스트가
  iframe에서 재생/일시정지 또는 방향키 탐색을 하면 반복하다 멈춤.
- 대상 목록: `PLsmaUhkCwW3q5q46uc9So2b4D-pZqVZOV`.
- Windows, 로컬 Vitest의 실제 모듈+가짜 네트워크/플레이어, 별도 Chromium의
  실제 YouTube 페이지·iframe, 운영 공개 manifest API 읽기로 조사했다.
- 제품 코드·추적 테스트 수정, 실제 고객방 입장, PR/원격 push, 배포 없음.
  scratch 테스트의 pass는 **현재 결함을 검출하는 assertion 통과**이며 수정 완료가 아니다.

## 1. 일반방의 200곡: 앱의 현재 고정 한도가 아니라 부분 목록 채택

### 관측

| 경로 | 이번에 관측한 수 |
| --- | --- |
| YouTube 원본 페이지의 표시 | 257곡 |
| MUSIXQUARE 공개 manifest API | HTTP 200, 1.774초, 영상 ID 248개 |
| 앱 없이 YouTube iframe의 `getPlaylist()` | 20초 동안 200개, iframe 오류 없음 |

API의 248개는 서버 필터를 통과한 ID 수다. 모든 영상의 재생 가능성을 검증한
수가 아니다. 원본 표시와의 9개 차이는 개별 대조하지 않았다. 서버의 private/
deleted/무효 ID 필터가 있으나 차이의 원인으로 확정하지 않는다. 이 목록에서
iframe이 200개를 반환한 것은 관측했지만 모든 YouTube 목록의 공식 한도라고
일반화하지 않는다.

### 코드 경로

- 과거 앱의 200개 검증 제한은 `160456d7`(2026-05-17)에서 5,000개로 바뀌었다.
  현재 `src/network/protocol.ts`의 `YOUTUBE_PLAYLIST_INFO` 상한도 5,000이다.
  UI의 240개 렌더링 묶음이나 상위 큐 1,000개 제한과 다른 값이다.
- 호스트가 입력창에서 추가하고 전체 manifest 미리보기가 성공하면 서버 목록을
  사용할 수 있다. 다만 `src/youtube/search.ts`의 미리보기 예산은 8초이며,
  미리보기 실패/미확보 경로는 iframe 목록 수집으로 넘어간다.
- `src/youtube/player.ts`의 관리자 게스트 추가는 전체 미리보기 소비 전에
  `requestStandardOperatorYouTubeAdd()`로 반환한다. 호스트의 요청 처리도 첫
  영상 식별 후 iframe 목록 수집에 의존한다. 일반방 채팅 링크 추가 역시 전체
  서버 manifest를 일관되게 확보하지 않는다.
- `src/youtube/iframe.ts`의 수집은 목록 길이가 연속해서 같으면 안정된 목록으로
  확정한다. **길이 안정은 전체 목록 확보의 증거가 아니다.** 이때 받은 200개를
  기준으로 내부 탐색을 구성하고 개별 영상 재생으로 전환하므로 201번째 ID가 없다.
- `src/youtube/player.ts`의 내부 다음 곡 경계와 `src/player/playlist.ts`의 상위
  큐 이동은 이 목록의 끝을 기준으로 동작한다. 끝에서 정지/상위 다음 항목 이동은
  부분 목록을 전체로 취급한 결과와 일치한다.

오너의 당시 입력 경로·미리보기 실패 로그는 없으므로 어느 분기로 들어갔는지는
확정하지 않는다. 수정 방향은 일반방의 모든 추가 경로에서 서버의 완결된 목록을
공통으로 확보하고, 불완전한 iframe 목록을 전체 목록으로 확정하지 않는 것이다.

## 2. PRO 재입장: 서버 목록의 클라이언트 투영 유실 — 확정

실제 `joinProRoom()`과 snapshot 적용 경로를 사용한 두 대조 검사로 확인했다.
목록이 2곡이어도 발생하여 200곡 문제와 독립이다.

1. `src/pro-room/playlist-projection.ts`는 서버 `source.videoIds`를
   로컬 `PlaylistItem.youtubeVideoIds`로 투영한다.
2. `src/pro-room/youtube-manifest-policy.ts`는 항목별
   `pro-queue:<queueItemId>` 키에 목록을 정상 저장한다.
3. `src/pro-room/runtime.ts`의 `playlistWireItems()`와
   `src/player/queue-model.ts`의 `clonePlaylistWireItem()`이 상태 반영 중
   `youtubeVideoIds`를 버린다.
4. `src/youtube/queue-manifest.ts`는 그 필드가 없으면 PRO 항목별 키 대신
   외부 `playlistId` 키를 조회한다. 서버에서 복원한 목록은 다른 키에 있으므로
   실제 행의 `getPlaylistSubItems()`가 `undefined`가 된다.
5. 같은 문서의 추가 미리보기 캐시에 외부 키가 있으면 필드가 없어도 목록이
   나타난다. 퇴장 후 캐시 없는 새 문서 상태를 모델링하여 재입장하면 실패한다.
   캐시가 남는 모든 재입장 방식에서 반드시 실패한다는 뜻은 아니다.

캐시를 항목별 키로 분리한 `b833e2a6`(2026-09-27)과 이전부터 있던 필드 제거가
결합한 문제다. 최근 절전 대응 서버 수정이 직접 만들었다는 근거는 없다.
서버 목록이 정상인 상태에서도 재현되며, 데이터 소실을 요구하지 않는다.
실제 고객방 저장소는 조회하지 않았다.

수정 방향: PRO의 로컬 투영 필드를 **원자적인 큐 상태 반영까지 보존**한다.
일반방 전송 스키마에 전체 manifest를 무조건 추가하거나 상태 반영 후 별도로
덧씌우는 방식은 피한다. 실제 join/snapshot을 거치는 재입장, 동일 외부 목록의
중복 항목, 정렬, 캐시 제거, 오래된 revision 거부를 회귀 검증해야 한다.
기존 occurrence 테스트는 투영 결과를 직접 상태에 넣어 runtime의 필드 제거를
통과하지 않았으므로 이 결함을 잡지 못했다.

## 3. 일반방 관리자 게스트의 iframe 직접 조작

### 재생/일시정지 전달은 이미 있으나 재개가 막힘 — 확정

`native-control-authority.ts`는 일반방 관리자 게스트의 재생/일시정지를
`REQUEST_YOUTUBE_PLAY/PAUSE`로 호스트에게 보낸다. 호스트는 권한과 현재 큐
항목을 검사한 뒤 자기 기준 위치로 방의 재생을 제어한다.

하지만 호스트의 PAUSE/STATE를 받은 `sync.ts`는 `ytAutoplayIntent=false`로
설정한다. iframe의 실제 PLAYING 콜백은 `iframe.ts`의 자동재생 가드에서 다시
pause된다. 직접 사용자 재생을 보호하는 함수가 PRO 전용이라 일반방 관리자는
요청 발생 전 차단된다. 실제 STATE handler → PAUSED → PLAYING 콜백 경로에서
추가 pause, `REQUEST_YOUTUBE_PLAY` 0회, paused 상태를 재현했다.

기존 play-resume 테스트는 실제 iframe 콜백 대신 재생 상태 함수를 직접 호출해
이 가드를 건너뛰었다.

### 직접 탐색을 호스트에게 전달하지 않음 — 확정

40→50초 이동 뒤 BUFFERING→PLAYING이면 재생/일시정지 의미 변화가 없어
위의 native 경로는 요청을 보내지 않는다. 앱의 탐색 UI는 이미
`transport.ts` → `REQUEST_SEEK` → 호스트의 권한 검증 경로를 사용하지만,
iframe의 위치 변화는 이 경로로 들어오지 않는다. 호스트의 다음 동기화는
게스트만 이동한 위치를 다시 호스트 위치로 되돌릴 수 있다.

호스트 직접 조작은 호스트의 위치·상태가 `YOUTUBE_STATE`와 동기화 기준에
반영되므로 같은 조건이 아니다. 관리자의 iframe 조작도 기존 권한 검증을 거쳐
호스트에게 의미 명령을 요청하도록 연결하는 것이 맞다.

### 반복/정지의 추가 후보: 보정 응답을 사용자 명령으로 재해석

- `sync.ts`의 heartbeat 드리프트 보정은 보호 작업 없이 `seekTo()`를 호출한다.
  native origin 추적은 play/pause/load/cue를 다루지만 이 seek를 추적하지 않는다.
- 실제 등록 heartbeat handler의 seek 후 BUFFERING→PAUSED→PLAYING을 주입하면
  관리자 게스트가 새 `REQUEST_PAUSE`, `REQUEST_PLAY`를 보낸다. 그 사이 호스트
  PAUSE 응답을 주입하면 앞의 재개 차단과 결합해 정지로 끝난다.
- 일반적인 앱 `pauseVideo()` 뒤 PAUSED에서는 요청 0인 대조군도 통과했다.
- **한계:** 이 검사는 provider 콜백열과 호스트 응답을 주입했다. 두 실제 기기가
  접속한 방의 자연 반복이나 제보 당시 순서를 관측한 것은 아니다.
- 실제 YouTube iframe의 별도 1회 seek(24.62→36.62초)는 BUFFERING→PLAYING만
  관측했고 PAUSED는 없었다(두 상태 간 약 304ms). 키보드 실험은 효과가 확인되지
  않았고 포인터 focus 보강도 YouTube overlay로 실패했다. 이를 재현 성공으로
  세지 않는다. 따라서 반복·정지 전체의 현장 원인은 아직 확정하지 않는다.

수정 방향: 검증된 사용자 재생과 탐색을 기존 호스트 명령 경로로 연결하고,
heartbeat를 포함한 프로그램 보정의 응답은 입력으로 재해석하지 않게 작업
소유권을 구분한다. 긴 시간 동안 모든 PAUSED를 무시하는 식의 가드는 실제
사용자 입력을 삼킬 수 있으므로 피한다.

## 실행 결과와 증거

| 검사 | 결과 | 한계 |
| --- | --- | --- |
| 기존 native authority/policy/origin/play-resume/seek-feedback + PRO occurrence/projection 7파일 | 43 pass / 0 fail / 0 skip | 실제 iframe callback·runtime sink 공백 존재 |
| 기존 playlist/protocol/Worker 관련 이름 필터 4파일 | 21 pass / 0 fail / 512 필터 제외 | 512개는 플랫폼 skip이 아니라 이번 선택 범위 밖 |
| 실제 `joinProRoom` 기반 scratch | 2 pass / 0 fail | API·미디어/clock 대체, 캐시 없는 문서 상태 모델링 |
| 실제 등록 iframe/동기화 handler 기반 scratch | 5 pass / 0 fail | provider·호스트 프레임 주입, 실제 방의 자연 루프 아님 |
| 실제 원본 페이지·순수 iframe·운영 manifest 조회 | 위 표의 257/200/248 | 읽기 전용, 201번째 재생·전체 영상 재생 미검증 |
| 실제 iframe seek | BUFFERING→PLAYING | 키보드 focus 검증 실패, 합성 PAUSED 경로 미관측 |

로컬 산출물(ignored scratch/임시 폴더, Git에 포함하지 않음):

- `scratch/youtube-native-control-audit-2026-10-14-existing.json`
- `scratch/youtube-playlist-cap-audit-2026-10-14/`: `focused-tests.log`,
  `iframe-probe.json/png/cjs`, `native-page-probe.json/cjs`,
  `iframe-control-probe.json`, `iframe-control-probe-click-focus.json`
- `scratch/native-operator-audit/proof.test.ts`, `proof-result.log`
- `%TEMP%/mxqr-pro-playlist-investigation/runtime-manifest.test.ts`,
  `vitest.config.mjs`, `live-manifest-result.json`

전체 E2E·전체 unit·원격 CI는 이번 조사에서 실행하지 않았다. 위 결과는
exact-main release candidate, 제품 수정 검증, 실기기 음향 검증을 대신하지 않는다.

공급자 계약 참고: [IFrame API](https://developers.google.com/youtube/iframe_api_reference),
[playlistItems.list 페이지 토큰](https://developers.google.com/youtube/v3/docs/playlistItems/list).
공식 IFrame 문서의 숫자 한도와 이번 실제 200개 관측을 혼동하지 않는다.
