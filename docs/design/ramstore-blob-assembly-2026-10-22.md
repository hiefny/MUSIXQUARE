# 수신 파일 조립의 중복 메모리 감소 — 2026-10-22

| 항목 | 범위 |
| --- | --- |
| 기준 SHA | `264fd5db4727d2c15b070d0e5d8a76ea346fcab5` (PR #442 병합) |
| 수정 코드 SHA | `e3fa0f3c08fd5e828a16b2d7e94ca04a722e807a` |
| 후보 | App 8.11.41 / SW v767, 미배포 |
| 환경 | Windows, Node 24.13.1; CI의 고정 Node 24.20.0과 구분 |
| 범위 | RAM 저장소의 수신 청크 표현과 완료 조립, 기존 기능·브라우저 회귀 |

## 원인과 수정

기존 RAM 저장소는 수신한 모든 `Uint8Array`를 보유한 채 완료 시점에
`new Blob(parts)`를 호출했다. 이 호출이 끝나야 청크 맵을 해제했다.
WebKit의 `BlobBuilder`는 BufferSource를 appendable byte vector에 복사하지만,
Blob 입력은 기존 Blob의 저장 항목을 참조한다. 따라서 700 MB 파일의 기존
조립은 원본 700 MB에 파일 크기의 추가 표현이 겹칠 수 있는 구조였다.
이는 JS 소유권과 엔진 소스에 근거한 설명이며 특정 iPhone의 RSS 측정값이나
PWA 재시작 원인의 확정은 아니다.
[WebKit BlobBuilder](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/fileapi/BlobBuilder.cpp),
[BlobRegistryImpl](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/network/BlobRegistryImpl.cpp).

수신할 때 각 청크만 불변 Blob으로 복사하고, 완료 시에는 이 Blob들을 합친다.
일반 직접 전송의 청크는 최대 64 KiB이며, 완료 조립에 원시 BufferSource를
다시 넘기지 않는다. 원래 수신 버퍼는 이후 보관할 필요가 없어 수신 도중부터
회수될 수 있다. 실제 회수 시점·Blob backing·일시적 추가 할당은 브라우저가
결정한다. 전체 앱의 중복 메모리가 항상 64 KiB 이하라는 뜻은 아니다.

최종 Blob의 크기·MIME·순서·잘린 마지막 청크 처리와 세션 식별은 유지한다.
아직 수신 중인 청크 읽기도 기존 Promise 인터페이스로 바이트를 반환하며,
읽은 배열을 수정해도 저장된 청크는 변하지 않는다. 정확한 세션의 이어받기,
프리로드 선택·승격·재전송·정리와 잘못된 세션 거절을 유지한다. Blob 생성이
실패하면 기존 청크를 덮어쓰거나 미완성 결과를 게시하지 않는다.

전송 프로토콜, 디코더 선택·PCM 창, 전체 원본 파일 보관 정책은 같다.
OPFS·IndexedDB 매체 저장소, 새 의존성·서버 계약·스키마·비밀·바인딩을 추가하지
않았다. `Blob`, `slice`, `arrayBuffer`는 기존 완료 파일 경로에서 이미 사용하던
API이며 최소 브라우저 요구사항을 올리지 않았다. 메모리 장부의 보수적인
2배 수신 허용량과 사실상 무제한인 운영 예산은 유지한다.

## 기능·호환성 검증

- RAM 저장소·프리로드 단위 테스트 129개 통과. 원본 버퍼 재사용, 정확한
  ArrayBuffer/SharedArrayBuffer view, 순서 역전·덮어쓰기·이어받기·정리,
  비동기 읽기 중 세션 교체, 할당 실패 후 보존·재시도를 포함한다.
- 수신 재개·lane 소유권·우선순위 109개 통과. 독립 검토의 storage·admission·
  receive-resume·remote-local-promotion 89개도 통과했다. 두 묶음에는 중복이
  있어 합산한 고유 테스트 수로 표시하지 않는다.
- 네이티브 Chromium·WebKit에서 각 4개, 총 8개 통과. 4 MiB + 117 B 파일의
  SHA-256, 임의 구간 읽기, 실제 저장소의 File 보유·프리로드 승격, 실패 후
  이어받기와 tail trim을 확인했다. Blob 생성 관측은 실제 생성자에 위임한다.
- 별도 테스트는 700 MiB / 64 KiB와 같은 11,200개 Blob을 만들되 페이로드는
  10.9 MiB만 사용한다. 이는 조각 개수 회귀이며 700 MiB 실기기 검증이 아니다.
- 초기 타입 검사와 변경 파일 ESLint·Prettier, 독립 소스 검토 통과.
  전체 검증과 큰 파일 측정은 아래에 최종 결과를 기록한다.

## 큰 파일 측정과 전체 검증

기준 SHA의 실제 RAM 모듈과 수정 SHA의 같은 모듈을 각각 번들해 새 브라우저
프로세스에서 실행했다. Chromium 153.0.8010.12와 WebKit 26.6, 64 GiB Windows
호스트에서 128 MiB 선별 후 **700 MiB(734,003,200 B)**를 순차 비교했다.
64 KiB 청크 11,200개를 만들고 256개마다 이벤트 루프에 양보한다. 실제 망·RTC·
디코더·화면은 포함하지 않으며 GC를 강제하지 않는다. 끝의 샘플 청크 5개와
경계 slice를 읽어 일치함을 확인했다. 별도의 700 MiB 전체 읽기/해시는 만들지
않았다. 크기·부분 읽기는 변경 전후 4조건 모두 통과했다.

첫 700 MiB 실행은 baseline 때 자식 프로세스 탐색이 끝나지 않아 baseline
차감 비교에서 제외했다. 탐색을 안정시킨 교정 실행을 조건당 1회 실시한 아래
표는 Chromium 4개·WebKit 7개의 전체 프로세스가 baseline부터 관측된 결과다.
처음 실행도 최종 파일 읽기는 통과했지만 교정 측정과 평균내지 않았다.

| 700 MiB 조건 | 수신 루프 시간 | 최종 조립 호출 | 수신~보유 구간 최고 working set 합 | baseline working set 합 |
| --- | ---: | ---: | ---: | ---: |
| Chromium 변경 전 | 483.5 ms | 314.3 ms | 1,616.2 MiB | 190.3 MiB |
| Chromium 변경 후 | 2,869.5 ms | 231.5 ms | 1,169.9 MiB | 192.4 MiB |
| WebKit 변경 전 | 667 ms | 1,190 ms | 3,160.8 MiB | 177.4 MiB |
| WebKit 변경 후 | 667 ms | 2,288 ms | 1,506.0 MiB | 178.4 MiB |

메모리는 해당 브라우저 프로세스 트리의 OS working set 합이며 공유 페이지를
중복 포함할 수 있다. 표본 간격 273–909 ms라 순간 최고점을 놓칠 수 있고,
장부나 JS heap 값도 아니다. 각 1회·데스크톱 조건에서 관측된 최대는 Chromium
약 446 MiB, WebKit 약 1,655 MiB 감소했다. 이를 iPhone에서 정확히 절약되는
양으로 환산하지 않는다. WebKit private bytes는 baseline 약 1,069 MiB를 포함해
전체 최고 5,826.8→2,393.2 MiB였으나, 예약/commit 성격이 다른 값을 실제 상주
RAM 절감량으로 사용하지 않는다.

**비용도 확인됐다.** Chromium 수신 루프는 약 2.4초 늘었고 WebKit의 최종
조립 호출은 약 1.1초 늘었다. 수신 직후 working set도 Chromium 902.6→1,045.4
MiB, WebKit 884.7→1,506.0 MiB로 증가했다. 즉 수신 중 모든 시점이 가벼워지는
것은 아니다. 최종 조립 시 WebKit working set 최고는 3,160.8→918.9 MiB로
낮아졌지만, 뒤의 값이 수신 직후보다 작은 것은 그 사이의 브라우저 회수 효과도
포함한다. 네트워크 처리량이나 iPhone의 대기 시간이 같다고 주장하지 않는다.

생성자 인수 관측에서 기존 마지막 호출은 원시 view 11,200개/700 MiB,
수정 호출은 Blob 11,200개/원시 view·ArrayBuffer 0개였다. 이 구조적 증거와
관측된 전체 최대 감소를 근거로 완료 시 중복 복사 감소를 채택했다. 프리로드
진행률·세션 재사용은 유지하지만, 큰 파일 완료 때 메인 스레드가 잠깐 더
묶일 수 있다는 성능 한계는 남는다.

수정 코드 SHA의 전체 검증:

- `npm test -- --maxWorkers=8`: **614개 파일, 13,750개 테스트 통과**, 실패·skip
  없음, 255.90초. RAM 저장소와 프리로드의 위 회귀를 포함한다.
- `npm run build:checked`: 통과. release identity·SW cache history·legacy TV·
  production hooks/security·앱 셸 102개 자산·초기 전송 예산 검사를 포함한다.
  초기 JS gzip **491,523 B**, 유지 상한 491,568 B보다 45 B 작고 별도 5%
  reserve를 유지한다. App 8.11.41과 SW v767, bootstrap query가 일치한다.
- 같은 SHA의 production 산출물에서 Chromium candidate **17/17 통과**
  (51.8초). 이후 E2E 산출물의 부분 수신 진행률·기존 프리로드 **6/6 통과**
  (약 1.1분, retry 0). 84→90%와 완료 후 디코드·로더 해제, 프리로드 유지 및
  다음/이전 곡 전환을 포함한다. 위 네이티브 8개와 합쳐 선택 브라우저 31개다.
- 전체 `typecheck`, `lint`, `format:check` 통과. App Worker 문법 검사,
  Developer API 경계, D1 계약(3 DB·19 migrations), ops drift source-only 검사
  모두 통과했다. 이 검사는 운영 상태를 변경하지 않는다.

## 한계와 다음 확인

수신 중 청크마다 Blob wrapper·저장 항목을 만들고 일부 읽기를 비동기로
처리하는 비용이 생긴다. 전체 encoded 원본과 프리로드, 디코더·브라우저
할당은 계속 존재한다. 이번 변경은 대용량 디코더 전에 생기던 큰 조립 복사를
줄이며, 모든 iPhone에서 700 MB 파일 재생을 보장하지 않는다.

실제 iPhone Safari·설치 PWA의 700 MB 수신/재생, 무선망 처리량, 메모리 압박 시
프로세스 종료 여부와 가청 동기화는 미검증이다. 데스크톱 WebKit은 iOS 장치와
같지 않다. 로컬·PR 결과를 exact-main CI release candidate로 대신하지 않는다.
프로덕션 배포는 실행하지 않았다.
