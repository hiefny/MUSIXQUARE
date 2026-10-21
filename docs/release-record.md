# 릴리스 기록 (현재 상태)

| Field              | Value                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Runbook — 현재 릴리스 상태. 프로덕션 배포·롤백마다 §1을 덮어쓰고, 열린 항목이 바뀌면 §2를 고친다                                                                                                                |
| Applies to         | 프로덕션 App·Worker 6종의 현재 배포 상태, 열린 확인 항목, 릴리스·QA 때 지킬 기준                                                                                                                                |
| Last source review | 2026-10-21 (배포 SHA `34b27f3d`, Release `39600770366` attempt 1 성공)                                                                                                                                          |
| Executable sources | [CI](../.github/workflows/ci.yml), [Production Release](../.github/workflows/release.yml), [배포 범위·복구 판정](../scripts/release-deployment-state.mts), [D1 계약](../cloudflare/d1-migrations.manifest.json) |
| Related documents  | [릴리스 이력](release-history.md), [정식 배포·복구 절차](hotfix-procedure.md), [버전 규칙](release-versioning.md), [QA 범위 설계](qa-domains.md), [허용한 위험](known-accepted.md), [작업 지침](../AGENTS.md)   |

QA를 시작하기 전과 main 병합·프로덕션 릴리스를 준비하기 전에 이 문서를 읽는다.
아래 값은 표에 적힌 커밋과 확인일 기준이다. 배포 직전에는 실제 Git·CI·Cloudflare
상태와 다시 맞춘다. 배포 승인은 오너가 하고, 절차는
[hotfix-procedure.md](hotfix-procedure.md)를 따른다. 이 문서는 근거를 모을 뿐
승인이나 절차를 대신하지 않는다.

```bash
npm run version:status
gh run list --workflow release.yml --limit 5
gh run list --workflow ops-drift-audit.yml --limit 3
gh run list --workflow e2e.yml --branch main --limit 3
```

## 1. 현재 운영 상태

아래는 2026-10-21 21:37 KST 배포 후 공개 자산·Drift Audit 확인까지의 상태다. 후속 기록 PR은 배포된 코드 SHA나 exact-main 후보를 대신하지 않는다. 다음 배포 전 Git·CI·Cloudflare 상태를 다시 확인한다.

| 항목                   | 값                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App 버전 / SW 캐시     | `8.11.39` / `v764`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 마지막 프로덕션 변경   | 2026-10-21 21:37:33 KST deploy job 완료, [Release 39600770366](https://github.com/hiefny/MUSIXQUARE/actions/runs/39600770366) attempt 1 성공, target=app, Developer API D1=false. 오너 요청(#440): 재생 중인 줄의 아이콘 칸을 16 px 고정 격자로(auto 트랙이 18 px 재생 중 표시에 맞춰 자라 아이콘이 1 px 아래·옆으로 밀리던 결함), 삭제 때 맞닿은 줄이 한 덩어리로 나가고 남은 줄 이동과 빈 목록 안내가 복사본이 흐려진 뒤 시작, 빈 목록 안내가 위에서 가운데로 점프하던 것 수정. 다른 세션의 브라우저 테스트·문서 수정(`agent/e2e-dialog-tab-recovery`)을 함께 포함 |
| 배포 main SHA          | `34b27f3d2768016c3f53419addda326cc7b19c6c`, PR [#440](https://github.com/hiefny/MUSIXQUARE/pull/440) squash. Exact-main push [CI 39596309322](https://github.com/hiefny/MUSIXQUARE/actions/runs/39596309322) attempt 1의 11 jobs success 후보 [artifact 12343903057](https://github.com/hiefny/MUSIXQUARE/actions/runs/39596309322/artifacts/12343903057)(sha256 `535feb19d87c685c26aaa69c3b26336c53d026428c04b8e4e353784baa356eac`)를 사용했다. main 트리는 CI를 통과한 PR head `59eb2ed1`과 같다. Node 24.20.0. PR·로컬 결과를 exact-main 후보로 대체하지 않았다   |
| Worker                 | App version `0e4e3be7-034c-4646-b9eb-26fc813b36c5` / deployment `2b6b1de1-8bc0-4600-81c3-46a339c8ae5f`, 100%, message=`git:34b27f3d2768016c3f53419addda326cc7b19c6c`. 최종 소유권 21:37:28 KST verified, exact-SHA coherent marker 기록, 부분 릴리스 호환성 compatible. 미선택 5 Worker는 8.11.33(`b93bed72`) 배포 그대로다. [배포 원본](https://github.com/hiefny/MUSIXQUARE/actions/runs/39600770366/artifacts/12345434007), [coherent marker](https://github.com/hiefny/MUSIXQUARE/actions/runs/39600770366/artifacts/12344669704)                                |
| 운영 smoke / 공개 자산 | 운영 smoke 4/4 pass: App generation(main `main-CQU-Q1rW.js` 435,336 B, 31 assets 수렴), 익명 App 계정 경계, 기존 PRO 공개 경계, Standard HTTPS signaling(`bridgeOpenMs` 방장 946ms·게스트 644ms). 범위 밖 Worker smoke는 skip. 배포 뒤 공개 GET 모두 HTTP 200: `/` 145,049 B(`bootstrap.js?cache=v764`), `/service-worker.js` 39,308 B(v764), `/bootstrap.js?cache=v764` 10,196 B. [보고서](design/icon-slot-cell-and-delete-sequence-2026-10-21.md)                                                                                                                 |
| 복구                   | 성공한 실행은 rollback 불필요·미실행, 독립 recovery job skipped. 배포 전 [checkpoint](https://github.com/hiefny/MUSIXQUARE/actions/runs/39600770366/artifacts/12345433782)는 App 8.11.38/v763 `1e15f7c2`(version `43f52d56-96da-40d3-8b03-f64ffe7d59a4` / deployment `5d26cd18-3976-4919-9ed6-5b6871dccbaa`)를 보존한다. 복구 경계는 §4의 8.11.39 이하 항목을 따른다. checkpoint는 사용자 데이터 백업이 아니다                                                                                                                                                       |
| 활성 복구 floor        | app 단독 릴리스라 PRO generation floor 검사는 skip이며 floor 변경은 없다. 8.11.33의 다중 재생목록 파일 앞으로만 복구(§4)와 기존 service-control·Soro·PRO 선택형 입장 암호 계약 유지                                                                                                                                                                                                                                                                                                                                                                                  |
| 검증 범위              | Exact-main CI 11 jobs success: unit 13,683 pass / 0 fail / 1 skip(Linux의 Windows 전용 경로 검사), candidate browser 17 + critical browser 56 pass, coverage·타입·린트·정적·빌드·보안 통과. PR #440 head CI 11 jobs 통과. Codex 리뷰는 머지 시점까지 진행 중으로 남아 결과 없음. 로컬 Windows `ff579a72` unit 13,684 pass, `build:checked`(즉시 로드 JS gzip 480.0 KiB, 유지 상한까지 약 0.1 KiB 이하), Chromium e2e 44 pass, 삭제 장면 프레임 확인. 실기기·WebKit·RTL 화면 미검증. [보고서](design/icon-slot-cell-and-delete-sequence-2026-10-21.md)                |
| 잔여 성능 조사         | native 4조건은 두 게스트·각 1회이며 과거 버전 속도 A/B가 아니다. 제어 지연 최대 415.7ms, 제어된 YouTube의 불필요한 조작 0은 실제 공급자·가청 싱크 증명이 아니다. 물리 Android/iOS·무선망/LTE·TURN·혼합 배포 버전·대규모 방과 [허용 위험 #18](known-accepted.md#18-isolated-standard-room-control-route-ends-on-a-network-change)의 실기 확인은 §2에 유지한다                                                                                                                                                                                                         |
| Operations Drift Audit | 배포 후 [39601187609](https://github.com/hiefny/MUSIXQUARE/actions/runs/39601187609) attempt 1, `34b27f3d`, automated-checks-passed: 31 pass / 0 fail / 5 manual-only. 매일 03:37 UTC 일정과 §3 수동 항목 유지                                                                                                                                                                                                                                                                                                                                                       |
| Full E2E               | 매주 월 18:17 UTC. 이번에 전체 직렬 E2E를 재실행하지 않았다. 최신 확인한 정기 main 실행 [39334520177](https://github.com/hiefny/MUSIXQUARE/actions/runs/39334520177)(`3d409c9a`, 2026-10-20 07:22 KST 시작)은 failure. 별도 브랜치 성공 [38405378201](https://github.com/hiefny/MUSIXQUARE/actions/runs/38405378201)(`749f0a6a`)은 이번 변경이나 main 최신 성공을 뜻하지 않는다. 이번 브라우저 근거는 위 exact-main의 73개다(8.11.38 기준)                                                                                                                           |
| 의존성·호환            | 신규 npm 의존성·스키마·비밀·바인딩·프로토콜 변경 없음(App UI와 브라우저 테스트만). App D1 기존 계약 apply/verify 성공, Developer API D1 skip. 8.11.37의 프리로드 복구 정책, 8.11.33의 PRO 저장 키·opt-in 헤더·Developer API 1.1과 일반방 메시지 계약 유지. 기존 의존성 override·Dependabot 정책 유지                                                                                                                                                                                                                                                                 |

## 2. 열린 확인 항목

해결하면 근거(커밋, 실행 ID, 문서)를 PR 설명에 적고 이 목록에서 지운다. 근거
없이 완료로 표시하지 않는다.

### 비주얼라이저·화면 보호기 후보

- [ ] App 8.11.40/v765 후보: 저음 반응 확대, 독립 시간 기반 smoothing,
      가림/동작 줄이기 처리, 스펙트럼 peak 집계와 조건부 로딩을 수정한다.
      신규 의존성·서버 계약·스키마·비밀·바인딩 변경 없음. 최초 미캐시
      스펙트럼 선택에는 추가 로딩이 가능하며 설치 완료 후 offline 자산을 보존한다.
      로컬 검증은 exact-main 후보가 아니며 배포하지 않았다. 물리 기기의 음악별
      시각 체감·전력/GPU 및 Safari 오디오 확인은 남는다.
      초기 JS는 유지 상한보다 20 B 작고 별도 5% reserve는 유지한다. 후속 변경은
      용량을 다시 측정해야 한다.
      [변경·검증 한계](design/visualizer-response-optimization-2026-10-22.md).

### YouTube 목록·관리자 iframe 조작

- [ ] 실제 공급자·실기 확인: 원래 사용자 제보의 자연 반복/정지 경로는 캡처가
      없어 원인 전체를 확정하지 못했다. 합성 provider 회귀로 검증한 수정이 실제
      사건의 경로였다고 단정하지 않는다. 실제 YouTube 키보드·미디어 키, 광고,
      모바일 WebView, 가청 싱크와 제보 목록의 모든 영상 재생 가능 여부는 미검증이다.
      재발 시 새 원인 근거를 수집하며, 이번 배포 성공으로 이 한계를 닫지 않는다.
      [수정·검증 한계](design/youtube-playlist-native-control-repair-2026-10-14.md),
      [원인 조사](design/youtube-playlist-native-control-audit-2026-10-14.md).

### 일반방 직접 파일 전송·프리로드의 남은 실기 한계

App 8.11.20/v723에서 일반 직접 전송·프리로드의 local threshold를 64 KiB로
통일하고, 지원하는 양쪽 연결에 128 KiB 누적 수신확인 창을 적용했다.
최종 runtime `fd1ce373`의 실제 제품 RTC 8조건·26파일 SHA가 통과했으며 혼합 버전
입장·취소/재등록·승격을 확인했다. 구현·재현된 입장 호환 결함은 해결됐고,
아래 확인 항목은 유지한다.
[설계·검증·배포 근거](design/receiver-credit-file-transfer-2026-10-18.md).

- [ ] 실제 Android/무선망 제보의 인과관계와 가청 동기화: Windows 제어·해시
      검증으로 원래 사건 전체를 확정하지 않는다. Pixel 에뮬레이터는 무전송 때부터
      버퍼링이 있어 품질 비교에 부적격이었고, 한 실행의 YouTube onError(5) →
      guest stop 원인은 미확정이다. 실제 기기/live 공급자에서 재확인한다.
      [Pixel 한계](design/preload-local-pixel-retest-2026-10-18.md),
      [실제 공급자 비교](design/youtube-preload-live-ab-2026-10-18.md),
      [두 재생 오염 경로 수정](design/youtube-heartbeat-delay-reproduction-2026-10-17.md).
- [ ] 실제 망의 지연·처리량·기기 부하: 고RTT 8 Mbps 실험에서 23 MB 완료가
      24.495→64.540초로 늘었다. 이는 제어 대기열을 줄이는 고정 창의 대가이며
      첫 파일 대기나 다음 곡 준비가 늦어질 수 있다. 원격 이력의 한 달 전·어제·현재
      각 배포 SHA의 원본 소스를 로컬 빌드한 최소 6회에서도 고RTT 완료가 어제25.352초→
      현재71.817초로 늘었고, 2 Mbps에서는 어제101.683초→현재97.275초였다.
      한 달 전에는 제어 최대20.077초와 약19.6초 재생 오차가 관측돼 지연 자체를
      최근 구조만의 문제로 단정할 수 없다. 단일 수신자·각1회·제어된 공급자이며
      최초 커밋은 원본 입장 예외로 정식2조건 미실행이다. 전송 무결성6회 통과는
      재생 품질 전체 통과가 아니며 운영값·기존 실기 한계를 유지한다.
      [역사 비교 근거](design/historical-transfer-comparison-2026-10-18.md).
      별도 같은-main A192 선별은 71.791→49.516초로 단축했지만 raw 최대1초와
      전체구간 p95 증가 예산에 실패해 채택하지 않았다. 결정 표본은192 확대 전
      시작 구간이며, 전송 길이에 따른 p95 표본 비중 차이를 별도로 기록했다.
      후속6조건은 미실행이고 운영값을 바꾸지 않았다.
      [A192 실패·원시 경계 근거](design/adaptive-credit-192-screen-2026-10-18.md).
      이어진 AF19216(협상된 native16 KiB+적응형 최대192 KiB) 8실행은 고RTT
      preload71.583→48.450초·일반64.217→36.760초, 느린 망101.610→101.614초를
      기록했다. 동적망149.978→122.697초 단축에도 초기 상대 제어 지연 예산을
      넘어서 채택하지 않았다. 결정 표본은192 확대 전128 단계였고 native 전달
      내부 원인은 미확정이다. 작은 tail 분석 오탐은 별도 수정·재판독했지만
      실제 성능 실패를 없애지 않으며, 역순4회·다중/수명6회는 미실행이다.
      [AF19216 실패·독립 감사](design/adaptive-credit-fragment16-screen-2026-10-18.md).
      후속 동일 B128 진단에서 첫 청크 809/1,885ms 상태를 재현했고, 느린 실행은
      이미 도착한 제어 메시지의 지연 ACK가 재전송 타이머와 경합해 전송량이
      줄어든 뒤 bulk를 시작하는 패킷·소스 근거를 확보했다. 지연만 100→80ms로
      바꾼 비교의 계획 관측 구간에서는 같은 경합이 없었다. 이는 새 재현의
      시작 지연 설명이며 과거 모든 실패·72초 전체 비용·실제 현장 원인의
      확정이 아니다. 전체 파일은 미완료인 8초 진단이고, 비교 실행의 관측 종료
      후 재전송 원인은 미확정으로 보존한다. 후보 실패·운영값·배포 보류를
      유지하며 [시작 전송 원인 조사](design/startup-transport-cause-2026-10-19.md)를
      다음 검증에 사용한다.
      후속 제어 연결 분리 실험에서 고정 256 KiB 창은 느린 망 상대 p95 예산에
      실패해 제외했다. 별도 실제 RTC 제어 연결+기존 적응형 128→192 KiB 후보는
      고RTT preload 73.103→40.193초, 연결 전부터 고RTT를 적용한 별도 비교에서
      72.375→40.108초로 단축했다. 후자의 sync-pong 최대는 1,254.3→152.7ms다.
      느린 망은 128 KiB를 유지하며 101.608→97.476초, 동적 8→2→8Mbps는
      151.276→115.623초였고 각 적용 가능한 제어·무결성·재생 관측 게이트를
      독립 판독했다. 서로 다른 느린 망·고RTT 수신자 2대에 동시 전송한 비교도
      일반 파일 65.667→39.912초, preload 66.214→40.084초로 고RTT 쪽이 단축됐고,
      느린 쪽 시간 증가는 각각 0.291%/0.224%였다. 각 수신자의 전체 방 전송구간
      제어 지연까지 적용 가능한 예산을 통과했다. 호스트 업링크는 제한하지 않았다.
      후보의 취소/재등록·다음 곡 승격·의도적 보조 연결 종료도 각각 단일 실행으로
      독립 감사했다. 종료된 쪽의 미확인 debt·미도착 제어는 보존하며 다른 수신자는
      기존 연결로 파일을 완료했다. 살아 있는 전송 중 경로 전환·재접속 검증은 아니다.
      이는 미배포 Qlease가 같은 두 로컬 빌드의 실험이며
      운영 버전 직접 A/B나 실제 Android·음향 검증이 아니다. 제품의 인증된
      보조 연결 협상·재접속·모바일 비용은 아직 구현·검증하지 않았으며
      운영 128 KiB와 배포 보류를 유지한다.
      [제어 연결 분리 실험·검증 범위](design/control-association-isolation-2026-10-19.md).
      2026-10-19 오너가 실제 앱 통합·협상/재접속·일반/프리로드 검증 뒤 조건부
      배포를 승인했으나, 안전 중단 후 같은 날 검증만 재개하며 배포는 명시적으로
      보류했다. 별도 delay-based credit 브랜치는 읽기 전용 검토 대상으로 두며
      현재 검증 후보에 섞지 않는다. App 8.11.22/v731 후보는 제품 내부 협상과 전환 순서 보호,
      최대 8개 별도 제어 PC, 분리 성공 시에만 128→192 KiB 적응을 구현했다.
      신규 의존성·스키마·비밀·바인딩·입장 정책 변경 없이 App만 배포할 계획이며,
      이전 Qlease 미배포 변경도 범위에 포함된다. v728의 첫 실제 제품 고RTT 일반
      전송 비교는 73.879→66.498초(9.99%)로 사전 20% 개선 기준에 실패했다.
      파일·경로·제어 지연 예산은 통과했지만, 단일 2초 확대 표본의 19.44% 이득이
      거절되어 30초 cooldown이 발생했다. 산술·이식 결함은 확인되지 않았다.
      첫 확대 관측만 균일하게 4초로 늘리고 안전·합격 기준을 유지하는 별도 후보를
      검증하며 원래 실패를 보존한다. v729의 일반 전송은 73.634→52.706초로
      기준을 통과했지만 프리로드 쌍 비교는 기존 버전 준비 실패로 중단했다.
      후속 진단에서 READY 전 같은 곡 replay가 시작 예약을 잃는 별도 경계를
      재현해 v730에서 보완했지만, 실제 재검증에서 READY 재생 뒤 지연 cue가
      덮는 잔여 경계가 나왔다. v731은 같은 곡 재요청 시 기존 로드를 유지하고
      시작 의도만 갱신한다. 최초 오류의 원시 유실과 재현된 실패를 구분하며,
      C9(`6a5afaae`)의 남은 로컬 검증은 완료했다. 실제 제품 RTC 고RTT preload는
      72.041→51.454초, 느린 망은 102.444→103.770초, 동적 망은 156.439→126.724초로
      각 사전 기준을 통과했다. 구·신 버전·취소/재등록·승격 6조건 10파일과 실제
      Reconnect→Start 3파일도 독립 기능 검증을 통과했다. 호스트 단일 4Mbps 업로드를
      공유한 두 수신자는 완료시간 증가가 +0.962%/+1.502%였고, 방 전체 관측의 최대
      제어 지연은 2,184.0→375.2ms로 줄었다. 두 창은 128KiB를 유지했다.
      시험 조작 순서와 판독기 오류의 최초 실패, 구버전 초기 재생이 겹친 baseline,
      희소 통계 N/A·export 구간 무효 표본은 보존한다. 실제 기기·가청 싱크·live 공급자
      한계는 그대로이며, 재개 중 제품 코드를 추가 수정하거나 다른 후보를 섞지 않았다.
      실제 제품 검증·exact-main CI·배포가 끝나기
      전에는 실험 통과를 운영 완료로 바꾸지 않는다.
      [제품화·검증 기록](design/control-isolation-product-integration-2026-10-19.md).
      같은 날 오너는 #410·지연 기반 창(128–256 KiB, 근거 상한)·전송 중 시계 보호를
      한 릴리스로 묶고, 사전에 고정한 native 라운드가 괜찮으면 배포하도록 요청했다.
      App 8.11.23/v732 후보 `72c58898`의 r1은 고RTT 프리로드·일반 전송 71.6→47.7초
      (−33%), 느린 망 +1.3%, 급락 8→2→8 −21%, 로컬 파일 재생 중 프리로드 65.3→33.3초로
      기준을 통과했다. 모든 응용 제어 최대는 1초 미만(급락 557ms)이고 재생 조작·로컬
      보정은 0이었다. 보조 연결 ICE restart는 다음 릴리스로 미뤘고, 망 전환 시 연결 종료는
      [허용 위험 #18](known-accepted.md#18-isolated-standard-room-control-route-ends-on-a-network-change)에
      둔다. 2026-10-19 18:14 KST Release 39228199282로 배포했다. 실기 Android/iOS·
      가청 싱크·live 공급자는 여전히 미검증이다.
      [통합 릴리스 검증](design/transport-release-bundle-2026-10-19.md).
      오너는 같은 날 운영 8.11.23에서 직접 파일을 받은 폰을 와이파이→LTE로 바꿔 연결 끊김을
      재현했다. 8.11.24/v733 후보(`ee8dcd28` + 식별자)는 보조 연결 ICE restart를 더한다.
      8.11.24는 배포하지 않고 아래 미리받기 재개, 공유 중지 버튼 정렬 수정과 묶어 8.11.25/v734
      (`e371df6b`)로 2026-10-20 04:04 KST Release 39307533720에서 배포했다.
      구현 세션 랩과 기대값 없이 수행한 독립 검증 모두, 짧은 끊김은 두 버전 다 유지하고
      보조 연결이 failed에 닿으면 8.11.23만 세션을 잃으며, 원래 연결의 15초 유예를 넘는
      끊김은 두 버전 모두 끝난다는 같은 결과였다. IP 변경은 랩에서 흉내 낼 수 없어 배포 뒤
      실기 확인으로 남긴다. 두 랩 모두 미리받기가 원래 연결 disconnected 감지 즉시 중단되고
      복구 뒤 다시 시작하지 않는 기존 동작을 확인했다. 8.11.25는 끊긴 레인을 ABORT 없이 멈춰
      두었다가 같은 연결이 복구되면 처음부터 다시 보내고(`restart` 표시), 게스트는 남은 부분 세션을
      놓고 재시작한다. 같은 (c) 조건의 2차 5회와 최종 런타임 3회가 모두 정확한 파일로 완료했다. 방장만
      고친 1차 후보는 4회 중 1회 실패했고, 그 원인을 게스트 재시작으로 고쳤다. 최종 3회 중 1회는 끊김 전에
      들어온 운영체제 미디어 일시정지로 재생 기준(C3)을 계산하지 못했다. PeerJS 연결은 복구를 알리지
      않으므로 기존처럼 바로 취소한다.
      [미리받기 재개 근거](design/preload-resume-after-ice-recovery-2026-10-20.md)
      [독립 검증](design/side-ice-restart-independent-verification-2026-10-20.md),
      [구현 랩](design/side-ice-restart-native-lab-2026-10-19.md).
      이전에 수행한 128/256/384/512 KiB
      비교에서 일반 전송과 프리로드의 고RTT 경로를 모두 반복 측정했다. 256 이상은
      이 조건에서 빨랐지만, 2 Mbps 프리로드에서는 파일 완료시간 이득 없이
      재생 중 자동 재정렬을 일으켜 고정 기본값 확대 후보에서 제외했다.
      후속 적응형 128→192→256 KiB 후보도 고RTT 완료시간은 약55% 줄였지만,
      느린 망 일반 전송의 동일 sync-pong 추가 최대 지연이 274ms 늘어 사전
      비교 예산 250ms를 넘었다. 채택·배포하지 않았으며 운영 128 KiB를 유지한다.
      로컬 기준 64/128/256 × 수신확인 창 128/256 KiB 후속 교차 36회와
      선택 조합 역순 12회도 완료했다. 파일 224개는 모두 무결성·receipt 검사를
      통과했지만, 창256의 느린 망 프리로드 3회는 재생 유지에 실패했다.
      로컬256/창128의 고RTT 전송은 역순에서도 약65초로 같았고, 느린 망
      프리로드의 동일 sync-pong 추가 최대 지연은 기준보다 +279/+289ms로
      두 순서 모두 예산을 넘었다. 무제한 망 일반 전송의 첫 속도 이득도 역순에는
      재현되지 않았다. 대체 기본값을 채택하지 않고 운영64/128을 유지한다.
      후속 합동 검토에서 보수적 적응형A2, native16 KiB 분할F16, 둘의 조합AF16을
      격리 구현했다. native12회·36파일은 기능/무결성을 통과했으나, A2·AF16은
      갑작스러운8→2 Mbps 하락 구간의 동일 sync-pong excess max가 기준보다
      +348/+391ms 늘어250ms 예산을 넘었다. F16은 고RTT 이득10.47%로
      사전20% 기준에 미달했다. 종합 통과 후보가 없어 확대 확인은 생략했고,
      후보 runtime은 미배포다. 이 결과로 모든 망에서 개선이 불가능하다고
      단정하지 않으며 운영64/128과 기존 실기 한계를 유지한다.
      구버전 송신자는 기존 지연이 남고(혼합 검사 최대 2.483초), 실기 CPU/메모리·
      8대 초과 실기·TURN은 미검증이다. PRO/R2는 변경 대상이 아니다.
      128 KiB는 payload 미확인량 상한이며 전체 네트워크 대기/지연 상한이 아니다.
      [네 창의 비교·선택 근거](design/receiver-credit-window-comparison-2026-10-18.md),
      [적응형 후보의 지연 예산 실패](design/receiver-credit-adaptive-design-2026-10-18.md),
      [로컬·수신확인 교차 48회와 역순 재검증](design/receiver-credit-cross-matrix-2026-10-18.md),
      [후속 합동 후보·동적 망 선별](design/transport-candidate-roundtable-2026-10-18.md),
      [범위·tradeoff](design/receiver-credit-file-transfer-2026-10-18.md),
      [이전 64 KiB 완화](design/preload-capacity-validation-2026-10-18.md),
      [독립 native 조사](design/preload-control-queue-root-cause-2026-10-18.md).
- [ ] 창 확대 전 시계·자동 보정의 혼잡 내성: 256/384/512 KiB 실험 후보의
      2 Mbps 프리로드에서는 정상 파일 수신과 별개로 불필요한 pause→seek→play가
      각 두 번씩 재현됐다. 첫 사례는 좋은 시계 표본의 개수 제한 퇴출 이후
      비대칭 대기열이 섞인 표본 선택→드리프트 오판→자동 재정렬 경로로 분석했다.
      128 KiB는 같은 두 반복에서 재생을 유지했다. 이는 확대 후보의 통제 실험
      결과이며 운영 128 KiB나 원래 Android 사건의 발생 증거로 바꾸지 않는다.
      후속 약178초 실제 RTC 혼잡에서도 현재 128 KiB는 재생을 유지했다.
      고정256 대조군은 추가 재생 조작 5개(완료한 보정 1회와 미완료 1회)가
      발생했고, 시계 품질로 자동 정밀 보정을 제한한 별도 후보는 0개였다.
      메시지 지연은 986→989ms로 거의 같아 전송 개선으로 해석하지 않는다.
      당시 보호는 격리 실험 소스에만 있었다. 후속 Qlease 후보는 자동 재정렬 한 작업의
      시각을 고정하고, 시계 무효화/지각 릴리스 후 같은 소유권이 유지되면 보정 전
      로컬 타임라인으로 복귀한다. 새 handler29개를 포함한 결정적648개가 통과했고,
      같은29개를 이전 Q-only에 적용하면18 pass/11 expected fail이었다.
      이는 실험 후보 간 대조이며 운영 결함11건을 뜻하지 않는다. 실제300ms
      오차도 고RTT 품질 부족 때 보류하는 한계가 남고, 복귀는 재생 지속 보호이지
      정확도 회복이 아니다. 미배포이며 수동 조작·3초 초과 별도 보정·실기/가청
      정확도·실제 슬립·관측하지 못한 원격 시계 변화까지 해결한 것으로 보지 않는다.
      더 큰 창이나 적응형 창을 검토한다면 시계 추정·자동 보정까지 함께 검증한다.
      후속 교차 시험도 창256의 세 로컬 기준에서 첫 불필요한 자동 재정렬을
      재현했다. 5개 호출인 사례는 완료 보정1회와 관측 종료 전 미완료 시도1회이며,
      두 번째 시도까지 모두 불필요했다고 분류하지 않는다.
      제품 후보 후속은 운영64/64/128을 유지하고 `m>=150ms && m>2U`의
      시계 불확실성 gate, 관측부터 실행까지 같은 lease, 새 명령 우선과
      제한된 로컬 진단을 추가했다. App8.11.21/v725 후보이며 아직 미배포다.
      로컬 전체 단위13,231 pass와 PR CI11 jobs, 관련 브라우저34개를 통과했다.
      native10회·24파일 및 독립 검산에서 운영128의 전송·재생 보존과 실제
      ±300/±1200ms 복구를 확인했다. 별도256 진단은 잘못된 첫 보정을 차단했지만
      빠른 수신자 두 대의 완료시간이+13.88/+14.71%로 사전10% 예산을 넘었고
      원인은 미확정이다. 전체 사전 계약 통과가 아닌 운영128 한정 빌드 후보다.
      고RTT 처리량·실기 한계는 유지하며 배포하지 않았다. 환경·skip·exact-main
      후보의 완료 여부는
      [후속 제품 후보 검증](design/automatic-realignment-clock-safety-2026-10-18.md)에
      따르며, 실제 오차의 장기 보류·실기/가청 한계를 이 변경만으로 닫지 않는다.
      통합 후보 8.11.23/v732는 같은 gate를 로컬 파일 soft resync에도 적용하고, 용량을
      넘으면 RTT가 큰 표본부터 지워 조용한 표본을 120초 나이 제한까지 유지하며, 강제
      재고정 때 기존 표본을 바로 버리지 않는다. r1 느린 망 로컬 파일 시나리오의 98초
      전송 동안 baseline 시계 오차는 −38ms까지 벌어졌고 후보는 −3ms 안에 머물렀다.
      고RTT 경로에서는 2U보다 작은 로컬 드리프트 보정을 보류하는 대가가 있다.
      [전송 중 시계 보호](design/transfer-clock-sync-guard-2026-10-19.md).
      [재현·원시 시각 재구성·한계](design/receiver-credit-window-comparison-2026-10-18.md#candidate-interruption-queue-biased-clock-and-automatic-realignment),
      [추가 설계·장시간 비교·미배포 범위](design/receiver-credit-adaptive-design-2026-10-18.md),
      [교차 시험의 실패 보존·독립 검산](design/receiver-credit-cross-matrix-2026-10-18.md),
      [작업 시계 고정 후보·대조와 한계](design/transport-candidate-roundtable-2026-10-18.md#qlease-대조).

### 최근 해결 근거

App 8.11.37/v762의 두 프리로드 복구 결함은 PR [#436](https://github.com/hiefny/MUSIXQUARE/pull/436),
exact-main `56721c76`의 [CI 39580783569](https://github.com/hiefny/MUSIXQUARE/actions/runs/39580783569),
[Release 39581781117](https://github.com/hiefny/MUSIXQUARE/actions/runs/39581781117) attempt 1로 배포했다.
원본의 두 실패를 재현한 뒤 37개 복구 검사·관련 3,623개 검사와 native 4조건·8파일을 검증했고,
최종 로컬 단위 13,681 pass, main 단위 13,680 pass / 1 Windows-only skip, 브라우저 73 pass,
운영 smoke 4/4·최종 소유권·coherent marker·공개 7자산 해시·Drift 31 pass / 5 manual-only를 확인했다.
64 KiB 청크·로컬 기준 및 적응형 최대 256 KiB는 유지하며, 위 실기·대규모·실제 공급자 한계는 닫지 않는다.
[복구·다중 수신·배포·한계 근거](design/preload-recovery-and-db256-multi-2026-10-21.md#production-release-and-recovery).

App 8.11.20/v723의 일반 직접 파일·프리로드 수신확인 제어는 PR
[#399](https://github.com/hiefny/MUSIXQUARE/pull/399), exact-main `416f5ee4`의
[CI 39081289549](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081289549),
[Release 39081701815](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815)
attempt 1의 운영 smoke 4종·최종 소유권·부분 릴리스 호환성·coherent marker,
공개 8 GET 후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포를
완료했다. 테스트 중 발견한 private hello의 입장 순서 결함도 재현·수정·재검증했다.
실제 Android 사건·고RTT 처리량·혼합 버전 성능 한계는 위 열린 항목에 유지한다.
[설계·실패 원인·검증·배포·복구](design/receiver-credit-file-transfer-2026-10-18.md#release-and-recovery).

App 8.11.19/v721의 프리로드 64 KiB 최소 완화는 PR
[#397](https://github.com/hiefny/MUSIXQUARE/pull/397), exact-main `eea5a842`의
[CI 39074808159](https://github.com/hiefny/MUSIXQUARE/actions/runs/39074808159),
[Release 39075260878](https://github.com/hiefny/MUSIXQUARE/actions/runs/39075260878)
attempt 1의 운영 smoke 4종·최종 소유권·부분 릴리스 호환성·coherent marker,
공개 7 GET 후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비를
완료했다. 실제 Android 사건과 심한 느린 망 지연은 위 열린 항목에 유지한다.
[변경·검증·배포·복구](design/preload-capacity-validation-2026-10-18.md#release-and-recovery).

App 8.11.18/v720의 시작 화면 버튼 전환 크로스페이드(오너 지적·결정 2026-10-18)는 PR
[#395](https://github.com/hiefny/MUSIXQUARE/pull/395), exact-main `06e26645`의
[CI 39067630261](https://github.com/hiefny/MUSIXQUARE/actions/runs/39067630261),
[Release 39068051083](https://github.com/hiefny/MUSIXQUARE/actions/runs/39068051083)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다. PR 자동 리뷰
지적은 없었다. 헤드리스 프레임 캡처와 단위·브라우저 테스트만 있으므로 실제 기기 확인은 아래
실기기 항목에 남긴다.
[원인·변경·검증·배포·복구](design/setup-actions-transition-2026-10-18.md#release-and-recovery).

App 8.11.17/v719의 시작 화면 캐러셀 간격·다크 아이콘 원(오너 결정 2026-10-18)은 PR
[#393](https://github.com/hiefny/MUSIXQUARE/pull/393), exact-main `ee9cd197`의
[CI 39063986797](https://github.com/hiefny/MUSIXQUARE/actions/runs/39063986797),
[Release 39064457697](https://github.com/hiefny/MUSIXQUARE/actions/runs/39064457697)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다. PR 자동 리뷰
지적은 없었다. 스크린샷 픽셀 측정과 브라우저 테스트만 있으므로 실제 기기 확인은 아래 실기기 항목에
남긴다.
[요청·변경·검증·배포·복구](design/setup-carousel-spacing-2026-10-18.md#release-and-recovery).

App 8.11.16/v718의 휴대폰 세로 시작 화면 보이는 기준 가운데 정렬(오너 지적 2026-10-18)은 PR
[#391](https://github.com/hiefny/MUSIXQUARE/pull/391), exact-main `6a934577`의
[CI 39056172118](https://github.com/hiefny/MUSIXQUARE/actions/runs/39056172118),
[Release 39056678732](https://github.com/hiefny/MUSIXQUARE/actions/runs/39056678732)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다. PR 자동 리뷰
지적은 없었다. 스크린샷 픽셀 측정과 브라우저 테스트만 있으므로 실제 기기 확인은 아래 실기기 항목에
남긴다.
[원인·변경·검증·배포·복구](design/setup-mobile-visible-centering-2026-10-18.md#release-and-recovery).

App 8.11.15/v717의 휴대폰 세로 시작 화면 가운데 정렬(오너 요청 2026-10-18)은 PR
[#389](https://github.com/hiefny/MUSIXQUARE/pull/389), exact-main `d51eb367`의
[CI 39053792906](https://github.com/hiefny/MUSIXQUARE/actions/runs/39053792906),
[Release 39054268521](https://github.com/hiefny/MUSIXQUARE/actions/runs/39054268521)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다. PR 자동 리뷰
지적은 없었다. 헤드리스 Chromium 측정과 브라우저 테스트만 있으므로 실제 기기 확인은 아래 실기기
항목에 남긴다.
[변경·검증·배포·복구](design/setup-mobile-centering-2026-10-18.md#release-and-recovery).

App 8.11.14/v716의 일반방 YouTube 지연 heartbeat 보정은 PR
[#387](https://github.com/hiefny/MUSIXQUARE/pull/387), exact-main `e47d0bb5`의
[CI 39038651880](https://github.com/hiefny/MUSIXQUARE/actions/runs/39038651880),
[Release 39039136092](https://github.com/hiefny/MUSIXQUARE/actions/runs/39039136092)
attempt 1 성공·운영 smoke 4종·공개 6 GET 후보 해시 일치·최종 소유권·Drift 31 pass로
배포 준비 항목을 닫았다. 실제 Android 프리로드 사건의 인과관계는 위 항목에 남긴다.
[수정·재현·배포 근거](design/youtube-heartbeat-delay-fix-2026-10-17.md).

App 8.11.13/v714의 방 만들기 QR 깜빡임 수정(오너 요청 2026-10-17)은 PR
[#385](https://github.com/hiefny/MUSIXQUARE/pull/385), exact-main `600f6046`의
[CI 39033815131](https://github.com/hiefny/MUSIXQUARE/actions/runs/39033815131),
[Release 39034289195](https://github.com/hiefny/MUSIXQUARE/actions/runs/39034289195)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
Codex P2 1건(앞선 QR 라이브러리 로드 실패 시 재시도 없음)은 `f8548a9a`에서 고치고 회귀
테스트로 고정했다. 헤드리스 Chromium 프레임 확인과 단위·브라우저 테스트만 있으므로 실제 기기
확인은 아래 실기기 항목에 남긴다.
[변경·검증·배포·복구](design/setup-qr-reveal-2026-10-17.md#release-and-recovery).

App 8.11.11/v711의 업데이트 대화상자 어디서나(오너 결정 2026-10-17)는 PR
[#381](https://github.com/hiefny/MUSIXQUARE/pull/381), exact-main `019d5101`의
[CI 39004078601](https://github.com/hiefny/MUSIXQUARE/actions/runs/39004078601),
[Release 39004520681](https://github.com/hiefny/MUSIXQUARE/actions/runs/39004520681)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
Codex P2 2건은 `d1a3995d`에서 고치고 회귀 테스트로 고정했다. 2026-10-11 방 안 안내와
8.11.6 재접속 적용의 실기기 항목은 그 동작이 사라져 같은 PR에서 8.11.11 항목으로
바꿨다. 로컬 데스크톱 Chromium 확인과 단위 테스트만 있으므로 실제 기기 확인은 아래
실기기 항목에 남긴다.
[변경·검증·배포·복구](design/update-dialog-everywhere-2026-10-17.md#release-and-recovery).

App 8.11.10/v709의 설명 글로우·묶음 중앙 정렬(오너 결정 2026-10-17)은 PR
[#379](https://github.com/hiefny/MUSIXQUARE/pull/379), exact-main `68fb3f9c`의
[CI 38995509028](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995509028),
[Release 38995961690](https://github.com/hiefny/MUSIXQUARE/actions/runs/38995961690)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker,
공개 19 GET의 후보 해시 일치로 배포 준비 항목을 닫았다. 자동 리뷰 P2 1건은
효과 전 글자 경계와 alpha 임곗값 경계가 다른 점을 독립 확인하고 테스트 기준을
교정해 처리했으며 제품 정렬을 다시 이동하지 않았다. 역사 진단은 원문을 보존했다.
기록 작성 시점인 11:46 KST에 로컬/원격 main은 `68fb3f9c`로 같고 checkout은 clean이다.
이 기록 병합 뒤 최종 fast-forward·diff 확인을 수행한다. 실제 iPhone·live 공급자·성능
한계는 유지한다. [변경·검증·배포·복구](design/screensaver-caption-glow-centering-2026-10-17.md#release-and-recovery).

App 8.11.9/v708의 뒤로가기로 맨 위 창 닫기(오너 결정 2026-10-17)는 PR
[#377](https://github.com/hiefny/MUSIXQUARE/pull/377), exact-main `5cbfaadf`의
[CI 38977359502](https://github.com/hiefny/MUSIXQUARE/actions/runs/38977359502),
[Release 38978044549](https://github.com/hiefny/MUSIXQUARE/actions/runs/38978044549)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 5 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
로컬 데스크톱 Chromium 확인과 단위 테스트만 있으므로 실제 기기의 뒤로 버튼·제스처는 아래
실기기 항목에 남긴다.
[변경·검증·배포·복구](design/back-closes-top-window-2026-10-17.md#release-and-recovery).

App 8.11.8/v707의 승인된 diffusion 01 시계 배경은 PR
[#375](https://github.com/hiefny/MUSIXQUARE/pull/375), exact-main `e0d71731`의
[CI 38950054085](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950054085),
[Release 38950797624](https://github.com/hiefny/MUSIXQUARE/actions/runs/38950797624)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker,
공개 19 GET의 후보 해시 일치로 배포 준비 항목을 닫았다. 새 이미지 7개는 승인된
처리 결과와 동일하고 이전 이미지 7개도 보존했다. 물리 화면의 밴딩 부재를 보장하지
않으며 실기기 항목은 유지한다.
[변경·검증·배포·복구](design/screensaver-diffusion-clock-2026-10-17.md#release-and-recovery).

App 8.11.7/v705의 백그라운드 복귀 대화상자 하나만(오너 결정 2026-10-17)은 PR
[#373](https://github.com/hiefny/MUSIXQUARE/pull/373), exact-main `4d1e0011`의
[CI 38944217887](https://github.com/hiefny/MUSIXQUARE/actions/runs/38944217887),
[Release 38945082862](https://github.com/hiefny/MUSIXQUARE/actions/runs/38945082862)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 4 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
단위 테스트만 있으므로 실제 방의 백그라운드 복귀는 아래 실기기 항목에 남긴다.
[수정·검증·배포·복구](design/resume-dialog-dedup-2026-10-17.md#release-and-recovery).

App 8.11.6/v704의 재접속 때 대기 업데이트 적용(오너 결정 2026-10-16)은 PR
[#371](https://github.com/hiefny/MUSIXQUARE/pull/371), exact-main `1a2fb442`의
[CI 38933446890](https://github.com/hiefny/MUSIXQUARE/actions/runs/38933446890),
[Release 38934335022](https://github.com/hiefny/MUSIXQUARE/actions/runs/38934335022)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker, 공개 4 GET의
후보 해시 일치와 Drift 31 pass / 0 fail / 5 manual-only로 배포 준비 항목을 닫았다.
데스크톱 앱 브라우저 창의 로컬 preview 실측(첫 화면 1.2초, 초대 링크 1.4초 적용)은
실제 기기·운영 환경의 다시 열기를 대신하지 않으므로 아래 실기기 항목을 유지한다.
[수정·검증·배포·복구](design/update-apply-on-reopen-2026-10-16.md#release-and-recovery).

App 8.11.5/v702의 작은 캡션 획 손실 대응은 오너의 Windows 수정 비교판 정상 확인,
PR [#369](https://github.com/hiefny/MUSIXQUARE/pull/369), exact-main `a8b37386`의
[CI 38916351290](https://github.com/hiefny/MUSIXQUARE/actions/runs/38916351290),
[Release 38917295260](https://github.com/hiefny/MUSIXQUARE/actions/runs/38917295260)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 Worker 호환성·coherent marker, 공개 144 GET의 후보 해시 일치·16/16 검사 통과로 배포 준비 항목을 닫았다.
캡션은 글자별 소형 텍스처 대신 묶음 canvas를 사용한다. 격리 Chromium 16·Windows
WebKit 16건과 앱의 12개 caption sample에서 내부 획 누락을 찾지 않았지만,
원래 하드웨어 현상의 자동 재현이나 모든 GPU·물리 iPhone 검증을 뜻하지 않는다.
아이폰 실기 항목은 유지한다.
[수정·검증·배포·복구](design/screensaver-caption-rendering-2026-10-16.md#release-and-recovery).

App 8.11.4/v701의 화면 보호기 이미지 배경·호환 전경은 PR
[#367](https://github.com/hiefny/MUSIXQUARE/pull/367), exact-main `813a0220`의
[CI 38909124622](https://github.com/hiefny/MUSIXQUARE/actions/runs/38909124622),
[Release 38909891395](https://github.com/hiefny/MUSIXQUARE/actions/runs/38909891395)
attempt 1의 운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker와
공개 144개 자산의 exact-main 후보 해시 일치(20/20 검사)로 배포 준비 항목을 닫았다.
139개 배경 이미지는 지연 로딩되며 앱 초기 shell에 들어가지 않는다.
Windows WebKit 외형 비교는 아이폰 실기 검증을 대신하지 않아 아래 실기기 항목에 남긴다.
[수정·검증·배포·복구](design/screensaver-image-backgrounds-2026-10-16.md#release-and-recovery).

App 8.11.3/v700의 글자 굵기 최대 700(오너 결정 2026-10-16)은 PR
[#365](https://github.com/hiefny/MUSIXQUARE/pull/365), exact-main `0041d5be`의
[CI 38875238552](https://github.com/hiefny/MUSIXQUARE/actions/runs/38875238552)(의존성 설치 실패 작업만 attempt 2 재실행),
[Release 38876050306](https://github.com/hiefny/MUSIXQUARE/actions/runs/38876050306)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v700·공개 CSS·페이지의 700 초과 0건·공개 OG 이미지 해시를 확인해 배포 준비 항목을 닫았다.
Drift 31 pass / 0 fail / 5 manual-only를 확인했다.
[수정·검증·배포·복구](design/max-font-weight-700-2026-10-16.md#release-and-recovery).

App 8.11.2/v699의 제목 굵기 700 통일(오너 결정 2026-10-16)은 PR
[#363](https://github.com/hiefny/MUSIXQUARE/pull/363), exact-main `c6ccfa03`의
[CI 38866050515](https://github.com/hiefny/MUSIXQUARE/actions/runs/38866050515),
[Release 38866744699](https://github.com/hiefny/MUSIXQUARE/actions/runs/38866744699)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v699·공개 CSS의 700 단일 정의·공개 디자인 시스템 견본을 확인해 배포 준비 항목을 닫았다.
Drift 31 pass / 0 fail / 5 manual-only를 확인했다.
[수정·검증·배포·복구](design/display-weight-700-2026-10-16.md#release-and-recovery).

App 8.11.1/v698 화면 보호기 후속은 PR [#361](https://github.com/hiefny/MUSIXQUARE/pull/361),
exact-main `cedc0b04`의 [CI 38835888083](https://github.com/hiefny/MUSIXQUARE/actions/runs/38835888083),
[Release 38836510116](https://github.com/hiefny/MUSIXQUARE/actions/runs/38836510116)의 운영 smoke·최종 소유권·
미선택 5 Worker 호환성·coherent marker 및 공개 운영 근거로 배포 준비 항목을 닫았다.
Drift 31 pass / 0 fail / 5 manual-only를 확인했다.
컴포넌트와 공급자·실기 검증 한계는 유지한다.
[배포·복구 근거](design/screensaver-integration-2026-10-16.md#follow-up-release-and-recovery).

App 8.11.0/v696 화면 보호기는 PR [#360](https://github.com/hiefny/MUSIXQUARE/pull/360),
exact-main `49347201`의 [CI 38829164350](https://github.com/hiefny/MUSIXQUARE/actions/runs/38829164350),
[Release 38829782253](https://github.com/hiefny/MUSIXQUARE/actions/runs/38829782253)의
운영 smoke 4종·최종 소유권·미선택 5 Worker 호환성·coherent marker와 공개 자산의
candidate 해시 일치로 초기 배포 준비 항목을 닫았다. 운영 자산의 격리된 같은 출처
컴포넌트 7 checks·160/320/1280/1920px 시각 확인과 Drift 31 pass / 0 fail / 5 manual-only를
확인했다. 실제 방·live 날씨·실기 검증을 뜻하지 않으며 후속 제어·전환·전체 화면 조정의 배포 근거는 별도로 기록했다.
[배포·복구 근거](design/screensaver-integration-2026-10-16.md#release-and-recovery).

App 8.10.27/v693의 데스크톱 동기화·미디어 버튼 너비 수정(오너 결정 2026-10-16)은
PR [#358](https://github.com/hiefny/MUSIXQUARE/pull/358), exact-main `0d08447c`의
[CI 38814552948](https://github.com/hiefny/MUSIXQUARE/actions/runs/38814552948),
[Release 38815146392](https://github.com/hiefny/MUSIXQUARE/actions/runs/38815146392)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v693·운영 Standard 방의 1280/1360/1440px 버튼 160×56px 실측으로 배포 준비
항목을 닫았다. 1280px 운영 캡처를 시각 확인했으며 실기기·운영 공유 캡처 검증을
대신하지 않는다.
[수정·검증·배포·복구](design/desktop-action-width-2026-10-16.md#release-and-recovery).

App 8.10.26/v692의 PRO 첫 미디어 안내(오너 결정 2026-10-16)는 PR
[#356](https://github.com/hiefny/MUSIXQUARE/pull/356), exact-main `476e42b1`의
[CI 38805172538](https://github.com/hiefny/MUSIXQUARE/actions/runs/38805172538),
[Release 38806931867](https://github.com/hiefny/MUSIXQUARE/actions/runs/38806931867)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v692·공개 번들의 PRO 본문 키를 확인해 배포 준비 항목을 닫았다.
[수정·검증·배포·복구](design/keep-open-pro-2026-10-16.md#release-and-recovery).

App 8.10.25/v691의 방장 기기 상태 안내(오너 결정 2026-10-16)는 PR
[#354](https://github.com/hiefny/MUSIXQUARE/pull/354), exact-main `45850f44`의
[CI 38797375114](https://github.com/hiefny/MUSIXQUARE/actions/runs/38797375114),
[Release 38799143891](https://github.com/hiefny/MUSIXQUARE/actions/runs/38799143891)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v691·공개 청크의 새 코드를 확인해 배포 준비 항목을 닫았다. 선행
[Release 38798391865](https://github.com/hiefny/MUSIXQUARE/actions/runs/38798391865)는 Standard HTTPS signaling smoke의 일시적
503으로 이전 App version에 자동 복구됐다. 실기기 확인은 §2 실기기 항목에 남는다.
[수정·검증·배포·복구](design/host-presence-keep-open-2026-10-16.md#release-and-recovery).

App 8.10.24/v690의 사용하지 않는 토스트 키 정리(오너 결정 2026-10-15)는 PR
[#352](https://github.com/hiefny/MUSIXQUARE/pull/352), exact-main `31c3b19c`의
[CI 38726918203](https://github.com/hiefny/MUSIXQUARE/actions/runs/38726918203),
[Release 38727700806](https://github.com/hiefny/MUSIXQUARE/actions/runs/38727700806)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v690·영어 번들에서 지운 키가 사라진 것을 확인해 배포 준비 항목을 닫았다.
[수정·검증·배포·복구](design/unused-toast-keys-2026-10-15.md#release-and-recovery).

App 8.10.23/v689의 토스트 전체 표시·장황한 번역 다듬기(오너 결정 2026-10-15)는 PR
[#350](https://github.com/hiefny/MUSIXQUARE/pull/350), exact-main `5903ed41`의
[CI 38715121084](https://github.com/hiefny/MUSIXQUARE/actions/runs/38715121084),
[Release 38715714880](https://github.com/hiefny/MUSIXQUARE/actions/runs/38715714880)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v689·운영 토스트 함수의 전체 표시와 표시 시간 확인으로 배포 준비 항목을 닫았다.
실기 확인은 하지 않았다.
[수정·검증·배포·복구](design/toast-line-length-2026-10-15.md#release-and-recovery).

App 8.10.22/v688의 토스트 마침표 정책(오너 결정 2026-10-15)은 PR
[#348](https://github.com/hiefny/MUSIXQUARE/pull/348), exact-main `2e05b070`의
[CI 38701042285](https://github.com/hiefny/MUSIXQUARE/actions/runs/38701042285),
[Release 38701766660](https://github.com/hiefny/MUSIXQUARE/actions/runs/38701766660)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v688·번들 문구·토스트 렌더링 확인으로 배포 준비 항목을 닫았다. 운영에서 실제 사용
흐름으로 토스트를 띄우지는 않았고 실기 확인도 하지 않았다.
[수정·검증·배포·복구](design/toast-punctuation-policy-2026-10-15.md#release-and-recovery).

App 8.10.21/v687의 업데이트 안내 줄바꿈(오너 결정 2026-10-15)은 PR
[#346](https://github.com/hiefny/MUSIXQUARE/pull/346), exact-main `a1d52c99`의
[CI 38692452260](https://github.com/hiefny/MUSIXQUARE/actions/runs/38692452260),
[Release 38693244484](https://github.com/hiefny/MUSIXQUARE/actions/runs/38693244484)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v687·영어 번들 문구 확인으로 배포 준비 항목을 닫았다. 실기 렌더링은 확인하지
않았다.
[수정·검증·배포·복구](design/update-notice-line-breaks-2026-10-15.md#release-and-recovery).

App 8.10.20/v686의 PRO 재생목록 순서 변경 깜빡임 수정(오너 제보 2026-10-14)은 PR
[#344](https://github.com/hiefny/MUSIXQUARE/pull/344), exact-main `27dceedc`의
[CI 38593021162](https://github.com/hiefny/MUSIXQUARE/actions/runs/38593021162),
[Release 38593965412](https://github.com/hiefny/MUSIXQUARE/actions/runs/38593965412)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v686 확인으로 배포 준비 항목을 닫았다. 운영 PRO 방에서 순서 변경을 재현한 것은
아니며 실기 확인은 실기기 항목에 남긴다.
[수정·검증·배포·복구](design/pro-playlist-reorder-optimistic-2026-10-14.md#release-and-recovery).

App 8.10.19/v685의 무음 기기 재생 버튼 수정(오너 결정 2026-10-14)은 PR
[#342](https://github.com/hiefny/MUSIXQUARE/pull/342), exact-main `6afd9187`의
[CI 38579109391](https://github.com/hiefny/MUSIXQUARE/actions/runs/38579109391),
[Release 38580171440](https://github.com/hiefny/MUSIXQUARE/actions/runs/38580171440)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v685 확인으로 배포 준비 항목을 닫았다. 재생 중인 방에서 무음 기기 버튼과 로딩
스피너를 운영에서 재현한 것은 아니며 실기 확인은 실기기 항목에 남긴다.
[수정·검증·배포·복구](design/pro-silent-endpoint-transport-2026-10-14.md#release-and-recovery).

App 8.10.18/v684의 YouTube 재합류 동기화는 PR
[#339](https://github.com/hiefny/MUSIXQUARE/pull/339), exact-main `cb81a89c`의
[CI 38565478458](https://github.com/hiefny/MUSIXQUARE/actions/runs/38565478458),
[Release 38566206816](https://github.com/hiefny/MUSIXQUARE/actions/runs/38566206816)의
운영 smoke 4종·최종 배포 소유권·미선택 5 Worker 호환성·coherent marker와 공개
v684 확인으로 배포 준비 항목을 닫았다. 배포 후 같은 방법의 운영 측정에서 PRO
중도참여·동기화·포그라운드 복귀가 release 순간 seek 없이 −62~−84ms로 시작했고
(배포 전 무음, −1062ms, −149·−343ms), 일반방 중도참여는 −5~−12ms였다(배포 전
−386·−877ms). 내장 Chromium 한 대의 측정이며 실기·실제 스피커 확인은 실기기
항목에 남긴다.
[측정·배포·복구](design/youtube-rejoin-sync-2026-10-14.md#release-and-recovery).

App 8.10.17/v683의 공유 모션 실패 후속과 간격 중복은 PR
[#337](https://github.com/hiefny/MUSIXQUARE/pull/337), exact-main `75fceac1`의
[CI 38549772729](https://github.com/hiefny/MUSIXQUARE/actions/runs/38549772729),
[Release 38550430599](https://github.com/hiefny/MUSIXQUARE/actions/runs/38550430599)의
운영 smoke 4종·App 100% 최종 소유권·미선택 5 Worker 호환성·coherent marker,
공개 v683/CSS 및 기존 홈 탭의 정상 업데이트 적용 확인으로 닫았다. Standard/PRO의
factory·update 예외 단위 회귀와 실제 앱의 합성 캡처 Chromium 검사를 포함한다.
운영 PRO SFU·실제 OS picker·모든 PWA를 검증한 것은 아니다.
[수정·검증·복구 근거](design/sharing-action-fallback-2026-10-14.md#release-and-recovery).

2026-10-14 오너가 8.10.16/v682 적용 후 iOS 17.6.1 설치 PWA의 기존 화면 밀림이
사라졌고, 추가 확인한 목록 스크롤·볼륨 드래그·재생목록 재정렬도 정상이라고
직접 보고하여 해당 실기 확인 항목을 닫았다. 자동화 결과로 대체한 판정이 아니며
다른 OS·모든 권한 조합·열려 있던 모든 PWA의 갱신까지 검증한 것은 아니다.
[실기 보고·범위](design/shared-touch-policy-2026-10-14.md#owner-verification--2026-10-14).

App 8.10.15/v681의 입장 대기·장황 버튼 라벨 축약은 PR [#330](https://github.com/hiefny/MUSIXQUARE/pull/330),
exact-main `19f1d27b`의 [CI 38518466482](https://github.com/hiefny/MUSIXQUARE/actions/runs/38518466482),
[Release 38518475226](https://github.com/hiefny/MUSIXQUARE/actions/runs/38518475226)의 운영 smoke 4종·App 100%
최종 소유권·미선택 5 Worker 호환성·coherent marker 및 공개 v681 확인으로 배포를 기록했다.
열린 항목을 닫는 변경은 아니며 원어민 검수·실기 화면 확인은 하지 않았다.
[범위·검증·배포·복구](design/short-wait-labels-2026-10-14.md#release-and-recovery).

App 8.10.14/v680의 공유 송신자 버튼 준비는 PR
[#331](https://github.com/hiefny/MUSIXQUARE/pull/331), exact-main
`75842130`의 [CI 38515483411](https://github.com/hiefny/MUSIXQUARE/actions/runs/38515483411),
[Release 38517124902](https://github.com/hiefny/MUSIXQUARE/actions/runs/38517124902)의 운영 smoke
4종·App 100% 최종 소유권·미선택 5 Worker 호환성·coherent marker 및 공개 v680
확인으로 닫았다. 실제 OS picker·실음향·Safari 실기·운영 PRO SFU를 검증했다는
뜻은 아니다. [수정·검증·배포·복구](design/system-audio-sharing-actions-2026-10-14.md#release-and-recovery).

8.10.12의 초기 전송 예산 잔여 66 B 항목은 초기 로딩 정책의 측정 검토와
8.10.14 정식 배포로 닫았다. legacy layer 변환은 공통 CSS를 함께 처리해야 하므로
CSS 분할 실험은 채택하지 않았고, 컨트롤러만 방 진입에 맞춰 지연 로드한다.
aggregate 상한 3종에 5% 유지 공간을 추가하되 보호 여유 5%·entry 상한·eager font
0은 유지했다. eager gzip 544,507 B는 새 유지 상한 570,570 B보다 26,063 B 작다.
동일 조건 5쌍의 cold-start 표본에서 회귀 근거는 없었으나 통계적 동등성 또는
남은 예산의 자유로운 소진을 보장하지 않는다.
[용량 결정](design/initial-bundle-loading-policy.md#2026-10-14-sender-actions-and-aggregate-maintenance-capacity),
[실측·검증 근거](design/system-audio-sharing-actions-2026-10-14.md).

App·Worker 8.10.12/v678의 점검 안내 번역 후속과 숨은 YouTube 패널 접근성 항목은 PR
[#328](https://github.com/hiefny/MUSIXQUARE/pull/328), exact-main `d9364cd9`의
[CI 38508327514](https://github.com/hiefny/MUSIXQUARE/actions/runs/38508327514),
[Release 38508866905](https://github.com/hiefny/MUSIXQUARE/actions/runs/38508866905)의 운영 smoke·최종 소유권
6종·coherent marker 및 공개 v678 갱신 확인으로 닫았다. 새 프로토콜·데이터 마이그레이션은
없다. [수정·검증·배포·복구](design/maintenance-copy-and-a11y-release-2026-10-14.md#release-and-recovery).

2026-10-14 오너 결정으로 열린 항목을 정리했다. 결정이 끝난 동작·전환기 한계·조건부
감시·문체 결정은 [허용한 위험 #14~#17](known-accepted.md#14-standard-room-youtube-zero-start-sync-readiness-gap)로,
재현 계획이 없는 관찰 6건은 [종료한 관찰](known-accepted.md#retired-observations)로
옮겼다. Drift Audit 수동 5항목과 일반방 방장 암호 감시는 §3 정기 수동 점검으로
바꿨다. 외부 보안 업체 점검으로 이미 해결된 보안 재실행 항목은 삭제했고, 그 접근
프로그램 이름은 재점검 작업을 막는 장벽이 되어 문서 전체에서 제거했다.

App 8.10.10/v673 배포 대기는 PR [#323](https://github.com/hiefny/MUSIXQUARE/pull/323),
exact-main `414ce19d`의 [CI 38444452325](https://github.com/hiefny/MUSIXQUARE/actions/runs/38444452325),
[Release 38445343194](https://github.com/hiefny/MUSIXQUARE/actions/runs/38445343194)의
운영 smoke 4종·최종 소유권·coherent marker 및 공개 v673 갱신 확인으로 닫았다.
일반방의 완결 목록 확보·부분 캐시 복구와 PRO 재입장 manifest 보존, 관리자 iframe
재개·직접 탐색·프로그램 seek 소유권을 수정했다. 새 프로토콜·데이터 마이그레이션은
없다. 실제 자연 반복 원인과 공급자·실기 한계는 위 열린 항목에 유지한다.
[수정·검증·배포·복구](design/youtube-playlist-native-control-repair-2026-10-14.md).

App 8.10.9/v671 준비는 PR #321, exact-main `16c6b219`의 CI 38425972188 및
Release 38427573214의 운영 smoke 4종·최종 소유권·coherent marker 확인으로
닫았다. 선행 Release 38426762796의 오래된 status 응답·자동 rollback과 독립
복구도 같은 보고서와 릴리스 이력에 보존한다. 조회의 세부 원인은 미정이고
소유권 안전 검사는 유지했다. 최초 로컬 seed 470021 실패와 실기기 확인은
해결한 것으로 처리하지 않는다.
[구현·검증·실패·배포·복구](design/component-cascade-refactor-2026-10-13.md).

YouTube 최초 focus 검사와 후반 Tab 실패 항목은 PR #319, exact-main `dc69bda0`의
CI 38364448487 및 Release 38365146388 성공으로 닫았다. 진입 검사는 준비 상태와
실제 Tab 이동을 확인하도록 바꿨고, 자연 실패 세 건의 timer-fire·focus stack·키
이벤트로 확인한 100ms 초기 focus 경합은 `594fbc5d`에서 수정했다. 타이머 경계의
단위 RED→GREEN, 로컬·원격 전체 Chromium 627 pass와 WebKit 결과를 확보했다.
두 OS 반복 60회는 모두 100ms 전 닫힌 정상 흐름 검증이라는 한계를 유지한다.
[원인·수정·검증·배포 근거](design/youtube-popup-focus-repair-2026-10-13.md).

8.10.7 YouTube 입력 안내 배포 준비는 PR #316, exact-main `6b159667`의 CI
38336374232와 Release 38336912131 성공으로 닫았다. 42개 언어의 URL 힌트·아래
링크/검색어 안내·입력 삭제 뒤 복원을 수정하고 공개 6언어 응답을 확인했다.
변경 전 Full E2E에서 발견한 최초 키보드 focus 실패는 위 8.10.8 근거로 후속 해결했다.
[검증·배포·복구 근거](design/youtube-input-guidance-2026-10-13.md).

8.10.6 App-only 후속 수정은 PR #314, exact-main `f0ea308b`의 CI 38319346829와
Release 38319913652 성공으로 닫았다. `/clear` 서비스 공지 유실, 닫기 영역 겹침,
자동 갱신 초안 유실, legacy 입력 정규화 불일치를 재현·수정하고 실행 JS의
App/cache 식별도 레코더에 추가했다. 관리자 초안은 자동 갱신에서 보존되지만 null
revision 저장은 계속 차단하고, 수동 Refresh는 확인 후 폐기·서버 원본 재조회한다.
기존 "첫 조회 실패 후 초안 유실 해결" 기록은 이 경계까지 보장한 것이 아니었다.
신규 의존성·스키마·바인딩·비밀 없음. 실기기 확인은 아래에 유지한다.
[후속 수정·검증·복구 범위](design/announcement-review-followup-2026-10-13.md).

PRO 정원 판정의 TTL 경계, 취소된 최초 요청에 묶인 공유 registry 조회 수명,
휴면 세션·계정 detach에 따른 Peer 101 이상 생성과 클라이언트 응답 거부의 세
확정 결함은 PR [#311](https://github.com/hiefny/MUSIXQUARE/pull/311)의 재현·회귀,
exact-main `08df0606` CI와 6종 Worker의 Release 38313333407 성공으로 닫았다.
공통 점검·공지 조회의 실제 context 전달과 늦은 응답·만료 TTL 경계도 함께 수정했다.
정원 100·presence TTL 45초·권한·엄격한 클라이언트 계약은 유지한다.
[수정·검증·배포·복구 근거](design/pro-admission-repair-2026-10-13.md).
행사 원인의 확정과 진단 로그의 한계는 아래에 남긴다.

공지의 네 배포 대기 항목은 PR #309의 재현·회귀, exact-main CI, App·PRO를 포함한
Release 38293505122 성공으로 닫았다. 관리자 초기 초안의 미관측 revision 채택과
첫 조회 실패 후 초안 유실도 리뷰에서 재현·수정했다.
[해결 근거](design/announcement-repair-2026-10-13.md#프로덕션-배포--2026-10-13).
PRO 방장 공지의 중도 참여 복원은 별도 정책이며 이번 서비스 공지 수정에 포함하지 않았다.

### 실기기 확인

사용자의 실제 기기가 필요하다. 브라우저 자동화 결과로 대신하지 않는다.

- [ ] 일반방 전송 통합(8.11.23 이후): 폰 두 대(Android·iPhone)와 PC로 로컬 파일 재생 중 다음 곡
      프리로드, YouTube 재생 중 프리로드, 프리로드 중 일시정지 반응, 같은 주소의 짧은 와이파이
      끊김(회복해야 정상)을 확인하고, 보조 연결이 하나 더 생기는 데 따른 배터리·발열도 본다.
      데스크톱 Chromium native 라운드만 있다.
      [남은 실기 확인](design/transport-release-bundle-2026-10-19.md#남은-실기-확인)
- [ ] 8.11.25 보조 연결 ICE restart: 호스트 노트북은 와이파이에 두고, 같은 와이파이의 폰이 직접
      파일을 받은 뒤 와이파이→LTE로 바꾼다. 8.11.23에서는 연결 끊김 창이 떴다(오너 확인
      2026-10-19). 8.11.25에서 창·재접속 없이 재생과 조작이 이어지고, `?mxqrLog=info`로 연
      게스트의 `/debug console`에 `Restarting isolated control ICE` 다음
      `Isolated control ICE recovered`가 보이면 허용 위험 #18을 닫는다. 같은 공유기의 다른 SSID로
      옮기는 IP 변경과, 원격(LTE) 게스트가 와이파이로 오는 반대 방향(이미 복구됨)도 회귀로 본다.
      [독립 검증](design/side-ice-restart-independent-verification-2026-10-20.md)
- [ ] 8.11.25 미리받기 재개: 호스트 노트북은 와이파이에 두고, 폰이 다음 곡을 미리받는 중(다음 곡
      준비 로더가 보일 때)에 와이파이를 몇 초 껐다 켜거나 LTE로 바꾼다. 8.11.23에서는 미리받기가
      취소된 뒤 다시 시작하지 않았다(오너 확인 2026-10-19). 8.11.25에서 연결이 돌아오면 미리받기가
      이어서 끝나고, 다음 곡으로 넘어갈 때 다시 받지 않고 바로 재생되면 닫는다. `?mxqrLog=info`로
      연 호스트의 `/debug console`에 끊긴 동안 `Paused preload`, 복구 뒤 `Resuming preload`가 보인다.
      [native 근거](design/preload-resume-after-ice-recovery-2026-10-20.md)
- [ ] 8.11.25 공유 중지 버튼 정렬: 시스템 오디오 공유를 켤 수 있는 기기(PC 브라우저·데스크톱 앱)에서
      공유를 켜고, "공유 중지" 버튼의 정지 사각형과 글자가 버튼 가운데에 보이는지(오른쪽 치우침 없음),
      사각형 크기와 글자 간격이 전과 같은지 다크·라이트에서 본다. 헤드리스 Chromium 측정과 브라우저
      테스트만 있다. [근거](design/stop-sharing-centering-2026-10-20.md)
- [ ] 8.11.18/v720 시작 화면 버튼 전환: iPhone Safari·홈 화면 PWA, Android Chrome, Windows·macOS
      데스크톱에서 첫 화면 → 방 만들기·방 참여하기와 뒤로 가기 때 가운데 덩어리가 튀지 않고 제자리에서
      크로스페이드되는지, 버튼도 함께 서서히 바뀌는지, 방 참여하기의 시작하기 버튼이 전과 같이 동작하는지
      확인한다. 헤드리스 Chromium 프레임 캡처와 단위·브라우저 테스트만 있다.
      [범위·한계](design/setup-actions-transition-2026-10-18.md#verification)
- [ ] 8.11.17/v719 시작 화면 캐러셀 간격: iPhone Safari·홈 화면 PWA, Android Chrome(세로·가로),
      태블릿, Windows·macOS 데스크톱에서 첫 화면 캐러셀의 아이콘 원→제목, 제목→본문, 본문→점 간격이
      휴대폰 28·20·36px과 같은 비율로 보이는지, 다크 테마의 아이콘 원이 라이트처럼 은은한지,
      슬라이드를 넘겨도 점 위치가 흔들리지 않는지, 첫 화면 가운데 덩어리가 계속 머리글과 버튼 사이
      가운데에 오는지 확인한다. 헤드리스 Chromium 측정과 브라우저 테스트만 있다.
      [범위·한계](design/setup-carousel-spacing-2026-10-18.md#verification)
- [ ] 8.11.15–8.11.16(v717–v718) 휴대폰 세로 시작 화면 가운데 정렬: iPhone Safari·홈 화면 PWA와
      Android Chrome에서 첫 화면, 방 만들기, 방 참여하기의 가운데 덩어리가 보기에 머리글과 버튼 사이
      가운데에 오는지(8.11.16부터 QR 여백·스캔 버튼 안쪽·글자 행간까지 맞춤), 머리글 위와 버튼 아래
      여백이 전과 같은지, 작은 화면에서 전처럼 스크롤되는지, 방 참여하기에서 키보드를 열고 닫을 때
      코드 입력칸이 가려지지 않는지 확인한다. 헤드리스 Chromium 측정과 브라우저 테스트만 있다.
      [범위·한계](design/setup-mobile-centering-2026-10-18.md#verification),
      [보이는 기준 보정](design/setup-mobile-visible-centering-2026-10-18.md#verification)
- [ ] 8.11.13/v714 방 만들기 QR: iPhone Safari·홈 화면 PWA, Android Chrome, Windows·macOS
      데스크톱 브라우저에서 앱을 처음 열고 방 만들기를 누를 때 캐러셀 자리가 검게 비지 않고
      흐린 QR로 바로 넘어가는지, 코드가 뜰 때 진짜 QR이 한 번만 부드럽게 나타나는지, 데스크톱에서
      가운데 스피너가 처음부터 다시 돌지 않는지, 방 참여하기도 검게 비지 않는지 확인한다. 코드가
      0.3초 안에 오면 첫 전환이 끊기는 점프는 남아 있다. 헤드리스 Chromium 프레임 확인과
      단위·브라우저 테스트만 있다.
      [범위·한계](design/setup-qr-reveal-2026-10-17.md#verification)
- [ ] 8.11.11 업데이트 대화상자(기기가 `v711` 코드를 실행한 뒤 다음 업데이트가 와야 볼 수 있다):
      iPhone Safari 탭, iPhone 홈 화면 PWA, Android Chrome(탭과 설치 앱), Windows·macOS
      데스크톱에서 첫 화면, 만들기·참여 화면, 초대 링크의 시작 화면, 일반방 방장·참여자, PRO 방,
      데모 중에 같은 "업데이트" 대화상자가 뜨는지, 문구가 방 밖은 "적용하면 페이지를
      새로고침해요", 일반방 방장은 "방을 다시 열어야 해요", 그 밖의 방 참여자는 "방에 다시
      입장해야 해요"인지 확인한다. "나중에" 뒤 같은 페이지에서는 다시 뜨지 않고 다시 열면 다시
      뜨는지, 참여자가 "적용하기"를 누르면 그 방의 시작 화면으로 돌아가 "시작하기"로 다시
      들어가는지, 다른 탭이 적용하면 방에 있는 탭은 새로고침되지 않고 대화상자를 한 번 띄우는지,
      PRO 방에서 휴대폰을 45초 넘게 잠갔다가 깨워도 새로고침되지 않는지, 채팅·토스트 업데이트
      안내가 더는 뜨지 않는지도 본다. iPhone 홈 화면 앱이 다시 열 때 이전 화면을 이어 쓰면
      다음 실제 실행까지 이전 코드가 남을 수 있다. 단위 테스트와 로컬 데스크톱 Chromium 확인만
      있다.
      [범위·한계](design/update-dialog-everywhere-2026-10-17.md#verification)
- [ ] 8.11.12/v712 R 뒤로가기(8.11.9 창 정책 후속): Android Chrome·설치 앱의 뒤로 버튼·제스처와 iPhone Safari/PWA 뒤로
      스와이프에서 방 밖(언어 선택)과 방 안(미디어 선택, YouTube 링크, 데모, 화면 보호기,
      채팅 시트, 확인창)의 맨 위 창만 닫히는지, 창이 없을 때만 "세션 나가기"가 뜨거나 이전
      페이지로 가는지, "오디오가 잠시 멈췄어요"는 뒤로가기로 닫히지 않는지 확인한다.
      2026-10-17 오너의 별도 iPhone 진단에서 즉시 재등록 I는 약 3초 지연,
      R은 단계별 Back 정상으로 확인되어 공통 R 적용·배포를 승인했고 PR #383과
      Release 39009031876으로 배포했다. 이 진단과 데스크톱 검사는 제품 실기 확인을
      대신하지 않는다. 제품의 초기 입장·닫기 완료 후
      재등록·연속 Back·실제 이전 문서 퇴장은 별도 검증한다.
      [R 구현·검증·한계](design/ios-back-deferred-guard-2026-10-17.md),
      [기존 창 정책](design/back-closes-top-window-2026-10-17.md#verification)
- [ ] 8.11.7 백그라운드 복귀 대화상자: iPhone Safari/PWA와 Android에서 방(로컬 파일
      재생 중)을 1분 넘게 백그라운드에 두었다가 돌아오면 대화상자가 하나만 뜨는지,
      경고를 닫지 않은 채 다시 1분 넘게 나갔다 오면 경고가 다시 뜨지 않는지, 소리가
      복구되지 않을 때는 "오디오가 잠시 멈췄어요" 하나만 뜨고 "오디오 다시 켜기"로
      소리가 돌아오는지 확인한다. 단위 테스트만 있다.
      [범위·한계](design/resume-dialog-dedup-2026-10-17.md)
- [ ] 8.11.4 화면 보호기: 실제 iPhone Safari/PWA에서 글로우·디렉셔널 블러·숫자
      전환과 가로·세로 회전, 진입·종료·전체화면 복원, 재생 유지·장시간 메모리 추세를
      확인한다. Windows WebKit 7개 외형 비교와 합성 lifecycle 검사는 실기 검증이 아니다.
      [범위·한계](design/screensaver-image-backgrounds-2026-10-16.md#verification)

- [ ] 8.10.4 공지: 새 클라이언트가 적용된 운영 일반방·PRO에서 게시 후 철회와 5분/
      foreground 반영, 실제 iPhone Safari/PWA·VoiceOver 및 Android/TalkBack의 전체보기/
      짧은 화면 스크롤·닫기. 이번에는 운영 공지를 재게시하지 않았고 기존 설치 PWA는
      새로고침 전 구 코드가 남을 수 있다. [증거·한계](design/announcement-repair-2026-10-13.md)
      8.10.6 적용 후 호스트 `/clear`에도 서비스 공지가 남는지 함께 확인한다.
      [후속 회귀·실기기 한계](design/announcement-review-followup-2026-10-13.md)

- [ ] 8.7.9 헤더 크로스페이드: iPhone Safari/PWA에서 로딩 시작·종료, 시크 직후
      탭 왕복. [상세](design/header-crossfade-2026-10-09.md)
- [ ] 8.10.25 방장 기기 상태 안내: 일반 방 방장을 iPhone Safari/PWA·Android에서
      백그라운드로 보내거나 화면을 잠갔을 때 게스트 로더가 뜨고 복귀하면 풀리는지,
      관리자 재생이 거절 토스트로 끝나는지, 좁은 화면에서 계정 필 앞 말줄임.
      브라우저에서 숨김·정지를 흉내 낸 결과만 있다.
      [범위·한계](design/host-presence-keep-open-2026-10-16.md)
- [ ] 8.8.0: 실제 고객방의 소유권·암호 지정·변경·해제, 기존 열린 탭·설치 PWA의
      새 코드 적용. [상세](design/pro-optional-entry-password-2026-10-10.md)
- [ ] 혼합 방(iPhone Safari/PWA + Android + Windows): 작은 곡 → 큰 MP3/FLAC/AAC
      → 작은 곡, host와 guest가 서로 다른 엔진을 쓰는 경우.
- [ ] 장시간 세션: 시작, 빠른 시크, 이전/다음, 곡 끝 반복, 중간 참가, 프리로드
      재정렬, 큰 수동 싱크, 네트워크 끊김·재참가, 잠금·복귀, 메모리 추세.
- [ ] 시크 직후 약 2.3초 native PCM 차이(자동 회복). PLAY 수신 시 clock·anchor,
      실제 오디오 시작, 회복 시간을 기록한다. 브라우저의 2.5초 수렴 허용치는 귀로
      듣는 정렬 기준이 아니다. [상세](design/beta-final-qa-2026-10-04.md)
- [ ] YouTube 첫 음 정렬(S01–S02, XS01–XS04): 일반·PRO, host·guest, 양·음 offset,
      다음 곡·반복·중간 참가·취소, 실제 YouTube, iPhone Safari/PWA, Bluetooth.
      [S01–S02](design/youtube-manual-zero-start-audit-2026-09-27.md#repair-addendum--2026-09-27),
      [XS01–XS04](design/extreme-manual-sync-repair-2026-09-27.md)
- [ ] YouTube 재합류 동기화(8.10.18 배포 뒤): iPhone Safari/PWA와 Android에서 PRO
      동기화 버튼·중도참여·잠금 복귀가 release 순간 seek 없이 시작하는지
      (`/debug sync`의 youtube-release·youtube-sample), 한 번도 재생하지 않은
      iPhone에 TAP TO PLAY가 뜨고 탭 뒤 준비되는지, 일반방 자동 재랑데부가 과하게
      반복되지 않는지와 실제 스피커의 가청 싱크를 확인한다.
      [상세](design/youtube-rejoin-sync-2026-10-14.md)
      8.10.19 배포 뒤에는 복원·재합류 중 재생 버튼 스피너와, 소리가 안 나는 기기의
      재생 버튼이 방을 멈추지 않고 그 기기만 다시 붙이는지도 함께 본다.
      [버튼 수정](design/pro-silent-endpoint-transport-2026-10-14.md)
- [ ] PRO 재생목록 순서 변경(8.10.20 배포 뒤): iPhone·Android 터치와 데스크톱
      마우스로 곡을 옮겼을 때 이전 순서로 깜빡이지 않고 새 순서가 유지되는지, 다른
      기기에도 같은 순서로 보이는지 확인한다.
      [상세](design/pro-playlist-reorder-optimistic-2026-10-14.md)
- [ ] D01 PRO 공유 중 참가: 실제 SFU와 실기.
- [ ] 계정: 기존 로그인 유지, 다른 탭의 새 로그인과 늦게 도착한 로그아웃·탈퇴
      응답, 익명·로그인 입장, 계정 API. 실제 Google OAuth와 운영 HTTPS 쿠키로 확인한다.
- [ ] 리버브 10초 경계(일반방, PRO, API)와 데모 종료 뒤 표시되는 설정이 실제
      효과와 같은지.
- [ ] 물리 키보드, 미디어 키, 실제 음향 출력(QA055 음향 테스트 포함).
- [ ] PRO 암호 참여자 선택·퇴장 사유(8.9.0, 두 단계 대화상자는 8.9.4로 배포):
      iPhone Safari/PWA와 Android에서 암호 지정·변경의 두 단계(암호 입력 뒤 "다음",
      "현재 참여자를 어떻게 할까요?"의 "그대로 두기"(기본)·"모두 재입장", "이전"으로
      돌아가도 입력한 암호 유지, 두 번 탭해도 바로 확인되지 않음), 소프트 키보드가
      열린 1단계와 가로 모드 2단계에서 버튼이 보이는지, "다음"을 눌러도 제목이 제자리에
      있는지, VoiceOver·TalkBack으로 행을 터치하면 행 전체가 선택 대상으로 잡히고
      라벨·설명을 한 번씩 읽는지, 강퇴·기기 연결 끊기·암호 변경 안내 문구, 안내 뒤 홈
      이동과 같은 탭에서 다시 열었을 때의 일반 입장, 320·360·390px과 가로 모드(중국어
      줄바꿈 포함), RTL 배치를 확인한다.
      [상세](design/pro-pin-member-choice-2026-10-11.md),
      [두 단계](design/pro-pin-two-step-2026-10-11.md)
- [ ] 일반방 방장 암호와 공통 암호 흐름(8.10.0 배포 뒤): iPhone Safari/PWA, Android,
      Windows에서 두 방 종류 모두 1단계 버튼이 혼자일 때 "확인", 다른 기기가 있을 때
      "다음"인지, 2단계 "그대로 두기"(기본)·"모두 재입장", 일반방 암호가 빈 칸에서
      시작하고 "••••-••••"와 연필 버튼으로만 보이는지, VoiceOver·TalkBack이 점 대신
      "암호 적용됨"을 읽는지 확인한다. "그대로 두기"로 남은 참여자가 백그라운드 전환,
      네트워크 변경, 시그널링 재연결 뒤 새 암호 없이 ICE 재시작으로 회복되는지,
      "모두 재입장" 뒤 참여자에게 "방장이 방 암호를 …" 안내가 한 번 뜨고 같은 방의 암호
      입력 화면으로 가는지, 아직 갱신되지 않은 이전 App 참여자가 "강제퇴장" 문구를 보는지,
      오답 20회 뒤 기다릴 시간이 분 단위로 보이는지, 강제 색상 모드(Windows 고대비 밝은·어두운
      테마)에서 언어 목록과 선택된 행의 글자, 선택된 탭 아이콘, 켜진 암호 스위치가 보이고
      초대 QR이 휴대폰 카메라로 스캔되는지, 320·360·390px, 가로 모드, RTL 배치를 함께 본다.
      [상세](design/standard-room-owner-pin-2026-10-11.md)

### 운영·보안

- [ ] PRO 공개방 입장 보호(8.9.0 배포 뒤): 실제 공개방에서
      일반 입장·재입장·탭 닫기 후 복귀가 `RATE_LIMITED`나 `ROOM_FULL` 없이 되는지,
      PRO Worker 로그에서 두 응답이 평소보다 늘지 않는지 확인한다. 입장 throttle
      카운터는 Durable Object 메모리에만 있어 운영에서 직접 볼 수 없고, 주소별 키
      파생(IPv4, IPv6 /64)은 front door 단위 테스트로만 검증했다.
      [상세](design/pro-room-admission-protection-2026-10-11.md)
- [ ] Standard HTTPS signaling 브리지 열기의 일시 5xx: 2026-10-16 8.10.25 배포에서 503 한 번, 2026-10-20 8.11.28
      배포에서 502 두 번(방장·게스트 열기) smoke가 실패했고, 자동 복구나 재시도 뒤 통과했다. 원인은 미확정이다.
      8.11.29(2026-10-20 15:38 KST 배포)부터 smoke 실패 줄에 역할·HTTP 상태·오류 코드·경과 ms·Ray ID가, App Worker
      로그에 `standard_signaling_bridge` 진단(operation·reason·브리지 객체 코드·시간)이 남는다. 통과한 smoke는 브리지
      열기 시간(`bridgeOpenMs`)을 남기며 첫 배포에서 방장 878ms·게스트 393ms였다. 다음 실패 때 둘을 Ray ID로 맞춰
      어느 Worker의 어떤 실패인지 좁힌다. 5초 제한과 smoke 재시도 변경은 오너가 정한다.
      [진단·읽는 법](design/standard-signaling-bridge-diagnostics-2026-10-20.md)

### 후속 작업과 유지 결정

- [ ] 8.11.32 배포 뒤 실기 확인(2026-10-21 03:41 KST 배포됨): iPhone에서 재생목록 길게 누르기가 글자를 선택하지
      않는지, 데스크톱 길게 클릭·끌기 가장자리 자동 스크롤, 백그라운드 복귀마다 Sync(일반방 YouTube 방장이 돌아올 때마다
      게스트가 최대 3초에 한 번 다시 맞춘다), 권한 확인 중 안내, 화면 보호기 두 번 탭 종료·저음 밝기를 실제 기기로 본다.
      초기 JS 예산 여유는 약 1.9 KB다.
      [묶음 보고서](design/playlist-and-platform-fixes-2026-10-20.md),
      [삭제 모드](design/playlist-delete-mode-undo-2026-10-20.md),
      [백그라운드 복귀](design/background-return-sync-2026-10-20.md),
      [화면 보호기](design/screensaver-clock-only-help-entry-2026-10-21.md),
      [화면 높이 레이아웃](design/desktop-height-layout-2026-10-21.md)
- [ ] 42개 로케일 번역 업데이트 배포 뒤 화면 확인(8.10.11/v675, 2026-10-14 11:55 KST 배포됨): 사전 값
      1,718건이 바뀌었고 PRO 활성화 7키가 40개 로케일에 새로 번역됐다. 2026-09-06
      감사 방식의 42언어×4폭 자동 레이아웃 재측정은 하지 않았다. 배포 뒤 실제
      기기에서 PRO 활성화 다이얼로그, 연결 탭 강제퇴장 다이얼로그, 설정 탭, About
      페이지를 긴 로케일(de·fi·hu·el·ta·ml)과 RTL(ar·he·fa·ur)로 훑어 넘침·잘림이
      없으면 닫는다.
      [적용 범위·오너 결정·검증·한계](design/i18n-quality-update-2026-10-14.md)
- [ ] 일반방 YouTube C11 현장 관측(8.10.2/v661 배포 뒤): 원래 deadline의
      미보정 callback 지연과 계획·예약·호출·측정 사이 시계 변경을 학습 입력에서
      제외하는 수정은 `72a6e780`, Release `38267400052`로 배포됐다. 기존 저장값은
      초기화하지 않는다. 실제 세션에서 flight recorder의 eligible 대비
      `clock-changed` 비율과 작업별 시계 선택값을 확인한다. UA/플랫폼 모두 Linux인
      기기를 터치만으로 Android로 추정하지 않으며 PRO 학습값 영속화도 보류한다.
      [수정·검증·한계](design/standard-start-learning-repair-2026-10-12.md),
      [수정 전 재현·판정](design/standard-start-review-2026-10-12.md),
      [배포 근거](design/sync-maintenance-release-preparation-2026-10-12.md)
- [ ] PRO 시작 시계 현장 확인(8.10.2/v661 배포 뒤): 작업별 시계 snapshot,
      playing COMMIT의 유효 시계 확보, 늦은 응답의 후보 보관, 조기 COMMIT 처리와
      C11 callback 지연 학습 분리는 `72a6e780`, Release `38267400052`로 배포됐다.
      자연 소켓 단절 중 이미 받은 COMMIT은 유지하고 명시적 퇴장·소켓 교체는 폐기한다.
      실제 현장 오차의 원인은 아직 미확정이다. 원시 시계·실제 선택값·YouTube 관측
      전용 표본을 현장에서 수집하고 재개 startup 지연은 독립 음향 측정과 함께 본다.
      [수정·검증·한계](design/pro-start-clock-safety-2026-10-12.md),
      [14개 후보 판정·재현·한계](design/pro-start-sync-candidate-validation-2026-10-12.md),
      [배포 근거](design/sync-maintenance-release-preparation-2026-10-12.md)
- [ ] Android YouTube 출력 정렬·혼합 버전 현장 확인(8.10.2/v661 배포 뒤):
      오너가 Android 태블릿 2대·Galaxy 5대·Xiaomi에서 확인한 음성 250ms 지연을
      기준으로 PRO·일반방 각 기기에 자신의 +250ms와 수동값을 합성하는 수정은
      `72a6e780`, Release `38267400052`로 배포됐다. 일반방 방장은 실제 적용한
      로컬 보정을 제외한 공통 시각을 송신한다. 실제 수정본의 음향 정렬은 실측 대상이다.
      UA와 UA-CH 모두 Linux로 숨기는 기기는 추측하지 않는다. capability v2는
      그대로여서 Android 방장에서 구·신 코드가 섞이면 zero-start가 ±250ms 어긋날
      수 있다. 오너가 승인한 기존 점검 모드로 배포했고 강제 버전 차단·호환
      마이그레이션은 추가하지 않았다. 기존 탭 잔존과 점검 해제 뒤 재입장을 수용했다.
      점검이 사용자 0명이나 동일 코드 실행을 보장하지 않는다.
      [구현·검증·호환 한계](design/android-youtube-output-baseline-2026-10-12.md),
      [점검·배포 근거](design/sync-maintenance-release-preparation-2026-10-12.md),
      [수용한 전환기 한계](known-accepted.md#13-maintenance-cutover-without-client-version-admission)
- [ ] iPhone Safari/PWA 실기 재입장: 8.9.4의 이전 연결 안내와 "여기서 계속",
      같은 코드로 입장 실패 후 재시도를 확인한다. 종료 알림이 누락되면 마지막 생존
      확인 뒤 45초 동안 presence가 남을 수 있고 명시적 이어하기 정책은 유지한다.
      42개 언어 문구·재시도 복원은 배포 완료했으며, 자동화가 실기 강제 종료를 대신하지
      않는다. [PWA·배포 근거](design/pro-pwa-force-close-audit-2026-10-12.md),
      [재시도 근거](design/pro-entry-retry-audit-2026-10-11.md)
- [ ] PRO 자율 재생 실기: 재생 권한 기기 절전·퇴장 후 일반 참여자만 남은 방에서
      파일·YouTube·플레이리스트 서브인덱스의 연속 전환, 전원 퇴장·복귀를 확인한다.
      서버 자연 종료 경로를 추가했으며, 길이를 검증할 수 없는 파일·라이브·조회가
      불확실한 YouTube는 임의 종료하지 않는다. 실기 확인은 자동화로 대신하지 않는다.
      [구현·검증·한계](design/pro-autonomous-playback-2026-10-12.md)
      등록 시 길이 확보와 기존 파일의 점진적 보완도 같은 실기 확인 대상이다.
      분석 불가 형식은 권한 기기의 준비 완료 전까지 미확정으로 남는다.
      [등록·보완 근거](design/pro-file-duration-registration-2026-10-12.md)
- [ ] PRO 자동 넘김 길이 판독(8.10.1 배포 뒤): 운영 PRO Worker 로그에서
      `Automatic completion metadata unavailable`(특히 `METADATA_LOOKUP_FAILED`)와 YouTube
      메타데이터 조회가 평소보다 늘지 않는지 본다. 8.9.5–8.10.0 판독기가 저장한 서버·업로드
      길이는 재생 때 다시 재므로, 이어 붙인 MP3·조각난 MP4는 짧게 넘어가는 대신 컨트롤러가
      준비할 때까지 곡 끝에서 멈출 수 있다(오너 규칙: 짧은 길이보다 미확정). 삭제·비공개
      YouTube 영상은 60초 이상 떨어진 두 번의 "없음" 응답 뒤에만 건너뛴다. 남은 한계:
      VBR 파일의 1/16 미만 이어 붙임은 FFmpeg처럼 감지하지 못하고, 16 MiB를 넘는 스캔
      대상과 꼬리말 없는 ID3v2.3 뒤 태그는 미확정이다. 실기 확인은 위 "PRO 자율 재생 실기"
      항목과 함께 한다. [상세](design/pro-duration-hardening-2026-10-12.md)

## 3. 릴리스·QA 기준

- QA 범위, 우선순위, 결과에 남길 최소 증거는 [QA 범위 설계](qa-domains.md)를
  따른다.
- 배포 대상은 매번 live SHA와 서버 의존성으로 다시 판정한다
  ([release-deployment-state.mts](../scripts/release-deployment-state.mts)).
  partial-release gate는 선택하지 않은 Worker에 남는 runtime 차이를 거부한다.
- Developer API D1 `false`는 데이터 계층을 건드리지 않는다는 뜻이 아니다. `all`은
  idempotent D1 baseline, R2 정책, room-code 재사용 fence를 적용하고 검증한다.
  `app`도 App 쪽 D1 baseline(번역 커뮤니티 등)은 적용·검증하지만, R2 정책과
  room-code fence는 건너뛴다. 대상별 단계 조건은
  [release.yml](../.github/workflows/release.yml)이 정본이다. 이미 끝난
  launch-cleanup SQL은 다시 실행하지 않는다.
- 날짜가 붙은 QA 결과는 현재 상태가 아니다. 실제로 실행한 환경과 코드 SHA를
  기록하고, 예전 통과 결과를 옮겨 적지 않는다. 같은 검사를 여러 번 돌린 숫자를
  합산하지 않고, 재실행·치환 집계는 그렇다고 밝힌다.
- 실기 확인과 Full E2E는 배포 gate와 별개다. CI의 E2E subset과 coverage는
  생략하지 않는다.
- Full E2E의 production large-room job은 `continue-on-error`라서, workflow가
  성공해도 그 probe가 통과했다는 뜻이 아니다.
- 원격 CI의 1 skip은 기존 상태다. pro-grant-campaign CLI의 Windows 전용 "다른
  드라이브 거부" 검사라서 Linux runner에서는 항상 skip된다.
- 릴리스 뒤 main에 올라간 문서 전용 커밋은 배포 SHA가 아니다. 문서와 감사
  도구만 바꾼 변경은 merge만으로 게시하고 Cloudflare 릴리스를 하지 않는다
  ([documentation-governance](documentation-governance.md#publication-boundary)).
- 시그널링 observability 설정은
  [wrangler.signaling.toml](../cloudflare/wrangler.signaling.toml)과
  [config-drift-ops.md](../cloudflare/config-drift-ops.md)가 소유한다.

### 정기 수동 점검

자동 감사가 통과해도 아래는 사람이 봐야 한다. 열린 항목이 아니라 주기 점검이며(오너
결정 2026-10-14), 이상이 없으면 기록하지 않고 이상이 있으면 §2에 항목을 연다.

- 분기 1회(Drift Audit manual-only 5건): Worker zone routes, `/admin` Cloudflare
  Access+MFA, WAF rate limit과 Worker/R2/D1 비용 알림, 두 번째 Git 배포 경로가
  없음, main review·필수 체크 정책. zone routes는 저장소 시크릿 `CLOUDFLARE_ZONE_ID`와
  `CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN`을 추가하면 자동 감사로 넘어간다.
- 월 1회(일반방 방장 암호): 관리자 대시보드 Operations → Signals의 Password
  lockouts(`guest_auth_rate_limited`, 최근 24시간)가 평소 0에 가까운지, Password
  failures(`guest_auth_failed`)·Password issues 카드 급증·신고가 없는지 본다. 추측
  공격이 보이면 게스트 암호 시도 앞에 봇 확인이나 작업 증명을 검토한다.
  [운영](../cloudflare/standard-room-pin-ops.md),
  [허용 위험](known-accepted.md#12-standard-room-owner-pins-kicks-and-guessing)

## 4. 복구 시 주의

기본 절차는 [hotfix-procedure.md](hotfix-procedure.md)다. checkpoint는 사용자
데이터 백업이 아니고, 더 새로운 외부 배포를 덮어쓰지 않으며, 소스를 revert해도
버전과 캐시 번호는 앞으로만 올린다. 아래는 지금 유효한 복구 경계다. PRO 선택형
입장 암호 floor의 정본은 hotfix-procedure의 "Optional PRO entry passwords"
문단이고, 아래는 요약이다.

- **8.11.39(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·프로토콜·floor는 없다. 8.11.38로 되돌리면 재생 중인 줄의
  아이콘이 다시 1 px 아래로 밀리고, 삭제 때 묶인 블록이 줄마다 잘려 나가며, 남은 줄 이동과 빈 목록 안내가 나가는
  복사본과 겹친다. 저장 데이터 마이그레이션은 없다. [보고서](design/icon-slot-cell-and-delete-sequence-2026-10-21.md)
- **8.11.38(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·프로토콜·floor는 없다. 8.11.37로 되돌리면 선택 모드를 끝낼 때
  여러 줄 블록이 pill로 갈라지며 사라지고, 선택 모드에서 누른 줄이 회색으로 남으며, 두 손가락 스크롤이 해제를 하지
  못하고, 다중 목록 창 부제가 이전 문구("곡 세트")로 돌아간다. 저장 데이터 마이그레이션은 없다.
  [보고서](design/selection-clear-fade-press-tint-two-finger-2026-10-21.md)
- **8.11.37(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·프로토콜·floor는 없다. 직전 배포 8.11.35/v760으로
  되돌리면 우선순위 대기 중 끊긴 프리로드와 재개 후 반복 중단의 복구 공백, 원격 목록 재그리기 중 선택 pill의
  위치 오류가 돌아온다. 저장 데이터 마이그레이션은 없다. 기존 8.11.33 이하의 복구 제한은 유지한다.
  [보고서](design/preload-recovery-and-db256-multi-2026-10-21.md#production-release-and-recovery)
- **8.11.35(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·floor는 없다. 8.11.34로 되돌리면 선택 블록이 행마다
  따로 모양을 바꾸며(해체 때 네모 모서리가 잠깐 보임), 머리글이 한 번에 바뀌고, 선택 막대가 화면 아래로 점프한 뒤
  사라지며, 아이콘이 이전 것으로 돌아간다. 저장 데이터 마이그레이션은 없다. [보고서](design/playlist-selection-morph-and-header-crossfade-2026-10-21.md)

- **8.11.34(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·floor는 없다. 8.11.33으로 되돌리면 다중 목록·곡 이동 창의
  버튼이 다시 아래 끝에 붙고, 선택 블록은 즉시 붙으며, 삭제한 행은 연출 없이 사라진다. 저장 데이터 마이그레이션은 없다.
  [보고서](design/playlist-dialog-inset-and-selection-motion-2026-10-21.md)

- **8.11.33 다중 재생목록(배포 뒤):** App·PRO·Developer API를 함께 `all`로 배포했다(Release 39525250036). PRO room
  Worker가 Developer API facade·공개 Worker보다 먼저 살아 있어야 새 경로가 400/503을 내지 않는다(기존 경로는 순서
  무관). 첫 실행 39524104567은 PRO room 배포 9초 뒤 remote-share smoke가 PRO Worker 안의 service-control 제한기에서
  503 `rate limit unavailable`을 받아 자동 복구됐다. remote-share·service-control 코드는 바뀌지 않아 배포 직후
  Durable Object 재시작과 겹친 것으로 보며 확정하지는 않았다. 같은 후보의 재시도는 통과했다. 되돌린 뒤 다시 배포할
  때도 같은 일이 생기면 새 실행으로 재시도한다.
  새 비밀·바인딩·D1 마이그레이션은 없고, PRO 저장소에 `pro-room:v2:slots`와 `pro-room:v2:slot-item:<id>` 키가
  더해진다(기존 활성 재생목록 배치는 그대로). **되돌리기는 파일에 대해 앞으로만 간다:** 이전 PRO Worker는 활성
  재생목록만 읽으므로 15분 유예 뒤 비활성 재생목록에만 있는 파일을 정리해 지운다. Worker를 되돌리면 그 파일 손실을
  감수하거나 앞으로 고친 배포를 해야 한다. 다음 정방향 배포는 자산이 사라진 비활성 항목을 불러올 때 지워 편집이
  막히지 않게 한다. 일반방은 호스트 메모리에만 있어 되돌려도 저장 데이터가 없다.
  [설계](design/multi-playlist-2026-10-21.md), [PRO 구현](design/multi-playlist-pro-2026-10-21.md)

- **8.11.32(배포 뒤):** App만 바뀌며 새 비밀·바인딩·D1·floor는 없다. 8.11.30 이하로 되돌리면 화면 보호기가
  날씨·공기·달 장면과 위치 요청으로 돌아가고(배경 이미지는 되돌린 App 산출물에 들어 있다), iPhone 길게 누르기
  글자 선택 회귀와 블로그 사진 404가 다시 나타나며, 재생목록 삭제는 예전 즉시 삭제 아이콘 pill로 돌아간다.
  저장 데이터 마이그레이션은 없다. [묶음 보고서](design/playlist-and-platform-fixes-2026-10-20.md)

- **PRO 파일 길이 저장(8.9.6):** App·PRO 함께 `all`로 배포한다. 새 비밀·바인딩·D1
  마이그레이션·복구 floor는 없다. 기존 파일의 private asset metadata를 점진적으로
  보완하고 업로드나 재생목록을 초기화하지 않는다. 이전 PRO에 대한 업로드 완료의
  선택적 길이 필드는 400 `INVALID_REQUEST`에서만 한 번 제외해 재시도한다.
  추가 길이 보고는 실패해도 재생을 막지 않으며, 구 서버의 404 `NOT_FOUND`는 해당
  클라이언트 수명 동안 생략한다. 8.9.5로 복구하면 새 필드는 사용하지 않고 기존
  큐 캐시·서버 조회·READY 경로로 돌아간다.
  [상세](design/pro-file-duration-registration-2026-10-12.md)

- **PRO 자율 재생(8.9.5):** App과 PRO를 함께 배포(`all`)한다. 새
  `PRO_YOUTUBE_METADATA` 서비스 바인딩은 기존 App의 YouTube 키와 기존 공유
  assertion secret을 쓰며, 새 비밀·D1 마이그레이션·호환 floor는 없다. PRO를 먼저
  배포했을 때 이전 App의 내부 경로 404는 미확정으로 처리하고 재시도한다.
  PRO 롤백 시 파일 READY의 선택적 길이 필드는 400 `INVALID_REQUEST`에만 한 번
  제외하고 재시도한다. 구 Worker는 새 길이 캐시를 사용하지 않으므로 자율 곡 전환은
  다시 권한 기기의 종료 보고에 의존한다. App만 롤백해도 기존 파일 근거는 유지되지만
  새 YouTube 길이 조회는 복구 전까지 미확정이 된다.
  [상세](design/pro-autonomous-playback-2026-10-12.md)

- **PRO 선택형 입장 암호:** `passwordRequired: false` / `pin: null`이 저장될 수
  있는 배포 이후에는 이 계약을 모르는 구 PRO/App 조합으로 자동 복구하지 않는다.
  구 Worker는 공개방 입장을 막거나, PIN 변경 뒤에도 모르는 false 플래그를 남겨
  재업그레이드 때 방을 다시 공개할 수 있다. forward repair나 검증된 같은 시점
  코드·데이터 복구를 쓰고, 계약을 아는 이후 기준선(예: 8.8.x에서 8.8.0으로)으로는
  일반 rollback이 가능하다. 임의 PIN 주입이나 플래그 삭제로 우회하지 않는다.
  [계약](design/pro-optional-entry-password-2026-10-10.md)
- **쿠키 reader 호환:** 세션별 쿠키를 발급한 뒤 이전 App Worker로만 되돌리면 이전
  코드가 새 이름을 읽지 못해 사용자가 익명으로 보일 수 있다. 이 경계는 자동
  rollback marker로 보호되지 않는다. 지금은 8.8.0 floor가 그 이전 App으로의
  복구를 막고 있지만, floor가 바뀌면 다시 검토한다. 새 cookie reader를 유지하는
  forward fix나 선별 revert를 우선한다. 구 버전 전체 복구가 필요하면 재로그인
  영향과 남은 scoped 쿠키 처리를 함께 검토하고, 재로그인만으로 해결된다고 가정하지
  않는다. 이 문제를 D1 세션 데이터 유실과 혼동하지 않는다.
- **리버브 상한 일치:** App, PRO, API 중 일부만 복구해 서로 다른 리버브 상한이
  남지 않게 한다. 대상별 복구 순서를 새로 만들지 않고 정식 절차를 따른다.
- **PRO 공개방 입장 보호(배포되면 적용):** 이 변경 이전 PRO Worker로 되돌려도
  core의 `sessionCreateIdempotency`(입장 영수증 최대 256개, 약 108 KiB)와
  `presenceCloseIdempotency`(presence-close 영수증 최대 128개, 약 52 KiB)
  필드는 그대로 보존되지만, 이전 Worker는 둘 다 읽지도 정리하지도 alarm
  대상으로 삼지도 않는다. 되돌린 동안에는 방장 좌석 예약, 입장 throttle, 두
  전용 원장이 모두 적용되지 않는다. 8.8.0은 presence-close 영수증을 다시 공유
  participant 원장에 쓰므로, 그 원장이 차서 방장 큐·재생·미디어 제어가 막히는
  문제도 그동안은 다시 생길 수 있다. 다시 앞으로 배포하면 공유 원장의
  presence-close 영수증은 로드할 때 해제되고, 전용 원장의 만료됐거나 세션이
  사라진 영수증은 정리된다. 그 사이 10분 안의 입장 재시도는 세션이 남아 있으면
  deterministic recovery로 같은 세션에 수렴하고, 이미 닫힌 세션이면 새 입장으로
  처리된다. 상대 Worker가 읽지 않는 원장에 영수증이 있는 presence close 재시도는
  상태 변화 없는 409를 받고, App은 이를 무시한다. 계약 marker는 없고 rollback
  floor도 바뀌지 않는다.
  [상세](design/pro-room-admission-protection-2026-10-11.md)
- **PRO 암호 참여자 선택·퇴장 사유(배포되면 적용):** 이 변경 이전 PRO Worker로
  되돌리면 `existingParticipants`가 든 `POST /pin`은 400 `INVALID_REQUEST`로
  거절된다. App은 이를 "그대로 두기를 지금 쓸 수 없음"으로 보여 주고 모두를
  내보내는 쪽으로 대신 시도하지 않는다. "모두 재입장"(8.9.0은 "모두 다시 입장하게
  하기")은 예전 `{pin}` 요청이라 그대로 동작한다. core의
  `sessionRevocationNotices`(최대 256개, 약 36 KiB)는 이전 Worker가 그대로
  보존하지만 읽거나 정리하지 않으며, 그동안
  퇴장 사유는 붙지 않는다(코드는 계속 `SESSION_REQUIRED`). 다시 앞으로 배포하면
  인증 epoch·room generation이 맞지 않거나 만료된 항목은 첫 prune에서 정리된다.
  App만 이전으로 되돌리면 사유를 무시하고 예전처럼 동작한다. 계약 marker는 없고
  rollback floor도 바뀌지 않는다.
  [상세](design/pro-pin-member-choice-2026-10-11.md)
- **일반방 방장 암호(8.10.0 배포 뒤):** 시그널링만 8.10.0 이전 Worker로 되돌려도
  floor는 없다. 이전 Worker는 `standard-room-pin-membership-v1`과
  `standard-room-pin-failures-v1`을 읽지 않고 기능 플래그도 알리지 않아, App이
  암호만 보낸다. 그동안 "그대로 두기"는 8.10.0 이전처럼 동작해 재연결 때 옛 암호를
  다시 보내는 결함이 돌아오고, "모두 재입장"은 방장의 강퇴뿐이라 수정된
  클라이언트는 시그널링에 남을 수 있다. 오답 제한도 꺼지는데 방장이 고른 약한
  암호는 계속 허용된다. 그래서 forward fix를 우선하고, 되돌려야 하면 App도 함께
  되돌린다(8.9.x의 무작위 암호로 돌아간다). 되돌린 동안 같은 방에서 암호를
  X→Y→X로 바꾸면, 다시 앞으로 배포했을 때 X 때의 유지 목록이 되살아난다(그 기기도
  자기 재연결 비밀이 있어야 한다). App만 되돌리면 무작위 암호로 돌아가고 새
  Worker는 예전 프레임을 그대로 받는다. 되돌리기 전에 저장된 유지 목록은 방
  epoch와 verifier에 묶여 있어 그 경우 말고는 무시되고, 오답 기록은 10분 안에
  만료된다. 계약 marker는 없고 rollback floor도 바뀌지 않는다.
  [상세](design/standard-room-owner-pin-2026-10-11.md),
  [운영](../cloudflare/standard-room-pin-ops.md#rollback)
- **PRO 파일 길이 근거(8.10.1 배포 뒤):** PRO Worker를 8.10.0으로 되돌려도 floor는
  없다. 이전 Worker는 asset 길이 근거의 `reader`·`measuredSeconds`를 엄격히 검사하지
  않아 다시 쓸 때까지 그대로 두고, 큐 캐시에서는 지운다. 되돌린 동안에는 이전 판독기와
  업로드 길이가 다시 저장되어 이어 붙인 MP3·조각난 MP4가 짧게 읽힐 수 있다. 다시 앞으로
  배포하면 그 값들은 `reader: 2`가 없으므로 재생 때 다시 잰다. App만 되돌리면 업로드
  길이를 보내지만 새 Worker는 저장하지 않는다. 계약 marker는 없다.
  [상세](design/pro-duration-hardening-2026-10-12.md#compatibility)

## 5. 갱신 방법

**프로덕션 배포나 롤백 뒤 (같은 기록 PR에서):** `Production Release` 실행뿐 아니라
로컬 emergency deploy와 CLI rollback도 해당한다.

1. §1 전체(표의 모든 행)와 머리말 표의 `Last source review`를 새 값으로
   덮어쓴다. 이전 값은 남기지 않는다.
2. [release-history.md](release-history.md) 표 맨 아래에 한 줄을 추가한다.
3. 릴리스 상세 근거는 `docs/design/<주제>-<날짜>.md`에 쓰고 §1과 이력 행에서
   링크한다.
4. 이번 배포로 해결된 §2 항목은 근거와 함께 지우고, 새로 생긴 한계는 추가한다.

**QA 라운드나 제품·런타임 변경을 마친 뒤** (문서·감사 도구만 바꾼 변경은 2번만
해당):

1. 실행한 코드 SHA, 환경, pass/fail/skip과 한계는 `docs/design/<주제>-<날짜>.md`
   보고서에 쓴다. 그 보고서를 [문서 허브](README.md)의 "Maintained evidence and
   completed records" 목록 맨 위에 추가한다.
2. 배포 대상, 의존성·자산, 데이터·secret·binding, API·프로토콜·쿠키 호환성,
   버전·캐시 요구, 열린 항목, 복구 조건, 오너의 승인·보류 결정 중 하나라도
   바뀌었으면 같은 변경에서 §1~§4를 고친다. 새로 열거나 바꾼 §2 항목에는 보고서를
   링크한다. 바뀐 것이 없으면 이 문서를 고치지 않는다.
3. §2 항목을 닫을 때는 근거 보고서·커밋·실행을 PR 설명에 적는다. 같은 기록 PR에서
   새 이력 행을 추가할 때만 그 행의 내용 칸에도 적고, 이미 쓴 이력 행은 고치지
   않는다.

**지킬 것:**

- 문서만 수정한 커밋은 마지막으로 검증한 코드 SHA를 바꾸지 않는다.
- secret 값, 세션 쿠키, 개인정보는 넣지 않는다.
- 이 문서는 현재 상태만 담는다. 날짜별 경과를 쌓지 말고, 길어지면 근거 문서로
  옮긴 뒤 링크만 남긴다.

2026-09-27~2026-10-10의 베타 승격·QA·배포 원문은
[보관본](beta-release-readiness-archive-2026-10-10.md)에 있다.
