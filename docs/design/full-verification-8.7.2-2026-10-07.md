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

## 운영 R2 원인 추적 — 2026-10-07

기준 검사 SHA는 `aba657eda95dc4e572b7c9094074fc787b26edd5`, 환경은 Windows·Node
24.20.0·Playwright 1.63이다. 운영 App `94fa5b03` / 8.7.2 / v633과 share Worker
`e8001e93`을 관찰했다. 아래 scratch 진단은 기존 실패 뒤 관찰 시간을 추가했으며,
원래 단계별 assertion·timeout·실패 판정은 유지했다. 20기기 진단만 추가 입장에 필요한
전체 test body 한도를 300초에서 600초로 늘렸고, ICE 30초·다운로드 120초·곡 제목
90초·다음 곡 재생 진행 60초는 그대로다. 자동 retry는 0이다. 모두 한 Windows PC의 브라우저 세션이며 물리 기기
20대·서로 다른 네트워크의 검증은 아니다.

| 범위 | 결과와 확인 가능한 결론 |
| --- | --- |
| 과거 유지 R2 job 12개 | 10 success / 2 failure. 성공은 모두 PUT 2개·완료 GET 18개. 두 실패는 업로드 전 ICE 8/9 판정이며 HTTP 본문 실패가 아님 |
| shared Chromium, 호스트 1·게스트 context 9 | 원래 검사는 fail. 게스트 8의 두 GET가 합계 126.590초 걸려 120초 조건을 넘었지만, 실패 뒤 같은 요청으로 모두 완료 |
| 기기별 독립 Chromium 진단 | 입장 완료를 기다리는 20초 조건에서 fail. 해당 입장은 약 8초 뒤 완료됐으나 업로드에 도달하지 않아 R2 처리량 비교 결과가 아님 |
| 호스트 1·게스트 context 19 확장 진단 | fail. 19명 입장·토폴로지·PUT 2개는 통과. 게스트 2·9의 수신이 120초를 넘겼으나 실패 후 각각 약 8.1·27.8초에 프리로드까지 완료. 최종 GET 38개 전체 수신 |
| R2를 거치지 않는 정적 파일 대조 | 2,057,688바이트 파일을 HTTP/2 3회·HTTP/3 1회 모두 약 0.78–1.04초에 수신. R2 동시 전송과 동일한 실험 조건은 아님 |

**이번 shared 진단의 직접적인 실패 원인은 진행 중인 전송이 검사 시간 한도를 넘은 것이다.**
게스트 8은 현재 곡을 52.551초에 받고, 6ms 뒤 시작한 프리로드를 74.033초에 받았다.
첫 요청부터 두 번째 완료까지 126.590초였다. 실패 snapshot에서도 프리로드는
1,957,076 / 2,153,280바이트를 받았고, 약 102ms 전까지 바이트가 증가했다.
이후 약 6.8초 만에 같은 요청이 끝났다. 중단·재시도 없이 GET 18개 모두 전체 본문을
수신했으므로 이 실행에서 무한 대기나 복구 누락은 관측되지 않았다.

실패 판정을 pass로 바꾸지는 않는다. 실패 뒤에는 다음 곡 assertion을 실행하지 않았으므로
이 진단을 곡 전환 통과로도 합산하지 않는다. **앞 절의 두 HTTP 본문 미완료 실패에는
동일한 진행 자료가 없으므로, 이번 원인을 소급 적용할 수 없다.** 독립 프로세스 진단의
입장 지연도 전송 실패와 별개이며, 모든 기기의 독립 프로세스 전송 비교는 미완료다.

20기기 진단의 실패 순간 게스트 2는 현재 곡 2,104,534 / 2,153,280바이트,
게스트 9는 1,884,106 / 2,153,280바이트를 받았다. 각각 약 911ms·200ms 전까지
XHR 바이트가 증가했다. 같은 현재 곡 요청은 실패 후 4.040초·25.734초에 끝났고,
프리로드까지는 8.118초·27.755초였다. 19명 모두 정확히 2개씩 재시도 없이 완료했다.
두 페이지의 heartbeat 최대 지연은 14ms·16ms였다. 다음 곡 전환 assertion은 실패로
실행되지 않았으므로, 최종 준비 완료를 전환 성공으로 바꾸어 기록하지 않는다.
이 실행의 tail은 GET 3개만 수집했고 느린 현재 곡 HTTP/2 요청은 포함하지 못했다.
따라서 아래 9게스트 실행의 전체 tail 근거를 20기기 실행으로 확대하지 않는다.

XHR와 CDP의 수신 바이트는 일치했고, 페이지별 이벤트 루프 지연의 관측 최댓값은
16ms 이하였다. 현재 곡 GET 9개는 모두 HTTP/2로 약 1.9–62.4초 걸렸다. 대부분의
프리로드는 HTTP/3로 약 1.2–3.3초였으나, HTTP/2 프리로드에도 1.1초 완료와 74.0초
완료가 모두 있었다. 프로토콜뿐 아니라 요청 순서·대상 객체·동시 전송량·연결 재사용이
함께 달라졌으므로 **HTTP/2가 지연의 원인이라는 인과관계는 입증하지 못했다.**

추가 정적 대조는 앱을 실행하지 않은 fresh context에서 같은 공개 폰트 파일을
각각 두 번씩 받아 전체 본문을 확인했다. QUIC를 끈 세션의 HTTP/2는 0.918·0.783초,
기본 세션의 HTTP/2·HTTP/3는 1.043·0.923초였다. 모두 200이며 브라우저 disk cache·
Service Worker 응답은 아니었다. 이는 HTTP/2 자체나 해당 PC의 모든 다운로드가
항상 느리다는 설명의 반례다. 그러나 정적 배포 자산과 인증된 R2 객체의 경로·edge
캐싱·동시성이 다르므로 R2 원인 확정/배제 근거로 쓰지 않는다. 최초 대조는 잘못 지정한
폰트 경로의 404·0바이트였으며 이를 처리량 측정에서 제외하고 원본을 보존했다.

9게스트 shared 진단의 Cloudflare tail GET 18개는 모두 HTTP 200·outcome `ok`, 예외 없음이었다.
Worker CPU는 1–10ms, wall time은 183–422ms였고 관측 edge는 LAX였다. 429나
CPU 제한 오류의 증거는 없다. 다만 이 wall time을 브라우저의 본문 수신 완료 시간으로
해석하지 않으며, 짧은 handler 시간만으로 R2·edge 이후의 전송 지연을 제외하지 않는다.

Cloudflare 공식 제한도 이번 현상과 구분했다. Worker의 동시 outgoing 연결 6개는
각 요청 실행의 제한이지 서비스 전체의 수신 사용자 6명 제한이 아니다. HTTP 요청에는
클라이언트가 연결된 동안 일률적인 실행 시간 제한이 없고, 네트워크 대기는 CPU 시간과
다르다. [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/).
R2의 `r2.dev` 가변 제한과 동일 객체 쓰기 1회/초 제한은 각각 공개 개발 endpoint와
쓰기에 관한 것이다. 이 서비스의 custom Worker·R2 binding GET에 그대로 적용되는
읽기 제한으로 설명할 수 없다. [R2 제한](https://developers.cloudflare.com/r2/platform/limits/).

과거 원격 실패는 [9월 17일 UTC job](https://github.com/hiefny/MUSIXQUARE/actions/runs/35276834150/job/105389384103)과
[9월 28일 UTC job](https://github.com/hiefny/MUSIXQUARE/actions/runs/36497282792/job/109179683667)이다
(한국 시간 9월 18일·29일). 모두 30초 ICE 사전 조건에서 8/9로 종료됐다. 원본에
실패 연결의 후보 자료가 없어 새 observer 반례를 과거 원인으로 확정하지 않는다.
R2 job은 처음부터 `continue-on-error`였으므로 전체 workflow의 초록불은 해당 job의
성공을 보장하지 않는다. 12개 중 성공한 10개는 개별 job과 완료 본문 로그로 확인했다.

9월 18일 배포 소스 `70edc9e9`와 현재 `e8001e93`을 비교하면 share Worker·두 import·
Wrangler 설정·R2 CORS/lifecycle, 브라우저 `r2-client.ts`·`remote-download.ts`는
바이트 단위로 동일하다. frozen main에서 현재 App까지 `remote-share.ts`의 관련
오케스트레이션 변경은 있으나 지연을 시작시킨 커밋이라는 증거는 없다. 소스 동일성을
배포 bundle·secret·외부 서비스·네트워크까지 동일하다는 의미로 확대하지 않는다.
Worker는 요청별 R2 body를 그대로 응답하고, 브라우저는 native XHR 본문을 다 받은 뒤
파일·디코딩 처리를 시작한다. 기존 90초 바이트 비활동 감지와 1회 재시도 관련
120개 검사는 앞 절의 통과 근거를 유지하며 이번 진단 때문에 재실행하지 않았다.

**새 확정 런타임 결함 0건; 느린 전송의 하위 원인은 미확정이다.** 제품의 timeout·
재시도·전송 정책이나 유지 테스트를 추측으로 바꾸지 않았다. 후속 인과 검증이 필요하면
동일한 불변 객체·동시성·연결 초기 조건을 맞춘 HTTP/2 대 HTTP/3 비교에서 헤더 도착,
본문 바이트 간격과 완료를 수집해야 한다. 그래야 클라이언트/TCP·QUIC 경로와
Worker/R2 경로를 더 좁힐 수 있다. 이번 기록은 그 통제 실험을 완료했다는 뜻이 아니다.

이번 9게스트·19게스트 전송 진단과 독립 프로세스 입장 진단은 각각 fail로 보존한다.
이 절은 앞선 5개 방의 3 pass / 2 fail을 덮어쓰거나 전체 로컬·원격 suite를 다시
통과했다고 선언하지 않는다. 제한된 표본으로 참가자 수에 따른 실패 확률을 계산하지 않는다.
지연 자체는 관측한 품질 문제이며, 코드 원인 미확정을 문제 없음으로 해석하지 않는다. 문서만 변경하며
새 App/Worker 릴리스·버전/cache·schema·secret/binding 변경은 없다.

원본은 `scratch/r2-root-cause-2026-10-07/`의 `history/findings.md`와 원격 job 로그,
`probe/{run.log,result.json,summary.jsonl}`, `probe-independent/`·`probe20/`의 같은 파일,
`tail-safe.jsonl`, `tail-share20.jsonl`, `static-control-results.json`,
`static-control-invalid-path-results.json`, `runtime/`의 소스 비교·진행 분석에 보존했다. 추적 문서에는
room ID·토큰·IP·원본 인증 URL을 넣지 않는다.

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
