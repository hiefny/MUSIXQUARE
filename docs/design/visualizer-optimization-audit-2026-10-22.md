# 비주얼라이저 최적화 조사 — 2026-10-22

| 항목 | 범위 |
| --- | --- |
| 성격 | 날짜가 고정된 조사·QA 근거. 제안의 채택이나 배포 승인을 뜻하지 않음 |
| 조사·실행 코드 SHA | `a1548d90d5e68573d19696dfd2bdd5a6efe29bce` (`main`, App 8.11.38) |
| 환경 | Windows, Node 24.13.1, Vitest 5.0.3, Playwright Chromium 153.0.8010.12 headless |
| 대상 | 원형·스펙트럼 Canvas, Web Audio analyser, 화면 보호기와 숨김·재개 경계 |
| 변경 | 제품 코드 변경 없음. 조사 보고서와 문서 허브만 추가 |
| 릴리스 경계 | 로컬 조사이며 exact-main CI 릴리스 후보·운영 배포 검증이 아님 |

## 판단

후속 [UI·UX·호환성 재검증](visualizer-ux-compatibility-preflight-2026-10-22.md)은
아래 제안을 구현하기 전의 조건을 보완한다. 특히 가려진 Canvas의 그리기와 공유
analyser 읽기 중단을 분리하고, 대역·집계·시간 보정은 표현이 바뀌는 변경으로 다룬다.

가장 먼저 줄일 작업은 **가려진 Canvas의 분석·그리기**다. 그다음에는 원형의
주파수 대역을 Hz 기준으로 정의하고, 움직임의 보정을 시간 기준으로 바꾸는 것이
타당하다. 실제 배터리·CPU·GPU 절감률은 측정하지 않았으므로 수치로 약속하지 않는다.

배열 재사용, 정지 시 렌더링 중단, 로그 주파수 좌표 사전 계산, 테마·디더 패턴 캐시,
최대 3배의 backing 해상도는 이미 구현돼 있다. 전면적인 렌더러 교체나 FFT 크기
축소를 우선할 근거는 없다.

## 확인된 실행 경계

현재 [시작 조건](../../src/ui/visualizer.ts)은 재생 여부를 확인하며, 두 draw 루프는
실행 토큰과 YouTube 여부를 검사한다. 화면 보호기의 가림, 이미 숨겨진 wrapper,
`prefers-reduced-motion`은 실행 조건에 없다.

[화면 보호기](../../src/ui/screensaver.ts)는 불투명한 전체화면 overlay를 만들고,
iframe 준비 후 [저음 밝기 반응](../../src/ui/screensaver-bass.ts)을 따로 시작한다.
그 뒤에 남은 비주얼라이저 loop를 중단시키는 연결은 없다.

실행 검사는 원본 TypeScript 모듈을 esbuild로 묶은 **격리 DOM**에서 했다.
실제 Web Audio analyser와 80 Hz 합성 oscillator를 사용했고, 음악을 방에 전송하지 않았다.
wrapper는 604×240 CSS px, viewport 1000×800, DPR 2, AudioContext 48 kHz였다.
제품의 `openScreensaver()`를 실행하되 fullscreen entry는 fixture로 제공하고,
iframe은 ready/close 메시지만 보내는 문서로 대체했다. 제품 전체 CSS·실제 시계
렌더러·네트워크 재생은 이 검사에 포함되지 않는다.

아래는 각 상태에서 안정화 후 약 1초간 센 Canvas `clearRect()`와 analyser 읽기 횟수다.
상태별 1회 관측이며 통계적 성능 benchmark가 아니다. 각 행의 두 수는 원형/스펙트럼 순서다.

| 상태 | Canvas 지우기 횟수 | analyser 읽기 횟수 | 관찰 |
| --- | ---: | ---: | --- |
| 화면에 보이며 재생 | 60 / 60 | 60 / 60 | 기준 |
| 화면 보호기로 덮음 | 60 / 60 | 82 / 83 | 가려진 Canvas도 계속 그림. 읽기는 보호기 저음 반응까지 포함 |
| 동작 줄이기 설정, 보호기 닫힘 | 60 / 60 | 60 / 60 | 비주얼라이저 반복 동작 유지 |
| 재생 중 wrapper를 `display:none`으로 바꿈 | 0 / 0 | 0 / 0 | ResizeObserver가 기존 loop를 중단 |
| 숨김 유지 중 pause → play | 60 / 60 | 60 / 60 | 폭 0인데 fallback 크기로 loop 재시작 |
| 이후 pause, settle 종료 | 0 / 0 | 0 / 0 | 정상 정지 |

브라우저 page error는 두 모드 모두 0이었다. 최초 관측에서는 iframe에 focus가 있어
Escape로 overlay가 닫히지 않았으므로, 보호기 이후 상태의 독립 판정에는 사용하지
않았다. 위 표는 close 메시지와 overlay 제거를 확인한 후 다시 측정한 결과이며
두 실행의 횟수를 합산하지 않았다.

**권고:** 재생 상태와 실제 Canvas 노출을 함께 판단하는 단일 실행 조건을 둔다.
보호기 닫기·재생 탭 복귀·재생 재개 시 다시 평가해야 한다. 데스크톱은 패널들이
동시에 보이고 데모는 wrapper를 별도 overlay로 옮기므로 `tab-play.active`나
`inert`만으로 차단하면 안 된다. 오디오 그래프와 보호기의 자체 저음 반응은 유지한다.

브라우저 백그라운드 탭은 일반적으로 rAF 자체가 정지한다. 이 조사 결과는 **전면 문서
안에서 가려진 Canvas**에 관한 것이며, 백그라운드에서 항상 60회 실행된다는 주장이 아니다.
관련 브라우저 동작은 [MDN requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)을 참고한다.

## 원형의 주파수 대역

`highStart = floor(frequencyBinCount × 0.7)`은 Hz 범위가 아니다.
FFT 4096에서 실제 사용하는 첫·마지막 고음 bin 중심 주파수는 다음과 같다.

| AudioContext sample rate | 현재 고음 bin 범위 | 첫 12개 저음 bin의 마지막 중심 주파수 |
| --- | ---: | ---: |
| 44.1 kHz | 15.429–22.039 kHz | 118.4 Hz |
| 48 kHz | 16.793–23.988 kHz | 128.9 Hz |
| 96 kHz | 33.586–47.977 kHz | 257.8 Hz |

이는 소스의 bin 산식으로 계산한 값이며 실기 96 kHz 측정이 아니다.
현재 “7.5kHz~20kHz” 주석과 실제 범위가 다르다. 특히 96 kHz 컨텍스트에서는
고음 원이 일반적인 가청 대역을 읽지 않는다.
[AudioContext 생성](../../src/audio/context.ts)은 sample rate를 고정하지 않는다.

**권고:** 의도한 저음·고음 경계를 Hz로 정의하고 `sampleRate / fftSize`로 bin을 구한다.
저음은 [공유 계산](../../src/audio/bass-level.ts)을 보호기와 함께 바꿔 일관성을 지킨다.
44.1/48/96 kHz에서 동일한 단일 주파수 신호를 넣는 검사가 필요하다.

## 주사율과 움직임

원형은 프레임마다 `previous × 0.8 + input × 0.2`를 계산한다. 일정 입력에 대한
잔차는 `0.8^n`이므로 입력 변화의 90%를 반영하는 데 11회 업데이트가 필요하다.
초기 동기 draw와 analyser 자체 smoothing을 제외하면 이는 약 183 ms@60 Hz,
92 ms@120 Hz에 해당한다. **수학적 비교이며 전체 시청각 응답의 실측값은 아니다.**

**권고:** `pow(0.8, elapsedMs / (1000 / 60))` 또는 시간 상수 기반 지수 보정을 사용한다.
보호기 저음 반응에는 이미 elapsed 기반 attack/release 구현이 있다. 그 후 FFT 읽기
빈도와 화면 갱신 빈도를 분리하는 실험을 할 수 있다. 30/60 Hz 분석과 display-rate
보간을 먼저 비교하고, 일괄 FPS 제한은 별도의 품질 선택으로 다룬다.

현재는 매 rAF마다 analyser를 읽고 전체 그림을 그린다. 120 Hz라면 60 Hz보다 호출
기회가 두 배지만 CPU 사용률 두 배를 의미하지 않는다. 또한 동일 analyser를 여러 곳에서
읽는 횟수를 네이티브 FFT 실행 횟수와 동일시하지 않는다.

## 스펙트럼의 후속 후보

1. **주파수 구간 집계:** `createSpectrumBinLayout()`은 고주파로 갈수록 bin을 건너뛰고,
   그중 선택한 한 bin만 그린다. 48 kHz/4096에서 310점이며 마지막 두 점은
   19,675.8 Hz와 19,980.5 Hz로 중간 25개 bin이 빠진다. 좁은 피크를 놓칠 가능성이
   있으므로 로그/픽셀 구간의 peak 또는 power를 집계하는 방식을 비교한다.
   피크 누락의 실제 음악 체감은 이번에 측정하지 않았다.
2. **정적 grid 캐시:** 동일한 수직 gradient를 매 프레임 3개 만든다.
   격리 검사에서도 스펙트럼 60회 draw 동안 180개 생성을 확인했다.
   context·크기·테마별 gradient 하나를 재사용하는 것은 작은 변경으로 검토 가능하다.
3. **곡선·정지 프레임 중복 처리:** fill/stroke 곡선 계산과 310개 점 snapshot 복사가
   반복된다. 프로파일에서 비용이 확인되면 개선하되 pause/resize 시 보존하는 마지막
   프레임을 깨뜨리지 않는다. 이 부분의 비용은 측정하지 않았다.
4. **동작 줄이기:** 보호기 저음은 설정을 존중하지만 비주얼라이저는 그렇지 않다.
   정적 프레임 또는 제한된 움직임 정책을 정하고 설정 변경에도 즉시 반영한다.

FFT 4096은 48 kHz에서 11.72 Hz/bin, 약 85.3 ms 분석 창을 제공한다.
이는 오디오 출력 지연이 아니다. analyser는 [masterGain 뒤의 병렬 가지](../../src/audio/engine.ts)에
연결돼 있고 출력도 별도로 destination에 연결된다. FFT를 줄이면 저음 해상도와
현재 12-bin 대역이 함께 바뀌므로 선행 최적화로 권하지 않는다.
분석 의미는 [Web Audio 표준의 AnalyserNode](https://www.w3.org/TR/webaudio-1.0/#AnalyserNode)를 따른다.

## 검증과 한계

- **PASS:** 기존 단위·레이아웃 계약 검사 4개 파일, 28개 테스트, 실패 0, skip 0.
  `visualizer.test.ts`, `visualizer-layout-contract.test.ts`, `spectrum-dither.test.ts`,
  `screensaver-bass.test.ts`를 실행했다.
- **관찰된 개선 공백:** 두 모드의 보호기 뒤 렌더링, 숨김 상태 재개 렌더링,
  reduced-motion에서도 지속되는 렌더링을 격리 브라우저에서 재현했다.
  기존 단위 테스트 통과가 이 경계를 보장하는 것은 아니다.
- **SKIP/미검증:** 전체 앱 E2E, 프로덕션 번들·live 서비스, 실제 보호기 시계,
  물리 Android/iPhone, WebKit, 120/144 Hz 화면, 44.1/96 kHz 오디오 장치,
  장시간 CPU/GPU/메모리·전력, 실제 음악의 피크 표현, 변경 전후 A/B.
- 제품 코드·버전·의존성·배포 범위·호환성·복구 조건은 바꾸지 않았다.
  제안은 후속 구현 후보이며 새 릴리스 차단 조건이나 오너 결정을 만들지 않는다.
  기존 릴리스 열린 항목을 닫지 않았고 `release-record.md`·`release-history.md`는 유지한다.
