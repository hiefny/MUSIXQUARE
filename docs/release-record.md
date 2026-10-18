# 릴리스 기록 (현재 상태)

| Field              | Value                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Runbook — 현재 릴리스 상태. 프로덕션 배포·롤백마다 §1을 덮어쓰고, 열린 항목이 바뀌면 §2를 고친다                                                                                                                |
| Applies to         | 프로덕션 App·Worker 6종의 현재 배포 상태, 열린 확인 항목, 릴리스·QA 때 지킬 기준                                                                                                                                |
| Last source review | 2026-10-18 (배포 SHA `416f5ee4`, Release `39081701815` attempt 1 성공) |
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

아래는 2026-10-18 09:12 KST 배포 후 공개 자산·Drift Audit 확인까지의 상태다. 후속 기록 PR은 배포된 코드 SHA나 exact-main 후보를 대신하지 않는다. 다음 배포 전 Git·CI·Cloudflare 상태를 다시 확인한다.

| 항목 | 값 |
| --- | --- |
| App 버전 / SW 캐시 | `8.11.20` / `v723` |
| 마지막 프로덕션 변경 | 2026-10-18 09:11:20 KST deploy job 완료, [Release 39081701815](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815) attempt 1 성공, target=app, Developer API D1=false. 일반방 직접 파일 전송·프리로드 네 경로의 다음 송신 대기 기준을 64 KiB로 통일하고, 지원하는 양쪽 연결에 128 KiB 누적 수신확인 제어를 적용했다. 혼합 버전 입장 전 private hello가 나가던 비교 후보 결함도 함께 수정했다. 재생·동기화 제어 우선이라는 오너 요청에 따라 비교 검증 뒤 배포했으며 고RTT 파일 전송시간 증가는 문서에 남긴다 |
| 배포 main SHA | `416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`, PR [#399](https://github.com/hiefny/MUSIXQUARE/pull/399). Exact-main push [CI 39081289549](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081289549) attempt 1의 11 jobs success 후보 [artifact 12118986426](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081289549/artifacts/12118986426)를 사용했다. Node 24.20.0 / npm 11.19.0 / Wrangler 4.148.0. PR·로컬 결과를 exact-main 후보로 대체하지 않았다 |
| Worker | App version `d9f64847-408c-4a7b-a13c-8c744a41c7c6` / deployment `930bbc83-b7c1-4fbc-b178-afd7de96478a`, 100%, message=`git:416f5ee48e3708ae33d82aa1c6d925a72bcab6f3`. 최종 소유권 09:11:16.794 KST verified, exact-SHA coherent marker 기록. 부분 릴리스 recheck 09:10:49.540 compatible. 미선택 5 Worker는 `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf` provenance와 version/deployment를 유지한다: signaling `c25e8be3-bb42-465f-a66b-77360b3a5f1a` / `052c9597-cc96-44ea-91cb-40469840d760`; pro-room `8d5d44c0-c925-4495-86d7-29bf11a0958e` / `e5049949-cbcf-4210-b736-92541dfadddf`; remote-share `b7150b48-2e77-4db0-a908-718fe341bd5f` / `8b306664-f898-463a-aeb3-f4a083ae0d5a`; developer-api `c4069dcd-524d-4752-baa0-364aba94679a` / `5bf2cebe-69f1-4cdc-847c-e9b3e0c28e5d`; developer-api-facade `d4b348cd-3323-4f48-8bbb-4f49a3680110` / `44f54bd6-1af9-4da3-9829-48d28d4c7037`. [배포 원본 12119341521](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815/artifacts/12119341521), [coherent marker 12119456150](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815/artifacts/12119456150) |
| 운영 smoke / 공개 자산 | 운영 smoke 4/4 pass: App generation, 익명 App 계정 경계, 기존 PRO 공개 경계, Standard HTTPS signaling. 범위 밖 Worker smoke는 skip. 09:12:00.794 KST 공개 8 GET 모두 HTTP 200, exact-main 후보 크기·SHA 일치: `/` 140,676 B, `/service-worker.js` 39,149 B(v723), `/bootstrap.js?cache=v723` 10,196 B, main JS `main-Bmr11182.js` 437,646 B, main CSS 324,945 B, credit 어댑터 `peer-ZE0BU1c_.js` 349,157 B, preload 31,888 B와 helper 1,599 B. 공개 어댑터에 `mxqr-bulk-flow` 포함도 확인. [근거](design/receiver-credit-file-transfer-2026-10-18.md#release-and-recovery) |
| 복구 | rollback 불필요·미실행, 독립 recovery job skipped. 09:10:11.359 KST captured [checkpoint 12119445999](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081701815/artifacts/12119445999)는 App 8.11.19/v721, `eea5a842c1d1b9cd51b845f95de24b1059378bae`, version `89f8574e-88e3-4268-bc63-f16d302b535b` / deployment `9d3dfb4d-c050-4c6f-b69f-e424c64fd3f2`를 보존한다. 복구하면 receiver credit을 잃고 일반 전송 기준은 512/256 KiB로 돌아가며, preload는 64 KiB를 유지한다. 혼합 버전은 legacy fallback 경로를 쓴다. 저장 데이터 마이그레이션 없음. 복구 시 소유권/floor를 다시 검증하며 checkpoint는 사용자 데이터 백업이 아니다 |
| 활성 복구 floor | 09:10:13.363 KST ready, release floor `d9364cd94ef036c5202ebf20cf5fff0b68d8cacf`, generation floor `4c5612d5fc4c5548781eb7d5b26d6904969c051c`, generation/entitlement true. 보존 App은 verified-release-ancestor, generation·entitlement·Developer API authority aware. 기존 service-control·Soro·PRO 선택형 입장 암호 계약과 marker `pro-room-optional-entry-password-v1` 유지, 신규 floor 없음. 파일 길이·쿠키 경계는 §4와 정식 절차를 따른다 |
| 검증 범위 | Exact-main CI 11 jobs success: unit 587 files / 13,114 pass / 0 fail / 1 skip(Linux의 Windows 전용 다른 드라이브 경로 거부 검사), candidate browser 17 + critical browser 55 pass, coverage·타입·린트·정적·빌드·보안 통과. 최종 PR head `fd1ce373`의 [CI 39080368618](https://github.com/hiefny/MUSIXQUARE/actions/runs/39080368618) 11 jobs 통과. GitHub Codex 자동 리뷰는 초기 `4c0f9498`에 지적 0건, 최종 수정은 별도 독립 코드·raw 근거 리뷰에서 P1/P2 없음. 로컬 Windows 최종 runtime tree의 unit 587 files / 13,115 pass / 0 fail / 0 skip, 타입·린트·포맷·committed build:checked 통과. 기존 Chromium E2E 24 pass. 최종 실제 제품 RTC 8조건·26파일 SHA/ACK/READY 통과, 이전 비교 16조건·88파일과 구분한다. 초기 fixture 실패와 실제 입장 호환 실패는 원인·수정·재검증 근거를 보존했다. 전체 serial E2E·실기 Android·가청 싱크는 미검증. [범위·한계](design/receiver-credit-file-transfer-2026-10-18.md) |
| 잔여 성능 조사 | 최종 8명 new/new heartbeat 최대 일반 26 ms / preload 20 ms. 이전 비교에서 2 Mbps 수신자는 약20초→0.42초로 줄고 전송시간은 약96초로 비슷했다. 반면 8 Mbps·약220 ms RTT preload는 23 MB 완료가 24.495→64.540초로 늘었다. 고정 수신확인 창의 처리량 대가와 실제 Android/무선망·공급자·부하 한계는 §2에 유지한다. 구버전 송신자는 기존 지연이 남고, PRO/R2는 이번 변경 범위 밖이다. 전체 망의 지연 상한이나 모든 다운로드의 가속을 보장하지 않는다 |
| Operations Drift Audit | active, 매일 03:37 UTC. 배포 후 [39081868540](https://github.com/hiefny/MUSIXQUARE/actions/runs/39081868540) attempt 1, `416f5ee4`, 09:12:20 KST 완료, automated-checks-passed: 31 pass / 0 fail / 5 manual-only. 수동 항목은 §3에 유지한다 |
| Full E2E | 매주 월 18:17 UTC. 이번 전체 serial suite는 재실행하지 않았다. 확인한 마지막 main 실행 [38328670967](https://github.com/hiefny/MUSIXQUARE/actions/runs/38328670967)(`4854e392`)은 failure. 별도 브랜치 성공 [38405378201](https://github.com/hiefny/MUSIXQUARE/actions/runs/38405378201)(`749f0a6a`, Chromium 640·WebKit UI 79 pass/플랫폼 3 skip·SW 1·운영 R2 1)은 이번 변경이나 main 최신 성공을 뜻하지 않는다 |
| 의존성·호환 | 신규 npm 의존성·스키마·비밀·바인딩·권한·CSP 변경 없음. RTC private additive hello/receipt는 앱 입장 APPLIED 완료 후 협상하고 구버전은 1초 grace 뒤 legacy 경로를 쓴다. 기존 FILE/PRELOAD 청크·READY·최종 ACK와 Worker 계약은 유지한다. 기존 App D1 계약 7단계 apply/verify 성공, Developer API D1 skip. 취약점·서명 검사 exact-main CI 통과. sharp 0.35.5 override, TypeScript 6.1 이상·@types/node 25 이상 Dependabot ignore 유지. [기존 근거](design/dependency-update-2026-10-11.md) |

## 2. 열린 확인 항목

해결하면 근거(커밋, 실행 ID, 문서)를 PR 설명에 적고 이 목록에서 지운다. 근거
없이 완료로 표시하지 않는다.

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
      첫 파일 대기나 다음 곡 준비가 늦어질 수 있다. 후속 128/256/384/512 KiB
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
      제한된 로컬 진단을 추가했다. App8.11.21/v724 후보이며 아직 미배포다.
      전체 회귀·native 비교·exact-main 후보의 완료 여부는
      [후속 제품 후보 검증](design/automatic-realignment-clock-safety-2026-10-18.md)에
      따르며, 실제 오차의 장기 보류·실기/가청 한계를 이 변경만으로 닫지 않는다.
      [재현·원시 시각 재구성·한계](design/receiver-credit-window-comparison-2026-10-18.md#candidate-interruption-queue-biased-clock-and-automatic-realignment),
      [추가 설계·장시간 비교·미배포 범위](design/receiver-credit-adaptive-design-2026-10-18.md),
      [교차 시험의 실패 보존·독립 검산](design/receiver-credit-cross-matrix-2026-10-18.md),
      [작업 시계 고정 후보·대조와 한계](design/transport-candidate-roundtable-2026-10-18.md#qlease-대조).

### 최근 해결 근거

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

### 후속 작업과 유지 결정

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
