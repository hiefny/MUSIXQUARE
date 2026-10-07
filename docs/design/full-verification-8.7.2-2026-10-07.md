# App 8.7.2 전체 검증 및 운영 검사 관측기 보완 — 2026-10-07

| 항목 | 상태 |
| --- | --- |
| 현재 판정 | 최초 전체 검증의 최종 실행은 통과. 이후 운영 R2 재검사에서 다운로드 본문 미완료가 다시 관측돼 현재 전체 올그린으로 확대 해석하지 않음. 아래 후속 진단·한계를 함께 확인 |
| 기준 검사 SHA | `61cedbc6dd40ae801233036d9ae5f9a26361fbdf` |
| 첫 검사 보완 SHA | `59eae678e6f1f1e50a62a77ea5460c2ac0e235d4` — 테스트 관련 3파일만 변경 |
| 최종 검사 보완 SHA | `716c37af6f57ae46112e1e6295562e50fdc03ff0` — native getter 예외에서도 SCTP/DTLS/ICE 객체 식별을 유지하는 최소 수정 |
| 배포된 App | `8.7.2` / `v633`, 제품 SHA `94fa5b03695122d1cf6b39d9e7a5374ec6e11e09` |
| 관련 기록 | [배포 준비 기록](../beta-release-readiness.md), [8.7.0 승격 기록](release-8.7.0-2026-10-07.md) |

최종 `716c37af`의 로컬 전체 unit 10,781개와 PR CI가 통과했다. 기준 제품 입력의 로컬·원격 전체 Chromium은 각각 581개 통과했고, 최종 보완 커밋의 원격 Chromium 재실행도 581개 모두 통과했다. 운영 R2 최초 실행의 `8/9` 실패는 원인 미확정으로 보존한다. 별도로 재현한 관측기 결함은 **테스트만 수정**했으며, 이후 실제 9게스트 R2 검사는 로컬·원격 모두 통과했다.

## 코드와 환경

- 기준 `61cedbc6`는 배포된 제품 `94fa5b03`와 `docs/beta-release-readiness.md`만 다르며 제품 입력은 같다.
- 보완 `59eae678`은 `e2e/helpers/production-ice-observation.ts`, `e2e/production-live/large-room-r2.test.ts`, `src/core/__tests__/production-ice-observation.test.ts`만 바꾼다. 제품 코드·의존성·서버 계약·DB·secret·binding·버전·캐시·빌드 설정 변경은 없다. 이 검증 작업에서 제품을 다시 배포하지 않았다.
- `716c37af`는 같은 helper의 예외 경로에서 transport 객체 식별을 보존하고 회귀 3개를 추가한다. 기준과의 최종 코드 diff도 위 테스트 관련 3파일뿐이며, 9게스트·30초·R2 assertion은 그대로다. 이 보고서와 준비 기록은 별도 문서 변경이다.
- Windows, Node 24.20.0/npm 12.0.2, Vitest 5, Playwright 1.63, jq 1.8.2. 원격은 GitHub Actions Ubuntu다. 기존 timeout·네트워크 격리·coverage 하한·브라우저 자동 retry 0을 유지했다.
- 기준 테스트 파일 604개는 unit 517개, E2E 86개, 의도적 dead-export fixture 1개로 모두 분류됐다. 전체 Chromium은 E2E 83파일이며, 제외된 3파일은 WebKit·production candidate·production-live 프로필이 각각 검사한다. 보완은 unit 1파일을 추가한다. 프로필 간 중복을 고유 검사 수에 더하지 않는다.

## 로컬 검사 결과와 SHA 구분

| 검사 | 실제 검사 기준 | 결과 |
| --- | --- | --- |
| 기준 전체 unit + broad coverage | `61cedbc6` | 517파일·10,730 pass, fail/skip/todo 0 |
| 최종 전체 unit + broad coverage | `716c37af` | 518파일·10,781 pass, fail/skip/todo 0, exit 0. 528.95초. 실행 전후 SHA와 변경된 3파일 SHA-256 일치 |
| Critical runtime coverage | `61cedbc6`; 이후 이 프로필의 입력 변경 없음 | 55파일·1,869 pass, 원래 하한 통과 |
| Worker runtime coverage | 같은 기준 | 26파일·1,728 pass, 원래 하한 통과 |
| Release tooling coverage | 같은 기준 | 13파일·342 pass, 원래 하한 통과 |
| 전체 Chromium | `61cedbc6`; 이후 해당 83파일·제품·빌드 입력 변경 없음 | 83파일·고유 581 pass; 두 격리 shard 298+283, fail/skip/retry/flaky/runner error 0 |
| 공식 iPhone WebKit | `61cedbc6`; 이후 해당 입력 변경 없음 | 12파일·66 pass/기존 3 skip, fail/retry/flaky 0 |
| Production candidate | 기준 production 산출물 | 17 pass, fail/skip/retry/flaky 0 |
| Production WebKit Service Worker | 같은 기준 production 산출물 | 1 pass, fail/skip/retry/flaky 0 |
| `build:checked` 및 산출물 guard | 기준 및 첫 보완 `59eae678` 후 각각; 최종 제품·빌드 입력 같음 | 통과. 기록 `build/production-build-final.log` |
| 6개 production Worker dry-run | 기준 SHA; 이후 Worker·의존성 입력 변경 없음 | 6개 모두 통과, 배포하지 않음 |
| 전체 정적·보안 검사 | `59eae678` | 18/18명령 exit 0. 전체 타입·lint·서식·독립 source guard·Worker syntax·dependency tree 통과 |
| 의존성 감사·서명 | `59eae678`, 09:30 UTC | 전체/prod-only 취약점 각각 0. registry 서명 486개·attestation 103개 검증 |
| 신규 ICE observer 회귀, 첫 보완 | 보완 작업 트리 → `59eae678` | 48/48 pass, fail/skip 0; test TypeScript 검사 통과 |
| 예외 경로 추가 회귀, 최종 보완 | 최종 작업 트리 → `716c37af` | 51/51 pass, fail/skip 0. E2E 타입·helper lint·서식 검사 exit 0; 최종 broad에서도 모두 통과 |
| 최종 실제 9게스트 R2 | `716c37af` 검사 도구 → 운영 App `94fa5b03` | 1 pass, 130.95초, fail/skip/retry/flaky 0. native host/host 9개, PUT 2개·완료 GET 18개·전환 후 추가 GET 없음 |

Chromium·WebKit·candidate의 기준 실행을 최종 커밋에서 모두 다시 실행했다고 표현하지 않는다. 각 SHA에서 다시 검사한 항목과, 변경되지 않은 입력에 대한 기준 증거를 위 표처럼 분리한다. 정적 18명령은 `59eae678` 증거이며 `716c37af`의 변경은 위 focused/type/lint/format으로 추가 검사했다. WebKit의 3개 skip은 데스크톱 진입 애니메이션, 모바일에서 숨겨진 캐러셀 화살표, hover 동작이며 Chromium이 해당 데스크톱 경로를 검사한다.

| Coverage 프로필 | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Broad, `61cedbc6` | 86.54% | 80.28% | 91.08% | 90.20% |
| Broad, `716c37af` | 86.54% | 80.28% | 91.08% | 90.20% |
| Critical runtime | 81.61% | 76.13% | 87.64% | 85.77% |
| Worker runtime | 84.26% | 80.79% | 92.63% | 88.93% |
| Release tooling | 78.27% | 73.87% | 87.09% | 80.14% |

네 기준 프로필과 최종 broad의 원래 전체·파일별 하한이 통과했다. focused 세 프로필은 입력이 바뀌지 않았고 원격 최종 PR CI에서도 다시 통과했다. `59eae678`의 로컬 broad 재실행은 후속 회귀 발견으로 중단했으며 완료 결과로 합산하지 않는다.

## 운영 R2 최초 실패와 검사 보완

최초 실행은 9명이 입장한 뒤 `host/host`로 관측된 연결 수가 30초 안에 9가 되지 않아 `Expected 9 / Received 8`로 종료됐다. 파일 업로드·R2 전송 검사에 도달하지 않았다. 당시 연결별 후보 자료가 없어 제품·환경·관측기 중 원인을 특정할 수 없다. 실패 시 topology 첨부만 추가한 재실행은 기존 알고리즘과 모든 assertion을 유지한 채 native `host/host` 9개·PUT 2개·현재 곡/프리로드 GET 18개·다음 곡에서 추가 GET 없음 조건을 통과했다.

이 발생과 별도로 아래 관측기 계약 오류를 대조 검사로 확인했다. 이전 callback은 `61cedbc6`에서 AST 그대로 추출해 export/type wrapper만 추가했다.

| 대조 | 수정 전 결과 | 의미 |
| --- | --- | --- |
| 기존 native `host/host` 정상 경로 | 1 pass | 정상 경로를 유지하는 대조 |
| native `host/prflx`가 canonical `host/host` stats를 가림 / native 없는 fallback이 `selectedCandidatePairId`를 무시 | 2 fail | 기존 observer의 false negative |
| canonical transport 선택 없이 임의 selected 또는 nominated pair를 채택 | 2 fail | 기존 observer의 false positive |
| 첫 helper에서 native getter가 예외를 던지는 동안 SCTP·DTLS·ICE 객체 각각 교체 | 3 fail, 객체 유지 대조 1 pass | catch가 식별 객체를 버려 stale stats를 받아들이던 결함 |

helper는 유일한 transport가 명시적으로 선택한 succeeded graph와 역할·backlink를 요구한다. native `host/prflx`를 보완할 때 유효 port/protocol이 같고, 양쪽에서 확인 가능한 address·local foundation·ICE generation도 일치해야 한다. stats를 기다리는 동안 registry·연결·SCTP/DTLS/ICE·후보 정보가 바뀌면 거부한다. native getter 예외에서도 읽은 객체를 보존하며, 진단에는 IP·SDP·토큰·ICE 자격 정보를 넣지 않는다.

첫 보완 `59eae678`에서 회귀 48개, 최종 `716c37af`에서 추가 예외 경로를 포함한 51개가 모두 통과했다. 최종 로컬 broad도 51개를 포함한다. 최종 운영 R2는 로컬·원격 각각 1 pass였고 두 실행 모두 native `host/host` 9개/refined 0이었다. 실제 운영에서 refined 경로를 발생시켰다고 해석하지 않는다.

초기 41 pass/1 fail, 이전 callback 대조의 include 설정 오류로 중단한 scratch 실행, 중단한 `59eae678` broad 원본도 보존한다. 정확한 이전 callback 비교의 43개 이름 필터 제외는 당시 5개 대조에만 적용됐고, 이후 유지 회귀 전체에서는 제외하지 않았다.

**확정한 것은 관측기 계약 불일치의 수정이다. 최초 운영 `8/9` 발생의 원인을 이 수정으로 확정하지 않는다.**

## 추가 live 검사

| 대상 | 결과와 범위 |
| --- | --- |
| App generation | 최신 공개 entry/초기 자산 graph 25개와 연속 3회 generation 일치 확인 |
| 실제 App host/guest session | 운영 Cloudflare transport로 입장, ordered bootstrap, 양방향 첫 채팅 통과 |
| 추가 6개 live 명령 | signaling, PRO room, PRO media CORS, remote share, Standard HTTPS signaling, App public boundary 모두 exit 0 |
| 첫 보완 9게스트 R2 | `59eae678`에서 1 pass. 최초 실패·진단 pass와 중복 합산하지 않음 |
| 최종 9게스트 R2 | `716c37af` 로컬 1 pass, 원격 1 pass; 모두 native host/host 9개, 원래 R2 전송·프리로드·전환 조건 통과 |

live 검사는 배포된 App/Worker에 대한 해당 시점의 결과다. 테스트 커밋 `59eae678`·`716c37af`가 운영에 배포되었다는 뜻은 아니다. 각 smoke가 관측하지 않은 실제 계정·모든 API·기기 경로로 결과를 확대하지 않는다.

## 원격 검사 결과

| 실행 | 검사 SHA / 확인 결과 | 상태 |
| --- | --- | --- |
| [main CI 37594837712](https://github.com/hiefny/MUSIXQUARE/actions/runs/37594837712) | `61cedbc6`; unit 10,729 pass/Windows 전용 1 skip, 4종 coverage gate, candidate 17·critical browser 22 pass | 성공 |
| [Operations Drift Audit 37595270795](https://github.com/hiefny/MUSIXQUARE/actions/runs/37595270795) | 기준 계약과 운영 비교, 자동 31 pass/0 fail, 수동 전용 5항목 | 자동 감사 성공 |
| [기준 Full E2E 37595231001](https://github.com/hiefny/MUSIXQUARE/actions/runs/37595231001) | `61cedbc6`; Chromium 581 pass/0 fail·skip·retry, WebKit 66 pass/3 skip, WebKit SW 1 pass, 실제 9게스트 R2 1 pass | 성공 |
| [첫 보완 Full E2E 37600603336](https://github.com/hiefny/MUSIXQUARE/actions/runs/37600603336) | `59eae678`; WebKit/SW 성공, 실제 9게스트 R2 1 pass, native 9/refined 0, retry 0 | 후속 helper 수정 검증으로 대체해 취소. 완료한 세부 결과는 보존하며 중단된 Chromium을 완료 증거로 사용하지 않음 |
| [첫 보완 PR #251 CI 37600971871](https://github.com/hiefny/MUSIXQUARE/actions/runs/37600971871) | 보완 커밋 `59eae678` | 성공. 최종 `716c37af` 또는 main push CI 성공으로 바꿔 기록하지 않음 |
| [최종 Full E2E 37602041553](https://github.com/hiefny/MUSIXQUARE/actions/runs/37602041553) | `716c37af`; Chromium 581 pass/0 fail·skip·retry, WebKit 66 pass/기존 3 skip, WebKit SW 1 pass, 실제 9게스트 R2 1 pass(native 9/refined 0), retry 0 | 모든 job 실제 성공. Chromium 52.5분, 완료 2026-10-07 10:32:13 UTC |
| [최종 PR #251 CI 37601999398](https://github.com/hiefny/MUSIXQUARE/actions/runs/37601999398) | `716c37af`; unit 518파일·10,780 pass/Windows 전용 1 skip, 4종 coverage gate, candidate 17·critical browser 22 pass | 성공. main push CI 증거와 구분 |

R2 job에는 `continue-on-error`가 있으므로 workflow의 종합 색상 대신 해당 job의 실제 성공을 확인했다. Linux에서 건너뛴 Windows 전용 unit는 최종 로컬 전체 검사에서 통과했다. 최종 원격 전체 Chromium의 종료 상태와 원본 로그에서 581개 통과를 확인했다.

## 실행 한계와 남은 확인

- 인증된 Developer API canary는 필요한 키가 GitHub production environment secret에만 있어 이번 독립 검사에서 실행하지 못했다. 다른 API smoke나 unit로 인증된 canary 성공을 대신하지 않으며, 검사를 위해 제품을 다시 배포하지 않았다.
- Operations Drift Audit의 수동 전용 5항목은 자동 31개 통과와 별도다.
- 로컬 Windows Playwright WebKit의 Web Audio/WebRTC 제약 때문에 위 결과를 실제 iPhone Safari/PWA 미디어·다기기 음향 동기화 증거로 해석하지 않는다. Bluetooth, 혼합 물리 기기, 모바일 네트워크 변경, 기존 설치 PWA·장기 운영 탭은 실기 확인 영역이다.
- 이전 R26의 legacy Refresh 승인 후 갱신 정지 1회는 원인 미확정 상태를 유지한다. 후속 진단 10회나 이번 SW 검사의 성공으로 해결된 것으로 처리하지 않는다.
- 이번 최초 `8/9` 운영 관찰도 원인 미확정으로 보존한다. 최종 테스트 보완의 효과는 독립 반례와 유지 회귀로 설명한다.
- 게시 경로는 [PR #251](https://github.com/hiefny/MUSIXQUARE/pull/251)이다. 이 기록은 최종 검사 코드 `716c37af`의 증거이며, 후속 문서 커밋과 main 병합 SHA는 별개다. 해당 PR의 최종 검사·병합 기록 및 [main CI](https://github.com/hiefny/MUSIXQUARE/actions/workflows/ci.yml?query=branch%3Amain)에서 후속 실행을 확인한다. 테스트·문서만 게시하며 Production Release는 실행하지 않는다.

## 운영 R2 후속 재검사 — 2026-10-07 저녁

사용자의 최초 미확정 관찰 재검사 요청에 따라 main `a1543f8baf40cea057fe817d18a064fbec7710da`의
검사로 같은 운영 App `94fa5b03`을 확인했다. Windows·Node 24.20.0·Playwright 1.63,
호스트 1개와 분리된 게스트 context 9개, 자동 retry 0이다. 유지 테스트의 인원·30초
ICE 조건·120초 다운로드 조건을 완화하지 않았다. 제품 및 유지 테스트 코드는 변경하지 않았다.

- **유지 테스트의 새 방 3회:** 2 pass / 1 fail. 첫 방에서는 연결 9개와 PUT 2개를
  확인했지만 게스트 4·7·8의 완료 GET가 0개였다. 다른 6개는 각각 현재 곡과
  프리로드 GET 2개가 완료됐다. 실패는 게스트 4의 다운로드 조건에서 보고됐다.
  나머지 두 방은 GET 18개·다음 곡 재생 진행·추가 GET 없음까지 통과했다.
- 첫 방의 연결 하나에서 native `host/prflx`와 안정적인 canonical `host/host`
  stats가 실제로 함께 관측됐다. 그 native snapshot에 기존 판정 규칙을 적용하면
  8개가 되며, 보완 observer의 실제 관측은 endpoint 일치 근거로 9개였다. 이로써 실제 브라우저에서
  보완 경로가 필요한 상황은 확인했지만, **과거 최초 8/9 실패가 같은 이유로
  30초 지속됐다는 증거는 아니다.**
- **별도 새 방 1회, 수동 관찰 추가:** 원래 입장·업로드 순서와 assertion을
  유지하며 기존 observer → 보완 observer → 기존 observer를 35초 동안 35회
  비교했다. 모두 9/9/9였다. 그러나 게스트 1의 다운로드 조건은 실패했다.
  해당 기기는 GET 1개 시작·HTTP 200 응답 후 본문 완료 0개, 로딩 중·미디어 길이 0이었다.
  다른 8개는 각각 GET 2개 완료·디코딩 준비 상태였다. 이 방은 다음 곡 검증에 도달하지 않았다.
- 이 진단 방은 9개의 R2 capability 모두가 최초 FILE_PREPARE 전에 도착했고,
  실제 FILE_PREPARE도 전부 `delivery:r2`였다. 직접 전송의 FILE_START/PRELOAD_START나
  bulk 바이트는 없었다. 따라서 **이 방의 실패는 정상 P2P 전송을 검사에서 빠뜨린
  경우가 아니다.** 앞선 첫 방은 같은 상세 자료가 없으므로 원인을 소급 확정하지 않는다.
- 코드의 정상 혼합 P2P/R2 정책은 기존 14개 테스트로 재확인했다. 하지만 그 정책이
  이번 진단 방의 실패 원인이라는 가설은 위 운영 증거로 제외했다.
- 다운로드 보호 처리는 이미 존재한다. 새 바이트가 90초 동안 없을 때 중단하고,
  transient 실패는 한 번 재시도한다. 계속 진행하는 느린 전송에는 전체 시간 제한을
  적용하지 않는다. 관련 기존 4파일·120개 검사가 모두 통과했다. 테스트의 120초
  절대 제한은 이 90초 비활동 조건과 다르므로, HTTP 200과 본문 미완료만으로
  무한 대기나 재시도 누락을 확정하지 않는다.
- **XHR 바이트 관찰을 추가한 마지막 새 방 1회:** 1 pass, 약 140초. 원래 assertion과
  timeout을 유지했고 GET 18개가 각각 2,153,280바이트 전체를 수신했다. 현재 곡의
  XHR은 기기별 약 2.1–69.6초, 뒤따른 프리로드는 약 1.2–4.6초 걸렸다.
  느린 요청도 실제 바이트 증가 이벤트를 반복해서 내며 완료했고, 다음 곡 재생 진행과
  추가 GET 없음까지 통과했다. 이 성공한 방의 진행 자료로 이전 실패한 방의 바이트
  진행 여부를 소급 증명할 수는 없다.

합계는 **서로 다른 새 방 5회 중 3 pass / 2 fail**이다. 유지 검사 3회와 scratch
관찰 진단 2회를 구분하며, 재시도 성공으로 이전 실패를 지우지 않는다. 최초 8/9
연결 관찰의 원인은 여전히 소급 확정 불가다. 이번에는 별도로 운영 HTTP 본문 수신의
기기별 큰 지연과 120초 미완료를 관측했지만, 서비스·네트워크·단일 PC의 여러 browser
context 부하 중 원인이나 앱 복구 결함을 특정하지 못했다. 새 확정 제품 코드 결함은
없으며 증거 없이 복구 정책·테스트 제한 시간을 바꾸지 않았다. 이 후속 결과를
포함한 운영 반복 검증은 올그린이 아니다. 전체 로컬·원격 스위트를 다시 실행한 것도 아니다.

현재 원본은 `scratch/r2-followup-2026-10-07/{baseline,report,summary}.json`,
`scratch/r2-paired-comparison-2026-10-07/{result,evidence,provenance}.json`,
각 폴더의 `run.log`, `policy-check/` 및 `watchdog-tests/`에 보존했다.
마지막 바이트 진단은 `scratch/r2-progress-diagnostic-2026-10-07/`의
`result.json`, `xhr-evidence.json`, `evidence.json`, `provenance.json`에 보존했다.
진단은 토큰·주소·원본 메시지 본문을 보관하지 않고 경로 종류·상태·바이트·시각만 남긴다.

## 최초 전체 검증 원본 증거

추적 제외 폴더 `scratch/full-verification-8.7.2-2026-10-07/`에 원본을 보존한다.

- `baseline.json`, `unit/summary.json`, `unit/*`: 기준 SHA·4종 coverage·원래 명령/JSON/LCOV.
- `unit-final-716c/summary.json`, `broad.json`, `coverage-broad/*`: 최종 518파일·10,781개, coverage 하한·원래 입력 hash 확인.
- `unit-final/*`: 추가 회귀 발견 후 중단한 `59eae678` broad 원본. 완료 결과로 사용하지 않는다.
- `browser-summary.json`, `browser/chromium-{1,2}.json`, `browser/webkit.json`: 전체 581개 고유성·모바일 skip 근거. 최초 R2 실패는 그대로 보존하며 후속 실행은 아래 개별 reporter로 구분한다.
- `browser/candidate.json`, `browser/webkit-sw.json`, `build/results.json`: 기준 production·SW·빌드·Worker 검증. `build/results.json`의 최초 R2 exit 1을 보존한다.
- `browser/production-live.json`, `browser/production-live-diagnostic.json`, `browser/production-live-final.json`: 최초 실패 → 기존 조건 진단 pass → 첫 helper `59eae678` pass의 서로 다른 실행.
- `browser/production-live-716c.json`, `build/production-large-room-716c.log`: 최종 `716c37af` 로컬 운영 1 pass, native host/host 9개.
- `observer-regression/report.md`, `old-proof-provenance.json`, `old-proof-final.json`, `new-final.json`: 정확한 이전 callback 대조와 첫 보완 48개 회귀, 초기 실패·중단 로그.
- `observer-regression/throwing-native-before.json`, `new-final-51.json`, `throwing-native-checks.json`: native getter 예외 중 객체 교체 3개 red·정상 대조 1개 pass, 후속 보완 51개 pass, E2E 타입·helper lint·서식 검사.
- `static/manifest.json`, `static-final/manifest.json`: 기준 및 `59eae678` 18개 명령, audit JSON·서명 로그. 후자는 09:26:54–09:30:42 UTC.
- `build/production-build-final.log`, `build/production-large-room-final.log`, `remote/direct-live-results.json`, `build/live-app-*.log`: `59eae678` production build와 운영 smoke. 파일명의 final을 현재 최신 SHA의 결과로 해석하지 않는다.
- `remote/*`, `remote-final/*`, `remote-complete/*`: 기준·첫 보완·최종 보완 실행의 상태 snapshot과 원격 원본 로그. `remote-complete/pr-ci.log`, `chromium.log`, `webkit.log`, `production-r2-summary.json`, `full-e2e-status.json`이 최종 완료 근거다.
