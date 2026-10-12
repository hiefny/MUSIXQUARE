# PRO 입장 복구와 제한된 서버 진단 — 2026-10-13

## 범위와 원인 구분

오너는 확인된 입장 결함 수정, 기기에 부담을 추가하지 않는 서버 진단, 정식 PR·CI·
프로덕션 배포를 승인했다. 기준 소스는 `d279e9d3d0fc9115e36dde2dbc6e08d03627d5d7`,
직전 운영은 `332600a9` / 8.10.4 / v665다.

[행사 심층 감사](pro-event-admission-deep-audit-2026-10-13.md)와
[외부 보고서 재검증](pro-event-report-verification-2026-10-13.md)의 세 결함을 수정한다.
행사 당시 002026의 실패가 이 중 어느 조합이었는지는 여전히 확정하지 않는다.
Peer 번호는 동시 접속 수가 아니며, 사용자 메일의 “100명처럼”도 서버 오류 코드의
직접 증거가 아니다. 원문 [외부 보고서](pro-event-sleep-and-capacity-code-review-2026-10-13.md)는
수정하지 않고 보존한다.

## 구현

- 활성 기기의 번호는 1–100만 사용한다. 활성 계정 그룹의 대표 번호는 실제 기기
  슬롯 하나로 뒷받침하고, 대표 기기가 빠지면 남은 기기가 그 슬롯을 이어받는다.
  휴면 쿠키·오프라인 관리자 권한은 슬롯을 점유하지 않는다. 기존 101 이상의
  저장 번호도 계정·memberId·권한을 보존하여 정상화한다. 클라이언트 파서의
  100 상한을 느슨하게 만들지 않는다. 오프라인 관리자 번호는 활성 번호와
  중복될 수 있으며 권한 식별은 번호가 아닌 memberId다.
  별도 리뷰에서 오프라인 계정 권한을 현재 기기에 연결할 때 역사적 번호를
  중복 반환하는 경계와, 만석에서 계정 연결이 새 슬롯을 요구하던 경계도
  HTTP 회귀로 실패를 확인해 수정했다. 계정 연결은 이미 점유한 슬롯을 유지한다.
- 요청 초기에만 prune하던 정원 판정은 인증·본문 처리 뒤의 현재 유효 lease를
  기준으로 한다. 거절은 정원 관련 상태를 변경하지 않고, 성공 경로에서 만료
  presence를 제거하여 기존 persist/rollback 경계 안에 함께 저장한다.
- registry 조회를 공유할 때는 ExecutionContext.waitUntil이 조회부터 정리까지
  전체 작업의 수명을 소유한다. 2초의 제한과 결과 세대 검사를 두어 취소되거나
  늦게 끝난 작업이 이후 캐시를 덮지 못한다. 소유 컨텍스트가 없는 호출은 완료된
  캐시만 재사용하고, 진행 중인 조회는 공유하지 않는다. 같은 패턴이 있던 점검·
  공지 조회도 소유된 작업만 공유한다. 실패 시 기존 fail-closed 응답을 유지한다.

정원 100, owner 예약 슬롯, PIN 보호, 공유망 신규 입장 제한, 영수증 보존,
presence TTL 45초, 빈 방의 재생 동결 정책은 완화하지 않는다. 기기 잠금·OS 절전
자체를 해결하는 변경도 아니다.

## 진단 계약

`cloudflare/pro-room-diagnostics.ts`는 고정된 이벤트·사유·숫자 필드만 허용한다.
방 코드와 generation, Worker version(기존 바인딩이 있는 서비스), 요청 종류,
유효 presence와 아직 메모리에 남은 presence, 세션·영수증 수, 최대 Peer 번호를
구분한다. App의 응답 헤더 대기 timeout/본문 timeout/전송·본문 실패, registry
조회 실패, REST 정원·요청 제한·상태 용량, 이미 열린 presence와 신원 불일치,
서버가 관측한 숫자 투영 계약 오류를 별도로 남긴다.

시그널링의 정원 거절에는 socket 수, 마지막 authority의 활성 대상 수와 revision,
입장 ticket의 revision만 추가한다. 이 대상 수는 마지막 수신한 명단이며 실시간
REST 인원 수가 아니다. 이 차이를 통해 다음 관측에서 서버 명단 전파 지연과 실제
정원을 구분할 수 있다. 클라이언트 파서 실패를 서버가 직접 관측한다고 주장하지 않는다.

- 정상 heartbeat마다 로그를 쓰지 않는다. 입장·재입장·재전송·인계·퇴장 및
  sleep/wake 변화는 메모리 카운터에 모아 기존 요청/알람에서 최대 분당 한 번
  요약한다. `counts`는 처리된 작업/배치 수이며 고유 사용자 수가 아니다.
  `affectedCounts`는 명시된 배치의 영향 수만 합산한다. `peakPresence`도 그 객체의
  관측 창에서 본 유효 기기 수이며 영구 통계가 아니다.
  `presence_expire`는 prune 배치가 저장된 뒤 보고한다. admission 도중의 극히
  짧은 TTL 경계에서 추가 정리된 기기까지 모두 세는 완전한 lifecycle ledger는 아니다.
- 고정된 실패 사유별 최초 상세와 분당 추가 4건만 상세 기록한다. 나머지는
  요약 카운터에 포함한다. 방별 동적 Map·새 타이머·DB 쓰기·기기 폴링·수집 SDK 없음.
- App/front의 제한기는 isolate당 고정 개수다. 상세는 해당 방을 가리키지만 그
  요약은 여러 방을 합쳐 roomCode=null로 표시한다. 공유 registry 오류는 실패한
  underlying 조회 수이며, 함께 기다린 모든 요청의 실패 수가 아니다.
- PIN·쿠키·토큰·IP·계정 ID·참가자 이름·미디어·URL·임의 오류 문자열은 넣지
  않는다. 진단 sink가 예외를 내도 원래 응답/권한/저장 결과에 영향을 주지 않는다.
- App/PRO의 로그 head sampling을 0.1에서 1로 올리고, 기존 signaling 1을
  유지한다. 자동 invocation URL 로그와 traces는 계속 꺼져 있다. 기존 custom/
  runtime 로그의 수집량도 증가할 수 있다. 새 진단 상세는 자체 제한을 적용한다.
- 메모리 카운터는 eviction/취소로 마지막 미전송 창을 잃을 수 있다. 공급자 수집
  제한과 계정 보존 기간이 적용되며 영구·무손실 감사 장치가 아니다. 다음 행사
  직후 조회해야 한다. 이번 변경만으로 지난 행사 최대 동접을 복원할 수 없다.

Cloudflare Logs에서 `diagnostic = pro_room`과 roomCode/generation/시간을 함께
검색하고, `scope=room`, `front`, `app`, `signaling`을 나누어 읽는다. 한 건의 502와
registry 실패를 같은 인원 거절로 합산하지 않는다. custom App versionId는 바인딩이
없어 null이며 공급자 Worker 버전 메타데이터를 사용한다.

## 검증과 배포

Windows / Node 24.13.1 / npm 12.0.2에서 로컬 검증했다. 저장소 CI는 pinned
Node 24.20.0을 사용한다. 실제 workerd 하니스는 PRO 전체 front handler와 느린
service binding을 사용해 취소·동시 조회·timeout·늦은 결과를 검증한다. 네이티브
D1의 취소 전파나 고객 행사 네트워크를 재현한 것은 아니다.

실제 HTTP Peer churn/계정 detach/저장 101 복구/TTL 경계와 owner 복구 포함
PRO Worker 439개, workerd 14개 시나리오, 진단·proxy 35개가 통과했다.
Worker coverage 최종 실행은 47파일 / 2,563 pass / 0 fail / 0 skip,
구문 85.41% / 분기 82.20% / 함수 93.42% / 라인 89.87%로 전체·파일별 기준을
모두 통과했다. 타입·린트·포맷, 경계·D1·운영 감사·복구 범위 guard도 통과했다.
독립 리뷰에서 identity/TTL/rollback, 공유 조회 수명, 진단 개인정보·부하,
배포 범위를 확인했으며 최종 차단 지적은 없다.
동결된 수정본의 전체 unit 재실행은 556파일 / 12,505 pass / 0 fail / 0 skip
(06:01:45 KST 시작, 467.47초)이다. 설치된 jq 경로를 명시해 로컬 jq 검사도
실행했다. 초기 편집 중 실행에서 나온 6개 실패는 소스 수정 반영 및 배포 범위·
coverage 목록·waitUntil 수명·bootstrap cache 참조 계약을 보완한 뒤 전부 통과했다.
로컬 검증 소스는 `1d5e95e532936e585d9b91a1b4b0520d891c7485`이며, 해당
committed HEAD에서 `build:checked`도 통과했다. 이후 이 문단의 근거 기록만 추가했다.
PR·exact-main CI·운영 smoke는 완료 후 아래에 기록한다.

배포 예정: 8.10.5 / v666, `target=all`, Developer API D1 적용 `false`.
공통 점검 조회를 사용하는 Worker와 App/PRO/signaling 변경을 같이 배포한다.
새 의존성·비밀·바인딩·스키마·프로토콜 버전·강제 갱신 없음. 기존 캐시 앱의
파서가 그대로 유효하다. 기존 호환 floor와 immutable recovery checkpoint를
유지한다. rollback은 코드 변경을 되돌릴 수 있지만 이전 결함도 다시 생길 수 있다.
정상화한 번호는 기존 스키마 안의 값이라 데이터 down migration은 필요 없다.
